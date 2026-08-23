use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{decrypt, encrypt, EncryptedData};
use subtle::ConstantTimeEq;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use zeroize::Zeroizing;

use crate::{
    authentication::VerifiedAuthentication,
    platform_storage::{
        AccountMetadataDocument, CurrentSessionDocument, QuickUnlockDocument,
        VerifiedTravelModePolicy,
    },
    protocol::{AccountId, Incarnation},
    RuntimeError, RuntimeErrorCode,
};

const MASTER_UNLOCK_KEY_BYTES: usize = 32;
const NANOS_PER_MILLISECOND: i128 = 1_000_000;
const DEFAULT_SESSION_EXPIRY_MS: u64 = 14 * 24 * 60 * 60 * 1_000;

/// The local evidence a full Sign-in must commit after remote authentication succeeds.
/// Master password is intentionally not representable here.
pub(crate) struct AuthenticationInstallationEvidence {
    pub(crate) secret_key: Zeroizing<String>,
    pub(crate) insecure_transport_confirmed: bool,
}

impl AuthenticationInstallationEvidence {
    pub(crate) fn new(secret_key: String, insecure_transport_confirmed: bool) -> Self {
        Self {
            secret_key: Zeroizing::new(secret_key),
            insecure_transport_confirmed,
        }
    }
}

/// Randomness needed by installation, kept private so tests can fix persistence identities.
pub(crate) trait InstallationEntropy: Send + Sync {
    fn generate_uuid(&self) -> String;
    fn generate_device_key(&self) -> [u8; MASTER_UNLOCK_KEY_BYTES];
}

pub(crate) struct SystemInstallationEntropy;

impl InstallationEntropy for SystemInstallationEntropy {
    fn generate_uuid(&self) -> String {
        bittery_crypto_core::generate_uuid()
    }

    fn generate_device_key(&self) -> [u8; MASTER_UNLOCK_KEY_BYTES] {
        bittery_crypto_core::generate_encryption_key()
    }
}

/// Fully prepared generation documents. Construction validates all authenticated timestamps and
/// filters hidden Travel Mode Vault keys before any installation write starts.
pub(crate) struct PreparedAuthenticatedInstallation {
    pub(crate) metadata: AccountMetadataDocument,
    pub(crate) quick_unlock: QuickUnlockDocument,
    pub(crate) current_session: CurrentSessionDocument,
    pub(crate) master_unlock_key: Zeroizing<[u8; MASTER_UNLOCK_KEY_BYTES]>,
}

/// Fully prepared writes for re-authenticating one existing Account generation.
pub(crate) struct PreparedQuickUnlock {
    pub(crate) metadata: AccountMetadataDocument,
    pub(crate) quick_unlock: QuickUnlockDocument,
    pub(crate) current_session: CurrentSessionDocument,
    pub(crate) master_unlock_key: Zeroizing<[u8; MASTER_UNLOCK_KEY_BYTES]>,
}

/// The one clock capability Account installation needs.
pub(crate) trait Clock: Send + Sync {
    fn now_ms(&self) -> Result<u64, RuntimeError>;
}

pub(crate) struct SystemClock;

#[cfg(test)]
pub(crate) struct FixedClock(pub(crate) u64);

#[cfg(test)]
impl Clock for FixedClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        Ok(self.0)
    }
}

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
impl Clock for SystemClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        use std::time::{SystemTime, UNIX_EPOCH};

        let elapsed = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "System clock is before the Unix epoch",
            )
        })?;
        u64::try_from(elapsed.as_millis()).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "System clock is outside the supported range",
            )
        })
    }
}

/// Server-authenticated material after the policy shared by Sign-in and Quick Unlock has passed.
/// The two callers add only their distinct local identity and document-installation rules.
struct ValidatedAuthentication {
    now_ms: u64,
    normalized_server_url: String,
    kdf_profile: bittery_crypto_core::KdfProfile,
    master_unlock_key: Zeroizing<[u8; MASTER_UNLOCK_KEY_BYTES]>,
    token: Zeroizing<String>,
    session_id: String,
    user: crate::server_contract::LoginUserResponse,
    vault_keys: Vec<crate::server_contract::AuthVaultKeyResponse>,
    verified_travel_mode: VerifiedTravelModePolicy,
    expires_at_ms: u64,
    server_expires_at_ms: u64,
}

