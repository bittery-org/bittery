//! Read-only compatibility validation for the first locked Desktop Account path. No destination
//! identity or document is installed here; the catalog-owned admission lifecycle remains fenced.
use super::{source, Runtime};
use crate::{
    auth_http::AuthHttpClient,
    platform_storage::{
        AccountMetadataDocument, CurrentSessionDocument, DeviceKeyDocument,
        LegacyDesktopAccountEvidence, LegacySessionEvidenceDocument, LegacySessionEvidenceMaterial,
        QuickUnlockDocument, VerifiedTravelModePolicy,
    },
    protocol::Incarnation,
    AccountId, ProfileAccountCredentialField as Field, ProfileGlobalCredentialField,
    ProfileSourceFamily, ProfileSourceObservation, ProfileSourcePresence, ProfileSourceSelector,
    ProfileSourceSnapshot, ProfileSourceStringEncoding, RuntimeError, RuntimeErrorCode,
    SecretString, SerializedProfileAdmissionExecutor,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{de::MapAccess, Deserialize, Deserializer};
use std::collections::{BTreeMap, HashSet};
use zeroize::Zeroizing;

mod cache;
mod commands;
pub(super) use commands::{BoundCommand, CommandScope};
mod travel;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) struct DecodedDesktop {
    pub(super) accounts: Vec<DecodedAccount>,
    pub(super) selected_account: Option<AccountId>,
    pub(super) device_key: Option<DeviceKeyDocument>,
    pub(super) master_password_reentry_period_ms: Option<i64>,
    pub(super) sync_client_id: Option<String>,
    pub(super) manifest: source::Manifest,
}

pub(super) struct DecodedAccount {
    account: Account,
    normalized_server_url: String,
    pinned_kdf_profile: bittery_crypto_core::KdfProfile,
    inactivity_timeout_ms: Option<i64>,
    last_biometric_auth: Option<i64>,
    background_timestamp: Option<i64>,
    enrollment_enabled: bool,
    travel_policy: Option<VerifiedTravelModePolicy>,
    credentials: DecodedCredentials,
    cache: Option<cache::DecodedCache>,
    commands: Vec<commands::DecodedCommand>,
}

struct DecodedAccountSeed {
    account: Account,
    normalized_server_url: String,
    pinned_kdf_profile: bittery_crypto_core::KdfProfile,
    inactivity_timeout_ms: Option<i64>,
    last_biometric_auth: Option<i64>,
    background_timestamp: Option<i64>,
    enrollment_enabled: bool,
    travel_policy: Option<VerifiedTravelModePolicy>,
}

impl DecodedAccount {
    pub(super) fn account_id(&self) -> &AccountId {
        &self.credentials.account_id
    }

