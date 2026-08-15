use serde::{Deserialize, Serialize};

/// What the platform can do, what the user has chosen, and whether the manifest
/// merge landed — three independent facts that look identical from the app until
/// a credential request arrives and nothing happens.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSupport {
    /// The device is API 34+, so `CredentialProviderService` exists at all.
    pub supported: bool,
    pub api_level: i32,
    /// The user picked Bittery as a credential provider in system settings.
    pub enabled: bool,
    /// The package manager can see the service, i.e. the plugin module's manifest
    /// reached the APK. False here means a build problem, not a settings problem.
    pub service_declared: bool,
    pub component: String,
    /// How `enabled` was decided, or why it could not be. Surfaced verbatim.
    pub detail: String,
}
