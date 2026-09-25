//! Private trusted native authority control. Renderer RuntimeRequest has no access to this facade.
use super::*;
use crate::platform_storage::{
    CurrentSessionDocument, QuickUnlockDocument, SecretBytes32, SessionProvenance,
};
use crate::Incarnation;
#[cfg(test)]
use crate::ItemDraft;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

#[path = "native_independent_revalidation.rs"]
mod independent_revalidation;
#[path = "native_travel.rs"]
mod native_travel;
use native_travel::{
    DestinationRestrictions, GrantRestrictions, SourceKeyAuthority, SourceRestrictions,
};
pub use native_travel::{
    NativeRestrictionAcknowledgement, NativeRestrictionAdoption, NativeRestrictionBatch,
    NativeRestrictionDisposition, NativeRestrictionEvidence, NativeRestrictiveContinuity,
};

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAccountScope {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub incarnation: Incarnation,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub lock_epoch: u64,
    pub server_url: String,
    pub user_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAccountAuthority {
    pub scope: NativeAccountScope,
    pub unlocked: bool,
    /// Derived capability readiness; this does not change Desktop Account lock state.
    pub key_authorization_available: bool,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub key_generation: u64,
    pub restrictive_continuity: Option<NativeRestrictiveContinuity>,
    pub policy_verification: Option<NativePolicyVerification>,
}

impl NativeAccountAuthority {
    fn authorizes(&self, challenge: &NativeImportChallenge) -> bool {
        !matches!(
            self.policy_verification,
            Some(NativePolicyVerification::Pending { .. })
        ) && self.authorizes_existing(challenge)
    }

    fn authorizes_existing(&self, challenge: &NativeImportChallenge) -> bool {
        self.unlocked
            && self.key_authorization_available
            && self.scope == challenge.source
            && self.key_generation == challenge.source_key_generation
    }
}

/// Source verification episodes restrict admission without withdrawing an established grant.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativePolicyVerification {
    Pending {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "crate::wire::decimal_u64::json_schema")
        )]
        #[serde(with = "crate::wire::decimal_u64")]
        revision: u64,
    },
    Verified {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "crate::wire::decimal_u64::json_schema")
        )]
        #[serde(with = "crate::wire::decimal_u64")]
        revision: u64,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "crate::wire::decimal_u64::json_schema")
        )]
        #[serde(with = "crate::wire::decimal_u64")]
        restriction_frontier: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAuthoritySnapshot {
    pub version: u32,
    pub extension_id: String,
    pub owner_id: String,
    pub channel_id: String,
    pub transport_id: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub sequence: u64,
    pub accounts: Vec<NativeAccountAuthority>,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub restriction_frontier: u64,
    pub restriction_chain_digest: [u8; 32],
    pub restrictions: Vec<NativeRestrictionBatch>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeImportChallenge {
    #[serde(default)]
    pub purpose: NativeChallengePurpose,
    pub version: u32,
    pub challenge_id: String,
    pub extension_id: String,
    pub source_owner: String,
    pub source_channel: String,
    pub source_transport: String,
    pub destination_owner: String,
    pub destination_channel: String,
    pub destination_transport: String,
    pub source: NativeAccountScope,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub source_key_generation: u64,
    pub destination: NativeAccountScope,
    pub new_destination: bool,
    pub destination_insecure_transport_confirmed: bool,
}

/// One native challenge owner serves credential transfer and independent exclusion restoration.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeChallengePurpose {
    #[default]
    Transfer,
    RevalidateIndependentRestrictions {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "crate::wire::decimal_u64::json_schema")
        )]
        #[serde(with = "crate::wire::decimal_u64")]
        restriction_frontier: u64,
        restriction_chain_digest: [u8; 32],
        excluded_vault_ids: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeIndependentRevalidationReply {
    pub challenge: NativeImportChallenge,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub source_session_expires_at_ms: u64,
    pub visible_vault_ids: Vec<String>,
}

/// Nonsecret source policy evidence accompanies, but does not change, encrypted transfer material.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeTravelEvidence {
    pub enabled: bool,
    pub hidden_vault_ids: Vec<String>,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::optional_decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::optional_decimal_u64")]
    pub server_enabled_at_ms: Option<u64>,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::optional_decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::optional_decimal_u64")]
    pub server_updated_at_ms: Option<u64>,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::optional_decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::optional_decimal_u64")]
    pub verified_at_ms: Option<u64>,
}
impl NativeTravelEvidence {
    fn matches(&self, policy: &crate::platform_storage::VerifiedTravelModePolicy) -> bool {
        self.enabled == policy.enabled
            && self.hidden_vault_ids.len() == policy.hidden_vault_ids.len()
            && self.hidden_vault_ids.iter().collect::<HashSet<_>>()
                == policy.hidden_vault_ids.iter().collect::<HashSet<_>>()
    }
}

/// Presentation and pinned derivation policy; this carries no new login secret.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeAccountProfile {
    pub email: String,
    pub name: String,
    pub team_name: Option<String>,
    pub team_avatar_url: Option<String>,
    pub secret_key_hint: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub added_at_ms: u64,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub last_active_at_ms: u64,
    pub biometric_enabled: bool,
    pub pinned_kdf_profile: bittery_crypto_core::KdfProfile,
}

impl NativeAccountProfile {
    fn destination_metadata(
        &self,
        destination: &NativeAccountScope,
        travel: &NativeTravelEvidence,
        insecure_transport_confirmed: bool,
    ) -> Result<crate::platform_storage::AccountMetadataDocument, RuntimeError> {
        let mut metadata = crate::platform_storage::AccountMetadataDocument::new(
            destination.account_id.clone(),
            destination.incarnation.clone(),
            destination.user_id.clone(),
            self.email.clone(),
            self.name.clone(),
            destination.server_url.clone(),
            self.team_name.clone(),
            self.team_avatar_url.clone(),
            self.secret_key_hint.clone(),
            self.added_at_ms,
            self.last_active_at_ms,
            self.biometric_enabled,
            insecure_transport_confirmed,
            self.pinned_kdf_profile.clone(),
            Some(crate::platform_storage::VerifiedTravelModePolicy {
                enabled: travel.enabled,
                hidden_vault_ids: travel.hidden_vault_ids.clone(),
                server_enabled_at_ms: travel.server_enabled_at_ms,
                server_updated_at_ms: travel.server_updated_at_ms,
                verified_at_ms: travel.verified_at_ms,
            }),
        )?;
        metadata.native_only = true;
        Ok(metadata)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeTransferReply {
    pub challenge: NativeImportChallenge,
    pub travel_evidence: NativeTravelEvidence,
    pub profile: Box<NativeAccountProfile>,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub material: crate::SecretString,
}

impl std::fmt::Debug for NativeTransferReply {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NativeTransferReply([redacted])")
    }
}

/// This control contract is available only to trusted native compositions.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeAuthorityRequest {
    AttachSource {
        extension_id: String,
        transport_id: String,
    },
    SourceSnapshot {
        channel_id: String,
    },
    AttachDesktop {
        source: NativeAuthoritySnapshot,
        transport_id: String,
    },
    PrepareImportForSource {
        channel_id: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        source_account: AccountId,
        #[serde(default)]
        insecure_transport_confirmed: bool,
    },
    PrepareIndependentRevalidation {
        channel_id: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        source_account: AccountId,
    },
    RevalidateIndependentRestrictions {
        challenge: NativeImportChallenge,
    },
    CompleteIndependentRevalidation {
        reply: NativeIndependentRevalidationReply,
    },
    Export {
        challenge: NativeImportChallenge,
    },
    ExportWithBiometric {
        challenge: NativeImportChallenge,
        prompt_message: String,
    },
    CompleteImport {
        reply: NativeTransferReply,
    },
    ApplyAuthority {
        channel_id: String,
        source: NativeAuthoritySnapshot,
    },
    RestrictionAcknowledgement {
        channel_id: String,
    },
    AcknowledgeRestrictions {
        acknowledgement: NativeRestrictionAcknowledgement,
    },
    RetireChannel {
        channel_id: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeAuthorityResponse {
    Source {
        snapshot: NativeAuthoritySnapshot,
    },
    Attached {
        channel_id: String,
    },
    Prepared {
        challenge: NativeImportChallenge,
    },
    Exported {
        reply: NativeTransferReply,
    },
    IndependentRestrictionsRevalidated {
        reply: NativeIndependentRevalidationReply,
    },
    BiometricRefused {
        failure: crate::BiometricFailure,
    },
    RestrictionAcknowledgement {
        acknowledgement: NativeRestrictionAcknowledgement,
    },
    Applied,
}

#[cfg(feature = "runtime-protocol-contract-schema")]
pub fn native_authority_contract_schema() -> serde_json::Value {
    #[derive(schemars::JsonSchema)]
    #[allow(dead_code)]
    struct NativeAuthorityContract {
        request: NativeAuthorityRequest,
        response: NativeAuthorityResponse,
    }
    serde_json::to_value(schemars::schema_for!(NativeAuthorityContract))
        .expect("native authority schema")
}

/// A trusted source transport owns this channel; browser requests cannot select another channel.
pub struct NativeSourceAttachment {
    facade: NativeAuthorityFacade,
    channel_id: String,
}

struct LegacySnapshotGuard {
    account_id: AccountId,
    incarnation: Incarnation,
    user_id: String,
    lock_epoch: u64,
    revision: u64,
    vault_ids: Vec<String>,
    loan: super::foreground_attachment_lifecycle::ForegroundAttachmentGuard,
    cancellation: RequestCancellation,
}

struct LegacyWrappedKeysGuard {
    account_id: AccountId,
    incarnation: Incarnation,
    user_id: String,
    lock_epoch: u64,
    revision: u64,
    vault_ids: Vec<String>,
    email: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacyDesktopAccountEntry {
    account_id: String,
    email: String,
    user_id: String,
    name: String,
    secret_key_hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_name: Option<String>,
    team_avatar_url: Option<String>,
    added_at: i64,
    last_active_at: i64,
    biometric_enabled: bool,
}

struct LegacyAccountsGuard {
    account_id: AccountId,
    incarnation: Incarnation,
    user_id: String,
    lock_epoch: u64,
    access: crate::AccountAccessState,
    eligible: bool,
    metadata: Option<crate::platform_storage::AccountMetadataDocument>,
    display_identity: crate::AccountDisplayIdentity,
    entry: Option<LegacyDesktopAccountEntry>,
}

fn legacy_desktop_account_entry(
    account_id: &AccountId,
    metadata: &crate::platform_storage::AccountMetadataDocument,
) -> Result<LegacyDesktopAccountEntry, RuntimeError> {
    let added_at = i64::try_from(metadata.added_at_ms).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Account creation time is outside the protocol-1 timestamp range",
        )
    })?;
    let last_active_at = i64::try_from(metadata.last_active_at_ms).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Account activity time is outside the protocol-1 timestamp range",
        )
    })?;
    Ok(LegacyDesktopAccountEntry {
        account_id: account_id.as_str().to_owned(),
        email: metadata.email.clone(),
        user_id: metadata.user_id.clone(),
        name: metadata.name.clone(),
        secret_key_hint: metadata.secret_key_hint.clone(),
        team_name: metadata.team_name.clone(),
        team_avatar_url: metadata.team_avatar_url.clone(),
        added_at,
        last_active_at,
        biometric_enabled: metadata.biometric_enabled,
    })
}

fn legacy_account_display_identity(
    metadata: &crate::platform_storage::AccountMetadataDocument,
) -> crate::AccountDisplayIdentity {
    crate::AccountDisplayIdentity {
        email: metadata.email.clone(),
        name: metadata.name.clone(),
        team_name: metadata.team_name.clone(),
        team_avatar_url: metadata.team_avatar_url.clone(),
        server_url: metadata.normalized_server_url.clone(),
        secret_key_hint: metadata.secret_key_hint.clone(),
    }
}

/// Preserve the Server wrapper string while taking Vault identity, visibility and role from the
/// current active Bootstrap generation. The old consumer expects JSON text inside `vaultKeys`.
pub(super) fn encode_visible_wrapped_keys(
    runtime: &Runtime,
    snapshot: &ReplicaSnapshot,
) -> Result<(Zeroizing<String>, Vec<String>), RuntimeError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct LegacyWrappedKey<'a> {
        vault_id: &'a str,
        vault_name: &'a str,
        vault_type: crate::VaultProjectionType,
        vault_icon: Option<&'a str>,
        vault_image_url: Option<&'a str>,
        encrypted_vault_key: &'a str,
        role: crate::VaultProjectionRole,
    }

    let visible: Vec<_> = visible_vaults(snapshot)
        .into_iter()
        .filter(|vault| !runtime.vault_is_fenced(snapshot, &vault.vault_id))
        .collect();
    let mut records = Vec::with_capacity(visible.len());
    let mut vault_ids = Vec::with_capacity(visible.len());
    for vault in &visible {
        let generation = snapshot
            .bootstrap
            .active_generation
            .as_ref()
            .ok_or_else(native_retired)?;
        let authority = snapshot
            .bootstrap
            .vaults
            .get(&(generation.clone(), vault.vault_id.clone()))
            .ok_or_else(native_retired)?;
        if authority.encrypted_vault_key.is_empty() {
            return Err(native_retired());
        }
        records.push(LegacyWrappedKey {
            vault_id: &vault.vault_id,
            vault_name: &vault.name,
            vault_type: vault.vault_type,
            vault_icon: vault.icon.as_deref(),
            vault_image_url: vault.image_url.as_deref(),
            encrypted_vault_key: &authority.encrypted_vault_key,
            role: vault.role,
        });
        vault_ids.push(vault.vault_id.clone());
    }
    let encoded = serde_json::to_string(&records).map_err(|_| native_retired())?;
    Ok((Zeroizing::new(encoded), vault_ids))
}

#[derive(Default)]
struct LegacyPrivateItems(Vec<serde_json::Value>);

fn scrub_legacy_private_value(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(string) => string.zeroize(),
        serde_json::Value::Array(values) => values.iter_mut().for_each(scrub_legacy_private_value),
        serde_json::Value::Object(fields) => {
            fields.values_mut().for_each(scrub_legacy_private_value)
        }
        _ => {}
    }
}

struct LegacyPrivateValue(serde_json::Value);
impl Drop for LegacyPrivateValue {
    fn drop(&mut self) {
        scrub_legacy_private_value(&mut self.0);
    }
}

impl Drop for LegacyPrivateItems {
    fn drop(&mut self) {
        self.0.iter_mut().for_each(scrub_legacy_private_value);
    }
}

#[cfg(test)]
type LegacyPrivateExportAudit = Box<dyn Fn(&crate::VaultExportProjection) + Send + Sync>;

/// Owns the original decrypted Export projection from capture until formatting exits, including
/// every early refusal. The JSON formatter separately scrubs its copied payload values.
struct LegacyPrivateExport {
    projection: crate::VaultExportProjection,
    #[cfg(test)]
    after_scrub: Option<LegacyPrivateExportAudit>,
}

impl LegacyPrivateExport {
    fn new(projection: crate::VaultExportProjection) -> Self {
        Self {
            projection,
            #[cfg(test)]
            after_scrub: None,
        }
    }
}

impl Drop for LegacyPrivateExport {
    fn drop(&mut self) {
        self.projection.zeroize();
        #[cfg(test)]
        if let Some(audit) = &self.after_scrub {
            audit(&self.projection);
        }
    }
}