    pub(super) fn bind(
        self,
        incarnation: Incarnation,
        manifest_entries_sha256: String,
    ) -> Result<BoundDesktopAccount, RuntimeError> {
        if self
            .travel_policy
            .as_ref()
            .is_some_and(|policy| policy.enabled)
            && !self.commands.is_empty()
        {
            return Err(invalid(
                "Legacy Desktop enabled Travel policy with pending work is not yet supported",
            ));
        }
        let account_id = self.credentials.account_id.clone();
        let mut metadata = AccountMetadataDocument::new(
            account_id.clone(),
            incarnation.clone(),
            self.account.user_id,
            self.account.email,
            self.account.name,
            self.normalized_server_url,
            self.account.team_name,
            self.account.team_avatar_url.flatten(),
            self.account.secret_key_hint,
            self.account.added_at,
            self.account.last_active_at,
            self.enrollment_enabled,
            self.account.insecure_transport_confirmed,
            self.pinned_kdf_profile,
            self.travel_policy,
        )?;
        metadata.legacy_desktop_evidence = Some(LegacyDesktopAccountEvidence {
            account_biometric_enabled: self.account.biometric_enabled,
            session_biometric_enabled: self.credentials.session_biometric_enabled,
            last_biometric_auth: self.last_biometric_auth,
            background_timestamp: self.background_timestamp,
        });
        let quick_unlock = QuickUnlockDocument::new(
            account_id.clone(),
            incarnation.clone(),
            self.credentials.encrypted_master_unlock_key,
            self.credentials.secret_key.to_string(),
            self.credentials.created_at_ms,
            self.credentials.last_master_password_entry_ms,
            self.enrollment_enabled,
        )?;
        let (mut current_session, mut legacy_session_evidence) =
            match self.credentials.retained_session {
                RetainedSession::Evidence(material) => (
                    None,
                    Some(LegacySessionEvidenceDocument::new(
                        account_id,
                        incarnation,
                        manifest_entries_sha256.clone(),
                        material,
                    )?),
                ),
                RetainedSession::Complete {
                    source_session_instance,
                    token,
                    session_id,
                    expires_at_ms,
                    server_expires_at_ms,
                    vault_keys,
                    encrypted_private_key,
                } => {
                    if source_session_instance.is_some() {
                        return Err(invalid(
                            "Legacy Desktop retained Session has a browser Session instance",
                        ));
                    }
                    (
                        Some(CurrentSessionDocument::new(
                            account_id,
                            incarnation,
                            token.to_string(),
                            session_id,
                            expires_at_ms,
                            server_expires_at_ms,
                            vault_keys,
                            encrypted_private_key.to_string(),
                        )?),
                        None,
                    )
                }
            };
        // Validate the entire original credential document before erasing keys, so malformed
        // hidden evidence cannot disappear through filtering. These are still private plans.
        let hidden = metadata
            .verified_travel_mode
            .as_ref()
            .filter(|policy| policy.enabled)
            .map(|policy| policy.hidden_vault_ids.as_slice())
            .unwrap_or_default();
        if let Some(session) = current_session.as_mut() {
            session
                .vault_keys
                .retain(|key| !hidden.contains(&key.vault_id));
        }
        if let Some(keys) = legacy_session_evidence
            .as_mut()
            .and_then(|evidence| evidence.vault_keys.as_mut())
        {
            keys.retain(|key| !hidden.contains(&key.vault_id));
        }
        let vault_keys = current_session
            .as_ref()
            .map(|session| session.vault_keys.as_slice())
            .or_else(|| {
                legacy_session_evidence
                    .as_ref()
                    .and_then(|evidence| evidence.vault_keys.as_deref())
            });
        let legacy_cache = self
            .cache
            .map(|cache| {
                cache.bind(
                    metadata.incarnation.clone(),
                    manifest_entries_sha256,
                    vault_keys,
                    hidden,
                )
            })
            .transpose()?;
        let (legacy_cache, captured_create_failures) = legacy_cache
            .map(|cache| (Some(cache.bootstrap), cache.failures))
            .unwrap_or_default();
        Ok(BoundDesktopAccount {
            metadata,
            quick_unlock,
            current_session,
            legacy_session_evidence,
            inactivity_timeout_ms: self.inactivity_timeout_ms,
            legacy_cache,
            captured_create_failures,
            legacy_commands: self.commands,
        })
    }
}

struct DecodedCredentials {
    account_id: AccountId,
    encrypted_master_unlock_key: bittery_crypto_core::EncryptedData,
    secret_key: SecretString,
    created_at_ms: u64,
    last_master_password_entry_ms: Option<u64>,
    session_biometric_enabled: Option<bool>,
    retained_session: RetainedSession,
}

enum RetainedSession {
    Evidence(LegacySessionEvidenceMaterial),
    Complete {
        source_session_instance: Option<String>,
        token: SecretString,
        session_id: Option<String>,
        expires_at_ms: u64,
        server_expires_at_ms: Option<u64>,
        vault_keys: Vec<crate::server_contract::AuthVaultKeyResponse>,
        encrypted_private_key: SecretString,
    },
}

pub(super) struct BoundDesktopAccount {
    pub(super) metadata: AccountMetadataDocument,
    pub(super) quick_unlock: QuickUnlockDocument,
    pub(super) current_session: Option<CurrentSessionDocument>,
    pub(super) legacy_session_evidence: Option<LegacySessionEvidenceDocument>,
    pub(super) inactivity_timeout_ms: Option<i64>,
    pub(super) legacy_cache: Option<crate::replica::LegacyAdmissionBootstrap>,
    pub(super) legacy_commands: Vec<commands::DecodedCommand>,
    pub(super) captured_create_failures: Vec<cache::CapturedCreateFailure>,
}

