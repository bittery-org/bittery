use qubit::{handler, server::Router};

use crate::{
    services::auth::RefreshSessionContext,
    services::billing::{
        self, AttachmentUsageResponse, BillingEntitlementsResponse, BillingStatusResponse,
        CheckoutPlanInput, CheckoutSessionResponse, PortalSessionResponse, SyncSeatsInput,
        SyncSeatsResponse, TeamSeatInvoicePreviewResponse,
    },
    error::AppError,
    config::db_pool,
    AppState,
};

#[allow(non_snake_case)]
#[handler(query)]
pub async fn status(ctx: RefreshSessionContext) -> Result<BillingStatusResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    billing::get_billing_status(pool, &ctx.session.user_id).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn entitlements(
    ctx: RefreshSessionContext,
) -> Result<BillingEntitlementsResponse, AppError> {
    billing::get_billing_entitlements(ctx.app_state.db_pool.as_ref(), &ctx.session.user_id).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn attachmentUsage(
    ctx: RefreshSessionContext,
) -> Result<AttachmentUsageResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    billing::get_attachment_usage(pool, &ctx.session.user_id).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createCheckoutSession(
    ctx: RefreshSessionContext,
    input: CheckoutPlanInput,
) -> Result<CheckoutSessionResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    billing::create_checkout_session(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createPortalSession(
    ctx: RefreshSessionContext,
) -> Result<PortalSessionResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    billing::create_portal_session(pool, &ctx.session.user_id).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn syncSeats(
    ctx: RefreshSessionContext,
    input: SyncSeatsInput,
) -> Result<SyncSeatsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    billing::sync_seats(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn previewAdditionalTeamSeat(
    ctx: RefreshSessionContext,
) -> Result<Option<TeamSeatInvoicePreviewResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    billing::preview_additional_team_seat(pool, &ctx.session.user_id).await
}

pub fn create_billing_router() -> Router<AppState> {
    Router::new()
        .handler(status)
        .handler(entitlements)
        .handler(attachmentUsage)
        .handler(createCheckoutSession)
        .handler(createPortalSession)
        .handler(syncSeats)
        .handler(previewAdditionalTeamSeat)
}
