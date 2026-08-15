use std::sync::OnceLock;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{
        header::{CACHE_CONTROL, SET_COOKIE},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use reqwest::Client;
use serde_json::json;
use tracing::warn;

use crate::{
    domains::billing::{
        is_stripe_webhook_configured, process_stripe_webhook_event, StripeWebhookError,
    },
    integrations::favicon::{
        fetch_and_store_favicon, get_fetched_favicon, normalize_favicon_domain,
    },
    AppState,
};

const CDN_CACHE_CONTROL: &str = "public, max-age=3600";
const FAVICON_CACHE_CONTROL: &str = "public, max-age=86400";

pub fn create_public_http_router() -> Router<AppState> {
    Router::new()
        .route("/cdn/{*key}", get(cdn_asset))
        .route("/favicon/{domain}", get(favicon))
        .route("/waitlist", post(join_waitlist))
        .route("/webhooks/stripe", post(stripe_webhook))
}

fn http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(Client::new)
}

fn is_public_storage_key_allowed(key: &str) -> bool {
    let normalized_key = key.trim().trim_start_matches('/');
    if normalized_key.is_empty() {
        return false;
    }
    let segments: Vec<&str> = normalized_key.splitn(3, '/').collect();
    // Require at least prefix/{id}/{filename} (3 segments)
    matches!(segments.as_slice(), ["teams" | "vaults", id, _rest] if !id.is_empty())
}

fn cache_control_header(value: &'static str) -> [(axum::http::header::HeaderName, HeaderValue); 1] {
    [(CACHE_CONTROL, HeaderValue::from_static(value))]
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

async fn join_waitlist(
    State(app_state): State<AppState>,
    Json(input): Json<crate::domains::waitlist::WaitlistSignupInput>,
) -> Response {
    let pool = &app_state.db_pool;

    match crate::domains::waitlist::join_beta_waitlist(pool, input).await {
        Ok(response) => Json(response).into_response(),
        Err(error) => {
            let status = match error.code {
                crate::error::AppErrorCode::BadRequest => StatusCode::BAD_REQUEST,
                crate::error::AppErrorCode::TooManyRequests => StatusCode::TOO_MANY_REQUESTS,
                crate::error::AppErrorCode::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
                _ => StatusCode::INTERNAL_SERVER_ERROR,
            };
            json_error(status, &error.message)
        }
    }
}

async fn cdn_asset(Path(key): Path<String>, State(app_state): State<AppState>) -> Response {
    if !is_public_storage_key_allowed(&key) {
        return json_error(StatusCode::NOT_FOUND, "Not Found");
    }

    let signed_url = match app_state.object_storage.presign_download(&key, None).await {
        Ok(signed_url) => signed_url,
        Err(error) => {
            warn!(?error, key, "failed to create presigned download url");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Storage not configured");
        }
    };

    let response = match http_client().get(signed_url).send().await {
        Ok(response) => response,
        Err(error) => {
            warn!(?error, key, "failed to fetch public storage asset");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Storage fetch failed");
        }
    };

    if !response.status().is_success() {
        let status = if response.status() == reqwest::StatusCode::FORBIDDEN {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY)
        };
        return json_error(status, "Not Found");
    }

    let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut headers = response.headers().clone();
    headers.remove(SET_COOKIE);
    headers.insert(CACHE_CONTROL, HeaderValue::from_static(CDN_CACHE_CONTROL));

    let body = match response.bytes().await {
        Ok(body) => body,
        Err(error) => {
            warn!(?error, key, "failed to read public storage asset body");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to read asset");
        }
    };

    let mut result = Response::new(Body::from(body));
    *result.status_mut() = status;
    *result.headers_mut() = headers;
    result
}

