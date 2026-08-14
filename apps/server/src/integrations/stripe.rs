use std::fmt;

use async_trait::async_trait;
use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use time::OffsetDateTime;

const STRIPE_API_BASE: &str = "https://api.stripe.com/v1";

#[derive(Debug)]
pub enum StripeClientError {
    RequestFailed(String),
    InvalidResponse(String),
}

impl fmt::Display for StripeClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RequestFailed(message) | Self::InvalidResponse(message) => {
                write!(f, "{message}")
            }
        }
    }
}

impl std::error::Error for StripeClientError {}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckoutSessionInput {
    pub team_id: String,
    pub user_id: String,
    pub customer_id: Option<String>,
    pub customer_email: String,
    pub plan: String,
    pub price_id: String,
    pub quantity: i64,
    pub success_url: String,
    pub cancel_url: String,
}

#[async_trait]
pub trait BillingGateway: Send + Sync {
    async fn create_customer(
        &self,
        email: String,
        name: String,
        team_id: String,
        user_id: String,
    ) -> Result<String, StripeClientError>;
    async fn create_checkout_session(
        &self,
        input: CheckoutSessionInput,
    ) -> Result<CheckoutSession, StripeClientError>;
    async fn create_billing_portal_session(
        &self,
        customer_id: String,
        return_url: String,
    ) -> Result<String, StripeClientError>;
    async fn update_subscription_item_quantity(
        &self,
        subscription_item_id: String,
        quantity: i64,
    ) -> Result<(), StripeClientError>;
    async fn preview_upcoming_team_seat_invoice(
        &self,
        stripe_customer_id: String,
        stripe_subscription_id: String,
        stripe_subscription_item_id: Option<String>,
        seats_purchased: Option<i32>,
        seat_increment: i64,
    ) -> Result<Option<TeamSeatInvoicePreview>, StripeClientError>;
}

#[derive(Debug)]
pub struct StripeBillingGateway {
    client: Client,
    secret_key: String,
}

impl StripeBillingGateway {
    pub fn from_env() -> Result<Option<Self>, StripeClientError> {
        let Some(secret_key) = std::env::var("STRIPE_SECRET_KEY")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        else {
            return Ok(None);
        };
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|error| {
                StripeClientError::InvalidResponse(format!(
                    "Failed to build Stripe HTTP client: {error}"
                ))
            })?;
        Ok(Some(Self { client, secret_key }))
    }
}

#[async_trait]
impl BillingGateway for StripeBillingGateway {
    async fn create_customer(
        &self,
        email: String,
        name: String,
        team_id: String,
        user_id: String,
    ) -> Result<String, StripeClientError> {
        create_customer(
            &self.client,
            &self.secret_key,
            &email,
            &name,
            &team_id,
            &user_id,
        )
        .await
    }

    async fn create_checkout_session(
        &self,
        input: CheckoutSessionInput,
    ) -> Result<CheckoutSession, StripeClientError> {
        create_checkout_session(&self.client, &self.secret_key, input).await
    }

    async fn create_billing_portal_session(
        &self,
        customer_id: String,
        return_url: String,
    ) -> Result<String, StripeClientError> {
        create_billing_portal_session(&self.client, &self.secret_key, &customer_id, &return_url)
            .await
    }

    async fn update_subscription_item_quantity(
        &self,
        subscription_item_id: String,
        quantity: i64,
    ) -> Result<(), StripeClientError> {
        update_subscription_item_quantity(
            &self.client,
            &self.secret_key,
            &subscription_item_id,
            quantity,
        )
        .await
    }