fn append_legacy_export_items(
    items: &mut LegacyPrivateItems,
    export: &LegacyPrivateExport,
    account_id: &AccountId,
    identity: &crate::AccountDisplayIdentity,
    user_id: &str,
    include_account_context: bool,
) -> Result<(), RuntimeError> {
    for item in &export.projection.items {
        let vault = export
            .projection
            .vaults
            .iter()
            .find(|vault| vault.vault_id == item.vault_id)
            .ok_or_else(native_retired)?;
        let mut encoded =
            LegacyPrivateValue(serde_json::to_value(&item.data).map_err(|_| native_retired())?);
        let fields = encoded.0.as_object_mut().ok_or_else(native_retired)?;
        let mut category = fields.remove("category").ok_or_else(native_retired)?;
        // Core names this draft Authenticator; the unchanged protocol-1 consumer uses TOTP.
        if category.as_str() == Some("authenticator") {
            category = serde_json::Value::String("totp".into());
        }
        let mut payload = LegacyPrivateValue(fields.remove("data").ok_or_else(native_retired)?);
        let payload_fields = payload.0.as_object_mut().ok_or_else(native_retired)?;
        payload_fields.insert("id".into(), serde_json::json!(&item.item_id));
        payload_fields.insert("vaultId".into(), serde_json::json!(&item.vault_id));
        payload_fields.insert("category".into(), category);
        payload_fields.insert("favorite".into(), serde_json::json!(item.favorite));
        payload_fields.insert("createdAt".into(), serde_json::json!(&item.created_at));
        payload_fields.insert("updatedAt".into(), serde_json::json!(&item.updated_at));
        payload_fields.insert("accountId".into(), serde_json::json!(account_id));
        payload_fields.insert("accountEmail".into(), serde_json::json!(&identity.email));
        payload_fields.insert(
            "vault".into(),
            serde_json::json!({
                "accountId": account_id,
                "id": &vault.vault_id,
                "name": &vault.name,
                "type": vault.vault_type,
                "icon": &vault.icon,
                "imageUrl": &vault.image_url,
            }),
        );
        if include_account_context {
            payload_fields.insert(
                "account".into(),
                serde_json::json!({
                    "email": &identity.email,
                    "userId": user_id,
                    "name": &identity.name,
                }),
            );
        }
        items.0.push(std::mem::take(&mut payload.0));
    }
    Ok(())
}

