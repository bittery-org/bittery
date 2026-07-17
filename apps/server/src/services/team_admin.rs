use sqlx::PgPool;

use crate::{
    config::{bittery_mode, SELF_HOSTED_MODE},
    error::AppError,
    repo::audit::load_actor,
    services::team_billing::team_management_enabled,
};

/// Proof that a caller is the owner/admin of a team entitled to the admin console.
///
/// Only obtainable through [`authorize_team_admin`], so any handler holding one has
/// already passed the role, plan, and billing checks.
#[derive(Debug, Clone)]
pub(crate) struct TeamAdmin {
    pub team_id: String,
}

/// Gate for every admin-console query.
///
/// The console exposes one member's footprint to another user, so this is the single
/// place that decides who may look. Keep it that way — callers must not re-derive it.
pub(crate) async fn authorize_team_admin(
    pool: &PgPool,
    user_id: &str,
) -> Result<TeamAdmin, AppError> {
    let actor = load_actor(pool, user_id).await?;
    let team_id = actor
        .team_id
        .clone()
        .ok_or_else(|| AppError::not_found("Team not found"))?;

    if actor.role != "owner" && actor.role != "admin" {
        return Err(AppError::forbidden(
            "Only team owner or admin can access this console",
        ));
    }

    if bittery_mode() != SELF_HOSTED_MODE && actor.billing_plan.as_deref() != Some("team") {
        return Err(AppError::forbidden(
            "This console is only available on Team plans",
        ));
    }

    if !team_management_enabled(
        bittery_mode(),
        Some("team"),
        actor.billing_status.as_deref(),
    ) {
        return Err(AppError::forbidden(
            "Team management is unavailable until billing is active",
        ));
    }

    Ok(TeamAdmin { team_id })
}
