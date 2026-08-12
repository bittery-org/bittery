use sqlx::FromRow;
use time::OffsetDateTime;

use crate::db::enums::{ShareLinkAccessMode, ShareLinkStatus, VaultRole};

#[derive(Clone, Debug, FromRow)]
pub struct DbShareLinkRow {
    pub id: String,
    pub item_id: String,
    pub created_by_id: String,
    pub status: ShareLinkStatus,
    pub access_mode: ShareLinkAccessMode,
    pub is_one_time_use: bool,
    pub access_count: i32,
    pub max_access_count: Option<i32>,
    pub expires_at: OffsetDateTime,
    pub created_at: OffsetDateTime,
    pub last_accessed_at: Option<OffsetDateTime>,
    pub vault_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbShareLinkAllowedEmailRow {
    pub id: String,
    pub share_link_id: String,
    pub email: String,
    pub verified: bool,
    pub verified_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbShareLinkAllowedEmailDeleteRow {
    pub id: String,
    pub email: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbShareAccessLogRow {
    pub id: String,
    pub accessed_by_email: Option<String>,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub success: bool,
    pub failure_reason: Option<String>,
    pub accessed_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbPublicShareLinkRow {
    pub id: String,
    pub created_by_id: String,
    pub status: ShareLinkStatus,
    pub access_mode: ShareLinkAccessMode,
    pub is_one_time_use: bool,
    pub encrypted_item_data: String,
    pub encryption_iv: String,
    pub encrypted_share_key: String,
    pub share_key_iv: String,
    pub access_count: i32,
    pub max_access_count: Option<i32>,
    pub expires_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbShareEmailVerificationRow {
    pub id: String,
    pub share_link_id: String,
    pub email: String,
    pub code_hash: String,
    pub attempts: i32,
    pub max_attempts: i32,
    pub expires_at: OffsetDateTime,
    pub created_at: OffsetDateTime,
    pub used_at: Option<OffsetDateTime>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbScopedItemAccessRow {
    pub item_id: String,
    pub vault_id: String,
    pub role: VaultRole,
}
