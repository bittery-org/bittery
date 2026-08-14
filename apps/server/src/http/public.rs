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
    integrations::favicon::{
        fetch_and_store_favicon, get_fetched_favicon, normalize_favicon_domain,
    },
    integrations::storage::create_presigned_download,
    services::billing::{
        is_self_hosted_mode, is_stripe_webhook_configured, process_stripe_webhook_event,
        StripeWebhookError,
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
    Json(input): Json<crate::services::waitlist::WaitlistSignupInput>,
) -> Response {
    let pool = &app_state.db_pool;

    match crate::services::waitlist::join_beta_waitlist(pool, input).await {
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

async fn cdn_asset(Path(key): Path<String>) -> Response {
    if !is_public_storage_key_allowed(&key) {
        return json_error(StatusCode::NOT_FOUND, "Not Found");
    }

    let signed_url = match create_presigned_download(&key, None).await {
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

    match fetch_and_store_favicon(pool, &domain).await {
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
    if is_self_hosted_mode() {
        return json_error(StatusCode::NOT_FOUND, "Not Found");
    }

    if !is_stripe_webhook_configured() {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Stripe webhook not configured",
        );
    }

    let pool = &app_state.db_pool;

    let signature_header = headers
        .get("stripe-signature")
        .and_then(|value| value.to_str().ok());

    match process_stripe_webhook_event(pool, &body, signature_header).await {
        Ok(duplicate) => Json(json!({
            "received": true,
            "duplicate": duplicate,
        }))
        .into_response(),
        Err(error) => {
            warn!(?error, "stripe webhook processing failed");
            match &error {
                StripeWebhookError::Database(_) => {
                    json_error(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
                }
                _ => json_error(StatusCode::BAD_REQUEST, "Invalid Stripe webhook"),
            }
        }
    }
}
