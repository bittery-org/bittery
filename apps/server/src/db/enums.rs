//! The closed value sets Bittery shares between PostgreSQL, the service layer and the wire.
//!
//! Each type here is the single source of truth for one set. The PostgreSQL enum, the Rust
//! variants, the JSON strings and the OpenAPI `enum` constraint are all derived from the same
//! declaration, so a value can never be spelled three different ways in three layers.
//!
//! # Wire compatibility
//!
//! The strings in [`closed_enum!`] are the contract. They match the PostgreSQL labels created in
//! `migrations/0000_fresh_pandemic.sql` (plus `migrations/0008_add_user_travel_mode.sql`) *and*
//! the JSON the API has always emitted. Changing one is a breaking API change; `enums_tests.rs`
//! pins every string.
//!
//! # Database representation
//!
//! [`closed_enum!`] hand-writes the sqlx traits rather than deriving `sqlx::Type`, so a value
//! decodes from both `role` (the PostgreSQL enum) and `role::text` (the cast the queries use
//! today). `Type::type_info` stays `TEXT`, which means binding one of these types behaves exactly
//! like binding the `&str` it replaces: the SQL keeps its existing `$1::vault_role` casts.

use std::{fmt, str::FromStr};

use serde::{Deserialize, Serialize};
use sqlx::{
    encode::IsNull,
    error::BoxDynError,
    postgres::{PgArgumentBuffer, PgTypeInfo, PgValueRef},
    Decode, Encode, Postgres, Type, TypeInfo,
};
use utoipa::ToSchema;

/// A value that is outside one of the closed sets in this module.
///
/// Reaching this means the database, or a client, produced a label the server does not know —
/// the mismatch is surfaced as a decode error rather than silently carried as an opaque string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownEnumValue {
    /// The Rust type that rejected the value.
    pub type_name: &'static str,
    /// The value that was rejected.
    pub value: String,
}

impl fmt::Display for UnknownEnumValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "`{}` is not a valid {} value",
            self.value, self.type_name
        )
    }
}

impl std::error::Error for UnknownEnumValue {}

/// Declares the conversions, PostgreSQL codec and parsing for one closed set.
///
/// The variant-to-string table given here is the only place the wire strings appear; `as_str`,
/// `Display`, `FromStr`, `TryFrom` and the sqlx codec are all generated from it.
macro_rules! closed_enum {
    ($name:ident, $pg_type:literal, { $($variant:ident => $wire:literal),+ $(,)? }) => {
        impl $name {
            /// Every variant, in declaration order. Used by the wire-format tests.
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub const fn as_str(&self) -> &'static str {
                match self {
                    $(Self::$variant => $wire,)+
                }
            }

            /// The PostgreSQL enum type this set mirrors.
            pub const fn pg_type_name() -> &'static str {
                $pg_type
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl FromStr for $name {
            type Err = UnknownEnumValue;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($wire => Ok(Self::$variant),)+
                    _ => Err(UnknownEnumValue {
                        type_name: stringify!($name),
                        value: value.to_owned(),
                    }),
                }
            }
        }

        impl TryFrom<String> for $name {
            type Error = UnknownEnumValue;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                value.as_str().parse()
            }
        }

        impl Type<Postgres> for $name {
            fn type_info() -> PgTypeInfo {
                <str as Type<Postgres>>::type_info()
            }

            fn compatible(ty: &PgTypeInfo) -> bool {
                <str as Type<Postgres>>::compatible(ty) || ty.name().eq_ignore_ascii_case($pg_type)
            }
        }

        impl Encode<'_, Postgres> for $name {
            fn encode_by_ref(&self, buf: &mut PgArgumentBuffer) -> Result<IsNull, BoxDynError> {
                <&str as Encode<Postgres>>::encode(self.as_str(), buf)
            }
        }

        impl<'r> Decode<'r, Postgres> for $name {
            fn decode(value: PgValueRef<'r>) -> Result<Self, BoxDynError> {
                Ok(value.as_str()?.parse()?)
            }
        }
    };
}

