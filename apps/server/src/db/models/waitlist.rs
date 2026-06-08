use sqlx::FromRow;
use time::OffsetDateTime;

#[derive(Debug, Clone, FromRow)]
pub struct DbBetaWaitlistRow {
    pub id: String,
    pub email: String,
    pub name: Option<String>,
    pub use_case: Option<String>,
    pub source: Option<String>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}
