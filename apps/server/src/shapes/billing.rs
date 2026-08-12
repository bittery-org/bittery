//! Canonical field lists for the billing surface.
//!
//! Money and byte counts are `i64` in the service models and decimal strings on the wire, because
//! they exceed an IEEE 754 safe integer. Every shape here that carries one takes it as a parameter
//! so each side names its own type.

/// The subscription state of the caller's team.
macro_rules! billing_status_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            enabled: bool,
            plan: $crate::db::enums::BillingPlan,
            status: $crate::db::enums::BillingStatus,
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
        } }
    };
}

/// Which features the caller's plan unlocks.
macro_rules! billing_entitlements_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            sentinel: bool,
            team_management: bool,
            vault_sharing: bool,
            share_links: bool,
            billing_portal: bool,
            attachments: bool,
        } }
    };
}

/// The numeric ceilings that go with those entitlements. `None` means unlimited.
macro_rules! entitlement_limits_shape {
    ($emit:ident $args:tt, limit = $limit:ty) => {
        $crate::shapes::$emit! { $args {
            #[serde(skip_serializing_if = "Option::is_none")]
            share_links: Option<$limit> = maybe,
            #[serde(skip_serializing_if = "Option::is_none")]
            shared_vaults: Option<$limit> = maybe,
            #[serde(skip_serializing_if = "Option::is_none")]
            attachment_max_file_size_bytes: Option<$limit> = maybe,
            #[serde(skip_serializing_if = "Option::is_none")]
            attachment_storage_bytes: Option<$limit> = maybe,
        } }
    };
}

/// Entitlements and limits together, with the plan they were derived from.
macro_rules! billing_entitlements_response_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            mode: String,
            billing_enabled: bool,
            plan: $crate::db::enums::BillingPlan,
            status: $crate::db::enums::BillingStatus,
            is_active: bool,
            entitlements: BillingEntitlements = into,
            limits: EntitlementLimits = into,
        } }
    };
}

/// Committed attachment storage against the plan's quota.
macro_rules! attachment_usage_shape {
    ($emit:ident $args:tt, bytes = $bytes:ty) => {
        $crate::shapes::$emit! { $args {
            mode: String,
            attachments_enabled: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            quota_bytes: Option<$bytes> = maybe,
            committed_storage_bytes: $bytes = into,
        } }
    };
}

/// A Stripe checkout session the client should redirect to.
macro_rules! checkout_session_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            url: String,
            session_id: String,
        } }
    };
}

/// A Stripe billing portal session the client should redirect to.
macro_rules! portal_session_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            url: String,
        } }
    };
}

/// One line of the invoice preview a team sees before changing its seat count.
macro_rules! seat_invoice_line_shape {
    ($emit:ident $args:tt, amount = $amount:ty) => {
        $crate::shapes::$emit! { $args {
            id: String,
            description: String,
            amount_cents: $amount = into,
            currency: String,
            period_start: String,
            period_end: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            quantity: Option<$amount> = maybe,
            #[serde(skip_serializing_if = "Option::is_none")]
            unit_amount_cents: Option<$amount> = maybe,
            is_proration: bool,
        } }
    };
}

/// The invoice preview itself: the seat move and what Stripe will charge for it.
macro_rules! seat_invoice_preview_shape {
    ($emit:ident $args:tt, amount = $amount:ty, line = $line:ty) => {
        $crate::shapes::$emit! { $args {
            currency: String,
            current_quantity: $amount = into,
            next_quantity: $amount = into,
            estimated_next_payment_cents: $amount = into,
            total_line_items_cents: $amount = into,
            @schema(max_items = 500)
            lines: Vec<$line> = each,
        } }
    };
}

pub(crate) use {
    attachment_usage_shape, billing_entitlements_response_shape, billing_entitlements_shape,
    billing_status_shape, checkout_session_shape, entitlement_limits_shape, portal_session_shape,
    seat_invoice_line_shape, seat_invoice_preview_shape,
};
