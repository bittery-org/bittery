use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{query_as, FromRow, PgPool};
use std::sync::LazyLock;
use time::OffsetDateTime;

use crate::{error::AppError, services::transaction::database_error};

static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").expect("email regex should compile")
});

const MAX_EMAIL_LEN: usize = 254;
const MAX_NAME_LEN: usize = 120;
const MAX_USE_CASE_LEN: usize = 500;
const MAX_SOURCE_LEN: usize = 80;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistSignupInput {
    pub email: String,
    pub name: Option<String>,
    pub use_case: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistSignupResponse {
    pub success: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, FromRow)]
struct DbBetaWaitlistRow {
    id: String,
    email: String,
    name: Option<String>,
    use_case: Option<String>,
    source: Option<String>,
    created_at: OffsetDateTime,
    updated_at: OffsetDateTime,
}

pub async fn join_beta_waitlist(
    pool: &PgPool,
    input: WaitlistSignupInput,
) -> Result<WaitlistSignupResponse, AppError> {
    let email = normalize_email(&input.email)?;
    let name = normalize_optional_text(input.name, MAX_NAME_LEN, "Name")?;
    let use_case = normalize_optional_text(input.use_case, MAX_USE_CASE_LEN, "Use case")?;
    let source = normalize_optional_text(input.source, MAX_SOURCE_LEN, "Source")?;
    let id = format!("waitlist_{}", uuid::Uuid::new_v4());

    upsert_beta_waitlist_entry(
        pool,
        &id,
        &email,
        name.as_deref(),
        use_case.as_deref(),
        source.as_deref(),
    )
    .await?;

    Ok(WaitlistSignupResponse { success: true })
}

async fn upsert_beta_waitlist_entry(
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
    .map_err(|error| database_error(error, "Failed to join waitlist"))
}

fn normalize_email(email: &str) -> Result<String, AppError> {
    let normalized = email.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized.len() > MAX_EMAIL_LEN || !EMAIL_RE.is_match(&normalized)
    {
        return Err(AppError::bad_request("Enter a valid email address"));
    }
    Ok(normalized)
}

fn normalize_optional_text(
    value: Option<String>,
    max_len: usize,
    label: &str,
) -> Result<Option<String>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let normalized = value.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    if normalized.len() > max_len {
        return Err(AppError::bad_request(format!("{label} is too long")));
    }
    Ok(Some(normalized.to_string()))
}