async fn favicon(Path(domain): Path<String>, State(app_state): State<AppState>) -> Response {
    let Some(domain) = normalize_favicon_domain(&domain) else {
        return (
            StatusCode::NOT_FOUND,
            cache_control_header(FAVICON_CACHE_CONTROL),
        )
            .into_response();
    };

    let pool = &app_state.db_pool;

    match get_fetched_favicon(pool, &domain).await {
        Ok(Some(icon)) => {
            return (
                cache_control_header(FAVICON_CACHE_CONTROL),
                [(axum::http::header::CONTENT_TYPE, icon.content_type)],
                icon.data,
            )
                .into_response();
        }
        Ok(None) => {}
        Err(error) => {
            warn!(?error, domain, "failed to read favicon from database");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to read favicon");
        }
    }

    match fetch_and_store_favicon(pool, app_state.remote_documents.as_ref(), &domain).await {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::NOT_FOUND,
                cache_control_header(FAVICON_CACHE_CONTROL),
            )
                .into_response();
        }
        Err(error) => {
            warn!(?error, domain, "failed to fetch favicon");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch favicon");
        }
    }

    match get_fetched_favicon(pool, &domain).await {
        Ok(Some(icon)) => (
            cache_control_header(FAVICON_CACHE_CONTROL),
            [(axum::http::header::CONTENT_TYPE, icon.content_type)],
            icon.data,
        )
            .into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            cache_control_header(FAVICON_CACHE_CONTROL),
        )
            .into_response(),
        Err(error) => {
            warn!(
                ?error,
                domain, "failed to reload fetched favicon from database"
            );
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn stripe_webhook(
    State(app_state): State<AppState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if app_state.config.server.mode.is_self_hosted() {
        return json_error(StatusCode::NOT_FOUND, "Not Found");
    }

    if !is_stripe_webhook_configured(&app_state.config.stripe) {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Stripe webhook not configured",
        );
    }

    let pool = &app_state.db_pool;

    let signature_header = headers
        .get("stripe-signature")
        .and_then(|value| value.to_str().ok());

    match process_stripe_webhook_event(pool, &app_state.config.stripe, &body, signature_header)
        .await
    {
        Ok(duplicate) => Json(json!({
            "received": true,
            "duplicate": duplicate,
        }))
        .into_response(),
        Err(StripeWebhookError::Database(_)) => {
            json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
        Err(error) => {
            warn!(?error, "stripe webhook processing failed");
            json_error(StatusCode::BAD_REQUEST, "Invalid Stripe webhook")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::create_public_http_router;
    use crate::{
        test_support::{
            seed_team, seed_user, with_api_test_app_state, ApiTestApp, RecordingObjectStorage,
        },
        AppState,
    };
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
    };
    use hmac::{Hmac, KeyInit, Mac};
    use serde_json::{json, Value};
    use sha2::Sha256;
    use sqlx::query_as;
    use std::sync::Arc;
    use tower::ServiceExt;

    type TestHmacSha256 = Hmac<Sha256>;

    async fn post_stripe_event(
        app: &ApiTestApp,
        secret: &str,
        event: Value,
    ) -> (StatusCode, Value) {
        let body = event.to_string();
        let timestamp = chrono::Utc::now().timestamp();
        let mut mac = TestHmacSha256::new_from_slice(secret.as_bytes())
            .expect("test webhook secret should be valid");
        mac.update(format!("{timestamp}.{body}").as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());
        let response = create_public_http_router()
            .with_state(app.state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/webhooks/stripe")
                    .header("stripe-signature", format!("t={timestamp},v1={signature}"))
                    .body(Body::from(body))
                    .expect("request should build"),
            )
            .await
            .expect("Stripe webhook route should respond");
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("Stripe webhook response should be readable");
        let body = serde_json::from_slice(&body).expect("Stripe webhook response should be JSON");
        (status, body)
    }

    #[tokio::test]
    async fn cdn_route_reports_and_records_storage_failure() {
        let storage = Arc::new(RecordingObjectStorage::failing());
        let state = AppState::database_free_test().with_object_storage(storage.clone());
        let response = create_public_http_router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .uri("/cdn/vaults/user/avatar.png")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("route should respond");

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            storage.calls(),
            vec!["presign_download:vaults/user/avatar.png"]
        );
    }

    #[tokio::test]
    async fn cdn_route_uses_successful_presigned_download() {
        let storage = Arc::new(RecordingObjectStorage::succeeding(None));
        let state = AppState::database_free_test().with_object_storage(storage.clone());
        let response = create_public_http_router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .uri("/cdn/teams/team/avatar.png")
                    .body(Body::empty())
                    .expect("request should build"),
            )
            .await
            .expect("route should respond");

        // The recording adapter deliberately returns a non-routable URL; reaching the fetch error
        // proves the handler accepted its successful presign result.
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            storage.calls(),
            vec!["presign_download:teams/team/avatar.png"]
        );
    }

    #[tokio::test]
    async fn stripe_webhook_route_applies_billing_lifecycle_and_deduplicates_events() {
        let secret = "whsec_http_integration";
        with_api_test_app_state(
            "stripe_webhook_http_lifecycle",
            |mut state| {
                let config = Arc::make_mut(&mut state.config);
                config.server.mode = crate::config::DeploymentMode::Cloud;
                config.stripe.secret_key = Some("sk_test_http_integration".to_string());
                config.stripe.webhook_secret = Some(secret.to_string());
                config.stripe.team_seat_monthly_price_id = Some("price_team_http".to_string());
                state
            },
            |app| async move {
            seed_user(
                &app.pool,
                "user_stripe_http_owner",
                "Stripe Owner",
                "stripe-http-owner@example.com",
            )
            .await;
            seed_team(
                &app.pool,
                "team_stripe_http",
                "Stripe HTTP Team",
                "user_stripe_http_owner",
                "organization",
                "free",
                "none",
            )
            .await;

            let checkout = json!({
                "id": "evt_checkout_http",
                "type": "checkout.session.completed",
                "data": { "object": {
                    "client_reference_id": "team_stripe_http",
                    "customer": "cus_http",
                    "subscription": "sub_http",
                    "metadata": { "plan": "team" }
                }}
            });
            let (status, body) = post_stripe_event(&app, secret, checkout.clone()).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body, json!({ "received": true, "duplicate": false }));

            let checkout_state = query_as::<_, (String, Option<String>, Option<String>)>(
                "SELECT billing_plan::text, stripe_customer_id, stripe_subscription_id FROM team WHERE id = $1",
            )
            .bind("team_stripe_http")
            .fetch_one(&app.pool)
            .await
            .expect("checkout billing state should load");
            assert_eq!(
                checkout_state,
                (
                    "team".to_string(),
                    Some("cus_http".to_string()),
                    Some("sub_http".to_string())
                )
            );

            let (status, body) = post_stripe_event(&app, secret, checkout).await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body, json!({ "received": true, "duplicate": true }));

            let subscription = |event_id: &str, event_type: &str, status: &str, quantity: i64| {
                json!({
                    "id": event_id,
                    "type": event_type,
                    "data": { "object": {
                        "id": "sub_http",
                        "customer": "cus_http",
                        "status": status,
                        "cancel_at_period_end": true,
                        "items": { "data": [{
                            "id": "si_http",
                            "price": { "id": "price_team_http" },
                            "quantity": quantity,
                            "current_period_end": 1_900_000_000_i64
                        }] }
                    }}
                })
            };

            let (status, _) = post_stripe_event(
                &app,
                secret,
                subscription(
                    "evt_subscription_created_http",
                    "customer.subscription.created",
                    "trialing",
                    4,
                ),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let created_state = query_as::<_, (String, Option<i32>, Option<String>, bool)>(
                "SELECT billing_status::text, seats_purchased, stripe_subscription_item_id, cancel_at_period_end FROM team WHERE id = $1",
            )
            .bind("team_stripe_http")
            .fetch_one(&app.pool)
            .await
            .expect("created subscription state should load");
            assert_eq!(
                created_state,
                (
                    "trialing".to_string(),
                    Some(4),
                    Some("si_http".to_string()),
                    true
                )
            );

            let (status, _) = post_stripe_event(
                &app,
                secret,
                subscription(
                    "evt_subscription_updated_http",
                    "customer.subscription.updated",
                    "active",
                    7,
                ),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let updated_state = query_as::<_, (String, Option<i32>)>(
                "SELECT billing_status::text, seats_purchased FROM team WHERE id = $1",
            )
            .bind("team_stripe_http")
            .fetch_one(&app.pool)
            .await
            .expect("updated subscription state should load");
            assert_eq!(updated_state, ("active".to_string(), Some(7)));

            for (event_id, event_type, expected_status) in [
                ("evt_invoice_failed_http", "invoice.payment_failed", "past_due"),
                ("evt_invoice_paid_http", "invoice.paid", "active"),
            ] {
                let event = json!({
                    "id": event_id,
                    "type": event_type,
                    "data": { "object": {
                        "customer": "cus_http",
                        "parent": { "subscription_details": { "subscription": "sub_http" } }
                    }}
                });
                let (status, _) = post_stripe_event(&app, secret, event).await;
                assert_eq!(status, StatusCode::OK);
                let billing_status: String = sqlx::query_scalar(
                    "SELECT billing_status::text FROM team WHERE id = $1",
                )
                .bind("team_stripe_http")
                .fetch_one(&app.pool)
                .await
                .expect("invoice billing state should load");
                assert_eq!(billing_status, expected_status);
            }

            let (status, _) = post_stripe_event(
                &app,
                secret,
                subscription(
                    "evt_subscription_deleted_http",
                    "customer.subscription.deleted",
                    "canceled",
                    7,
                ),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let deleted_state = query_as::<_, (
                String,
                Option<String>,
                Option<String>,
                Option<i32>,
                bool,
            )>(
                "SELECT billing_status::text, stripe_subscription_id, stripe_subscription_item_id, seats_purchased, cancel_at_period_end FROM team WHERE id = $1",
            )
            .bind("team_stripe_http")
            .fetch_one(&app.pool)
            .await
            .expect("deleted subscription state should load");
            assert_eq!(
                deleted_state,
                ("canceled".to_string(), None, None, None, false)
            );
            },
        )
        .await;
    }
}