fn invalid(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

/// The outer file contains stored strings. A typed map visitor preserves duplicate/type errors
/// before any value can be treated as absent; a generic JSON object would collapse duplicates.
struct StoredStrings(BTreeMap<String, SecretString>);
impl<'de> Deserialize<'de> for StoredStrings {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = StoredStrings;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object of unique stored strings")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut values = BTreeMap::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(serde::de::Error::custom("duplicate stored key"));
                    }
                    values.insert(key, map.next_value::<SecretString>()?);
                }
                Ok(StoredStrings(values))
            }
        }
        decoder.deserialize_map(Visitor)
    }
}

fn file(
    read: source::SourceRead,
    message: &'static str,
) -> Result<BTreeMap<String, SecretString>, RuntimeError> {
    match (read.observation, read.bytes) {
        (ProfileSourceObservation::Missing {}, None) => Ok(BTreeMap::new()),
        (ProfileSourceObservation::FileBytes { .. }, Some(bytes)) => {
            serde_json::from_slice::<StoredStrings>(&bytes)
                .map(|values| values.0)
                .map_err(|_| invalid(message))
        }
        _ => Err(invalid(message)),
    }
}

// Optional does not mean nullable. Legacy writers omit these fields; a present null must not
// silently become the absent default. teamAvatarUrl alone explicitly permits null.
fn present<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
    decoder: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(decoder).map(Some)
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct Accounts {
    version: u32,
    accounts: Vec<Account>,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct Account {
    account_id: String,
    email: String,
    user_id: String,
    name: String,
    server_url: String,
    #[serde(default, deserialize_with = "present")]
    team_name: Option<String>,
    #[serde(default, deserialize_with = "present")]
    team_avatar_url: Option<Option<String>>,
    secret_key_hint: String,
    added_at: u64,
    last_active_at: u64,
    biometric_enabled: bool,
    insecure_transport_confirmed: bool,
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct Kdf {
    schema_version: u32,
    algorithm: String,
    iterations: u32,
}

fn json<'a, T: Deserialize<'a>>(value: &'a str, message: &'static str) -> Result<T, RuntimeError> {
    serde_json::from_str(value).map_err(|_| invalid(message))
}

fn integer(value: &str) -> Result<i64, RuntimeError> {
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid("Legacy Desktop security preference is malformed"));
    }
    let number = value
        .parse::<i64>()
        .map_err(|_| invalid("Legacy Desktop security preference is malformed"))?;
    if number.unsigned_abs() > MAX_SAFE_INTEGER {
        return Err(invalid("Legacy Desktop security preference is malformed"));
    }
    Ok(number)
}

fn account_key(account: &Account, field: &str) -> String {
    format!("bittery_account_{}_{}", account.account_id, field)
}

fn normalize(runtime: &Runtime, value: &str, confirmed: bool) -> Result<String, RuntimeError> {
    let config = runtime
        .auth_client_config
        .clone()
        .ok_or_else(|| invalid("Legacy Desktop admission requires authentication configuration"))?;
    AuthHttpClient::new(&runtime.http_transport, value, confirmed, config)
        .map(|client| client.normalized_server_url())
        .map_err(|_| invalid("Legacy Desktop Server identity is invalid"))
}

fn decode_sync(
    read: source::SourceRead,
) -> Result<(Option<String>, BTreeMap<String, SecretString>), RuntimeError> {
    let mut values = file(read, "Legacy Desktop Sync store is malformed")?;
    let sync_client_id = values
        .remove("bittery_sync_client_id")
        .map(|value| {
            if value.is_empty() {
                Err(invalid("Legacy Desktop Sync identity is malformed"))
            } else {
                Ok(value.to_string())
            }
        })
        .transpose()?;
    Ok((sync_client_id, values))
}

