mod webhook;

use serde::{Deserialize, Serialize};
use sqlx::{query, query_scalar, PgPool};
use time::OffsetDateTime;

pub(crate) use self::webhook::{
    is_self_hosted_mode, is_stripe_webhook_configured, process_stripe_webhook_event,
    StripeWebhookError,
};
use crate::integrations::stripe::{BillingGateway, CheckoutSessionInput};
use crate::{
    config::{bittery_mode, cloud_billing_enabled, format_timestamp},
    db::{
        enums::{BillingPlan, BillingStatus, TeamRole},
        models::{DbBillingActorRow, DbBillingContactRow},
    },
    error::AppError,
    repo::billing::{
        count_team_members, get_committed_attachment_storage_bytes, load_billing_actor,
        load_billing_contact, load_optional_billing_state,
    },
    services::transaction::database_error,
    shapes::{
        attachment_usage_shape, billing_entitlements_response_shape, billing_entitlements_shape,
        billing_status_shape, checkout_session_shape, entitlement_limits_shape,
        portal_session_shape, seat_invoice_line_shape, seat_invoice_preview_shape,
    },
};

const MB: i64 = 1024 * 1024;
const GB: i64 = 1024 * 1024 * 1024;

billing_status_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BillingStatusResponse
});

billing_entitlements_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BillingEntitlements
});

entitlement_limits_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct EntitlementLimits
}, limit = i64);

billing_entitlements_response_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BillingEntitlementsResponse
});

attachment_usage_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AttachmentUsageResponse
}, bytes = i64);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutPlanInput {
    pub plan: Option<BillingPlan>,
}

checkout_session_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CheckoutSessionResponse
});

portal_session_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PortalSessionResponse
});

seat_invoice_line_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TeamSeatInvoicePreviewLineResponse
}, amount = i64);

seat_invoice_preview_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct TeamSeatInvoicePreviewResponse
}, amount = i64, line = TeamSeatInvoicePreviewLineResponse);

struct BillingSnapshot {
    entitlements: BillingEntitlements,
    limits: EntitlementLimits,
}

pub(crate) async fn get_billing_status(
    pool: &PgPool,
    billing_gateway: Option<&dyn BillingGateway>,
    user_id: &str,
) -> Result<BillingStatusResponse, AppError> {
    if bittery_mode() == "self-hosted" {
        return Ok(self_hosted_billing_status());
    }
    if !cloud_billing_enabled() {
        return Ok(cloud_billing_disabled_status());
    }

    let actor = load_billing_actor(pool, user_id).await?;
    actor
        .team_id
        .clone()
        .ok_or_else(|| AppError::not_found("Team not found"))?;
    let team = ensure_team_billing(actor)?;
    let requires_payment = team.billing_plan.is_paid();

    Ok(BillingStatusResponse {
        enabled: true,
        plan: team.billing_plan,
        status: team.billing_status,
        is_active: team.billing_status.is_active(),
        requires_payment,
        is_stripe_configured: billing_gateway.is_some(),
        stripe_customer_id: team.stripe_customer_id,
        stripe_subscription_id: team.stripe_subscription_id,
        stripe_price_id: team.stripe_price_id,
        current_period_end: team.current_period_end.map(format_timestamp),
        cancel_at_period_end: team.cancel_at_period_end,
        seats_purchased: team.seats_purchased,
    })
}