#[cfg(test)]
mod legacy_private_export_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn export() -> crate::VaultExportProjection {
        let data = serde_json::from_value(serde_json::json!({
            "category": "login",
            "data": {
                "title": "Private fixture",
                "username": "fixture-user",
                "password": "password-canary",
                "totpSecret": "totp-canary",
                "customFields": [{ "id": "field", "label": "label", "value": "field-canary", "type": "password" }],
                "passkeys": [{
                    "credentialId": "credential", "rpId": "fixture.invalid", "rpName": "Fixture",
                    "userHandle": "handle", "userName": "user", "userDisplayName": "User",
                    "privateKey": "scalar-canary", "publicKey": "public", "algorithm": -7,
                    "signCount": 0, "transports": [], "createdAt": "2026-09-23T00:00:00Z"
                }]
            }
        })).unwrap();
        crate::VaultExportProjection {
            account_id: AccountId::from("account-1"),
            replica_revision: 1,
            items: vec![crate::VaultExportItem {
                account_id: AccountId::from("account-1"),
                item_id: "item-1".into(),
                vault_id: "vault-1".into(),
                data,
                favorite: false,
                deleted_at: None,
                attachments: Vec::new(),
                created_at: "2026-09-23T00:00:00Z".into(),
                updated_at: "2026-09-23T00:00:00Z".into(),
                status: crate::ItemProjectionStatus::Authoritative,
            }],
            vaults: vec![crate::VaultProjection {
                vault_id: "vault-1".into(),
                name: "Fixture".into(),
                vault_type: crate::VaultProjectionType::Personal,
                icon: None,
                image_url: None,
                role: crate::VaultProjectionRole::Owner,
            }],
        }
    }

    fn audited_export(
        export: crate::VaultExportProjection,
    ) -> (LegacyPrivateExport, Arc<AtomicUsize>) {
        let count = Arc::new(AtomicUsize::new(0));
        let observed = count.clone();
        let mut owner = LegacyPrivateExport::new(export);
        owner.after_scrub = Some(Box::new(move |projection| {
            for item in &projection.items {
                let ItemDraft::Login(login) = &item.data else {
                    panic!("fixture category changed")
                };
                assert!(login.title.is_empty());
                assert!(login.username.is_none());
                assert!(login.password.is_none());
                assert!(login.totp_secret.is_none());
                assert!(login
                    .custom_fields
                    .iter()
                    .all(|field| field.value.is_empty()));
                assert!(login
                    .passkeys
                    .iter()
                    .all(|passkey| passkey.private_key.is_empty()));
            }
            observed.fetch_add(1, Ordering::SeqCst);
        }));
        (owner, count)
    }

    fn identity() -> crate::AccountDisplayIdentity {
        crate::AccountDisplayIdentity {
            email: "fixture@example.invalid".into(),
            name: "Fixture".into(),
            ..Default::default()
        }
    }

    #[test]
    fn exported_projection_zeroize_clears_non_password_category_data() {
        let mut projection = export();
        projection.items.push(crate::VaultExportItem {
            account_id: AccountId::from("account-1"),
            item_id: "authenticator-1".into(),
            vault_id: "vault-1".into(),
            data: serde_json::from_value(serde_json::json!({
                "category": "authenticator",
                "data": {
                    "title": "Authenticator",
                    "totpSecret": "authenticator-canary",
                    "notes": "authenticator-notes-canary"
                }
            }))
            .unwrap(),
            favorite: false,
            deleted_at: None,
            attachments: Vec::new(),
            created_at: "2026-09-23T00:00:00Z".into(),
            updated_at: "2026-09-23T00:00:00Z".into(),
            status: crate::ItemProjectionStatus::Authoritative,
        });
        projection.zeroize();
        let scrubbed = serde_json::to_string(&projection).unwrap();
        assert!(!scrubbed.contains("password-canary"));
        assert!(!scrubbed.contains("totp-canary"));
        assert!(!scrubbed.contains("scalar-canary"));
        assert!(!scrubbed.contains("authenticator-canary"));
        assert!(!scrubbed.contains("authenticator-notes-canary"));
    }

    #[test]
    fn successful_legacy_format_wipes_original_private_item_after_copy() {
        let (owner, audited) = audited_export(export());
        let mut items = LegacyPrivateItems::default();
        append_legacy_export_items(
            &mut items,
            &owner,
            &AccountId::from("account-1"),
            &identity(),
            "user-1",
            false,
        )
        .unwrap();
        assert_eq!(items.0.len(), 1);
        assert_eq!(items.0[0]["password"], "password-canary");
        assert_eq!(items.0[0]["passkeys"][0]["privateKey"], "scalar-canary");
        drop(owner);
        assert_eq!(audited.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn refused_legacy_format_wipes_all_original_private_items_after_partial_copy() {
        let mut projection = export();
        let mut second = projection.items[0].clone();
        second.item_id = "item-2".into();
        second.vault_id = "missing-vault".into();
        projection.items.push(second);
        let (owner, audited) = audited_export(projection);
        let mut items = LegacyPrivateItems::default();
        assert!(append_legacy_export_items(
            &mut items,
            &owner,
            &AccountId::from("account-1"),
            &identity(),
            "user-1",
            false,
        )
        .is_err());
        assert_eq!(items.0.len(), 1);
        drop(owner);
        assert_eq!(audited.load(Ordering::SeqCst), 1);
    }
}

impl NativeSourceAttachment {
    /// The event connection uses Core's injected clock even when shutdown has
    /// already retired its source channel.
    pub fn legacy_event_timestamp(&self) -> Result<i64, RuntimeError> {
        i64::try_from(self.facade.runtime.clock.now_ms()?).map_err(|_| native_retired())
    }
    /// The headless source has no UI Active Account. Preserve protocol-1's account-specific
    /// enabled bit without guessing a selection from the catalog or activity history.
    pub async fn encode_legacy_biometric_status(
        &self,
        request_id: Option<&str>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        self.require_active()?;
        let RuntimeResponse::BiometricAvailability { hardware, .. } = self
            .facade
            .runtime
            .request_biometric(
                RuntimeRequest::BiometricAvailability {
                    account_ids: Vec::new(),
                },
                RequestCancellation::new(),
            )
            .await?
        else {
            return Err(native_retired());
        };
        let native = self.facade.runtime.native_observation_guard();
        self.require_active_in(&native.state)?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            protocol_version: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            request_id: Option<&'a str>,
            #[serde(rename = "type")]
            kind: &'static str,
            available: bool,
            enabled: bool,
            app_running: bool,
        }
        serde_json::to_string(&Payload {
            protocol_version: 1,
            request_id,
            kind: "BIOMETRIC_STATUS",
            available: hardware.has_hardware && hardware.is_enrolled,
            enabled: false,
            app_running: true,
        })
        .map(Zeroizing::new)
        .map_err(|_| native_retired())
    }

    /// Protocol-1 local transfer is a source-only disclosure after Core67's real ceremony.
    /// The browser correlation string is not a protocol-2 destination grant.
    pub async fn encode_legacy_biometric_single(
        &self,
        requested_account: Option<&str>,
        extension_id: &str,
        challenge: &str,
        request_id: Option<&str>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let runtime = &self.facade.runtime;
        self.require_active()?;
        let account_id = AccountId::from(requested_account.ok_or_else(native_retired)?);
        let scope = runtime.native_account_scope(&account_id)?;
        runtime.require_native_scope(&scope, false)?;
        {
            let state = runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            match state.channels.get(&self.channel_id) {
                Some(Channel::Source {
                    extension_id: origin,
                    ..
                }) if origin == extension_id => {}
                _ => return Err(native_retired()),
            }
        }
        let biometric_generation = runtime.biometric.generation(&account_id);
        let cancellation = RequestCancellation::new();
        let RuntimeResponse::BiometricUnlock { accounts } = runtime
            .request_biometric(
                RuntimeRequest::BiometricUnlock {
                    account_id: account_id.clone(),
                    prompt_message: "Unlock Bittery for browser extension".into(),
                },
                cancellation.clone(),
            )
            .await?
        else {
            return Err(native_retired());
        };
        let [result] = accounts.as_slice() else {
            return Err(native_retired());
        };
        if result.account_id != account_id || cancellation.is_cancelled() {
            return Err(native_retired());
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Refusal<'a> {
            protocol_version: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            request_id: Option<&'a str>,
            #[serde(rename = "type")]
            kind: &'static str,
            error: &'static str,
        }
        let encode_refusal = || {
            serde_json::to_string(&Refusal {
                protocol_version: 1,
                request_id,
                kind: "BIOMETRIC_UNLOCK_FAILED",
                error: "Biometric unlock was refused",
            })
            .map(Zeroizing::new)
            .map_err(|_| native_retired())
        };
        if result.failure.is_some() {
            self.require_active()?;
            return encode_refusal();
        }

        // Account execution owns all local material reads. Source/publication guards stay live
        // through final serialization, so Lock, removal and peer close refuse stale bytes.
        let execution = runtime.account_execution_lock_internal(&account_id)?;
        let _execution = execution.lock_owned().await;
        let quick = runtime
            .platform_storage
            .load_quick_unlock(&account_id, &scope.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        let device = runtime
            .platform_storage
            .load_device_key()
            .await?
            .ok_or_else(native_retired)?;
        let session = runtime
            .platform_storage
            .load_current_session(&account_id, &scope.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        let current_session = runtime
            .effective_session(&account_id, &scope.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        if current_session != session || !quick.biometric_enabled {
            return Err(native_retired());
        }
        let stored_key =
            unwrap_master_unlock_key(&quick.encrypted_master_unlock_key, &device.key_bytes)?;
        let live_key = runtime
            .copy_live_master_unlock_key(&account_id, &scope.incarnation)
            .ok_or_else(native_retired)?;
        if !bool::from(stored_key.as_slice().ct_eq(live_key.as_slice())) {
            return Err(native_retired());
        }
        let encrypted_json = Zeroizing::new(
            serde_json::to_vec(&quick.encrypted_master_unlock_key).map_err(|_| native_retired())?,
        );
        let encrypted_session = Zeroizing::new(BASE64.encode(encrypted_json.as_slice()));
        let device_key = Zeroizing::new(BASE64.encode(device.key_bytes.as_ref()));
        let signature_input = Zeroizing::new(format!("{challenge}:{}", encrypted_session.as_str()));
        let signature = Zeroizing::new(BASE64.encode(signature_input.as_bytes()));

        #[cfg(test)]
        runtime
            .foreground_attachments
            .before_finalization_admission();
        let reentry_period = runtime.reentry_period().await?;
        let native = runtime.native_observation_guard();
        self.require_active_in(&native.state)?;
        let _biometric = runtime
            .biometric
            .guard_generations(&[(account_id.clone(), biometric_generation)])
            .ok_or_else(native_retired)?;
        let _publication = runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        let snapshot = runtime.require_native_scope(&scope, true)?;
        if !runtime.generation_is_preparation_eligible(&snapshot) || cancellation.is_cancelled() {
            return Err(native_retired());
        }
        let metadata = runtime
            .account_display_identities
            .lock()
            .expect("Account display identity lock poisoned")
            .get(&account_id)
            .map(|display| display.identity.clone())
            .ok_or_else(native_retired)?;
        if metadata.server_url != scope.server_url {
            return Err(native_retired());
        }
        if biometric::require_local_deadlines(
            &quick,
            &session,
            reentry_period,
            runtime.clock.now_ms()?,
        )
        .is_err()
        {
            return encode_refusal();
        }
        let (vault_keys, _) = encode_visible_wrapped_keys(runtime, &snapshot)?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a> {
            protocol_version: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            request_id: Option<&'a str>,
            #[serde(rename = "type")]
            kind: &'static str,
            account_id: &'a str,
            email: &'a str,
            #[serde(rename = "encrypted_session")]
            encrypted_session: &'a str,
            #[serde(rename = "device_key")]
            device_key: &'a str,
            signature: &'a str,
            #[serde(rename = "auth_token")]
            auth_token: &'a str,
            #[serde(rename = "vault_keys")]
            vault_keys: &'a str,
        }
        serde_json::to_string(&Payload {
            protocol_version: 1,
            request_id,
            kind: "BIOMETRIC_UNLOCK_SUCCESS",
            account_id: account_id.as_str(),
            email: &metadata.email,
            encrypted_session: &encrypted_session,
            device_key: &device_key,
            signature: &signature,
            auth_token: session.token.as_ref(),
            vault_keys: &vault_keys,
        })
        .map(Zeroizing::new)
        .map_err(|_| native_retired())
    }

    /// The target set is the captured current catalog's biometric-enabled Accounts. Core67
    /// performs one prompt and independently decides each Account's retained-Session release.
    pub async fn encode_legacy_biometric_all(
        &self,
        extension_id: &str,
        challenge: &str,
        request_id: Option<&str>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let runtime = &self.facade.runtime;
        self.require_active()?;
        {
            let state = runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            match state.channels.get(&self.channel_id) {
                Some(Channel::Source {
                    extension_id: origin,
                    ..
                }) if origin == extension_id => {}
                _ => return Err(native_retired()),
            }
        }
        let catalog = runtime.platform_storage.load_device_catalog().await?;
        if catalog.as_ref().is_some_and(|catalog| {
            catalog.profile_admission_pending() || catalog.profile_reset_wiping()
        }) {
            return Err(native_retired());
        }
        let mut scopes = Vec::new();
        if let Some(catalog) = &catalog {
            for account in &catalog.accounts {
                if account.pending_install.is_some() || account.pending_retirement.is_some() {
                    return Err(native_retired());
                }
                let incarnation = account
                    .active_incarnation
                    .as_ref()
                    .ok_or_else(native_retired)?;
                let scope = runtime.native_account_scope(&account.account_id)?;
                if &scope.incarnation != incarnation {
                    return Err(native_retired());
                }
                runtime.require_native_scope(&scope, false)?;
                scopes.push(scope);
            }
        }
        let RuntimeResponse::BiometricAvailability { accounts, .. } = runtime
            .request_biometric(
                RuntimeRequest::BiometricAvailability {
                    account_ids: scopes
                        .iter()
                        .map(|scope| scope.account_id.clone())
                        .collect(),
                },
                RequestCancellation::new(),
            )
            .await?
        else {
            return Err(native_retired());
        };
        if accounts.len() != scopes.len() {
            return Err(native_retired());
        }
        let mut targets = Vec::new();
        for (scope, availability) in scopes.into_iter().zip(accounts) {
            if scope.account_id != availability.account_id {
                return Err(native_retired());
            }
            if availability.enabled {
                targets.push(scope);
            }
        }
        let biometric_generations: Vec<_> = targets
            .iter()
            .map(|scope| {
                (
                    scope.account_id.clone(),
                    runtime.biometric.generation(&scope.account_id),
                )
            })
            .collect();
        let cancellation = RequestCancellation::new();
        let RuntimeResponse::BiometricUnlock { accounts: results } = runtime
            .request_biometric(
                RuntimeRequest::BiometricUnlockAccounts {
                    account_ids: targets
                        .iter()
                        .map(|scope| scope.account_id.clone())
                        .collect(),
                    prompt_message: "Unlock all Bittery accounts for browser extension".into(),
                },
                cancellation.clone(),
            )
            .await?
        else {
            return Err(native_retired());
        };
        if results.len() != targets.len() || cancellation.is_cancelled() {
            return Err(native_retired());
        }
        let _catalog = runtime.catalog_transition.lock().await;
        if runtime.platform_storage.load_device_catalog().await? != catalog {
            return Err(native_retired());
        }
        let mut sorted_ids: Vec<_> = targets
            .iter()
            .map(|scope| scope.account_id.clone())
            .collect();
        sorted_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
        let mut execution_guards = Vec::with_capacity(sorted_ids.len());
        for account_id in sorted_ids {
            execution_guards.push(
                runtime
                    .account_execution_lock_internal(&account_id)?
                    .lock_owned()
                    .await,
            );
        }

        struct Material {
            scope: NativeAccountScope,
            revision: u64,
            email: String,
            encrypted_session: Zeroizing<String>,
            auth_token: Zeroizing<String>,
            vault_keys: Zeroizing<String>,
            quick: QuickUnlockDocument,
            session: CurrentSessionDocument,
        }
        let mut materials = Vec::new();
        let mut device_key: Option<Zeroizing<String>> = None;
        for (scope, result) in targets.iter().zip(&results) {
            if result.account_id != scope.account_id {
                return Err(native_retired());
            }
            if result.failure.is_some() {
                continue;
            }
            let snapshot = runtime.require_native_scope(scope, true)?;
            let quick = runtime
                .platform_storage
                .load_quick_unlock(&scope.account_id, &scope.incarnation)
                .await?
                .ok_or_else(native_retired)?;
            let device = runtime
                .platform_storage
                .load_device_key()
                .await?
                .ok_or_else(native_retired)?;
            let session = runtime
                .platform_storage
                .load_current_session(&scope.account_id, &scope.incarnation)
                .await?
                .ok_or_else(native_retired)?;
            let effective = runtime
                .effective_session(&scope.account_id, &scope.incarnation)
                .await?
                .ok_or_else(native_retired)?;
            if effective != session || !quick.biometric_enabled {
                return Err(native_retired());
            }
            let stored_key =
                unwrap_master_unlock_key(&quick.encrypted_master_unlock_key, &device.key_bytes)?;
            let live_key = runtime
                .copy_live_master_unlock_key(&scope.account_id, &scope.incarnation)
                .ok_or_else(native_retired)?;
            if !bool::from(stored_key.as_slice().ct_eq(live_key.as_slice())) {
                return Err(native_retired());
            }
            let encoded_device = Zeroizing::new(BASE64.encode(device.key_bytes.as_ref()));
            if device_key
                .as_ref()
                .is_some_and(|key| key.as_str() != encoded_device.as_str())
            {
                return Err(native_retired());
            }
            device_key = Some(encoded_device);
            let encrypted_json = Zeroizing::new(
                serde_json::to_vec(&quick.encrypted_master_unlock_key)
                    .map_err(|_| native_retired())?,
            );
            let identity = runtime
                .account_display_identities
                .lock()
                .expect("Account display identity lock poisoned")
                .get(&scope.account_id)
                .map(|display| display.identity.clone())
                .ok_or_else(native_retired)?;
            if identity.server_url != scope.server_url {
                return Err(native_retired());
            }
            let (vault_keys, _) = encode_visible_wrapped_keys(runtime, &snapshot)?;
            materials.push(Material {
                scope: scope.clone(),
                revision: snapshot.revision,
                email: identity.email.to_lowercase(),
                encrypted_session: Zeroizing::new(BASE64.encode(encrypted_json.as_slice())),
                auth_token: Zeroizing::new(session.token.as_ref().to_owned()),
                vault_keys,
                quick,
                session,
            });
        }

        #[cfg(test)]
        runtime
            .foreground_attachments
            .before_finalization_admission();
        let reentry_period = if materials.is_empty() {
            None
        } else {
            Some(runtime.reentry_period().await?)
        };
        let native = runtime.native_observation_guard();
        self.require_active_in(&native.state)?;
        let _biometric = runtime
            .biometric
            .guard_generations(&biometric_generations)
            .ok_or_else(native_retired)?;
        let _publication = runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        for scope in &targets {
            if runtime.native_account_scope(&scope.account_id)? != *scope {
                return Err(native_retired());
            }
        }
        let mut current_materials = Vec::with_capacity(materials.len());
        for material in materials {
            let snapshot = runtime.require_native_scope(&material.scope, true)?;
            if snapshot.revision != material.revision
                || !runtime.generation_is_preparation_eligible(&snapshot)
            {
                return Err(native_retired());
            }
            if biometric::require_local_deadlines(
                &material.quick,
                &material.session,
                reentry_period.expect("successful biometric material has a re-entry period"),
                runtime.clock.now_ms()?,
            )
            .is_err()
            {
                continue;
            }
            current_materials.push(material);
        }
        let materials = current_materials;
        let failed: Vec<_> = targets
            .iter()
            .filter(|scope| {
                !materials
                    .iter()
                    .any(|material| material.scope.account_id == scope.account_id)
            })
            .map(|scope| scope.account_id.as_str().to_owned())
            .collect();
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Account<'a> {
            account_id: &'a str,
            email: &'a str,
            #[serde(rename = "encrypted_session")]
            encrypted_session: &'a str,
            #[serde(rename = "auth_token")]
            auth_token: &'a str,
            #[serde(rename = "vault_keys")]
            vault_keys: &'a str,
        }
        let accounts: Vec<_> = materials
            .iter()
            .map(|material| Account {
                account_id: material.scope.account_id.as_str(),
                email: &material.email,
                encrypted_session: &material.encrypted_session,
                auth_token: &material.auth_token,
                vault_keys: &material.vault_keys,
            })
            .collect();
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Success<'a> {
            protocol_version: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            request_id: Option<&'a str>,
            #[serde(rename = "type")]
            kind: &'static str,
            #[serde(rename = "device_key")]
            device_key: &'a str,
            signature: &'a str,
            accounts: Vec<Account<'a>>,
            unlocked: Vec<&'a str>,
            failed: Vec<String>,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Refusal<'a> {
            protocol_version: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            request_id: Option<&'a str>,
            #[serde(rename = "type")]
            kind: &'static str,
            error: &'static str,
        }
        if accounts.is_empty() {
            serde_json::to_string(&Refusal {
                protocol_version: 1,
                request_id,
                kind: "BIOMETRIC_UNLOCK_ALL_FAILED",
                error: "No accounts could be unlocked",
            })
            .map(Zeroizing::new)
            .map_err(|_| native_retired())
        } else {
            let signature_input = Zeroizing::new(format!("{challenge}:{}", accounts.len()));
            let signature = Zeroizing::new(BASE64.encode(signature_input.as_bytes()));
            let unlocked = materials
                .iter()
                .map(|material| material.scope.account_id.as_str())
                .collect();
            serde_json::to_string(&Success {
                protocol_version: 1,
                request_id,
                kind: "BIOMETRIC_UNLOCK_ALL_SUCCESS",
                device_key: device_key.as_ref().ok_or_else(native_retired)?,
                signature: &signature,
                accounts,
                unlocked,
                failed,
            })
            .map(Zeroizing::new)
            .map_err(|_| native_retired())
        }
    }

    /// Protocol-1 status is a guarded Core projection for the unmigrated Extension. The
    /// returned Account list is local-read eligibility, never a grant or renderer assertion.
    pub async fn encode_legacy_status(
        &self,
        request_id: Option<&str>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let runtime = &self.facade.runtime;
        runtime.ensure_open()?;
        self.require_active()?;
        let catalog = runtime.platform_storage.load_device_catalog().await?;
        if catalog.as_ref().is_some_and(|catalog| {
            catalog.profile_admission_pending() || catalog.profile_reset_wiping()
        }) {
            return Err(native_retired());
        }

        struct StatusAccount {
            account_id: AccountId,
            incarnation: Incarnation,
            lock_epoch: u64,
            access: crate::AccountAccessState,
            failed: bool,
            eligible: bool,
        }
        let selection = runtime.inactivity_status_selection();
        let mut accounts = Vec::new();
        {
            let native = runtime.native_observation_guard();
            self.require_active_in(&native.state)?;
            let _publication = runtime
                .publication
                .lock()
                .expect("publication lock poisoned");
            if let Some(catalog) = &catalog {
                for account in &catalog.accounts {
                    if account.pending_install.is_some() || account.pending_retirement.is_some() {
                        return Err(native_retired());
                    }
                    let incarnation = account
                        .active_incarnation
                        .as_ref()
                        .ok_or_else(native_retired)?;
                    let snapshot = runtime
                        .replica
                        .snapshot(&account.account_id)
                        .ok_or_else(native_retired)?;
                    if snapshot.incarnation != *incarnation
                        || runtime.account_teardown_is_pending(&account.account_id)
                        || runtime.account_access_retirement_is_pending(&account.account_id)
                    {
                        return Err(native_retired());
                    }
                    let access = runtime
                        .account_access
                        .lock()
                        .expect("Account access lock poisoned")
                        .get(&account.account_id)
                        .copied()
                        .ok_or_else(native_retired)?;
                    accounts.push(StatusAccount {
                        account_id: account.account_id.clone(),
                        incarnation: snapshot.incarnation.clone(),
                        lock_epoch: snapshot.lock_epoch,
                        access,
                        failed: snapshot.failure.is_some(),
                        eligible: runtime.generation_is_preparation_eligible(&snapshot),
                    });
                }
            }
        }

        // Core67 uses this same selected incarnation and its persisted Account preference.
        // The removed-selection fallback protects any other unlocked Account.
        let selected_is_current = selection
            .as_ref()
            .is_some_and(|(account_id, incarnation, _)| {
                runtime
                    .replica
                    .snapshot(account_id)
                    .is_some_and(|snapshot| snapshot.incarnation == *incarnation)
                    && !runtime.account_teardown_is_pending(account_id)
            });
        let timeout = match &selection {
            None => Ok(0),
            Some((account_id, _, _)) if selected_is_current => {
                runtime
                    .platform_storage
                    .load_inactivity_timeout(account_id)
                    .await
            }
            Some(_) => Ok(600_000),
        };

        #[cfg(test)]
        runtime
            .foreground_attachments
            .before_finalization_admission();

        let _catalog = runtime.catalog_transition.lock().await;
        runtime.ensure_open()?;
        if runtime.platform_storage.load_device_catalog().await? != catalog {
            return Err(native_retired());
        }
        let mut account_ids: Vec<_> = accounts
            .iter()
            .map(|account| account.account_id.clone())
            .collect();
        account_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
        let mut execution_guards = Vec::with_capacity(account_ids.len());
        for account_id in account_ids {
            let execution = runtime.account_execution_lock_internal(&account_id)?;
            execution_guards.push(execution.lock_owned().await);
        }
        if runtime.inactivity_status_selection() != selection {
            return Err(native_retired());
        }
        // A setting changed while the first read waited must not be reported as current.
        let timeout = if selected_is_current && timeout.is_ok() {
            let Some((account_id, _, _)) = &selection else {
                unreachable!()
            };
            let current = runtime
                .platform_storage
                .load_inactivity_timeout(account_id)
                .await;
            if current.as_ref().ok() != timeout.as_ref().ok() {
                return Err(native_retired());
            }
            current
        } else {
            timeout
        };
        let timestamp = i64::try_from(runtime.clock.now_ms()?).map_err(|_| native_retired())?;
        let native = runtime.native_observation_guard();
        self.require_active_in(&native.state)?;
        let _publication = runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        if runtime.inactivity_status_selection() != selection {
            return Err(native_retired());
        }
        for account in &accounts {
            let snapshot = runtime.require_snapshot(&account.account_id)?;
            let access = runtime
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&account.account_id)
                .copied()
                .ok_or_else(native_retired)?;
            if snapshot.incarnation != account.incarnation
                || snapshot.lock_epoch != account.lock_epoch
                || access != account.access
                || snapshot.failure.is_some() != account.failed
                || runtime.account_teardown_is_pending(&account.account_id)
                || runtime.account_access_retirement_is_pending(&account.account_id)
                || runtime.generation_is_preparation_eligible(&snapshot) != account.eligible
            {
                return Err(native_retired());
            }
        }
        let unlocked_accounts: Vec<&str> = if timeout.is_err() {
            Vec::new()
        } else {
            accounts
                .iter()
                .filter(|account| account.eligible)
                .map(|account| account.account_id.as_str())
                .collect()
        };
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyPayload<'a> {
            protocol_version: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            request_id: Option<&'a str>,
            #[serde(rename = "type")]
            kind: &'static str,
            available: bool,
            locked: bool,
            unlocked_accounts: Vec<&'a str>,
            timestamp: i64,
            autolock_timeout_ms: i64,
        }
        serde_json::to_string(&LegacyPayload {
            protocol_version: 1,
            request_id,
            kind: "DESKTOP_STATUS",
            available: true,
            locked: unlocked_accounts.is_empty(),
            unlocked_accounts,
            timestamp,
            autolock_timeout_ms: timeout.unwrap_or(0),
        })
        .map(Zeroizing::new)
        .map_err(|_| native_retired())
    }

    /// Closed protocol-1 Account catalog encoding for the unmigrated Extension. The Device
    /// catalog and generation metadata remain Core-owned; this process has no UI active Account.
    pub async fn encode_legacy_accounts(
        &self,
        request_id: Option<&str>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let runtime = &self.facade.runtime;
        runtime.ensure_open()?;
        self.require_active()?;

        let catalog = runtime.platform_storage.load_device_catalog().await?;
        if catalog.as_ref().is_some_and(|catalog| {
            catalog.profile_admission_pending() || catalog.profile_reset_wiping()
        }) {
            return Err(native_retired());
        }

        let mut accounts = Vec::new();
        {
            let native = runtime.native_observation_guard();
            self.require_active_in(&native.state)?;
            let _publication = runtime
                .publication
                .lock()
                .expect("publication lock poisoned");
            if let Some(catalog) = &catalog {
                for account in &catalog.accounts {
                    if account.pending_install.is_some() || account.pending_retirement.is_some() {
                        return Err(native_retired());
                    }
                    let incarnation = account
                        .active_incarnation
                        .as_ref()
                        .ok_or_else(native_retired)?;
                    let snapshot = runtime
                        .replica
                        .snapshot(&account.account_id)
                        .ok_or_else(native_retired)?;
                    if snapshot.incarnation != *incarnation
                        || snapshot.failure.is_some()
                        || runtime.account_teardown_is_pending(&account.account_id)
                        || runtime.account_access_retirement_is_pending(&account.account_id)
                    {
                        return Err(native_retired());
                    }
                    let access = runtime
                        .account_access
                        .lock()
                        .expect("Account access lock poisoned")
                        .get(&account.account_id)
                        .copied()
                        .ok_or_else(native_retired)?;
                    let display_identity = runtime
                        .account_display_identities
                        .lock()
                        .expect("Account display identity lock poisoned")
                        .get(&account.account_id)
                        .map(|presentation| presentation.identity.clone())
                        .ok_or_else(native_retired)?;
                    accounts.push(LegacyAccountsGuard {
                        account_id: account.account_id.clone(),
                        incarnation: snapshot.incarnation.clone(),
                        user_id: snapshot.user_id.clone(),
                        lock_epoch: snapshot.lock_epoch,
                        access,
                        eligible: runtime.generation_is_preparation_eligible(&snapshot),
                        metadata: None,
                        display_identity,
                        entry: None,
                    });
                }
            }
        }
        for account in &mut accounts {
            let metadata = runtime
                .platform_storage
                .load_account_metadata(&account.account_id, &account.incarnation)
                .await?
                .ok_or_else(native_retired)?;
            if metadata.account_id != account.account_id
                || metadata.incarnation != account.incarnation
                || metadata.user_id != account.user_id
                || legacy_account_display_identity(&metadata) != account.display_identity
            {
                return Err(native_retired());
            }
            account.entry = Some(legacy_desktop_account_entry(
                &account.account_id,
                &metadata,
            )?);
            account.metadata = Some(metadata);
        }

        // The test seam holds only this prepared identity list so retirement races exercise the
        // same last-check boundary as the other Core native source encoders.
        #[cfg(test)]
        runtime
            .foreground_attachments
            .before_finalization_admission();

        let _catalog = runtime.catalog_transition.lock().await;
        runtime.ensure_open()?;
        if runtime.platform_storage.load_device_catalog().await? != catalog {
            return Err(native_retired());
        }
        let mut account_ids: Vec<_> = accounts
            .iter()
            .map(|account| account.account_id.clone())
            .collect();
        account_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
        let mut execution_guards = Vec::with_capacity(account_ids.len());
        for account_id in account_ids {
            let execution = runtime.account_execution_lock_internal(&account_id)?;
            execution_guards.push(execution.lock_owned().await);
        }

        for account in &accounts {
            let metadata = runtime
                .platform_storage
                .load_account_metadata(&account.account_id, &account.incarnation)
                .await?
                .ok_or_else(native_retired)?;
            if Some(metadata.clone()) != account.metadata
                || Some(legacy_desktop_account_entry(
                    &account.account_id,
                    &metadata,
                )?) != account.entry
                || legacy_account_display_identity(&metadata) != account.display_identity
            {
                return Err(native_retired());
            }
        }

        let native = runtime.native_observation_guard();
        self.require_active_in(&native.state)?;
        let _publication = runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        for account in &accounts {
            let snapshot = runtime.require_snapshot(&account.account_id)?;
            let access = runtime
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&account.account_id)
                .copied()
                .ok_or_else(native_retired)?;
            let current_identity = runtime
                .account_display_identities
                .lock()
                .expect("Account display identity lock poisoned")
                .get(&account.account_id)
                .map(|presentation| presentation.identity.clone())
                .ok_or_else(native_retired)?;
            if snapshot.incarnation != account.incarnation
                || snapshot.user_id != account.user_id
                || snapshot.lock_epoch != account.lock_epoch
                || access != account.access
                || runtime.account_teardown_is_pending(&account.account_id)
                || runtime.account_access_retirement_is_pending(&account.account_id)
                || runtime.generation_is_preparation_eligible(&snapshot) != account.eligible
                || current_identity != account.display_identity
            {
                return Err(native_retired());
            }
        }

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyPayload<'a> {
            protocol_version: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            request_id: Option<&'a str>,
            #[serde(rename = "type")]
            kind: &'static str,
            accounts: &'a [LegacyDesktopAccountEntry],
            active_account: Option<&'a str>,
            unlocked_accounts: Vec<&'a str>,
        }
        let unlocked_accounts = accounts
            .iter()
            .filter(|account| account.eligible)
            .map(|account| account.account_id.as_str())
            .collect();
        let entries = accounts
            .iter()
            .map(|account| account.entry.clone().ok_or_else(native_retired))
            .collect::<Result<Vec<_>, _>>()?;
        serde_json::to_string(&LegacyPayload {
            protocol_version: 1,
            request_id,
            kind: "DESKTOP_ACCOUNTS",
            accounts: &entries,
            active_account: None,
            unlocked_accounts,
        })
        .map(Zeroizing::new)
        .map_err(|_| native_retired())
    }

    /// Closed protocol-1 source encoding for the unmigrated Extension. The caller owns an
    /// authenticated native socket; the renderer cannot construct this attachment. Selection,
    /// private decryption and final serialization share Core's native/publication guards.
    pub fn encode_legacy_items_snapshot(
        &self,
        requested_accounts: Option<&[String]>,
        request_id: Option<&str>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let runtime = &self.facade.runtime;
        runtime.ensure_open()?;
        let (items, guards) = {
            let native = runtime.native_observation_guard();
            self.require_active_in(&native.state)?;
            let _publication = runtime
                .publication
                .lock()
                .expect("publication lock poisoned");

            let targets: Vec<AccountId> = match requested_accounts {
                Some(ids) if !ids.is_empty() => ids.iter().cloned().map(AccountId::from).collect(),
                _ => runtime
                    .replica
                    .snapshots()
                    .into_iter()
                    .filter(|snapshot| runtime.generation_is_preparation_eligible(snapshot))
                    .map(|snapshot| snapshot.account_id)
                    .collect(),
            };
            let mut unique = HashSet::new();
            if targets
                .iter()
                .any(|account| !unique.insert(account.clone()))
            {
                return Err(native_retired());
            }
            let include_account_context = targets.len() > 1;
            let mut items = LegacyPrivateItems::default();
            let mut guards = Vec::new();
            for account_id in targets {
                let Some(snapshot) = runtime.replica.snapshot(&account_id) else {
                    return Err(native_retired());
                };
                // A locked explicit target contributes no Items. Local reads use live keys and the
                // verified/offline policy; they do not acquire a usable network Session.
                if !runtime.generation_is_preparation_eligible(&snapshot) {
                    continue;
                }
                let vault_ids: Vec<_> = visible_vaults(&snapshot)
                    .into_iter()
                    .filter(|vault| !runtime.vault_is_fenced(&snapshot, &vault.vault_id))
                    .map(|vault| vault.vault_id)
                    .collect();
                let export = if vault_ids.is_empty() {
                    None
                } else {
                    let RuntimeProjection::VaultExport(export) = runtime
                        .projection_locked(
                            &ObservationRequest::VaultExport {
                                account_id: account_id.clone(),
                                vault_ids: vault_ids.clone(),
                            },
                            &native,
                        )?
                        .projection
                    else {
                        unreachable!("VaultExport projection changed variant");
                    };
                    // Take ownership before scope validation, loan registration, or presentation
                    // lookup can refuse. Even a partially formatted projection must be wiped.
                    Some(LegacyPrivateExport::new(export))
                };
                let captured_vault_ids = runtime.vault_export_capture_scopes(
                    &snapshot,
                    &vault_ids,
                    export
                        .as_ref()
                        .map_or(&[], |export| export.projection.items.as_slice()),
                )?;
                let cancellation = RequestCancellation::new();
                let loan = runtime.foreground_attachments.register_target(
                    &account_id,
                    &snapshot.incarnation,
                    super::foreground_attachment_lifecycle::ForegroundAttachmentTarget::VaultExport {
                        vault_ids: captured_vault_ids.clone(),
                    },
                    cancellation.clone(),
                )?;
                guards.push(LegacySnapshotGuard {
                    account_id: account_id.clone(),
                    incarnation: snapshot.incarnation.clone(),
                    user_id: snapshot.user_id.clone(),
                    lock_epoch: snapshot.lock_epoch,
                    revision: snapshot.revision,
                    vault_ids: captured_vault_ids,
                    loan,
                    cancellation,
                });
                let Some(export) = export else {
                    continue;
                };
                let identity = runtime
                    .account_display_identities
                    .lock()
                    .expect("Account display identity lock poisoned")
                    .get(&account_id)
                    .map(|presentation| presentation.identity.clone())
                    .ok_or_else(native_retired)?;
                append_legacy_export_items(
                    &mut items,
                    &export,
                    &account_id,
                    &identity,
                    &snapshot.user_id,
                    include_account_context,
                )?;
            }
            (items, guards)
        };
        // Capture can outlive its read locks while the caller awaits an OS callback or the
        // browser port. Final admission refuses any retired scope or replaced readable row.
        #[cfg(test)]
        runtime
            .foreground_attachments
            .before_finalization_admission();
        let native = runtime.native_observation_guard();
        self.require_active_in(&native.state)?;
        let _publication = runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        for guard in &guards {
            let snapshot = runtime.require_snapshot(&guard.account_id)?;
            if snapshot.incarnation != guard.incarnation
                || snapshot.user_id != guard.user_id
                || snapshot.lock_epoch != guard.lock_epoch
                || snapshot.revision != guard.revision
                || !runtime.generation_is_preparation_eligible(&snapshot)
                || guard.vault_ids.iter().any(|id| {
                    !visible_vaults(&snapshot)
                        .iter()
                        .any(|vault| &vault.vault_id == id)
                        || runtime.vault_is_fenced(&snapshot, id)
                })
                || !runtime
                    .foreground_attachments
                    .admit_finalization(&guard.loan, &guard.cancellation)
            {
                return Err(native_retired());
            }
        }
        let generated_at = i64::try_from(runtime.clock.now_ms()?).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Runtime clock is outside the protocol-1 timestamp range",
            )
        })?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyPayload<'a> {
            protocol_version: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            request_id: Option<&'a str>,
            #[serde(rename = "type")]
            kind: &'static str,
            items: &'a [serde_json::Value],
            generated_at: i64,
        }
        serde_json::to_string(&LegacyPayload {
            protocol_version: 1,
            request_id,
            kind: "DESKTOP_ITEMS_SNAPSHOT",
            items: &items.0,
            generated_at,
        })
        .map(Zeroizing::new)
        .map_err(|_| native_retired())
    }

    /// Source-only protocol-1 wrapped-key read. This uses local visible Vault authority, not an
    /// effective network Session, and never asks the legacy Desktop key-reference store to fill
    /// a missing row. The captured source and Vault set are checked again at final encoding.
    pub fn encode_legacy_vault_keys(
        &self,
        requested_account: &str,
        request_id: Option<&str>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let runtime = &self.facade.runtime;
        runtime.ensure_open()?;
        let account_id = AccountId::from(requested_account);
        let (keys_json, guard) = {
            let native = runtime.native_observation_guard();
            self.require_active_in(&native.state)?;
            let _publication = runtime
                .publication
                .lock()
                .expect("publication lock poisoned");
            let snapshot = runtime.require_snapshot(&account_id)?;
            if !runtime.generation_is_preparation_eligible(&snapshot) {
                return Err(native_retired());
            }
            let email = runtime
                .account_display_identities
                .lock()
                .expect("Account display identity lock poisoned")
                .get(&account_id)
                .map(|presentation| presentation.identity.email.clone())
                .ok_or_else(native_retired)?;
            let (keys_json, vault_ids) = encode_visible_wrapped_keys(runtime, &snapshot)?;
            (
                keys_json,
                LegacyWrappedKeysGuard {
                    account_id,
                    incarnation: snapshot.incarnation,
                    user_id: snapshot.user_id,
                    lock_epoch: snapshot.lock_epoch,
                    revision: snapshot.revision,
                    vault_ids,
                    email,
                },
            )
        };

        #[cfg(test)]
        runtime
            .foreground_attachments
            .before_finalization_admission();
        let native = runtime.native_observation_guard();
        self.require_active_in(&native.state)?;
        let _publication = runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        let current = runtime.require_snapshot(&guard.account_id)?;
        if current.incarnation != guard.incarnation
            || current.user_id != guard.user_id
            || current.lock_epoch != guard.lock_epoch
            || current.revision != guard.revision
            || !runtime.generation_is_preparation_eligible(&current)
        {
            return Err(native_retired());
        }
        let (current_keys_json, current_vault_ids) =
            encode_visible_wrapped_keys(runtime, &current)?;
        if current_vault_ids != guard.vault_ids
            || current_keys_json.as_str() != keys_json.as_str()
            || runtime
                .account_display_identities
                .lock()
                .expect("Account display identity lock poisoned")
                .get(&guard.account_id)
                .is_none_or(|presentation| presentation.identity.email != guard.email)
        {
            return Err(native_retired());
        }

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyPayload<'a> {
            protocol_version: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            request_id: Option<&'a str>,
            #[serde(rename = "type")]
            kind: &'static str,
            account_id: &'a str,
            email: &'a str,
            vault_keys: &'a str,
        }
        serde_json::to_string(&LegacyPayload {
            protocol_version: 1,
            request_id,
            kind: "DESKTOP_VAULT_KEYS",
            account_id: guard.account_id.as_str(),
            email: &guard.email,
            vault_keys: &keys_json,
        })
        .map(Zeroizing::new)
        .map_err(|_| native_retired())
    }

    /// Disclose only the locally usable effective Session for this exact current Account.
    /// The transport owns the final encoded bytes; Core keeps no protocol-1 token mirror.
    pub async fn encode_legacy_auth_token(
        &self,
        requested_account: &str,
        request_id: Option<&str>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let runtime = &self.facade.runtime;
        self.require_active()?;
        let account_id = AccountId::from(requested_account);
        let scope = runtime.native_account_scope(&account_id)?;
        runtime.require_native_scope(&scope, true)?;
        let email = runtime
            .account_display_identities
            .lock()
            .expect("Account display identity lock poisoned")
            .get(&account_id)
            .map(|presentation| presentation.identity.email.clone())
            .ok_or_else(native_retired)?;
        let session = runtime
            .effective_session(&account_id, &scope.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        if session.account_id != account_id || session.incarnation != scope.incarnation {
            return Err(native_retired());
        }
        require_usable_session(&session, runtime.clock.now_ms()?)?;

        #[cfg(test)]
        runtime
            .foreground_attachments
            .before_finalization_admission();

        // Account mutations use this execution owner. The Session primitive read is bounded
        // local storage; no transport or prompt is awaited while it is held.
        let execution = runtime.account_execution_lock_internal(&account_id)?;
        let _execution = execution.lock_owned().await;
        let current_session = runtime
            .effective_session(&account_id, &scope.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        if current_session != session {
            return Err(native_retired());
        }
        let native = runtime.native_observation_guard();
        self.require_active_in(&native.state)?;
        let _publication = runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        runtime.require_native_scope(&scope, true)?;
        if runtime
            .account_display_identities
            .lock()
            .expect("Account display identity lock poisoned")
            .get(&account_id)
            .is_none_or(|presentation| presentation.identity.email != email)
        {
            return Err(native_retired());
        }
        // A borrowed grant can be replaced independently of local platform storage.
        match (&session.provenance, native.state.grants.get(&account_id)) {
            (SessionProvenance::Borrowed { .. }, Some(grant)) if grant.session == session => {}
            (SessionProvenance::Independent, None)
                if !native.state.standalone_blocked.contains(&account_id) => {}
            _ => return Err(native_retired()),
        }
        require_usable_session(&session, runtime.clock.now_ms()?)?;
        let expires_at = i64::try_from(
            session
                .server_expires_at_ms
                .unwrap_or(session.expires_at_ms),
        )
        .map_err(|_| native_retired())?;

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct LegacyPayload<'a> {
            protocol_version: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            request_id: Option<&'a str>,
            #[serde(rename = "type")]
            kind: &'static str,
            account_id: &'a str,
            email: &'a str,
            auth_token: &'a str,
            expires_at: i64,
            user_id: &'a str,
        }
        let encoded = serde_json::to_string(&LegacyPayload {
            protocol_version: 1,
            request_id,
            kind: "DESKTOP_AUTH_TOKEN",
            account_id: account_id.as_str(),
            email: &email,
            auth_token: session.token.as_ref(),
            expires_at,
            user_id: &scope.user_id,
        })
        .map(Zeroizing::new)
        .map_err(|_| native_retired())?;
        require_usable_session(&session, runtime.clock.now_ms()?)?;
        Ok(encoded)
    }

    pub fn acknowledge_restrictions(
        &self,
        acknowledgement: NativeRestrictionAcknowledgement,
    ) -> Result<(), RuntimeError> {
        if acknowledgement.source_channel != self.channel_id {
            return Err(native_retired());
        }
        self.facade.acknowledge_restrictions(acknowledgement)
    }

    pub fn snapshot(&self) -> Result<NativeAuthoritySnapshot, RuntimeError> {
        self.facade.source_snapshot(&self.channel_id)
    }

    /// Existing Core owner lifecycle notification for trusted transports. Ordinary source close is
    /// synchronous and owned by the transport itself; a status subscription is only a wake signal.
    pub async fn runtime_closed(&self) {
        loop {
            let finished = self.facade.runtime.close_finished.notified();
            tokio::pin!(finished);
            finished.as_mut().enable();
            if self.facade.runtime.close_complete.load(Ordering::SeqCst) {
                return;
            }
            finished.await;
        }
    }

    pub fn close(&self) {
        let mut state = self
            .facade
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        if matches!(
            state.channels.get(&self.channel_id),
            Some(Channel::Source { .. })
        ) {
            let scopes = self.facade.retire_channel_in(&mut state, &self.channel_id);
            debug_assert!(scopes.is_empty());
        }
    }

    fn require_challenge(&self, challenge: &NativeImportChallenge) -> Result<(), RuntimeError> {
        if challenge.source_channel != self.channel_id {
            return Err(native_retired());
        }
        self.facade.require_source_channel(challenge)
    }

    fn require_active(&self) -> Result<(), RuntimeError> {
        self.facade.runtime.ensure_open()?;
        let state = self
            .facade
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        self.require_active_in(&state)
    }

    fn require_active_in(&self, state: &AuthorityState) -> Result<(), RuntimeError> {
        if matches!(
            state.channels.get(&self.channel_id),
            Some(Channel::Source { .. })
        ) {
            Ok(())
        } else {
            Err(native_retired())
        }
    }

    /// Wake subscription only: the trusted transport discards its projection, obtains a fresh
    /// snapshot for each wake, and closes this handle when retiring the port. The subscription
    /// itself carries no source authority and cannot keep the channel alive.
    pub fn observe_changes(
        &self,
        sink: Arc<dyn crate::ObservationSink>,
    ) -> Result<Arc<crate::ObservationHandle>, RuntimeError> {
        self.require_active()?;
        // Observe may synchronously call foreign code. Never hold the native state lock here.
        let handle = self.facade.runtime.observe(
            crate::ObservationRequest::RuntimeStatus { account_id: None },
            sink,
        )?;
        if let Err(error) = self.require_active() {
            handle.close();
            return Err(error);
        }
        Ok(handle)
    }

    pub async fn export_with_biometric(
        &self,
        challenge: NativeImportChallenge,
        prompt_message: String,
    ) -> Result<NativeAuthorityResponse, RuntimeError> {
        self.require_challenge(&challenge)?;
        self.facade
            .export_with_biometric(challenge, prompt_message)
            .await
    }

    pub fn encode_response(
        &self,
        response: &NativeAuthorityResponse,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        match response {
            NativeAuthorityResponse::IndependentRestrictionsRevalidated { reply } => {
                self.require_challenge(&reply.challenge)?;
                self.facade.encode_response(response)
            }
            NativeAuthorityResponse::Exported { reply } => {
                self.require_challenge(&reply.challenge)?;
                self.facade.encode_response(response)
            }
            NativeAuthorityResponse::Source { snapshot }
                if snapshot.channel_id == self.channel_id =>
            {
                self.encode_active_response(response)
            }
            NativeAuthorityResponse::BiometricRefused { .. } | NativeAuthorityResponse::Applied => {
                self.encode_active_response(response)
            }
            _ => Err(native_retired()),
        }
    }

    fn encode_active_response(
        &self,
        response: &NativeAuthorityResponse,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        self.facade.runtime.ensure_open()?;
        let state = self
            .facade
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        self.require_active_in(&state)?;
        // These responses are nonsecret and cannot recursively enter the Exported delivery guard.
        self.facade.encode_response(response)
    }

    pub async fn revalidate_independent_restrictions(
        &self,
        challenge: NativeImportChallenge,
    ) -> Result<NativeIndependentRevalidationReply, RuntimeError> {
        self.require_challenge(&challenge)?;
        self.facade
            .revalidate_independent_restrictions(challenge)
            .await
    }

    pub async fn export(
        &self,
        challenge: NativeImportChallenge,
    ) -> Result<NativeTransferReply, RuntimeError> {
        self.require_challenge(&challenge)?;
        self.facade.export(challenge).await
    }
}

