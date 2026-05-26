mod webhook;

use serde::{Deserialize, Serialize};
use sqlx::{query, query_scalar, PgPool};
use time::OffsetDateTime;
use ts_rs::TS;

pub(crate) use self::webhook::{
    is_self_hosted_mode, is_stripe_webhook_configured, process_stripe_webhook_event,
    StripeWebhookError,
};
use crate::integrations::stripe::{
    create_billing_portal_session as stripe_create_billing_portal_session_impl,
    create_checkout_session as stripe_create_checkout_session_impl,
    create_customer as stripe_create_customer_impl,
    preview_upcoming_team_seat_invoice as stripe_preview_upcoming_team_seat_invoice_impl,
    update_subscription_item_quantity as stripe_update_subscription_item_quantity_impl,
    CheckoutSession, CheckoutSessionInput, StripeClientError, TeamSeatInvoicePreview,
};
use crate::{
    config::{bittery_mode, format_timestamp},
    db::models::{DbBillingActorRow, DbBillingContactRow},
    error::AppError,
    repo::billing::{
        count_team_members, get_committed_attachment_storage_bytes, load_billing_actor,
        load_billing_contact, load_optional_billing_state,
    },
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

struct BillingSnapshot {
    entitlements: BillingEntitlements,
    limits: EntitlementLimits,
}

pub(crate) async fn get_billing_status(
    pool: &PgPool,
    user_id: &str,
) -> Result<BillingStatusResponse, AppError> {
    if bittery_mode() == "self-hosted" {
        return Ok(self_hosted_billing_status());
    }

    let actor = load_billing_actor(pool, user_id).await?;
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

pub(crate) async fn get_billing_entitlements(
    db_pool: Option<&PgPool>,
    user_id: &str,
) -> Result<BillingEntitlementsResponse, AppError> {
    let mode = bittery_mode().to_string();
    if mode == "self-hosted" {
        let state = match db_pool {
            Some(pool) => load_optional_billing_state(pool, user_id).await?,
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
    let pool = db_pool.ok_or_else(|| internal_error("Database is not configured"))?;
    let actor = load_billing_actor(pool, user_id).await?;
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

pub(crate) async fn get_attachment_usage(
    pool: &PgPool,
    user_id: &str,
) -> Result<AttachmentUsageResponse, AppError> {
    let mode = bittery_mode().to_string();
    if mode == "self-hosted" {
        return Ok(AttachmentUsageResponse {
            mode,
            attachments_enabled: true,
            quota_bytes: None,
            committed_storage_bytes: 0,
        });
    }
    let actor = load_billing_actor(pool, user_id).await?;
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

pub(crate) async fn create_checkout_session(
    pool: &PgPool,
    user_id: &str,
    input: CheckoutPlanInput,
) -> Result<CheckoutSessionResponse, AppError> {
    assert_cloud_billing_enabled()?;
    let actor = load_billing_actor(pool, user_id).await?;
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
        user_id: user_id,
        customer_id: customer_id.as_deref(),
        customer_email: &actor.email,
        plan: &target_plan,
        price_id: &stripe_price_id,
        quantity,
        success_url: format!("{base_url}/billing?checkout=success"),
        cancel_url: format!("{base_url}/billing?checkout=cancel"),
    })
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "Internal error");
        internal_error("An internal error occurred")
    })?;

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

pub(crate) async fn create_portal_session(
    pool: &PgPool,
    user_id: &str,
) -> Result<PortalSessionResponse, AppError> {
    assert_cloud_billing_enabled()?;
    let actor = load_billing_actor(pool, user_id).await?;
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
            .map_err(|error| {
                tracing::error!(error = %error, "Internal error");
                internal_error("An internal error occurred")
            })?;

    Ok(PortalSessionResponse { url })
}

pub(crate) async fn sync_seats(
    pool: &PgPool,
    user_id: &str,
    input: SyncSeatsInput,
) -> Result<SyncSeatsResponse, AppError> {
    assert_cloud_billing_enabled()?;
    let actor = load_billing_actor(pool, user_id).await?;
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
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            internal_error("An internal error occurred")
        })?;

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

pub(crate) async fn preview_additional_team_seat(
    pool: &PgPool,
    user_id: &str,
) -> Result<Option<TeamSeatInvoicePreviewResponse>, AppError> {
    assert_cloud_billing_enabled()?;

    let actor = load_billing_actor(pool, user_id).await?;
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
                    lines: vec![crate::integrations::stripe::TeamSeatInvoicePreviewLine {
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

fn ensure_team_billing(actor: DbBillingActorRow) -> Result<TeamBillingState, AppError> {
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
) -> Result<Option<String>, AppError> {
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
    .map_err(|error| {
        tracing::error!(error = %error, "Internal error");
        internal_error("An internal error occurred")
    })?;

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

fn assert_cloud_billing_enabled() -> Result<(), AppError> {
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

fn ensure_billing_admin(role: &str) -> Result<(), AppError> {
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

fn forbidden_error(message: &str) -> AppError {
    AppError::forbidden(message)
}

fn bad_request_error(message: &str) -> AppError {
    AppError::bad_request(message)
}

fn not_found_error(message: &str) -> AppError {
    AppError::not_found(message)
}

fn internal_error(message: &str) -> AppError {
    AppError::internal(message)
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
