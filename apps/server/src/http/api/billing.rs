use axum::{
    extract::{DefaultBodyLimit, State},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    config::db_pool,
    services::billing::{self, CheckoutPlanInput},
    AppState,
};

use super::{
    dto::{DecimalString, ProblemDetails},
    error::ApiError,
    extract::{ApiJson, AuthenticatedRequest},
    ORDINARY_API_BODY_LIMIT_BYTES,
};

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckoutSessionRequest {
    plan: Option<CheckoutPlan>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
enum CheckoutPlan {
    Personal,
    Family,
    Team,
}

impl CheckoutPlan {
    fn into_wire_value(self) -> String {
        match self {
            Self::Personal => "personal",
            Self::Family => "family",
            Self::Team => "team",
        }
        .to_string()
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct BillingStatusResponse {
    enabled: bool,
    plan: String,
    status: String,
    is_active: bool,
    requires_payment: bool,
    is_stripe_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stripe_customer_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stripe_subscription_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stripe_price_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_period_end: Option<String>,
    cancel_at_period_end: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    seats_purchased: Option<i32>,
}

impl From<billing::BillingStatusResponse> for BillingStatusResponse {
    fn from(value: billing::BillingStatusResponse) -> Self {
        Self {
            enabled: value.enabled,
            plan: value.plan,
            status: value.status,
            is_active: value.is_active,
            requires_payment: value.requires_payment,
            is_stripe_configured: value.is_stripe_configured,
            stripe_customer_id: value.stripe_customer_id,
            stripe_subscription_id: value.stripe_subscription_id,
            stripe_price_id: value.stripe_price_id,
            current_period_end: value.current_period_end,
            cancel_at_period_end: value.cancel_at_period_end,
            seats_purchased: value.seats_purchased,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct BillingEntitlements {
    sentinel: bool,
    team_management: bool,
    vault_sharing: bool,
    share_links: bool,
    billing_portal: bool,
    attachments: bool,
}

impl From<billing::BillingEntitlements> for BillingEntitlements {
    fn from(value: billing::BillingEntitlements) -> Self {
        Self {
            sentinel: value.sentinel,
            team_management: value.team_management,
            vault_sharing: value.vault_sharing,
            share_links: value.share_links,
            billing_portal: value.billing_portal,
            attachments: value.attachments,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct EntitlementLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    share_links: Option<DecimalString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shared_vaults: Option<DecimalString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment_max_file_size_bytes: Option<DecimalString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment_storage_bytes: Option<DecimalString>,
}

impl From<billing::EntitlementLimits> for EntitlementLimits {
    fn from(value: billing::EntitlementLimits) -> Self {
        Self {
            share_links: value.share_links.map(Into::into),
            shared_vaults: value.shared_vaults.map(Into::into),
            attachment_max_file_size_bytes: value.attachment_max_file_size_bytes.map(Into::into),
            attachment_storage_bytes: value.attachment_storage_bytes.map(Into::into),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct BillingEntitlementsResponse {
    mode: String,
    billing_enabled: bool,
    plan: String,
    status: String,
    is_active: bool,
    entitlements: BillingEntitlements,
    limits: EntitlementLimits,
}

impl From<billing::BillingEntitlementsResponse> for BillingEntitlementsResponse {
    fn from(value: billing::BillingEntitlementsResponse) -> Self {
        Self {
            mode: value.mode,
            billing_enabled: value.billing_enabled,
            plan: value.plan,
            status: value.status,
            is_active: value.is_active,
            entitlements: value.entitlements.into(),
            limits: value.limits.into(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct AttachmentUsageResponse {
    mode: String,
    attachments_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    quota_bytes: Option<DecimalString>,
    committed_storage_bytes: DecimalString,
}

impl From<billing::AttachmentUsageResponse> for AttachmentUsageResponse {
    fn from(value: billing::AttachmentUsageResponse) -> Self {
        Self {
            mode: value.mode,
            attachments_enabled: value.attachments_enabled,
            quota_bytes: value.quota_bytes.map(Into::into),
            committed_storage_bytes: value.committed_storage_bytes.into(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct CheckoutSessionResponse {
    url: String,
    session_id: String,
}

impl From<billing::CheckoutSessionResponse> for CheckoutSessionResponse {
    fn from(value: billing::CheckoutSessionResponse) -> Self {
        Self {
            url: value.url,
            session_id: value.session_id,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
struct PortalSessionResponse {
    url: String,
}

impl From<billing::PortalSessionResponse> for PortalSessionResponse {
    fn from(value: billing::PortalSessionResponse) -> Self {
        Self { url: value.url }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct TeamSeatInvoicePreviewLineResponse {
    id: String,
    description: String,
    amount_cents: DecimalString,
    currency: String,
    period_start: String,
    period_end: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    quantity: Option<DecimalString>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unit_amount_cents: Option<DecimalString>,
    is_proration: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct TeamSeatInvoicePreviewResponse {
    currency: String,
    current_quantity: DecimalString,
    next_quantity: DecimalString,
    estimated_next_payment_cents: DecimalString,
    total_line_items_cents: DecimalString,
    #[schema(max_items = 500)]
    lines: Vec<TeamSeatInvoicePreviewLineResponse>,
}

impl From<billing::TeamSeatInvoicePreviewResponse> for TeamSeatInvoicePreviewResponse {
    fn from(value: billing::TeamSeatInvoicePreviewResponse) -> Self {
        Self {
            currency: value.currency,
            current_quantity: value.current_quantity.into(),
            next_quantity: value.next_quantity.into(),
            estimated_next_payment_cents: value.estimated_next_payment_cents.into(),
            total_line_items_cents: value.total_line_items_cents.into(),
            lines: value
                .lines
                .into_iter()
                .map(|line| TeamSeatInvoicePreviewLineResponse {
                    id: line.id,
                    description: line.description,
                    amount_cents: line.amount_cents.into(),
                    currency: line.currency,
                    period_start: line.period_start,
                    period_end: line.period_end,
                    quantity: line.quantity.map(Into::into),
                    unit_amount_cents: line.unit_amount_cents.map(Into::into),
                    is_proration: line.is_proration,
                })
                .collect(),
        }
    }
}

#[derive(IntoResponses)]
#[allow(dead_code)]
enum BillingErrorResponses {
    #[response(
        status = 400,
        description = "Bad request",
        content_type = "application/problem+json"
    )]
    BadRequest(ProblemDetails),
    #[response(
        status = 401,
        description = "Authentication required",
        content_type = "application/problem+json"
    )]
    Unauthorized(ProblemDetails),
    #[response(
        status = 403,
        description = "Forbidden",
        content_type = "application/problem+json"
    )]
    Forbidden(ProblemDetails),
    #[response(
        status = 404,
        description = "Not found",
        content_type = "application/problem+json"
    )]
    NotFound(ProblemDetails),
    #[response(
        status = 500,
        description = "Internal error",
        content_type = "application/problem+json"
    )]
    Internal(ProblemDetails),
}

#[utoipa::path(get, path = "/billing/status", operation_id = "getBillingStatus", tag = "billing", responses((status = 200, body = BillingStatusResponse), BillingErrorResponses))]
async fn status(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
) -> Result<Json<BillingStatusResponse>, ApiError> {
    Ok(Json(
        billing::get_billing_status(db_pool(&state)?, &request.session.user_id)
            .await?
            .into(),
    ))
}

#[utoipa::path(get, path = "/billing/entitlements", operation_id = "getBillingEntitlements", tag = "billing", responses((status = 200, body = BillingEntitlementsResponse), BillingErrorResponses))]
async fn entitlements(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
) -> Result<Json<BillingEntitlementsResponse>, ApiError> {
    Ok(Json(
        billing::get_billing_entitlements(state.db_pool.as_ref(), &request.session.user_id)
            .await?
            .into(),
    ))
}

#[utoipa::path(get, path = "/billing/attachment-usage", operation_id = "getAttachmentUsage", tag = "billing", responses((status = 200, body = AttachmentUsageResponse), BillingErrorResponses))]
async fn attachment_usage(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
) -> Result<Json<AttachmentUsageResponse>, ApiError> {
    Ok(Json(
        billing::get_attachment_usage(db_pool(&state)?, &request.session.user_id)
            .await?
            .into(),
    ))
}

#[utoipa::path(post, path = "/billing/checkout-sessions", operation_id = "createBillingCheckoutSession", tag = "billing", request_body = CheckoutSessionRequest, responses((status = 200, body = CheckoutSessionResponse), BillingErrorResponses))]
async fn create_checkout_session(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
    ApiJson(body): ApiJson<CheckoutSessionRequest>,
) -> Result<Json<CheckoutSessionResponse>, ApiError> {
    Ok(Json(
        billing::create_checkout_session(
            db_pool(&state)?,
            &request.session.user_id,
            CheckoutPlanInput {
                plan: body.plan.map(CheckoutPlan::into_wire_value),
            },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(post, path = "/billing/portal-sessions", operation_id = "createBillingPortalSession", tag = "billing", responses((status = 200, body = PortalSessionResponse), BillingErrorResponses))]
async fn create_portal_session(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
) -> Result<Json<PortalSessionResponse>, ApiError> {
    Ok(Json(
        billing::create_portal_session(db_pool(&state)?, &request.session.user_id)
            .await?
            .into(),
    ))
}

#[utoipa::path(get, path = "/billing/team-seats/addition-preview", operation_id = "previewAdditionalTeamSeat", tag = "billing", responses((status = 200, body = inline(Option<TeamSeatInvoicePreviewResponse>)), BillingErrorResponses))]
async fn preview_additional_team_seat(
    State(state): State<AppState>,
    request: AuthenticatedRequest,
) -> Result<Json<Option<TeamSeatInvoicePreviewResponse>>, ApiError> {
    Ok(Json(
        billing::preview_additional_team_seat(db_pool(&state)?, &request.session.user_id)
            .await?
            .map(Into::into),
    ))
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(status))
        .routes(routes!(entitlements))
        .routes(routes!(attachment_usage))
        .routes(routes!(create_checkout_session))
        .routes(routes!(create_portal_session))
        .routes(routes!(preview_additional_team_seat))
        .route_layer(DefaultBodyLimit::max(ORDINARY_API_BODY_LIMIT_BYTES))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{router, TeamSeatInvoicePreviewResponse};
    use crate::services::billing;

    #[test]
    fn router_registers_only_used_billing_operations() {
        let document = serde_json::to_value(router().split_for_parts().1).unwrap();
        let rendered = document.to_string();
        assert_eq!(rendered.matches("operationId").count(), 6);
        assert!(!rendered.contains("syncSeats"));
    }

    #[test]
    fn billing_large_integers_are_decimal_strings() {
        let response: TeamSeatInvoicePreviewResponse = billing::TeamSeatInvoicePreviewResponse {
            currency: "usd".to_string(),
            current_quantity: i64::MAX,
            next_quantity: i64::MAX,
            estimated_next_payment_cents: i64::MAX,
            total_line_items_cents: i64::MAX,
            lines: vec![billing::TeamSeatInvoicePreviewLineResponse {
                id: "line_test".to_string(),
                description: "Seat".to_string(),
                amount_cents: i64::MAX,
                currency: "usd".to_string(),
                period_start: "2026-01-01T00:00:00Z".to_string(),
                period_end: "2026-02-01T00:00:00Z".to_string(),
                quantity: Some(i64::MAX),
                unit_amount_cents: Some(i64::MAX),
                is_proration: true,
            }],
        }
        .into();

        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["currentQuantity"], json!(i64::MAX.to_string()));
        assert_eq!(
            value["lines"][0]["amountCents"],
            json!(i64::MAX.to_string())
        );
    }
}
