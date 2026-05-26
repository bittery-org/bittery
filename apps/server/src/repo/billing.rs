use sqlx::{query_as, query_scalar, PgPool};

use crate::db::models::{DbBillingActorRow, DbBillingContactRow};
use crate::error::AppError;

pub async fn load_billing_actor(
    pool: &PgPool,
    user_id: &str,
) -> Result<DbBillingActorRow, AppError> {
    query_as::<_, DbBillingActorRow>(
		"SELECT u.id AS user_id, u.team_id, u.role::text AS role, u.email, u.name, t.owner_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, t.stripe_customer_id, t.stripe_subscription_id, t.stripe_subscription_item_id, t.stripe_price_id, t.current_period_end, t.cancel_at_period_end, t.seats_purchased FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load billing actor"); AppError::internal("Failed to load billing actor") })?
	.ok_or_else(|| AppError::not_found("Team not found"))
}

pub async fn load_optional_billing_state(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<DbBillingActorRow>, AppError> {
    query_as::<_, DbBillingActorRow>(
		"SELECT u.id AS user_id, u.team_id, u.role::text AS role, u.email, u.name, t.owner_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, t.stripe_customer_id, t.stripe_subscription_id, t.stripe_subscription_item_id, t.stripe_price_id, t.current_period_end, t.cancel_at_period_end, t.seats_purchased FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load billing actor"); AppError::internal("Failed to load billing actor") })
}

pub async fn load_billing_contact(
    pool: &PgPool,
    user_id: &str,
    team_id: &str,
) -> Result<Option<DbBillingContactRow>, AppError> {
    query_as::<_, DbBillingContactRow>(
        "SELECT id, email, name FROM \"user\" WHERE id = $1 AND team_id = $2 LIMIT 1",
    )
    .bind(user_id)
    .bind(team_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load billing contact");
        AppError::internal("Failed to load billing contact")
    })
}

pub async fn count_team_members(pool: &PgPool, team_id: &str) -> Result<i64, AppError> {
    query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE team_id = $1")
        .bind(team_id)
        .fetch_one(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to count team members");
            AppError::internal("Failed to count team members")
        })
}

pub async fn get_committed_attachment_storage_bytes(
    pool: &PgPool,
    team_id: &str,
) -> Result<i64, AppError> {
    query_scalar::<_, i64>(
		"SELECT COALESCE(SUM(ia.storage_size), 0)::bigint AS total FROM item_attachment ia INNER JOIN \"user\" u ON ia.uploaded_by = u.id WHERE u.team_id = $1",
	)
	.bind(team_id)
	.fetch_one(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load attachment usage"); AppError::internal("Failed to load attachment usage") })
}
