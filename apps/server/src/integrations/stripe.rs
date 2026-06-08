use std::{fmt, sync::OnceLock};

use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use time::OffsetDateTime;

const STRIPE_API_BASE: &str = "https://api.stripe.com/v1";

#[derive(Debug)]
pub enum StripeClientError {
    NotConfigured,
    RequestFailed(String),
    InvalidResponse(String),
}

impl fmt::Display for StripeClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotConfigured => write!(f, "Stripe is not configured"),
            Self::RequestFailed(message) | Self::InvalidResponse(message) => {
                write!(f, "{message}")
            }
        }
    }
}

impl std::error::Error for StripeClientError {}

#[derive(Debug, Clone)]
pub struct CheckoutSessionInput<'a> {
    pub team_id: &'a str,
    pub user_id: &'a str,
    pub customer_id: Option<&'a str>,
    pub customer_email: &'a str,
    pub plan: &'a str,
    pub price_id: &'a str,
    pub quantity: i64,
    pub success_url: String,
    pub cancel_url: String,
}

#[derive(Debug, Clone)]
pub struct CheckoutSession {
    pub id: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TeamSeatInvoicePreviewLine {
    pub id: String,
    pub description: String,
    pub amount_cents: i64,
    pub currency: String,
    pub period_start: OffsetDateTime,
    pub period_end: OffsetDateTime,
    pub quantity: Option<i64>,
    pub unit_amount_cents: Option<i64>,
    pub is_proration: bool,
}

#[derive(Debug, Clone)]
pub struct TeamSeatInvoicePreview {
    pub currency: String,
    pub current_quantity: i64,
    pub next_quantity: i64,
    pub estimated_next_payment_cents: i64,
    pub total_line_items_cents: i64,
    pub lines: Vec<TeamSeatInvoicePreviewLine>,
}

#[derive(Debug, Deserialize)]
struct StripeCustomerResponse {
    id: String,
}

#[derive(Debug, Deserialize)]
struct StripeCheckoutSessionResponse {
    id: String,
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StripeBillingPortalSessionResponse {
    url: String,
}

#[derive(Debug, Deserialize)]
struct StripeList<T> {
    data: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct StripeSubscriptionResponse {
    currency: Option<String>,
    items: StripeList<StripeSubscriptionItem>,
}

#[derive(Debug, Deserialize)]
struct StripeSubscriptionItem {
    id: String,
    quantity: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct StripeInvoicePreviewResponse {
    currency: Option<String>,
    amount_due: Option<i64>,
    total: Option<i64>,
    lines: StripeList<StripeInvoiceLine>,
}

#[derive(Debug, Clone, Deserialize)]
struct StripeInvoiceLine {
    id: String,
    description: Option<String>,
    amount: i64,
    currency: Option<String>,
    period: StripePeriod,
    quantity: Option<i64>,
    pricing: Option<StripeLinePricing>,
    parent: Option<StripeInvoiceLineParent>,
}

#[derive(Debug, Clone, Deserialize)]
struct StripePeriod {
    start: i64,
    end: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct StripeLinePricing {
    unit_amount_decimal: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct StripeInvoiceLineParent {
    subscription_item_details: Option<StripeSubscriptionItemDetails>,
    invoice_item_details: Option<StripeInvoiceItemDetails>,
}

#[derive(Debug, Clone, Deserialize)]
struct StripeSubscriptionItemDetails {
    proration: Option<bool>,
    subscription_item: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct StripeInvoiceItemDetails {
    proration: Option<bool>,
    subscription: Option<String>,
}

pub async fn create_customer(
    email: &str,
    name: &str,
    team_id: &str,
    user_id: &str,
) -> Result<String, StripeClientError> {
    let response: StripeCustomerResponse = post_form(
        "/customers",
        vec![
            ("email".to_string(), email.to_string()),
            ("name".to_string(), name.to_string()),
            ("metadata[teamId]".to_string(), team_id.to_string()),
            (
                "metadata[initiatedByUserId]".to_string(),
                user_id.to_string(),
            ),
        ],
    )
    .await?;

    Ok(response.id)
}

pub async fn create_checkout_session(
    input: CheckoutSessionInput<'_>,
) -> Result<CheckoutSession, StripeClientError> {
    let mut form = vec![
        ("mode".to_string(), "subscription".to_string()),
        ("success_url".to_string(), input.success_url),
        ("cancel_url".to_string(), input.cancel_url),
        ("client_reference_id".to_string(), input.team_id.to_string()),
        ("allow_promotion_codes".to_string(), "true".to_string()),
        (
            "line_items[0][price]".to_string(),
            input.price_id.to_string(),
        ),
        (
            "line_items[0][quantity]".to_string(),
            input.quantity.max(1).to_string(),
        ),
        ("metadata[teamId]".to_string(), input.team_id.to_string()),
        ("metadata[plan]".to_string(), input.plan.to_string()),
        (
            "metadata[initiatedByUserId]".to_string(),
            input.user_id.to_string(),
        ),
        (
            "subscription_data[metadata][teamId]".to_string(),
            input.team_id.to_string(),
        ),
        (
            "subscription_data[metadata][plan]".to_string(),
            input.plan.to_string(),
        ),
        (
            "subscription_data[metadata][initiatedByUserId]".to_string(),
            input.user_id.to_string(),
        ),
    ];

    if let Some(customer_id) = input.customer_id {
        form.push(("customer".to_string(), customer_id.to_string()));
    } else {
        form.push((
            "customer_email".to_string(),
            input.customer_email.to_string(),
        ));
    }

    let response: StripeCheckoutSessionResponse = post_form("/checkout/sessions", form).await?;
    Ok(CheckoutSession {
        id: response.id,
        url: response.url,
    })
}

pub async fn create_billing_portal_session(
    customer_id: &str,
    return_url: &str,
) -> Result<String, StripeClientError> {
    let response: StripeBillingPortalSessionResponse = post_form(
        "/billing_portal/sessions",
        vec![
            ("customer".to_string(), customer_id.to_string()),
            ("return_url".to_string(), return_url.to_string()),
        ],
    )
    .await?;

    Ok(response.url)
}

pub async fn update_subscription_item_quantity(
    subscription_item_id: &str,
    quantity: i64,
) -> Result<(), StripeClientError> {
    let _: serde_json::Value = post_form(
        &format!("/subscription_items/{subscription_item_id}"),
        vec![
            ("quantity".to_string(), quantity.max(1).to_string()),
            (
                "proration_behavior".to_string(),
                "create_prorations".to_string(),
            ),
        ],
    )
    .await?;
    Ok(())
}

pub async fn preview_upcoming_team_seat_invoice(
    stripe_customer_id: &str,
    stripe_subscription_id: &str,
    stripe_subscription_item_id: Option<&str>,
    seats_purchased: Option<i32>,
    seat_increment: i64,
) -> Result<Option<TeamSeatInvoicePreview>, StripeClientError> {
    let subscription: StripeSubscriptionResponse = get_json(
        &format!("/subscriptions/{stripe_subscription_id}"),
        vec![("expand[]".to_string(), "items.data.price".to_string())],
    )
    .await?;

    let subscription_item = stripe_subscription_item_id
        .and_then(|item_id| {
            subscription
                .items
                .data
                .iter()
                .find(|item| item.id == item_id)
        })
        .or_else(|| subscription.items.data.first());
    let Some(subscription_item) = subscription_item else {
        return Ok(None);
    };

    let current_quantity = subscription_item
        .quantity
        .unwrap_or_else(|| seats_purchased.unwrap_or(1) as i64)
        .max(1);
    let next_quantity = current_quantity + seat_increment.max(1);

    let upcoming_invoice: StripeInvoicePreviewResponse = post_form(
        "/invoices/create_preview",
        vec![
            ("customer".to_string(), stripe_customer_id.to_string()),
            (
                "subscription".to_string(),
                stripe_subscription_id.to_string(),
            ),
            (
                "subscription_details[items][0][id]".to_string(),
                subscription_item.id.clone(),
            ),
            (
                "subscription_details[items][0][quantity]".to_string(),
                next_quantity.to_string(),
            ),
        ],
    )
    .await?;

    let fallback_currency = upcoming_invoice
        .currency
        .clone()
        .or(subscription.currency.clone())
        .unwrap_or_else(|| "eur".to_string());

    let non_zero_lines = upcoming_invoice
        .lines
        .data
        .into_iter()
        .filter(|line| line.amount != 0)
        .collect::<Vec<_>>();

    let subscription_scoped_lines = non_zero_lines
        .iter()
        .filter(|line| {
            let subscription_item_match = line
                .parent
                .as_ref()
                .and_then(|parent| parent.subscription_item_details.as_ref())
                .and_then(|details| details.subscription_item.as_deref())
                == Some(subscription_item.id.as_str());
            let subscription_match = line
                .parent
                .as_ref()
                .and_then(|parent| parent.invoice_item_details.as_ref())
                .and_then(|details| details.subscription.as_deref())
                == Some(stripe_subscription_id);
            subscription_item_match || subscription_match
        })
        .cloned()
        .collect::<Vec<_>>();

    let source_lines = if subscription_scoped_lines.is_empty() {
        non_zero_lines
    } else {
        subscription_scoped_lines
    };

    let mut lines = source_lines
        .into_iter()
        .filter(|line| line.amount != 0)
        .map(
            |line| -> Result<TeamSeatInvoicePreviewLine, StripeClientError> {
                let period_start =
                    OffsetDateTime::from_unix_timestamp(line.period.start).map_err(|_| {
                        StripeClientError::InvalidResponse(
                            "Invalid Stripe period start".to_string(),
                        )
                    })?;
                let period_end =
                    OffsetDateTime::from_unix_timestamp(line.period.end).map_err(|_| {
                        StripeClientError::InvalidResponse("Invalid Stripe period end".to_string())
                    })?;
                let unit_amount_cents = get_line_unit_amount_cents(&line);
                let is_proration = is_proration_line(&line);

                Ok(TeamSeatInvoicePreviewLine {
                    id: line.id,
                    description: line
                        .description
                        .clone()
                        .unwrap_or_else(|| "Team".to_string()),
                    amount_cents: line.amount,
                    currency: line
                        .currency
                        .clone()
                        .unwrap_or_else(|| fallback_currency.clone()),
                    period_start,
                    period_end,
                    quantity: line.quantity,
                    unit_amount_cents,
                    is_proration,
                })
            },
        )
        .collect::<Result<Vec<_>, _>>()?;
    lines.sort_by_key(|line| line.period_start);

    let total_line_items_cents = lines.iter().map(|line| line.amount_cents).sum::<i64>();
    let estimated_next_payment_cents = upcoming_invoice
        .amount_due
        .or(upcoming_invoice.total)
        .unwrap_or(total_line_items_cents);

    Ok(Some(TeamSeatInvoicePreview {
        currency: fallback_currency,
        current_quantity,
        next_quantity,
        estimated_next_payment_cents,
        total_line_items_cents,
        lines,
    }))
}

fn is_proration_line(line: &StripeInvoiceLine) -> bool {
    line.parent
        .as_ref()
        .and_then(|parent| parent.subscription_item_details.as_ref())
        .and_then(|details| details.proration)
        == Some(true)
        || line
            .parent
            .as_ref()
            .and_then(|parent| parent.invoice_item_details.as_ref())
            .and_then(|details| details.proration)
            == Some(true)
}

fn get_line_unit_amount_cents(line: &StripeInvoiceLine) -> Option<i64> {
    if let Some(amount_decimal) = line
        .pricing
        .as_ref()
        .and_then(|pricing| pricing.unit_amount_decimal.as_deref())
    {
        if let Ok(parsed) = amount_decimal.parse::<f64>() {
            if parsed.is_finite() {
                return Some(parsed.round() as i64);
            }
        }
    }

    match line.quantity {
        Some(quantity) if quantity > 0 => {
            Some((line.amount as f64 / quantity as f64).round() as i64)
        }
        _ => None,
    }
}

fn http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .expect("stripe http client should build")
    })
}

async fn post_form<T: DeserializeOwned>(
    path: &str,
    form: Vec<(String, String)>,
) -> Result<T, StripeClientError> {
    let secret_key = stripe_secret_key()?;
    let response = http_client()
        .post(format!("{STRIPE_API_BASE}{path}"))
        .bearer_auth(secret_key)
        .form(&form)
        .send()
        .await
        .map_err(|error| {
            StripeClientError::RequestFailed(format!("Stripe request failed: {error}"))
        })?;

    parse_response(response).await
}

async fn get_json<T: DeserializeOwned>(
    path: &str,
    query: Vec<(String, String)>,
) -> Result<T, StripeClientError> {
    let secret_key = stripe_secret_key()?;
    let response = http_client()
        .get(format!("{STRIPE_API_BASE}{path}"))
        .bearer_auth(secret_key)
        .query(&query)
        .send()
        .await
        .map_err(|error| {
            StripeClientError::RequestFailed(format!("Stripe request failed: {error}"))
        })?;

    parse_response(response).await
}

async fn parse_response<T: DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, StripeClientError> {
    let status = response.status();
    let body = response.text().await.map_err(|error| {
        StripeClientError::RequestFailed(format!("Failed to read Stripe response: {error}"))
    })?;

    if !status.is_success() {
        return Err(StripeClientError::RequestFailed(format!(
            "Stripe API request failed with status {}: {}",
            status, body
        )));
    }

    serde_json::from_str(&body).map_err(|error| {
        StripeClientError::InvalidResponse(format!("Failed to parse Stripe response: {error}"))
    })
}

fn stripe_secret_key() -> Result<String, StripeClientError> {
    std::env::var("STRIPE_SECRET_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or(StripeClientError::NotConfigured)
}
