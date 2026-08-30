use crate::wire::decimal_u64;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::watch;
use zeroize::{Zeroize, ZeroizeOnDrop};

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
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
    rename_all_fields = "camelCase",
    deny_unknown_fields
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
    /// Irreversibly removes exactly the explicitly named Account from this Device.
    RemoveAccount {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String", regex(pattern = "^[\\s\\S]+$"))
        )]
        account_id: AccountId,
    },
    /// Uses this installed Account's Runtime-owned Session to request authoritative Server
    /// deletion. The host retains the exact request identity until the workflow is closed.
    DeleteServerAccount {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String", regex(pattern = "^[\\s\\S]+$"))
        )]
        account_id: AccountId,
        confirm_email: String,
        request_id: String,
    },
    /// Irreversibly removes every Runtime-owned Account and Device record.
    Wipe,
    CreateItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        vault_id: String,
        draft: ItemDraft,
    },
    UpdateItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        draft: ItemDraft,
    },
    SetItemFavorite {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        favorite: bool,
    },
    TrashItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
    },
    RestoreItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
    },
    MoveItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        target_vault_id: String,
    },
    PermanentlyDeleteItem {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
    },
    CreateShare {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        draft: CreateShareDraft,
    },
    AcknowledgeShareResult {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        operation_id: String,
    },
    RenameAttachment {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
        name: String,
    },
    DeleteAttachment {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
    },
    DownloadAttachment {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._~-]+$"))
        )]
        sink_capability_id: String,
    },
    UploadAttachment {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        item_id: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(min = 1, max = 255))
        )]
        name: String,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(min = 1, max = 255))
        )]
        content_type: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        file_size: u64,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(min = 1, max = 128), regex(pattern = "^[A-Za-z0-9._~-]+$"))
        )]
        source_capability_id: String,
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
            Self::RemoveAccount { .. } => formatter.write_str("RemoveAccount([redacted scope])"),
            Self::DeleteServerAccount { .. } => {
                formatter.write_str("DeleteServerAccount([redacted scope and confirmation])")
            }
            Self::Wipe => formatter.write_str("Wipe"),
            Self::CreateItem {
                account_id,
                vault_id,
                draft,
            } => formatter
                .debug_struct("CreateItem")
                .field("account_id", account_id)
                .field("vault_id", vault_id)
                .field("draft", draft)
                .finish(),
            Self::UpdateItem {
                account_id,
                item_id,
                draft,
            } => formatter
                .debug_struct("UpdateItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("draft", draft)
                .finish(),
            Self::SetItemFavorite {
                account_id,
                item_id,
                favorite,
            } => formatter
                .debug_struct("SetItemFavorite")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("favorite", favorite)
                .finish(),
            Self::TrashItem {
                account_id,
                item_id,
            } => formatter
                .debug_struct("TrashItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::RestoreItem {
                account_id,
                item_id,
            } => formatter
                .debug_struct("RestoreItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::MoveItem {
                account_id,
                item_id,
                target_vault_id,
            } => formatter
                .debug_struct("MoveItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("target_vault_id", target_vault_id)
                .finish(),
            Self::PermanentlyDeleteItem {
                account_id,
                item_id,
            } => formatter
                .debug_struct("PermanentlyDeleteItem")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .finish(),
            Self::CreateShare {
                account_id,
                item_id,
                draft,
            } => formatter
                .debug_struct("CreateShare")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("draft", draft)
                .finish(),
            Self::AcknowledgeShareResult {
                account_id,
                operation_id,
            } => formatter
                .debug_struct("AcknowledgeShareResult")
                .field("account_id", account_id)
                .field("operation_id", operation_id)
                .finish(),
            Self::RenameAttachment {
                account_id,
                attachment_id,
                ..
            } => formatter
                .debug_struct("RenameAttachment")
                .field("account_id", account_id)
                .field("attachment_id", attachment_id)
                .field("plaintext", &"[redacted]")
                .finish(),
            Self::DeleteAttachment {
                account_id,
                attachment_id,
            } => formatter
                .debug_struct("DeleteAttachment")
                .field("account_id", account_id)
                .field("attachment_id", attachment_id)
                .finish(),
            Self::DownloadAttachment {
                account_id,
                attachment_id,
                ..
            } => formatter
                .debug_struct("DownloadAttachment")
                .field("account_id", account_id)
                .field("attachment_id", attachment_id)
                .field("sink_capability", &"[redacted]")
                .finish(),
            Self::UploadAttachment {
                account_id,
                item_id,
                file_size,
                ..
            } => formatter
                .debug_struct("UploadAttachment")
                .field("account_id", account_id)
                .field("item_id", item_id)
                .field("file_size", file_size)
                .field("plaintext_and_source_capability", &"[redacted]")
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
            Self::RemoveAccount { account_id } => Some(account_id),
            Self::DeleteServerAccount { account_id, .. } => Some(account_id),
            Self::Wipe => None,
            Self::CreateItem { account_id, .. }
            | Self::UpdateItem { account_id, .. }
            | Self::SetItemFavorite { account_id, .. }
            | Self::TrashItem { account_id, .. }
            | Self::RestoreItem { account_id, .. }
            | Self::MoveItem { account_id, .. }
            | Self::PermanentlyDeleteItem { account_id, .. }
            | Self::CreateShare { account_id, .. }
            | Self::AcknowledgeShareResult { account_id, .. }
            | Self::RenameAttachment { account_id, .. }
            | Self::DeleteAttachment { account_id, .. }
            | Self::DownloadAttachment { account_id, .. }
            | Self::UploadAttachment { account_id, .. } => Some(account_id),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareDraft {
    pub access_mode: ShareAccessMode,
    pub expires_in: ShareExpiration,
    #[serde(default)]
    pub is_one_time_use: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_emails: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "kebab-case")]
pub enum ShareAccessMode {
    Anyone,
    EmailRestricted,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
pub enum ShareExpiration {
    #[serde(rename = "1hour")]
    OneHour,
    #[serde(rename = "1day")]
    OneDay,
    #[serde(rename = "7days")]
    SevenDays,
    #[serde(rename = "14days")]
    FourteenDays,
    #[serde(rename = "30days")]
    ThirtyDays,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoginItemData {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub password_history: Vec<PasswordHistoryEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub passkeys: Vec<Passkey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_algorithm: Option<TotpAlgorithm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_digits: Option<TotpDigits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub totp_period: Option<u32>,
}

impl fmt::Debug for LoginItemData {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LoginItemData")
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
#[serde(tag = "category", content = "data", deny_unknown_fields)]
pub enum ItemDraft {
    #[serde(rename = "login")]
    Login(LoginItemData),
    #[serde(rename = "secure-note")]
    SecureNote(SecureNoteItemData),
    #[serde(rename = "credit-card")]
    CreditCard(CreditCardItemData),
    #[serde(rename = "identity")]
    Identity(IdentityItemData),
    #[serde(rename = "authenticator")]
    Authenticator(AuthenticatorItemData),
}

impl fmt::Debug for ItemDraft {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ItemDraft")
            .field("category", &self.category())
            .field("plaintext", &"[redacted]")
            .finish()
    }
}

impl ItemDraft {
    pub fn category(&self) -> ItemCategory {
        match self {
            Self::Login(_) => ItemCategory::Login,
            Self::SecureNote(_) => ItemCategory::SecureNote,
            Self::CreditCard(_) => ItemCategory::CreditCard,
            Self::Identity(_) => ItemCategory::Identity,
            Self::Authenticator(_) => ItemCategory::Authenticator,
        }
    }

    pub fn title(&self) -> &str {
        match self {
            Self::Login(value) => &value.title,
            Self::SecureNote(value) => &value.title,
            Self::CreditCard(value) => &value.title,
            Self::Identity(value) => &value.title,
            Self::Authenticator(value) => &value.title,
        }
    }

    pub fn password(&self) -> Option<&str> {
        match self {
            Self::Login(value) => value.password.as_deref(),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "kebab-case")]
pub enum ItemCategory {
    Login,
    SecureNote,
    CreditCard,
    Identity,
    Authenticator,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordHistoryEntry {
    pub password: String,
    pub changed_at: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Passkey {
    pub credential_id: String,
    pub rp_id: String,
    pub rp_name: String,
    pub user_handle: String,
    pub user_name: String,
    pub user_display_name: String,
    pub private_key: String,
    pub public_key: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_i32_schema")
    )]
    pub algorithm: i32,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_u32_schema")
    )]
    pub sign_count: u32,
    pub transports: Vec<String>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<PasskeyStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<PasskeyStatusReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_updated_at: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "kebab-case")]
pub enum PasskeyStatus {
    Active,
    Suspect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "kebab-case")]
