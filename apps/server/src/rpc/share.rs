use qubit::{handler, server::Router};

use crate::{
    config::db_pool,
    error::AppError,
    services::auth::{AppContext, RefreshSessionContext},
    services::share::{self, *},
    AppState,
};

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn create(
    ctx: RefreshSessionContext,
    input: CreateShareLinkInput,
) -> Result<CreateShareLinkResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    share::create_share_link(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listByItem(
    ctx: RefreshSessionContext,
    input: ItemIdInput,
) -> Result<ShareLinkListResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    share::list_share_links_by_item(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn get(
    ctx: RefreshSessionContext,
    input: LinkIdInput,
) -> Result<ShareLinkDetailsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    share::get_share_link(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn revoke(
    ctx: RefreshSessionContext,
    input: LinkIdInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    share::revoke_share_link(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn update(
    ctx: RefreshSessionContext,
    input: UpdateShareLinkInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    share::update_share_link(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getAccessLogs(
    ctx: RefreshSessionContext,
    input: LinkIdInput,
) -> Result<Vec<ShareAccessLogResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    share::get_share_access_logs(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getPublicInfo(
    ctx: AppContext,
    input: PublicTokenInput,
) -> Result<PublicShareInfoResponse, AppError> {
    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::internal("Database is not configured"))?;
    share::get_public_info(pool, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn accessPublic(
    ctx: AppContext,
    input: PublicTokenInput,
) -> Result<PublicShareAccessResponse, AppError> {
    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::internal("Database is not configured"))?;
    share::access_public(pool, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn requestEmailVerification(
    ctx: AppContext,
    input: RequestEmailVerificationInput,
) -> Result<RequestEmailVerificationResponse, AppError> {
    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::internal("Database is not configured"))?;
    share::request_email_verification(pool, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn verifyEmailAndAccess(
    ctx: AppContext,
    input: VerifyEmailAndAccessInput,
) -> Result<PublicShareAccessResponse, AppError> {
    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| AppError::internal("Database is not configured"))?;
    share::verify_email_and_access(pool, input).await
}

pub fn create_share_router() -> Router<AppState> {
    Router::new()
        .handler(create)
        .handler(listByItem)
        .handler(get)
        .handler(revoke)
        .handler(update)
        .handler(getAccessLogs)
        .handler(getPublicInfo)
        .handler(requestEmailVerification)
        .handler(verifyEmailAndAccess)
        .handler(accessPublic)
}