fn validate_authenticated_session(
    verified: VerifiedAuthentication,
    pinned_kdf_profile: Option<&bittery_crypto_core::KdfProfile>,
    clock: &dyn Clock,
) -> Result<ValidatedAuthentication, RuntimeError> {
    let now_ms = clock.now_ms()?;
    bittery_crypto_core::validate_kdf_profile(&verified.kdf_profile, pinned_kdf_profile).map_err(
        |_| {
            RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "Authenticated KDF profile does not match the installed Account",
            )
        },
    )?;
    if verified.session_id.is_empty() {
        return Err(invalid_authenticated_session());
    }

    let mut authenticated_vault_ids = std::collections::HashSet::new();
    for vault_key in &verified.vault_keys {
        if vault_key.vault_id.is_empty()
            || vault_key.encrypted_vault_key.is_empty()
            || !authenticated_vault_ids.insert(vault_key.vault_id.as_str())
        {
            return Err(invalid_authenticated_session());
        }
    }
    let mut hidden_vault_ids = std::collections::HashSet::new();
    for vault_id in &verified.travel_mode.hidden_vault_ids {
        if vault_id.is_empty() || !hidden_vault_ids.insert(vault_id.as_str()) {
            return Err(invalid_authenticated_session());
        }
    }

    let server_expires_at_ms = parse_session_expiry_ms(&verified.expires_at)?;
    if server_expires_at_ms <= now_ms {
        return Err(RuntimeError::new(
            RuntimeErrorCode::AuthenticationUnavailable,
            "Server Session is already expired",
        ));
    }
    let expires_at_ms = now_ms
        .checked_add(DEFAULT_SESSION_EXPIRY_MS)
        .ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Device Session expiry overflowed",
            )
        })?;

    if verified.travel_mode.enabled != verified.travel_mode.enabled_at.is_some() {
        return Err(RuntimeError::new(
            RuntimeErrorCode::AuthenticationUnavailable,
            "Server Travel Mode activation timestamp is inconsistent",
        ));
    }
    let server_enabled_at_ms = verified
        .travel_mode
        .enabled_at
        .as_deref()
        .map(parse_server_timestamp_ms)
        .transpose()?;
    let verified_travel_mode = VerifiedTravelModePolicy {
        enabled: verified.travel_mode.enabled,
        hidden_vault_ids: verified.travel_mode.hidden_vault_ids.clone(),
        server_enabled_at_ms,
        server_updated_at_ms: Some(parse_server_timestamp_ms(&verified.travel_mode.updated_at)?),
        verified_at_ms: now_ms,
    };
    if !verified.travel_mode.enabled {
        hidden_vault_ids.clear();
    }
    let vault_keys = verified
        .vault_keys
        .into_iter()
        .filter(|vault_key| !hidden_vault_ids.contains(vault_key.vault_id.as_str()))
        .collect();

    Ok(ValidatedAuthentication {
        now_ms,
        normalized_server_url: verified.normalized_server_url,
        kdf_profile: verified.kdf_profile,
        master_unlock_key: verified.master_unlock_key,
        token: verified.token,
        session_id: verified.session_id,
        user: verified.user,
        vault_keys,
        verified_travel_mode,
        expires_at_ms,
        server_expires_at_ms,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn prepare_authenticated_installation(
    verified: VerifiedAuthentication,
    mut evidence: AuthenticationInstallationEvidence,
    account_id: AccountId,
    incarnation: Incarnation,
    previous_metadata: Option<&AccountMetadataDocument>,
    device_key: &[u8; MASTER_UNLOCK_KEY_BYTES],
    clock: &dyn Clock,
) -> Result<PreparedAuthenticatedInstallation, RuntimeError> {
    let mut authenticated = validate_authenticated_session(
        verified,
        previous_metadata.map(|metadata| &metadata.pinned_kdf_profile),
        clock,
    )?;

    let added_at_ms =
        previous_metadata.map_or(authenticated.now_ms, |metadata| metadata.added_at_ms);
    let biometric_enabled = previous_metadata.is_some_and(|metadata| metadata.biometric_enabled);
    let encrypted_master_unlock_key =
        wrap_master_unlock_key(&authenticated.master_unlock_key, device_key)?;
    let secret_key = std::mem::take(&mut *evidence.secret_key);
    let metadata = AccountMetadataDocument::new(
        account_id.clone(),
        incarnation.clone(),
        authenticated.user.id.clone(),
        authenticated.user.email.clone(),
        authenticated.user.name.clone(),
        authenticated.normalized_server_url,
        authenticated.user.team_name.clone(),
        authenticated.user.team_avatar_url.clone(),
        authenticated.user.secret_key_hint.clone(),
        added_at_ms,
        authenticated.now_ms,
        biometric_enabled,
        evidence.insecure_transport_confirmed,
        authenticated.kdf_profile,
        Some(authenticated.verified_travel_mode),
    )?;
    let quick_unlock = QuickUnlockDocument::new(
        account_id.clone(),
        incarnation.clone(),
        encrypted_master_unlock_key,
        secret_key,
        metadata.last_active_at_ms,
        Some(authenticated.now_ms),
        biometric_enabled,
    )?;
    let current_session = CurrentSessionDocument::new(
        account_id,
        incarnation,
        std::mem::take(&mut *authenticated.token),
        Some(authenticated.session_id),
        authenticated.expires_at_ms,
        Some(authenticated.server_expires_at_ms),
        authenticated.vault_keys,
        authenticated.user.encrypted_private_key,
    )?;

    Ok(PreparedAuthenticatedInstallation {
        metadata,
        quick_unlock,
        current_session,
        master_unlock_key: authenticated.master_unlock_key,
    })
}

/// Validates fresh Server evidence against the exact installed generation before any Quick Unlock
/// write is allowed. The existing Replica and generation identities are intentionally absent from
/// the returned write set.
pub(crate) fn prepare_quick_unlock(
    verified: VerifiedAuthentication,
    metadata: AccountMetadataDocument,
    quick_unlock: QuickUnlockDocument,
    stored_master_unlock_key: &Zeroizing<[u8; MASTER_UNLOCK_KEY_BYTES]>,
    clock: &dyn Clock,
) -> Result<PreparedQuickUnlock, RuntimeError> {
    if verified.normalized_server_url != metadata.normalized_server_url
        || verified.user.id != metadata.user_id
        || verified.kdf_profile != metadata.pinned_kdf_profile
    {
        return Err(RuntimeError::new(
            RuntimeErrorCode::AuthenticationUnavailable,
            "Authenticated Account evidence does not match the installed Account",
        ));
    }
    if !bool::from(
        verified
            .master_unlock_key
            .as_slice()
            .ct_eq(stored_master_unlock_key.as_slice()),
    ) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::AuthenticationRequired,
            "Stored master unlock key does not match the installed Account",
        ));
    }
    let mut authenticated =
        validate_authenticated_session(verified, Some(&metadata.pinned_kdf_profile), clock)?;

    let account_id = metadata.account_id.clone();
    let incarnation = metadata.incarnation.clone();
    let refreshed_name = if authenticated.user.name.is_empty() {
        metadata.name
    } else {
        authenticated.user.name
    };
    let updated_metadata = AccountMetadataDocument::new(
        account_id.clone(),
        incarnation.clone(),
        metadata.user_id,
        metadata.email,
        refreshed_name,
        metadata.normalized_server_url,
        authenticated.user.team_name.or(metadata.team_name),
        authenticated
            .user
            .team_avatar_url
            .or(metadata.team_avatar_url),
        // Quick Unlock reuses the installed Secret Key, so its installed hint remains authoritative.
        metadata.secret_key_hint,
        metadata.added_at_ms,
        metadata.last_active_at_ms,
        metadata.biometric_enabled,
        metadata.insecure_transport_confirmed,
        metadata.pinned_kdf_profile,
        Some(authenticated.verified_travel_mode),
    )?;
    let updated_quick_unlock = quick_unlock.record_master_password_entry(authenticated.now_ms)?;
    let current_session = CurrentSessionDocument::new(
        account_id,
        incarnation,
        std::mem::take(&mut *authenticated.token),
        Some(authenticated.session_id),
        authenticated.expires_at_ms,
        Some(authenticated.server_expires_at_ms),
        authenticated.vault_keys,
        authenticated.user.encrypted_private_key,
    )?;

    Ok(PreparedQuickUnlock {
        metadata: updated_metadata,
        quick_unlock: updated_quick_unlock,
        current_session,
        master_unlock_key: authenticated.master_unlock_key,
    })
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
impl Clock for SystemClock {
    fn now_ms(&self) -> Result<u64, RuntimeError> {
        let milliseconds = js_sys::Date::now();
        if !milliseconds.is_finite() || milliseconds < 0.0 || milliseconds > u64::MAX as f64 {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "System clock is outside the supported range",
            ));
        }

        Ok(milliseconds as u64)
    }
}

