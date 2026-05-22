mod audit;
mod auth;
mod billing;
pub mod db;
mod edge_http;
pub mod favicon;
mod jobs;
mod public_http;
pub(crate) mod session_control;
mod share;
pub mod storage;
mod sync;
mod team;
#[cfg(test)]
pub(crate) mod test_support;
mod vault;

use qubit::{handler, Router};
use sqlx::PgPool;
use ts_rs::TS;

use serde::Serialize;

pub use audit::create_audit_router;
pub use auth::{create_auth_router, rpc_request_context_middleware, SeededSession, SessionService};
pub use billing::create_billing_router;
pub use edge_http::{edge_http_middleware, load_edge_http_config, rpc_request_guard_middleware};
pub use jobs::JobRunner;
pub use public_http::create_public_http_router;
pub use share::create_share_router;
pub use sync::{create_sync_http_router, create_sync_router, SyncControlBroker};
pub use team::create_team_router;
pub use vault::create_vault_router;

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
pub async fn privateData(ctx: auth::RefreshSessionContext) -> PrivateDataResponse {
    PrivateDataResponse {
        message: "This is private".to_string(),
        user: PrivateDataUserResponse {
            token: ctx.session.token,
            session_id: ctx.session.session_id,
            user_id: ctx.session.user_id,
            expires_at: ctx
                .session
                .expires_at
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| ctx.session.expires_at.unix_timestamp().to_string()),
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
