mod stripe;
mod webhook;

use qubit::{
    builder::IntoResponse,
    handler,
    server::{ErrorCode, Router, RpcError},
};
use serde::{Deserialize, Serialize};
use sqlx::{query, query_as, query_scalar, PgPool};
use time::OffsetDateTime;
use ts_rs::TS;

use self::stripe::{
    create_billing_portal_session as stripe_create_billing_portal_session_impl,
    create_checkout_session as stripe_create_checkout_session_impl,
    create_customer as stripe_create_customer_impl,
    preview_upcoming_team_seat_invoice as stripe_preview_upcoming_team_seat_invoice_impl,
    update_subscription_item_quantity as stripe_update_subscription_item_quantity_impl,
    CheckoutSession, CheckoutSessionInput, StripeClientError, TeamSeatInvoicePreview,
};
pub(crate) use self::webhook::{
    is_self_hosted_mode, is_stripe_webhook_configured, process_stripe_webhook_event,
};
use crate::{
    auth::RefreshSessionContext,
    db::models::{DbBillingActorRow, DbBillingContactRow},
    AppState,
};

const MB: i64 = 1024 * 1024;
const GB: i64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BillingStatusResponse {
    pub enabled: bool,
    pub plan: String,
    pub status: String,
    pub is_active: bool,
    pub requires_payment: bool,
    pub is_stripe_configured: bool,
    pub stripe_customer_id: Option<String>,
    pub stripe_subscription_id: Option<String>,
    pub stripe_price_id: Option<String>,
    pub current_period_end: Option<String>,
    pub cancel_at_period_end: bool,
    pub seats_purchased: Option<i32>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BillingEntitlements {
    pub sentinel: bool,
    pub team_management: bool,
    pub vault_sharing: bool,
    pub share_links: bool,
    pub billing_portal: bool,
    pub attachments: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EntitlementLimits {
    pub share_links: Option<i64>,
    pub shared_vaults: Option<i64>,
    pub attachment_max_file_size_bytes: Option<i64>,
    pub attachment_storage_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BillingEntitlementsResponse {
    pub mode: String,
    pub plan: String,
    pub status: String,
    pub is_active: bool,
    pub entitlements: BillingEntitlements,
    pub limits: EntitlementLimits,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentUsageResponse {
    pub mode: String,
    pub attachments_enabled: bool,
    pub quota_bytes: Option<i64>,
    pub committed_storage_bytes: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutPlanInput {
    pub plan: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutSessionResponse {
    pub url: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PortalSessionResponse {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyncSeatsInput {
    pub team_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyncSeatsResponse {
    pub synced: bool,
    pub reason: Option<String>,
    pub quantity: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamSeatInvoicePreviewLineResponse {
    pub id: String,
    pub description: String,
    pub amount_cents: i64,
    pub currency: String,
    pub period_start: String,
    pub period_end: String,
    pub quantity: Option<i64>,
    pub unit_amount_cents: Option<i64>,
    pub is_proration: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamSeatInvoicePreviewResponse {
    pub currency: String,
    pub current_quantity: i64,
    pub next_quantity: i64,
    pub estimated_next_payment_cents: i64,
    pub total_line_items_cents: i64,
    pub lines: Vec<TeamSeatInvoicePreviewLineResponse>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct BillingRpcError {
    pub code: String,
    pub message: String,
}

struct BillingSnapshot {
    entitlements: BillingEntitlements,
    limits: EntitlementLimits,
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn status(ctx: RefreshSessionContext) -> Result<BillingStatusResponse, BillingRpcError> {
    if bittery_mode() == "self-hosted" {
        return Ok(self_hosted_billing_status());
    }

    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let actor = load_billing_actor(pool, &ctx.session.user_id).await?;
    actor
        .team_id
        .clone()
        .ok_or_else(|| not_found_error("Team not found"))?;
    let team = ensure_team_billing(actor)?;
    let requires_payment = team.billing_plan != "free";

    Ok(BillingStatusResponse {
        enabled: true,
        plan: team.billing_plan,
        status: team.billing_status.clone(),
        is_active: is_billing_active(&team.billing_status),
        requires_payment,
        is_stripe_configured: is_stripe_api_configured(),
        stripe_customer_id: team.stripe_customer_id,
        stripe_subscription_id: team.stripe_subscription_id,
        stripe_price_id: team.stripe_price_id,
        current_period_end: team.current_period_end.map(format_timestamp),
        cancel_at_period_end: team.cancel_at_period_end,
        seats_purchased: team.seats_purchased,
    })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn entitlements(
    ctx: RefreshSessionContext,
) -> Result<BillingEntitlementsResponse, BillingRpcError> {
    let mode = bittery_mode().to_string();
    if mode == "self-hosted" {
        let state = match ctx.app_state.db_pool.as_ref() {
            Some(pool) => load_optional_billing_state(pool, &ctx.session.user_id).await?,
            None => None,
        };
        let plan = state
            .as_ref()
            .and_then(|actor| actor.billing_plan.clone())
            .unwrap_or_else(|| "team".to_string());
        let billing_status = state
            .as_ref()
            .and_then(|actor| actor.billing_status.clone())
            .unwrap_or_else(|| "active".to_string());
        let snapshot = get_billing_snapshot(&mode, &plan, &billing_status);

        return Ok(BillingEntitlementsResponse {
            mode,
            plan,
            status: billing_status.clone(),
            is_active: is_billing_active(&billing_status),
            entitlements: snapshot.entitlements,
            limits: snapshot.limits,
        });
    }

    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let actor = load_billing_actor(pool, &ctx.session.user_id).await?;
    actor
        .team_id
        .clone()
        .ok_or_else(|| not_found_error("Team not found"))?;
    let team = ensure_team_billing(actor)?;
    let snapshot = get_billing_snapshot(&mode, &team.billing_plan, &team.billing_status);

    Ok(BillingEntitlementsResponse {
        mode,
        plan: team.billing_plan,
        status: team.billing_status.clone(),
        is_active: is_billing_active(&team.billing_status),
        entitlements: snapshot.entitlements,
        limits: snapshot.limits,
    })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn attachmentUsage(
    ctx: RefreshSessionContext,
) -> Result<AttachmentUsageResponse, BillingRpcError> {
    let mode = bittery_mode().to_string();
    if mode == "self-hosted" {
        return Ok(AttachmentUsageResponse {
            mode,
            attachments_enabled: true,
            quota_bytes: None,
            committed_storage_bytes: 0,
        });
    }

    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let actor = load_billing_actor(pool, &ctx.session.user_id).await?;
    let team_id = actor
        .team_id
        .clone()
        .ok_or_else(|| not_found_error("Team not found"))?;
    let team = ensure_team_billing(actor)?;
    let snapshot = get_billing_snapshot(&mode, &team.billing_plan, &team.billing_status);

    Ok(AttachmentUsageResponse {
        mode,
        attachments_enabled: snapshot.entitlements.attachments,
        quota_bytes: snapshot.limits.attachment_storage_bytes,
        committed_storage_bytes: get_committed_attachment_storage_bytes(pool, &team_id).await?,
    })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createCheckoutSession(
    ctx: RefreshSessionContext,
    input: CheckoutPlanInput,
) -> Result<CheckoutSessionResponse, BillingRpcError> {
    assert_cloud_billing_enabled()?;

    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let actor = load_billing_actor(pool, &ctx.session.user_id).await?;
    let team_id = actor
        .team_id
        .clone()
        .ok_or_else(|| not_found_error("Team not found"))?;
    let team = ensure_team_billing(actor.clone())?;
    ensure_billing_admin(&actor.role)?;

    let target_plan = input
        .plan
        .as_deref()
        .unwrap_or(team.billing_plan.as_str())
        .to_string();
    if !is_paid_plan(&target_plan) {
        return Err(bad_request_error("Free plan does not require checkout"));
    }

    if team.stripe_subscription_id.is_some()
        && is_billing_active(&team.billing_status)
        && team.billing_plan == target_plan
    {
        return Err(bad_request_error(
            "Subscription is already active for this plan",
        ));
    }

    let stripe_price_id = get_stripe_price_id(&target_plan).ok_or_else(|| {
        internal_error(&format!("Missing Stripe price ID for {target_plan} plan"))
    })?;
    let quantity = if target_plan == "team" {
        count_team_members(pool, &team_id).await?.max(1)
    } else {
        1
    };
    let customer_id = ensure_team_stripe_customer(pool, &actor, &team_id).await?;
    let base_url = web_app_url().trim_end_matches('/').to_string();
    let checkout = stripe_create_checkout_session(CheckoutSessionInput {
        team_id: &team_id,
        user_id: &ctx.session.user_id,
        customer_id: customer_id.as_deref(),
        customer_email: &actor.email,
        plan: &target_plan,
        price_id: &stripe_price_id,
        quantity,
        success_url: format!("{base_url}/billing?checkout=success"),
        cancel_url: format!("{base_url}/billing?checkout=cancel"),
    })
    .await
    .map_err(|error| internal_error(&error.to_string()))?;

    let redirect_url = checkout
        .url
        .ok_or_else(|| internal_error("Stripe checkout session has no redirect URL"))?;

    query(
		"UPDATE team SET billing_plan = $1::billing_plan, billing_status = 'incomplete', updated_at = $2 WHERE id = $3",
	)
	.bind(&target_plan)
	.bind(OffsetDateTime::now_utc())
	.bind(&team_id)
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to update team billing state"); internal_error("Failed to update team billing state") })?;

    Ok(CheckoutSessionResponse {
        url: redirect_url,
        session_id: checkout.id,
    })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createPortalSession(
    ctx: RefreshSessionContext,
) -> Result<PortalSessionResponse, BillingRpcError> {
    assert_cloud_billing_enabled()?;

    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let actor = load_billing_actor(pool, &ctx.session.user_id).await?;
    let team = ensure_team_billing(actor.clone())?;
    ensure_billing_admin(&actor.role)?;

    let snapshot = get_billing_snapshot(bittery_mode(), &team.billing_plan, &team.billing_status);
    if !snapshot.entitlements.billing_portal {
        return Err(forbidden_error(
            "Billing portal is unavailable for your current plan",
        ));
    }

    let stripe_customer_id = team
        .stripe_customer_id
        .as_deref()
        .ok_or_else(|| bad_request_error("No Stripe customer found for this team"))?;
    let base_url = web_app_url().trim_end_matches('/').to_string();
    let url =
        stripe_create_billing_portal_session(stripe_customer_id, &format!("{base_url}/billing"))
            .await
            .map_err(|error| internal_error(&error.to_string()))?;

    Ok(PortalSessionResponse { url })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn syncSeats(
    ctx: RefreshSessionContext,
    input: SyncSeatsInput,
) -> Result<SyncSeatsResponse, BillingRpcError> {
    assert_cloud_billing_enabled()?;

    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let actor = load_billing_actor(pool, &ctx.session.user_id).await?;
    let team_id = actor
        .team_id
        .clone()
        .ok_or_else(|| not_found_error("Team not found"))?;
    let team = ensure_team_billing(actor.clone())?;
    ensure_billing_admin(&actor.role)?;

    let target_team_id = input.team_id.unwrap_or_else(|| team_id.clone());
    if target_team_id != team_id {
        return Err(forbidden_error("You can only sync seats for your own team"));
    }

    if team.billing_plan != "team" {
        return Ok(SyncSeatsResponse {
            synced: false,
            reason: Some("not_team_plan".to_string()),
            quantity: None,
        });
    }
    let subscription_item_id = match team.stripe_subscription_item_id.as_deref() {
        Some(value) => value,
        None => {
            return Ok(SyncSeatsResponse {
                synced: false,
                reason: Some("missing_subscription_item".to_string()),
                quantity: None,
            })
        }
    };

    let quantity = count_team_members(pool, &target_team_id).await?.max(1);
    stripe_update_subscription_item_quantity(subscription_item_id, quantity)
        .await
        .map_err(|error| internal_error(&error.to_string()))?;

    query("UPDATE team SET seats_purchased = $1, updated_at = $2 WHERE id = $3")
        .bind(quantity as i32)
        .bind(OffsetDateTime::now_utc())
        .bind(&target_team_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to update purchased seats");
            internal_error("Failed to update purchased seats")
        })?;

    Ok(SyncSeatsResponse {
        synced: true,
        reason: None,
        quantity: Some(quantity),
    })
}

pub(crate) async fn sync_team_seats_best_effort(pool: &PgPool, team_id: &str, billing_plan: &str) {
    if billing_plan != "team" || !is_stripe_api_configured() {
        return;
    }

    let subscription_item_id = match query_scalar::<_, Option<String>>(
        "SELECT stripe_subscription_item_id FROM team WHERE id = $1 LIMIT 1",
    )
    .bind(team_id)
    .fetch_optional(pool)
    .await
    {
        Ok(Some(Some(value))) if !value.trim().is_empty() => value,
        _ => return,
    };

    let quantity = match count_team_members(pool, team_id).await {
        Ok(value) => value.max(1),
        Err(_) => return,
    };

    if stripe_update_subscription_item_quantity(&subscription_item_id, quantity)
        .await
        .is_err()
    {
        return;
    }

    let _ = query("UPDATE team SET seats_purchased = $1, updated_at = $2 WHERE id = $3")
        .bind(quantity as i32)
        .bind(OffsetDateTime::now_utc())
        .bind(team_id)
        .execute(pool)
        .await;
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn previewAdditionalTeamSeat(
    ctx: RefreshSessionContext,
) -> Result<Option<TeamSeatInvoicePreviewResponse>, BillingRpcError> {
    assert_cloud_billing_enabled()?;

    let pool = ctx
        .app_state
        .db_pool
        .as_ref()
        .ok_or_else(|| internal_error("Database is not configured"))?;
    let actor = load_billing_actor(pool, &ctx.session.user_id).await?;
    ensure_billing_admin(&actor.role)?;
    let team = ensure_team_billing(actor)?;

    let Some(stripe_customer_id) = team.stripe_customer_id.as_deref() else {
        return Ok(None);
    };
    let Some(stripe_subscription_id) = team.stripe_subscription_id.as_deref() else {
        return Ok(None);
    };

    match stripe_preview_upcoming_team_seat_invoice(
        stripe_customer_id,
        stripe_subscription_id,
        team.stripe_subscription_item_id.as_deref(),
        team.seats_purchased,
        1,
    )
    .await
    {
        Ok(Some(preview)) => Ok(Some(TeamSeatInvoicePreviewResponse {
            currency: preview.currency,
            current_quantity: preview.current_quantity,
            next_quantity: preview.next_quantity,
            estimated_next_payment_cents: preview.estimated_next_payment_cents,
            total_line_items_cents: preview.total_line_items_cents,
            lines: preview
                .lines
                .into_iter()
                .map(|line| TeamSeatInvoicePreviewLineResponse {
                    id: line.id,
                    description: line.description,
                    amount_cents: line.amount_cents,
                    currency: line.currency,
                    period_start: format_timestamp(line.period_start),
                    period_end: format_timestamp(line.period_end),
                    quantity: line.quantity,
                    unit_amount_cents: line.unit_amount_cents,
                    is_proration: line.is_proration,
                })
                .collect(),
        })),
        Ok(None) | Err(_) => Ok(None),
    }
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

async fn stripe_create_customer(
    email: &str,
    name: &str,
    team_id: &str,
    user_id: &str,
) -> Result<String, StripeClientError> {
    #[cfg(test)]
    if let Some(result) = mock_stripe_create_customer(email, name, team_id, user_id) {
        return result;
    }

    stripe_create_customer_impl(email, name, team_id, user_id).await
}

async fn stripe_create_checkout_session(
    input: CheckoutSessionInput<'_>,
) -> Result<CheckoutSession, StripeClientError> {
    #[cfg(test)]
    if let Some(result) = mock_stripe_create_checkout_session(&input) {
        return result;
    }

    stripe_create_checkout_session_impl(input).await
}

async fn stripe_create_billing_portal_session(
    customer_id: &str,
    return_url: &str,
) -> Result<String, StripeClientError> {
    #[cfg(test)]
    if let Some(result) = mock_stripe_create_billing_portal_session(customer_id, return_url) {
        return result;
    }

    stripe_create_billing_portal_session_impl(customer_id, return_url).await
}

async fn stripe_update_subscription_item_quantity(
    subscription_item_id: &str,
    quantity: i64,
) -> Result<(), StripeClientError> {
    #[cfg(test)]
    if let Some(result) =
        mock_stripe_update_subscription_item_quantity(subscription_item_id, quantity)
    {
        return result;
    }

    stripe_update_subscription_item_quantity_impl(subscription_item_id, quantity).await
}

async fn stripe_preview_upcoming_team_seat_invoice(
    stripe_customer_id: &str,
    stripe_subscription_id: &str,
    stripe_subscription_item_id: Option<&str>,
    seats_purchased: Option<i32>,
    seat_increment: i64,
) -> Result<Option<TeamSeatInvoicePreview>, StripeClientError> {
    #[cfg(test)]
    if let Some(result) = mock_stripe_preview_upcoming_team_seat_invoice(
        stripe_customer_id,
        stripe_subscription_id,
        stripe_subscription_item_id,
        seats_purchased,
        seat_increment,
    ) {
        return result;
    }

    stripe_preview_upcoming_team_seat_invoice_impl(
        stripe_customer_id,
        stripe_subscription_id,
        stripe_subscription_item_id,
        seats_purchased,
        seat_increment,
    )
    .await
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq)]
enum StripeMockCall {
    CreateCustomer {
        email: String,
        name: String,
        team_id: String,
        user_id: String,
    },
    CreateCheckoutSession {
        team_id: String,
        user_id: String,
        customer_id: Option<String>,
        customer_email: String,
        plan: String,
        price_id: String,
        quantity: i64,
        success_url: String,
        cancel_url: String,
    },
    CreateBillingPortalSession {
        customer_id: String,
        return_url: String,
    },
    UpdateSubscriptionItemQuantity {
        subscription_item_id: String,
        quantity: i64,
    },
    PreviewUpcomingTeamSeatInvoice {
        stripe_customer_id: String,
        stripe_subscription_id: String,
        stripe_subscription_item_id: Option<String>,
        seats_purchased: Option<i32>,
        seat_increment: i64,
    },
}

#[cfg(test)]
#[derive(Clone)]
enum StripeMockResponse<T> {
    Ok(T),
    Err(String),
}

#[cfg(test)]
impl<T> StripeMockResponse<T>
where
    T: Clone,
{
    fn into_result(self) -> Result<T, StripeClientError> {
        match self {
            Self::Ok(value) => Ok(value),
            Self::Err(message) => Err(StripeClientError::RequestFailed(message)),
        }
    }
}

#[cfg(test)]
#[derive(Clone)]
struct StripeMockState {
    create_customer: StripeMockResponse<String>,
    create_checkout_session: StripeMockResponse<CheckoutSession>,
    create_billing_portal_session: StripeMockResponse<String>,
    update_subscription_item_quantity: StripeMockResponse<()>,
    preview_upcoming_team_seat_invoice: StripeMockResponse<Option<TeamSeatInvoicePreview>>,
    calls: Vec<StripeMockCall>,
}

#[cfg(test)]
impl Default for StripeMockState {
    fn default() -> Self {
        Self {
            create_customer: StripeMockResponse::Ok("cus_test_123".to_string()),
            create_checkout_session: StripeMockResponse::Ok(CheckoutSession {
                id: "cs_test_123".to_string(),
                url: Some("https://checkout.stripe.test/session/cs_test_123".to_string()),
            }),
            create_billing_portal_session: StripeMockResponse::Ok(
                "https://billing.stripe.test/portal/session_123".to_string(),
            ),
            update_subscription_item_quantity: StripeMockResponse::Ok(()),
            preview_upcoming_team_seat_invoice: StripeMockResponse::Ok(Some(
                TeamSeatInvoicePreview {
                    currency: "usd".to_string(),
                    current_quantity: 3,
                    next_quantity: 4,
                    estimated_next_payment_cents: 750,
                    total_line_items_cents: 750,
                    lines: vec![stripe::TeamSeatInvoicePreviewLine {
                        id: "il_preview_123".to_string(),
                        description: "Additional team seat".to_string(),
                        amount_cents: 750,
                        currency: "usd".to_string(),
                        period_start: OffsetDateTime::from_unix_timestamp(1_717_300_000)
                            .expect("preview period start should be valid"),
                        period_end: OffsetDateTime::from_unix_timestamp(1_719_892_800)
                            .expect("preview period end should be valid"),
                        quantity: Some(1),
                        unit_amount_cents: Some(750),
                        is_proration: true,
                    }],
                },
            )),
            calls: Vec::new(),
        }
    }
}

#[cfg(test)]
fn stripe_mock_state() -> &'static std::sync::Mutex<Option<StripeMockState>> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<Option<StripeMockState>>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(None))
}

#[cfg(test)]
fn replace_stripe_mock_state(new_state: Option<StripeMockState>) -> Option<StripeMockState> {
    std::mem::replace(
        &mut *stripe_mock_state()
            .lock()
            .expect("stripe mock state should be lockable"),
        new_state,
    )
}

#[cfg(test)]
fn stripe_mock_calls() -> Vec<StripeMockCall> {
    stripe_mock_state()
        .lock()
        .expect("stripe mock state should be lockable")
        .as_ref()
        .map(|state| state.calls.clone())
        .unwrap_or_default()
}

#[cfg(test)]
fn mock_stripe_create_customer(
    email: &str,
    name: &str,
    team_id: &str,
    user_id: &str,
) -> Option<Result<String, StripeClientError>> {
    let response = {
        let mut guard = stripe_mock_state()
            .lock()
            .expect("stripe mock state should be lockable");
        let state = guard.as_mut()?;
        state.calls.push(StripeMockCall::CreateCustomer {
            email: email.to_string(),
            name: name.to_string(),
            team_id: team_id.to_string(),
            user_id: user_id.to_string(),
        });
        state.create_customer.clone()
    };

    Some(response.into_result())
}

#[cfg(test)]
fn mock_stripe_create_checkout_session(
    input: &CheckoutSessionInput<'_>,
) -> Option<Result<CheckoutSession, StripeClientError>> {
    let response = {
        let mut guard = stripe_mock_state()
            .lock()
            .expect("stripe mock state should be lockable");
        let state = guard.as_mut()?;
        state.calls.push(StripeMockCall::CreateCheckoutSession {
            team_id: input.team_id.to_string(),
            user_id: input.user_id.to_string(),
            customer_id: input.customer_id.map(str::to_string),
            customer_email: input.customer_email.to_string(),
            plan: input.plan.to_string(),
            price_id: input.price_id.to_string(),
            quantity: input.quantity,
            success_url: input.success_url.clone(),
            cancel_url: input.cancel_url.clone(),
        });
        state.create_checkout_session.clone()
    };

    Some(response.into_result())
}

#[cfg(test)]
fn mock_stripe_create_billing_portal_session(
    customer_id: &str,
    return_url: &str,
) -> Option<Result<String, StripeClientError>> {
    let response = {
        let mut guard = stripe_mock_state()
            .lock()
            .expect("stripe mock state should be lockable");
        let state = guard.as_mut()?;
        state
            .calls
            .push(StripeMockCall::CreateBillingPortalSession {
                customer_id: customer_id.to_string(),
                return_url: return_url.to_string(),
            });
        state.create_billing_portal_session.clone()
    };

    Some(response.into_result())
}

#[cfg(test)]
fn mock_stripe_update_subscription_item_quantity(
    subscription_item_id: &str,
    quantity: i64,
) -> Option<Result<(), StripeClientError>> {
    let response = {
        let mut guard = stripe_mock_state()
            .lock()
            .expect("stripe mock state should be lockable");
        let state = guard.as_mut()?;
        state
            .calls
            .push(StripeMockCall::UpdateSubscriptionItemQuantity {
                subscription_item_id: subscription_item_id.to_string(),
                quantity,
            });
        state.update_subscription_item_quantity.clone()
    };

    Some(response.into_result())
}

#[cfg(test)]
fn mock_stripe_preview_upcoming_team_seat_invoice(
    stripe_customer_id: &str,
    stripe_subscription_id: &str,
    stripe_subscription_item_id: Option<&str>,
    seats_purchased: Option<i32>,
    seat_increment: i64,
) -> Option<Result<Option<TeamSeatInvoicePreview>, StripeClientError>> {
    let response = {
        let mut guard = stripe_mock_state()
            .lock()
            .expect("stripe mock state should be lockable");
        let state = guard.as_mut()?;
        state
            .calls
            .push(StripeMockCall::PreviewUpcomingTeamSeatInvoice {
                stripe_customer_id: stripe_customer_id.to_string(),
                stripe_subscription_id: stripe_subscription_id.to_string(),
                stripe_subscription_item_id: stripe_subscription_item_id.map(str::to_string),
                seats_purchased,
                seat_increment,
            });
        state.preview_upcoming_team_seat_invoice.clone()
    };

    Some(response.into_result())
}

#[derive(Clone)]
struct TeamBillingState {
    billing_plan: String,
    billing_status: String,
    stripe_customer_id: Option<String>,
    stripe_subscription_id: Option<String>,
    stripe_subscription_item_id: Option<String>,
    stripe_price_id: Option<String>,
    current_period_end: Option<OffsetDateTime>,
    cancel_at_period_end: bool,
    seats_purchased: Option<i32>,
}

async fn load_billing_actor(
    pool: &PgPool,
    user_id: &str,
) -> Result<DbBillingActorRow, BillingRpcError> {
    query_as::<_, DbBillingActorRow>(
		"SELECT u.id AS user_id, u.team_id, u.role::text AS role, u.email, u.name, t.owner_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, t.stripe_customer_id, t.stripe_subscription_id, t.stripe_subscription_item_id, t.stripe_price_id, t.current_period_end, t.cancel_at_period_end, t.seats_purchased FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load billing actor"); internal_error("Failed to load billing actor") })?
	.ok_or_else(|| not_found_error("Team not found"))
}

async fn load_optional_billing_state(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<DbBillingActorRow>, BillingRpcError> {
    query_as::<_, DbBillingActorRow>(
		"SELECT u.id AS user_id, u.team_id, u.role::text AS role, u.email, u.name, t.owner_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status, t.stripe_customer_id, t.stripe_subscription_id, t.stripe_subscription_item_id, t.stripe_price_id, t.current_period_end, t.cancel_at_period_end, t.seats_purchased FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|_| internal_error("Failed to load billing actor"))
}

fn ensure_team_billing(actor: DbBillingActorRow) -> Result<TeamBillingState, BillingRpcError> {
    Ok(TeamBillingState {
        billing_plan: actor
            .billing_plan
            .ok_or_else(|| not_found_error("Team not found"))?,
        billing_status: actor
            .billing_status
            .ok_or_else(|| not_found_error("Team not found"))?,
        stripe_customer_id: actor.stripe_customer_id,
        stripe_subscription_id: actor.stripe_subscription_id,
        stripe_subscription_item_id: actor.stripe_subscription_item_id,
        stripe_price_id: actor.stripe_price_id,
        current_period_end: actor.current_period_end,
        cancel_at_period_end: actor.cancel_at_period_end.unwrap_or(false),
        seats_purchased: actor.seats_purchased,
    })
}

async fn ensure_team_stripe_customer(
    pool: &PgPool,
    actor: &DbBillingActorRow,
    team_id: &str,
) -> Result<Option<String>, BillingRpcError> {
    if let Some(customer_id) = actor.stripe_customer_id.clone() {
        return Ok(Some(customer_id));
    }

    let billing_contact = match actor.owner_id.as_deref() {
        Some(owner_id) => load_billing_contact(pool, owner_id, team_id)
            .await?
            .or_else(|| {
                Some(DbBillingContactRow {
                    id: actor.user_id.clone(),
                    email: actor.email.clone(),
                    name: actor.name.clone(),
                })
            }),
        None => Some(DbBillingContactRow {
            id: actor.user_id.clone(),
            email: actor.email.clone(),
            name: actor.name.clone(),
        }),
    }
    .ok_or_else(|| internal_error("No billing contact found for team"))?;

    let customer_id = stripe_create_customer(
        &billing_contact.email,
        &billing_contact.name,
        team_id,
        &billing_contact.id,
    )
    .await
    .map_err(|error| internal_error(&error.to_string()))?;

    query("UPDATE team SET stripe_customer_id = $1, updated_at = $2 WHERE id = $3")
        .bind(&customer_id)
        .bind(OffsetDateTime::now_utc())
        .bind(team_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to persist Stripe customer");
            internal_error("Failed to persist Stripe customer")
        })?;

    Ok(Some(customer_id))
}

async fn load_billing_contact(
    pool: &PgPool,
    user_id: &str,
    team_id: &str,
) -> Result<Option<DbBillingContactRow>, BillingRpcError> {
    query_as::<_, DbBillingContactRow>(
        "SELECT id, email, name FROM \"user\" WHERE id = $1 AND team_id = $2 LIMIT 1",
    )
    .bind(user_id)
    .bind(team_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| internal_error("Failed to load billing contact"))
}

async fn count_team_members(pool: &PgPool, team_id: &str) -> Result<i64, BillingRpcError> {
    query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM \"user\" WHERE team_id = $1")
        .bind(team_id)
        .fetch_one(pool)
        .await
        .map_err(|_| internal_error("Failed to count team members"))
}

async fn get_committed_attachment_storage_bytes(
    pool: &PgPool,
    team_id: &str,
) -> Result<i64, BillingRpcError> {
    query_scalar::<_, i64>(
		"SELECT COALESCE(SUM(ia.storage_size), 0)::bigint AS total FROM item_attachment ia INNER JOIN \"user\" u ON ia.uploaded_by = u.id WHERE u.team_id = $1",
	)
	.bind(team_id)
	.fetch_one(pool)
	.await
	.map_err(|_| internal_error("Failed to load attachment usage"))
}

fn get_billing_snapshot(mode: &str, billing_plan: &str, billing_status: &str) -> BillingSnapshot {
    let resolved_entitlements = resolve_effective_entitlements(mode, billing_plan, billing_status);
    let limits = resolve_effective_entitlement_limits(mode, billing_plan, &resolved_entitlements);
    BillingSnapshot {
        entitlements: resolved_entitlements,
        limits,
    }
}

fn resolve_effective_entitlements(
    mode: &str,
    billing_plan: &str,
    billing_status: &str,
) -> BillingEntitlements {
    if mode == "self-hosted" {
        return BillingEntitlements {
            sentinel: false,
            team_management: true,
            vault_sharing: true,
            share_links: true,
            billing_portal: false,
            attachments: true,
        };
    }

    let is_active = is_billing_active(billing_status);
    let paid_inactive = requires_paid_subscription(billing_plan) && !is_active;
    match billing_plan {
        "personal" => BillingEntitlements {
            sentinel: !paid_inactive,
            team_management: false,
            vault_sharing: false,
            share_links: !paid_inactive,
            billing_portal: true,
            attachments: !paid_inactive,
        },
        "family" | "team" => BillingEntitlements {
            sentinel: !paid_inactive,
            team_management: !paid_inactive,
            vault_sharing: !paid_inactive,
            share_links: !paid_inactive,
            billing_portal: true,
            attachments: !paid_inactive,
        },
        _ => BillingEntitlements {
            sentinel: false,
            team_management: false,
            vault_sharing: false,
            share_links: false,
            billing_portal: false,
            attachments: false,
        },
    }
}

fn resolve_effective_entitlement_limits(
    mode: &str,
    billing_plan: &str,
    resolved_entitlements: &BillingEntitlements,
) -> EntitlementLimits {
    if mode == "self-hosted" {
        return EntitlementLimits {
            share_links: None,
            shared_vaults: None,
            attachment_max_file_size_bytes: None,
            attachment_storage_bytes: None,
        };
    }

    let mut limits = match billing_plan {
        "personal" => EntitlementLimits {
            share_links: Some(5),
            shared_vaults: Some(0),
            attachment_max_file_size_bytes: Some(10 * MB),
            attachment_storage_bytes: Some(250 * MB),
        },
        "family" => EntitlementLimits {
            share_links: None,
            shared_vaults: Some(5),
            attachment_max_file_size_bytes: Some(25 * MB),
            attachment_storage_bytes: Some(GB),
        },
        "team" => EntitlementLimits {
            share_links: None,
            shared_vaults: None,
            attachment_max_file_size_bytes: Some(50 * MB),
            attachment_storage_bytes: Some(2 * GB),
        },
        _ => EntitlementLimits {
            share_links: Some(0),
            shared_vaults: Some(0),
            attachment_max_file_size_bytes: Some(0),
            attachment_storage_bytes: Some(0),
        },
    };

    if !resolved_entitlements.share_links {
        limits.share_links = Some(0);
    }
    if !resolved_entitlements.vault_sharing {
        limits.shared_vaults = Some(0);
    }
    if !resolved_entitlements.attachments {
        limits.attachment_max_file_size_bytes = Some(0);
        limits.attachment_storage_bytes = Some(0);
    }

    limits
}

fn self_hosted_billing_status() -> BillingStatusResponse {
    BillingStatusResponse {
        enabled: false,
        plan: "free".to_string(),
        status: "none".to_string(),
        is_active: false,
        requires_payment: false,
        is_stripe_configured: false,
        stripe_customer_id: None,
        stripe_subscription_id: None,
        stripe_price_id: None,
        current_period_end: None,
        cancel_at_period_end: false,
        seats_purchased: None,
    }
}

fn assert_cloud_billing_enabled() -> Result<(), BillingRpcError> {
    if bittery_mode() == "self-hosted" {
        return Err(forbidden_error("Billing is disabled in self-hosted mode"));
    }

    if !is_stripe_api_configured() {
        return Err(internal_error("Stripe is not configured"));
    }

    Ok(())
}

fn is_billing_active(billing_status: &str) -> bool {
    matches!(billing_status, "active" | "trialing")
}

fn ensure_billing_admin(role: &str) -> Result<(), BillingRpcError> {
    if role == "owner" || role == "admin" {
        Ok(())
    } else {
        Err(forbidden_error(
            "Only team owner or admin can manage billing",
        ))
    }
}

fn requires_paid_subscription(plan: &str) -> bool {
    plan != "free"
}

fn is_paid_plan(plan: &str) -> bool {
    plan == "personal" || plan == "family" || plan == "team"
}

fn is_stripe_api_configured() -> bool {
    std::env::var("STRIPE_SECRET_KEY")
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn bittery_mode() -> &'static str {
    match std::env::var("BITTERY_MODE") {
        Ok(value) => {
            let normalized = value.trim().to_ascii_lowercase();
            if normalized == "self-hosted"
                || normalized == "self_hosted"
                || normalized == "selfhosted"
            {
                "self-hosted"
            } else {
                "cloud"
            }
        }
        Err(_) => "cloud",
    }
}

fn get_stripe_price_id(plan: &str) -> Option<String> {
    let env_name = match plan {
        "personal" => "STRIPE_PRICE_PERSONAL_MONTHLY",
        "family" => "STRIPE_PRICE_FAMILY_MONTHLY",
        "team" => "STRIPE_PRICE_TEAM_SEAT_MONTHLY",
        _ => return None,
    };

    std::env::var(env_name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn web_app_url() -> String {
    std::env::var("WEB_APP_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://localhost:3001".to_string())
}

fn format_timestamp(value: OffsetDateTime) -> String {
    value
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| value.unix_timestamp().to_string())
}

fn forbidden_error(message: &str) -> BillingRpcError {
    BillingRpcError {
        code: "FORBIDDEN".to_string(),
        message: message.to_string(),
    }
}

fn bad_request_error(message: &str) -> BillingRpcError {
    BillingRpcError {
        code: "BAD_REQUEST".to_string(),
        message: message.to_string(),
    }
}

fn not_found_error(message: &str) -> BillingRpcError {
    BillingRpcError {
        code: "NOT_FOUND".to_string(),
        message: message.to_string(),
    }
}

fn internal_error(message: &str) -> BillingRpcError {
    BillingRpcError {
        code: "INTERNAL_SERVER_ERROR".to_string(),
        message: message.to_string(),
    }
}

impl From<BillingRpcError> for RpcError {
    fn from(value: BillingRpcError) -> Self {
        let code = match value.code.as_str() {
            "NOT_FOUND" => ErrorCode::ServerError(404),
            "FORBIDDEN" => ErrorCode::ServerError(403),
            "BAD_REQUEST" => ErrorCode::InvalidParams,
            _ => ErrorCode::InternalError,
        };

        RpcError {
            code,
            message: value.message,
            data: None,
        }
    }
}

impl IntoResponse for BillingRpcError {
    type Output = <RpcError as IntoResponse>::Output;

    fn into_response(self) -> jsonrpsee::ResponsePayload<'static, Self::Output> {
        RpcError::from(self).into_response()
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, StatusCode};
    use serde_json::{json, Value};
    use sqlx::{query, query_as, query_scalar, FromRow, PgPool};
    use std::{
        future::Future,
        sync::{Mutex, OnceLock},
    };
    use time::{macros::datetime, OffsetDateTime};

    use super::{
        assert_cloud_billing_enabled, bittery_mode, format_timestamp, get_billing_snapshot,
        is_stripe_api_configured, replace_stripe_mock_state, self_hosted_billing_status,
        stripe_mock_calls, web_app_url, StripeMockCall, StripeMockState, GB,
    };
    use crate::test_support::{
        acquire_env_lock, assign_user_to_team, authenticated_json_headers, seed_item, seed_team,
        seed_user, seed_vault, with_rpc_test_app,
    };

    #[derive(Default)]
    struct BillingTestEnv<'a> {
        bittery_mode: Option<&'a str>,
        stripe_secret_key: Option<&'a str>,
        web_app_url: Option<&'a str>,
        stripe_price_personal: Option<&'a str>,
        stripe_price_family: Option<&'a str>,
        stripe_price_team: Option<&'a str>,
        stripe_mock: Option<StripeMockState>,
    }

    #[derive(Clone)]
    struct BillingRouterFixture {
        owner_user_id: String,
        admin_user_id: String,
        member_user_id: String,
        no_team_user_id: String,
        team_id: String,
        other_team_id: String,
        vault_id: String,
        item_id: String,
    }

    #[derive(FromRow)]
    struct BillingTeamTestRow {
        billing_plan: String,
        billing_status: String,
        stripe_customer_id: Option<String>,
        stripe_subscription_id: Option<String>,
        stripe_subscription_item_id: Option<String>,
        stripe_price_id: Option<String>,
        seats_purchased: Option<i32>,
        current_period_end: Option<OffsetDateTime>,
        cancel_at_period_end: bool,
    }

    fn set_env_var(name: &str, value: Option<&str>) {
        match value {
            Some(value) => unsafe { std::env::set_var(name, value) },
            None => unsafe { std::env::remove_var(name) },
        }
    }

    fn restore_env_var(name: &str, previous: Option<String>) {
        match previous.as_deref() {
            Some(value) => unsafe { std::env::set_var(name, value) },
            None => unsafe { std::env::remove_var(name) },
        }
    }

    fn with_env_vars<T>(
        bittery_mode_value: Option<&str>,
        stripe_secret_key: Option<&str>,
        web_app_url_value: Option<&str>,
        test_fn: impl FnOnce() -> T,
    ) -> T {
        let _guard = acquire_env_lock();
        let previous_mode = std::env::var("BITTERY_MODE").ok();
        let previous_stripe_secret = std::env::var("STRIPE_SECRET_KEY").ok();
        let previous_web_app_url = std::env::var("WEB_APP_URL").ok();

        set_env_var("BITTERY_MODE", bittery_mode_value);
        set_env_var("STRIPE_SECRET_KEY", stripe_secret_key);
        set_env_var("WEB_APP_URL", web_app_url_value);

        let result = test_fn();

        restore_env_var("BITTERY_MODE", previous_mode);
        restore_env_var("STRIPE_SECRET_KEY", previous_stripe_secret);
        restore_env_var("WEB_APP_URL", previous_web_app_url);

        result
    }

    async fn with_billing_test_env_async<T, F>(env: BillingTestEnv<'_>, future: F) -> T
    where
        F: Future<Output = T>,
    {
        let _guard = acquire_env_lock();
        let previous_mode = std::env::var("BITTERY_MODE").ok();
        let previous_stripe_secret = std::env::var("STRIPE_SECRET_KEY").ok();
        let previous_web_app_url = std::env::var("WEB_APP_URL").ok();
        let previous_personal_price = std::env::var("STRIPE_PRICE_PERSONAL_MONTHLY").ok();
        let previous_family_price = std::env::var("STRIPE_PRICE_FAMILY_MONTHLY").ok();
        let previous_team_price = std::env::var("STRIPE_PRICE_TEAM_SEAT_MONTHLY").ok();
        let previous_stripe_mock = replace_stripe_mock_state(env.stripe_mock);

        set_env_var("BITTERY_MODE", env.bittery_mode);
        set_env_var("STRIPE_SECRET_KEY", env.stripe_secret_key);
        set_env_var("WEB_APP_URL", env.web_app_url);
        set_env_var("STRIPE_PRICE_PERSONAL_MONTHLY", env.stripe_price_personal);
        set_env_var("STRIPE_PRICE_FAMILY_MONTHLY", env.stripe_price_family);
        set_env_var("STRIPE_PRICE_TEAM_SEAT_MONTHLY", env.stripe_price_team);

        let result = future.await;

        restore_env_var("BITTERY_MODE", previous_mode);
        restore_env_var("STRIPE_SECRET_KEY", previous_stripe_secret);
        restore_env_var("WEB_APP_URL", previous_web_app_url);
        restore_env_var("STRIPE_PRICE_PERSONAL_MONTHLY", previous_personal_price);
        restore_env_var("STRIPE_PRICE_FAMILY_MONTHLY", previous_family_price);
        restore_env_var("STRIPE_PRICE_TEAM_SEAT_MONTHLY", previous_team_price);
        replace_stripe_mock_state(previous_stripe_mock);

        result
    }

    fn unauthenticated_json_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
        headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
        headers
    }

    fn assert_handler_error(body: &Value, code: &str, message: &str) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["result"]["Err"]["code"], json!(code));
        assert_eq!(body["result"]["Err"]["message"], json!(message));
    }

    fn assert_rpc_error(body: &Value, code: &str, message: &str) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert_eq!(body["error"]["message"], json!(message));
        assert_eq!(body["error"]["data"]["code"], json!(code));
    }

    fn assert_invalid_params_error(body: &Value) {
        assert_eq!(body["jsonrpc"], json!("2.0"));
        assert!(
            body["error"].is_object(),
            "unexpected invalid params body: {body}"
        );
        let message = body["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(
            message.contains("invalid params"),
            "unexpected invalid params body: {body}"
        );
    }

    async fn build_billing_router_fixture(pool: &PgPool) -> BillingRouterFixture {
        let owner_user_id = "user_billing_owner".to_string();
        let admin_user_id = "user_billing_admin".to_string();
        let member_user_id = "user_billing_member".to_string();
        let no_team_user_id = "user_billing_no_team".to_string();
        let team_id = "team_billing_primary".to_string();
        let other_team_id = "team_billing_other".to_string();
        let vault_id = "vault_billing_team".to_string();
        let item_id = "item_billing_team".to_string();

        seed_user(
            pool,
            &owner_user_id,
            "Billing Owner",
            "billing-owner@example.com",
        )
        .await;
        seed_user(
            pool,
            &admin_user_id,
            "Billing Admin",
            "billing-admin@example.com",
        )
        .await;
        seed_user(
            pool,
            &member_user_id,
            "Billing Member",
            "billing-member@example.com",
        )
        .await;
        seed_user(
            pool,
            &no_team_user_id,
            "Billing No Team",
            "billing-no-team@example.com",
        )
        .await;
        seed_team(
            pool,
            &team_id,
            "Billing Team",
            &owner_user_id,
            "organization",
            "team",
            "active",
        )
        .await;
        assign_user_to_team(pool, &owner_user_id, &team_id, "owner").await;
        assign_user_to_team(pool, &admin_user_id, &team_id, "admin").await;
        assign_user_to_team(pool, &member_user_id, &team_id, "member").await;
        seed_vault(
            pool,
            &vault_id,
            "Billing Team Vault",
            "team",
            &owner_user_id,
            Some(&team_id),
        )
        .await;
        seed_item(
            pool,
            &item_id,
            &vault_id,
            "login",
            "encrypted-item",
            "item-iv",
            &owner_user_id,
        )
        .await;

        BillingRouterFixture {
            owner_user_id,
            admin_user_id,
            member_user_id,
            no_team_user_id,
            team_id,
            other_team_id,
            vault_id,
            item_id,
        }
    }

    async fn seed_attachment(
        pool: &PgPool,
        attachment_id: &str,
        item_id: &str,
        vault_id: &str,
        uploaded_by: &str,
        storage_size: i32,
    ) {
        query(
			"INSERT INTO item_attachment (id, item_id, vault_id, storage_key, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, storage_size, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
		)
		.bind(attachment_id)
		.bind(item_id)
		.bind(vault_id)
		.bind(format!("attachments/{attachment_id}"))
		.bind("encrypted-name")
		.bind("encrypted-content-type")
		.bind("attachment-iv")
		.bind(Some("content-type-iv"))
		.bind("AES-GCM-AAD-V1")
		.bind(storage_size)
		.bind(storage_size)
		.bind(uploaded_by)
		.bind(OffsetDateTime::now_utc())
		.execute(pool)
		.await
		.expect("attachment should seed");
    }

    async fn update_team_billing_state(
        pool: &PgPool,
        team_id: &str,
        billing_plan: &str,
        billing_status: &str,
        stripe_customer_id: Option<&str>,
        stripe_subscription_id: Option<&str>,
        stripe_subscription_item_id: Option<&str>,
        stripe_price_id: Option<&str>,
        seats_purchased: Option<i32>,
        cancel_at_period_end: bool,
        current_period_end: Option<OffsetDateTime>,
    ) {
        query(
			"UPDATE team SET billing_plan = $1::billing_plan, billing_status = $2::billing_status, stripe_customer_id = $3, stripe_subscription_id = $4, stripe_subscription_item_id = $5, stripe_price_id = $6, seats_purchased = $7, cancel_at_period_end = $8, current_period_end = $9, updated_at = $10 WHERE id = $11",
		)
		.bind(billing_plan)
		.bind(billing_status)
		.bind(stripe_customer_id)
		.bind(stripe_subscription_id)
		.bind(stripe_subscription_item_id)
		.bind(stripe_price_id)
		.bind(seats_purchased)
		.bind(cancel_at_period_end)
		.bind(current_period_end)
		.bind(OffsetDateTime::now_utc())
		.bind(team_id)
		.execute(pool)
		.await
		.expect("team billing state should update");
    }

    async fn load_team_billing_row(pool: &PgPool, team_id: &str) -> BillingTeamTestRow {
        query_as::<_, BillingTeamTestRow>(
			"SELECT billing_plan::text AS billing_plan, billing_status::text AS billing_status, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, stripe_price_id, seats_purchased, current_period_end, cancel_at_period_end FROM team WHERE id = $1 LIMIT 1",
		)
		.bind(team_id)
		.fetch_one(pool)
		.await
		.expect("team billing row should load")
    }

    #[test]
    fn self_hosted_status_matches_expected_snapshot() {
        let status = self_hosted_billing_status();

        assert!(!status.enabled);
        assert_eq!(status.plan, "free");
        assert_eq!(status.status, "none");
        assert!(!status.requires_payment);
    }

    #[test]
    fn free_cloud_plan_disables_paid_entitlements() {
        let snapshot = get_billing_snapshot("cloud", "free", "none");

        assert!(!snapshot.entitlements.sentinel);
        assert!(!snapshot.entitlements.share_links);
        assert!(!snapshot.entitlements.team_management);
        assert!(!snapshot.entitlements.vault_sharing);
        assert!(!snapshot.entitlements.attachments);
        assert_eq!(snapshot.limits.share_links, Some(0));
        assert_eq!(snapshot.limits.shared_vaults, Some(0));
        assert_eq!(snapshot.limits.attachment_max_file_size_bytes, Some(0));
        assert_eq!(snapshot.limits.attachment_storage_bytes, Some(0));
    }

    #[test]
    fn inactive_paid_plan_keeps_only_billing_portal() {
        let snapshot = get_billing_snapshot("cloud", "personal", "incomplete");

        assert!(!snapshot.entitlements.sentinel);
        assert!(!snapshot.entitlements.share_links);
        assert!(snapshot.entitlements.billing_portal);
        assert_eq!(snapshot.limits.share_links, Some(0));
        assert_eq!(snapshot.limits.shared_vaults, Some(0));
        assert_eq!(snapshot.limits.attachment_max_file_size_bytes, Some(0));
        assert_eq!(snapshot.limits.attachment_storage_bytes, Some(0));
    }

    #[test]
    fn self_hosted_mode_enables_non_cloud_features() {
        let snapshot = get_billing_snapshot("self-hosted", "team", "active");

        assert!(!snapshot.entitlements.sentinel);
        assert!(!snapshot.entitlements.billing_portal);
        assert!(snapshot.entitlements.share_links);
        assert!(snapshot.entitlements.team_management);
        assert!(snapshot.entitlements.attachments);
        assert_eq!(snapshot.limits.share_links, None);
        assert_eq!(snapshot.limits.shared_vaults, None);
        assert_eq!(snapshot.limits.attachment_max_file_size_bytes, None);
        assert_eq!(snapshot.limits.attachment_storage_bytes, None);
    }

    #[test]
    fn bittery_mode_normalizes_self_hosted_aliases_and_defaults_to_cloud() {
        with_env_vars(None, None, None, || {
            assert_eq!(bittery_mode(), "cloud");
        });

        with_env_vars(Some("self_hosted"), None, None, || {
            assert_eq!(bittery_mode(), "self-hosted");
        });

        with_env_vars(Some("SELFHOSTED"), None, None, || {
            assert_eq!(bittery_mode(), "self-hosted");
        });

        with_env_vars(Some("cloud"), None, None, || {
            assert_eq!(bittery_mode(), "cloud");
        });
    }

    #[test]
    fn stripe_configuration_and_web_app_url_use_trimmed_env_values() {
        with_env_vars(
            None,
            Some("  sk_test_123  "),
            Some(" https://app.example.com/  "),
            || {
                assert!(is_stripe_api_configured());
                assert_eq!(web_app_url(), "https://app.example.com/");
            },
        );

        with_env_vars(None, Some("   "), Some("   "), || {
            assert!(!is_stripe_api_configured());
            assert_eq!(web_app_url(), "http://localhost:3001");
        });
    }

    #[test]
    fn cloud_billing_guard_rejects_self_hosted_and_missing_stripe_configuration() {
        with_env_vars(Some("self-hosted"), Some("sk_test_123"), None, || {
            let error = assert_cloud_billing_enabled()
                .expect_err("self-hosted mode should disable cloud billing handlers");
            assert_eq!(error.code, "FORBIDDEN");
            assert_eq!(error.message, "Billing is disabled in self-hosted mode");
        });

        with_env_vars(None, None, None, || {
            let error = assert_cloud_billing_enabled()
                .expect_err("missing Stripe config should be rejected");
            assert_eq!(error.code, "INTERNAL_SERVER_ERROR");
            assert_eq!(error.message, "Stripe is not configured");
        });

        with_env_vars(None, Some("sk_test_123"), None, || {
            assert!(assert_cloud_billing_enabled().is_ok());
        });
    }

    #[tokio::test]
    async fn billing_handlers_require_authentication() {
        with_rpc_test_app(
            "billing_handlers_require_authentication",
            |app| async move {
                let protected_calls = vec![
                    ("billing.status", json!([])),
                    ("billing.entitlements", json!([])),
                    ("billing.attachmentUsage", json!([])),
                    ("billing.createCheckoutSession", json!([{}])),
                    ("billing.createPortalSession", json!([])),
                    ("billing.syncSeats", json!([{}])),
                    ("billing.previewAdditionalTeamSeat", json!([])),
                ];

                for (method, params) in protected_calls {
                    let response = app
                        .rpc_call(method, params, unauthenticated_json_headers())
                        .await;
                    assert_eq!(
                        response.status,
                        StatusCode::OK,
                        "unexpected status for {method}"
                    );
                    assert_rpc_error(&response.body, "UNAUTHORIZED", "Authentication required");
                }
            },
        )
        .await;
    }

    #[tokio::test]
    async fn billing_query_handlers_return_expected_status_entitlements_and_attachment_usage() {
        with_billing_test_env_async(
            BillingTestEnv {
                stripe_secret_key: Some("sk_test_123"),
                web_app_url: Some("https://app.example.com"),
                ..BillingTestEnv::default()
            },
            async {
                with_rpc_test_app("billing_query_handlers_success", |app| async move {
                    let fixture = build_billing_router_fixture(&app.pool).await;
                    let period_end = datetime!(2026-05-22 12:00 UTC);
                    update_team_billing_state(
                        &app.pool,
                        &fixture.team_id,
                        "team",
                        "active",
                        Some("cus_team_123"),
                        Some("sub_team_123"),
                        Some("si_team_123"),
                        Some("price_team_123"),
                        Some(3),
                        true,
                        Some(period_end),
                    )
                    .await;
                    seed_attachment(
                        &app.pool,
                        "attachment_billing_1",
                        &fixture.item_id,
                        &fixture.vault_id,
                        &fixture.owner_user_id,
                        1024,
                    )
                    .await;
                    seed_attachment(
                        &app.pool,
                        "attachment_billing_2",
                        &fixture.item_id,
                        &fixture.vault_id,
                        &fixture.admin_user_id,
                        2048,
                    )
                    .await;

                    let session = app.issue_session(&fixture.owner_user_id).await;
                    let headers = authenticated_json_headers(&session.token);

                    let status_response = app
                        .rpc_call("billing.status", json!([]), headers.clone())
                        .await;
                    assert_eq!(status_response.status, StatusCode::OK);
                    assert_eq!(status_response.body["result"]["Ok"]["enabled"], json!(true));
                    assert_eq!(status_response.body["result"]["Ok"]["plan"], json!("team"));
                    assert_eq!(
                        status_response.body["result"]["Ok"]["status"],
                        json!("active")
                    );
                    assert_eq!(
                        status_response.body["result"]["Ok"]["isActive"],
                        json!(true)
                    );
                    assert_eq!(
                        status_response.body["result"]["Ok"]["requiresPayment"],
                        json!(true)
                    );
                    assert_eq!(
                        status_response.body["result"]["Ok"]["isStripeConfigured"],
                        json!(true)
                    );
                    assert_eq!(
                        status_response.body["result"]["Ok"]["stripeCustomerId"],
                        json!("cus_team_123")
                    );
                    assert_eq!(
                        status_response.body["result"]["Ok"]["stripeSubscriptionId"],
                        json!("sub_team_123")
                    );
                    assert_eq!(
                        status_response.body["result"]["Ok"]["stripePriceId"],
                        json!("price_team_123")
                    );
                    assert_eq!(
                        status_response.body["result"]["Ok"]["currentPeriodEnd"],
                        json!(format_timestamp(period_end))
                    );
                    assert_eq!(
                        status_response.body["result"]["Ok"]["cancelAtPeriodEnd"],
                        json!(true)
                    );
                    assert_eq!(
                        status_response.body["result"]["Ok"]["seatsPurchased"],
                        json!(3)
                    );

                    let entitlements_response = app
                        .rpc_call("billing.entitlements", json!([]), headers.clone())
                        .await;
                    assert_eq!(entitlements_response.status, StatusCode::OK);
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["mode"],
                        json!("cloud")
                    );
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["plan"],
                        json!("team")
                    );
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["status"],
                        json!("active")
                    );
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["isActive"],
                        json!(true)
                    );
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["entitlements"]
                            ["teamManagement"],
                        json!(true)
                    );
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["entitlements"]["attachments"],
                        json!(true)
                    );
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["limits"]
                            ["attachmentStorageBytes"],
                        json!(2 * GB)
                    );

                    let usage_response = app
                        .rpc_call("billing.attachmentUsage", json!([]), headers)
                        .await;
                    assert_eq!(usage_response.status, StatusCode::OK);
                    assert_eq!(usage_response.body["result"]["Ok"]["mode"], json!("cloud"));
                    assert_eq!(
                        usage_response.body["result"]["Ok"]["attachmentsEnabled"],
                        json!(true)
                    );
                    assert_eq!(
                        usage_response.body["result"]["Ok"]["quotaBytes"],
                        json!(2 * GB)
                    );
                    assert_eq!(
                        usage_response.body["result"]["Ok"]["committedStorageBytes"],
                        json!(3072)
                    );
                })
                .await;
            },
        )
        .await;
    }

    #[tokio::test]
    async fn billing_cloud_queries_return_team_not_found_without_team() {
        with_billing_test_env_async(BillingTestEnv::default(), async {
            with_rpc_test_app("billing_cloud_queries_team_not_found", |app| async move {
                let fixture = build_billing_router_fixture(&app.pool).await;
                let session = app.issue_session(&fixture.no_team_user_id).await;
                let headers = authenticated_json_headers(&session.token);

                for method in [
                    "billing.status",
                    "billing.entitlements",
                    "billing.attachmentUsage",
                ] {
                    let response = app.rpc_call(method, json!([]), headers.clone()).await;
                    assert_eq!(
                        response.status,
                        StatusCode::OK,
                        "unexpected status for {method}"
                    );
                    assert_handler_error(&response.body, "NOT_FOUND", "Team not found");
                }
            })
            .await;
        })
        .await;
    }

    #[tokio::test]
    async fn billing_self_hosted_queries_use_self_hosted_defaults() {
        with_billing_test_env_async(
            BillingTestEnv {
                bittery_mode: Some("self-hosted"),
                ..BillingTestEnv::default()
            },
            async {
                with_rpc_test_app("billing_self_hosted_queries_defaults", |app| async move {
                    let fixture = build_billing_router_fixture(&app.pool).await;
                    let session = app.issue_session(&fixture.no_team_user_id).await;
                    let headers = authenticated_json_headers(&session.token);

                    let status_response = app
                        .rpc_call("billing.status", json!([]), headers.clone())
                        .await;
                    assert_eq!(status_response.status, StatusCode::OK);
                    assert_eq!(
                        status_response.body["result"]["Ok"]["enabled"],
                        json!(false)
                    );
                    assert_eq!(status_response.body["result"]["Ok"]["plan"], json!("free"));
                    assert_eq!(
                        status_response.body["result"]["Ok"]["status"],
                        json!("none")
                    );

                    let entitlements_response = app
                        .rpc_call("billing.entitlements", json!([]), headers.clone())
                        .await;
                    assert_eq!(entitlements_response.status, StatusCode::OK);
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["mode"],
                        json!("self-hosted")
                    );
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["plan"],
                        json!("team")
                    );
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["status"],
                        json!("active")
                    );
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["entitlements"]["billingPortal"],
                        json!(false)
                    );
                    assert_eq!(
                        entitlements_response.body["result"]["Ok"]["limits"]
                            ["attachmentStorageBytes"],
                        Value::Null
                    );

                    let usage_response = app
                        .rpc_call("billing.attachmentUsage", json!([]), headers)
                        .await;
                    assert_eq!(usage_response.status, StatusCode::OK);
                    assert_eq!(
                        usage_response.body["result"]["Ok"]["mode"],
                        json!("self-hosted")
                    );
                    assert_eq!(
                        usage_response.body["result"]["Ok"]["attachmentsEnabled"],
                        json!(true)
                    );
                    assert_eq!(
                        usage_response.body["result"]["Ok"]["quotaBytes"],
                        Value::Null
                    );
                    assert_eq!(
                        usage_response.body["result"]["Ok"]["committedStorageBytes"],
                        json!(0)
                    );
                })
                .await;
            },
        )
        .await;
    }

    #[tokio::test]
    async fn billing_mutation_handlers_reject_self_hosted_mode() {
        with_billing_test_env_async(
            BillingTestEnv {
                bittery_mode: Some("self-hosted"),
                ..BillingTestEnv::default()
            },
            async {
                with_rpc_test_app("billing_mutations_reject_self_hosted", |app| async move {
                    let fixture = build_billing_router_fixture(&app.pool).await;
                    let session = app.issue_session(&fixture.owner_user_id).await;
                    let headers = authenticated_json_headers(&session.token);
                    let mutation_calls = vec![
                        ("billing.createCheckoutSession", json!([{}])),
                        ("billing.createPortalSession", json!([])),
                        ("billing.syncSeats", json!([{}])),
                        ("billing.previewAdditionalTeamSeat", json!([])),
                    ];

                    for (method, params) in mutation_calls {
                        let response = app.rpc_call(method, params, headers.clone()).await;
                        assert_eq!(
                            response.status,
                            StatusCode::OK,
                            "unexpected status for {method}"
                        );
                        assert_handler_error(
                            &response.body,
                            "FORBIDDEN",
                            "Billing is disabled in self-hosted mode",
                        );
                    }
                })
                .await;
            },
        )
        .await;
    }

    #[tokio::test]
    async fn billing_create_checkout_session_rejects_invalid_payload_shape() {
        with_billing_test_env_async(
            BillingTestEnv {
                stripe_secret_key: Some("sk_test_123"),
                stripe_price_team: Some("price_team_123"),
                ..BillingTestEnv::default()
            },
            async {
                with_rpc_test_app(
                    "billing_create_checkout_invalid_payload",
                    |app| async move {
                        let fixture = build_billing_router_fixture(&app.pool).await;
                        let session = app.issue_session(&fixture.owner_user_id).await;

                        let response = app
                            .rpc_call(
                                "billing.createCheckoutSession",
                                json!([{ "plan": 123 }]),
                                authenticated_json_headers(&session.token),
                            )
                            .await;

                        assert_eq!(response.status, StatusCode::OK);
                        assert_invalid_params_error(&response.body);
                    },
                )
                .await;
            },
        )
        .await;
    }

    #[tokio::test]
    async fn billing_create_checkout_session_enforces_admin_and_plan_validation() {
        with_billing_test_env_async(
            BillingTestEnv {
                stripe_secret_key: Some("sk_test_123"),
                stripe_price_team: Some("price_team_123"),
                ..BillingTestEnv::default()
            },
            async {
                with_rpc_test_app(
                    "billing_create_checkout_access_and_validation_v2",
                    |app| async move {
                        let fixture = build_billing_router_fixture(&app.pool).await;
                        let member_session = app.issue_session(&fixture.member_user_id).await;
                        let forbidden_response = app
                            .rpc_call(
                                "billing.createCheckoutSession",
                                json!([{ "plan": "team" }]),
                                authenticated_json_headers(&member_session.token),
                            )
                            .await;
                        assert_eq!(forbidden_response.status, StatusCode::OK);
                        assert_handler_error(
                            &forbidden_response.body,
                            "FORBIDDEN",
                            "Only team owner or admin can manage billing",
                        );

                        update_team_billing_state(
                            &app.pool,
                            &fixture.team_id,
                            "free",
                            "none",
                            None,
                            None,
                            None,
                            None,
                            None,
                            false,
                            None,
                        )
                        .await;
                        let owner_session = app.issue_session(&fixture.owner_user_id).await;
                        let bad_request_response = app
                            .rpc_call(
                                "billing.createCheckoutSession",
                                json!([{ "plan": "free" }]),
                                authenticated_json_headers(&owner_session.token),
                            )
                            .await;
                        assert_eq!(bad_request_response.status, StatusCode::OK);
                        assert_handler_error(
                            &bad_request_response.body,
                            "BAD_REQUEST",
                            "Free plan does not require checkout",
                        );
                    },
                )
                .await;
            },
        )
        .await;
    }

    #[tokio::test]
    async fn billing_create_checkout_session_success_persists_incomplete_state_and_stripe_customer()
    {
        with_billing_test_env_async(
            BillingTestEnv {
                stripe_secret_key: Some("sk_test_123"),
                web_app_url: Some("https://app.example.com"),
                stripe_price_team: Some("price_team_123"),
                stripe_mock: Some(StripeMockState::default()),
                ..BillingTestEnv::default()
            },
            async {
                with_rpc_test_app("billing_create_checkout_success", |app| async move {
                    let fixture = build_billing_router_fixture(&app.pool).await;
                    let session = app.issue_session(&fixture.owner_user_id).await;

                    let response = app
                        .rpc_call(
                            "billing.createCheckoutSession",
                            json!([{ "plan": "team" }]),
                            authenticated_json_headers(&session.token),
                        )
                        .await;

                    assert_eq!(response.status, StatusCode::OK);
                    assert_eq!(
                        response.body["result"]["Ok"]["url"],
                        json!("https://checkout.stripe.test/session/cs_test_123")
                    );
                    assert_eq!(
                        response.body["result"]["Ok"]["sessionId"],
                        json!("cs_test_123")
                    );

                    let team_row = load_team_billing_row(&app.pool, &fixture.team_id).await;
                    assert_eq!(team_row.billing_plan, "team");
                    assert_eq!(team_row.billing_status, "incomplete");
                    assert_eq!(team_row.stripe_customer_id.as_deref(), Some("cus_test_123"));

                    let calls = stripe_mock_calls();
                    assert_eq!(calls.len(), 2);
                    assert_eq!(
                        calls[0],
                        StripeMockCall::CreateCustomer {
                            email: "billing-owner@example.com".to_string(),
                            name: "Billing Owner".to_string(),
                            team_id: fixture.team_id.clone(),
                            user_id: fixture.owner_user_id.clone(),
                        },
                    );
                    assert_eq!(
                        calls[1],
                        StripeMockCall::CreateCheckoutSession {
                            team_id: fixture.team_id,
                            user_id: fixture.owner_user_id,
                            customer_id: Some("cus_test_123".to_string()),
                            customer_email: "billing-owner@example.com".to_string(),
                            plan: "team".to_string(),
                            price_id: "price_team_123".to_string(),
                            quantity: 3,
                            success_url: "https://app.example.com/billing?checkout=success"
                                .to_string(),
                            cancel_url: "https://app.example.com/billing?checkout=cancel"
                                .to_string(),
                        },
                    );
                })
                .await;
            },
        )
        .await;
    }

    #[tokio::test]
    async fn billing_create_portal_session_requires_customer_and_returns_url() {
        with_billing_test_env_async(
            BillingTestEnv {
                stripe_secret_key: Some("sk_test_123"),
                web_app_url: Some("https://app.example.com"),
                stripe_mock: Some(StripeMockState::default()),
                ..BillingTestEnv::default()
            },
            async {
                with_rpc_test_app("billing_create_portal_session_paths", |app| async move {
                    let fixture = build_billing_router_fixture(&app.pool).await;
                    let session = app.issue_session(&fixture.owner_user_id).await;

                    let missing_customer_response = app
                        .rpc_call(
                            "billing.createPortalSession",
                            json!([]),
                            authenticated_json_headers(&session.token),
                        )
                        .await;
                    assert_eq!(missing_customer_response.status, StatusCode::OK);
                    assert_handler_error(
                        &missing_customer_response.body,
                        "BAD_REQUEST",
                        "No Stripe customer found for this team",
                    );

                    update_team_billing_state(
                        &app.pool,
                        &fixture.team_id,
                        "team",
                        "active",
                        Some("cus_portal_123"),
                        Some("sub_portal_123"),
                        Some("si_portal_123"),
                        Some("price_team_123"),
                        Some(3),
                        false,
                        None,
                    )
                    .await;
                    let success_response = app
                        .rpc_call(
                            "billing.createPortalSession",
                            json!([]),
                            authenticated_json_headers(&session.token),
                        )
                        .await;
                    assert_eq!(success_response.status, StatusCode::OK);
                    assert_eq!(
                        success_response.body["result"]["Ok"]["url"],
                        json!("https://billing.stripe.test/portal/session_123")
                    );

                    assert_eq!(
                        stripe_mock_calls(),
                        vec![StripeMockCall::CreateBillingPortalSession {
                            customer_id: "cus_portal_123".to_string(),
                            return_url: "https://app.example.com/billing".to_string(),
                        }],
                    );
                })
                .await;
            },
        )
        .await;
    }

    #[tokio::test]
    async fn billing_sync_seats_rejects_other_team_and_updates_quantity() {
        with_billing_test_env_async(
            BillingTestEnv {
                stripe_secret_key: Some("sk_test_123"),
                stripe_mock: Some(StripeMockState::default()),
                ..BillingTestEnv::default()
            },
            async {
                with_rpc_test_app("billing_sync_seats_paths", |app| async move {
                    let fixture = build_billing_router_fixture(&app.pool).await;
                    update_team_billing_state(
                        &app.pool,
                        &fixture.team_id,
                        "team",
                        "active",
                        Some("cus_team_123"),
                        Some("sub_team_123"),
                        Some("si_team_123"),
                        Some("price_team_123"),
                        Some(2),
                        false,
                        None,
                    )
                    .await;
                    let session = app.issue_session(&fixture.owner_user_id).await;

                    let forbidden_response = app
                        .rpc_call(
                            "billing.syncSeats",
                            json!([{ "teamId": fixture.other_team_id }]),
                            authenticated_json_headers(&session.token),
                        )
                        .await;
                    assert_eq!(forbidden_response.status, StatusCode::OK);
                    assert_handler_error(
                        &forbidden_response.body,
                        "FORBIDDEN",
                        "You can only sync seats for your own team",
                    );

                    let success_response = app
                        .rpc_call(
                            "billing.syncSeats",
                            json!([{}]),
                            authenticated_json_headers(&session.token),
                        )
                        .await;
                    assert_eq!(success_response.status, StatusCode::OK);
                    assert_eq!(success_response.body["result"]["Ok"]["synced"], json!(true));
                    assert_eq!(success_response.body["result"]["Ok"]["reason"], Value::Null);
                    assert_eq!(success_response.body["result"]["Ok"]["quantity"], json!(3));

                    let team_row = load_team_billing_row(&app.pool, &fixture.team_id).await;
                    assert_eq!(team_row.seats_purchased, Some(3));
                    assert_eq!(
                        stripe_mock_calls(),
                        vec![StripeMockCall::UpdateSubscriptionItemQuantity {
                            subscription_item_id: "si_team_123".to_string(),
                            quantity: 3,
                        }],
                    );
                })
                .await;
            },
        )
        .await;
    }

    #[tokio::test]
    async fn billing_preview_additional_team_seat_returns_none_and_maps_preview_response() {
        with_billing_test_env_async(
            BillingTestEnv {
                stripe_secret_key: Some("sk_test_123"),
                stripe_mock: Some(StripeMockState::default()),
                ..BillingTestEnv::default()
            },
            async {
                with_rpc_test_app(
                    "billing_preview_additional_team_seat_paths",
                    |app| async move {
                        let fixture = build_billing_router_fixture(&app.pool).await;
                        let session = app.issue_session(&fixture.owner_user_id).await;

                        let none_response = app
                            .rpc_call(
                                "billing.previewAdditionalTeamSeat",
                                json!([]),
                                authenticated_json_headers(&session.token),
                            )
                            .await;
                        assert_eq!(none_response.status, StatusCode::OK);
                        assert_eq!(none_response.body["result"]["Ok"], Value::Null);

                        update_team_billing_state(
                            &app.pool,
                            &fixture.team_id,
                            "team",
                            "active",
                            Some("cus_preview_123"),
                            Some("sub_preview_123"),
                            Some("si_preview_123"),
                            Some("price_team_123"),
                            Some(3),
                            false,
                            None,
                        )
                        .await;
                        let preview_response = app
                            .rpc_call(
                                "billing.previewAdditionalTeamSeat",
                                json!([]),
                                authenticated_json_headers(&session.token),
                            )
                            .await;
                        assert_eq!(preview_response.status, StatusCode::OK);
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["currency"],
                            json!("usd")
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["currentQuantity"],
                            json!(3)
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["nextQuantity"],
                            json!(4)
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["estimatedNextPaymentCents"],
                            json!(750)
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["totalLineItemsCents"],
                            json!(750)
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["lines"][0]["id"],
                            json!("il_preview_123")
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["lines"][0]["description"],
                            json!("Additional team seat")
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["lines"][0]["amountCents"],
                            json!(750)
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["lines"][0]["unitAmountCents"],
                            json!(750)
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["lines"][0]["isProration"],
                            json!(true)
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["lines"][0]["periodStart"],
                            json!(format_timestamp(
                                OffsetDateTime::from_unix_timestamp(1_717_300_000)
                                    .expect("preview period start should be valid"),
                            )),
                        );
                        assert_eq!(
                            preview_response.body["result"]["Ok"]["lines"][0]["periodEnd"],
                            json!(format_timestamp(
                                OffsetDateTime::from_unix_timestamp(1_719_892_800)
                                    .expect("preview period end should be valid"),
                            )),
                        );

                        assert_eq!(
                            stripe_mock_calls(),
                            vec![StripeMockCall::PreviewUpcomingTeamSeatInvoice {
                                stripe_customer_id: "cus_preview_123".to_string(),
                                stripe_subscription_id: "sub_preview_123".to_string(),
                                stripe_subscription_item_id: Some("si_preview_123".to_string()),
                                seats_purchased: Some(3),
                                seat_increment: 1,
                            }],
                        );
                    },
                )
                .await;
            },
        )
        .await;
    }

    #[tokio::test]
    async fn billing_create_portal_and_preview_require_billing_admin() {
        with_billing_test_env_async(
            BillingTestEnv {
                stripe_secret_key: Some("sk_test_123"),
                ..BillingTestEnv::default()
            },
            async {
                with_rpc_test_app("billing_admin_only_handlers", |app| async move {
                    let fixture = build_billing_router_fixture(&app.pool).await;
                    let member_session = app.issue_session(&fixture.member_user_id).await;

                    for method in [
                        "billing.createPortalSession",
                        "billing.previewAdditionalTeamSeat",
                    ] {
                        let response = app
                            .rpc_call(
                                method,
                                json!([]),
                                authenticated_json_headers(&member_session.token),
                            )
                            .await;
                        assert_eq!(
                            response.status,
                            StatusCode::OK,
                            "unexpected status for {method}"
                        );
                        assert_handler_error(
                            &response.body,
                            "FORBIDDEN",
                            "Only team owner or admin can manage billing",
                        );
                    }
                })
                .await;
            },
        )
        .await;
    }
}