pub(super) async fn decode(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    snapshot: &ProfileSourceSnapshot,
    sources: source::DesktopSources,
) -> Result<DecodedDesktop, RuntimeError> {
    let mut evidence = vec![
        source::evidence(
            snapshot,
            ProfileSourceFamily::DesktopStore,
            ProfileSourceSelector::WholeFile {},
            &sources.store,
        )?,
        source::evidence(
            snapshot,
            ProfileSourceFamily::DesktopSyncStore,
            ProfileSourceSelector::WholeFile {},
            &sources.sync_store,
        )?,
    ];
    let mut values = file(sources.store, "Legacy Desktop store is malformed")?;
    let accounts = match values.remove("bittery_accounts_list") {
        None => Vec::new(),
        Some(value) => {
            let list: Accounts = json(&value, "Legacy Desktop Account list is malformed")?;
            if list.version != 2 {
                return Err(invalid("Legacy Desktop Account list is unsupported"));
            }
            list.accounts
        }
    };
    let selected_source = values
        .remove("bittery_active_account")
        .map(|value| value.to_string());
    let master_password_reentry_period_ms = values
        .remove("bittery_master_password_reentry_period_ms")
        .map(|value| integer(&value))
        .transpose()?;
    let mut ids = HashSet::new();
    let mut bindings = HashSet::new();
    let mut decoded_accounts = Vec::with_capacity(accounts.len());
    for account in accounts {
        if account.account_id.is_empty()
            || account.account_id.len() > crate::PROFILE_SOURCE_IDENTITY_BYTES
            || account.user_id.is_empty()
            || account.email.is_empty()
            || account.added_at > MAX_SAFE_INTEGER
            || account.last_active_at > MAX_SAFE_INTEGER
        {
            return Err(invalid("Legacy Desktop Account metadata is malformed"));
        }
        let normalized_server_url = normalize(
            runtime,
            &account.server_url,
            account.insecure_transport_confirmed,
        )?;
        if !ids.insert(account.account_id.clone())
            || !bindings.insert((normalized_server_url.clone(), account.user_id.clone()))
        {
            return Err(invalid("Legacy Desktop Account identity is duplicated"));
        }
        if let Some(value) = values.remove(&account_key(&account, "server_url")) {
            if normalize(runtime, &value, account.insecure_transport_confirmed)?
                != normalized_server_url
            {
                return Err(invalid(
                    "Legacy Desktop Server identity disagrees with Account metadata",
                ));
            }
        }
        let kdf = values
            .remove(&account_key(&account, "pinned_kdf_params"))
            .ok_or_else(|| invalid("Legacy Desktop pinned KDF is missing"))?;
        let kdf: Kdf = json(&kdf, "Legacy Desktop pinned KDF is malformed")?;
        let pinned_kdf_profile = bittery_crypto_core::KdfProfile {
            schema_version: kdf.schema_version,
            algorithm: kdf.algorithm,
            iterations: kdf.iterations,
        };
        bittery_crypto_core::validate_kdf_profile(&pinned_kdf_profile, None)
            .map_err(|_| invalid("Legacy Desktop pinned KDF is unsupported"))?;
        let inactivity_timeout_ms = values
            .remove(&account_key(&account, "auto_lock_timeout"))
            .map(|value| integer(&value))
            .transpose()?;
        let last_biometric_auth = values
            .remove(&account_key(&account, "last_biometric_auth"))
            .map(|value| integer(&value))
            .transpose()?;
        let background_timestamp = values
            .remove(&account_key(&account, "background_timestamp"))
            .map(|value| integer(&value))
            .transpose()?;
        let enrollment_enabled = match values
            .remove(&account_key(&account, "biometric_enabled"))
            .as_deref()
        {
            None | Some("false") => false,
            Some("true") => true,
            _ => return Err(invalid("Legacy Desktop biometric enrollment is malformed")),
        };
        let travel_policy = values
            .remove(&account_key(&account, "travel_mode_cache"))
            .map(|value| travel::decode(&value))
            .transpose()?;
        decoded_accounts.push(DecodedAccountSeed {
            account,
            normalized_server_url,
            pinned_kdf_profile,
            inactivity_timeout_ms,
            last_biometric_auth,
            background_timestamp,
            enrollment_enabled,
            travel_policy,
        });
    }
    // Selection is presentation state, never Account or login authority. A stale pointer remains
    // in the captured source/manifest, but only a pointer to an admitted Account is projected.
    let selected_account = selected_source.and_then(|selected| {
        decoded_accounts
            .iter()
            .any(|account| account.account.account_id == selected)
            .then(|| AccountId::from(selected))
    });
    // This stale projection is captured evidence only, never live key or enrollment authority.
    values.remove("bittery_native_view");
    let (sync_client_id, mut sync_values) = decode_sync(sources.sync_store)?;
    let identities = decoded_accounts
        .iter()
        .map(|account| cache::AccountIdentity {
            account_id: &account.account.account_id,
            user_id: &account.account.user_id,
            email: &account.account.email,
            normalized_server_url: &account.normalized_server_url,
            insecure_transport_confirmed: account.account.insecure_transport_confirmed,
        })
        .collect::<Vec<_>>();
    let mut caches = cache::decode(
        |value, confirmed| normalize(runtime, value, confirmed),
        &mut values,
        &mut sync_values,
        &identities,
    )?;
    let command_identities = decoded_accounts
        .iter()
        .map(|account| commands::AccountIdentity {
            account_id: &account.account.account_id,
            email: &account.account.email,
            user_id: &account.account.user_id,
        })
        .collect::<Vec<_>>();
    let mut commands = commands::decode(&mut sync_values, &command_identities)?;
    if !values.is_empty() {
        return Err(invalid(
            "Legacy Desktop store contains unsupported evidence",
        ));
    }
    if !sync_values.is_empty() {
        return Err(invalid(
            "Legacy Desktop Sync store contains unsupported evidence",
        ));
    }

    let credentials_present = snapshot.families.iter().any(|family| {
        family.family == ProfileSourceFamily::DesktopCredentials
            && family.presence == ProfileSourcePresence::Present
    });
    let device = credential(
        runtime,
        executor,
        snapshot,
        ProfileSourceSelector::GlobalCredential {
            field: ProfileGlobalCredentialField::DeviceKey,
        },
        &mut evidence,
    )
    .await?;
    if decoded_accounts.is_empty() {
        if credentials_present {
            return Err(invalid(
                "Legacy Desktop credentials have no Account mapping",
            ));
        }
        return Ok(DecodedDesktop {
            accounts: Vec::new(),
            selected_account,
            device_key: None,
            master_password_reentry_period_ms,
            sync_client_id,
            manifest: source::Manifest::desktop(snapshot, evidence, Vec::new())?,
        });
    }
    let device =
        device.ok_or_else(|| invalid("Legacy Desktop Quick Unlock evidence is incomplete"))?;
    let decoded = Zeroizing::new(
        STANDARD
            .decode(device.as_bytes())
            .map_err(|_| invalid("Legacy Desktop Device key is malformed"))?,
    );
    let key_bytes: [u8; 32] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| invalid("Legacy Desktop Device key is malformed"))?;
    let mut credential_indexes = (0..decoded_accounts.len()).collect::<Vec<_>>();
    credential_indexes.sort_by(|left, right| {
        decoded_accounts[*left]
            .account
            .account_id
            .as_bytes()
            .cmp(decoded_accounts[*right].account.account_id.as_bytes())
    });
    let mut decoded_credentials = BTreeMap::new();
    for index in credential_indexes {
        let account = &decoded_accounts[index];
        let mut credentials = Vec::new();
        for field in [
            Field::SecretKey,
            Field::SessionData,
            Field::JwtToken,
            Field::VaultKeys,
            Field::EncryptedPrivateKey,
        ] {
            credentials.push(
                credential(
                    runtime,
                    executor,
                    snapshot,
                    ProfileSourceSelector::AccountCredential {
                        account_id: account.account.account_id.clone().into(),
                        field,
                    },
                    &mut evidence,
                )
                .await?,
            );
        }
        decoded_credentials.insert(
            account.account.account_id.clone(),
            decode_credentials(&account.account, account.enrollment_enabled, credentials)?,
        );
    }
    let manifest = source::Manifest::desktop(
        snapshot,
        evidence,
        decoded_accounts
            .iter()
            .map(|account| account.account.account_id.clone().into())
            .collect(),
    )?;
    let accounts = decoded_accounts
        .into_iter()
        .map(|account| {
            let account_id = account.account.account_id.clone();
            let credentials = decoded_credentials
                .remove(&account_id)
                .expect("every decoded Account consumed its credential segment");
            DecodedAccount {
                account: account.account,
                normalized_server_url: account.normalized_server_url,
                pinned_kdf_profile: account.pinned_kdf_profile,
                inactivity_timeout_ms: account.inactivity_timeout_ms,
                last_biometric_auth: account.last_biometric_auth,
                background_timestamp: account.background_timestamp,
                enrollment_enabled: account.enrollment_enabled,
                travel_policy: account.travel_policy,
                credentials,
                cache: caches.remove(&account_id),
                commands: commands.remove(&account_id).unwrap_or_default(),
            }
        })
        .collect();
    Ok(DecodedDesktop {
        accounts,
        selected_account,
        device_key: Some(DeviceKeyDocument::new(key_bytes)),
        master_password_reentry_period_ms,
        sync_client_id,
        manifest,
    })
}