/// Preserves the existing quick-unlock plaintext and encryption format.
pub(crate) fn wrap_master_unlock_key(
    master_unlock_key: &[u8; MASTER_UNLOCK_KEY_BYTES],
    device_key: &[u8; MASTER_UNLOCK_KEY_BYTES],
) -> Result<EncryptedData, RuntimeError> {
    let plaintext = Zeroizing::new(BASE64.encode(master_unlock_key));
    encrypt(&plaintext, device_key).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Master unlock key could not be wrapped",
        )
    })
}

/// Opens only the exact standard-Base64, 32-byte quick-unlock form.
pub(crate) fn unwrap_master_unlock_key(
    wrapped: &EncryptedData,
    device_key: &[u8; MASTER_UNLOCK_KEY_BYTES],
) -> Result<Zeroizing<[u8; MASTER_UNLOCK_KEY_BYTES]>, RuntimeError> {
    let plaintext = Zeroizing::new(decrypt(wrapped, device_key).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::AuthenticationRequired,
            "Stored master unlock key is invalid",
        )
    })?);
    let decoded = Zeroizing::new(BASE64.decode(plaintext.as_bytes()).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::AuthenticationRequired,
            "Stored master unlock key is invalid",
        )
    })?);
    if decoded.len() != MASTER_UNLOCK_KEY_BYTES {
        return Err(RuntimeError::new(
            RuntimeErrorCode::AuthenticationRequired,
            "Stored master unlock key is invalid",
        ));
    }

    let mut master_unlock_key = Zeroizing::new([0_u8; MASTER_UNLOCK_KEY_BYTES]);
    master_unlock_key.copy_from_slice(&decoded);
    Ok(master_unlock_key)
}

