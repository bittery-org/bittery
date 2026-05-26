use std::{env, io, path::PathBuf};

use sqlx::{
    migrate::{MigrateError, Migrator},
    postgres::PgPoolOptions,
    query, query_scalar, PgPool,
};
use tracing::info;

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
    baseline_sqlx_from_legacy_drizzle(pool, &migrator).await?;
    migrator.run(pool).await
}

async fn baseline_sqlx_from_legacy_drizzle(
    pool: &PgPool,
    migrator: &Migrator,
) -> Result<(), MigrateError> {
    let sqlx_table_exists: bool =
        query_scalar("SELECT to_regclass('public._sqlx_migrations') IS NOT NULL")
            .fetch_one(pool)
            .await?;

    let sqlx_migration_count = if sqlx_table_exists {
        query_scalar::<_, i64>("SELECT COUNT(*) FROM public._sqlx_migrations")
            .fetch_one(pool)
            .await?
    } else {
        0
    };

    if sqlx_migration_count > 0 {
        return Ok(());
    }

    let drizzle_table_exists: bool =
        query_scalar("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL")
            .fetch_one(pool)
            .await?;

    if !drizzle_table_exists {
        return Ok(());
    }

    let legacy_migration_count =
        query_scalar::<_, i64>("SELECT COUNT(*) FROM drizzle.__drizzle_migrations")
            .fetch_one(pool)
            .await?;

    if legacy_migration_count == 0 {
        return Ok(());
    }

    let legacy_migration_count = legacy_migration_count as usize;
    let known_migrations: Vec<_> = migrator.iter().collect();

    if legacy_migration_count > known_migrations.len() {
        return Err(MigrateError::Source(Box::new(io::Error::other(format!(
			"legacy drizzle migration history has {legacy_migration_count} entries, but only {} sqlx migrations are available",
			known_migrations.len()
		)))));
    }

    if !sqlx_table_exists {
        query(
            r#"
			CREATE TABLE IF NOT EXISTS public._sqlx_migrations (
				version BIGINT PRIMARY KEY,
				description TEXT NOT NULL,
				installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
				success BOOLEAN NOT NULL,
				checksum BYTEA NOT NULL,
				execution_time BIGINT NOT NULL
			)
			"#,
        )
        .execute(pool)
        .await?;
    }

    info!(
        legacy_migration_count,
        "baselining sqlx migrations from legacy drizzle history"
    );

    let mut tx = pool.begin().await?;

    for migration in known_migrations.into_iter().take(legacy_migration_count) {
        query(
            r#"
			INSERT INTO public._sqlx_migrations (
				version,
				description,
				success,
				checksum,
				execution_time
			)
			VALUES ($1, $2, TRUE, $3, 0)
			ON CONFLICT (version) DO NOTHING
			"#,
        )
        .bind(migration.version)
        .bind(migration.description.as_ref())
        .bind(migration.checksum.as_ref())
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;

    Ok(())
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