impl Drop for NativeSourceAttachment {
    fn drop(&mut self) {
        self.close();
    }
}

pub struct NativeAuthorityFacade {
    runtime: Arc<Runtime>,
}

#[derive(Clone)]
enum Channel {
    Source {
        extension_id: String,
        transport_id: String,
        sequence: u64,
        restrictions: SourceRestrictions,
    },
    Desktop {
        source: NativeAuthoritySnapshot,
        transport_id: String,
        restrictions: DestinationRestrictions,
    },
}

struct BorrowedGrant {
    restrictions: GrantRestrictions,
    binding: NativeImportChallenge,
    session: CurrentSessionDocument,
}

#[derive(Default)]
struct AuthorityState {
    channels: HashMap<String, Channel>,
    challenges: HashMap<String, NativeImportChallenge>,
    ceremonies: HashMap<String, PendingNativeCeremony>,
    grants: HashMap<AccountId, BorrowedGrant>,
    standalone_blocked: HashSet<AccountId>,
    retirements: HashMap<AccountId, PendingNativeRetirement>,
    source_key_generations: HashMap<AccountId, SourceKeyAuthority>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NativeCeremonyDirection {
    Source,
    Destination,
}

struct PendingNativeCeremony {
    challenge: NativeImportChallenge,
    direction: NativeCeremonyDirection,
    cancellation: RequestCancellation,
}

impl PendingNativeCeremony {
    fn scope(&self) -> &NativeAccountScope {
        match self.direction {
            NativeCeremonyDirection::Source => &self.challenge.source,
            NativeCeremonyDirection::Destination => &self.challenge.destination,
        }
    }

