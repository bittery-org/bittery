use qubit::{handler, Router};

use crate::{
    error::AppError,
    services::auth::{self, AppContext, PublicAuthContext, RefreshSessionContext, *},
    services::session::{
        DeviceSessionResponse, RefreshSessionResponse, RenameDeviceInput, SessionIdInput,
    },
    AppState,
};

// --- Public auth handlers (no session required) ---

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn requestSignupVerification(
    ctx: PublicAuthContext,
    input: RequestSignupVerificationInput,
) -> Result<LogoutResponse, AppError> {
    auth::request_signup_verification(&ctx.app_state, &ctx.request, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn verifySignupVerification(
    ctx: PublicAuthContext,
    input: VerifySignupVerificationInput,
) -> Result<VerifySignupVerificationResponse, AppError> {
    auth::verify_signup_verification(&ctx.app_state, &ctx.request, input).await
}

#[handler(mutation)]
pub async fn signup(
    ctx: PublicAuthContext,
    input: SignupInput,
) -> Result<SignupResponse, AppError> {
    auth::signup(&ctx.app_state, &ctx.request, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn signupWithInvitation(
    ctx: PublicAuthContext,
    input: SignupWithInvitationInput,
) -> Result<SignupResponse, AppError> {
    auth::signup_with_invitation(&ctx.app_state, &ctx.request, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn startLogin(
    ctx: PublicAuthContext,
    input: StartLoginInput,
) -> Result<StartLoginResponse, AppError> {
    auth::start_login(&ctx.app_state, &ctx.request, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn finishLogin(
    ctx: PublicAuthContext,
    input: FinishLoginInput,
) -> Result<FinishLoginResponse, AppError> {
    auth::finish_login(&ctx.app_state, &ctx.request, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn requestRecoveryVerification(
    ctx: PublicAuthContext,
    input: RequestRecoveryVerificationInput,
) -> Result<LogoutResponse, AppError> {
    auth::request_recovery_verification(&ctx.app_state, &ctx.request, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn verifyRecoveryCode(
    ctx: PublicAuthContext,
    input: VerifyRecoveryCodeInput,
) -> Result<VerifyRecoveryCodeResponse, AppError> {
    auth::verify_recovery_code(&ctx.app_state, &ctx.request, input).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getRecoveryData(
    ctx: PublicAuthContext,
    input: GetRecoveryDataInput,
) -> Result<GetRecoveryDataResponse, AppError> {
    auth::get_recovery_data(&ctx.app_state, &ctx.request, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn resetPassword(
    ctx: PublicAuthContext,
    input: ResetPasswordInput,
) -> Result<ResetPasswordResponse, AppError> {
    auth::reset_password(&ctx.app_state, &ctx.request, input).await
}

// --- AppContext handlers ---

#[allow(non_snake_case)]
#[handler(query)]
pub async fn registrationStatus(ctx: AppContext) -> Result<RegistrationStatusResponse, AppError> {
    auth::registration_status(&ctx.app_state).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn checkEmail(
    ctx: AppContext,
    input: CheckEmailInput,
) -> Result<CheckEmailResponse, AppError> {
    auth::check_email(&ctx.app_state, input).await
}

// --- Authenticated handlers ---

#[handler(query)]
pub async fn me(ctx: RefreshSessionContext) -> Result<MeResponse, AppError> {
    auth::get_me(&ctx.app_state, &ctx.session).await
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listDevices(
    ctx: RefreshSessionContext,
) -> Result<Vec<DeviceSessionResponse>, AppError> {
    auth::list_devices(&ctx.app_state, &ctx.session).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn updateEmail(
    ctx: RefreshSessionContext,
    input: UpdateEmailInput,
) -> Result<LogoutResponse, AppError> {
    auth::update_email(&ctx.app_state, &ctx.session, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn changePassword(
    ctx: RefreshSessionContext,
    input: ChangePasswordInput,
) -> Result<LogoutResponse, AppError> {
    auth::change_password(&ctx.app_state, &ctx.session, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn regenerateSecretKey(
    ctx: RefreshSessionContext,
    input: RegenerateSecretKeyInput,
) -> Result<LogoutResponse, AppError> {
    auth::regenerate_secret_key(&ctx.app_state, &ctx.session, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn storeRecoveryKey(
    ctx: RefreshSessionContext,
    input: StoreRecoveryKeyInput,
) -> Result<LogoutResponse, AppError> {
    auth::store_recovery_key(&ctx.app_state, &ctx.session, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn deleteAccount(
    ctx: RefreshSessionContext,
    input: DeleteAccountInput,
) -> Result<LogoutResponse, AppError> {
    auth::delete_account(&ctx.app_state, &ctx.session, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn revokeDevice(
    ctx: RefreshSessionContext,
    input: SessionIdInput,
) -> Result<LogoutResponse, AppError> {
    auth::revoke_device(&ctx.app_state, &ctx.session, input).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn renameDevice(
    ctx: RefreshSessionContext,
    input: RenameDeviceInput,
) -> Result<LogoutResponse, AppError> {
    auth::rename_device(&ctx.app_state, &ctx.session, input).await
}

#[handler(mutation)]
pub async fn heartbeat(ctx: RefreshSessionContext) -> Result<LogoutResponse, AppError> {
    auth::do_heartbeat(&ctx.app_state, &ctx.session).await
}

#[handler(mutation)]
pub async fn logout(ctx: RefreshSessionContext) -> Result<LogoutResponse, AppError> {
    auth::do_logout(&ctx.app_state, &ctx.session).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn logoutAll(ctx: RefreshSessionContext) -> Result<LogoutResponse, AppError> {
    auth::do_logout_all(&ctx.app_state, &ctx.session).await
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn refreshSession(
    ctx: RefreshSessionContext,
) -> Result<RefreshSessionResponse, AppError> {
    auth::do_refresh_session(&ctx.app_state, &ctx.session).await
}

pub fn create_auth_router() -> Router<AppState> {
    Router::new()
        .handler(registrationStatus)
        .handler(requestSignupVerification)
        .handler(verifySignupVerification)
        .handler(signup)
        .handler(signupWithInvitation)
        .handler(startLogin)
        .handler(finishLogin)
        .handler(requestRecoveryVerification)
        .handler(verifyRecoveryCode)
        .handler(getRecoveryData)
        .handler(resetPassword)
        .handler(checkEmail)
        .handler(me)
        .handler(updateEmail)
        .handler(changePassword)
        .handler(regenerateSecretKey)
        .handler(storeRecoveryKey)
        .handler(deleteAccount)
        .handler(listDevices)
        .handler(revokeDevice)
        .handler(renameDevice)
        .handler(heartbeat)
        .handler(logout)
        .handler(logoutAll)
        .handler(refreshSession)
}