pub enum PasskeyStatusReason {
    Manual,
    UnknownCredential,
    SigningError,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
pub enum TotpAlgorithm {
    #[serde(rename = "SHA1")]
    Sha1,
    #[serde(rename = "SHA256")]
    Sha256,
    #[serde(rename = "SHA512")]
    Sha512,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TotpDigits {
    Six,
    Seven,
    Eight,
}

impl Serialize for TotpDigits {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(match self {
            Self::Six => 6,
            Self::Seven => 7,
            Self::Eight => 8,
        })
    }
}

impl<'de> Deserialize<'de> for TotpDigits {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match u8::deserialize(deserializer)? {
            6 => Ok(Self::Six),
            7 => Ok(Self::Seven),
            8 => Ok(Self::Eight),
            _ => Err(serde::de::Error::custom("TOTP digits must be 6, 7, or 8")),
        }
    }
}

#[cfg(feature = "runtime-protocol-contract-schema")]
impl schemars::JsonSchema for TotpDigits {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "TotpDigits".into()
    }
    fn json_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
        schemars::json_schema!({ "type": "integer", "enum": [6, 7, 8] })
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecureNoteItemData {
    pub title: String,
    pub note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreditCardItemData {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cardholder_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cvv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expiry_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_algorithm: Option<TotpAlgorithm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_digits: Option<TotpDigits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub totp_period: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Address {
    pub id: String,
    pub street: String,
    pub city: String,
    pub state: String,
    pub zip: String,
    pub country: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PhoneNumber {
    pub id: String,
    pub label: String,
    pub number: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdentityItemData {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub middle_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub addresses: Vec<Address>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub phone_numbers: Vec<PhoneNumber>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssn: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passport_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drivers_license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_of_birth: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_algorithm: Option<TotpAlgorithm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_digits: Option<TotpDigits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub totp_period: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthenticatorItemData {
    pub title: String,
    pub totp_secret: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_issuer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_account_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_algorithm: Option<TotpAlgorithm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub totp_digits: Option<TotpDigits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "optional_plain_u32_schema")
    )]
    pub totp_period: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_item_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_fields: Vec<CustomField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomField {
    pub id: String,
    pub label: String,
    pub value: String,
    #[serde(rename = "type")]
    pub field_type: CustomFieldKind,
}

impl fmt::Debug for CustomField {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CustomField")
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
    rename_all_fields = "camelCase",
    deny_unknown_fields
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
    ServerAccountDeletion {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String", regex(pattern = "^[\\s\\S]+$"))
        )]
        account_id: AccountId,
        request_id: String,
        outcome: ServerAccountDeletionOutcome,
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
    ShareResultAcknowledged {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        operation_id: String,
    },
    AttachmentRenamed {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
    },
    AttachmentDeleted {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
    },
    AttachmentDownloaded {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        attachment_id: String,
    },
    AttachmentUploaded {
        attachment_id: String,
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
    Teardown {
        scope: TeardownScope,
        status: TeardownStatus,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(length(max = 4))
        )]
        failures: Vec<TeardownPhase>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TeardownScope {
    Account {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String", regex(pattern = "^[\\s\\S]+$"))
        )]
        account_id: AccountId,
    },
    Device,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum TeardownStatus {
    Complete,
    Incomplete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum ServerAccountDeletionOutcome {
    Deleted,
    ConfirmationEmailMismatch,
    Blocked,
}

/// Closed, bounded failure vocabulary. It deliberately carries no host detail or identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum TeardownPhase {
    AttachmentArtifacts,
    HostCleanup,
    PlatformStorage,
    Replica,
}

/// The declared envelope every external Runtime request answers with.
///
/// Serde would otherwise emit its externally tagged `Result` spelling, an implicit wire shape no
/// contract describes. This adjacent tagging matches `RuntimeProjection`, and it keeps the
/// success payload intact: `RuntimeResponse` is itself internally tagged on `type`, so an
/// internally tagged envelope would collide with it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    PendingShareResults {
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
            Self::Items { account_id } | Self::PendingShareResults { account_id } => {
                Some(account_id)
            }
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
    PendingShareResults(PendingShareResultsProjection),
    RuntimeStatus(RuntimeStatusProjection),
}

impl RuntimeProjection {
    pub fn revision(&self) -> u64 {
        match self {
            Self::Items(value) => value.replica_revision,
            Self::PendingShareResults(value) => value.replica_revision,
            Self::RuntimeStatus(value) => value.revision,
        }
    }

    pub fn item_count(&self) -> usize {
        match self {
            Self::Items(value) => value.items.len(),
            Self::PendingShareResults(_) => 0,
            Self::RuntimeStatus(_) => 0,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct PendingShareResultsProjection {
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
    pub results: Vec<PendingShareResult>,
}

impl fmt::Debug for PendingShareResultsProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingShareResultsProjection")
            .field("account_id", &self.account_id)
            .field("replica_revision", &self.replica_revision)
            .field("result_count", &self.results.len())
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct PendingShareResult {
    pub operation_id: String,
    pub item_id: String,
    pub share_link_id: String,
    pub share_url: String,
    pub expires_at: String,
}

impl fmt::Debug for PendingShareResult {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingShareResult")
            .field("operation_id", &self.operation_id)
            .field("item_id", &self.item_id)
            .field("share_link_id", &self.share_link_id)
            .field("share_url", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[cfg(test)]
mod pending_share_secret_tests {
    use super::PendingShareResult;

    fn requires_zeroize_on_drop<T: zeroize::ZeroizeOnDrop>() {}

    #[test]
    fn core_pending_share_result_owns_its_url_as_a_zeroizing_secret() {
        requires_zeroize_on_drop::<PendingShareResult>();
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
    pub items: Vec<ItemProjection>,
    /// The Vaults these Items live in, so a host can name one and can tell a reader from a
    /// writer without asking a second source. Present for the first slice's create affordance;
    /// full Vault metadata still belongs to the read path that owns it.
    pub vaults: Vec<VaultProjection>,
}

/// One Vault as an Items reader needs it: enough to label it and to know what may be written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct VaultProjection {
    pub vault_id: String,
    pub name: String,
    pub vault_type: VaultProjectionType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_url: Option<String>,
    /// This Account's membership in the Vault. A host derives "may I write an Item here"
    /// from it (anything but `ReadOnly`), and the manage affordances an Owner or Admin has
    /// and a Member does not. The first slice's narrower create rule filters on the Vault
    /// type as well.
    pub role: VaultProjectionRole,
}

/// One Account's membership in one Vault.
///
/// The values are the Server's own closed `VaultRole` set, spelled the way the Server spells
/// them, so a host that already renders a role does not need a second vocabulary and a
/// translation table between the two.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "kebab-case")]
pub enum VaultProjectionRole {
    Owner,
    Admin,
    Member,
    ReadOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub enum VaultProjectionType {
    Personal,
    Team,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct ItemProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    pub item_id: String,
    pub vault_id: String,
    pub data: ItemDraft,
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentProjection>,
    pub created_at: String,
    pub updated_at: String,
    pub status: ItemProjectionStatus,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentProjection {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(with = "String")
    )]
    pub account_id: AccountId,
    pub attachment_id: String,
    pub item_id: String,
    pub vault_id: String,
    pub name: String,
    pub content_type: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "plain_i32_schema")
    )]
    pub file_size: i32,
    pub uploaded_by: String,
    pub created_at: String,
}

#[cfg(feature = "runtime-protocol-contract-schema")]
fn plain_i32_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "type": "integer",
        "minimum": i32::MIN,
        "maximum": i32::MAX
    })
}

