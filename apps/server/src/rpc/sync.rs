use std::collections::BTreeMap;

use qubit::{handler, server::Router};

use crate::{
    services::auth::RefreshSessionContext,
    error::AppError,
    config::db_pool,
    services::sync::{
        self, AcknowledgeEventsInput, AcknowledgeEventsResponse, BootstrapItemsInput,
        BootstrapItemsResponse, CheckConflictInput, CheckConflictResponse, GetEventsSinceInput,
        GetEventsSinceResponse, GetLastAcknowledgedInput, GetSyncStateInput,
        LastAcknowledgedResponse, SyncStateEntry,
    },
    AppState,
};

#[allow(non_snake_case)]
#[handler(query)]
pub async fn checkConflict(
    ctx: RefreshSessionContext,
    input: CheckConflictInput,
) -> Result<CheckConflictResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    sync::check_conflict(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getEventsSince(
    ctx: RefreshSessionContext,
    input: GetEventsSinceInput,
) -> Result<GetEventsSinceResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    sync::get_events_since(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn bootstrapItems(
    ctx: RefreshSessionContext,
    input: BootstrapItemsInput,
) -> Result<BootstrapItemsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    sync::bootstrap_items(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn acknowledgeEvents(
    ctx: RefreshSessionContext,
    input: AcknowledgeEventsInput,
) -> Result<AcknowledgeEventsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    sync::acknowledge_events(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getLastAcknowledged(
    ctx: RefreshSessionContext,
    input: GetLastAcknowledgedInput,
) -> Result<Option<LastAcknowledgedResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    sync::get_last_acknowledged(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getSyncState(
    ctx: RefreshSessionContext,
    input: GetSyncStateInput,
) -> Result<BTreeMap<String, SyncStateEntry>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    sync::get_sync_state(pool, &ctx.session.user_id, input).await
}

pub fn create_sync_router() -> Router<AppState> {
    Router::new()
        .handler(bootstrapItems)
        .handler(getEventsSince)
        .handler(acknowledgeEvents)
        .handler(getLastAcknowledged)
        .handler(getSyncState)
        .handler(checkConflict)
}
