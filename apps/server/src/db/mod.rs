use std::path::{Path, PathBuf};

use sqlx::{
    migrate::{MigrateError, Migrator},
    postgres::PgPoolOptions,
    PgPool,
};

use crate::config::DatabaseConfig;

pub mod enums;
pub mod models;

const DEFAULT_MAX_CONNECTIONS: u32 = 5;

pub async fn connect(database_url: &str) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(DEFAULT_MAX_CONNECTIONS)
        .acquire_timeout(std::time::Duration::from_secs(5))
        .connect(database_url)
        .await
}

pub async fn connect_with_config(config: &DatabaseConfig) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(config.max_connections)
        .acquire_timeout(config.acquire_timeout)
        .connect(&config.url)
        .await
}

pub async fn run_migrations(pool: &PgPool) -> Result<(), MigrateError> {
    run_migrations_from(pool, default_migrations_dir()).await
}

pub async fn run_migrations_with_config(
    pool: &PgPool,
    config: &DatabaseConfig,
) -> Result<(), MigrateError> {
    run_migrations_from(
        pool,
        config
            .migrations_folder
            .clone()
            .unwrap_or_else(default_migrations_dir),
    )
    .await
}

pub async fn run_migrations_from(
    pool: &PgPool,
    migrations_dir: impl AsRef<Path>,
) -> Result<(), MigrateError> {
    Migrator::new(migrations_dir.as_ref())
        .await?
        .run(pool)
        .await
}

fn default_migrations_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("migrations")
}