#[cfg(feature = "runtime-protocol-contract-schema")]
fn plain_u32_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": "integer", "minimum": 0, "maximum": u32::MAX })
}

#[cfg(feature = "runtime-protocol-contract-schema")]
fn optional_plain_u32_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({ "type": ["integer", "null"], "minimum": 0, "maximum": u32::MAX })
}

impl fmt::Debug for AttachmentProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AttachmentProjection")
            .field("account_id", &self.account_id)
            .field("attachment_id", &self.attachment_id)
            .field("item_id", &self.item_id)
            .field("vault_id", &self.vault_id)
            .field("plaintext", &"[redacted]")
            .finish()
    }
}

impl fmt::Debug for ItemProjection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ItemProjection")
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
    pub display_identity: Option<AccountDisplayIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_reason: Option<AccountWaitingReason>,
    pub failure: Option<RuntimeErrorCode>,
}

/// The non-secret identity a host may render for one installed Account.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase")]
pub struct AccountDisplayIdentity {
    pub email: String,
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
    RetryableTransport,
    AuthorityMissing,
    AccessDenied,
    ReadOnly,
    QuotaExceeded,
    SizeRejected,
    SourceFailure,
    SinkFailure,
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

    pub async fn cancelled(&self) {
        let mut changed = self.0.changed.subscribe();
        while !*changed.borrow_and_update() {
            if changed.changed().await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod server_account_deletion_protocol_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn server_account_deletion_protocol_is_explicit_scoped_and_redacted() {
        let request = RuntimeRequest::DeleteServerAccount {
            account_id: AccountId::from("account-1"),
            confirm_email: "user@example.com".into(),
            request_id: "018f05c4-7b6a-4a89-9237-2e612fa96d01".into(),
        };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            json!({
                "type": "deleteServerAccount",
                "accountId": "account-1",
                "confirmEmail": "user@example.com",
                "requestId": "018f05c4-7b6a-4a89-9237-2e612fa96d01"
            })
        );
        assert!(!format!("{request:?}").contains("user@example.com"));

        let response = RuntimeResponse::ServerAccountDeletion {
            account_id: AccountId::from("account-1"),
            request_id: "018f05c4-7b6a-4a89-9237-2e612fa96d01".into(),
            outcome: ServerAccountDeletionOutcome::Deleted,
        };
        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "type": "serverAccountDeletion",
                "accountId": "account-1",
                "requestId": "018f05c4-7b6a-4a89-9237-2e612fa96d01",
                "outcome": "deleted"
            })
        );
    }
}
