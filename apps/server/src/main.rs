use std::{env, net::SocketAddr};

use bittery_server::ServerRuntime;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,bittery_server=debug"));

    tracing_subscriber::fmt().with_env_filter(filter).init();
}

fn read_bind_address() -> String {
    let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port = env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    format!("{host}:{port}")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    dotenvy::dotenv().ok();
    init_tracing();

    let bind_address = read_bind_address();
    let runtime = ServerRuntime::from_env().await?;
    let app = runtime.app();

    let listener = TcpListener::bind(&bind_address).await?;
    info!(address = %bind_address, "Bittery API server listening");
    info!("using database-backed session service");

    // ConnectInfo preserves TCP peer identity unless trusted proxy settings select forwarded headers.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
