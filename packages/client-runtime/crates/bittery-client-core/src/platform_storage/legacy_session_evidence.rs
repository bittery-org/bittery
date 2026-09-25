use super::{
    deserialize_object_vec, platform_storage_invariant, require_account_id, require_incarnation,
    require_non_empty, required_option, AccountId, Incarnation, RuntimeError, SecretString,
    DOCUMENT_VERSION,
};
use crate::{server_contract::AuthVaultKeyResponse, wire::map_only_serde};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;
use zeroize::{Zeroize, ZeroizeOnDrop};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const ABSOLUTE_TIMESTAMP_THRESHOLD: u64 = 1_000_000_000_000;

#[derive(Clone, PartialEq, Zeroize, ZeroizeOnDrop)]
pub(crate) struct LegacySessionEvidenceMaterial {
    #[zeroize(skip)]
    pub(crate) source_session_instance: Option<String>,
    #[zeroize(skip)]
    pub(crate) created_at_ms: u64,
    #[zeroize(skip)]
    pub(crate) expires_at: Option<u64>,
    #[zeroize(skip)]
    pub(crate) server_expires_at: Option<u64>,
    #[zeroize(skip)]
    pub(crate) session_id: Option<String>,
    pub(crate) token: Option<SecretString>,
    #[zeroize(skip)]
    pub(crate) vault_keys: Option<Vec<AuthVaultKeyResponse>>,
    pub(crate) encrypted_private_key: Option<SecretString>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacySessionEvidenceDocument {
    #[zeroize(skip)]
    version: u32,
    #[zeroize(skip)]
    pub(crate) account_id: AccountId,
    #[zeroize(skip)]
    pub(crate) incarnation: Incarnation,
    #[zeroize(skip)]
    pub(crate) manifest_digest: String,
    #[zeroize(skip)]
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) source_session_instance: Option<String>,
    #[zeroize(skip)]
    pub(crate) created_at_ms: u64,
    #[zeroize(skip)]
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) expires_at: Option<u64>,
    #[zeroize(skip)]
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) server_expires_at: Option<u64>,
    #[zeroize(skip)]
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) session_id: Option<String>,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) token: Option<SecretString>,
    #[zeroize(skip)]
    #[serde(deserialize_with = "deserialize_optional_object_vec")]
    pub(crate) vault_keys: Option<Vec<AuthVaultKeyResponse>>,
    #[serde(deserialize_with = "required_option::deserialize")]
    pub(crate) encrypted_private_key: Option<SecretString>,
}

map_only_serde!(LegacySessionEvidenceDocument);

fn deserialize_optional_object_vec<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<AuthVaultKeyResponse>>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    struct OptionalObjects(
        #[serde(deserialize_with = "deserialize_object_vec")] Vec<AuthVaultKeyResponse>,
    );

    Option::<OptionalObjects>::deserialize(deserializer).map(|value| value.map(|value| value.0))
}

impl LegacySessionEvidenceDocument {
    pub(crate) fn new(
        account_id: AccountId,
        incarnation: Incarnation,
        manifest_digest: String,
        mut material: LegacySessionEvidenceMaterial,
    ) -> Result<Self, RuntimeError> {
        let document = Self {
            version: DOCUMENT_VERSION,
            account_id,
            incarnation,
            manifest_digest,
            source_session_instance: material.source_session_instance.take(),
            created_at_ms: material.created_at_ms,
            expires_at: material.expires_at,
            server_expires_at: material.server_expires_at,
            session_id: material.session_id.take(),
            token: material.token.take(),
            vault_keys: material.vault_keys.take(),
            encrypted_private_key: material.encrypted_private_key.take(),
        };
        document.validate()?;
        Ok(document)
    }

    pub(crate) fn has_fragments(&self) -> bool {
        self.token.is_some() || self.vault_keys.is_some() || self.encrypted_private_key.is_some()
    }

