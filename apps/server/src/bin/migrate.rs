use bittery_server::db;
use sqlx::query;
use url::Url;

/// `--fresh` drops the database it is pointed at, so it is restricted to the
/// throwaway prefixes: a mistyped DATABASE_URL must not be able to destroy a real
/// one.
const RESETTABLE_DATABASE_PREFIXES: [&str; 2] = ["bittery_e2e", "bittery_test"];

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ = dotenvy::dotenv();
    let database_url = std::env::var("DATABASE_URL")
        .map_err(|_| "DATABASE_URL environment variable is not set")?;

    if std::env::args()
        .skip(1)
        .any(|argument| argument == "--fresh")
    {
        let name = recreate_database(&database_url).await?;
        println!("Recreated database {name}");
    }

    let pool = db::connect(&database_url).await?;

    match std::env::var("MIGRATIONS_FOLDER")
        .ok()
        .filter(|path| !path.trim().is_empty())
    {
        Some(path) => db::run_migrations_from(&pool, path.trim()).await?,
        None => db::run_migrations(&pool).await?,
    }
    println!("Migrations applied successfully");

    Ok(())
}

async fn recreate_database(
    database_url: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let url = Url::parse(database_url)?;
    let name = url.path().trim_start_matches('/').to_string();
    ensure_resettable_database_name(&name)?;

    let mut admin_url = url.clone();
    admin_url.set_path("/postgres");
    let admin_pool = db::connect(admin_url.as_str()).await?;

    // A running server holds open connections, and Postgres refuses to drop a
    // database that still has any.
    query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
    )
    .bind(&name)
    .execute(&admin_pool)
    .await?;

    query(&format!("DROP DATABASE IF EXISTS \"{name}\""))
        .execute(&admin_pool)
        .await?;
    query(&format!("CREATE DATABASE \"{name}\""))
        .execute(&admin_pool)
        .await?;

    Ok(name)
}

fn ensure_resettable_database_name(name: &str) -> Result<(), String> {
    if !name
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '_')
        || name.is_empty()
    {
        return Err(format!(
            "Refusing --fresh: '{name}' is not a plain database name in DATABASE_URL"
        ));
    }
    if !RESETTABLE_DATABASE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
    {
        return Err(format!(
            "Refusing --fresh on database '{name}': only databases named {} may be dropped",
            RESETTABLE_DATABASE_PREFIXES
                .map(|prefix| format!("{prefix}*"))
                .join(" or ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ensure_resettable_database_name;

    #[test]
    fn fresh_accepts_only_throwaway_database_names() {
        for name in ["bittery_e2e", "bittery_e2e_web", "bittery_test_abc123"] {
            ensure_resettable_database_name(name)
                .unwrap_or_else(|error| panic!("{name} should be resettable: {error}"));
        }

        for name in ["bittery", "bittery_dev", "postgres", "", "prod_bittery_e2e"] {
            let error = ensure_resettable_database_name(name)
                .expect_err(&format!("{name} should be refused"));
            assert!(error.starts_with("Refusing --fresh"), "{error}");
        }
    }

    #[test]
    fn fresh_refuses_names_that_could_break_out_of_the_ddl_statement() {
        let error = ensure_resettable_database_name("bittery_e2e\"; DROP DATABASE bittery; --")
            .expect_err("a quoted injection should be refused");
        assert!(error.contains("not a plain database name"), "{error}");
    }
}