pub(crate) async fn get_billing_entitlements(
    db_pool: &PgPool,
    user_id: &str,
) -> Result<BillingEntitlementsResponse, AppError> {
    let mode = bittery_mode().to_string();
    if mode == "self-hosted" {
        let state = load_optional_billing_state(db_pool, user_id).await?;
        let plan = state
            .as_ref()
            .and_then(|actor| actor.billing_plan)
            .unwrap_or(BillingPlan::Team);
        let billing_status = state
            .as_ref()
            .and_then(|actor| actor.billing_status)
            .unwrap_or(BillingStatus::Active);
        let snapshot = get_billing_snapshot(&mode, plan, billing_status);

        return Ok(BillingEntitlementsResponse {
            mode,
            billing_enabled: false,
            plan,
            status: billing_status,
            is_active: billing_status.is_active(),
            entitlements: snapshot.entitlements,
            limits: snapshot.limits,
        });
    }
    if !cloud_billing_enabled() {
        let snapshot = get_billing_snapshot(&mode, BillingPlan::Free, BillingStatus::None);
        return Ok(BillingEntitlementsResponse {
            mode,
            billing_enabled: false,
            plan: BillingPlan::Free,
            status: BillingStatus::None,
            is_active: false,
            entitlements: snapshot.entitlements,
            limits: snapshot.limits,
        });
    }
    let actor = load_billing_actor(db_pool, user_id).await?;
    actor
        .team_id
        .clone()
        .ok_or_else(|| AppError::not_found("Team not found"))?;
    let team = ensure_team_billing(actor)?;
    let snapshot = get_billing_snapshot(&mode, team.billing_plan, team.billing_status);

    Ok(BillingEntitlementsResponse {
        mode,
        billing_enabled: true,
        plan: team.billing_plan,
        status: team.billing_status,
        is_active: team.billing_status.is_active(),
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
        .ok_or_else(|| AppError::not_found("Team not found"))?;
    let team = ensure_team_billing(actor)?;
    let snapshot = get_billing_snapshot(&mode, team.billing_plan, team.billing_status);

    Ok(AttachmentUsageResponse {
        mode,
        attachments_enabled: snapshot.entitlements.attachments,
        quota_bytes: snapshot.limits.attachment_storage_bytes,
        committed_storage_bytes: get_committed_attachment_storage_bytes(pool, &team_id).await?,
    })
}

pub(crate) async fn create_checkout_session(
    pool: &PgPool,
    billing_gateway: Option<&dyn BillingGateway>,
    user_id: &str,
    input: CheckoutPlanInput,
) -> Result<CheckoutSessionResponse, AppError> {
    assert_cloud_billing_enabled(billing_gateway.is_some())?;
    let billing_gateway = billing_gateway.expect("billing gateway availability was checked");
    let actor = load_billing_actor(pool, user_id).await?;
    let team_id = actor
        .team_id
        .clone()
        .ok_or_else(|| AppError::not_found("Team not found"))?;
    let team = ensure_team_billing(actor.clone())?;
    ensure_billing_admin(actor.role)?;

    let target_plan = input.plan.unwrap_or(team.billing_plan);
    if !target_plan.is_paid() {
        return Err(AppError::bad_request("Free plan does not require checkout"));
    }

    if team.stripe_subscription_id.is_some()
        && team.billing_status.is_active()
        && team.billing_plan == target_plan
    {
        return Err(AppError::bad_request(
            "Subscription is already active for this plan",
        ));
    }

    let stripe_price_id = get_stripe_price_id(target_plan).ok_or_else(|| {
        AppError::internal(format!("Missing Stripe price ID for {target_plan} plan"))
    })?;
    let quantity = if target_plan == BillingPlan::Team {
        count_team_members(pool, &team_id).await?.max(1)
    } else {
        1
    };
    let customer_id = ensure_team_stripe_customer(pool, billing_gateway, &actor, &team_id).await?;
    let base_url = web_app_url().trim_end_matches('/').to_string();
    let checkout = billing_gateway
        .create_checkout_session(CheckoutSessionInput {
            team_id: team_id.clone(),
            user_id: user_id.to_string(),
            customer_id,
            customer_email: actor.email.clone(),
            plan: target_plan.as_str().to_string(),
            price_id: stripe_price_id,
            quantity,
            success_url: format!("{base_url}/billing?checkout=success"),
            cancel_url: format!("{base_url}/billing?checkout=cancel"),
        })
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })?;

    let redirect_url = checkout
        .url
        .ok_or_else(|| AppError::internal("Stripe checkout session has no redirect URL"))?;

    query(
		"UPDATE team SET billing_plan = $1::billing_plan, billing_status = 'incomplete', updated_at = $2 WHERE id = $3",
	)
	.bind(target_plan)
	.bind(OffsetDateTime::now_utc())
	.bind(&team_id)
	.execute(pool)
	.await
	.map_err(|error| database_error(error, "Failed to update team billing state"))?;

    Ok(CheckoutSessionResponse {
        url: redirect_url,
        session_id: checkout.id,
    })
}