async fn credential(
    runtime: &Runtime,
    executor: &dyn SerializedProfileAdmissionExecutor,
    snapshot: &ProfileSourceSnapshot,
    selector: ProfileSourceSelector,
    evidence: &mut Vec<crate::ProfileSourceManifestEntry>,
) -> Result<Option<SecretString>, RuntimeError> {
    let value = source::read(
        runtime,
        executor,
        snapshot,
        ProfileSourceFamily::DesktopCredentials,
        selector.clone(),
    )
    .await?;
    if !matches!(
        value.observation,
        ProfileSourceObservation::PresentUnsupported { .. }
    ) {
        evidence.push(source::evidence(
            snapshot,
            ProfileSourceFamily::DesktopCredentials,
            selector,
            &value,
        )?);
    }
    match (value.observation, value.bytes) {
        (ProfileSourceObservation::Missing {}, None) => Ok(None),
        (
            ProfileSourceObservation::StoredString {
                encoding: ProfileSourceStringEncoding::Utf8,
                ..
            },
            Some(bytes),
        ) => {
            if !snapshot.families.iter().any(|family| {
                family.family == ProfileSourceFamily::DesktopCredentials
                    && family.presence == ProfileSourcePresence::Present
            }) {
                return Err(invalid(
                    "Legacy Desktop credential presence disagrees with its inventory",
                ));
            }
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| invalid("Legacy Desktop credential is not UTF-8"))?;
            Ok(Some(SecretString::from(text)))
        }
        _ => Err(invalid(
            "Legacy Desktop credential has an unsupported value type",
        )),
    }
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    encrypted_master_unlock_key: Envelope,
    email: String,
    user_id: String,
    created_at: u64,
    #[serde(default, deserialize_with = "present")]
    expires_at: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    server_expires_at: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    session_id: Option<String>,
    #[serde(default, deserialize_with = "present")]
    biometric_enabled: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    last_master_password_entry: Option<u64>,
}