    pub(super) fn validate(&self) -> Result<(), RuntimeError> {
        super::require_version(self.version, "Legacy Session evidence")?;
        require_account_id(&self.account_id)?;
        require_incarnation(&self.incarnation)?;
        super::profile_admission::digest(&self.manifest_digest)?;
        if let Some(instance) = &self.source_session_instance {
            super::profile_admission::identity(instance)?;
        }
        validate_source_timestamp(self.created_at_ms, "created timestamp")?;
        validate_source_expiry(self.expires_at, self.created_at_ms, "expiry")?;
        validate_source_expiry(self.server_expires_at, self.created_at_ms, "server expiry")?;
        if let Some(token) = &self.token {
            require_non_empty(token, "Legacy Session evidence token")?;
        }
        if let Some(private_key) = &self.encrypted_private_key {
            require_non_empty(private_key, "Legacy Session evidence encrypted private key")?;
        }
        if let Some(vault_keys) = &self.vault_keys {
            validate_vault_keys(vault_keys)?;
        }
        if self.token.is_some() && self.vault_keys.is_some() && self.encrypted_private_key.is_some()
        {
            return Err(platform_storage_invariant(
                "complete Session authority cannot enter legacy evidence",
            ));
        }
        Ok(())
    }
}

fn validate_source_timestamp(value: u64, field: &str) -> Result<(), RuntimeError> {
    if value > MAX_SAFE_INTEGER {
        return Err(platform_storage_invariant(format!(
            "Legacy Session evidence {field} is malformed"
        )));
    }
    Ok(())
}

fn validate_source_expiry(
    value: Option<u64>,
    created_at_ms: u64,
    field: &str,
) -> Result<(), RuntimeError> {
    let Some(value) = value else {
        return Ok(());
    };
    let normalized = if value > ABSOLUTE_TIMESTAMP_THRESHOLD {
        Some(value)
    } else {
        created_at_ms.checked_add(value)
    };
    if normalized.is_none_or(|value| value > MAX_SAFE_INTEGER) {
        return Err(platform_storage_invariant(format!(
            "Legacy Session evidence {field} is malformed"
        )));
    }
    Ok(())
}

