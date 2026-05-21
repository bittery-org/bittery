use std::env;

use axum::{middleware, routing::get, Json, Router};
use bittery_server_rust::{
	create_public_http_router, create_rpc_router, create_sync_http_router, db,
	edge_http_middleware, load_edge_http_config, rpc_request_context_middleware,
	rpc_request_guard_middleware,
	AppState, JobRunner,
};
use serde_json::json;
use tokio::net::TcpListener;
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

fn init_tracing() {
	let filter = EnvFilter::try_from_default_env()
		.unwrap_or_else(|_| EnvFilter::new("info,bittery_server_rust=debug,tower_http=debug"));

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
	let edge_http_config = load_edge_http_config().map_err(std::io::Error::other)?;
	let app_state = match db::connect_from_env().await? {
		Some(pool) => {
			db::run_migrations(&pool).await?;
			AppState::from_pool(pool)
		}
		None => AppState::default(),
	};
	let _job_runner = app_state
		.db_pool
		.clone()
		.map(JobRunner::start)
		.transpose()?;
	let seeded_session = app_state.sessions.seeded_session();
	let (qubit_service, _server_handle) = create_rpc_router().to_service(app_state.clone());
	let rpc_routes = Router::new()
		.nest_service("/rpc", qubit_service)
		.route_layer(middleware::from_fn_with_state(
			app_state.clone(),
			rpc_request_context_middleware,
		))
		.layer(middleware::from_fn(rpc_request_guard_middleware));
	let sync_routes = create_sync_http_router()
		.route_layer(middleware::from_fn_with_state(
			app_state.clone(),
			rpc_request_context_middleware,
		))
		.with_state(app_state.clone());
	let public_http_routes = create_public_http_router().with_state(app_state.clone());
	let app = Router::new()
		.route("/", get(|| async { "OK" }))
		.route("/healthz", get(|| async { Json(json!({ "status": "ok" })) }))
		.merge(public_http_routes)
		.nest("/sync", sync_routes)
		.merge(rpc_routes)
		.layer(middleware::from_fn_with_state(
			edge_http_config,
			edge_http_middleware,
		))
		.layer(TraceLayer::new_for_http());

	let listener = TcpListener::bind(&bind_address).await?;
	info!(address = %bind_address, "rust rpc server listening");
	if let Some(seeded_session) = seeded_session {
		info!(
			dev_token = %seeded_session.token,
			session_id = %seeded_session.session_id,
			user_id = %seeded_session.user_id,
			expires_at = %seeded_session.expires_at,
			"seeded dev auth.refreshSession session"
		);
	} else {
		info!("using database-backed session service");
	}

	axum::serve(listener, app).await?;
	Ok(())
}