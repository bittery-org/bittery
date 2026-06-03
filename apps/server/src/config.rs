use sqlx::PgPool;
use time::OffsetDateTime;

use crate::error::AppError;
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

fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name) {
        Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => default,
        },
        Err(_) => default,
    }
}

pub(crate) fn cloud_public_signup_enabled() -> bool {
    env_flag("BITTERY_CLOUD_PUBLIC_SIGNUP", true)
}

pub(crate) fn cloud_billing_enabled() -> bool {
    env_flag("BITTERY_CLOUD_BILLING_ENABLED", true)
}

pub(crate) fn format_timestamp(value: OffsetDateTime) -> String {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| value.unix_timestamp().to_string())
}

pub(crate) fn db_pool(app_state: &AppState) -> Result<&PgPool, AppError> {
    app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::internal(DATABASE_NOT_CONFIGURED_MESSAGE))
}
