use std::{env, path::PathBuf};

use sqlx::{
    migrate::{MigrateError, Migrator},
    postgres::PgPoolOptions,
    PgPool,
};

pub mod enums;
pub mod models;

const DEFAULT_MAX_CONNECTIONS: u32 = 5;

fn max_connections() -> u32 {
    env::var("DATABASE_MAX_CONNECTIONS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_CONNECTIONS)
}

pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max_connections())
        .connect(database_url)
        .await
}

pub async fn connect_from_env() -> Result<Option<PgPool>, sqlx::Error> {
    match env::var("DATABASE_URL") {
        Ok(database_url) if !database_url.trim().is_empty() => {
            connect(database_url.trim()).await.map(Some)
        }
        _ => Ok(None),
    }
}

pub fn database_url_from_env() -> Result<String, &'static str> {
    required_database_url(env::var("DATABASE_URL").ok())
}

fn required_database_url(value: Option<String>) -> Result<String, &'static str> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().to_owned())
        .ok_or("DATABASE_URL is required")
}

pub async fn connect_required_from_env() -> Result<PgPool, Box<dyn std::error::Error + Send + Sync>>
{
    let database_url = database_url_from_env().map_err(std::io::Error::other)?;
    Ok(connect(&database_url).await?)
}

pub async fn run_migrations(pool: &PgPool) -> Result<(), MigrateError> {
    let migrator = Migrator::new(resolve_migrations_dir()).await?;
    migrator.run(pool).await
}

fn resolve_migrations_dir() -> PathBuf {
    if let Ok(path) = env::var("MIGRATIONS_FOLDER") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations")
}

#[cfg(test)]
mod tests {
    use super::required_database_url;

    #[test]
    fn required_database_url_rejects_missing_or_blank_values_and_normalizes_valid_ones() {
        assert_eq!(required_database_url(None), Err("DATABASE_URL is required"));
        assert_eq!(
            required_database_url(Some("  ".to_string())),
            Err("DATABASE_URL is required")
        );
        assert_eq!(
            required_database_url(Some(" postgres://localhost/bittery ".to_string())),
            Ok("postgres://localhost/bittery".to_string())
        );
    }
}
