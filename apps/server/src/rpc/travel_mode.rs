use qubit::{handler, Router};

use crate::{
    config::db_pool,
    error::AppError,
    services::auth::{self, FinishLoginInput, RefreshSessionContext},
    services::travel_mode::{self, *},
    AppState, NotifySyncExt,
};

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getTravelMode(ctx: RefreshSessionContext) -> Result<TravelModeResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    travel_mode::get_travel_mode(pool, &ctx.session.user_id).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn setTravelModeHiddenVaults(
    ctx: RefreshSessionContext,
    input: SetTravelModeHiddenVaultsInput,
) -> Result<TravelModeResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    travel_mode::set_travel_mode_hidden_vaults(
        pool,
        &ctx.session.user_id,
        ctx.request.client_id.as_deref(),
        input,
    )
    .await
    .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn enableTravelMode(
    ctx: RefreshSessionContext,
    input: EnableTravelModeInput,
) -> Result<TravelModeResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    travel_mode::enable_travel_mode(
        pool,
        &ctx.session.user_id,
        ctx.request.client_id.as_deref(),
        input,
    )
    .await
    .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn disableTravelMode(
    ctx: RefreshSessionContext,
    input: DisableTravelModeInput,
) -> Result<TravelModeResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    auth::verify_login_proof_for_user(
        pool,
        &ctx.session.user_id,
        &FinishLoginInput {
            attempt_id: input.attempt_id,
            client_public_key: input.client_public_key,
            client_proof: input.client_proof,
        },
    )
    .await?;
    travel_mode::disable_travel_mode(pool, &ctx.session.user_id, ctx.request.client_id.as_deref())
        .await
        .notify_sync(&ctx.app_state)
}

pub fn create_travel_mode_router() -> Router<AppState> {
    Router::new()
        .handler(getTravelMode)
        .handler(setTravelModeHiddenVaults)
        .handler(enableTravelMode)
        .handler(disableTravelMode)
}