    fn channel(&self) -> &str {
        match self.direction {
            NativeCeremonyDirection::Source => &self.challenge.source_channel,
            NativeCeremonyDirection::Destination => &self.challenge.destination_channel,
        }
    }
}

struct PendingNativeRetirement {
    scope: NativeAccountScope,
    running: bool,
    attempts: u64,
    retry_at_ms: u64,
    last_error: Option<RuntimeError>,
}

struct NativeRetirementLease<'a> {
    runtime: &'a Runtime,
    scope: NativeAccountScope,
    completed: bool,
}
impl Drop for NativeRetirementLease<'_> {
    fn drop(&mut self) {
        if !self.completed {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            if let Some(pending) = state
                .retirements
                .get_mut(&self.scope.account_id)
                .filter(|pending| pending.scope == self.scope)
            {
                pending.running = false;
            }
            drop(state);
            self.runtime.wake_dispatch();
        }
    }
}

pub(super) struct NativeAuthorityState {
    owner: String,
    state: Mutex<AuthorityState>,
    channel_attachment: tokio::sync::Mutex<()>,
}

impl Default for NativeAuthorityState {
    fn default() -> Self {
        Self {
            owner: bittery_crypto_core::generate_uuid(),
            state: Mutex::default(),
            channel_attachment: tokio::sync::Mutex::new(()),
        }
    }
}

pub(super) struct NativeObservationGuard<'a> {
    state: std::sync::MutexGuard<'a, AuthorityState>,
}

impl NativeObservationGuard<'_> {
    pub(super) fn unlock_capabilities(
        &self,
        presentation: Option<&AccountPresentation>,
        user_id: &str,
        access: AccountAccessState,
    ) -> AccountUnlockCapabilities {
        let Some(presentation) = presentation else {
            return AccountUnlockCapabilities::default();
        };
        let independent =
            independent_identity_allowed(&self.state, &presentation.identity.server_url, user_id);
        AccountUnlockCapabilities {
            password: access == AccountAccessState::Locked
                && !presentation.native_only
                && independent,
            desktop: presentation.native_only || !independent,
            sign_in: independent,
        }
    }
}

pub(super) struct NativeLocalPublicationGuard<'a> {
    _state: std::sync::MutexGuard<'a, AuthorityState>,
    pub(super) allowed: bool,
}

fn retire_account_in_state(state: &mut AuthorityState, account: &AccountId) {
    if state.grants.remove(account).is_some() {
        state.standalone_blocked.insert(account.clone());
    }
    state
        .challenges
        .retain(|_, challenge| &challenge.destination.account_id != account);
    for ceremony in state.ceremonies.values() {
        if &ceremony.scope().account_id == account {
            ceremony.cancellation.cancel();
        }
    }
}

fn independent_identity_allowed(state: &AuthorityState, server_url: &str, user_id: &str) -> bool {
    !state.channels.values().any(|channel| match channel {
        Channel::Desktop { source, .. } => source.accounts.iter().any(|authority| {
            authority.scope.server_url == server_url && authority.scope.user_id == user_id
        }),
        Channel::Source { .. } => false,
    })
}

impl NativeAuthorityState {
    pub(super) fn owner_incarnation(&self) -> &str {
        &self.owner
    }

    #[cfg(test)]
    pub(super) fn retirement_is_running(&self, account: &AccountId) -> bool {
        self.state
            .lock()
            .expect("native authority lock poisoned")
            .retirements
            .get(account)
            .is_some_and(|pending| pending.running)
    }

    #[cfg(test)]
    pub(super) fn has_borrowed_session(&self, account: &AccountId) -> bool {
        self.state
            .lock()
            .expect("native authority lock poisoned")
            .grants
            .contains_key(account)
    }

    pub(super) fn retire_account(&self, account: &AccountId) {
        let mut state = self.state.lock().expect("native authority lock poisoned");
        retire_account_in_state(&mut state, account);
    }

    pub(super) fn retire_all(&self) {
        let mut state = self.state.lock().expect("native authority lock poisoned");
        for ceremony in state.ceremonies.values() {
            ceremony.cancellation.cancel();
        }
        for channel in state.channels.values() {
            if let Channel::Desktop { restrictions, .. } = channel {
                restrictions.cancel_adoption_waiters();
            }
        }
        *state = AuthorityState::default();
    }
}

struct NativeCeremonyLease<'a> {
    owner: &'a NativeAuthorityState,
    id: String,
}

impl Drop for NativeCeremonyLease<'_> {
    fn drop(&mut self) {
        if let Some(ceremony) = self
            .owner
            .state
            .lock()
            .expect("native authority lock poisoned")
            .ceremonies
            .remove(&self.id)
        {
            ceremony.cancellation.cancel();
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferMaterial {
    encrypted_master_unlock_key: bittery_crypto_core::EncryptedData,
    device_key: SecretBytes32,
    session: CurrentSessionDocument,
}

impl Runtime {
    pub(super) fn native_observation_guard(&self) -> NativeObservationGuard<'_> {
        NativeObservationGuard {
            state: self
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned"),
        }
    }

    async fn finish_native_retirement(
        &self,
        mut lease: NativeRetirementLease<'_>,
    ) -> Result<(), RuntimeError> {
        let snapshot = self
            .replica
            .snapshot(&lease.scope.account_id)
            .filter(|snapshot| {
                snapshot.incarnation == lease.scope.incarnation
                    && snapshot.user_id == lease.scope.user_id
                    && snapshot.lock_epoch == lease.scope.lock_epoch
            });
        let result = if let Some(snapshot) = snapshot {
            self.retire_account_generation(&snapshot).await.map(|_| ())
        } else {
            Ok(())
        };
        let result = match result {
            Err(error) if error.code == RuntimeErrorCode::Cancelled => Ok(()),
            result => result,
        };
        let mut state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        if state
            .retirements
            .get(&lease.scope.account_id)
            .is_some_and(|pending| pending.scope == lease.scope)
        {
            match &result {
                Ok(()) => {
                    state.retirements.remove(&lease.scope.account_id);
                }
                Err(error) => {
                    let pending = state
                        .retirements
                        .get_mut(&lease.scope.account_id)
                        .expect("pending retirement checked");
                    pending.running = false;
                    pending.attempts = pending.attempts.saturating_add(1);
                    pending.retry_at_ms = self
                        .clock
                        .now_ms()
                        .unwrap_or(0)
                        .saturating_add(super::dispatch::backoff_ms(pending.attempts));
                    pending.last_error = Some(error.clone());
                }
            }
        }
        lease.completed = true;
        drop(state);
        self.wake_dispatch();
        result
    }

    fn claim_native_retirements(
        &self,
        scopes: &[NativeAccountScope],
    ) -> Result<Vec<NativeRetirementLease<'_>>, RuntimeError> {
        let now = self.clock.now_ms()?;
        let leases = {
            let mut state = self
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let mut leases = Vec::new();
            for scope in scopes {
                if let Some(pending) =
                    state
                        .retirements
                        .get_mut(&scope.account_id)
                        .filter(|pending| {
                            pending.scope == *scope
                                && !pending.running
                                && pending.retry_at_ms <= now
                        })
                {
                    pending.running = true;
                    leases.push(NativeRetirementLease {
                        runtime: self,
                        scope: scope.clone(),
                        completed: false,
                    });
                }
            }
            leases
        };
        Ok(leases)
    }

    async fn drive_native_retirements(
        &self,
        scopes: &[NativeAccountScope],
    ) -> Result<bool, RuntimeError> {
        let leases = self.claim_native_retirements(scopes)?;
        if leases.is_empty() {
            return Ok(false);
        }
        let mut pending: Vec<_> = leases
            .into_iter()
            .map(|lease| Some(Box::pin(self.finish_native_retirement(lease))))
            .collect();
        let mut failure = None;
        std::future::poll_fn(|context| {
            for slot in &mut pending {
                if let Some(future) = slot {
                    if let std::task::Poll::Ready(result) =
                        std::future::Future::poll(future.as_mut(), context)
                    {
                        if let Err(error) = result {
                            if failure.is_none() {
                                failure = Some(error);
                            }
                        }
                        *slot = None;
                    }
                }
            }
            if pending.iter().all(Option::is_none) {
                std::task::Poll::Ready(failure.take().map_or(Ok(true), Err))
            } else {
                std::task::Poll::Pending
            }
        })
        .await
    }

    pub(super) async fn run_native_authority_retirements(&self) {
        let mut active = Vec::new();
        loop {
            let mut wake = std::pin::pin!(self.dispatch_wake.notified());
            wake.as_mut().enable();
            if self.is_closed() {
                return;
            }
            let scopes: Vec<_> = self
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned")
                .retirements
                .values()
                .map(|pending| pending.scope.clone())
                .collect();
            active.retain(Option::is_some);
            if let Ok(leases) = self.claim_native_retirements(&scopes) {
                active.extend(
                    leases
                        .into_iter()
                        .map(|lease| Some(Box::pin(self.finish_native_retirement(lease)))),
                );
            }
            // Keep existing Account drains alive while a wake admits newly queued Accounts.
            // A blocked Account must not prevent an unrelated Account from completing retirement.
            let completed = std::future::poll_fn(|context| {
                let mut progressed = false;
                for slot in &mut active {
                    if let Some(future) = slot {
                        if std::future::Future::poll(future.as_mut(), context).is_ready() {
                            *slot = None;
                            progressed = true;
                        }
                    }
                }
                if progressed {
                    std::task::Poll::Ready(())
                } else {
                    std::task::Poll::Pending
                }
            });
            let deadline = self
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned")
                .retirements
                .values()
                .filter(|pending| !pending.running)
                .map(|pending| pending.retry_at_ms)
                .min();
            match (deadline, self.clock.now_ms()) {
                (Some(deadline), Ok(now)) if deadline <= now => continue,
                (Some(deadline), Ok(now)) => {
                    tokio::select! {
                        () = completed => {},
                        () = wake => {},
                        () = self.device_timer.sleep_ms(deadline - now) => {},
                    }
                }
                (Some(_), Err(_)) => {
                    tokio::select! {
                        () = completed => {},
                        () = wake => {},
                        () = self.device_timer.sleep_ms(super::dispatch::backoff_ms(1)) => {},
                    }
                }
                (None, _) => {
                    tokio::select! { () = completed => {}, () = wake => {} }
                }
            }
        }
    }
}

impl Runtime {
    /// The caller must be a trusted native socket/Worker composition, never a renderer dispatcher.
    #[doc(hidden)]
    pub fn native_authority(self: &Arc<Self>) -> NativeAuthorityFacade {
        NativeAuthorityFacade {
            runtime: self.clone(),
        }
    }

    fn native_vault_authorization_available(&self, snapshot: &ReplicaSnapshot) -> bool {
        snapshot.bootstrap.pending_vault_retirements.is_empty()
            && !self
                .foreground_attachments
                .has_pending_vault_retirement(&snapshot.account_id, &snapshot.incarnation)
    }

