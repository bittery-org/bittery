pub(crate) mod config;
pub mod db;
pub mod error;
pub(crate) mod http;
pub(crate) mod integrations;
mod jobs;
pub(crate) mod repo;
pub(crate) mod rpc;
pub(crate) mod services;
#[cfg(test)]
pub(crate) mod test_support;

use qubit::{handler, Router};
use sqlx::PgPool;
use config::format_timestamp;
use ts_rs::TS;

use serde::Serialize;

pub use rpc::audit::create_audit_router;
pub use services::auth::rpc_request_context_middleware;
pub use services::session::{SeededSession, SessionService};
pub use rpc::auth::create_auth_router;
pub use rpc::billing::create_billing_router;
pub use http::middleware::{edge_http_middleware, load_edge_http_config, rpc_request_guard_middleware};
pub use jobs::JobRunner;
pub use http::public::create_public_http_router;
pub use rpc::share::create_share_router;
pub use rpc::sync::create_sync_router;
pub use http::sync_sse::create_sync_http_router;
pub use services::sync::SyncControlBroker;
pub use rpc::team::create_team_router;
pub use rpc::vault::create_vault_router;

#[derive(Clone)]
pub struct AppState {
    pub db_pool: Option<PgPool>,
    pub sessions: SessionService,
    pub sync_control: SyncControlBroker,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrivateDataUserResponse {
    pub token: String,
    pub session_id: String,
    pub user_id: String,
    pub expires_at: String,
    pub platform: String,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PrivateDataResponse {
    pub message: String,
    pub user: PrivateDataUserResponse,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            db_pool: None,
            sessions: SessionService::default(),
            sync_control: SyncControlBroker::default(),
        }
    }
}

impl AppState {
    pub fn from_pool(pool: PgPool) -> Self {
        Self {
            db_pool: Some(pool.clone()),
            sessions: SessionService::from_pool(pool),
            sync_control: SyncControlBroker::default(),
        }
    }

    pub async fn from_env() -> Result<Self, sqlx::Error> {
        match db::connect_from_env().await? {
            Some(pool) => Ok(Self::from_pool(pool)),
            _ => Ok(Self::default()),
        }
    }
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn healthCheck() -> String {
    "OK".to_string()
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn privateData(ctx: services::auth::RefreshSessionContext) -> PrivateDataResponse {
    PrivateDataResponse {
        message: "This is private".to_string(),
        user: PrivateDataUserResponse {
            token: ctx.session.token,
            session_id: ctx.session.session_id,
            user_id: ctx.session.user_id,
            expires_at: format_timestamp(ctx.session.expires_at),
            platform: ctx.session.platform,
            client_id: ctx.session.client_id,
        },
    }
}

pub fn create_rpc_router() -> Router<AppState> {
    Router::new()
        .handler(healthCheck)
        .handler(privateData)
        .nest("auth", create_auth_router())
        .nest("audit", create_audit_router())
        .nest("billing", create_billing_router())
        .nest("share", create_share_router())
        .nest("sync", create_sync_router())
        .nest("team", create_team_router())
        .nest("vault", create_vault_router())
}