pub(crate) async fn create_portal_session(
    pool: &PgPool,
    billing_gateway: Option<&dyn BillingGateway>,
    user_id: &str,
) -> Result<PortalSessionResponse, AppError> {
    assert_cloud_billing_enabled(billing_gateway.is_some())?;
    let billing_gateway = billing_gateway.expect("billing gateway availability was checked");
    let actor = load_billing_actor(pool, user_id).await?;
    let team = ensure_team_billing(actor.clone())?;
    ensure_billing_admin(actor.role)?;

    let snapshot = get_billing_snapshot(bittery_mode(), team.billing_plan, team.billing_status);
    if !snapshot.entitlements.billing_portal {
        return Err(AppError::forbidden(
            "Billing portal is unavailable for your current plan",
        ));
    }

    let stripe_customer_id = team
        .stripe_customer_id
        .as_deref()
        .ok_or_else(|| AppError::bad_request("No Stripe customer found for this team"))?;
    let base_url = web_app_url().trim_end_matches('/').to_string();
    let url = billing_gateway
        .create_billing_portal_session(
            stripe_customer_id.to_string(),
            format!("{base_url}/billing"),
        )
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })?;

    Ok(PortalSessionResponse { url })
}

pub(crate) async fn sync_team_seats_best_effort(
    pool: &PgPool,
    billing_gateway: Option<&dyn BillingGateway>,
    team_id: &str,
    billing_plan: BillingPlan,
) {
    let Some(billing_gateway) = billing_gateway else {
        return;
    };
    if billing_plan != BillingPlan::Team {
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

    if billing_gateway
        .update_subscription_item_quantity(subscription_item_id, quantity)
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
    billing_gateway: Option<&dyn BillingGateway>,
    user_id: &str,
) -> Result<Option<TeamSeatInvoicePreviewResponse>, AppError> {
    assert_cloud_billing_enabled(billing_gateway.is_some())?;
    let billing_gateway = billing_gateway.expect("billing gateway availability was checked");

    let actor = load_billing_actor(pool, user_id).await?;
    ensure_billing_admin(actor.role)?;
    let team = ensure_team_billing(actor)?;

    let Some(stripe_customer_id) = team.stripe_customer_id.as_deref() else {
        return Ok(None);
    };
    let Some(stripe_subscription_id) = team.stripe_subscription_id.as_deref() else {
        return Ok(None);
    };

    match billing_gateway
        .preview_upcoming_team_seat_invoice(
            stripe_customer_id.to_string(),
            stripe_subscription_id.to_string(),
            team.stripe_subscription_item_id,
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

#[derive(Clone)]
struct TeamBillingState {
    billing_plan: BillingPlan,
    billing_status: BillingStatus,
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
            .ok_or_else(|| AppError::not_found("Team not found"))?,
        billing_status: actor
            .billing_status
            .ok_or_else(|| AppError::not_found("Team not found"))?,
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
    billing_gateway: &dyn BillingGateway,
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
    .ok_or_else(|| AppError::internal("No billing contact found for team"))?;

    let customer_id = billing_gateway
        .create_customer(
            billing_contact.email,
            billing_contact.name,
            team_id.to_string(),
            billing_contact.id,
        )
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })?;

    query("UPDATE team SET stripe_customer_id = $1, updated_at = $2 WHERE id = $3")
        .bind(&customer_id)
        .bind(OffsetDateTime::now_utc())
        .bind(team_id)
        .execute(pool)
        .await
        .map_err(|error| database_error(error, "Failed to persist Stripe customer"))?;

    Ok(Some(customer_id))
}

fn get_billing_snapshot(
    mode: &str,
    billing_plan: BillingPlan,
    billing_status: BillingStatus,
) -> BillingSnapshot {
    let resolved_entitlements = resolve_effective_entitlements(mode, billing_plan, billing_status);
    let limits = resolve_effective_entitlement_limits(mode, billing_plan, &resolved_entitlements);
    BillingSnapshot {
        entitlements: resolved_entitlements,
        limits,
    }
}

fn resolve_effective_entitlements(
    mode: &str,
    billing_plan: BillingPlan,
    billing_status: BillingStatus,
) -> BillingEntitlements {
    if mode == "self-hosted" {
        return BillingEntitlements {
            sentinel: true,
            team_management: true,
            vault_sharing: true,
            share_links: true,
            billing_portal: false,
            attachments: true,
        };
    }

    let paid_inactive = billing_plan.is_paid() && !billing_status.is_active();
    match billing_plan {
        BillingPlan::Personal => BillingEntitlements {
            sentinel: !paid_inactive,
            team_management: false,
            vault_sharing: false,
            share_links: !paid_inactive,
            billing_portal: true,
            attachments: !paid_inactive,
        },
        BillingPlan::Family | BillingPlan::Team => BillingEntitlements {
            sentinel: !paid_inactive,
            team_management: !paid_inactive,
            vault_sharing: !paid_inactive,
            share_links: !paid_inactive,
            billing_portal: true,
            attachments: !paid_inactive,
        },
        BillingPlan::Free => BillingEntitlements {
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
    billing_plan: BillingPlan,
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
        BillingPlan::Personal => EntitlementLimits {
            share_links: Some(5),
            shared_vaults: Some(0),
            attachment_max_file_size_bytes: Some(10 * MB),
            attachment_storage_bytes: Some(250 * MB),
        },
        BillingPlan::Family => EntitlementLimits {
            share_links: None,
            shared_vaults: Some(5),
            attachment_max_file_size_bytes: Some(25 * MB),
            attachment_storage_bytes: Some(GB),
        },
        BillingPlan::Team => EntitlementLimits {
            share_links: None,
            shared_vaults: None,
            attachment_max_file_size_bytes: Some(50 * MB),
            attachment_storage_bytes: Some(2 * GB),
        },
        BillingPlan::Free => EntitlementLimits {
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
        plan: BillingPlan::Free,
        status: BillingStatus::None,
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

fn cloud_billing_disabled_status() -> BillingStatusResponse {
    BillingStatusResponse {
        enabled: false,
        plan: BillingPlan::Free,
        status: BillingStatus::None,
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

fn assert_cloud_billing_enabled(has_billing_gateway: bool) -> Result<(), AppError> {
    if bittery_mode() == "self-hosted" {
        return Err(AppError::forbidden(
            "Billing is disabled in self-hosted mode",
        ));
    }

    if !cloud_billing_enabled() {
        return Err(AppError::forbidden(
            "Billing is disabled during the hosted beta",
        ));
    }

    if !has_billing_gateway {
        return Err(AppError::internal("Stripe is not configured"));
    }

    Ok(())
}

fn ensure_billing_admin(role: TeamRole) -> Result<(), AppError> {
    if role.can_manage() {
        Ok(())
    } else {
        Err(AppError::forbidden(
            "Only team owner or admin can manage billing",
        ))
    }
}

fn get_stripe_price_id(plan: BillingPlan) -> Option<String> {
    let env_name = match plan {
        BillingPlan::Personal => "STRIPE_PRICE_PERSONAL_MONTHLY",
        BillingPlan::Family => "STRIPE_PRICE_FAMILY_MONTHLY",
        BillingPlan::Team => "STRIPE_PRICE_TEAM_SEAT_MONTHLY",
        BillingPlan::Free => return None,
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

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;
