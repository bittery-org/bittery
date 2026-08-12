use sqlx::FromRow;
use time::OffsetDateTime;

use crate::db::enums::{ItemCategory, SyncEntityType, SyncEventType, VaultRole, VaultType};

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncConflictRow {
    pub version: i32,
    pub user_id: String,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncEventVaultRow {
    pub id: String,
    pub vault_id: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultAccessRow {
    pub vault_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbLastAcknowledgedRow {
    pub event_id: String,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncStateEventRow {
    pub id: String,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncEventCursorRow {
    pub id: String,
    pub seq: i64,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncEventIdRow {
    pub id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncEventRow {
    pub id: String,
    pub seq: i64,
    pub event_type: SyncEventType,
    pub entity_id: String,
    pub entity_type: SyncEntityType,
    pub vault_id: Option<String>,
    pub version: i32,
    pub client_id: Option<String>,
    pub user_id: String,
    pub metadata: Option<String>,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbBootstrapVaultAccessRow {
    pub vault_id: String,
    pub vault_name: String,
    pub vault_type: VaultType,
    pub vault_icon: Option<String>,
    pub vault_image_key: Option<String>,
    pub encrypted_vault_key: String,
    pub role: VaultRole,
}

/// Column list for `item` SELECTs that populate `DbBootstrapItemRow`.
/// Must stay in sync with that struct's field order and casts.
pub(crate) const BOOTSTRAP_ITEM_COLUMNS: &str = "id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, encryption_version, encrypted_by_user_id, last_modified_by, created_at, updated_at, deleted_at";

#[derive(Clone, Debug, FromRow)]
pub struct DbBootstrapItemRow {
    pub id: String,
    pub vault_id: String,
    pub category: ItemCategory,
    pub favorite: bool,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
    pub version: i32,
    pub encryption_version: i32,
    pub encrypted_by_user_id: String,
    pub last_modified_by: String,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub deleted_at: Option<OffsetDateTime>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbBootstrapAttachmentRow {
    pub id: String,
    pub item_id: String,
    pub vault_id: String,
    pub storage_key: String,
    pub encrypted_name: String,
    pub encrypted_content_type: String,
    pub encryption_iv: String,
    pub encrypted_content_type_iv: String,
    pub encryption_algorithm: String,
    pub file_size: i32,
    pub uploaded_by: String,
    pub created_at: OffsetDateTime,
}
