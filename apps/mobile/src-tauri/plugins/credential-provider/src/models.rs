use serde::{Deserialize, Serialize};

/// The plugin's one resolve shape.
///
/// A Tauri `@Command` answers with a JSON object, never a bare value, so every Kotlin
/// command in `CredentialProviderPlugin.kt` resolves exactly one key — `value` — holding
/// what the Expo method used to return. Unwrapping happens here rather than in the
/// TypeScript, so the guest sees a `boolean`, a `number`, a `string | null` or an array,
/// and `credential-provider.ts` can mirror the old interface without a translation step.
///
/// `is_supported` is the one command that does not use it: its answer is a record of five
/// independent fields with no single value to wrap.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wrapped<T> {
    pub value: T,
}

// ----------------------------------------------------------------------
// Arguments
//
// These are serialised to JSON and parsed by Jackson on the Kotlin side, so the field
// names are camelCase and every optional parameter is an `Option`. Timeouts are `f64`
// rather than `i64` because the Expo module took a `Double?` and JavaScript has one
// number type; narrowing here would reject a caller the old bridge accepted.
// ----------------------------------------------------------------------

/// The *server* user id, for queries against the Android Room cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserIdArgs {
    pub user_id: Option<String>,
}

/// The account id, which is what live unlock state on the Kotlin side is keyed by.
/// There is no fallback value: a blank id is rejected there.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdArgs {
    pub account_id: Option<String>,
}

/// The account id, required rather than optional.
///
/// Separate from [`AccountIdArgs`] because a command that answers "no live key" for a
/// *missing* id is indistinguishable from one that answers it for a locked vault, and
/// the caller would never learn it had asked the wrong question. `borrow_live_master_
/// unlock_key_base64` names its account or fails.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredAccountIdArgs {
    pub account_id: String,
}

/// No `#[derive(Debug)]`. This struct carries the master unlock key, and a derived
/// `Debug` would print it in full — one `tracing::error!("{args:?}")` away from the MUK
/// in logcat, where every app on the device could read it before API 16 and where a bug
/// report attaches it today. The hand-written impl below prints its length instead.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMasterUnlockKeyArgs {
    pub muk_base64: String,
    pub account_id: Option<String>,
    pub user_id: Option<String>,
    pub auto_lock_timeout_ms: Option<f64>,
}

impl std::fmt::Debug for SetMasterUnlockKeyArgs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SetMasterUnlockKeyArgs")
            .field(
                "muk_base64",
                &format_args!("<redacted, {} chars>", self.muk_base64.len()),
            )
            .field("account_id", &self.account_id)
            .field("user_id", &self.user_id)
            .field("auto_lock_timeout_ms", &self.auto_lock_timeout_ms)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMukAutoLockTimeoutArgs {
    pub timeout_ms: f64,
    pub account_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EscrowMukArgs {
    pub email: String,
    pub account_id: Option<String>,
    pub user_id: Option<String>,
    pub timeout_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailArgs {
    pub email: String,
}

/// Reason shown on the OS biometric sheet. Empty falls back on the Kotlin side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthenticateArgs {
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncVaultDataArgs {
    pub data_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdsArgs {
    pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdsWithErrorArgs {
    pub ids: Vec<String>,
    pub error: String,
}

// ----------------------------------------------------------------------
// Results
// ----------------------------------------------------------------------

/// What one `sync_vault_data` pass wrote.
///
/// `deleted_vault_keys` and `deleted_items` are carried across because the Kotlin
/// reports them and dropping a fact on the floor is worse than an unused field. The
/// TypeScript interface declares only the first three, matching the Expo module's
/// declared return type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncVaultDataResult {
    pub vault_keys: u32,
    pub items: u32,
    pub domains: u32,
    pub deleted_vault_keys: u32,
    pub deleted_items: u32,
}

/// A mutation the Android credential provider wrote locally and the sync layer still
/// owes the server. Field for field the Room entity, and field for field
/// `PendingPasskeyMutation` in the TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPasskeyMutation {
    pub id: String,
    pub user_id: String,
    pub vault_id: String,
    pub item_id: String,
    pub operation: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
    pub base_version: i64,
    pub encryption_version: i64,
    pub encrypted_by_user_id: String,
    pub created_at: i64,
    pub attempt_count: i64,
    #[serde(default)]
    pub last_error: Option<String>,
}

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
