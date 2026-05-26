use sqlx::FromRow;
use time::OffsetDateTime;

#[derive(Clone, Debug, FromRow)]
pub struct DbTombstoneCandidate {
    pub id: String,
    pub vault_id: String,
    pub last_modified_by: Option<String>,
    pub version: Option<i32>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultOwnerRow {
    pub id: String,
    pub created_by_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbPendingAttachmentUploadRow {
    pub id: String,
    pub storage_key: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbPendingAttachmentReservationRow {
    pub id: String,
    pub file_size: i32,
    pub storage_size: i32,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbScopedAttachmentAccessRow {
    pub id: String,
    pub item_id: String,
    pub vault_id: String,
    pub storage_key: String,
    pub encrypted_name: String,
    pub encrypted_content_type: String,
    pub encryption_iv: String,
    pub encrypted_content_type_iv: Option<String>,
    pub encryption_algorithm: String,
    pub file_size: i32,
    pub uploaded_by: Option<String>,
    pub created_at: OffsetDateTime,
    pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultListRow {
    pub id: String,
    pub name: String,
    pub vault_type: String,
    pub icon: Option<String>,
    pub image_key: Option<String>,
    pub role: String,
    pub encrypted_vault_key: String,
    pub created_by_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultGetRow {
    pub id: String,
    pub name: String,
    pub vault_type: String,
    pub icon: Option<String>,
    pub image_key: Option<String>,
    pub user_role: String,
    pub item_count: i64,
    pub member_count: i64,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbManagedVaultRow {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub image_key: Option<String>,
    pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultOwnerAccessRow {
    pub vault_id: String,
    pub vault_type: String,
    pub team_id: Option<String>,
    pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultDeleteRow {
    pub id: String,
    pub name: String,
    pub vault_type: String,
    pub image_key: Option<String>,
    pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultMemberAccessRow {
    pub user_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultAvailableMemberRow {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub public_key: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultLookupUserRow {
    pub id: String,
    pub name: String,
    pub email: String,
    pub public_key: String,
    pub team_id: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbItemVaultAccessRow {
    pub role: String,
}
