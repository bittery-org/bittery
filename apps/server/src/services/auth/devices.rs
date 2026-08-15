use super::{LogoutResponse, MeResponse};
use sqlx::query_as;
use time::OffsetDateTime;

use crate::{
    db::enums::{TeamRole, TeamType},
    error::AppError,
    repo::common::{hash_token, insert_audit_event},
    services::{
        session::{
            format_rfc3339, generate_opaque_session_token, is_grouped_client_session,
            DeviceSessionResponse, RefreshSessionResponse, RenameDeviceInput, SessionIdInput,
            VerifiedSession,
        },
        session_control::record_session_revocations,
        transaction::database_error,
    },
    AppState,
};
pub(crate) async fn get_me(
    app_state: &AppState,
    session: &VerifiedSession,
) -> Result<MeResponse, AppError> {
    let pool = &app_state.db_pool;
    let user = query_as::<_, DbMeRow>(
		"SELECT u.id, u.email, u.name, u.team_id, t.name AS team_name, t.type::text AS team_type, t.image_key AS team_image_key, u.role::text AS role, u.secret_key_hint, u.public_key, u.encrypted_private_key, u.encrypted_master_key, u.created_at FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(&session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load user"))?
	.ok_or_else(|| AppError::not_found("User not found"))?;

    Ok(MeResponse {
        id: user.id,
        email: user.email,
        name: user.name,
        team_id: user.team_id,
        team_name: user.team_name,
        team_type: user.team_type,
        team_avatar_url: user
            .team_image_key
            .as_deref()
            .and_then(|key| app_state.object_storage.public_url(key)),
        role: user.role,
        secret_key_hint: user.secret_key_hint,
        public_key: user.public_key,
        encrypted_private_key: user.encrypted_private_key,
        has_recovery_key: user.encrypted_master_key.is_some(),
        created_at: format_rfc3339(user.created_at),
    })
}

pub(crate) async fn list_devices(
    app_state: &AppState,
    session: &VerifiedSession,
) -> Result<Vec<DeviceSessionResponse>, AppError> {
    app_state
        .sessions
        .list_devices(&session.user_id, &session.session_id)
        .await
}

pub(crate) async fn revoke_device(
    app_state: &AppState,
    session: &VerifiedSession,
    input: SessionIdInput,
) -> Result<LogoutResponse, AppError> {
    if input.session_id == session.session_id {
        return Err(AppError::bad_request(
            "Cannot revoke current session. Use logout instead.",
        ));
    }

    let target_session = app_state
        .sessions
        .get_owned_session(&input.session_id, &session.user_id)
        .await?;
    let current_session = app_state
        .sessions
        .get_owned_session(&session.session_id, &session.user_id)
        .await?;

    if let (Some(target_session), Some(current_session)) = (&target_session, &current_session) {
        if is_grouped_client_session(target_session)
            && is_grouped_client_session(current_session)
            && target_session.client_id == current_session.client_id
        {
            return Err(AppError::bad_request(
                "Cannot revoke current session. Use logout instead.",
            ));
        }
    }

    let revoked_session_ids = app_state
        .sessions
        .revoke_device(&input.session_id, &session.user_id)
        .await?;

    if !revoked_session_ids.is_empty() {
        for revoked_session_id in &revoked_session_ids {
            app_state.sync_pubsub.notify_session_revoked(
                &session.user_id,
                revoked_session_id,
                "device_revoked",
            );
        }

        record_session_revocations(
            &app_state.db_pool,
            &session.user_id,
            &revoked_session_ids,
            "device_revoked",
        )
        .await
        .map_err(|error| database_error(error, "Failed to record session revocations"))?;
        insert_audit_event(
            &app_state.db_pool,
            &format!(
                "audit_{}",
                &hash_token(&generate_opaque_session_token())[..16]
            ),
            &session.user_id,
            "device_revoked",
            "session",
            &input.session_id,
            None,
        )
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to record device revoke audit event");
            AppError::internal("Failed to record device revoke audit event")
        })?;
    }

    Ok(LogoutResponse { success: true })
}

pub(crate) async fn rename_device(
    app_state: &AppState,
    session: &VerifiedSession,
    input: RenameDeviceInput,
) -> Result<LogoutResponse, AppError> {
    if input.device_name.trim().is_empty() || input.device_name.len() > 100 {
        return Err(AppError::bad_request(
            "Device name must be between 1 and 100 characters",
        ));
    }

    app_state
        .sessions
        .rename_device(
            &input.session_id,
            &session.user_id,
            input.device_name.trim(),
        )
        .await?;
    Ok(LogoutResponse { success: true })
}

pub(crate) async fn do_refresh_session(
    app_state: &AppState,
    session: &VerifiedSession,
) -> Result<RefreshSessionResponse, AppError> {
    app_state.sessions.refresh_session(session).await
}
#[derive(Debug, sqlx::FromRow)]
struct DbMeRow {
    id: String,
    email: String,
    name: String,
    team_id: Option<String>,
    team_name: Option<String>,
    team_type: Option<TeamType>,
    team_image_key: Option<String>,
    role: TeamRole,
    secret_key_hint: Option<String>,
    public_key: String,
    encrypted_private_key: String,
    encrypted_master_key: Option<String>,
    created_at: OffsetDateTime,
}
