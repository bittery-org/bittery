use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::LazyLock;
use ts_rs::TS;

use crate::{error::AppError, repo::waitlist::upsert_beta_waitlist_entry};

static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$").expect("email regex should compile")
});

const MAX_EMAIL_LEN: usize = 254;
const MAX_NAME_LEN: usize = 120;
const MAX_USE_CASE_LEN: usize = 500;
const MAX_SOURCE_LEN: usize = 80;

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistSignupInput {
    pub email: String,
    pub name: Option<String>,
    pub use_case: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WaitlistSignupResponse {
    pub success: bool,
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
