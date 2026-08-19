use sqlx::FromRow;
use time::OffsetDateTime;

use crate::db::enums::{BillingPlan, BillingStatus, TeamRole};

#[derive(Clone, Debug, FromRow)]
pub struct DbBillingActorRow {
    pub user_id: String,
    pub team_id: Option<String>,
    pub role: TeamRole,
    pub email: String,
    pub name: String,
    pub owner_id: Option<String>,
    pub billing_plan: Option<BillingPlan>,
    pub billing_status: Option<BillingStatus>,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub stripe_subscription_item_id: Option<String>,
    pub stripe_price_id: Option<String>,
    pub current_period_end: Option<OffsetDateTime>,
    pub cancel_at_period_end: Option<bool>,
    pub seats_purchased: Option<i32>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbBillingContactRow {
    pub id: String,
    pub email: String,
    pub name: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamBillingEntitlementRow {
    pub team_id: Option<String>,
    pub billing_plan: Option<BillingPlan>,
    pub billing_status: Option<BillingStatus>,
}