fn expiry(value: Option<u64>, created: u64) -> Result<u64, RuntimeError> {
    let value = value.unwrap_or(14 * 24 * 60 * 60 * 1000);
    let timestamp = if value > 1_000_000_000_000 {
        Some(value)
    } else {
        created.checked_add(value)
    };
    timestamp
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid("Legacy Desktop Session expiry is malformed"))
}

fn decode_credentials(
    account: &Account,
    enabled: bool,
    credentials: Vec<Option<SecretString>>,
) -> Result<DecodedCredentials, RuntimeError> {
    let mut credentials = credentials.into_iter();
    let secret = credentials
        .next()
        .flatten()
        .ok_or_else(|| invalid("Legacy Desktop Quick Unlock evidence is incomplete"))?;
    let session = credentials
        .next()
        .flatten()
        .ok_or_else(|| invalid("Legacy Desktop Quick Unlock evidence is incomplete"))?;
    let token = credentials.next().flatten();
    let keys = credentials.next().flatten();
    let private = credentials.next().flatten();
    let session: Session = json(&session, "Legacy Desktop Session data is malformed")?;
    if session.user_id != account.user_id
        || session.email.to_lowercase() != account.email.to_lowercase()
    {
        return Err(invalid(
            "Legacy Desktop Session identity disagrees with Account metadata",
        ));
    }
    if session.created_at > MAX_SAFE_INTEGER
        || session
            .last_master_password_entry
            .is_some_and(|value| value > MAX_SAFE_INTEGER)
    {
        return Err(invalid("Legacy Desktop Session timestamp is malformed"));
    }
    let expires = expiry(session.expires_at, session.created_at)?;
    let server_expires = session
        .server_expires_at
        .map(|value| expiry(Some(value), session.created_at))
        .transpose()?;
    // Constructor validation uses a deliberately nonpublishable local placeholder. A real fixed
    // incarnation may be allocated only by the future durable Preparing catalog transition.
    let account_id = AccountId::from(account.account_id.clone());
    let encrypted_master_unlock_key = bittery_crypto_core::EncryptedData {
        ciphertext: session.encrypted_master_unlock_key.ciphertext,
        iv: session.encrypted_master_unlock_key.iv,
        algorithm: session.encrypted_master_unlock_key.algorithm,
    };
    QuickUnlockDocument::new(
        account.account_id.clone().into(),
        "unpublished-admission-validation".into(),
        encrypted_master_unlock_key.clone(),
        secret.to_string(),
        session.created_at,
        session.last_master_password_entry,
        enabled,
    )
    .map_err(|_| invalid("Legacy Desktop Quick Unlock evidence is malformed"))?;
    let vault_keys = keys
        .map(|keys| {
            serde_json::from_str::<Vec<Object<crate::server_contract::AuthVaultKeyResponse>>>(&keys)
                .map(|keys| keys.into_iter().map(|key| key.0).collect::<Vec<_>>())
                .map_err(|_| invalid("Legacy Desktop retained Session keys are malformed"))
        })
        .transpose()?;
    let retained_session = match (token, vault_keys, private) {
        (Some(token), Some(vault_keys), Some(private)) => {
            CurrentSessionDocument::new(
                account.account_id.clone().into(),
                "unpublished-admission-validation".into(),
                token.to_string(),
                session.session_id.clone(),
                expires,
                server_expires,
                vault_keys.clone(),
                private.to_string(),
            )
            .map_err(|_| invalid("Legacy Desktop retained Session is malformed"))?;
            RetainedSession::Complete {
                source_session_instance: None,
                token,
                session_id: session.session_id,
                expires_at_ms: expires,
                server_expires_at_ms: server_expires,
                vault_keys,
                encrypted_private_key: private,
            }
        }
        (token, vault_keys, encrypted_private_key) => {
            RetainedSession::Evidence(LegacySessionEvidenceMaterial {
                source_session_instance: None,
                created_at_ms: session.created_at,
                expires_at: session.expires_at,
                server_expires_at: session.server_expires_at,
                session_id: session.session_id,
                token,
                vault_keys,
                encrypted_private_key,
            })
        }
    };
    Ok(DecodedCredentials {
        account_id,
        encrypted_master_unlock_key,
        secret_key: secret,
        created_at_ms: session.created_at,
        last_master_password_entry_ms: session.last_master_password_entry,
        session_biometric_enabled: session.biometric_enabled,
        retained_session,
    })
}

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", deny_unknown_fields)]
struct Envelope {
    ciphertext: String,
    iv: String,
    algorithm: String,
}