/// Vault role — maps to PostgreSQL `vault_role` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum VaultRole {
    #[serde(rename = "owner")]
    Owner,
    #[serde(rename = "admin")]
    Admin,
    #[serde(rename = "member")]
    Member,
    #[serde(rename = "read-only")]
    ReadOnly,
}

closed_enum!(VaultRole, "vault_role", {
    Owner => "owner",
    Admin => "admin",
    Member => "member",
    ReadOnly => "read-only",
});

impl VaultRole {
    pub fn can_write(&self) -> bool {
        matches!(self, Self::Owner | Self::Admin | Self::Member)
    }

    pub fn can_manage(&self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }
}

/// Team role — maps to PostgreSQL `team_role` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum TeamRole {
    #[serde(rename = "owner")]
    Owner,
    #[serde(rename = "admin")]
    Admin,
    #[serde(rename = "member")]
    Member,
}

closed_enum!(TeamRole, "team_role", {
    Owner => "owner",
    Admin => "admin",
    Member => "member",
});

impl TeamRole {
    pub fn can_manage(&self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }

    /// The vault role a team member of this rank receives on team vaults.
    ///
    /// Team owners administer the team but hold the same vault rights as an admin; the vault
    /// owner is whoever created the vault.
    pub fn vault_role(&self) -> VaultRole {
        match self {
            Self::Owner | Self::Admin => VaultRole::Admin,
            Self::Member => VaultRole::Member,
        }
    }
}

/// Vault type — maps to PostgreSQL `vault_type` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum VaultType {
    #[serde(rename = "personal")]
    Personal,
    #[serde(rename = "team")]
    Team,
}

closed_enum!(VaultType, "vault_type", {
    Personal => "personal",
    Team => "team",
});

/// Team type — maps to PostgreSQL `team_type` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum TeamType {
    #[serde(rename = "personal")]
    Personal,
    #[serde(rename = "family")]
    Family,
    #[serde(rename = "organization")]
    Organization,
}

closed_enum!(TeamType, "team_type", {
    Personal => "personal",
    Family => "family",
    Organization => "organization",
});

/// Billing plan — maps to PostgreSQL `billing_plan` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum BillingPlan {
    #[serde(rename = "free")]
    Free,
    #[serde(rename = "personal")]
    Personal,
    #[serde(rename = "family")]
    Family,
    #[serde(rename = "team")]
    Team,
}

closed_enum!(BillingPlan, "billing_plan", {
    Free => "free",
    Personal => "personal",
    Family => "family",
    Team => "team",
});

impl BillingPlan {
    pub fn is_paid(&self) -> bool {
        !matches!(self, Self::Free)
    }
}

/// Billing status — maps to PostgreSQL `billing_status` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum BillingStatus {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "incomplete")]
    Incomplete,
    #[serde(rename = "trialing")]
    Trialing,
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "past_due")]
    PastDue,
    #[serde(rename = "canceled")]
    Canceled,
    #[serde(rename = "unpaid")]
    Unpaid,
}

closed_enum!(BillingStatus, "billing_status", {
    None => "none",
    Incomplete => "incomplete",
    Trialing => "trialing",
    Active => "active",
    PastDue => "past_due",
    Canceled => "canceled",
    Unpaid => "unpaid",
});

impl BillingStatus {
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Active | Self::Trialing)
    }
}

/// Invitation status — maps to PostgreSQL `invitation_status` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum InvitationStatus {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "accepted")]
    Accepted,
    #[serde(rename = "declined")]
    Declined,
    #[serde(rename = "expired")]
    Expired,
}

closed_enum!(InvitationStatus, "invitation_status", {
    Pending => "pending",
    Accepted => "accepted",
    Declined => "declined",
    Expired => "expired",
});

/// Share link status — maps to PostgreSQL `share_link_status` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum ShareLinkStatus {
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "expired")]
    Expired,
    #[serde(rename = "exhausted")]
    Exhausted,
    #[serde(rename = "revoked")]
    Revoked,
}

