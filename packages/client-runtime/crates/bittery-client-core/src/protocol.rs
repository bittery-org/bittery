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
    CreateLoginItem {
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
            Self::CreateLoginItem { account_id, .. } => Some(account_id),
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
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
#[serde(rename_all = "camelCase")]
pub enum CustomFieldKind {
    Text,
    Password,
    Email,
    Url,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeResponse {
    SignedIn {
        account_id: AccountId,
        user_id: String,
    },
    Accepted {
        operation_id: String,
        item_id: String,
        replica_revision: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ObservationRequest {
    Items { account_id: AccountId },
    RuntimeStatus { account_id: Option<AccountId> },
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
#[serde(rename_all = "camelCase")]
pub struct ItemsProjection {
    pub account_id: AccountId,
    pub replica_revision: u64,
    pub items: Vec<LoginItemProjection>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginItemProjection {
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
#[serde(rename_all = "camelCase")]
pub enum ItemProjectionStatus {
    Pending,
    Authoritative,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusProjection {
    pub account_id: Option<AccountId>,
    pub revision: u64,
    pub accounts: Vec<AccountStatus>,
    pub closed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub account_id: AccountId,
    pub replica_revision: u64,
    pub access: AccountAccessState,
    pub failure: Option<RuntimeErrorCode>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountAccessState {
    SignedOut,
    Locked,
    Unlocked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
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
