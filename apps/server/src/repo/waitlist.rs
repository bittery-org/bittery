use sqlx::{query_as, PgPool};
use time::OffsetDateTime;

use crate::{db::models::DbBetaWaitlistRow, error::AppError};

pub async fn upsert_beta_waitlist_entry(
    pool: &PgPool,
    id: &str,
    email: &str,
    name: Option<&str>,
    use_case: Option<&str>,
    source: Option<&str>,
) -> Result<DbBetaWaitlistRow, AppError> {
    query_as::<_, DbBetaWaitlistRow>(
		r#"
		INSERT INTO beta_waitlist (id, email, name, use_case, source)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (lower(email))
		DO UPDATE SET
			name = COALESCE(EXCLUDED.name, beta_waitlist.name),
			use_case = COALESCE(EXCLUDED.use_case, beta_waitlist.use_case),
			source = COALESCE(EXCLUDED.source, beta_waitlist.source),
			updated_at = $6
		RETURNING id, email, name, use_case, source, created_at, updated_at
		"#,
	)
	.bind(id)
	.bind(email)
	.bind(name)
	.bind(use_case)
	.bind(source)
	.bind(OffsetDateTime::now_utc())
	.fetch_one(pool)
	.await
	.map_err(|e| {
		tracing::error!(error = %e, "Failed to upsert beta waitlist entry");
		AppError::internal("Failed to join waitlist")
	})
}