closed_enum!(ShareLinkStatus, "share_link_status", {
    Active => "active",
    Expired => "expired",
    Exhausted => "exhausted",
    Revoked => "revoked",
});

/// Share link access mode — maps to PostgreSQL `share_link_access_mode` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum ShareLinkAccessMode {
    #[serde(rename = "anyone")]
    Anyone,
    #[serde(rename = "email-restricted")]
    EmailRestricted,
}

closed_enum!(ShareLinkAccessMode, "share_link_access_mode", {
    Anyone => "anyone",
    EmailRestricted => "email-restricted",
});

/// Sync event type — maps to PostgreSQL `sync_event_type` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum SyncEventType {
    #[serde(rename = "item_created")]
    ItemCreated,
    #[serde(rename = "item_updated")]
    ItemUpdated,
    #[serde(rename = "item_deleted")]
    ItemDeleted,
    #[serde(rename = "item_restored")]
    ItemRestored,
    #[serde(rename = "item_permanently_deleted")]
    ItemPermanentlyDeleted,
    #[serde(rename = "item_moved")]
    ItemMoved,
    #[serde(rename = "vault_created")]
    VaultCreated,
    #[serde(rename = "vault_updated")]
    VaultUpdated,
    #[serde(rename = "vault_deleted")]
    VaultDeleted,
    #[serde(rename = "vault_access_revoked")]
    VaultAccessRevoked,
    #[serde(rename = "vault_member_added")]
    VaultMemberAdded,
    #[serde(rename = "vault_member_removed")]
    VaultMemberRemoved,
    #[serde(rename = "vault_key_rotated")]
    VaultKeyRotated,
    #[serde(rename = "travel_mode_updated")]
    TravelModeUpdated,
    #[serde(rename = "operation_resolved")]
    OperationResolved,
}

closed_enum!(SyncEventType, "sync_event_type", {
    ItemCreated => "item_created",
    ItemUpdated => "item_updated",
    ItemDeleted => "item_deleted",
    ItemRestored => "item_restored",
    ItemPermanentlyDeleted => "item_permanently_deleted",
    ItemMoved => "item_moved",
    VaultCreated => "vault_created",
    VaultUpdated => "vault_updated",
    VaultDeleted => "vault_deleted",
    VaultAccessRevoked => "vault_access_revoked",
    VaultMemberAdded => "vault_member_added",
    VaultMemberRemoved => "vault_member_removed",
    VaultKeyRotated => "vault_key_rotated",
    TravelModeUpdated => "travel_mode_updated",
    OperationResolved => "operation_resolved",
});

/// Sync entity type — maps to PostgreSQL `sync_entity_type` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum SyncEntityType {
    #[serde(rename = "item")]
    Item,
    #[serde(rename = "vault")]
    Vault,
    #[serde(rename = "vault_member")]
    VaultMember,
    #[serde(rename = "vault_key")]
    VaultKey,
    #[serde(rename = "user")]
    User,
    #[serde(rename = "operation")]
    Operation,
}

closed_enum!(SyncEntityType, "sync_entity_type", {
    Item => "item",
    Vault => "vault",
    VaultMember => "vault_member",
    VaultKey => "vault_key",
    User => "user",
    Operation => "operation",
});

/// Item category — maps to PostgreSQL `item_category` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum ItemCategory {
    #[serde(rename = "login")]
    Login,
    #[serde(rename = "secure-note")]
    SecureNote,
    #[serde(rename = "credit-card")]
    CreditCard,
    #[serde(rename = "identity")]
    Identity,
    #[serde(rename = "totp")]
    Totp,
}

