use std::{fmt, path::PathBuf, time::Duration};

use time::OffsetDateTime;

pub(crate) const CLOUD_MODE: &str = "cloud";
pub(crate) const SELF_HOSTED_MODE: &str = "self-hosted";

const DEFAULT_DATABASE_MAX_CONNECTIONS: u32 = 5;
const DEFAULT_DATABASE_ACQUIRE_TIMEOUT_SECONDS: u64 = 5;
const DEFAULT_REQUEST_TIMEOUT_SECONDS: u64 = 30;

#[derive(Clone)]
pub struct Config {
    pub database: DatabaseConfig,
    pub auth: AuthConfig,
    pub stripe: StripeConfig,
    pub storage: StorageConfig,
    pub server: ServerConfig,
    pub redis: RedisConfig,
    pub rate_limit: RateLimitConfig,
}

#[derive(Clone)]
pub struct DatabaseConfig {
    pub url: String,
    pub max_connections: u32,
    pub acquire_timeout: Duration,
    pub migrations_folder: Option<PathBuf>,
}

#[derive(Clone)]
pub struct AuthConfig {
    pub jwt_secret: String,
    pub dev_stubs_enabled: bool,
    pub dev_mail_outbox: Option<PathBuf>,
}

#[derive(Clone, Default)]
pub struct StripeConfig {
    pub secret_key: Option<String>,
    pub webhook_secret: Option<String>,
    pub personal_monthly_price_id: Option<String>,
    pub family_monthly_price_id: Option<String>,
    pub team_seat_monthly_price_id: Option<String>,
}

#[derive(Clone)]
pub struct StorageConfig {
    pub s3: Option<S3Config>,
    pub cdn_url: Option<String>,
    pub attachment_upload_secret: String,
}

#[derive(Clone)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

#[derive(Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub node_environment: String,
    pub mode: DeploymentMode,
    pub cloud_public_signup: bool,
    pub cloud_billing: bool,
    pub allow_insecure_http: bool,
    pub trust_proxy_mode: TrustProxyMode,
    pub cors_origin: Option<String>,
    pub web_app_url: Option<String>,
    pub request_timeout: Duration,
}

