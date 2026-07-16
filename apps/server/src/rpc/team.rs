use qubit::{handler, server::Router};

use crate::{
    config::db_pool,
    error::AppError,
    services::access::{get_member_access, MemberAccessInput, MemberAccessResponse},
    services::auth::{AppContext, RefreshSessionContext},
    services::team::{self, invitation_handlers, member_handlers, *},
    AppState, NotifySyncExt,
};

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getByToken(
    ctx: AppContext,
    input: TokenInput,
) -> Result<TeamInvitationDetailsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::get_invitation_by_token(pool, input).await
}

#[handler(query)]
pub async fn pending(
    ctx: RefreshSessionContext,
) -> Result<Vec<PendingTeamInvitationResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::get_pending_invitations(pool, &ctx.session.user_id).await
}

#[handler(query)]
pub async fn list(ctx: RefreshSessionContext) -> Result<TeamSummaryResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::list_teams(pool, &ctx.session.user_id).await
}

#[handler(query)]
pub async fn get(
    ctx: RefreshSessionContext,
    input: TeamIdInput,
) -> Result<TeamDetailsResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::get_team(pool, &ctx.session.user_id, input).await
}

#[handler(query)]
pub async fn vaults(
    ctx: RefreshSessionContext,
    input: TeamIdInput,
) -> Result<Vec<TeamVaultResponse>, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::get_team_vaults(pool, &ctx.session.user_id, input).await
}

#[handler(mutation)]
pub async fn create(
    ctx: RefreshSessionContext,
    input: CreateTeamInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::create_team(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn update(
    ctx: RefreshSessionContext,
    input: UpdateTeamInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::update_team(pool, &ctx.session.user_id, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createImageUpload(
    ctx: RefreshSessionContext,
    input: CreateImageUploadInput,
) -> Result<crate::integrations::storage::PresignedUploadResult, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::create_team_image_upload(pool, &ctx.session.user_id, input).await
}

#[handler(mutation)]
pub async fn delete(
    ctx: RefreshSessionContext,
    input: TeamIdInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::delete_team(pool, &ctx.session.user_id, input).await
}

#[handler(mutation)]
pub async fn leave(
    ctx: RefreshSessionContext,
    input: LeaveTeamInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::leave_team(
        pool,
        &ctx.session.user_id,
        ctx.request.client_id.as_deref(),
        input,
    )
    .await
    .notify_sync(&ctx.app_state)
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getLeaveRotationData(
    ctx: RefreshSessionContext,
    input: TeamIdInput,
) -> Result<RotationDataResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::get_leave_rotation_data(pool, &ctx.session.user_id, input).await
}

#[handler(mutation)]
pub async fn send(
    ctx: RefreshSessionContext,
    input: SendInvitationInput,
) -> Result<SendInvitationResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::send_invitation(pool, &ctx.session.user_id, input).await
}

#[handler(mutation)]
pub async fn accept(
    ctx: RefreshSessionContext,
    input: TokenInput,
) -> Result<AcceptInvitationResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::accept_invitation(pool, &ctx.session.user_id, input).await
}

#[handler(mutation)]
pub async fn decline(
    ctx: RefreshSessionContext,
    input: TokenInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::decline_invitation(pool, &ctx.session.user_id, input).await
}

#[handler(mutation)]
pub async fn cancel(
    ctx: RefreshSessionContext,
    input: InvitationIdInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::cancel_invitation(pool, &ctx.session.user_id, input).await
}

#[handler(mutation)]
pub async fn resend(
    ctx: RefreshSessionContext,
    input: InvitationIdInput,
) -> Result<SuccessResponse, AppError> {
    let pool = db_pool(&ctx.app_state)?;
    team::resend_invitation(pool, &ctx.session.user_id, input).await
}

// --- Member handlers ---

mod rpc_member_handlers {
    use super::*;

    #[handler(query)]
    pub async fn list(
        ctx: RefreshSessionContext,
        input: TeamIdInput,
    ) -> Result<Vec<TeamMemberResponse>, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::list_team_members(pool, &ctx.session.user_id, input).await
    }

    #[handler(query)]
    pub async fn access(
        ctx: RefreshSessionContext,
        input: MemberAccessInput,
    ) -> Result<MemberAccessResponse, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        get_member_access(pool, &ctx.session.user_id, input).await
    }

    #[allow(non_snake_case)]
    #[handler(query)]
    pub async fn getTeamRotationData(
        ctx: RefreshSessionContext,
        input: TeamRotationInput,
    ) -> Result<RotationDataResponse, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::get_team_rotation_data(pool, &ctx.session.user_id, input).await
    }

    #[allow(non_snake_case)]
    #[handler(mutation)]
    pub async fn remove(
        ctx: RefreshSessionContext,
        input: RemoveTeamMemberInput,
    ) -> Result<RemoveTeamMemberResponse, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::remove_team_member(
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
    pub async fn deleteAccount(
        ctx: RefreshSessionContext,
        input: DeleteAccountInput,
    ) -> Result<SuccessResponse, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        member_handlers::delete_team_account(pool, &ctx.session.user_id, input).await
    }
}

// --- Invitation list handler ---

mod rpc_invitation_handlers {
    use super::*;

    #[handler(query)]
    pub async fn list(
        ctx: RefreshSessionContext,
        input: TeamIdInput,
    ) -> Result<Vec<invitation_handlers::TeamInvitationListEntry>, AppError> {
        let pool = db_pool(&ctx.app_state)?;
        invitation_handlers::list_team_invitations(pool, &ctx.session.user_id, input).await
    }
}

pub fn create_team_router() -> Router<AppState> {
    Router::new()
        .handler(list)
        .handler(get)
        .handler(vaults)
        .handler(create)
        .handler(update)
        .handler(createImageUpload)
        .handler(delete)
        .handler(leave)
        .handler(getLeaveRotationData)
        .nest("members", create_team_members_router())
        .nest("invitations", create_team_invitations_router())
}

fn create_team_invitations_router() -> Router<AppState> {
    Router::new()
        .handler(getByToken)
        .handler(rpc_invitation_handlers::list)
        .handler(pending)
        .handler(send)
        .handler(accept)
        .handler(cancel)
        .handler(resend)
        .handler(decline)
}

fn create_team_members_router() -> Router<AppState> {
    Router::new()
        .handler(rpc_member_handlers::list)
        .handler(rpc_member_handlers::access)
        .handler(rpc_member_handlers::getTeamRotationData)
        .handler(rpc_member_handlers::remove)
        .handler(rpc_member_handlers::deleteAccount)
}
