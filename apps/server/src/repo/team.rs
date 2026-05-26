use sqlx::{query_as, PgPool};

use crate::db::models::DbTeamMembershipActorRow;
use crate::error::AppError;

pub async fn load_team_membership_actor(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<DbTeamMembershipActorRow>, AppError> {
    query_as::<_, DbTeamMembershipActorRow>(
		"SELECT u.id, u.team_id, u.role::text AS role, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|_| AppError::internal("Failed to load team membership"))
}
