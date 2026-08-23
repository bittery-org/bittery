use crate::wire::decimal_u64;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::watch;

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

string_id!(AccountId);
string_id!(Incarnation);

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeRequest {
    SignIn {
        server_url: String,
        email: String,
        master_password: String,
        secret_key: String,
        insecure_transport_confirmed: bool,
    },
    QuickUnlock {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        master_password: String,
    },
    /// Retires this Account's live keys and plaintext delivery while the Device keeps the
    /// material one master password reopens.
    Lock {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    /// Ends local ownership: the same retirement as `Lock`, and the Device forgets the
    /// Quick Unlock material and Session, so this Account needs a full Sign-in again.
    SignOut {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    CreateLoginItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        vault_id: String,
        draft: LoginItemDraft,
    },
}

impl fmt::Debug for RuntimeRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SignIn {
                server_url, email, ..
            } => formatter
                .debug_struct("SignIn")
                .field("server_url", server_url)
                .field("email", email)
                .field("credentials", &"[redacted]")
                .finish(),
            Self::QuickUnlock { account_id, .. } => formatter
                .debug_struct("QuickUnlock")
                .field("account_id", account_id)
                .field("credentials", &"[redacted]")
                .finish(),
            Self::Lock { account_id } => formatter
                .debug_struct("Lock")
                .field("account_id", account_id)
                .finish(),
            Self::SignOut { account_id } => formatter
                .debug_struct("SignOut")
                .field("account_id", account_id)
                .finish(),
            Self::CreateLoginItem {
                account_id,
                vault_id,
                draft,
            } => formatter
                .debug_struct("CreateLoginItem")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .field("draft", draft)
                .finish(),
        }
    }
}

