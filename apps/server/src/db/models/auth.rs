use sqlx::FromRow;
use time::OffsetDateTime;

#[derive(Clone, Debug, FromRow)]
pub struct DbSignupVerificationRow {
    pub id: String,
    pub email: String,
    pub invitation_token_hash: Option<String>,
    pub code_hash: String,
    pub attempts: i32,
    pub max_attempts: i32,
    pub expires_at: OffsetDateTime,
    pub used_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbRecoveryVerificationRow {
    pub id: String,
    pub email: String,
    pub code_hash: String,
    pub attempts: i32,
    pub max_attempts: i32,
    pub expires_at: OffsetDateTime,
    pub used_at: Option<OffsetDateTime>,
    pub created_at: OffsetDateTime,
}
