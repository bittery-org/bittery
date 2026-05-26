use qubit::{handler, server::Router};

use crate::{
    services::audit::{self, TeamEventsInput, TeamEventsResponse},
    services::auth::RefreshSessionContext,
    error::AppError,
    config::db_pool,
    AppState,
};

#[allow(non_snake_case)]
#[handler(query)]
pub async fn teamEvents(
    ctx: RefreshSessionContext,
    input: TeamEventsInput,
) -> Result<TeamEventsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    audit::get_team_events(pool, &ctx.session.user_id, input).await
}

pub fn create_audit_router() -> Router<AppState> {
    Router::new().handler(teamEvents)
}