crate::wire::map_only_serde!(Accounts, Account, Kdf, Session, Envelope);

/// Generated Server structs also support sequence deserialization. Keep their sole field/type
/// definition, but require the legacy JSON object's actual shape before decoding each Vault key.
struct Object<T>(T);
impl<T: serde::Serialize> serde::Serialize for Object<T> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Object<T> {
    fn deserialize<D: Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct Visitor<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> serde::de::Visitor<'de> for Visitor<T> {
            type Value = Object<T>;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a typed JSON object")
            }
            fn visit_map<M: MapAccess<'de>>(self, map: M) -> Result<Self::Value, M::Error> {
                T::deserialize(serde::de::value::MapAccessDeserializer::new(map)).map(Object)
            }
        }
        decoder.deserialize_map(Visitor(std::marker::PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> Account {
        Account {
            account_id: "source-account".into(),
            email: "Original@Example.test".into(),
            user_id: "source-user".into(),
            name: "Original Name".into(),
            server_url: "https://example.test".into(),
            team_name: Some("Original Team".into()),
            team_avatar_url: Some(None),
            secret_key_hint: "A3-A••••".into(),
            added_at: 1_700_000_000_000,
            last_active_at: 1_700_000_000_123,
            biometric_enabled: true,
            insecure_transport_confirmed: false,
        }
    }

    fn credentials(retain_session: bool) -> Vec<Option<SecretString>> {
        let session = serde_json::json!({
            "encryptedMasterUnlockKey": {
                "ciphertext": "source-ciphertext",
                "iv": "source-iv",
                "algorithm": "AES-GCM-AAD-V1"
            },
            "email": "original@example.test",
            "userId": "source-user",
            "createdAt": 1_700_000_000_000_u64,
            "expiresAt": 1209600000_u64,
            "serverExpiresAt": 1_800_000_000_000_u64,
            "sessionId": "source-session",
            "biometricEnabled": true,
            "lastMasterPasswordEntry": 1_699_999_999_999_u64
        })
        .to_string();
        vec![
            Some("A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2".into()),
            Some(session.into()),
            retain_session.then(|| "source-token".into()),
            retain_session.then(|| {
                serde_json::json!([{
                    "vaultId": "source-vault",
                    "encryptedVaultKey": "source-vault-key",
                    "role": "owner",
                    "vaultIcon": null,
                    "vaultImageUrl": null,
                    "vaultName": "Source Vault",
                    "vaultType": "personal"
                }])
                .to_string()
                .into()
            }),
            retain_session.then(|| "source-private-key".into()),
        ]
    }

    fn decoded(retain_session: bool) -> DecodedAccount {
        let account = account();
        let credentials = decode_credentials(&account, false, credentials(retain_session)).unwrap();
        DecodedAccount {
            account,
            normalized_server_url: "https://example.test".into(),
            pinned_kdf_profile: bittery_crypto_core::current_kdf_profile(),
            inactivity_timeout_ms: Some(-1),
            last_biometric_auth: Some(1_699_999_999_000),
            background_timestamp: Some(-1),
            enrollment_enabled: false,
            travel_policy: None,
            credentials,
            cache: None,
            commands: Vec::new(),
        }
    }

    #[test]
    fn binding_preserves_source_metadata_and_retires_only_prompt_activity_receipts() {
        let bound = decoded(false)
            .bind("recorded-incarnation".into(), "ab".repeat(32))
            .unwrap();
        assert_eq!(bound.metadata.account_id.as_str(), "source-account");
        assert_eq!(bound.metadata.incarnation.as_str(), "recorded-incarnation");
        assert_eq!(bound.metadata.email, "Original@Example.test");
        assert_eq!(bound.metadata.normalized_server_url, "https://example.test");
        assert_eq!(bound.metadata.team_name.as_deref(), Some("Original Team"));
        assert_eq!(bound.metadata.team_avatar_url, None);
        assert!(!bound.metadata.biometric_enabled);
        assert_eq!(bound.inactivity_timeout_ms, Some(-1));
        assert_eq!(
            bound.quick_unlock.last_master_password_entry_ms,
            Some(1_699_999_999_999)
        );
        assert!(!bound.quick_unlock.biometric_enabled);
        let evidence = bound.metadata.legacy_desktop_evidence.unwrap();
        assert!(evidence.account_biometric_enabled);
        assert_eq!(evidence.session_biometric_enabled, Some(true));
        assert_eq!(evidence.last_biometric_auth, Some(1_699_999_999_000));
        assert_eq!(evidence.background_timestamp, Some(-1));
        assert!(bound.current_session.is_none());
    }

    #[test]
    fn complete_retained_session_keeps_original_expiry_and_secret_documents() {
        let bound = decoded(true)
            .bind("recorded-incarnation".into(), "ab".repeat(32))
            .unwrap();
        let session = bound.current_session.unwrap();
        assert_eq!(session.token.as_ref(), "source-token");
        assert_eq!(session.session_id.as_deref(), Some("source-session"));
        assert_eq!(session.expires_at_ms, 1_701_209_600_000);
        assert_eq!(session.server_expires_at_ms, Some(1_800_000_000_000));
        assert_eq!(session.vault_keys.len(), 1);
        assert_eq!(session.vault_keys[0].vault_id, "source-vault");
        assert_eq!(session.encrypted_private_key, "source-private-key");
    }
}
