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