closed_enum!(ItemCategory, "item_category", {
    Login => "login",
    SecureNote => "secure-note",
    CreditCard => "credit-card",
    Identity => "identity",
    Totp => "totp",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum KeyRotationReason {
    MemberRemoved,
    Scheduled,
    SecurityBreach,
    Manual,
}
closed_enum!(KeyRotationReason, "key_rotation_reason", {
    MemberRemoved => "member_removed", Scheduled => "scheduled",
    SecurityBreach => "security_breach", Manual => "manual",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum VaultKeyRotationPlanState {
    Preparing,
    Ready,
    Completed,
    Stale,
    Failed,
    Abandoned,
    Expired,
}

closed_enum!(VaultKeyRotationPlanState, "vault_key_rotation_plan_state", {
    Preparing => "preparing",
    Ready => "ready",
    Completed => "completed",
    Stale => "stale",
    Failed => "failed",
    Abandoned => "abandoned",
    Expired => "expired",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum VaultKeyRotationStaleReason {
    VaultVersion,
    MemberSet,
    ItemState,
    AttachmentState,
}

closed_enum!(VaultKeyRotationStaleReason, "vault_key_rotation_stale_reason", {
    VaultVersion => "vault_version",
    MemberSet => "member_set",
    ItemState => "item_state",
    AttachmentState => "attachment_state",
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum VaultKeyRotationManifestKind {
    Member,
    Item,
    Attachment,
}

closed_enum!(VaultKeyRotationManifestKind, "vault_key_rotation_manifest_kind", {
    Member => "member",
    Item => "item",
    Attachment => "attachment",
});

/// The Domain operation represented by one retained outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    CreateItem,
    UpdateItem,
    SetItemFavorite,
    TrashItem,
    RestoreItem,
    MoveItem,
    PermanentlyDeleteItem,
    CreateShare,
}

closed_enum!(OperationKind, "operation_kind", {
    CreateItem => "create_item",
    UpdateItem => "update_item",
    SetItemFavorite => "set_item_favorite",
    TrashItem => "trash_item",
    RestoreItem => "restore_item",
    MoveItem => "move_item",
    PermanentlyDeleteItem => "permanently_delete_item",
    CreateShare => "create_share",
});

/// Whether a retained Operation applied its effect or proved a terminal rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OperationOutcomeStatus {
    Applied,
    Rejected,
}

closed_enum!(OperationOutcomeStatus, "operation_outcome_status", {
    Applied => "applied",
    Rejected => "rejected",
});

/// The terminal semantic rejections an Item Operation can prove.
///
/// One set, not one per kind. `invalid_ciphertext`, `vault_access_denied` and `vault_read_only`
/// are the same fact whichever mutation met them, and a client that learns to read them once can
/// read them everywhere. Each kind then contributes only its own genuinely new failures, and the
/// handler -- not the wire type -- decides which subset it can ever prove.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum OperationRejectionCode {
    InvalidCiphertext,
    VaultAccessDenied,
    VaultReadOnly,
    ItemIdConflict,
    ItemNotFound,
    ItemVersionConflict,
    ItemTrashed,
    ItemNotTrashed,
    SourceVaultMismatch,
    TargetVaultAccessDenied,
    TargetVaultReadOnly,
    AttachmentStateConflict,
    ShareEntitlementDenied,
    ShareLimitReached,
}

closed_enum!(OperationRejectionCode, "operation_rejection_code", {
    InvalidCiphertext => "invalid_ciphertext",
    VaultAccessDenied => "vault_access_denied",
    VaultReadOnly => "vault_read_only",
    ItemIdConflict => "item_id_conflict",
    ItemNotFound => "item_not_found",
    ItemVersionConflict => "item_version_conflict",
    ItemTrashed => "item_trashed",
    ItemNotTrashed => "item_not_trashed",
    SourceVaultMismatch => "source_vault_mismatch",
    TargetVaultAccessDenied => "target_vault_access_denied",
    TargetVaultReadOnly => "target_vault_read_only",
    AttachmentStateConflict => "attachment_state_conflict",
    ShareEntitlementDenied => "share_entitlement_denied",
    ShareLimitReached => "share_limit_reached",
});

#[cfg(test)]
#[path = "enums_tests.rs"]
mod tests;
