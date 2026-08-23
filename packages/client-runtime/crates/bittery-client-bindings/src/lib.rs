//! Shallow projections of `bittery-client-core` for native UniFFI and Web WASM hosts.

use bittery_client_core as core;
use std::fmt;
use std::sync::Arc;

uniffi::setup_scaffolding!();

#[derive(uniffi::Object)]
pub struct SecretString {
    value: String,
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([redacted])")
    }
}

#[uniffi::export]
impl SecretString {
    #[uniffi::constructor]
    pub fn new(value: String) -> Arc<Self> {
        Arc::new(Self { value })
    }
}

#[derive(uniffi::Object)]
pub struct LoginCustomField {
    id: String,
    label: String,
    value: String,
    field_type: CustomFieldKind,
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

#[uniffi::export]
impl LoginCustomField {
    #[uniffi::constructor]
    pub fn new(id: String, label: String, value: String, field_type: CustomFieldKind) -> Arc<Self> {
        Arc::new(Self {
            id,
            label,
            value,
            field_type,
        })
    }

    pub fn id(&self) -> String {
        self.id.clone()
    }

    pub fn label(&self) -> String {
        self.label.clone()
    }

    pub fn value(&self) -> String {
        self.value.clone()
    }

    pub fn field_type(&self) -> CustomFieldKind {
        self.field_type
    }
}

impl LoginCustomField {
    fn to_core(&self) -> core::LoginCustomField {
        core::LoginCustomField {
            id: self.id.clone(),
            label: self.label.clone(),
            value: self.value.clone(),
            field_type: self.field_type.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum CustomFieldKind {
    Text,
    Password,
    Email,
    Url,
}

#[derive(uniffi::Object)]
pub struct LoginItemDraft {
    title: String,
    url: Option<String>,
    urls: Vec<String>,
    username: Option<String>,
    password: Option<String>,
    notes: Option<String>,
    note: Option<String>,
    custom_fields: Vec<Arc<LoginCustomField>>,
    tags: Vec<String>,
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

#[uniffi::export]
impl LoginItemDraft {
    #[uniffi::constructor]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        title: String,
        url: Option<String>,
        urls: Vec<String>,
        username: Option<String>,
        password: Option<String>,
        notes: Option<String>,
        note: Option<String>,
        custom_fields: Vec<Arc<LoginCustomField>>,
        tags: Vec<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            title,
            url,
            urls,
            username,
            password,
            notes,
            note,
            custom_fields,
            tags,
        })
    }
}

impl LoginItemDraft {
    fn to_core(&self) -> core::LoginItemDraft {
        core::LoginItemDraft {
            title: self.title.clone(),
            url: self.url.clone(),
            urls: self.urls.clone(),
            username: self.username.clone(),
            password: self.password.clone(),
            notes: self.notes.clone(),
            note: self.note.clone(),
            custom_fields: self
                .custom_fields
                .iter()
                .map(|field| field.to_core())
                .collect(),
            tags: self.tags.clone(),
        }
    }
}

#[derive(Clone, uniffi::Enum)]
pub enum RuntimeRequest {
    SignIn {
        server_url: String,
        email: String,
        master_password: Arc<SecretString>,
        secret_key: Arc<SecretString>,
        insecure_transport_confirmed: bool,
    },
    CreateLoginItem {
        account_id: String,
        vault_id: String,
        draft: Arc<LoginItemDraft>,
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

#[derive(Clone, Debug, uniffi::Enum)]
pub enum RuntimeResponse {
    SignedIn {
        account_id: String,
        user_id: String,
    },
    Accepted {
        operation_id: String,
        item_id: String,
        replica_revision: u64,
    },
}

#[derive(Clone, Debug, uniffi::Enum)]
pub enum ObservationRequest {
    Items { account_id: String },
    RuntimeStatus { account_id: Option<String> },
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum ItemProjectionStatus {
    Pending,
    Authoritative,
    Failed,
}

#[derive(uniffi::Object)]
pub struct LoginItemProjection {
    account_id: String,
    item_id: String,
    vault_id: String,
    title: String,
    url: Option<String>,
    urls: Vec<String>,
    username: Option<String>,
    password: Option<String>,
    notes: Option<String>,
    note: Option<String>,
    custom_fields: Vec<Arc<LoginCustomField>>,
    tags: Vec<String>,
    status: ItemProjectionStatus,
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

#[uniffi::export]
impl LoginItemProjection {
    pub fn account_id(&self) -> String {
        self.account_id.clone()
    }

    pub fn item_id(&self) -> String {
        self.item_id.clone()
    }

    pub fn vault_id(&self) -> String {
        self.vault_id.clone()
    }

    pub fn title(&self) -> String {
        self.title.clone()
    }

    pub fn url(&self) -> Option<String> {
        self.url.clone()
    }

    pub fn urls(&self) -> Vec<String> {
        self.urls.clone()
    }

    pub fn username(&self) -> Option<String> {
        self.username.clone()
    }

    pub fn password(&self) -> Option<String> {
        self.password.clone()
    }

    pub fn notes(&self) -> Option<String> {
        self.notes.clone()
    }

    pub fn note(&self) -> Option<String> {
        self.note.clone()
    }

    pub fn custom_fields(&self) -> Vec<Arc<LoginCustomField>> {
        self.custom_fields.clone()
    }

    pub fn tags(&self) -> Vec<String> {
        self.tags.clone()
    }

    pub fn status(&self) -> ItemProjectionStatus {
        self.status
    }
}

#[derive(Clone, uniffi::Record)]
pub struct ItemsProjection {
    pub account_id: String,
    pub replica_revision: u64,
    pub items: Vec<Arc<LoginItemProjection>>,
}

impl fmt::Debug for ItemsProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ItemsProjection")
            .field("account_id", &self.account_id)
            .field("replica_revision", &self.replica_revision)
            .field("item_count", &self.items.len())
            .finish()
    }
}

#[derive(Clone, Copy, Debug, uniffi::Enum)]
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

#[derive(Clone, Copy, Debug, uniffi::Enum)]
pub enum AccountAccessState {
    SignedOut,
    Locked,
    Unlocked,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct AccountStatus {
    pub account_id: String,
    pub replica_revision: u64,
    pub access: AccountAccessState,
    pub failure: Option<RuntimeErrorCode>,
}

#[derive(Clone, Debug, uniffi::Record)]
pub struct RuntimeStatusProjection {
    pub account_id: Option<String>,
    pub revision: u64,
    pub accounts: Vec<AccountStatus>,
    pub closed: bool,
}

#[derive(Clone, uniffi::Enum)]
pub enum RuntimeProjection {
    Items { value: ItemsProjection },
    RuntimeStatus { value: RuntimeStatusProjection },
}

impl fmt::Debug for RuntimeProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Items { value } => formatter.debug_tuple("Items").field(value).finish(),
            Self::RuntimeStatus { value } => {
                formatter.debug_tuple("RuntimeStatus").field(value).finish()
            }
        }
    }
}

#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum BindingError {
    #[error("Runtime request failed: {message}")]
    Runtime {
        code: RuntimeErrorCode,
        message: String,
    },
}

#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export(with_foreign)]
pub trait ObservationSink: Send + Sync {
    fn publish(&self, projection: RuntimeProjection);
}

#[cfg(not(target_arch = "wasm32"))]
struct NativeSink(Arc<dyn ObservationSink>);

#[cfg(not(target_arch = "wasm32"))]
impl core::ObservationSink for NativeSink {
    fn publish(&self, projection: core::RuntimeProjection) {
        self.0.publish(projection.into());
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(uniffi::Object)]
pub struct ClientRuntime {
    inner: Arc<core::Runtime>,
}

#[cfg(not(target_arch = "wasm32"))]
impl ClientRuntime {
    fn headless() -> Arc<Self> {
        Arc::new(Self {
            inner: core::Runtime::new(),
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export(async_runtime = "tokio")]
impl ClientRuntime {
    #[uniffi::constructor]
    pub fn new() -> Arc<Self> {
        Self::headless()
    }

    pub async fn request(&self, request: RuntimeRequest) -> Result<RuntimeResponse, BindingError> {
        self.inner
            .request(request.into(), core::RequestCancellation::new())
            .await
            .map(Into::into)
            .map_err(Into::into)
    }

    pub fn observe(
        self: &Arc<Self>,
        request: ObservationRequest,
        sink: Arc<dyn ObservationSink>,
    ) -> Result<Arc<ObservationHandle>, BindingError> {
        self.inner
            .observe(request.into(), Arc::new(NativeSink(sink)))
            .map(|inner| Arc::new(ObservationHandle { inner }))
            .map_err(Into::into)
    }

    // UniFFI's Kotlin object wrapper reserves `close()` for synchronous handle disposal. The native
    // facade projects this transport name back to the Runtime protocol's asynchronous `close()`.
    pub async fn shutdown(&self) {
        self.inner.close().await;
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(uniffi::Object)]
pub struct ObservationHandle {
    inner: Arc<core::ObservationHandle>,
}

#[cfg(not(target_arch = "wasm32"))]
#[uniffi::export]
impl ObservationHandle {
    pub fn close(&self) {
        self.inner.close();
    }
}

impl From<RuntimeRequest> for core::RuntimeRequest {
    fn from(value: RuntimeRequest) -> Self {
        match value {
            RuntimeRequest::SignIn {
                server_url,
                email,
                master_password,
                secret_key,
                insecure_transport_confirmed,
            } => Self::SignIn {
                server_url,
                email,
                master_password: master_password.value.clone(),
                secret_key: secret_key.value.clone(),
                insecure_transport_confirmed,
            },
            RuntimeRequest::CreateLoginItem {
                account_id,
                vault_id,
                draft,
            } => Self::CreateLoginItem {
                account_id: account_id.into(),
                vault_id,
                draft: draft.to_core(),
            },
        }
    }
}

impl From<CustomFieldKind> for core::CustomFieldKind {
    fn from(value: CustomFieldKind) -> Self {
        match value {
            CustomFieldKind::Text => Self::Text,
            CustomFieldKind::Password => Self::Password,
            CustomFieldKind::Email => Self::Email,
            CustomFieldKind::Url => Self::Url,
        }
    }
}

impl From<ObservationRequest> for core::ObservationRequest {
    fn from(value: ObservationRequest) -> Self {
        match value {
            ObservationRequest::Items { account_id } => Self::Items {
                account_id: account_id.into(),
            },
            ObservationRequest::RuntimeStatus { account_id } => Self::RuntimeStatus {
                account_id: account_id.map(Into::into),
            },
        }
    }
}

impl From<core::RuntimeResponse> for RuntimeResponse {
    fn from(value: core::RuntimeResponse) -> Self {
        match value {
            core::RuntimeResponse::SignedIn {
                account_id,
                user_id,
            } => Self::SignedIn {
                account_id: account_id.into(),
                user_id,
            },
            core::RuntimeResponse::Accepted {
                operation_id,
                item_id,
                replica_revision,
            } => Self::Accepted {
                operation_id,
                item_id,
                replica_revision,
            },
        }
    }
}

impl From<core::RuntimeProjection> for RuntimeProjection {
    fn from(value: core::RuntimeProjection) -> Self {
        match value {
            core::RuntimeProjection::Items(value) => Self::Items {
                value: value.into(),
            },
            core::RuntimeProjection::RuntimeStatus(value) => Self::RuntimeStatus {
                value: value.into(),
            },
        }
    }
}

impl From<core::ItemsProjection> for ItemsProjection {
    fn from(value: core::ItemsProjection) -> Self {
        let core::ItemsProjection {
            account_id,
            replica_revision,
            items,
        } = value;
        Self {
            account_id: account_id.into(),
            replica_revision,
            items: items
                .into_iter()
                .map(|item| Arc::new(LoginItemProjection::from(item)))
                .collect(),
        }
    }
}

impl From<core::LoginItemProjection> for LoginItemProjection {
    fn from(value: core::LoginItemProjection) -> Self {
        let core::LoginItemProjection {
            account_id,
            item_id,
            vault_id,
            title,
            url,
            urls,
            username,
            password,
            notes,
            note,
            custom_fields,
            tags,
            status,
        } = value;
        Self {
            account_id: account_id.into(),
            item_id,
            vault_id,
            title,
            url,
            urls,
            username,
            password,
            notes,
            note,
            custom_fields: custom_fields
                .into_iter()
                .map(|field| Arc::new(LoginCustomField::from(field)))
                .collect(),
            tags,
            status: status.into(),
        }
    }
}

impl From<core::LoginCustomField> for LoginCustomField {
    fn from(value: core::LoginCustomField) -> Self {
        let core::LoginCustomField {
            id,
            label,
            value,
            field_type,
        } = value;
        Self {
            id,
            label,
            value,
            field_type: field_type.into(),
        }
    }
}

impl From<core::CustomFieldKind> for CustomFieldKind {
    fn from(value: core::CustomFieldKind) -> Self {
        match value {
            core::CustomFieldKind::Text => Self::Text,
            core::CustomFieldKind::Password => Self::Password,
            core::CustomFieldKind::Email => Self::Email,
            core::CustomFieldKind::Url => Self::Url,
        }
    }
}

impl From<core::ItemProjectionStatus> for ItemProjectionStatus {
    fn from(value: core::ItemProjectionStatus) -> Self {
        match value {
            core::ItemProjectionStatus::Pending => Self::Pending,
            core::ItemProjectionStatus::Authoritative => Self::Authoritative,
            core::ItemProjectionStatus::Failed => Self::Failed,
        }
    }
}

impl From<core::RuntimeStatusProjection> for RuntimeStatusProjection {
    fn from(value: core::RuntimeStatusProjection) -> Self {
        let core::RuntimeStatusProjection {
            account_id,
            revision,
            accounts,
            closed,
        } = value;
        Self {
            account_id: account_id.map(Into::into),
            revision,
            accounts: accounts.into_iter().map(Into::into).collect(),
            closed,
        }
    }
}

impl From<core::AccountStatus> for AccountStatus {
    fn from(value: core::AccountStatus) -> Self {
        let core::AccountStatus {
            account_id,
            replica_revision,
            access,
            failure,
        } = value;
        Self {
            account_id: account_id.into(),
            replica_revision,
            access: access.into(),
            failure: failure.map(Into::into),
        }
    }
}

impl From<core::AccountAccessState> for AccountAccessState {
    fn from(value: core::AccountAccessState) -> Self {
        match value {
            core::AccountAccessState::SignedOut => Self::SignedOut,
            core::AccountAccessState::Locked => Self::Locked,
            core::AccountAccessState::Unlocked => Self::Unlocked,
        }
    }
}

impl From<core::RuntimeErrorCode> for RuntimeErrorCode {
    fn from(value: core::RuntimeErrorCode) -> Self {
        match value {
            core::RuntimeErrorCode::RuntimeClosed => Self::RuntimeClosed,
            core::RuntimeErrorCode::Cancelled => Self::Cancelled,
            core::RuntimeErrorCode::AccountMissing => Self::AccountMissing,
            core::RuntimeErrorCode::AccountAlreadyInstalled => Self::AccountAlreadyInstalled,
            core::RuntimeErrorCode::AccountFailed => Self::AccountFailed,
            core::RuntimeErrorCode::AuthenticationRequired => Self::AuthenticationRequired,
            core::RuntimeErrorCode::AuthenticationUnavailable => Self::AuthenticationUnavailable,
            core::RuntimeErrorCode::InvariantViolation => Self::InvariantViolation,
        }
    }
}

impl From<core::RuntimeError> for BindingError {
    fn from(value: core::RuntimeError) -> Self {
        Self::Runtime {
            code: value.code.into(),
            message: value.message,
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod web;
#[cfg(target_arch = "wasm32")]
pub use web::WebClientRuntime;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_debug_output_redacts_every_plaintext_and_credential_field() {
        let sign_in = RuntimeRequest::SignIn {
            server_url: "https://server.test".into(),
            email: "person@example.test".into(),
            master_password: SecretString::new("UNIQUE_MASTER_PASSWORD".into()),
            secret_key: SecretString::new("UNIQUE_SECRET_KEY".into()),
            insecure_transport_confirmed: false,
        };
        let create = RuntimeRequest::CreateLoginItem {
            account_id: "account-1".into(),
            vault_id: "vault-1".into(),
            draft: LoginItemDraft::new(
                "UNIQUE_TITLE".into(),
                Some("UNIQUE_URL".into()),
                vec!["UNIQUE_URLS".into()],
                Some("UNIQUE_USERNAME".into()),
                Some("UNIQUE_PASSWORD".into()),
                Some("UNIQUE_NOTES".into()),
                Some("UNIQUE_NOTE".into()),
                vec![LoginCustomField::new(
                    "UNIQUE_FIELD_ID".into(),
                    "UNIQUE_FIELD_LABEL".into(),
                    "UNIQUE_FIELD_VALUE".into(),
                    CustomFieldKind::Password,
                )],
                vec!["UNIQUE_TAG".into()],
            ),
        };
        let projection = RuntimeProjection::Items {
            value: ItemsProjection {
                account_id: "account-1".into(),
                replica_revision: 1,
                items: vec![Arc::new(LoginItemProjection {
                    account_id: "account-1".into(),
                    item_id: "item-1".into(),
                    vault_id: "vault-1".into(),
                    title: "UNIQUE_PROJECTION_TITLE".into(),
                    url: Some("UNIQUE_PROJECTION_URL".into()),
                    urls: vec!["UNIQUE_PROJECTION_URLS".into()],
                    username: Some("UNIQUE_PROJECTION_USERNAME".into()),
                    password: Some("UNIQUE_PROJECTION_PASSWORD".into()),
                    notes: Some("UNIQUE_PROJECTION_NOTES".into()),
                    note: Some("UNIQUE_PROJECTION_NOTE".into()),
                    custom_fields: vec![],
                    tags: vec![],
                    status: ItemProjectionStatus::Pending,
                })],
            },
        };

        let output = format!("{sign_in:?} {create:?} {projection:?}");
        for marker in [
            "UNIQUE_MASTER_PASSWORD",
            "UNIQUE_SECRET_KEY",
            "UNIQUE_TITLE",
            "UNIQUE_URL",
            "UNIQUE_URLS",
            "UNIQUE_USERNAME",
            "UNIQUE_PASSWORD",
            "UNIQUE_NOTES",
            "UNIQUE_NOTE",
            "UNIQUE_FIELD_ID",
            "UNIQUE_FIELD_LABEL",
            "UNIQUE_FIELD_VALUE",
            "UNIQUE_TAG",
            "UNIQUE_PROJECTION_TITLE",
            "UNIQUE_PROJECTION_URL",
            "UNIQUE_PROJECTION_URLS",
            "UNIQUE_PROJECTION_USERNAME",
            "UNIQUE_PROJECTION_PASSWORD",
            "UNIQUE_PROJECTION_NOTES",
            "UNIQUE_PROJECTION_NOTE",
        ] {
            assert!(!output.contains(marker), "debug output leaked {marker}");
        }
    }
}
