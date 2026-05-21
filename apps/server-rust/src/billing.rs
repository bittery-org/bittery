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
	create_billing_portal_session, create_checkout_session, create_customer,
	preview_upcoming_team_seat_invoice, update_subscription_item_quantity,
	CheckoutSessionInput,
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
	let checkout = create_checkout_session(CheckoutSessionInput {
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

	let redirect_url = checkout.url.ok_or_else(|| {
		internal_error("Stripe checkout session has no redirect URL")
	})?;

	query(
		"UPDATE team SET billing_plan = $1, billing_status = 'incomplete', updated_at = $2 WHERE id = $3",
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

	let snapshot = get_billing_snapshot(
		bittery_mode(),
		&team.billing_plan,
		&team.billing_status,
	);
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
	let url = create_billing_portal_session(
		stripe_customer_id,
		&format!("{base_url}/billing"),
	)
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
		return Err(forbidden_error(
			"You can only sync seats for your own team",
		));
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
	update_subscription_item_quantity(subscription_item_id, quantity)
		.await
		.map_err(|error| internal_error(&error.to_string()))?;

	query("UPDATE team SET seats_purchased = $1, updated_at = $2 WHERE id = $3")
		.bind(quantity as i32)
		.bind(OffsetDateTime::now_utc())
		.bind(&target_team_id)
		.execute(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to update purchased seats"); internal_error("Failed to update purchased seats") })?;

	Ok(SyncSeatsResponse {
		synced: true,
		reason: None,
		quantity: Some(quantity),
	})
}

pub(crate) async fn sync_team_seats_best_effort(
	pool: &PgPool,
	team_id: &str,
	billing_plan: &str,
) {
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

	if update_subscription_item_quantity(&subscription_item_id, quantity)
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

	match preview_upcoming_team_seat_invoice(
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

async fn load_billing_actor(pool: &PgPool, user_id: &str) -> Result<DbBillingActorRow, BillingRpcError> {
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
			.or_else(|| Some(DbBillingContactRow {
				id: actor.user_id.clone(),
				email: actor.email.clone(),
				name: actor.name.clone(),
			})),
		None => Some(DbBillingContactRow {
			id: actor.user_id.clone(),
			email: actor.email.clone(),
			name: actor.name.clone(),
		}),
	}
	.ok_or_else(|| internal_error("No billing contact found for team"))?;

	let customer_id = create_customer(
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
		.map_err(|e| { tracing::error!(error = %e, "Failed to persist Stripe customer"); internal_error("Failed to persist Stripe customer") })?;

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
	let resolved_entitlements =
		resolve_effective_entitlements(mode, billing_plan, billing_status);
	let limits = resolve_effective_entitlement_limits(
		mode,
		billing_plan,
		&resolved_entitlements,
	);
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
	value.format(&time::format_description::well_known::Rfc3339)
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
	use super::{get_billing_snapshot, self_hosted_billing_status};

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
}