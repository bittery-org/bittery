use serde::{Deserialize, Serialize};

/// Vault role — maps to PostgreSQL `vault_role` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "vault_role")]
pub enum VaultRole {
    #[sqlx(rename = "owner")]
    #[serde(rename = "owner")]
    Owner,
    #[sqlx(rename = "admin")]
    #[serde(rename = "admin")]
    Admin,
    #[sqlx(rename = "member")]
    #[serde(rename = "member")]
    Member,
    #[sqlx(rename = "read-only")]
    #[serde(rename = "read-only")]
    ReadOnly,
}

impl VaultRole {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
            Self::ReadOnly => "read-only",
        }
    }

    pub fn can_write(&self) -> bool {
        matches!(self, Self::Owner | Self::Admin | Self::Member)
    }

    pub fn can_manage(&self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }
}

impl std::fmt::Display for VaultRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Team role — maps to PostgreSQL `team_role` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "team_role")]
pub enum TeamRole {
    #[sqlx(rename = "owner")]
    #[serde(rename = "owner")]
    Owner,
    #[sqlx(rename = "admin")]
    #[serde(rename = "admin")]
    Admin,
    #[sqlx(rename = "member")]
    #[serde(rename = "member")]
    Member,
}

impl TeamRole {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }

    pub fn can_manage(&self) -> bool {
        matches!(self, Self::Owner | Self::Admin)
    }
}

impl std::fmt::Display for TeamRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Vault type — maps to PostgreSQL `vault_type` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "vault_type")]
pub enum VaultType {
    #[sqlx(rename = "personal")]
    #[serde(rename = "personal")]
    Personal,
    #[sqlx(rename = "team")]
    #[serde(rename = "team")]
    Team,
}

impl VaultType {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Team => "team",
        }
    }
}

impl std::fmt::Display for VaultType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Team type — maps to PostgreSQL `team_type` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "team_type")]
pub enum TeamType {
    #[sqlx(rename = "personal")]
    #[serde(rename = "personal")]
    Personal,
    #[sqlx(rename = "family")]
    #[serde(rename = "family")]
    Family,
    #[sqlx(rename = "organization")]
    #[serde(rename = "organization")]
    Organization,
}

impl TeamType {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Family => "family",
            Self::Organization => "organization",
        }
    }
}

impl std::fmt::Display for TeamType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Billing plan — maps to PostgreSQL `billing_plan` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "billing_plan")]
pub enum BillingPlan {
    #[sqlx(rename = "free")]
    #[serde(rename = "free")]
    Free,
    #[sqlx(rename = "personal")]
    #[serde(rename = "personal")]
    Personal,
    #[sqlx(rename = "family")]
    #[serde(rename = "family")]
    Family,
    #[sqlx(rename = "team")]
    #[serde(rename = "team")]
    Team,
}

impl BillingPlan {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Personal => "personal",
            Self::Family => "family",
            Self::Team => "team",
        }
    }

    pub fn is_paid(&self) -> bool {
        !matches!(self, Self::Free)
    }
}

impl std::fmt::Display for BillingPlan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Billing status — maps to PostgreSQL `billing_status` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "billing_status")]
pub enum BillingStatus {
    #[sqlx(rename = "none")]
    #[serde(rename = "none")]
    None,
    #[sqlx(rename = "incomplete")]
    #[serde(rename = "incomplete")]
    Incomplete,
    #[sqlx(rename = "trialing")]
    #[serde(rename = "trialing")]
    Trialing,
    #[sqlx(rename = "active")]
    #[serde(rename = "active")]
    Active,
    #[sqlx(rename = "past_due")]
    #[serde(rename = "past_due")]
    PastDue,
    #[sqlx(rename = "canceled")]
    #[serde(rename = "canceled")]
    Canceled,
    #[sqlx(rename = "unpaid")]
    #[serde(rename = "unpaid")]
    Unpaid,
}

impl BillingStatus {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Incomplete => "incomplete",
            Self::Trialing => "trialing",
            Self::Active => "active",
            Self::PastDue => "past_due",
            Self::Canceled => "canceled",
            Self::Unpaid => "unpaid",
        }
    }

    pub fn is_active(&self) -> bool {
        matches!(self, Self::Active | Self::Trialing)
    }
}

impl std::fmt::Display for BillingStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Invitation status — maps to PostgreSQL `invitation_status` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "invitation_status")]
pub enum InvitationStatus {
    #[sqlx(rename = "pending")]
    #[serde(rename = "pending")]
    Pending,
    #[sqlx(rename = "accepted")]
    #[serde(rename = "accepted")]
    Accepted,
    #[sqlx(rename = "declined")]
    #[serde(rename = "declined")]
    Declined,
    #[sqlx(rename = "expired")]
    #[serde(rename = "expired")]
    Expired,
}

impl InvitationStatus {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Declined => "declined",
            Self::Expired => "expired",
        }
    }
}

impl std::fmt::Display for InvitationStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Share link status — maps to PostgreSQL `share_link_status` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "share_link_status")]
pub enum ShareLinkStatus {
    #[sqlx(rename = "active")]
    #[serde(rename = "active")]
    Active,
    #[sqlx(rename = "expired")]
    #[serde(rename = "expired")]
    Expired,
    #[sqlx(rename = "exhausted")]
    #[serde(rename = "exhausted")]
    Exhausted,
    #[sqlx(rename = "revoked")]
    #[serde(rename = "revoked")]
    Revoked,
}

