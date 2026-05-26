use sqlx::PgPool;
use time::OffsetDateTime;

use crate::AppState;

pub(crate) const CLOUD_MODE: &str = "cloud";
pub(crate) const SELF_HOSTED_MODE: &str = "self-hosted";

const DATABASE_NOT_CONFIGURED_MESSAGE: &str = "Database is not configured";

pub(crate) fn bittery_mode() -> &'static str {
    match std::env::var("BITTERY_MODE") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            if normalized == SELF_HOSTED_MODE
                || normalized == "self_hosted"
                || normalized == "selfhosted"
            {
                SELF_HOSTED_MODE
            } else {
                CLOUD_MODE
            }
        }
        Err(_) => CLOUD_MODE,
    }
}

pub(crate) fn is_self_hosted_mode() -> bool {
    bittery_mode() == SELF_HOSTED_MODE
}

pub(crate) fn format_timestamp(value: OffsetDateTime) -> String {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| value.unix_timestamp().to_string())
}

pub(crate) fn db_pool<E>(
    app_state: &AppState,
    internal_error: fn(&str) -> E,
) -> Result<&PgPool, E> {
    app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error(DATABASE_NOT_CONFIGURED_MESSAGE))
}