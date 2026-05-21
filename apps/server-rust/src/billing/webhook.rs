use std::{env, fmt};

use chrono::Utc;
use hmac::{Hmac, Mac};
use rand::random;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, PgPool};
use time::OffsetDateTime;

type HmacSha256 = Hmac<Sha256>;

const STRIPE_SIGNATURE_TOLERANCE_SECONDS: i64 = 5 * 60;

#[derive(Debug)]
pub enum StripeWebhookError {
	NotConfigured,
	MissingSignature,
	InvalidSignature,
	InvalidPayload(String),
	Database(String),
}

impl fmt::Display for StripeWebhookError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::NotConfigured => write!(f, "Stripe webhook is not configured"),
			Self::MissingSignature => write!(f, "Missing Stripe signature header"),
			Self::InvalidSignature => write!(f, "Invalid Stripe signature"),
			Self::InvalidPayload(message) | Self::Database(message) => write!(f, "{message}"),
		}
	}
}

impl std::error::Error for StripeWebhookError {}

#[derive(Debug, Deserialize)]
struct StripeWebhookEvent {
	id: String,
	#[serde(rename = "type")]
	kind: String,
	data: StripeWebhookData,
}

#[derive(Debug, Deserialize)]
struct StripeWebhookData {
	object: Value,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct DbBillingTeamRow {
	id: String,
	billing_plan: String,
}

pub(crate) fn is_self_hosted_mode() -> bool {
	match env::var("BITTERY_MODE") {
		Ok(value) => matches!(
			value.trim().to_ascii_lowercase().as_str(),
			"self-hosted" | "self_hosted" | "selfhosted"
		),
		Err(_) => false,
	}
}

pub(crate) fn is_stripe_webhook_configured() -> bool {
	stripe_secret_key_is_configured() && stripe_webhook_secret().is_some()
}

pub(crate) async fn process_stripe_webhook_event(
	pool: &PgPool,
	raw_body: &str,
	signature_header: Option<&str>,
) -> Result<bool, StripeWebhookError> {
	verify_stripe_signature(raw_body, signature_header)?;

	let event = serde_json::from_str::<StripeWebhookEvent>(raw_body)
		.map_err(|error| StripeWebhookError::InvalidPayload(format!("Invalid Stripe event payload: {error}")))?;

	if insert_event_log(pool, &event, raw_body).await? == 0 {
		return Ok(true);
	}

	match event.kind.as_str() {
		"checkout.session.completed" => apply_checkout_session_completed(pool, &event.data.object).await?,
		"customer.subscription.created" => {
			apply_subscription_update(pool, &event.data.object, SubscriptionUpdateKind::Created).await?
		}
		"customer.subscription.updated" => {
			apply_subscription_update(pool, &event.data.object, SubscriptionUpdateKind::Updated).await?
		}
		"customer.subscription.deleted" => {
			apply_subscription_update(pool, &event.data.object, SubscriptionUpdateKind::Deleted).await?
		}
		"invoice.paid" => apply_invoice_status(pool, &event.data.object, "active").await?,
		"invoice.payment_failed" => apply_invoice_status(pool, &event.data.object, "past_due").await?,
		_ => {}
	}

	Ok(false)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SubscriptionUpdateKind {
	Created,
	Updated,
	Deleted,
}

async fn insert_event_log(
	pool: &PgPool,
	event: &StripeWebhookEvent,
	raw_body: &str,
) -> Result<u64, StripeWebhookError> {
	let event_id = hex::encode(random::<[u8; 16]>());
	let payload_hash = hex::encode(Sha256::digest(raw_body.as_bytes()));
	query(
		"INSERT INTO stripe_event_log (id, event_id, event_type, payload_hash, processed_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING",
	)
	.bind(event_id)
	.bind(&event.id)
	.bind(&event.kind)
	.bind(payload_hash)
	.bind(OffsetDateTime::now_utc())
	.execute(pool)
	.await
	.map(|result| result.rows_affected())
	.map_err(|error| StripeWebhookError::Database(format!("Failed to persist Stripe event log: {error}")))
}

async fn apply_checkout_session_completed(
	pool: &PgPool,
	session: &Value,
) -> Result<(), StripeWebhookError> {
	let team_id = metadata_string(session, "teamId").or_else(|| {
		session
			.get("client_reference_id")
			.and_then(Value::as_str)
			.map(str::to_string)
	});
	let stripe_customer_id = to_object_id(session.get("customer"));
	let stripe_subscription_id = to_object_id(session.get("subscription"));
	let plan = parse_plan_id(metadata_string(session, "plan").as_deref());

	let Some(team) = find_team_for_event(
		pool,
		team_id.as_deref(),
		stripe_customer_id.as_deref(),
		stripe_subscription_id.as_deref(),
	)
	.await?
	else {
		return Ok(());
	};

	query(
		"UPDATE team SET billing_plan = COALESCE($1, billing_plan), stripe_customer_id = COALESCE($2, stripe_customer_id), stripe_subscription_id = COALESCE($3, stripe_subscription_id), updated_at = $4 WHERE id = $5",
	)
	.bind(plan)
	.bind(stripe_customer_id)
	.bind(stripe_subscription_id)
	.bind(OffsetDateTime::now_utc())
	.bind(team.id)
	.execute(pool)
	.await
	.map_err(|error| StripeWebhookError::Database(format!("Failed to update Stripe checkout session state: {error}")))?;

	Ok(())
}

async fn apply_subscription_update(
	pool: &PgPool,
	subscription: &Value,
	kind: SubscriptionUpdateKind,
) -> Result<(), StripeWebhookError> {
	let first_item = first_subscription_item(subscription);
	let stripe_price_id = first_item
		.and_then(|item| item.pointer("/price/id"))
		.and_then(Value::as_str)
		.map(str::to_string);
	let stripe_subscription_id = subscription
		.get("id")
		.and_then(Value::as_str)
		.map(str::to_string);

	let Some(team) = find_team_for_event(
		pool,
		metadata_string(subscription, "teamId").as_deref(),
		to_object_id(subscription.get("customer")).as_deref(),
		stripe_subscription_id.as_deref(),
	)
	.await?
	else {
		return Ok(());
	};

	let billing_plan = parse_plan_id(metadata_string(subscription, "plan").as_deref())
		.or_else(|| get_plan_by_stripe_price_id(stripe_price_id.as_deref()))
		.unwrap_or_else(|| team.billing_plan.clone());
	let clear_subscription = kind == SubscriptionUpdateKind::Deleted;
	let stripe_subscription_item_id = if clear_subscription {
		None
	} else {
		first_item
			.and_then(|item| item.get("id"))
			.and_then(Value::as_str)
			.map(str::to_string)
	};
	let current_period_end = if clear_subscription {
		None
	} else {
		first_item
			.and_then(|item| item.get("current_period_end"))
			.and_then(Value::as_i64)
			.and_then(|timestamp| OffsetDateTime::from_unix_timestamp(timestamp).ok())
	};
	let seats_purchased = if clear_subscription || billing_plan != "team" {
		None
	} else {
		first_item
			.and_then(|item| item.get("quantity"))
			.and_then(Value::as_i64)
			.and_then(|quantity| i32::try_from(quantity).ok())
	};
	let billing_status = if clear_subscription {
		"canceled".to_string()
	} else {
		map_stripe_status(subscription.get("status").and_then(Value::as_str)).to_string()
	};

	query(
		"UPDATE team SET billing_plan = $1, billing_status = $2, stripe_customer_id = COALESCE($3, stripe_customer_id), stripe_subscription_id = $4, stripe_subscription_item_id = $5, stripe_price_id = $6, seats_purchased = $7, current_period_end = $8, cancel_at_period_end = $9, updated_at = $10 WHERE id = $11",
	)
	.bind(billing_plan)
	.bind(billing_status)
	.bind(to_object_id(subscription.get("customer")))
	.bind(if clear_subscription { None } else { stripe_subscription_id })
	.bind(stripe_subscription_item_id)
	.bind(if clear_subscription { None } else { stripe_price_id })
	.bind(seats_purchased)
	.bind(current_period_end)
	.bind(if clear_subscription {
		false
	} else {
		subscription
			.get("cancel_at_period_end")
			.and_then(Value::as_bool)
			.unwrap_or(false)
	})
	.bind(OffsetDateTime::now_utc())
	.bind(team.id)
	.execute(pool)
	.await
	.map_err(|error| StripeWebhookError::Database(format!("Failed to update Stripe subscription state: {error}")))?;

	Ok(())
}

async fn apply_invoice_status(
	pool: &PgPool,
	invoice: &Value,
	billing_status: &str,
) -> Result<(), StripeWebhookError> {
	let Some(team) = find_team_for_event(
		pool,
		None,
		to_object_id(invoice.get("customer")).as_deref(),
		get_invoice_subscription_id(invoice).as_deref(),
	)
	.await?
	else {
		return Ok(());
	};

	if team.billing_plan == "free" {
		return Ok(());
	}

	query("UPDATE team SET billing_status = $1, updated_at = $2 WHERE id = $3")
		.bind(billing_status)
		.bind(OffsetDateTime::now_utc())
		.bind(team.id)
		.execute(pool)
		.await
		.map_err(|error| StripeWebhookError::Database(format!("Failed to update invoice billing state: {error}")))?;

	Ok(())
}

async fn find_team_for_event(
	pool: &PgPool,
	team_id: Option<&str>,
	stripe_customer_id: Option<&str>,
	stripe_subscription_id: Option<&str>,
) -> Result<Option<DbBillingTeamRow>, StripeWebhookError> {
	if let Some(team_id) = team_id {
		if let Some(team) = query_as::<_, DbBillingTeamRow>(
			"SELECT id, billing_plan::text FROM team WHERE id = $1 LIMIT 1",
		)
		.bind(team_id)
		.fetch_optional(pool)
		.await
		.map_err(|error| StripeWebhookError::Database(format!("Failed to load billing team by id: {error}")))?
		{
			return Ok(Some(team));
		}
	}

	if let Some(stripe_subscription_id) = stripe_subscription_id {
		if let Some(team) = query_as::<_, DbBillingTeamRow>(
			"SELECT id, billing_plan::text FROM team WHERE stripe_subscription_id = $1 LIMIT 1",
		)
		.bind(stripe_subscription_id)
		.fetch_optional(pool)
		.await
		.map_err(|error| StripeWebhookError::Database(format!("Failed to load billing team by subscription: {error}")))?
		{
			return Ok(Some(team));
		}
	}

	if let Some(stripe_customer_id) = stripe_customer_id {
		return query_as::<_, DbBillingTeamRow>(
			"SELECT id, billing_plan::text FROM team WHERE stripe_customer_id = $1 LIMIT 1",
		)
		.bind(stripe_customer_id)
		.fetch_optional(pool)
		.await
		.map_err(|error| StripeWebhookError::Database(format!("Failed to load billing team by customer: {error}")));
	}

	Ok(None)
}

fn verify_stripe_signature(
	raw_body: &str,
	signature_header: Option<&str>,
) -> Result<(), StripeWebhookError> {
	let webhook_secret = stripe_webhook_secret().ok_or(StripeWebhookError::NotConfigured)?;
	let signature_header = signature_header.ok_or(StripeWebhookError::MissingSignature)?;
	verify_signature(
		&webhook_secret,
		raw_body,
		signature_header,
		Utc::now().timestamp(),
	)
}

fn verify_signature(
	webhook_secret: &str,
	raw_body: &str,
	signature_header: &str,
	now_timestamp: i64,
) -> Result<(), StripeWebhookError> {
	let parsed = parse_signature_header(signature_header)?;
	if (now_timestamp - parsed.timestamp).abs() > STRIPE_SIGNATURE_TOLERANCE_SECONDS {
		return Err(StripeWebhookError::InvalidSignature);
	}

	let signed_payload = format!("{}.{}", parsed.timestamp, raw_body);
	for signature in parsed.v1_signatures {
		let mut mac =
			HmacSha256::new_from_slice(webhook_secret.as_bytes()).map_err(|_| StripeWebhookError::InvalidSignature)?;
		mac.update(signed_payload.as_bytes());
		if mac.verify_slice(&signature).is_ok() {
			return Ok(());
		}
	}

	Err(StripeWebhookError::InvalidSignature)
}

struct ParsedSignatureHeader {
	timestamp: i64,
	v1_signatures: Vec<Vec<u8>>,
}

fn parse_signature_header(signature_header: &str) -> Result<ParsedSignatureHeader, StripeWebhookError> {
	let mut timestamp = None;
	let mut v1_signatures = Vec::new();

	for part in signature_header.split(',') {
		let Some((key, value)) = part.split_once('=') else {
			continue;
		};
		match key.trim() {
			"t" => {
				timestamp = value.trim().parse::<i64>().ok();
			}
			"v1" => {
				if let Ok(decoded) = hex::decode(value.trim()) {
					v1_signatures.push(decoded);
				}
			}
			_ => {}
		}
	}

	match (timestamp, v1_signatures.is_empty()) {
		(Some(timestamp), false) => Ok(ParsedSignatureHeader {
			timestamp,
			v1_signatures,
		}),
		_ => Err(StripeWebhookError::InvalidSignature),
	}
}

fn stripe_webhook_secret() -> Option<String> {
	env::var("STRIPE_WEBHOOK_SECRET")
		.ok()
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty())
}

fn stripe_secret_key_is_configured() -> bool {
	env::var("STRIPE_SECRET_KEY")
		.ok()
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty())
		.is_some()
}

