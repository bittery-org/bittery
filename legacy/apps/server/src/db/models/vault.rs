use sqlx::FromRow;

#[derive(Clone, Debug, FromRow)]
pub struct DbTombstoneCandidate {
    pub id: String,
    pub vault_id: String,
    pub last_modified_by: String,
    pub version: i32,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbPendingAttachmentUploadRow {
    pub id: String,
    pub storage_key: String,
}
