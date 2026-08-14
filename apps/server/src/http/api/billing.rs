use axum::{
    extract::{DefaultBodyLimit, State},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    db::enums::BillingPlan,
    services::billing::{self, CheckoutPlanInput},
    shapes::{
        attachment_usage_shape, billing_entitlements_response_shape, billing_entitlements_shape,
        billing_status_shape, checkout_session_shape, entitlement_limits_shape,
        portal_session_shape, seat_invoice_line_shape, seat_invoice_preview_shape,
    },
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

impl From<CheckoutPlan> for BillingPlan {
    fn from(value: CheckoutPlan) -> Self {
        match value {
            CheckoutPlan::Personal => Self::Personal,
            CheckoutPlan::Family => Self::Family,
            CheckoutPlan::Team => Self::Team,
        }
    }
}

billing_status_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct BillingStatusResponse
});
billing_status_shape!(shape_from {
    billing::BillingStatusResponse => BillingStatusResponse
});

billing_entitlements_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct BillingEntitlements
});
billing_entitlements_shape!(shape_from {
    billing::BillingEntitlements => BillingEntitlements
});

entitlement_limits_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct EntitlementLimits
}, limit = DecimalString);
entitlement_limits_shape!(shape_from {
    billing::EntitlementLimits => EntitlementLimits
}, limit = DecimalString);

billing_entitlements_response_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct BillingEntitlementsResponse
});
billing_entitlements_response_shape!(shape_from {
    billing::BillingEntitlementsResponse => BillingEntitlementsResponse
});

attachment_usage_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct AttachmentUsageResponse
}, bytes = DecimalString);
attachment_usage_shape!(shape_from {
    billing::AttachmentUsageResponse => AttachmentUsageResponse
}, bytes = DecimalString);

checkout_session_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct CheckoutSessionResponse
});
checkout_session_shape!(shape_from {
    billing::CheckoutSessionResponse => CheckoutSessionResponse
});

portal_session_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    struct PortalSessionResponse
});
portal_session_shape!(shape_from {
    billing::PortalSessionResponse => PortalSessionResponse
});

seat_invoice_line_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct TeamSeatInvoicePreviewLineResponse
}, amount = DecimalString);
seat_invoice_line_shape!(shape_from {
    billing::TeamSeatInvoicePreviewLineResponse => TeamSeatInvoicePreviewLineResponse
}, amount = DecimalString);

seat_invoice_preview_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct TeamSeatInvoicePreviewResponse
}, amount = DecimalString, line = TeamSeatInvoicePreviewLineResponse);
seat_invoice_preview_shape!(shape_from {
    billing::TeamSeatInvoicePreviewResponse => TeamSeatInvoicePreviewResponse
}, amount = DecimalString, line = TeamSeatInvoicePreviewLineResponse);

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
        billing::get_billing_status(&state.db_pool, &request.session.user_id)
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
        billing::get_billing_entitlements(&state.db_pool, &request.session.user_id)
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
        billing::get_attachment_usage(&state.db_pool, &request.session.user_id)
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
            &state.db_pool,
            &request.session.user_id,
            CheckoutPlanInput {
                plan: body.plan.map(BillingPlan::from),
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
        billing::create_portal_session(&state.db_pool, &request.session.user_id)
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
        billing::preview_additional_team_seat(&state.db_pool, &request.session.user_id)
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