impl ShareLinkStatus {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Expired => "expired",
            Self::Exhausted => "exhausted",
            Self::Revoked => "revoked",
        }
    }
}

impl std::fmt::Display for ShareLinkStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Share link access mode — maps to PostgreSQL `share_link_access_mode` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "share_link_access_mode")]
pub enum ShareLinkAccessMode {
    #[sqlx(rename = "anyone")]
    #[serde(rename = "anyone")]
    Anyone,
    #[sqlx(rename = "email-restricted")]
    #[serde(rename = "email-restricted")]
    EmailRestricted,
}

impl ShareLinkAccessMode {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Anyone => "anyone",
            Self::EmailRestricted => "email-restricted",
        }
    }
}

impl std::fmt::Display for ShareLinkAccessMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Sync event type — maps to PostgreSQL `sync_event_type` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "sync_event_type")]
pub enum SyncEventType {
    #[sqlx(rename = "item_created")]
    #[serde(rename = "item_created")]
    ItemCreated,
    #[sqlx(rename = "item_updated")]
    #[serde(rename = "item_updated")]
    ItemUpdated,
    #[sqlx(rename = "item_deleted")]
    #[serde(rename = "item_deleted")]
    ItemDeleted,
    #[sqlx(rename = "item_restored")]
    #[serde(rename = "item_restored")]
    ItemRestored,
    #[sqlx(rename = "item_permanently_deleted")]
    #[serde(rename = "item_permanently_deleted")]
    ItemPermanentlyDeleted,
    #[sqlx(rename = "item_moved")]
    #[serde(rename = "item_moved")]
    ItemMoved,
    #[sqlx(rename = "vault_created")]
    #[serde(rename = "vault_created")]
    VaultCreated,
    #[sqlx(rename = "vault_updated")]
    #[serde(rename = "vault_updated")]
    VaultUpdated,
    #[sqlx(rename = "vault_deleted")]
    #[serde(rename = "vault_deleted")]
    VaultDeleted,
    #[sqlx(rename = "vault_access_revoked")]
    #[serde(rename = "vault_access_revoked")]
    VaultAccessRevoked,
    #[sqlx(rename = "vault_member_added")]
    #[serde(rename = "vault_member_added")]
    VaultMemberAdded,
    #[sqlx(rename = "vault_member_removed")]
    #[serde(rename = "vault_member_removed")]
    VaultMemberRemoved,
    #[sqlx(rename = "vault_key_rotated")]
    #[serde(rename = "vault_key_rotated")]
    VaultKeyRotated,
    #[sqlx(rename = "travel_mode_updated")]
    #[serde(rename = "travel_mode_updated")]
    TravelModeUpdated,
}

impl SyncEventType {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::ItemCreated => "item_created",
            Self::ItemUpdated => "item_updated",
            Self::ItemDeleted => "item_deleted",
            Self::ItemRestored => "item_restored",
            Self::ItemPermanentlyDeleted => "item_permanently_deleted",
            Self::ItemMoved => "item_moved",
            Self::VaultCreated => "vault_created",
            Self::VaultUpdated => "vault_updated",
            Self::VaultDeleted => "vault_deleted",
            Self::VaultAccessRevoked => "vault_access_revoked",
            Self::VaultMemberAdded => "vault_member_added",
            Self::VaultMemberRemoved => "vault_member_removed",
            Self::VaultKeyRotated => "vault_key_rotated",
            Self::TravelModeUpdated => "travel_mode_updated",
        }
    }
}

impl std::fmt::Display for SyncEventType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Sync entity type — maps to PostgreSQL `sync_entity_type` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "sync_entity_type")]
pub enum SyncEntityType {
    #[sqlx(rename = "item")]
    #[serde(rename = "item")]
    Item,
    #[sqlx(rename = "vault")]
    #[serde(rename = "vault")]
    Vault,
    #[sqlx(rename = "vault_member")]
    #[serde(rename = "vault_member")]
    VaultMember,
    #[sqlx(rename = "vault_key")]
    #[serde(rename = "vault_key")]
    VaultKey,
    #[sqlx(rename = "user")]
    #[serde(rename = "user")]
    User,
}

impl SyncEntityType {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Item => "item",
            Self::Vault => "vault",
            Self::VaultMember => "vault_member",
            Self::VaultKey => "vault_key",
            Self::User => "user",
        }
    }
}

impl std::fmt::Display for SyncEntityType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Item category — maps to PostgreSQL `item_category` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(type_name = "item_category")]
pub enum ItemCategory {
    #[sqlx(rename = "login")]
    #[serde(rename = "login")]
    Login,
    #[sqlx(rename = "secure-note")]
    #[serde(rename = "secure-note")]
    SecureNote,
    #[sqlx(rename = "credit-card")]
    #[serde(rename = "credit-card")]
    CreditCard,
    #[sqlx(rename = "identity")]
    #[serde(rename = "identity")]
    Identity,
    #[sqlx(rename = "totp")]
    #[serde(rename = "totp")]
    Totp,
}

impl ItemCategory {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Login => "login",
            Self::SecureNote => "secure-note",
            Self::CreditCard => "credit-card",
            Self::Identity => "identity",
            Self::Totp => "totp",
        }
    }
}

impl std::fmt::Display for ItemCategory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}