    pub(super) async fn effective_session(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<Option<CurrentSessionDocument>, RuntimeError> {
        self.ensure_open()?;
        {
            let state = self
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            if let Some(grant) = state.grants.get(account) {
                if &grant.binding.destination.incarnation != incarnation {
                    return Err(native_retired());
                }
                self.require_current_native_scope(&grant.binding.destination, true)?;
                native_travel::require_grant_channel(&state, grant)?;
                return Ok(Some(grant.session.clone()));
            }
            if state.standalone_blocked.contains(account) {
                return Ok(None);
            }
        }
        let stored = self
            .platform_storage
            .load_current_session(account, incarnation)
            .await?;
        // A channel may have attached while the primitive read was pending.
        let state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        if state.grants.contains_key(account) || state.standalone_blocked.contains(account) {
            return Err(native_retired());
        }
        Ok(stored)
    }

    pub(super) async fn store_renewed_effective_session(
        &self,
        session: &CurrentSessionDocument,
        refreshed: crate::server_contract::RefreshSessionResponse,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        if matches!(session.provenance, SessionProvenance::Independent) {
            return self.store_renewed_session(session, refreshed).await;
        }
        let renewed = Self::prepare_renewed_session(session, refreshed)?;
        self.replace_borrowed_session(session, renewed)
    }

    /// Replace only the exact currently borrowed document, without persisting its credentials.
    /// Callers derive the replacement through shared Core policy; this seam preserves authority.
    pub(super) fn replace_borrowed_session(
        &self,
        expected: &CurrentSessionDocument,
        replacement: CurrentSessionDocument,
    ) -> Result<CurrentSessionDocument, RuntimeError> {
        let SessionProvenance::Borrowed { grant_id } = &expected.provenance else {
            return Err(native_retired());
        };
        if replacement.account_id != expected.account_id
            || replacement.incarnation != expected.incarnation
            || replacement.provenance != expected.provenance
        {
            return Err(native_retired());
        }
        let mut state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let grant = state
            .grants
            .get(&expected.account_id)
            .ok_or_else(native_retired)?;
        if &grant.binding.challenge_id != grant_id {
            return Err(native_retired());
        }
        if &grant.session != expected {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Session changed before guarded replacement",
            ));
        }
        self.require_current_native_scope(&grant.binding.destination, true)?;
        native_travel::require_grant_channel(&state, grant)?;
        state
            .grants
            .get_mut(&expected.account_id)
            .expect("grant checked")
            .session = replacement.clone();
        Ok(replacement)
    }

    fn native_account_scope(
        &self,
        account: &AccountId,
    ) -> Result<NativeAccountScope, RuntimeError> {
        let snapshot = self.require_snapshot(account)?;
        let identities = self
            .account_display_identities
            .lock()
            .expect("Account display identity lock poisoned");
        let identity = identities.get(account).ok_or_else(native_retired)?;
        Ok(NativeAccountScope {
            account_id: account.clone(),
            incarnation: snapshot.incarnation,
            lock_epoch: snapshot.lock_epoch,
            server_url: identity.identity.server_url.clone(),
            user_id: snapshot.user_id,
        })
    }

    fn require_native_scope(
        &self,
        expected: &NativeAccountScope,
        unlocked: bool,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        let snapshot = self.require_current_native_scope(expected, unlocked)?;
        if self.travel_policy_verification_pending(&snapshot) {
            return Err(native_retired());
        }
        Ok(snapshot)
    }

    fn require_current_native_scope(
        &self,
        expected: &NativeAccountScope,
        unlocked: bool,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        self.ensure_open()?;
        let current = self.native_account_scope(&expected.account_id)?;
        let snapshot = self.require_snapshot(&expected.account_id)?;
        if &current != expected
            || self.account_teardown_is_pending(&expected.account_id)
            || self.account_access_retirement_is_pending(&expected.account_id)
            || self
                .lock_epoch_pending
                .lock()
                .expect("pending epoch lock poisoned")
                .contains_key(&expected.account_id)
            || (unlocked && !self.generation_has_current_unlocked_authority(&snapshot))
        {
            return Err(native_retired());
        }
        Ok(snapshot)
    }

    pub(super) fn require_native_identity_local_unlock_allowed(
        &self,
        server_url: &str,
        user_id: &str,
    ) -> Result<(), RuntimeError> {
        let state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        if independent_identity_allowed(&state, server_url, user_id) {
            Ok(())
        } else {
            Err(native_retired())
        }
    }

    pub(super) fn native_local_installation_publication(
        &self,
        server_url: &str,
        user_id: &str,
        account: &AccountId,
    ) -> NativeLocalPublicationGuard<'_> {
        let mut state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let allowed = independent_identity_allowed(&state, server_url, user_id);
        retire_account_in_state(&mut state, account);
        NativeLocalPublicationGuard {
            _state: state,
            allowed,
        }
    }

    pub(super) fn native_local_unlock_publication(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<NativeLocalPublicationGuard<'_>, RuntimeError> {
        let state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        if state
            .channels
            .values()
            .any(|channel| matches!(channel, Channel::Desktop { .. }))
        {
            let scope = self.native_account_scope(&expected.account_id)?;
            if scope.incarnation != expected.incarnation
                || scope.lock_epoch != expected.lock_epoch
                || !independent_identity_allowed(&state, &scope.server_url, &scope.user_id)
            {
                return Err(native_retired());
            }
        }
        Ok(NativeLocalPublicationGuard {
            _state: state,
            allowed: true,
        })
    }

    pub(super) fn native_local_unlock_completed(&self, account: &AccountId) {
        let mut state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let Ok(snapshot) = self.require_snapshot(account) else {
            return;
        };
        if state.grants.contains_key(account) || !self.generation_is_preparation_eligible(&snapshot)
        {
            return;
        }
        if state
            .channels
            .values()
            .any(|channel| matches!(channel, Channel::Desktop { .. }))
        {
            let Ok(scope) = self.native_account_scope(account) else {
                return;
            };
            if !independent_identity_allowed(&state, &scope.server_url, &scope.user_id) {
                return;
            }
        }
        state.standalone_blocked.remove(account);
        state
            .challenges
            .retain(|_, challenge| &challenge.destination.account_id != account);
    }

    pub(super) fn require_native_local_unlock_allowed(
        &self,
        account: &AccountId,
    ) -> Result<(), RuntimeError> {
        let state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        if !state
            .channels
            .values()
            .any(|channel| matches!(channel, Channel::Desktop { .. }))
        {
            return Ok(());
        }
        let scope = self.native_account_scope(account)?;
        if independent_identity_allowed(&state, &scope.server_url, &scope.user_id) {
            Ok(())
        } else {
            Err(native_retired())
        }
    }
}

impl NativeAuthorityFacade {
    pub fn attach_source_scoped(
        self,
        extension_id: String,
        transport_id: String,
    ) -> Result<NativeSourceAttachment, RuntimeError> {
        let snapshot = self.attach_source(extension_id, transport_id)?;
        Ok(NativeSourceAttachment {
            facade: self,
            channel_id: snapshot.channel_id,
        })
    }

    fn require_platform(&self, platform: crate::ClientPlatform) -> Result<(), RuntimeError> {
        if self
            .runtime
            .auth_client_config
            .as_ref()
            .is_some_and(|config| {
                matches!(
                    (config.platform, platform),
                    (
                        crate::ClientPlatform::Desktop,
                        crate::ClientPlatform::Desktop
                    ) | (
                        crate::ClientPlatform::Extension,
                        crate::ClientPlatform::Extension
                    )
                )
            })
        {
            Ok(())
        } else {
            Err(native_retired())
        }
    }

    pub async fn invoke(
        &self,
        request: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let request: NativeAuthorityRequest =
            serde_json::from_str(&request).map_err(|_| native_retired())?;
        let response = match request {
            NativeAuthorityRequest::AttachSource {
                extension_id,
                transport_id,
            } => NativeAuthorityResponse::Source {
                snapshot: self.attach_source(extension_id, transport_id)?,
            },
            NativeAuthorityRequest::SourceSnapshot { channel_id } => {
                NativeAuthorityResponse::Source {
                    snapshot: self.source_snapshot(&channel_id)?,
                }
            }
            NativeAuthorityRequest::AttachDesktop {
                source,
                transport_id,
            } => NativeAuthorityResponse::Attached {
                channel_id: self.attach_desktop(source, transport_id).await?,
            },
            NativeAuthorityRequest::PrepareImportForSource {
                channel_id,
                source_account,
                insecure_transport_confirmed,
            } => NativeAuthorityResponse::Prepared {
                challenge: self
                    .prepare_import_for_source(
                        &channel_id,
                        &source_account,
                        insecure_transport_confirmed,
                    )
                    .await?,
            },
            NativeAuthorityRequest::PrepareIndependentRevalidation {
                channel_id,
                source_account,
            } => NativeAuthorityResponse::Prepared {
                challenge: self
                    .prepare_independent_revalidation(&channel_id, &source_account)
                    .await?,
            },
            NativeAuthorityRequest::RevalidateIndependentRestrictions { challenge } => {
                NativeAuthorityResponse::IndependentRestrictionsRevalidated {
                    reply: self.revalidate_independent_restrictions(challenge).await?,
                }
            }
            NativeAuthorityRequest::CompleteIndependentRevalidation { reply } => {
                self.complete_independent_revalidation(reply).await?;
                NativeAuthorityResponse::Applied
            }
            NativeAuthorityRequest::Export { challenge } => NativeAuthorityResponse::Exported {
                reply: self.export(challenge).await?,
            },
            NativeAuthorityRequest::ExportWithBiometric {
                challenge,
                prompt_message,
            } => {
                self.export_with_biometric(challenge, prompt_message)
                    .await?
            }
            NativeAuthorityRequest::CompleteImport { reply } => {
                self.complete_import(reply).await?;
                NativeAuthorityResponse::Applied
            }
            NativeAuthorityRequest::ApplyAuthority { channel_id, source } => {
                self.apply_authority(&channel_id, source).await?;
                NativeAuthorityResponse::Applied
            }
            NativeAuthorityRequest::RestrictionAcknowledgement { channel_id } => {
                NativeAuthorityResponse::RestrictionAcknowledgement {
                    acknowledgement: self.restriction_acknowledgement(&channel_id)?,
                }
            }
            NativeAuthorityRequest::AcknowledgeRestrictions { acknowledgement } => {
                self.acknowledge_restrictions(acknowledgement)?;
                NativeAuthorityResponse::Applied
            }
            NativeAuthorityRequest::RetireChannel { channel_id } => {
                self.retire_channel(&channel_id).await?;
                NativeAuthorityResponse::Applied
            }
        };
        self.encode_response(&response)
    }

    fn encode_response(
        &self,
        response: &NativeAuthorityResponse,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let encode = || {
            serde_json::to_string(response)
                .map(Zeroizing::new)
                .map_err(|_| native_retired())
        };
        match response {
            NativeAuthorityResponse::Exported { reply } => self.deliver_reply(reply, encode)?,
            NativeAuthorityResponse::IndependentRestrictionsRevalidated { reply } => {
                self.deliver_independent_revalidation_reply(reply, encode)?
            }
            _ => encode(),
        }
    }

    pub fn encode_reply(
        &self,
        reply: NativeTransferReply,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        self.deliver_reply(&reply, || {
            serde_json::to_string(&reply)
                .map(Zeroizing::new)
                .map_err(|_| native_retired())
        })?
    }

    fn deliver_reply<T>(
        &self,
        reply: &NativeTransferReply,
        deliver: impl FnOnce() -> T,
    ) -> Result<T, RuntimeError> {
        independent_revalidation::require_transfer(&reply.challenge)?;
        let state = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let scope = &reply.challenge.source;
        self.runtime.deliver_account_scoped(
            &scope.account_id,
            &scope.incarnation,
            scope.lock_epoch,
            |snapshot| self.require_source_snapshot_in(&state, &reply.challenge, snapshot),
            deliver,
        )
    }

    pub fn attach_source(
        &self,
        extension_id: String,
        transport_id: String,
    ) -> Result<NativeAuthoritySnapshot, RuntimeError> {
        self.runtime.ensure_open()?;
        self.require_platform(crate::ClientPlatform::Desktop)?;
        require_identifier(&extension_id)?;
        require_identifier(&transport_id)?;
        let channel = bittery_crypto_core::generate_uuid();
        self.register_source_channel(&channel, extension_id, transport_id)?;
        self.source_snapshot(&channel)
    }