impl RuntimeRequest {
    pub fn account_id(&self) -> Option<&AccountId> {
        match self {
            Self::SignIn { .. } => None,
            Self::QuickUnlock { account_id, .. } => Some(account_id),
            Self::Lock { account_id } | Self::SignOut { account_id } => Some(account_id),
            Self::CreateLoginItem { account_id, .. } => Some(account_id),
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct LoginItemDraft {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<LoginCustomField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

impl fmt::Debug for LoginItemDraft {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LoginItemDraft")
            .field("plaintext", &"[redacted]")
            .field("custom_field_count", &self.custom_fields.len())
            .field("tag_count", &self.tags.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct LoginCustomField {
    pub id: String,
    pub label: String,
    pub value: String,
    #[serde(rename = "type")]
    pub field_type: CustomFieldKind,
}

impl fmt::Debug for LoginCustomField {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LoginCustomField")
            .field("plaintext", &"[redacted]")
            .field("field_type", &self.field_type)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum CustomFieldKind {
    Text,
    Password,
    Email,
    Url,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeResponse {
    SignedIn {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        user_id: String,
    },
    /// The Account access state this Device holds after a `Lock` or `SignOut`. An Account this
    /// Device does not have answers `SignedOut`, because that is what it is.
    AccessChanged {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        access: AccountAccessState,
    },
    Accepted {
        operation_id: String,
        item_id: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
}

/// The declared envelope every external Runtime request answers with.
///
/// Serde would otherwise emit its externally tagged `Result` spelling, an implicit wire shape no
/// contract describes. This adjacent tagging matches `RuntimeProjection`, and it keeps the
/// success payload intact: `RuntimeResponse` is itself internally tagged on `type`, so an
/// internally tagged envelope would collide with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum RuntimeOutcome {
    Succeeded(RuntimeResponse),
    Failed(RuntimeError),
}

impl From<Result<RuntimeResponse, RuntimeError>> for RuntimeOutcome {
    fn from(value: Result<RuntimeResponse, RuntimeError>) -> Self {
        match value {
            Ok(response) => Self::Succeeded(response),
            Err(error) => Self::Failed(error),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ObservationRequest {
    Items {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
    },
    RuntimeStatus {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "Option<String>")
        )]
        account_id: Option<AccountId>,
    },
}

impl ObservationRequest {
    pub fn account_id(&self) -> Option<&AccountId> {
        match self {
            Self::Items { account_id } => Some(account_id),
            Self::RuntimeStatus { account_id } => account_id.as_ref(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum RuntimeProjection {
    Items(ItemsProjection),
    RuntimeStatus(RuntimeStatusProjection),
}

impl RuntimeProjection {
    pub fn revision(&self) -> u64 {
        match self {
            Self::Items(value) => value.replica_revision,
            Self::RuntimeStatus(value) => value.revision,
        }
    }

    pub fn item_count(&self) -> usize {
        match self {
            Self::Items(value) => value.items.len(),
            Self::RuntimeStatus(_) => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct ItemsProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub replica_revision: u64,
    pub items: Vec<LoginItemProjection>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct LoginItemProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    pub item_id: String,
    pub vault_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<LoginCustomField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    pub favorite: bool,
    pub created_at: String,
    pub updated_at: String,
    pub status: ItemProjectionStatus,
}

impl fmt::Debug for LoginItemProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LoginItemProjection")
            .field("account_id", &self.account_id)
            .field("item_id", &self.item_id)
            .field("vault_id", &self.vault_id)
            .field("plaintext", &"[redacted]")
            .field("status", &self.status)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum ItemProjectionStatus {
    Pending,
    Authoritative,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "Option<String>")
    )]
    pub account_id: Option<AccountId>,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub revision: u64,
    pub accounts: Vec<AccountStatus>,
    pub closed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    #[serde(with = "decimal_u64")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "decimal_u64::json_schema")
    )]
    pub replica_revision: u64,
    pub access: AccountAccessState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_reason: Option<AccountWaitingReason>,
    pub failure: Option<RuntimeErrorCode>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum AccountWaitingReason {
    ReauthenticationRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum AccountAccessState {
    SignedOut,
    Locked,
    Unlocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    any(
        feature = "persistence-contract-schema",
        feature = "runtime-protocol-contract-schema"
    ),
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuntimeErrorCode {
    RuntimeClosed,
    Cancelled,
    AccountMissing,
    AccountAlreadyInstalled,
    AccountFailed,
    AuthenticationRequired,
    AuthenticationUnavailable,
    InvariantViolation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[error("{code:?}: {message}")]
pub struct RuntimeError {
    pub code: RuntimeErrorCode,
    pub message: String,
}

impl RuntimeError {
    pub(crate) fn new(code: RuntimeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[cfg(feature = "runtime-protocol-contract-schema")]
#[derive(schemars::JsonSchema)]
#[allow(dead_code)]
struct RuntimeProtocolContract {
    request: RuntimeRequest,
    outcome: RuntimeOutcome,
    observation: ObservationRequest,
    projection: RuntimeProjection,
}

#[cfg(feature = "runtime-protocol-contract-schema")]
#[doc(hidden)]
pub fn runtime_protocol_contract_schema() -> schemars::Schema {
    let mut settings = schemars::generate::SchemaSettings::draft2020_12();
    settings.contract = schemars::generate::Contract::Serialize;
    settings
        .into_generator()
        .into_root_schema_for::<RuntimeProtocolContract>()
}

pub trait ObservationSink: Send + Sync + 'static {
    fn publish(&self, projection: RuntimeProjection);
}

struct CancellationState {
    cancelled: AtomicBool,
    changed: watch::Sender<bool>,
}

#[derive(Clone)]
pub struct RequestCancellation(Arc<CancellationState>);

impl Default for RequestCancellation {
    fn default() -> Self {
        let (changed, _) = watch::channel(false);
        Self(Arc::new(CancellationState {
            cancelled: AtomicBool::new(false),
            changed,
        }))
    }
}

impl RequestCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        if !self.0.cancelled.swap(true, Ordering::SeqCst) {
            self.0.changed.send_replace(true);
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::SeqCst)
    }

    pub(crate) async fn cancelled(&self) {
        let mut changed = self.0.changed.subscribe();
        while !*changed.borrow_and_update() {
            if changed.changed().await.is_err() {
                return;
            }
        }
    }
}