/// Converts authenticated Server expiry evidence to the Runtime's millisecond clock domain.
pub(crate) fn parse_session_expiry_ms(expires_at: &str) -> Result<u64, RuntimeError> {
    let timestamp = OffsetDateTime::parse(expires_at, &Rfc3339)
        .map_err(|_| invalid_session_expiry())?
        .unix_timestamp_nanos();

    timestamp_nanos_to_ms(timestamp)
}

fn parse_server_timestamp_ms(value: &str) -> Result<u64, RuntimeError> {
    let timestamp = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| invalid_server_timestamp())?
        .unix_timestamp_nanos();
    timestamp_nanos_to_ms(timestamp).map_err(|_| invalid_server_timestamp())
}

fn timestamp_nanos_to_ms(timestamp: i128) -> Result<u64, RuntimeError> {
    if timestamp < 0 {
        return Err(invalid_session_expiry());
    }

    u64::try_from(timestamp / NANOS_PER_MILLISECOND).map_err(|_| invalid_session_expiry())
}

fn invalid_session_expiry() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationUnavailable,
        "Server Session expiry is invalid",
    )
}

fn invalid_server_timestamp() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationUnavailable,
        "Server Travel Mode timestamp is invalid",
    )
}

fn invalid_authenticated_session() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationUnavailable,
        "Authenticated Server Session material is invalid",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server_contract::{
        AuthVaultKeyResponse, LoginUserResponse, TravelModeResponse, VaultRole, VaultType,
    };

    const MUK: [u8; MASTER_UNLOCK_KEY_BYTES] = [0xA5; MASTER_UNLOCK_KEY_BYTES];
    const DEVICE_KEY: [u8; MASTER_UNLOCK_KEY_BYTES] = [0x3C; MASTER_UNLOCK_KEY_BYTES];
    const SECRET_KEY: &str = "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2";

    fn vault_key(vault_id: &str) -> AuthVaultKeyResponse {
        AuthVaultKeyResponse {
            encrypted_vault_key: format!("wrapped-{vault_id}"),
            role: VaultRole::Owner,
            vault_icon: None,
            vault_id: vault_id.into(),
            vault_image_url: None,
            vault_name: vault_id.into(),
            vault_type: VaultType::Personal,
        }
    }

    fn verified() -> VerifiedAuthentication {
        VerifiedAuthentication {
            normalized_server_url: "https://vault.example.com".into(),
            kdf_profile: bittery_crypto_core::current_kdf_profile(),
            master_unlock_key: Zeroizing::new(MUK),
            token: Zeroizing::new("session-token".into()),
            session_id: "session-id".into(),
            expires_at: "2030-01-01T00:00:00Z".into(),
            user: LoginUserResponse {
                email: "alice@example.com".into(),
                encrypted_private_key: "encrypted-private-key".into(),
                id: "user-1".into(),
                name: "Alice".into(),
                public_key: "public-key".into(),
                secret_key_hint: "A3-A••••".into(),
                team_avatar_url: None,
                team_name: Some("Team".into()),
            },
            vault_keys: vec![vault_key("visible"), vault_key("hidden")],
            travel_mode: TravelModeResponse {
                enabled: true,
                enabled_at: Some("2029-01-01T00:00:00Z".into()),
                hidden_vault_ids: vec!["hidden".into()],
                updated_at: "2029-01-02T00:00:00Z".into(),
            },
        }
    }

    fn evidence() -> AuthenticationInstallationEvidence {
        AuthenticationInstallationEvidence::new(SECRET_KEY.into(), false)
    }

    fn existing_metadata() -> AccountMetadataDocument {
        AccountMetadataDocument::new(
            AccountId::from("account"),
            Incarnation::from("generation"),
            "user-1".into(),
            "alice@example.com".into(),
            "Stored Name".into(),
            "https://vault.example.com".into(),
            Some("Stored Team".into()),
            Some("stored-avatar".into()),
            "stored-hint".into(),
            123,
            456,
            true,
            false,
            bittery_crypto_core::current_kdf_profile(),
            None,
        )
        .unwrap()
    }

    fn existing_quick_unlock() -> QuickUnlockDocument {
        QuickUnlockDocument::new(
            AccountId::from("account"),
            Incarnation::from("generation"),
            wrap_master_unlock_key(&MUK, &DEVICE_KEY).unwrap(),
            SECRET_KEY.into(),
            123,
            Some(456),
            true,
        )
        .unwrap()
    }

    #[test]
    fn wrapper_encrypts_the_standard_base64_plaintext_without_aad() {
        let wrapped = wrap_master_unlock_key(&MUK, &DEVICE_KEY).unwrap();

        assert_eq!(
            decrypt(&wrapped, &DEVICE_KEY).unwrap(),
            "paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU="
        );
        assert_eq!(wrapped.algorithm, "AES-GCM-AAD-V1");
    }

    #[test]
    fn wrapped_master_unlock_key_roundtrips_exactly() {
        let wrapped = wrap_master_unlock_key(&MUK, &DEVICE_KEY).unwrap();

        assert_eq!(
            *unwrap_master_unlock_key(&wrapped, &DEVICE_KEY).unwrap(),
            MUK
        );
    }

    #[test]
    fn unwrap_rejects_malformed_base64_and_wrong_length() {
        for plaintext in ["not base64", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="] {
            let wrapped = encrypt(plaintext, &DEVICE_KEY).unwrap();
            let error = unwrap_master_unlock_key(&wrapped, &DEVICE_KEY).unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
        }
    }

    #[test]
    fn deterministic_clock_returns_its_fixed_milliseconds() {
        assert_eq!(
            FixedClock(1_777_777_777_123).now_ms().unwrap(),
            1_777_777_777_123
        );
    }

    #[test]
    fn quick_unlock_preparation_preserves_existing_generation_and_legacy_optional_metadata() {
        let mut fresh = verified();
        fresh.user.name.clear();
        fresh.user.team_name = None;
        fresh.user.team_avatar_url = None;
        fresh.user.secret_key_hint = "changed-server-hint".into();
        fresh.user.email = "server-canonicalized@example.com".into();
        let prepared = prepare_quick_unlock(
            fresh,
            existing_metadata(),
            existing_quick_unlock(),
            &Zeroizing::new(MUK),
            &FixedClock(1_700_000_000_000),
        )
        .unwrap();

        assert_eq!(prepared.metadata.account_id, AccountId::from("account"));
        assert_eq!(
            prepared.metadata.incarnation,
            Incarnation::from("generation")
        );
        assert_eq!(prepared.metadata.name, "Stored Name");
        assert_eq!(prepared.metadata.team_name.as_deref(), Some("Stored Team"));
        assert_eq!(
            prepared.metadata.team_avatar_url.as_deref(),
            Some("stored-avatar")
        );
        assert_eq!(prepared.metadata.secret_key_hint, "stored-hint");
        assert_eq!(prepared.metadata.email, "alice@example.com");
        assert_eq!(prepared.metadata.last_active_at_ms, 456);
        assert_eq!(
            prepared.quick_unlock.last_master_password_entry_ms,
            Some(1_700_000_000_000)
        );
        assert_eq!(prepared.current_session.vault_keys.len(), 1);
        assert_eq!(prepared.current_session.vault_keys[0].vault_id, "visible");
    }

    #[test]
    fn quick_unlock_classifies_a_decryptable_wrong_stored_muk_as_full_sign_in_required() {
        let error = prepare_quick_unlock(
            verified(),
            existing_metadata(),
            existing_quick_unlock(),
            &Zeroizing::new([0x11; MASTER_UNLOCK_KEY_BYTES]),
            &FixedClock(1_700_000_000_000),
        )
        .err()
        .expect("mismatched stored MUK must fail");

        assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    }

    #[test]
    fn preparation_filters_travel_vaults_and_preserves_replacement_preferences() {
        let old = AccountMetadataDocument::new(
            AccountId::from("account"),
            Incarnation::from("old"),
            "user-1".into(),
            "old@example.com".into(),
            "Old Name".into(),
            "https://vault.example.com".into(),
            None,
            None,
            "old-hint".into(),
            123,
            456,
            true,
            false,
            bittery_crypto_core::current_kdf_profile(),
            None,
        )
        .unwrap();

        let prepared = prepare_authenticated_installation(
            verified(),
            evidence(),
            AccountId::from("account"),
            Incarnation::from("new"),
            Some(&old),
            &DEVICE_KEY,
            &FixedClock(1_700_000_000_000),
        )
        .unwrap();

        assert_eq!(prepared.metadata.added_at_ms, 123);
        assert!(prepared.metadata.biometric_enabled);
        assert_eq!(prepared.metadata.name, "Alice");
        assert_eq!(prepared.metadata.last_active_at_ms, 1_700_000_000_000);
        assert_eq!(prepared.current_session.vault_keys.len(), 1);
        assert_eq!(prepared.current_session.vault_keys[0].vault_id, "visible");
        assert_eq!(prepared.current_session.expires_at_ms, 1_701_209_600_000);
        assert_eq!(
            prepared.current_session.server_expires_at_ms,
            Some(1_893_456_000_000)
        );
        assert_eq!(
            prepared.metadata.verified_travel_mode,
            Some(VerifiedTravelModePolicy {
                enabled: true,
                hidden_vault_ids: vec!["hidden".into()],
                server_enabled_at_ms: Some(1_861_920_000_000),
                server_updated_at_ms: Some(1_862_006_400_000),
                verified_at_ms: 1_700_000_000_000,
            })
        );
    }

    #[test]
    fn preparation_rejects_all_malformed_authenticated_time_and_session_evidence() {
        let mut cases = Vec::new();
        let mut empty_session = verified();
        empty_session.session_id.clear();
        cases.push(empty_session);
        let mut expired = verified();
        expired.expires_at = "2020-01-01T00:00:00Z".into();
        cases.push(expired);
        let mut malformed_expiry = verified();
        malformed_expiry.expires_at = "not-a-time".into();
        cases.push(malformed_expiry);
        let mut inconsistent_travel = verified();
        inconsistent_travel.travel_mode.enabled_at = None;
        cases.push(inconsistent_travel);
        let mut malformed_travel = verified();
        malformed_travel.travel_mode.updated_at = "not-a-time".into();
        cases.push(malformed_travel);
        let mut duplicate_hidden = verified();
        duplicate_hidden
            .travel_mode
            .hidden_vault_ids
            .push("hidden".into());
        cases.push(duplicate_hidden);

        for value in cases {
            let error = prepare_authenticated_installation(
                value,
                evidence(),
                AccountId::from("account"),
                Incarnation::from("generation"),
                None,
                &DEVICE_KEY,
                &FixedClock(1_700_000_000_000),
            )
            .err()
            .expect("hostile authenticated evidence must fail");
            assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        }
    }

    #[test]
    fn hidden_vault_keys_are_validated_before_they_are_filtered() {
        for corrupt in ["duplicate", "empty-id", "empty-key"] {
            let mut value = verified();
            match corrupt {
                "duplicate" => value.vault_keys.push(vault_key("hidden")),
                "empty-id" => value.vault_keys.push(vault_key("")),
                "empty-key" => value.vault_keys[1].encrypted_vault_key.clear(),
                _ => unreachable!(),
            }
            let error = prepare_authenticated_installation(
                value,
                evidence(),
                AccountId::from("account"),
                Incarnation::from("generation"),
                None,
                &DEVICE_KEY,
                &FixedClock(1_700_000_000_000),
            )
            .err()
            .expect("hidden hostile Vault keys must fail before filtering");
            assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        }
    }

    #[test]
    fn replacement_rejects_a_post_proof_kdf_pin_mismatch() {
        let mut old = AccountMetadataDocument::new(
            AccountId::from("account"),
            Incarnation::from("old"),
            "user-1".into(),
            "alice@example.com".into(),
            "Alice".into(),
            "https://vault.example.com".into(),
            None,
            None,
            "hint".into(),
            1,
            2,
            false,
            false,
            bittery_crypto_core::current_kdf_profile(),
            None,
        )
        .unwrap();
        old.pinned_kdf_profile.iterations -= 1;

        let error = prepare_authenticated_installation(
            verified(),
            evidence(),
            AccountId::from("account"),
            Incarnation::from("new"),
            Some(&old),
            &DEVICE_KEY,
            &FixedClock(1_700_000_000_000),
        )
        .err()
        .expect("a replacement must revalidate its installed KDF pin");
        assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
    }

    #[test]
    fn session_expiry_parses_rfc3339_into_milliseconds() {
        assert_eq!(
            parse_session_expiry_ms("1970-01-01T00:00:01.23456789Z").unwrap(),
            1_234
        );
        assert_eq!(
            parse_session_expiry_ms("1970-01-01T01:00:01.234+01:00").unwrap(),
            1_234
        );
    }

    #[test]
    fn session_expiry_rejects_malformed_and_pre_epoch_values() {
        for expires_at in [
            "2026-08-23T12:34:56",
            "not-a-date",
            "1969-12-31T23:59:59.999999999Z",
            "+999999-01-01T00:00:00Z",
        ] {
            let error = parse_session_expiry_ms(expires_at).unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::AuthenticationUnavailable);
        }

        assert_eq!(
            timestamp_nanos_to_ms(i128::MAX).unwrap_err().code,
            RuntimeErrorCode::AuthenticationUnavailable
        );
    }
}