    pub fn source_snapshot(&self, channel: &str) -> Result<NativeAuthoritySnapshot, RuntimeError> {
        self.runtime.ensure_open()?;
        let mut state = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let Some(Channel::Source {
            extension_id,
            transport_id,
            sequence,
            ..
        }) = state.channels.get_mut(channel)
        else {
            return Err(native_retired());
        };
        let _publication = self
            .runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        self.runtime.ensure_open()?;
        *sequence = sequence.checked_add(1).ok_or_else(native_retired)?;
        let extension_id = extension_id.clone();
        let transport_id = transport_id.clone();
        let sequence = *sequence;
        let mut accounts = Vec::new();
        for snapshot in self.runtime.replica.snapshots() {
            let scope = self.runtime.native_account_scope(&snapshot.account_id)?;
            let key_generation =
                source_key_generation(&state, &scope.account_id, &scope.incarnation);
            let unlocked = self
                .runtime
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&snapshot.account_id)
                == Some(&AccountAccessState::Unlocked);
            if snapshot.bootstrap.policy_verification_pending {
                self.runtime
                    .foreground_attachments
                    .restore_policy_verification_pending(
                        &snapshot.account_id,
                        &snapshot.incarnation,
                    )?;
            }
            let policy_verification = self
                .runtime
                .foreground_attachments
                .server_policy_verification_status(&snapshot.account_id, &snapshot.incarnation)
                .map(|episode| {
                    if episode.pending || snapshot.bootstrap.policy_verification_pending {
                        NativePolicyVerification::Pending {
                            revision: episode.revision,
                        }
                    } else {
                        NativePolicyVerification::Verified {
                            revision: episode.revision,
                            restriction_frontier: native_travel::source_restrictions(
                                &state, channel,
                            )
                            .expect("validated source channel")
                            .last_frontier()
                            .0,
                        }
                    }
                });
            accounts.push(NativeAccountAuthority {
                scope,
                policy_verification,
                unlocked,
                key_authorization_available: unlocked
                    && self
                        .runtime
                        .generation_has_current_unlocked_authority(&snapshot)
                    && self.runtime.native_vault_authorization_available(&snapshot)
                    && key_generation != u64::MAX,
                key_generation,
                restrictive_continuity: state
                    .source_key_generations
                    .get(&snapshot.account_id)
                    .filter(|authority| {
                        authority.incarnation == snapshot.incarnation
                            && self
                                .runtime
                                .generation_has_current_unlocked_authority(&snapshot)
                    })
                    .and_then(|authority| authority.continuity.clone()),
            });
        }
        accounts.sort_by(|a, b| a.scope.account_id.as_str().cmp(b.scope.account_id.as_str()));
        Ok(NativeAuthoritySnapshot {
            version: 1,
            extension_id,
            owner_id: self.runtime.native_authority.owner.clone(),
            channel_id: channel.into(),
            transport_id,
            sequence,
            accounts,
            restriction_frontier: native_travel::source_restrictions(&state, channel)?
                .last_frontier()
                .0,
            restriction_chain_digest: native_travel::source_restrictions(&state, channel)?
                .last_frontier()
                .1,
            restrictions: native_travel::source_restrictions(&state, channel)?.pending_snapshot(),
        })
    }

    pub async fn attach_desktop(
        &self,
        source: NativeAuthoritySnapshot,
        transport_id: String,
    ) -> Result<String, RuntimeError> {
        self.runtime.ensure_open()?;
        self.require_platform(crate::ClientPlatform::Extension)?;
        validate_snapshot(&source)?;
        let _attachment = self
            .runtime
            .native_authority
            .channel_attachment
            .lock()
            .await;
        self.runtime.ensure_open()?;
        require_identifier(&transport_id)?;
        let previous: Vec<_> = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned")
            .channels
            .iter()
            .filter_map(|(id, channel)| match channel {
                Channel::Desktop { source: old, .. } if old.extension_id == source.extension_id => {
                    Some(id.clone())
                }
                _ => None,
            })
            .collect();
        for channel in previous {
            self.retire_channel(&channel).await?;
        }
        let channel = bittery_crypto_core::generate_uuid();
        {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            self.runtime.ensure_open()?;
            if state.channels.len() >= native_travel::MAX_CHANNELS {
                return Err(native_retired());
            }
            self.runtime.device_revision.fetch_add(1, Ordering::SeqCst);
            state.channels.insert(
                channel.clone(),
                Channel::Desktop {
                    restrictions: DestinationRestrictions::new(
                        &source,
                        self.runtime
                            .replica
                            .snapshots()
                            .iter()
                            .map(|snapshot| self.runtime.native_account_scope(&snapshot.account_id))
                            .collect::<Result<Vec<_>, _>>()?,
                    )?,
                    source: source.clone(),
                    transport_id,
                },
            );
        }
        self.apply_authority(&channel, source).await?;
        Ok(channel)
    }

    pub async fn prepare_import_for_source(
        &self,
        channel: &str,
        source_account: &AccountId,
        insecure_transport_confirmed: bool,
    ) -> Result<NativeImportChallenge, RuntimeError> {
        let catalog_guard = self.runtime.catalog_transition.lock().await;
        self.runtime.ensure_open()?;
        let source_scope = {
            let state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let Some(Channel::Desktop { source, .. }) = state.channels.get(channel) else {
                return Err(native_retired());
            };
            source
                .accounts
                .iter()
                .find(|account| &account.scope.account_id == source_account)
                .ok_or_else(native_retired)?
                .scope
                .clone()
        };
        let catalog = self.runtime.platform_storage.load_device_catalog().await?;
        let matches = self
            .matching_catalog_accounts(catalog.as_ref(), &source_scope)
            .await?;
        match matches.as_slice() {
            [account] => {
                let account = account.clone();
                drop(catalog_guard);
                self.prepare_import(channel, source_account, &account).await
            }
            [] => {
                // Reuse the shared transport admission; Desktop consent is not destination consent.
                AuthHttpClient::new(
                    &self.runtime.http_transport,
                    &source_scope.server_url,
                    insecure_transport_confirmed,
                    self.runtime
                        .auth_client_config
                        .clone()
                        .ok_or_else(native_retired)?,
                )?;
                let mut state = self
                    .runtime
                    .native_authority
                    .state
                    .lock()
                    .expect("native authority lock poisoned");
                self.runtime.ensure_open()?;
                if state
                    .challenges
                    .values()
                    .any(|challenge| same_identity(&challenge.destination, &source_scope))
                    || state.ceremonies.values().any(|ceremony| {
                        ceremony.direction == NativeCeremonyDirection::Destination
                            && same_identity(&ceremony.challenge.destination, &source_scope)
                    })
                {
                    return Err(native_retired());
                }
                let destination = NativeAccountScope {
                    account_id: bittery_crypto_core::generate_uuid().into(),
                    incarnation: bittery_crypto_core::generate_uuid().into(),
                    lock_epoch: 0,
                    server_url: source_scope.server_url,
                    user_id: source_scope.user_id,
                };
                self.register_import_challenge(
                    &mut state,
                    channel,
                    source_account,
                    destination,
                    true,
                    insecure_transport_confirmed,
                )
            }
            _ => Err(native_retired()),
        }
    }

    async fn matching_catalog_accounts(
        &self,
        catalog: Option<&DeviceCatalogDocument>,
        source: &NativeAccountScope,
    ) -> Result<Vec<AccountId>, RuntimeError> {
        let mut matching = Vec::new();
        if let Some(catalog) = catalog {
            for account in &catalog.accounts {
                if account.pending_install.is_some() {
                    return Err(native_retired());
                }
                let incarnation = account
                    .active_incarnation
                    .as_ref()
                    .ok_or_else(native_retired)?;
                let metadata = self
                    .runtime
                    .platform_storage
                    .load_account_metadata(&account.account_id, incarnation)
                    .await?
                    .ok_or_else(native_retired)?;
                if metadata.normalized_server_url == source.server_url
                    && metadata.user_id == source.user_id
                {
                    matching.push(account.account_id.clone());
                }
            }
        }
        Ok(matching)
    }

    pub(super) async fn prepare_import(
        &self,
        channel: &str,
        source_account: &AccountId,
        destination: &AccountId,
    ) -> Result<NativeImportChallenge, RuntimeError> {
        self.runtime.ensure_open()?;
        let before = self.runtime.native_account_scope(destination)?;
        let expected = self.runtime.require_native_scope(&before, false)?;
        {
            let state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let Some(Channel::Desktop { source, .. }) = state.channels.get(channel) else {
                return Err(native_retired());
            };
            if !source.accounts.iter().any(|account| {
                &account.scope.account_id == source_account
                    && same_identity(&account.scope, &before)
            }) {
                return Err(native_retired());
            }
        }
        // Retire the previous live Session/stream through the ordinary lifecycle before capturing
        // the destination epoch. Its independent persisted credentials and accepted work remain.
        self.runtime.retire_account_generation(&expected).await?;
        let destination_scope = self.runtime.native_account_scope(destination)?;
        self.runtime
            .require_native_scope(&destination_scope, false)?;
        if destination_scope.incarnation != before.incarnation
            || !same_identity(&destination_scope, &before)
            || self
                .runtime
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(destination)
                != Some(&AccountAccessState::Locked)
        {
            return Err(native_retired());
        }
        let mut state = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        self.register_import_challenge(
            &mut state,
            channel,
            source_account,
            destination_scope,
            false,
            false,
        )
    }

    fn register_import_challenge(
        &self,
        state: &mut AuthorityState,
        channel: &str,
        source_account: &AccountId,
        destination_scope: NativeAccountScope,
        new_destination: bool,
        destination_insecure_transport_confirmed: bool,
    ) -> Result<NativeImportChallenge, RuntimeError> {
        let Some(Channel::Desktop {
            source,
            transport_id,
            ..
        }) = state.channels.get(channel)
        else {
            return Err(native_retired());
        };
        let source_account = source
            .accounts
            .iter()
            .find(|account| &account.scope.account_id == source_account)
            .ok_or_else(native_retired)?;
        if !same_identity(&source_account.scope, &destination_scope)
            || !native_travel::fresh_source_restrictions_adopted(
                state,
                channel,
                &source_account.scope,
            )
        {
            return Err(native_retired());
        }
        let destination_account = destination_scope.account_id.clone();
        let challenge = NativeImportChallenge {
            purpose: NativeChallengePurpose::Transfer,
            version: 1,
            challenge_id: bittery_crypto_core::generate_uuid(),
            extension_id: source.extension_id.clone(),
            source_owner: source.owner_id.clone(),
            source_channel: source.channel_id.clone(),
            source_transport: source.transport_id.clone(),
            destination_owner: self.runtime.native_authority.owner.clone(),
            destination_channel: channel.into(),
            destination_transport: transport_id.clone(),
            source: source_account.scope.clone(),
            source_key_generation: source_account.key_generation,
            destination: destination_scope,
            new_destination,
            destination_insecure_transport_confirmed,
        };
        if !new_destination {
            state.standalone_blocked.insert(destination_account);
        }
        state
            .challenges
            .insert(challenge.challenge_id.clone(), challenge.clone());
        Ok(challenge)
    }

    pub async fn export_with_biometric(
        &self,
        challenge: NativeImportChallenge,
        prompt_message: String,
    ) -> Result<NativeAuthorityResponse, RuntimeError> {
        independent_revalidation::require_transfer(&challenge)?;
        let cancellation = RequestCancellation::new();
        {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            self.runtime
                .require_native_scope(&challenge.source, false)?;
            self.require_source_channel_in(&state, &challenge)?;
            if state.ceremonies.contains_key(&challenge.challenge_id) {
                return Err(native_retired());
            }
            state.ceremonies.insert(
                challenge.challenge_id.clone(),
                PendingNativeCeremony {
                    challenge: challenge.clone(),
                    direction: NativeCeremonyDirection::Source,
                    cancellation: cancellation.clone(),
                },
            );
        }
        let _ceremony = NativeCeremonyLease {
            owner: &self.runtime.native_authority,
            id: challenge.challenge_id.clone(),
        };
        let result = self
            .runtime
            .request_biometric(
                RuntimeRequest::BiometricUnlock {
                    account_id: challenge.source.account_id.clone(),
                    prompt_message,
                },
                cancellation.clone(),
            )
            .await?;
        if cancellation.is_cancelled() {
            return Err(native_retired());
        }
        self.runtime
            .require_native_scope(&challenge.source, false)?;
        self.require_source_channel(&challenge)?;
        let RuntimeResponse::BiometricUnlock { accounts } = result else {
            return Err(native_retired());
        };
        let [account] = accounts.as_slice() else {
            return Err(native_retired());
        };
        if account.account_id != challenge.source.account_id {
            return Err(native_retired());
        }
        if let Some(failure) = account.failure {
            return Ok(NativeAuthorityResponse::BiometricRefused { failure });
        }
        Ok(NativeAuthorityResponse::Exported {
            reply: self.export(challenge).await?,
        })
    }

    pub async fn export(
        &self,
        challenge: NativeImportChallenge,
    ) -> Result<NativeTransferReply, RuntimeError> {
        independent_revalidation::require_transfer(&challenge)?;
        let lock = self
            .runtime
            .account_execution_lock(&challenge.source.account_id)?;
        let _execution = lock.lock().await;
        self.runtime.require_native_scope(&challenge.source, true)?;
        self.require_source_channel(&challenge)?;
        let quick = self
            .runtime
            .platform_storage
            .load_quick_unlock(&challenge.source.account_id, &challenge.source.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        let device = self
            .runtime
            .platform_storage
            .load_device_key()
            .await?
            .ok_or_else(native_retired)?;
        let session = self
            .runtime
            .platform_storage
            .load_current_session(&challenge.source.account_id, &challenge.source.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        require_usable_session(&session, self.runtime.clock.now_ms()?)?;
        let stored_key =
            unwrap_master_unlock_key(&quick.encrypted_master_unlock_key, &device.key_bytes)?;
        let live_key = self
            .runtime
            .copy_live_master_unlock_key(
                &challenge.source.account_id,
                &challenge.source.incarnation,
            )
            .ok_or_else(native_retired)?;
        if !bool::from(stored_key.as_slice().ct_eq(live_key.as_slice())) {
            return Err(native_retired());
        }
        self.require_source_channel(&challenge)?;
        self.runtime.require_native_scope(&challenge.source, true)?;
        let metadata = self
            .runtime
            .platform_storage
            .load_account_metadata(&challenge.source.account_id, &challenge.source.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        let policy = metadata
            .verified_travel_mode
            .clone()
            .ok_or_else(native_retired)?;
        self.runtime.require_native_scope(&challenge.source, true)?;
        self.require_source_channel(&challenge)?;
        let travel_evidence = NativeTravelEvidence {
            enabled: policy.enabled,
            hidden_vault_ids: policy.hidden_vault_ids,
            server_enabled_at_ms: policy.server_enabled_at_ms,
            server_updated_at_ms: policy.server_updated_at_ms,
            verified_at_ms: policy.verified_at_ms,
        };
        let profile = NativeAccountProfile {
            email: metadata.email,
            name: metadata.name,
            team_name: metadata.team_name,
            team_avatar_url: metadata.team_avatar_url,
            secret_key_hint: metadata.secret_key_hint,
            added_at_ms: metadata.added_at_ms,
            last_active_at_ms: metadata.last_active_at_ms,
            biometric_enabled: metadata.biometric_enabled,
            pinned_kdf_profile: metadata.pinned_kdf_profile,
        };
        let material = TransferMaterial {
            encrypted_master_unlock_key: quick.encrypted_master_unlock_key.clone(),
            device_key: device.key_bytes.clone(),
            session,
        };
        let encoded = serde_json::to_string(&material).map_err(|_| native_retired())?;
        Ok(NativeTransferReply {
            challenge,
            travel_evidence,
            profile: Box::new(profile),
            material: encoded.into(),
        })
    }

    fn require_source_channel(
        &self,
        challenge: &NativeImportChallenge,
    ) -> Result<(), RuntimeError> {
        let state = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        self.require_source_channel_in(&state, challenge)
    }

    fn require_source_channel_in(
        &self,
        state: &AuthorityState,
        challenge: &NativeImportChallenge,
    ) -> Result<(), RuntimeError> {
        let snapshot = self
            .runtime
            .require_snapshot(&challenge.source.account_id)?;
        self.require_source_snapshot_in(state, challenge, &snapshot)
    }

    // Final callers pass the exact snapshot guarded by publication; early admission reuses this
    // same validation. Native state is already held, so the registry is acquired last.
    fn require_source_snapshot_in(
        &self,
        state: &AuthorityState,
        challenge: &NativeImportChallenge,
        snapshot: &ReplicaSnapshot,
    ) -> Result<(), RuntimeError> {
        if challenge.version != 1
            || challenge.source_owner != self.runtime.native_authority.owner
            || !same_identity(&challenge.source, &challenge.destination)
            || challenge.source_key_generation == u64::MAX
            || source_key_generation(
                state,
                &challenge.source.account_id,
                &challenge.source.incarnation,
            ) != challenge.source_key_generation
        {
            return Err(native_retired());
        }
        if !self.runtime.native_vault_authorization_available(snapshot) {
            return Err(native_retired());
        }
        match state.channels.get(&challenge.source_channel) {
            Some(Channel::Source {
                extension_id,
                transport_id,
                ..
            }) if extension_id == &challenge.extension_id
                && transport_id == &challenge.source_transport =>
            {
                Ok(())
            }
            _ => Err(native_retired()),
        }
    }

    pub async fn complete_import(&self, reply: NativeTransferReply) -> Result<(), RuntimeError> {
        let _admission = self.runtime.teardown_admission.read().await;
        self.runtime.ensure_open()?;
        let challenge = reply.challenge;
        independent_revalidation::require_transfer(&challenge)?;
        let cancellation = RequestCancellation::new();
        {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let pending = state
                .challenges
                .remove(&challenge.challenge_id)
                .ok_or_else(native_retired)?;
            if pending != challenge
                || challenge.destination_owner != self.runtime.native_authority.owner
            {
                return Err(native_retired());
            }
            require_destination_channel(&state, &challenge)?;
            state.ceremonies.insert(
                challenge.challenge_id.clone(),
                PendingNativeCeremony {
                    challenge: challenge.clone(),
                    direction: NativeCeremonyDirection::Destination,
                    cancellation: cancellation.clone(),
                },
            );
        }
        let _import = NativeCeremonyLease {
            owner: &self.runtime.native_authority,
            id: challenge.challenge_id.clone(),
        };
        if self
            .runtime
            .account_teardown_is_pending(&challenge.destination.account_id)
        {
            return Err(native_retired());
        }
        if !challenge.new_destination {
            self.runtime
                .require_native_scope(&challenge.destination, false)?;
        }
        let material: TransferMaterial =
            serde_json::from_str(&reply.material).map_err(|_| native_retired())?;
        if material.session.account_id != challenge.source.account_id
            || material.session.incarnation != challenge.source.incarnation
        {
            return Err(native_retired());
        }
        require_usable_session(&material.session, self.runtime.clock.now_ms()?)?;
        let key =
            unwrap_master_unlock_key(&material.encrypted_master_unlock_key, &material.device_key)?;
        let mut session = CurrentSessionDocument::new(
            challenge.destination.account_id.clone(),
            challenge.destination.incarnation.clone(),
            material.session.token.to_string(),
            material.session.session_id.clone(),
            material.session.expires_at_ms,
            material.session.server_expires_at_ms,
            material.session.vault_keys.clone(),
            material.session.encrypted_private_key.clone(),
        )?;
        session.provenance = SessionProvenance::Borrowed {
            grant_id: challenge.challenge_id.clone(),
        };
        let mut metadata = if challenge.new_destination {
            reply.profile.destination_metadata(
                &challenge.destination,
                &reply.travel_evidence,
                challenge.destination_insecure_transport_confirmed,
            )?
        } else {
            self.runtime
                .platform_storage
                .load_account_metadata(
                    &challenge.destination.account_id,
                    &challenge.destination.incarnation,
                )
                .await?
                .ok_or_else(native_retired)?
        };
        let (policy, fresh) = self
            .runtime
            .verify_local_travel_policy(&metadata, &session, cancellation.clone())
            .await
            .map_err(|failure| match failure {
                super::local_access::LocalTravelFailure::Runtime(error) => error,
                _ => native_retired(),
            })?;
        if !fresh && !reply.travel_evidence.matches(&policy) {
            return Err(native_retired());
        }
        let _catalog = if challenge.new_destination {
            Some(self.runtime.catalog_transition.lock().await)
        } else {
            None
        };
        let execution = self
            .runtime
            .account_execution_lock(&challenge.destination.account_id)?;
        let _execution = execution.lock().await;
        self.runtime.ensure_open()?;
        if cancellation.is_cancelled()
            || self
                .runtime
                .account_teardown_is_pending(&challenge.destination.account_id)
        {
            return Err(native_retired());
        }
        let snapshot = if challenge.new_destination {
            let catalog = self.runtime.platform_storage.load_device_catalog().await?;
            if !self
                .matching_catalog_accounts(catalog.as_ref(), &challenge.source)
                .await?
                .is_empty()
                || catalog.as_ref().is_some_and(|catalog| {
                    catalog.accounts.iter().any(|entry| {
                        entry.account_id == challenge.destination.account_id
                            || entry.active_incarnation.as_ref()
                                == Some(&challenge.destination.incarnation)
                    })
                })
                || self
                    .runtime
                    .replica
                    .load_uncached(&challenge.destination.account_id)
                    .await?
                    .is_some()
            {
                return Err(native_retired());
            }
            {
                let state = self
                    .runtime
                    .native_authority
                    .state
                    .lock()
                    .expect("native authority lock poisoned");
                require_destination_channel(&state, &challenge)?;
                if cancellation.is_cancelled() {
                    return Err(native_retired());
                }
            }
            require_usable_session(&session, self.runtime.clock.now_ms()?)?;
            self.runtime
                .ensure_image_device_key_under_catalog(&SystemInstallationEntropy)
                .await?;
            metadata.verified_travel_mode = Some(policy.clone());
            let installed = self
                .runtime
                .persist_account_installation(
                    catalog.as_ref(),
                    None,
                    super::installation_commit::InstallationDocuments {
                        metadata: &metadata,
                        quick_unlock: None,
                        current_session: None,
                    },
                )
                .await;
            let snapshot = match installed {
                Ok(snapshot) => snapshot,
                Err(super::installation_commit::InstallationCommitFailure::BeforeReplica(
                    error,
                )) => return Err(error),
                Err(super::installation_commit::InstallationCommitFailure::AfterReplica {
                    error,
                    snapshot,
                }) => {
                    let invalidated = self.runtime.fence_authenticated_installation(
                        snapshot.map(|snapshot| *snapshot),
                        &challenge.destination.account_id,
                    );
                    drop(_execution);
                    drop(_catalog);
                    finish_generation_fence(invalidated);
                    self.runtime.publish_all();
                    return Err(error);
                }
            };
            // Physical installation may have committed before source loss. Retain its discoverable
            // locked Account; only the later exact ceremony guard may publish borrowed keys.
            let invalidated = self.runtime.publish_installed_account(
                snapshot.clone(),
                account_presentation(&metadata),
                None,
            )?;
            finish_generation_fence(invalidated);
            snapshot
        } else {
            let snapshot = self
                .runtime
                .require_native_scope(&challenge.destination, false)?;
            if fresh {
                metadata = self
                    .runtime
                    .platform_storage
                    .load_account_metadata(
                        &challenge.destination.account_id,
                        &challenge.destination.incarnation,
                    )
                    .await?
                    .ok_or_else(native_retired)?;
                metadata.verified_travel_mode = Some(policy.clone());
                self.runtime
                    .platform_storage
                    .store_account_metadata(&metadata)
                    .await?;
                self.runtime
                    .require_native_scope(&challenge.destination, false)?;
            }
            snapshot
        };
        if Runtime::hidden_local_authority_remains(&snapshot, &session, &policy) {
            return Err(native_retired());
        }
        if self
            .runtime
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(&challenge.destination.account_id)
            != Some(&AccountAccessState::Locked)
        {
            return Err(native_retired());
        }
        let invalidated = {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            if cancellation.is_cancelled() {
                return Err(native_retired());
            }
            require_destination_channel(&state, &challenge)?;
            self.runtime
                .require_native_scope(&challenge.destination, false)?;
            require_usable_session(&session, self.runtime.clock.now_ms()?)?;
            let grant_restrictions =
                native_travel::new_grant_restrictions(&state, &challenge, &policy, &session)?;
            let invalidated = self.runtime.publish_account_unlock(
                &snapshot,
                key,
                Some(session.encrypted_private_key.clone()),
            )?;
            state
                .standalone_blocked
                .insert(challenge.destination.account_id.clone());
            if let Some(Channel::Desktop { restrictions, .. }) =
                state.channels.get_mut(&challenge.destination_channel)
            {
                restrictions.bind_import(&challenge);
                restrictions
                    .independent_exclusions
                    .remove(&challenge.destination.account_id);
            }
            state.grants.insert(
                challenge.destination.account_id.clone(),
                BorrowedGrant {
                    restrictions: grant_restrictions,
                    binding: challenge.clone(),
                    session,
                },
            );
            invalidated
        };
        let projection = self
            .runtime
            .decrypt_visible_items(&challenge.destination.account_id);
        let failed = projection.as_ref().err().and_then(|_| {
            self.runtime
                .fence_account_unlock(&snapshot, AccountAccessState::Locked)
        });
        if projection.is_err() {
            self.runtime
                .native_authority
                .retire_account(&challenge.destination.account_id);
        }
        drop(_execution);
        drop(_catalog);
        finish_generation_fence(invalidated);
        finish_generation_fence(failed);
        projection?;
        self.runtime
            .note_session_available(&challenge.destination.account_id);
        Ok(())
    }

    pub async fn retire_channel(&self, channel: &str) -> Result<(), RuntimeError> {
        let scopes = {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            self.retire_channel_in(&mut state, channel)
        };
        self.retire_scopes(&scopes, None).await?;
        self.retire_native_policy_verification(channel).await
    }

    fn retire_channel_in(
        &self,
        state: &mut AuthorityState,
        channel: &str,
    ) -> Vec<NativeAccountScope> {
        retire_channel_in_state(&self.runtime, state, channel)
    }

    async fn retire_scopes(
        &self,
        scopes: &[NativeAccountScope],
        authority: Option<(&str, &NativeAuthoritySnapshot)>,
    ) -> Result<(), RuntimeError> {
        let mut deliveries = Vec::new();
        // These existing registry handles own only the first fence. The ordinary scoped Lock
        // path still performs the sole drain; retain these handles until that work completes.
        let mut foreground_retirements = Vec::new();
        let admission = (|| -> Result<(), RuntimeError> {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            self.runtime.ensure_open()?;
            if let Some((channel, expected)) = authority {
                if !matches!(state.channels.get(channel), Some(Channel::Desktop { source, .. }) if source == expected)
                {
                    return Err(native_retired());
                }
            }
            for scope in scopes {
                let Some(snapshot) =
                    self.runtime
                        .replica
                        .snapshot(&scope.account_id)
                        .filter(|snapshot| {
                            snapshot.incarnation == scope.incarnation
                                && snapshot.user_id == scope.user_id
                                && snapshot.lock_epoch == scope.lock_epoch
                        })
                else {
                    continue;
                };
                if state
                    .retirements
                    .get(&scope.account_id)
                    .is_some_and(|pending| pending.scope == *scope)
                {
                    continue;
                }
                let publication = self
                    .runtime
                    .publication
                    .lock()
                    .expect("publication lock poisoned");
                let (delivery, _, _) = match self.runtime.fence_account_access_under_publication(
                    &publication,
                    &snapshot,
                    AccountAccessState::Locked,
                ) {
                    Ok(fence) => fence,
                    Err(error) if error.code == RuntimeErrorCode::Cancelled => continue,
                    Err(error) => return Err(error),
                };
                foreground_retirements.push(
                    self.runtime
                        .foreground_attachments
                        .begin_account_retirement(&scope.account_id),
                );
                deliveries.push(delivery);
                drop(publication);
                if state
                    .grants
                    .get(&scope.account_id)
                    .is_some_and(|grant| grant.binding.destination == *scope)
                {
                    state.grants.remove(&scope.account_id);
                }
                state.standalone_blocked.insert(scope.account_id.clone());
                for ceremony in state.ceremonies.values() {
                    if ceremony.scope() == scope {
                        ceremony.cancellation.cancel();
                    }
                }
                state.retirements.insert(
                    scope.account_id.clone(),
                    PendingNativeRetirement {
                        scope: scope.clone(),
                        running: false,
                        attempts: 0,
                        retry_at_ms: 0,
                        last_error: None,
                    },
                );
            }
            Ok(())
        })();
        // No native/publication guard survives the closure, including a later-scope error.
        // Emit every already-required terminal control before any token or execution wait.
        for retirement in &foreground_retirements {
            retirement.notify_retirement();
        }
        self.runtime.wake_dispatch();
        for delivery in deliveries {
            finish_generation_fence(delivery);
        }
        self.runtime.publish_all();
        loop {
            let mut wake = std::pin::pin!(self.runtime.dispatch_wake.notified());
            wake.as_mut().enable();
            self.runtime.ensure_open()?;
            let progressed = self.runtime.drive_native_retirements(scopes).await?;
            let (remaining, failure) = {
                let state = self
                    .runtime
                    .native_authority
                    .state
                    .lock()
                    .expect("native authority lock poisoned");
                let pending: Vec<_> = scopes
                    .iter()
                    .filter_map(|scope| {
                        state
                            .retirements
                            .get(&scope.account_id)
                            .filter(|pending| pending.scope == *scope)
                    })
                    .collect();
                (
                    !pending.is_empty(),
                    pending
                        .iter()
                        .find_map(|pending| pending.last_error.clone()),
                )
            };
            if let Some(error) = failure {
                return Err(error);
            }
            if !remaining {
                return admission;
            }
            if !progressed {
                wake.await;
            }
        }
    }

    pub async fn apply_authority(
        &self,
        channel: &str,
        source: NativeAuthoritySnapshot,
    ) -> Result<(), RuntimeError> {
        validate_snapshot(&source)?;
        let replaced = {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let Some(Channel::Desktop {
                source: current,
                restrictions,
                ..
            }) = state.channels.get_mut(channel)
            else {
                return Err(native_retired());
            };
            if current.owner_id != source.owner_id
                || current.channel_id != source.channel_id
                || current.transport_id != source.transport_id
                || current.extension_id != source.extension_id
                || current.sequence > source.sequence
                || (current.sequence == source.sequence && *current != source)
            {
                return Err(native_retired());
            }
            restrictions.require_known_replays(&source)?;
            if *current != source {
                self.runtime.device_revision.fetch_add(1, Ordering::SeqCst);
                *current = source.clone();
            }
            let replaced = {
                let _publication = self
                    .runtime
                    .publication
                    .lock()
                    .expect("publication lock poisoned");
                self.receive_native_policy_verification(&state, channel, &source)?
            };
            state.challenges.retain(|_, pending| {
                pending.destination_channel != channel
                    || source
                        .accounts
                        .iter()
                        .any(|account| account.authorizes(pending))
            });
            for ceremony in state.ceremonies.values() {
                if ceremony.direction == NativeCeremonyDirection::Destination
                    && ceremony.channel() == channel
                    && !source
                        .accounts
                        .iter()
                        .any(|account| account.authorizes(&ceremony.challenge))
                {
                    ceremony.cancellation.cancel();
                }
            }
            replaced
        };
        let native_retirements = match self.receive_native_restrictions(channel, &source) {
            Ok(retirements) => retirements,
            Err((error, retirements)) => {
                // A failed projection filter may already own a fence and old delivery token.
                // Its notifications were emitted outside locks; conserve that drain here.
                for work in &retirements {
                    if let native_travel::NativeRestrictionAdoptionWork::New {
                        token: Some(token),
                        ..
                    } = work
                    {
                        token.wait_for_other_threads_async().await;
                    }
                }
                self.retire_channel(channel).await?;
                return Err(error);
            }
        };
        self.runtime.live_sync_wake.notify_waiters();
        let mut retire = replaced;
        for snapshot in self.runtime.replica.snapshots() {
            let local = self.runtime.native_account_scope(&snapshot.account_id)?;
            let state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let borrowed = state
                .grants
                .get(&local.account_id)
                .filter(|grant| grant.binding.destination_channel == channel);
            let source_account = source
                .accounts
                .iter()
                .find(|account| same_identity(&account.scope, &local));
            let authority_lost = source_account.is_some_and(|account| {
                !account.unlocked
                    || (!account.key_authorization_available
                        && account.restrictive_continuity.is_none())
            }) || borrowed.is_some_and(|grant| {
                source_account
                    .is_none_or(|account| !grant.restrictions.authorizes(account, &grant.binding))
            });
            if authority_lost && !retire.contains(&local) {
                retire.push(local);
            }
        }
        {
            let state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            for ceremony in state.ceremonies.values() {
                if ceremony.direction == NativeCeremonyDirection::Destination
                    && ceremony.channel() == channel
                    && ceremony.cancellation.is_cancelled()
                    && matches!(ceremony.challenge.purpose, NativeChallengePurpose::Transfer)
                    && !retire.contains(ceremony.scope())
                {
                    retire.push(ceremony.scope().clone());
                }
            }
        }
        self.retire_scopes(&retire, Some((channel, &source)))
            .await?;
        self.replace_retired_native_policy_scopes(channel, &source, &retire)?;
        self.persist_native_policy_verification(channel, &source, false)
            .await?;
        self.adopt_native_restrictions(channel, native_retirements)
            .await?;
        self.persist_native_policy_verification(channel, &source, true)
            .await
    }
}

fn source_key_generation(
    state: &AuthorityState,
    account: &AccountId,
    incarnation: &Incarnation,
) -> u64 {
    state
        .source_key_generations
        .get(account)
        .filter(|current| &current.incarnation == incarnation)
        .map_or(0, |current| current.generation)
}

fn native_retired() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Native authority is absent or retired",
    )
}

