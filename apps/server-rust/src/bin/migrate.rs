use bittery_server_rust::db;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _ = dotenvy::dotenv();

    let Some(pool) = db::connect_from_env().await? else {
        return Err("DATABASE_URL environment variable is not set".into());
    };

    db::run_migrations(&pool).await?;
    println!("Migrations applied successfully");

    Ok(())
}
