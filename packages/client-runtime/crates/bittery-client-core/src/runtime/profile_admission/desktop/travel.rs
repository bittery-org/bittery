//! Legacy policy has Server timestamps but no local verification receipt.
use super::{invalid, json, present, MAX_SAFE_INTEGER};
use crate::{platform_storage::VerifiedTravelModePolicy, RuntimeError};
use serde::Deserialize;

#[derive(serde::Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
struct LegacyTravelPolicy {
    enabled: bool,
    hidden_vault_ids: Vec<String>,
    enabled_at: Option<u64>,
    #[serde(default, deserialize_with = "present")]
    updated_at: Option<u64>,
}
crate::wire::map_only_serde!(LegacyTravelPolicy);

pub(super) fn decode(value: &str) -> Result<VerifiedTravelModePolicy, RuntimeError> {
    let source: LegacyTravelPolicy = json(value, "Legacy Desktop Travel policy is malformed")?;
    if [source.enabled_at, source.updated_at]
        .into_iter()
        .flatten()
        .any(|value| value > MAX_SAFE_INTEGER)
    {
        return Err(invalid("Legacy Desktop Travel timestamp is malformed"));
    }
    let policy = VerifiedTravelModePolicy {
        enabled: source.enabled,
        hidden_vault_ids: source.hidden_vault_ids,
        server_enabled_at_ms: source.enabled_at,
        server_updated_at_ms: source.updated_at,
        verified_at_ms: None,
    };
    policy.validate()?;
    Ok(policy)
}