    async fn preview_upcoming_team_seat_invoice(
        &self,
        stripe_customer_id: String,
        stripe_subscription_id: String,
        stripe_subscription_item_id: Option<String>,
        seats_purchased: Option<i32>,
        seat_increment: i64,
    ) -> Result<Option<TeamSeatInvoicePreview>, StripeClientError> {
        preview_upcoming_team_seat_invoice(
            &self.client,
            &self.secret_key,
            &stripe_customer_id,
            &stripe_subscription_id,
            stripe_subscription_item_id.as_deref(),
            seats_purchased,
            seat_increment,
        )
        .await
    }
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

async fn create_customer(
    client: &Client,
    secret_key: &str,
    email: &str,
    name: &str,
    team_id: &str,
    user_id: &str,
) -> Result<String, StripeClientError> {
    let response: StripeCustomerResponse = post_form(
        client,
        secret_key,
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

async fn create_checkout_session(
    client: &Client,
    secret_key: &str,
    input: CheckoutSessionInput,
) -> Result<CheckoutSession, StripeClientError> {
    let mut form = vec![
        ("mode".to_string(), "subscription".to_string()),
        ("success_url".to_string(), input.success_url),
        ("cancel_url".to_string(), input.cancel_url),
        ("client_reference_id".to_string(), input.team_id.clone()),
        ("allow_promotion_codes".to_string(), "true".to_string()),
        ("line_items[0][price]".to_string(), input.price_id.clone()),
        (
            "line_items[0][quantity]".to_string(),
            input.quantity.max(1).to_string(),
        ),
        ("metadata[teamId]".to_string(), input.team_id.clone()),
        ("metadata[plan]".to_string(), input.plan.clone()),
        (
            "metadata[initiatedByUserId]".to_string(),
            input.user_id.clone(),
        ),
        (
            "subscription_data[metadata][teamId]".to_string(),
            input.team_id.clone(),
        ),
        (
            "subscription_data[metadata][plan]".to_string(),
            input.plan.clone(),
        ),
        (
            "subscription_data[metadata][initiatedByUserId]".to_string(),
            input.user_id.clone(),
        ),
    ];

    if let Some(customer_id) = input.customer_id {
        form.push(("customer".to_string(), customer_id));
    } else {
        form.push(("customer_email".to_string(), input.customer_email));
    }

    let response: StripeCheckoutSessionResponse =
        post_form(client, secret_key, "/checkout/sessions", form).await?;
    Ok(CheckoutSession {
        id: response.id,
        url: response.url,
    })
}

async fn create_billing_portal_session(
    client: &Client,
    secret_key: &str,
    customer_id: &str,
    return_url: &str,
) -> Result<String, StripeClientError> {
    let response: StripeBillingPortalSessionResponse = post_form(
        client,
        secret_key,
        "/billing_portal/sessions",
        vec![
            ("customer".to_string(), customer_id.to_string()),
            ("return_url".to_string(), return_url.to_string()),
        ],
    )
    .await?;

    Ok(response.url)
}

async fn update_subscription_item_quantity(
    client: &Client,
    secret_key: &str,
    subscription_item_id: &str,
    quantity: i64,
) -> Result<(), StripeClientError> {
    let _: serde_json::Value = post_form(
        client,
        secret_key,
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

async fn preview_upcoming_team_seat_invoice(
    client: &Client,
    secret_key: &str,
    stripe_customer_id: &str,
    stripe_subscription_id: &str,
    stripe_subscription_item_id: Option<&str>,
    seats_purchased: Option<i32>,
    seat_increment: i64,
) -> Result<Option<TeamSeatInvoicePreview>, StripeClientError> {
    let subscription: StripeSubscriptionResponse = get_json(
        client,
        secret_key,
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
        client,
        secret_key,
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

async fn post_form<T: DeserializeOwned>(
    client: &Client,
    secret_key: &str,
    path: &str,
    form: Vec<(String, String)>,
) -> Result<T, StripeClientError> {
    let response = client
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
    client: &Client,
    secret_key: &str,
    path: &str,
    query: Vec<(String, String)>,
) -> Result<T, StripeClientError> {
    let response = client
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

#[cfg(test)]
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum BillingGatewayCall {
    CreateCustomer {
        email: String,
        name: String,
        team_id: String,
        user_id: String,
    },
    CreateCheckoutSession(CheckoutSessionInput),
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
pub(crate) struct TestBillingGateway {
    calls: std::sync::Mutex<Vec<BillingGatewayCall>>,
    failure: Option<String>,
}

#[cfg(test)]
impl Default for TestBillingGateway {
    fn default() -> Self {
        Self {
            calls: std::sync::Mutex::new(Vec::new()),
            failure: None,
        }
    }
}

#[cfg(test)]
impl TestBillingGateway {
    pub(crate) fn failing(message: impl Into<String>) -> Self {
        Self {
            failure: Some(message.into()),
            ..Self::default()
        }
    }
    pub(crate) fn calls(&self) -> Vec<BillingGatewayCall> {
        self.calls
            .lock()
            .expect("billing gateway calls should be lockable")
            .clone()
    }
    fn result<T>(&self, value: T) -> Result<T, StripeClientError> {
        self.failure.as_ref().map_or(Ok(value), |message| {
            Err(StripeClientError::RequestFailed(message.clone()))
        })
    }
    fn record(&self, call: BillingGatewayCall) {
        self.calls
            .lock()
            .expect("billing gateway calls should be lockable")
            .push(call);
    }
}

#[cfg(test)]
#[async_trait]
impl BillingGateway for TestBillingGateway {
    async fn create_customer(
        &self,
        email: String,
        name: String,
        team_id: String,
        user_id: String,
    ) -> Result<String, StripeClientError> {
        self.record(BillingGatewayCall::CreateCustomer {
            email,
            name,
            team_id,
            user_id,
        });
        self.result("cus_test_123".to_string())
    }
    async fn create_checkout_session(
        &self,
        input: CheckoutSessionInput,
    ) -> Result<CheckoutSession, StripeClientError> {
        self.record(BillingGatewayCall::CreateCheckoutSession(input));
        self.result(CheckoutSession {
            id: "cs_test_123".to_string(),
            url: Some("https://checkout.stripe.test/session/cs_test_123".to_string()),
        })
    }
    async fn create_billing_portal_session(
        &self,
        customer_id: String,
        return_url: String,
    ) -> Result<String, StripeClientError> {
        self.record(BillingGatewayCall::CreateBillingPortalSession {
            customer_id,
            return_url,
        });
        self.result("https://billing.stripe.test/portal/session_123".to_string())
    }
    async fn update_subscription_item_quantity(
        &self,
        subscription_item_id: String,
        quantity: i64,
    ) -> Result<(), StripeClientError> {
        self.record(BillingGatewayCall::UpdateSubscriptionItemQuantity {
            subscription_item_id,
            quantity,
        });
        self.result(())
    }
    async fn preview_upcoming_team_seat_invoice(
        &self,
        stripe_customer_id: String,
        stripe_subscription_id: String,
        stripe_subscription_item_id: Option<String>,
        seats_purchased: Option<i32>,
        seat_increment: i64,
    ) -> Result<Option<TeamSeatInvoicePreview>, StripeClientError> {
        self.record(BillingGatewayCall::PreviewUpcomingTeamSeatInvoice {
            stripe_customer_id,
            stripe_subscription_id,
            stripe_subscription_item_id,
            seats_purchased,
            seat_increment,
        });
        self.result(Some(TeamSeatInvoicePreview {
            currency: "usd".to_string(),
            current_quantity: 3,
            next_quantity: 4,
            estimated_next_payment_cents: 750,
            total_line_items_cents: 750,
            lines: vec![TeamSeatInvoicePreviewLine {
                id: "il_preview_123".to_string(),
                description: "Additional team seat".to_string(),
                amount_cents: 750,
                currency: "usd".to_string(),
                period_start: OffsetDateTime::from_unix_timestamp(1_717_300_000).unwrap(),
                period_end: OffsetDateTime::from_unix_timestamp(1_719_892_800).unwrap(),
                quantity: Some(1),
                unit_amount_cents: Some(750),
                is_proration: true,
            }],
        }))
    }
}