fn same_identity(left: &NativeAccountScope, right: &NativeAccountScope) -> bool {
    left.server_url == right.server_url && left.user_id == right.user_id
}

fn require_identifier(value: &str) -> Result<(), RuntimeError> {
    if value.is_empty() || value.len() > 1024 {
        Err(native_retired())
    } else {
        Ok(())
    }
}

fn validate_snapshot(snapshot: &NativeAuthoritySnapshot) -> Result<(), RuntimeError> {
    if snapshot.version != 1 || snapshot.sequence == 0 {
        return Err(native_retired());
    }
    for identifier in [
        &snapshot.extension_id,
        &snapshot.owner_id,
        &snapshot.channel_id,
        &snapshot.transport_id,
    ] {
        require_identifier(identifier)?;
    }
    native_travel::validate_restrictions_snapshot(snapshot)?;
    let mut seen = HashSet::new();
    for account in &snapshot.accounts {
        if !seen.insert(account.scope.account_id.clone())
            || matches!(account.policy_verification, Some(NativePolicyVerification::Verified { restriction_frontier, .. }) if restriction_frontier > snapshot.restriction_frontier)
            || (account.key_authorization_available
                && (!account.unlocked || account.key_generation == u64::MAX))
        {
            return Err(native_retired());
        }
    }
    Ok(())
}

fn require_destination_channel(
    state: &AuthorityState,
    challenge: &NativeImportChallenge,
) -> Result<(), RuntimeError> {
    match state.channels.get(&challenge.destination_channel) {
        Some(Channel::Desktop {
            source,
            transport_id,
            ..
        }) if source.owner_id == challenge.source_owner
            && source.channel_id == challenge.source_channel
            && source.transport_id == challenge.source_transport
            && source.extension_id == challenge.extension_id
            && transport_id == &challenge.destination_transport
            && source
                .accounts
                .iter()
                .any(|account| account.authorizes(challenge))
            && native_travel::fresh_source_restrictions_adopted(
                state,
                &challenge.destination_channel,
                &challenge.source,
            ) =>
        {
            Ok(())
        }
        _ => Err(native_retired()),
    }
}

fn require_usable_session(session: &CurrentSessionDocument, now: u64) -> Result<(), RuntimeError> {
    if now
        >= session
            .server_expires_at_ms
            .unwrap_or(session.expires_at_ms)
    {
        return Err(native_retired());
    }
    Ok(())
}

fn retire_channel_in_state(
    runtime: &Runtime,
    state: &mut AuthorityState,
    channel: &str,
) -> Vec<NativeAccountScope> {
    if let Some(removed) = state.channels.remove(channel) {
        if let Channel::Desktop { restrictions, .. } = removed {
            restrictions.cancel_adoption_waiters();
        }
        runtime.device_revision.fetch_add(1, Ordering::SeqCst);
    }
    if !state
        .channels
        .values()
        .any(|channel| matches!(channel, Channel::Source { .. }))
    {
        for authority in state.source_key_generations.values_mut() {
            authority.continuity = None;
            authority.excluded_vaults.clear();
        }
    }
    state
        .challenges
        .retain(|_, value| value.destination_channel != channel);
    let mut scopes = state
        .grants
        .iter()
        .filter(|(_, grant)| grant.binding.destination_channel == channel)
        .map(|(account, grant)| (account.clone(), grant.binding.destination.clone()))
        .collect::<HashMap<_, _>>();
    for ceremony in state.ceremonies.values() {
        if ceremony.channel() == channel {
            ceremony.cancellation.cancel();
            if ceremony.direction == NativeCeremonyDirection::Destination
                && matches!(ceremony.challenge.purpose, NativeChallengePurpose::Transfer)
            {
                scopes.insert(
                    ceremony.scope().account_id.clone(),
                    ceremony.scope().clone(),
                );
            }
        }
    }
    scopes.into_values().collect::<Vec<_>>()
}