fn parse_plan_id(value: Option<&str>) -> Option<String> {
	match value {
		Some("free" | "personal" | "family" | "team") => value.map(str::to_string),
		_ => None,
	}
}

fn map_stripe_status(status: Option<&str>) -> &'static str {
	match status {
		Some("active") => "active",
		Some("trialing") => "trialing",
		Some("past_due") => "past_due",
		Some("canceled") => "canceled",
		Some("unpaid") => "unpaid",
		_ => "incomplete",
	}
}

fn get_plan_by_stripe_price_id(price_id: Option<&str>) -> Option<String> {
	let price_id = price_id?;
	for (plan, env_name) in [
		("personal", "STRIPE_PRICE_PERSONAL_MONTHLY"),
		("family", "STRIPE_PRICE_FAMILY_MONTHLY"),
		("team", "STRIPE_PRICE_TEAM_SEAT_MONTHLY"),
	] {
		if env::var(env_name).ok().as_deref().map(str::trim) == Some(price_id) {
			return Some(plan.to_string());
		}
	}
	None
}

fn to_object_id(value: Option<&Value>) -> Option<String> {
	match value {
		Some(Value::String(id)) => Some(id.clone()),
		Some(Value::Object(map)) => map.get("id").and_then(Value::as_str).map(str::to_string),
		_ => None,
	}
}