impl ServerConfig {
    pub fn bind_address(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

#[derive(Clone, Default)]
pub struct RedisConfig {
    pub url: Option<String>,
    pub pool_size: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RateLimitAdapter {
    Auto,
    Postgres,
    Redis,
}

#[derive(Clone)]
pub struct RateLimitConfig {
    pub adapter: RateLimitAdapter,
    pub redis_url: Option<String>,
    pub login_ip: i64,
    pub login_email: i64,
    pub signup_ip: i64,
    pub signup_email: i64,
    pub signup_verify_request: i64,
    pub recovery_request: i64,
    pub auth_ip: i64,
    pub share_link_daily: i64,
    pub signup_verify_max: i64,
    pub signup_verify_lock: Duration,
    pub recovery_verify_max: i64,
    pub recovery_verify_lock: Duration,
    pub share_email_verify_max: i64,
    pub share_email_verify_lock: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeploymentMode {
    Cloud,
    SelfHosted,
}

impl DeploymentMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cloud => CLOUD_MODE,
            Self::SelfHosted => SELF_HOSTED_MODE,
        }
    }

    pub fn is_self_hosted(self) -> bool {
        matches!(self, Self::SelfHosted)
    }
}

/// How the client IP is derived, per `TRUST_PROXY_MODE`.
///
/// Forwarding headers are client-supplied: anything reaching the server without
/// passing through a proxy that overwrites them can put an arbitrary value
/// there. Default to `None` and opt in only behind such a proxy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TrustProxyMode {
    None,
    Cloudflare,
    Forwarded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError {
    message: String,
}

impl ConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    fn from_lookup(mut lookup: impl FnMut(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let node_environment =
            optional(&mut lookup, "NODE_ENV").unwrap_or_else(|| "development".to_string());
        let production = node_environment.eq_ignore_ascii_case("production");
        let mode_value =
            optional(&mut lookup, "BITTERY_MODE").map(|value| value.to_ascii_lowercase());
        let mode = match mode_value.as_deref() {
            None | Some(CLOUD_MODE) => DeploymentMode::Cloud,
            Some(SELF_HOSTED_MODE) => DeploymentMode::SelfHosted,
            Some(_) => return Err(invalid("BITTERY_MODE", "cloud or self-hosted")),
        };

        let database_max_connections = match optional(&mut lookup, "DATABASE_MAX_CONNECTIONS") {
            Some(value) => parse_positive(&value, "DATABASE_MAX_CONNECTIONS")?,
            None if production => {
                return Err(ConfigError::new(
                    "DATABASE_MAX_CONNECTIONS is required when NODE_ENV=production",
                ))
            }
            None => DEFAULT_DATABASE_MAX_CONNECTIONS,
        };
        let database_acquire_timeout = positive_seconds(
            optional(&mut lookup, "DATABASE_ACQUIRE_TIMEOUT_SECONDS"),
            "DATABASE_ACQUIRE_TIMEOUT_SECONDS",
            DEFAULT_DATABASE_ACQUIRE_TIMEOUT_SECONDS,
        )?;

        let jwt_secret = required_secret(&mut lookup, "JWT_SECRET")?;
        let attachment_upload_secret = match lookup("BITTERY_ATTACHMENT_UPLOAD_SECRET") {
            Some(value) if value.trim().is_empty() => {
                return Err(ConfigError::new(
                    "BITTERY_ATTACHMENT_UPLOAD_SECRET must not be blank when set",
                ))
            }
            Some(value) => value,
            None => jwt_secret.clone(),
        };

        let s3_values = [
            optional(&mut lookup, "BITTERY_STORAGE_ENDPOINT"),
            optional(&mut lookup, "BITTERY_STORAGE_BUCKET"),
            optional(&mut lookup, "BITTERY_STORAGE_ACCESS_KEY_ID"),
            optional(&mut lookup, "BITTERY_STORAGE_SECRET_ACCESS_KEY"),
        ];
        let s3 = match s3_values {
            [None, None, None, None] => None,
            [Some(endpoint), Some(bucket), Some(access_key_id), Some(secret_access_key)] => {
                Some(S3Config {
                    endpoint,
                    region: optional(&mut lookup, "BITTERY_STORAGE_REGION")
                        .unwrap_or_else(|| "auto".to_string()),
                    bucket,
                    access_key_id,
                    secret_access_key,
                })
            }
            _ => {
                return Err(ConfigError::new(
                    "BITTERY_STORAGE_ENDPOINT, BITTERY_STORAGE_BUCKET, BITTERY_STORAGE_ACCESS_KEY_ID, and BITTERY_STORAGE_SECRET_ACCESS_KEY must be set together",
                ))
            }
        };

        let rate_limit_adapter_value =
            optional(&mut lookup, "RATE_LIMIT_ADAPTER").map(|value| value.to_ascii_lowercase());
        let rate_limit_adapter = match rate_limit_adapter_value.as_deref() {
            None | Some("auto") => RateLimitAdapter::Auto,
            Some("postgres") => RateLimitAdapter::Postgres,
            Some("redis") => RateLimitAdapter::Redis,
            Some(_) => return Err(invalid("RATE_LIMIT_ADAPTER", "auto, postgres, or redis")),
        };
        let rate_limit_redis_url = optional(&mut lookup, "RATE_LIMIT_REDIS_URL");
        if rate_limit_adapter == RateLimitAdapter::Redis && rate_limit_redis_url.is_none() {
            return Err(ConfigError::new(
                "RATE_LIMIT_ADAPTER=redis requires RATE_LIMIT_REDIS_URL",
            ));
        }

        let dev_stubs_enabled = boolean(
            optional(&mut lookup, "BITTERY_ENABLE_DEV_AUTH_STUBS"),
            "BITTERY_ENABLE_DEV_AUTH_STUBS",
            false,
        )?;
        if production && dev_stubs_enabled {
            return Err(ConfigError::new(
                "BITTERY_ENABLE_DEV_AUTH_STUBS cannot be enabled in production",
            ));
        }

        Ok(Self {
            database: DatabaseConfig {
                url: required(&mut lookup, "DATABASE_URL")?,
                max_connections: database_max_connections,
                acquire_timeout: database_acquire_timeout,
                migrations_folder: optional(&mut lookup, "MIGRATIONS_FOLDER").map(PathBuf::from),
            },
            auth: AuthConfig {
                jwt_secret,
                dev_stubs_enabled,
                dev_mail_outbox: optional(&mut lookup, "BITTERY_DEV_MAIL_OUTBOX")
                    .map(PathBuf::from),
            },
            stripe: StripeConfig {
                secret_key: optional(&mut lookup, "STRIPE_SECRET_KEY"),
                webhook_secret: optional(&mut lookup, "STRIPE_WEBHOOK_SECRET"),
                personal_monthly_price_id: optional(&mut lookup, "STRIPE_PRICE_PERSONAL_MONTHLY"),
                family_monthly_price_id: optional(&mut lookup, "STRIPE_PRICE_FAMILY_MONTHLY"),
                team_seat_monthly_price_id: optional(&mut lookup, "STRIPE_PRICE_TEAM_SEAT_MONTHLY"),
            },
            storage: StorageConfig {
                s3,
                cdn_url: optional(&mut lookup, "BITTERY_STORAGE_CDN_URL"),
                attachment_upload_secret,
            },
            server: ServerConfig {
                host: optional(&mut lookup, "HOST").unwrap_or_else(|| "0.0.0.0".to_string()),
                port: optional(&mut lookup, "PORT")
                    .map(|value| parse_positive(&value, "PORT"))
                    .transpose()?
                    .unwrap_or(3000),
                node_environment,
                mode,
                cloud_public_signup: boolean(
                    optional(&mut lookup, "BITTERY_CLOUD_PUBLIC_SIGNUP"),
                    "BITTERY_CLOUD_PUBLIC_SIGNUP",
                    true,
                )?,
                cloud_billing: boolean(
                    optional(&mut lookup, "BITTERY_CLOUD_BILLING_ENABLED"),
                    "BITTERY_CLOUD_BILLING_ENABLED",
                    true,
                )?,
                allow_insecure_http: boolean(
                    optional(&mut lookup, "BITTERY_ALLOW_INSECURE_HTTP"),
                    "BITTERY_ALLOW_INSECURE_HTTP",
                    false,
                )?,
                trust_proxy_mode: match optional(&mut lookup, "TRUST_PROXY_MODE")
                    .map(|value| value.to_ascii_lowercase())
                    .as_deref()
                {
                    None | Some("none") => TrustProxyMode::None,
                    Some("cloudflare") => TrustProxyMode::Cloudflare,
                    Some("forwarded") | Some("proxy") => TrustProxyMode::Forwarded,
                    Some(_) => {
                        return Err(invalid(
                            "TRUST_PROXY_MODE",
                            "none, cloudflare, or forwarded",
                        ))
                    }
                },
                cors_origin: optional(&mut lookup, "CORS_ORIGIN"),
                web_app_url: optional(&mut lookup, "WEB_APP_URL"),
                request_timeout: positive_seconds(
                    optional(&mut lookup, "REQUEST_TIMEOUT_SECONDS"),
                    "REQUEST_TIMEOUT_SECONDS",
                    DEFAULT_REQUEST_TIMEOUT_SECONDS,
                )?,
            },
            redis: RedisConfig {
                url: optional(&mut lookup, "REDIS_URL"),
                pool_size: optional(&mut lookup, "REDIS_POOL_SIZE")
                    .map(|value| parse_positive(&value, "REDIS_POOL_SIZE"))
                    .transpose()?
                    .unwrap_or(4),
            },
            rate_limit: RateLimitConfig {
                adapter: rate_limit_adapter,
                redis_url: rate_limit_redis_url,
                login_ip: positive_i64(&mut lookup, "RATE_LIMIT_LOGIN_IP", 20)?,
                login_email: positive_i64(&mut lookup, "RATE_LIMIT_LOGIN_EMAIL", 10)?,
                signup_ip: positive_i64(&mut lookup, "RATE_LIMIT_SIGNUP_IP", 10)?,
                signup_email: positive_i64(&mut lookup, "RATE_LIMIT_SIGNUP_EMAIL", 5)?,
                signup_verify_request: positive_i64(
                    &mut lookup,
                    "RATE_LIMIT_SIGNUP_VERIFY_REQUEST",
                    5,
                )?,
                recovery_request: positive_i64(&mut lookup, "RATE_LIMIT_RECOVERY_REQUEST", 5)?,
                auth_ip: positive_i64(&mut lookup, "RATE_LIMIT_AUTH_IP", 30)?,
                share_link_daily: positive_i64(&mut lookup, "SHARE_LINK_DAILY_LIMIT", 50)?,
                signup_verify_max: positive_i64(&mut lookup, "RATE_LIMIT_SIGNUP_VERIFY_MAX", 10)?,
                signup_verify_lock: positive_minutes(
                    &mut lookup,
                    "RATE_LIMIT_SIGNUP_VERIFY_LOCK_MINUTES",
                    15,
                )?,
                recovery_verify_max: positive_i64(
                    &mut lookup,
                    "RATE_LIMIT_RECOVERY_VERIFY_MAX",
                    5,
                )?,
                recovery_verify_lock: positive_minutes(
                    &mut lookup,
                    "RATE_LIMIT_RECOVERY_LOCK_MINUTES",
                    15,
                )?,
                share_email_verify_max: positive_i64(
                    &mut lookup,
                    "RATE_LIMIT_SHARE_EMAIL_VERIFY_MAX",
                    5,
                )?,
                share_email_verify_lock: positive_minutes(
                    &mut lookup,
                    "RATE_LIMIT_SHARE_EMAIL_VERIFY_LOCK_MINUTES",
                    15,
                )?,
            },
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Self::from_lookup(|name| match name {
            "DATABASE_URL" => Some("postgres://test:test@127.0.0.1/test".to_string()),
            "DATABASE_MAX_CONNECTIONS" => std::env::var(name)
                .ok()
                .or_else(|| Some(DEFAULT_DATABASE_MAX_CONNECTIONS.to_string())),
            "JWT_SECRET" => std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .or_else(|| Some("bittery-test-jwt-secret".to_string())),
            _ => std::env::var(name).ok(),
        })
        .expect("test environment configuration should be valid")
    }
}

fn required(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    name: &'static str,
) -> Result<String, ConfigError> {
    optional(lookup, name).ok_or_else(|| ConfigError::new(format!("{name} is required")))
}

fn required_secret(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    name: &'static str,
) -> Result<String, ConfigError> {
    match lookup(name) {
        Some(value) if !value.trim().is_empty() => Ok(value),
        _ => Err(ConfigError::new(format!("{name} is required"))),
    }
}

fn optional(lookup: &mut impl FnMut(&str) -> Option<String>, name: &str) -> Option<String> {
    lookup(name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_positive<T>(value: &str, name: &'static str) -> Result<T, ConfigError>
where
    T: std::str::FromStr + PartialOrd + From<u8>,
{
    let parsed = value
        .parse::<T>()
        .map_err(|_| ConfigError::new(format!("{name} must be a positive integer")))?;
    if parsed <= T::from(0) {
        return Err(ConfigError::new(format!(
            "{name} must be a positive integer"
        )));
    }
    Ok(parsed)
}

fn positive_seconds(
    value: Option<String>,
    name: &'static str,
    default: u64,
) -> Result<Duration, ConfigError> {
    Ok(Duration::from_secs(match value {
        Some(value) => parse_positive(&value, name)?,
        None => default,
    }))
}

fn positive_i64(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    name: &'static str,
    default: i64,
) -> Result<i64, ConfigError> {
    match optional(lookup, name) {
        Some(value) => parse_positive(&value, name),
        None => Ok(default),
    }
}

fn positive_minutes(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    name: &'static str,
    default: i64,
) -> Result<Duration, ConfigError> {
    let minutes = positive_i64(lookup, name, default)?;
    let seconds = u64::try_from(minutes)
        .ok()
        .and_then(|minutes| minutes.checked_mul(60))
        .ok_or_else(|| ConfigError::new(format!("{name} is too large")))?;
    Ok(Duration::from_secs(seconds))
}

fn boolean(value: Option<String>, name: &'static str, default: bool) -> Result<bool, ConfigError> {
    match value.as_deref().map(str::to_ascii_lowercase).as_deref() {
        None => Ok(default),
        Some("1" | "true" | "yes" | "on") => Ok(true),
        Some("0" | "false" | "no" | "off") => Ok(false),
        Some(_) => Err(ConfigError::new(format!("{name} must be true or false"))),
    }
}

fn invalid(name: &'static str, expected: &'static str) -> ConfigError {
    ConfigError::new(format!("{name} must be one of: {expected}"))
}

pub(crate) fn format_timestamp(value: OffsetDateTime) -> String {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| value.unix_timestamp().to_string())
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn parse(values: &[(&str, &str)]) -> Result<Config, ConfigError> {
        let values = values
            .iter()
            .map(|(name, value)| ((*name).to_string(), (*value).to_string()))
            .collect::<HashMap<_, _>>();
        Config::from_lookup(|name| values.get(name).cloned())
    }

    fn required_values() -> Vec<(&'static str, &'static str)> {
        vec![
            ("DATABASE_URL", "postgres://localhost/bittery"),
            ("JWT_SECRET", "test-jwt-secret"),
        ]
    }

    #[test]
    fn startup_config_parses_defaults_and_groups_secrets() {
        let config = parse(&required_values()).expect("minimal development config should parse");

        assert_eq!(config.database.max_connections, 5);
        assert_eq!(config.database.acquire_timeout, Duration::from_secs(5));
        assert_eq!(config.server.mode, DeploymentMode::Cloud);
        assert_eq!(config.server.request_timeout, Duration::from_secs(30));
        assert_eq!(config.rate_limit.adapter, RateLimitAdapter::Auto);
        assert_eq!(config.rate_limit.login_ip, 20);
        assert_eq!(config.storage.attachment_upload_secret, "test-jwt-secret");
        assert!(config.storage.s3.is_none());
        assert_eq!(config.server.bind_address(), "0.0.0.0:3000");

        let mut case_insensitive = required_values();
        case_insensitive.extend([
            ("BITTERY_MODE", "SELF-HOSTED"),
            ("TRUST_PROXY_MODE", "Cloudflare"),
            ("RATE_LIMIT_ADAPTER", "POSTGRES"),
        ]);
        let config = parse(&case_insensitive).expect("legacy enum casing should remain accepted");
        assert_eq!(config.server.mode, DeploymentMode::SelfHosted);
        assert_eq!(config.server.trust_proxy_mode, TrustProxyMode::Cloudflare);
        assert_eq!(config.rate_limit.adapter, RateLimitAdapter::Postgres);
    }

    #[test]
    fn startup_config_rejects_invalid_security_and_tunable_values() {
        for (name, value) in [
            ("BITTERY_MODE", "hybrid"),
            ("TRUST_PROXY_MODE", "always"),
            ("BITTERY_CLOUD_PUBLIC_SIGNUP", "perhaps"),
            ("REQUEST_TIMEOUT_SECONDS", "0"),
            ("DATABASE_ACQUIRE_TIMEOUT_SECONDS", "later"),
            ("RATE_LIMIT_LOGIN_IP", "-1"),
            ("RATE_LIMIT_ADAPTER", "memory"),
        ] {
            let mut values = required_values();
            values.push((name, value));
            assert!(parse(&values).is_err(), "{name}={value} must fail startup");
        }
    }

    #[test]
    fn startup_config_preserves_attachment_secret_fallback_semantics() {
        let mut dedicated = required_values();
        dedicated.push(("BITTERY_ATTACHMENT_UPLOAD_SECRET", "attachment-secret"));
        assert_eq!(
            parse(&dedicated)
                .expect("dedicated secret should parse")
                .storage
                .attachment_upload_secret,
            "attachment-secret"
        );

        let mut blank = required_values();
        blank.push(("BITTERY_ATTACHMENT_UPLOAD_SECRET", "  "));
        assert!(parse(&blank).is_err());
    }

    #[test]
    fn production_requires_explicit_pool_size_and_disables_dev_auth_stubs() {
        let mut missing_pool_size = required_values();
        missing_pool_size.push(("NODE_ENV", "production"));
        assert!(parse(&missing_pool_size).is_err());

        let mut dev_stubs = missing_pool_size;
        dev_stubs.push(("DATABASE_MAX_CONNECTIONS", "12"));
        dev_stubs.push(("BITTERY_ENABLE_DEV_AUTH_STUBS", "true"));
        assert!(parse(&dev_stubs).is_err());
    }

    #[test]
    fn storage_configuration_is_all_or_nothing() {
        let mut partial = required_values();
        partial.push(("BITTERY_STORAGE_ENDPOINT", "https://storage.example.com"));
        assert!(parse(&partial).is_err());

        let mut complete = required_values();
        complete.extend([
            ("BITTERY_STORAGE_ENDPOINT", "https://storage.example.com"),
            ("BITTERY_STORAGE_BUCKET", "bittery"),
            ("BITTERY_STORAGE_ACCESS_KEY_ID", "access"),
            ("BITTERY_STORAGE_SECRET_ACCESS_KEY", "secret"),
        ]);
        assert!(parse(&complete)
            .expect("complete storage config should parse")
            .storage
            .s3
            .is_some());
    }
}