fn validate_vault_keys(vault_keys: &[AuthVaultKeyResponse]) -> Result<(), RuntimeError> {
    let mut vault_ids = HashSet::new();
    for vault_key in vault_keys {
        require_non_empty(
            &vault_key.vault_id,
            "Legacy Session evidence Vault identity",
        )?;
        require_non_empty(
            &vault_key.encrypted_vault_key,
            "Legacy Session evidence encrypted Vault key",
        )?;
        if !vault_ids.insert(vault_key.vault_id.as_str()) {
            return Err(platform_storage_invariant(
                "Legacy Session evidence contains a duplicate Vault key",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vault_key() -> AuthVaultKeyResponse {
        AuthVaultKeyResponse {
            encrypted_vault_key: "encrypted-vault-key".into(),
            role: crate::server_contract::VaultRole::Owner,
            vault_icon: None,
            vault_id: "vault".into(),
            vault_image_url: None,
            vault_name: "Personal".into(),
            vault_type: crate::server_contract::VaultType::Personal,
        }
    }

    fn material() -> LegacySessionEvidenceMaterial {
        LegacySessionEvidenceMaterial {
            source_session_instance: None,
            created_at_ms: 1_700_000_000_000,
            expires_at: Some(1_209_600_000),
            server_expires_at: None,
            session_id: Some(String::new()),
            token: Some("token".into()),
            vault_keys: None,
            encrypted_private_key: None,
        }
    }

    fn document(material: LegacySessionEvidenceMaterial) -> LegacySessionEvidenceDocument {
        LegacySessionEvidenceDocument::new(
            "account".into(),
            "incarnation".into(),
            "a".repeat(64),
            material,
        )
        .unwrap()
    }

    #[test]
    fn evidence_wire_is_flat_strict_and_requires_nullable_fields() {
        let encoded = serde_json::to_value(document(material())).unwrap();
        assert_eq!(encoded["version"], 1);
        assert_eq!(encoded["token"], "token");
        assert_eq!(encoded["serverExpiresAt"], json!(null));
        assert!(encoded.get("material").is_none());
        assert!(serde_json::from_value::<LegacySessionEvidenceDocument>(encoded.clone()).is_ok());

        for malformed in [
            {
                let mut value = encoded.clone();
                value
                    .as_object_mut()
                    .unwrap()
                    .remove("sourceSessionInstance");
                value
            },
            {
                let mut value = encoded.clone();
                value.as_object_mut().unwrap().remove("expiresAt");
                value
            },
            {
                let mut value = encoded.clone();
                value.as_object_mut().unwrap().remove("serverExpiresAt");
                value
            },
            {
                let mut value = encoded.clone();
                value.as_object_mut().unwrap().remove("sessionId");
                value
            },
            {
                let mut value = encoded.clone();
                value.as_object_mut().unwrap().remove("token");
                value
            },
            {
                let mut value = encoded.clone();
                value.as_object_mut().unwrap().remove("vaultKeys");
                value
            },
            {
                let mut value = encoded.clone();
                value.as_object_mut().unwrap().remove("encryptedPrivateKey");
                value
            },
            {
                let mut value = encoded;
                value["unexpected"] = json!(true);
                value
            },
        ] {
            assert!(serde_json::from_value::<LegacySessionEvidenceDocument>(malformed).is_err());
        }
    }

    #[test]
    fn evidence_rejects_positional_vault_keys_and_complete_authority() {
        let mut with_keys = material();
        with_keys.token = None;
        with_keys.vault_keys = Some(vec![vault_key()]);
        let encoded = serde_json::to_value(document(with_keys)).unwrap();
        let mut positional = encoded.clone();
        positional["vaultKeys"][0] = json!([
            "encrypted-vault-key",
            "owner",
            null,
            "vault",
            null,
            "Personal",
            "personal"
        ]);
        assert!(serde_json::from_value::<LegacySessionEvidenceDocument>(positional).is_err());

        let mut complete = material();
        complete.vault_keys = Some(vec![]);
        complete.encrypted_private_key = Some("private".into());
        assert!(LegacySessionEvidenceDocument::new(
            "account".into(),
            "incarnation".into(),
            "a".repeat(64),
            complete,
        )
        .is_err());

        let mut decoded: LegacySessionEvidenceDocument = serde_json::from_value(encoded).unwrap();
        decoded.token = Some("token".into());
        decoded.encrypted_private_key = Some("private".into());
        assert!(decoded.validate().is_err());
    }

    #[test]
    fn evidence_accepts_zero_to_two_fragments_and_bounds_source_timestamps() {
        for mask in 0..=6 {
            let mut value = material();
            value.token = (mask & 1 != 0).then(|| "token".into());
            value.vault_keys = (mask & 2 != 0).then(Vec::new);
            value.encrypted_private_key = (mask & 4 != 0).then(|| "private".into());
            let document = LegacySessionEvidenceDocument::new(
                "account".into(),
                "incarnation".into(),
                "a".repeat(64),
                value,
            )
            .unwrap();
            assert_eq!(document.has_fragments(), mask != 0);
        }

        for (created_at_ms, expires_at) in [
            (MAX_SAFE_INTEGER + 1, None),
            (MAX_SAFE_INTEGER, Some(1)),
            (1, Some(MAX_SAFE_INTEGER + 1)),
        ] {
            let mut value = material();
            value.created_at_ms = created_at_ms;
            value.expires_at = expires_at;
            assert!(LegacySessionEvidenceDocument::new(
                "account".into(),
                "incarnation".into(),
                "a".repeat(64),
                value,
            )
            .is_err());
        }
    }
}