fn metadata_string(object: &Value, key: &str) -> Option<String> {
	object
		.get("metadata")
		.and_then(|metadata| metadata.get(key))
		.and_then(Value::as_str)
		.map(str::to_string)
}

fn first_subscription_item(subscription: &Value) -> Option<&Value> {
	subscription
		.get("items")
		.and_then(|items| items.get("data"))
		.and_then(Value::as_array)
		.and_then(|items| items.first())
}

fn get_invoice_subscription_id(invoice: &Value) -> Option<String> {
	to_object_id(
		invoice
			.get("parent")
			.and_then(|parent| parent.get("subscription_details"))
			.and_then(|details| details.get("subscription")),
	)
}

#[cfg(test)]
mod tests {
	use super::{verify_signature, StripeWebhookError};
	use hmac::{Hmac, Mac};
	use sha2::Sha256;

	type TestHmacSha256 = Hmac<Sha256>;

	#[test]
	fn verifies_valid_signature() {
		let body = r#"{"id":"evt_123"}"#;
		let secret = "whsec_test";
		let timestamp = 1_717_300_000_i64;
		let signed_payload = format!("{timestamp}.{body}");
		let mut mac = TestHmacSha256::new_from_slice(secret.as_bytes())
			.expect("test secret should be valid");
		mac.update(signed_payload.as_bytes());
		let signature = hex::encode(mac.finalize().into_bytes());

		assert!(verify_signature(
			secret,
			body,
			&format!("t={timestamp},v1={signature}"),
			timestamp,
		)
		.is_ok());
	}

	#[test]
	fn rejects_invalid_signature() {
		let result = verify_signature(
			"whsec_test",
			r#"{"id":"evt_123"}"#,
			"t=1717300000,v1=deadbeef",
			1_717_300_000,
		);

		assert!(matches!(result, Err(StripeWebhookError::InvalidSignature)));
	}
	}