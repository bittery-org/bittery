use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetArgs {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyArgs {
    pub key: String,
}

/// A read. `value` is `None` for a key that was never written **and** for one whose
/// ciphertext can no longer be decrypted, because those are the same fact to every
/// caller: the value is gone. See `KeystorePlugin.kt` on key invalidation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretValue {
    #[serde(default)]
    pub value: Option<String>,
}

/// The probe the storage adapter calls once, in `initialize()`.
///
/// `backing` is surfaced verbatim through `PlatformPort.secretBacking`, which is the
/// security-review answer to "is `vault_keys` hardware-backed on Android?". It must
/// describe what was actually observed at runtime, never what was hoped for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretAvailability {
    pub available: bool,
    pub backing: String,
}
