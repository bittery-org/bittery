
use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, StatusCode};
use serde_json::{json, Value};
use sqlx::{query, query_as, query_scalar, FromRow, PgPool};
use std::{
    future::Future,
    sync::{Mutex, OnceLock},
};
use time::{macros::datetime, OffsetDateTime};

use super::{
    assert_cloud_billing_enabled, bittery_mode, format_timestamp, get_billing_snapshot,
    is_stripe_api_configured, replace_stripe_mock_state, self_hosted_billing_status,
    stripe_mock_calls, web_app_url, StripeMockCall, StripeMockState, GB,
};
use crate::error::AppErrorCode;
use crate::test_support::{
    acquire_env_lock, assign_user_to_team, authenticated_json_headers, seed_item, seed_team,
    seed_user, seed_vault, with_rpc_test_app,
};

#[derive(Default)]
struct BillingTestEnv<'a> {
    bittery_mode: Option<&'a str>,
    stripe_secret_key: Option<&'a str>,
    web_app_url: Option<&'a str>,
    stripe_price_personal: Option<&'a str>,
    stripe_price_family: Option<&'a str>,
    stripe_price_team: Option<&'a str>,
    stripe_mock: Option<StripeMockState>,
}

#[derive(Clone)]
struct BillingRouterFixture {
    owner_user_id: String,
    admin_user_id: String,
    member_user_id: String,
    no_team_user_id: String,
    team_id: String,
    other_team_id: String,
    vault_id: String,
    item_id: String,
}

#[derive(FromRow)]
struct BillingTeamTestRow {
    billing_plan: String,
    billing_status: String,
    stripe_customer_id: Option<String>,
    stripe_subscription_id: Option<String>,
    stripe_subscription_item_id: Option<String>,
    stripe_price_id: Option<String>,
    seats_purchased: Option<i32>,
    current_period_end: Option<OffsetDateTime>,
    cancel_at_period_end: bool,
}

fn set_env_var(name: &str, value: Option<&str>) {
    match value {
        Some(value) => unsafe { std::env::set_var(name, value) },
        None => unsafe { std::env::remove_var(name) },
    }
}

fn restore_env_var(name: &str, previous: Option<String>) {
    match previous.as_deref() {
        Some(value) => unsafe { std::env::set_var(name, value) },
        None => unsafe { std::env::remove_var(name) },
    }
}

fn with_env_vars<T>(
    bittery_mode_value: Option<&str>,
    stripe_secret_key: Option<&str>,
    web_app_url_value: Option<&str>,
    test_fn: impl FnOnce() -> T,
) -> T {
    let _guard = acquire_env_lock();
    let previous_mode = std::env::var("BITTERY_MODE").ok();
    let previous_stripe_secret = std::env::var("STRIPE_SECRET_KEY").ok();
    let previous_web_app_url = std::env::var("WEB_APP_URL").ok();

    set_env_var("BITTERY_MODE", bittery_mode_value);
    set_env_var("STRIPE_SECRET_KEY", stripe_secret_key);
    set_env_var("WEB_APP_URL", web_app_url_value);

    let result = test_fn();

    restore_env_var("BITTERY_MODE", previous_mode);
    restore_env_var("STRIPE_SECRET_KEY", previous_stripe_secret);
    restore_env_var("WEB_APP_URL", previous_web_app_url);

    result
}

async fn with_billing_test_env_async<T, F>(env: BillingTestEnv<'_>, future: F) -> T
where
    F: Future<Output = T>,
{
    let _guard = acquire_env_lock();
    let previous_mode = std::env::var("BITTERY_MODE").ok();
    let previous_stripe_secret = std::env::var("STRIPE_SECRET_KEY").ok();
    let previous_web_app_url = std::env::var("WEB_APP_URL").ok();
    let previous_personal_price = std::env::var("STRIPE_PRICE_PERSONAL_MONTHLY").ok();
    let previous_family_price = std::env::var("STRIPE_PRICE_FAMILY_MONTHLY").ok();
    let previous_team_price = std::env::var("STRIPE_PRICE_TEAM_SEAT_MONTHLY").ok();
    let previous_stripe_mock = replace_stripe_mock_state(env.stripe_mock);

    set_env_var("BITTERY_MODE", env.bittery_mode);
    set_env_var("STRIPE_SECRET_KEY", env.stripe_secret_key);
    set_env_var("WEB_APP_URL", env.web_app_url);
    set_env_var("STRIPE_PRICE_PERSONAL_MONTHLY", env.stripe_price_personal);
    set_env_var("STRIPE_PRICE_FAMILY_MONTHLY", env.stripe_price_family);
    set_env_var("STRIPE_PRICE_TEAM_SEAT_MONTHLY", env.stripe_price_team);

    let result = future.await;

    restore_env_var("BITTERY_MODE", previous_mode);
    restore_env_var("STRIPE_SECRET_KEY", previous_stripe_secret);
    restore_env_var("WEB_APP_URL", previous_web_app_url);
    restore_env_var("STRIPE_PRICE_PERSONAL_MONTHLY", previous_personal_price);
    restore_env_var("STRIPE_PRICE_FAMILY_MONTHLY", previous_family_price);
    restore_env_var("STRIPE_PRICE_TEAM_SEAT_MONTHLY", previous_team_price);
    replace_stripe_mock_state(previous_stripe_mock);

    result
}

fn unauthenticated_json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert("x-app-platform", HeaderValue::from_static("desktop"));
    headers.insert("x-client-id", HeaderValue::from_static("integration-test"));
    headers
}

fn assert_handler_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["jsonrpc"], json!("2.0"));
    assert_eq!(body["result"]["Err"]["code"], json!(code));
    assert_eq!(body["result"]["Err"]["message"], json!(message));
}

fn assert_rpc_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["jsonrpc"], json!("2.0"));
    assert_eq!(body["error"]["message"], json!(message));
    assert_eq!(body["error"]["data"]["code"], json!(code));
}

fn assert_invalid_params_error(body: &Value) {
    assert_eq!(body["jsonrpc"], json!("2.0"));
    assert!(
        body["error"].is_object(),
        "unexpected invalid params body: {body}"
    );
    let message = body["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert!(
        message.contains("invalid params"),
        "unexpected invalid params body: {body}"
    );
}

async fn build_billing_router_fixture(pool: &PgPool) -> BillingRouterFixture {
    let owner_user_id = "user_billing_owner".to_string();
    let admin_user_id = "user_billing_admin".to_string();
    let member_user_id = "user_billing_member".to_string();
    let no_team_user_id = "user_billing_no_team".to_string();
    let team_id = "team_billing_primary".to_string();
    let other_team_id = "team_billing_other".to_string();
    let vault_id = "vault_billing_team".to_string();
    let item_id = "item_billing_team".to_string();

    seed_user(
        pool,
        &owner_user_id,
        "Billing Owner",
        "billing-owner@example.com",
    )
    .await;
    seed_user(
        pool,
        &admin_user_id,
        "Billing Admin",
        "billing-admin@example.com",
    )
    .await;
    seed_user(
        pool,
        &member_user_id,
        "Billing Member",
        "billing-member@example.com",
    )
    .await;
    seed_user(
        pool,
        &no_team_user_id,
        "Billing No Team",
        "billing-no-team@example.com",
    )
    .await;
    seed_team(
        pool,
        &team_id,
        "Billing Team",
        &owner_user_id,
        "organization",
        "team",
        "active",
    )
    .await;
    assign_user_to_team(pool, &owner_user_id, &team_id, "owner").await;
    assign_user_to_team(pool, &admin_user_id, &team_id, "admin").await;
    assign_user_to_team(pool, &member_user_id, &team_id, "member").await;
    seed_vault(
        pool,
        &vault_id,
        "Billing Team Vault",
        "team",
        &owner_user_id,
        Some(&team_id),
    )
    .await;
    seed_item(
        pool,
        &item_id,
        &vault_id,
        "login",
        "encrypted-item",
        "item-iv",
        &owner_user_id,
    )
    .await;

    BillingRouterFixture {
        owner_user_id,
        admin_user_id,
        member_user_id,
        no_team_user_id,
        team_id,
        other_team_id,
        vault_id,
        item_id,
    }
}

async fn seed_attachment(
    pool: &PgPool,
    attachment_id: &str,
    item_id: &str,
    vault_id: &str,
    uploaded_by: &str,
    storage_size: i32,
) {
    query(
			"INSERT INTO item_attachment (id, item_id, vault_id, storage_key, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, storage_size, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
		)
		.bind(attachment_id)
		.bind(item_id)
		.bind(vault_id)
		.bind(format!("attachments/{attachment_id}"))
		.bind("encrypted-name")
		.bind("encrypted-content-type")
		.bind("attachment-iv")
		.bind(Some("content-type-iv"))
		.bind("AES-GCM-AAD-V1")
		.bind(storage_size)
		.bind(storage_size)
		.bind(uploaded_by)
		.bind(OffsetDateTime::now_utc())
		.execute(pool)
		.await
		.expect("attachment should seed");
}

async fn update_team_billing_state(
    pool: &PgPool,
    team_id: &str,
    billing_plan: &str,
    billing_status: &str,
    stripe_customer_id: Option<&str>,
    stripe_subscription_id: Option<&str>,
    stripe_subscription_item_id: Option<&str>,
    stripe_price_id: Option<&str>,
    seats_purchased: Option<i32>,
    cancel_at_period_end: bool,
    current_period_end: Option<OffsetDateTime>,
) {
    query(
			"UPDATE team SET billing_plan = $1::billing_plan, billing_status = $2::billing_status, stripe_customer_id = $3, stripe_subscription_id = $4, stripe_subscription_item_id = $5, stripe_price_id = $6, seats_purchased = $7, cancel_at_period_end = $8, current_period_end = $9, updated_at = $10 WHERE id = $11",
		)
		.bind(billing_plan)
		.bind(billing_status)
		.bind(stripe_customer_id)
		.bind(stripe_subscription_id)
		.bind(stripe_subscription_item_id)
		.bind(stripe_price_id)
		.bind(seats_purchased)
		.bind(cancel_at_period_end)
		.bind(current_period_end)
		.bind(OffsetDateTime::now_utc())
		.bind(team_id)
		.execute(pool)
		.await
		.expect("team billing state should update");
}

async fn load_team_billing_row(pool: &PgPool, team_id: &str) -> BillingTeamTestRow {
    query_as::<_, BillingTeamTestRow>(
			"SELECT billing_plan::text AS billing_plan, billing_status::text AS billing_status, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id, stripe_price_id, seats_purchased, current_period_end, cancel_at_period_end FROM team WHERE id = $1 LIMIT 1",
		)
		.bind(team_id)
		.fetch_one(pool)
		.await
		.expect("team billing row should load")
}

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

#[test]
fn bittery_mode_normalizes_self_hosted_aliases_and_defaults_to_cloud() {
    with_env_vars(None, None, None, || {
        assert_eq!(bittery_mode(), "cloud");
    });

    with_env_vars(Some("self_hosted"), None, None, || {
        assert_eq!(bittery_mode(), "self-hosted");
    });

    with_env_vars(Some("SELFHOSTED"), None, None, || {
        assert_eq!(bittery_mode(), "self-hosted");
    });

    with_env_vars(Some("cloud"), None, None, || {
        assert_eq!(bittery_mode(), "cloud");
    });
}

#[test]
fn stripe_configuration_and_web_app_url_use_trimmed_env_values() {
    with_env_vars(
        None,
        Some("  sk_test_123  "),
        Some(" https://app.example.com/  "),
        || {
            assert!(is_stripe_api_configured());
            assert_eq!(web_app_url(), "https://app.example.com/");
        },
    );

    with_env_vars(None, Some("   "), Some("   "), || {
        assert!(!is_stripe_api_configured());
        assert_eq!(web_app_url(), "http://localhost:3001");
    });
}

#[test]
fn cloud_billing_guard_rejects_self_hosted_and_missing_stripe_configuration() {
    with_env_vars(Some("self-hosted"), Some("sk_test_123"), None, || {
        let error = assert_cloud_billing_enabled()
            .expect_err("self-hosted mode should disable cloud billing handlers");
        assert_eq!(error.code, AppErrorCode::Forbidden);
        assert_eq!(error.message, "Billing is disabled in self-hosted mode");
    });

    with_env_vars(None, None, None, || {
        let error =
            assert_cloud_billing_enabled().expect_err("missing Stripe config should be rejected");
        assert_eq!(error.code, AppErrorCode::InternalServerError);
        assert_eq!(error.message, "Stripe is not configured");
    });

    with_env_vars(None, Some("sk_test_123"), None, || {
        assert!(assert_cloud_billing_enabled().is_ok());
    });
}

#[tokio::test]
async fn billing_handlers_require_authentication() {
    with_rpc_test_app(
        "billing_handlers_require_authentication",
        |app| async move {
            let protected_calls = vec![
                ("billing.status", json!([])),
                ("billing.entitlements", json!([])),
                ("billing.attachmentUsage", json!([])),
                ("billing.createCheckoutSession", json!([{}])),
                ("billing.createPortalSession", json!([])),
                ("billing.syncSeats", json!([{}])),
                ("billing.previewAdditionalTeamSeat", json!([])),
            ];

            for (method, params) in protected_calls {
                let response = app
                    .rpc_call(method, params, unauthenticated_json_headers())
                    .await;
                assert_eq!(
                    response.status,
                    StatusCode::OK,
                    "unexpected status for {method}"
                );
                assert_rpc_error(&response.body, "UNAUTHORIZED", "Authentication required");
            }
        },
    )
    .await;
}

#[tokio::test]
async fn billing_query_handlers_return_expected_status_entitlements_and_attachment_usage() {
    with_billing_test_env_async(
        BillingTestEnv {
            stripe_secret_key: Some("sk_test_123"),
            web_app_url: Some("https://app.example.com"),
            ..BillingTestEnv::default()
        },
        async {
            with_rpc_test_app("billing_query_handlers_success", |app| async move {
                let fixture = build_billing_router_fixture(&app.pool).await;
                let period_end = datetime!(2026-05-22 12:00 UTC);
                update_team_billing_state(
                    &app.pool,
                    &fixture.team_id,
                    "team",
                    "active",
                    Some("cus_team_123"),
                    Some("sub_team_123"),
                    Some("si_team_123"),
                    Some("price_team_123"),
                    Some(3),
                    true,
                    Some(period_end),
                )
                .await;
                seed_attachment(
                    &app.pool,
                    "attachment_billing_1",
                    &fixture.item_id,
                    &fixture.vault_id,
                    &fixture.owner_user_id,
                    1024,
                )
                .await;
                seed_attachment(
                    &app.pool,
                    "attachment_billing_2",
                    &fixture.item_id,
                    &fixture.vault_id,
                    &fixture.admin_user_id,
                    2048,
                )
                .await;

                let session = app.issue_session(&fixture.owner_user_id).await;
                let headers = authenticated_json_headers(&session.token);

                let status_response = app
                    .rpc_call("billing.status", json!([]), headers.clone())
                    .await;
                assert_eq!(status_response.status, StatusCode::OK);
                assert_eq!(status_response.body["result"]["Ok"]["enabled"], json!(true));
                assert_eq!(status_response.body["result"]["Ok"]["plan"], json!("team"));
                assert_eq!(
                    status_response.body["result"]["Ok"]["status"],
                    json!("active")
                );
                assert_eq!(
                    status_response.body["result"]["Ok"]["isActive"],
                    json!(true)
                );
                assert_eq!(
                    status_response.body["result"]["Ok"]["requiresPayment"],
                    json!(true)
                );
                assert_eq!(
                    status_response.body["result"]["Ok"]["isStripeConfigured"],
                    json!(true)
                );
                assert_eq!(
                    status_response.body["result"]["Ok"]["stripeCustomerId"],
                    json!("cus_team_123")
                );
                assert_eq!(
                    status_response.body["result"]["Ok"]["stripeSubscriptionId"],
                    json!("sub_team_123")
                );
                assert_eq!(
                    status_response.body["result"]["Ok"]["stripePriceId"],
                    json!("price_team_123")
                );
                assert_eq!(
                    status_response.body["result"]["Ok"]["currentPeriodEnd"],
                    json!(format_timestamp(period_end))
                );
                assert_eq!(
                    status_response.body["result"]["Ok"]["cancelAtPeriodEnd"],
                    json!(true)
                );
                assert_eq!(
                    status_response.body["result"]["Ok"]["seatsPurchased"],
                    json!(3)
                );

                let entitlements_response = app
                    .rpc_call("billing.entitlements", json!([]), headers.clone())
                    .await;
                assert_eq!(entitlements_response.status, StatusCode::OK);
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["mode"],
                    json!("cloud")
                );
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["plan"],
                    json!("team")
                );
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["status"],
                    json!("active")
                );
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["isActive"],
                    json!(true)
                );
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["entitlements"]["teamManagement"],
                    json!(true)
                );
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["entitlements"]["attachments"],
                    json!(true)
                );
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["limits"]["attachmentStorageBytes"],
                    json!(2 * GB)
                );

                let usage_response = app
                    .rpc_call("billing.attachmentUsage", json!([]), headers)
                    .await;
                assert_eq!(usage_response.status, StatusCode::OK);
                assert_eq!(usage_response.body["result"]["Ok"]["mode"], json!("cloud"));
                assert_eq!(
                    usage_response.body["result"]["Ok"]["attachmentsEnabled"],
                    json!(true)
                );
                assert_eq!(
                    usage_response.body["result"]["Ok"]["quotaBytes"],
                    json!(2 * GB)
                );
                assert_eq!(
                    usage_response.body["result"]["Ok"]["committedStorageBytes"],
                    json!(3072)
                );
            })
            .await;
        },
    )
    .await;
}

#[tokio::test]
async fn billing_cloud_queries_return_team_not_found_without_team() {
    with_billing_test_env_async(BillingTestEnv::default(), async {
        with_rpc_test_app("billing_cloud_queries_team_not_found", |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.no_team_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            for method in [
                "billing.status",
                "billing.entitlements",
                "billing.attachmentUsage",
            ] {
                let response = app.rpc_call(method, json!([]), headers.clone()).await;
                assert_eq!(
                    response.status,
                    StatusCode::OK,
                    "unexpected status for {method}"
                );
                assert_handler_error(&response.body, "NOT_FOUND", "Team not found");
            }
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn billing_self_hosted_queries_use_self_hosted_defaults() {
    with_billing_test_env_async(
        BillingTestEnv {
            bittery_mode: Some("self-hosted"),
            ..BillingTestEnv::default()
        },
        async {
            with_rpc_test_app("billing_self_hosted_queries_defaults", |app| async move {
                let fixture = build_billing_router_fixture(&app.pool).await;
                let session = app.issue_session(&fixture.no_team_user_id).await;
                let headers = authenticated_json_headers(&session.token);

                let status_response = app
                    .rpc_call("billing.status", json!([]), headers.clone())
                    .await;
                assert_eq!(status_response.status, StatusCode::OK);
                assert_eq!(
                    status_response.body["result"]["Ok"]["enabled"],
                    json!(false)
                );
                assert_eq!(status_response.body["result"]["Ok"]["plan"], json!("free"));
                assert_eq!(
                    status_response.body["result"]["Ok"]["status"],
                    json!("none")
                );

                let entitlements_response = app
                    .rpc_call("billing.entitlements", json!([]), headers.clone())
                    .await;
                assert_eq!(entitlements_response.status, StatusCode::OK);
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["mode"],
                    json!("self-hosted")
                );
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["plan"],
                    json!("team")
                );
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["status"],
                    json!("active")
                );
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["entitlements"]["billingPortal"],
                    json!(false)
                );
                assert_eq!(
                    entitlements_response.body["result"]["Ok"]["limits"]["attachmentStorageBytes"],
                    Value::Null
                );

                let usage_response = app
                    .rpc_call("billing.attachmentUsage", json!([]), headers)
                    .await;
                assert_eq!(usage_response.status, StatusCode::OK);
                assert_eq!(
                    usage_response.body["result"]["Ok"]["mode"],
                    json!("self-hosted")
                );
                assert_eq!(
                    usage_response.body["result"]["Ok"]["attachmentsEnabled"],
                    json!(true)
                );
                assert_eq!(
                    usage_response.body["result"]["Ok"]["quotaBytes"],
                    Value::Null
                );
                assert_eq!(
                    usage_response.body["result"]["Ok"]["committedStorageBytes"],
                    json!(0)
                );
            })
            .await;
        },
    )
    .await;
}

#[tokio::test]
async fn billing_mutation_handlers_reject_self_hosted_mode() {
    with_billing_test_env_async(
        BillingTestEnv {
            bittery_mode: Some("self-hosted"),
            ..BillingTestEnv::default()
        },
        async {
            with_rpc_test_app("billing_mutations_reject_self_hosted", |app| async move {
                let fixture = build_billing_router_fixture(&app.pool).await;
                let session = app.issue_session(&fixture.owner_user_id).await;
                let headers = authenticated_json_headers(&session.token);
                let mutation_calls = vec![
                    ("billing.createCheckoutSession", json!([{}])),
                    ("billing.createPortalSession", json!([])),
                    ("billing.syncSeats", json!([{}])),
                    ("billing.previewAdditionalTeamSeat", json!([])),
                ];

                for (method, params) in mutation_calls {
                    let response = app.rpc_call(method, params, headers.clone()).await;
                    assert_eq!(
                        response.status,
                        StatusCode::OK,
                        "unexpected status for {method}"
                    );
                    assert_handler_error(
                        &response.body,
                        "FORBIDDEN",
                        "Billing is disabled in self-hosted mode",
                    );
                }
            })
            .await;
        },
    )
    .await;
}

#[tokio::test]
async fn billing_create_checkout_session_rejects_invalid_payload_shape() {
    with_billing_test_env_async(
        BillingTestEnv {
            stripe_secret_key: Some("sk_test_123"),
            stripe_price_team: Some("price_team_123"),
            ..BillingTestEnv::default()
        },
        async {
            with_rpc_test_app(
                "billing_create_checkout_invalid_payload",
                |app| async move {
                    let fixture = build_billing_router_fixture(&app.pool).await;
                    let session = app.issue_session(&fixture.owner_user_id).await;

                    let response = app
                        .rpc_call(
                            "billing.createCheckoutSession",
                            json!([{ "plan": 123 }]),
                            authenticated_json_headers(&session.token),
                        )
                        .await;

                    assert_eq!(response.status, StatusCode::OK);
                    assert_invalid_params_error(&response.body);
                },
            )
            .await;
        },
    )
    .await;
}

#[tokio::test]
async fn billing_create_checkout_session_enforces_admin_and_plan_validation() {
    with_billing_test_env_async(
        BillingTestEnv {
            stripe_secret_key: Some("sk_test_123"),
            stripe_price_team: Some("price_team_123"),
            ..BillingTestEnv::default()
        },
        async {
            with_rpc_test_app(
                "billing_create_checkout_access_and_validation_v2",
                |app| async move {
                    let fixture = build_billing_router_fixture(&app.pool).await;
                    let member_session = app.issue_session(&fixture.member_user_id).await;
                    let forbidden_response = app
                        .rpc_call(
                            "billing.createCheckoutSession",
                            json!([{ "plan": "team" }]),
                            authenticated_json_headers(&member_session.token),
                        )
                        .await;
                    assert_eq!(forbidden_response.status, StatusCode::OK);
                    assert_handler_error(
                        &forbidden_response.body,
                        "FORBIDDEN",
                        "Only team owner or admin can manage billing",
                    );

                    update_team_billing_state(
                        &app.pool,
                        &fixture.team_id,
                        "free",
                        "none",
                        None,
                        None,
                        None,
                        None,
                        None,
                        false,
                        None,
                    )
                    .await;
                    let owner_session = app.issue_session(&fixture.owner_user_id).await;
                    let bad_request_response = app
                        .rpc_call(
                            "billing.createCheckoutSession",
                            json!([{ "plan": "free" }]),
                            authenticated_json_headers(&owner_session.token),
                        )
                        .await;
                    assert_eq!(bad_request_response.status, StatusCode::OK);
                    assert_handler_error(
                        &bad_request_response.body,
                        "BAD_REQUEST",
                        "Free plan does not require checkout",
                    );
                },
            )
            .await;
        },
    )
    .await;
}

#[tokio::test]
async fn billing_create_checkout_session_success_persists_incomplete_state_and_stripe_customer() {
    with_billing_test_env_async(
        BillingTestEnv {
            stripe_secret_key: Some("sk_test_123"),
            web_app_url: Some("https://app.example.com"),
            stripe_price_team: Some("price_team_123"),
            stripe_mock: Some(StripeMockState::default()),
            ..BillingTestEnv::default()
        },
        async {
            with_rpc_test_app("billing_create_checkout_success", |app| async move {
                let fixture = build_billing_router_fixture(&app.pool).await;
                let session = app.issue_session(&fixture.owner_user_id).await;

                let response = app
                    .rpc_call(
                        "billing.createCheckoutSession",
                        json!([{ "plan": "team" }]),
                        authenticated_json_headers(&session.token),
                    )
                    .await;

                assert_eq!(response.status, StatusCode::OK);
                assert_eq!(
                    response.body["result"]["Ok"]["url"],
                    json!("https://checkout.stripe.test/session/cs_test_123")
                );
                assert_eq!(
                    response.body["result"]["Ok"]["sessionId"],
                    json!("cs_test_123")
                );

                let team_row = load_team_billing_row(&app.pool, &fixture.team_id).await;
                assert_eq!(team_row.billing_plan, "team");
                assert_eq!(team_row.billing_status, "incomplete");
                assert_eq!(team_row.stripe_customer_id.as_deref(), Some("cus_test_123"));

                let calls = stripe_mock_calls();
                assert_eq!(calls.len(), 2);
                assert_eq!(
                    calls[0],
                    StripeMockCall::CreateCustomer {
                        email: "billing-owner@example.com".to_string(),
                        name: "Billing Owner".to_string(),
                        team_id: fixture.team_id.clone(),
                        user_id: fixture.owner_user_id.clone(),
                    },
                );
                assert_eq!(
                    calls[1],
                    StripeMockCall::CreateCheckoutSession {
                        team_id: fixture.team_id,
                        user_id: fixture.owner_user_id,
                        customer_id: Some("cus_test_123".to_string()),
                        customer_email: "billing-owner@example.com".to_string(),
                        plan: "team".to_string(),
                        price_id: "price_team_123".to_string(),
                        quantity: 3,
                        success_url: "https://app.example.com/billing?checkout=success".to_string(),
                        cancel_url: "https://app.example.com/billing?checkout=cancel".to_string(),
                    },
                );
            })
            .await;
        },
    )
    .await;
}

#[tokio::test]
async fn billing_create_portal_session_requires_customer_and_returns_url() {
    with_billing_test_env_async(
        BillingTestEnv {
            stripe_secret_key: Some("sk_test_123"),
            web_app_url: Some("https://app.example.com"),
            stripe_mock: Some(StripeMockState::default()),
            ..BillingTestEnv::default()
        },
        async {
            with_rpc_test_app("billing_create_portal_session_paths", |app| async move {
                let fixture = build_billing_router_fixture(&app.pool).await;
                let session = app.issue_session(&fixture.owner_user_id).await;

                let missing_customer_response = app
                    .rpc_call(
                        "billing.createPortalSession",
                        json!([]),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                assert_eq!(missing_customer_response.status, StatusCode::OK);
                assert_handler_error(
                    &missing_customer_response.body,
                    "BAD_REQUEST",
                    "No Stripe customer found for this team",
                );

                update_team_billing_state(
                    &app.pool,
                    &fixture.team_id,
                    "team",
                    "active",
                    Some("cus_portal_123"),
                    Some("sub_portal_123"),
                    Some("si_portal_123"),
                    Some("price_team_123"),
                    Some(3),
                    false,
                    None,
                )
                .await;
                let success_response = app
                    .rpc_call(
                        "billing.createPortalSession",
                        json!([]),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                assert_eq!(success_response.status, StatusCode::OK);
                assert_eq!(
                    success_response.body["result"]["Ok"]["url"],
                    json!("https://billing.stripe.test/portal/session_123")
                );

                assert_eq!(
                    stripe_mock_calls(),
                    vec![StripeMockCall::CreateBillingPortalSession {
                        customer_id: "cus_portal_123".to_string(),
                        return_url: "https://app.example.com/billing".to_string(),
                    }],
                );
            })
            .await;
        },
    )
    .await;
}

#[tokio::test]
async fn billing_sync_seats_rejects_other_team_and_updates_quantity() {
    with_billing_test_env_async(
        BillingTestEnv {
            stripe_secret_key: Some("sk_test_123"),
            stripe_mock: Some(StripeMockState::default()),
            ..BillingTestEnv::default()
        },
        async {
            with_rpc_test_app("billing_sync_seats_paths", |app| async move {
                let fixture = build_billing_router_fixture(&app.pool).await;
                update_team_billing_state(
                    &app.pool,
                    &fixture.team_id,
                    "team",
                    "active",
                    Some("cus_team_123"),
                    Some("sub_team_123"),
                    Some("si_team_123"),
                    Some("price_team_123"),
                    Some(2),
                    false,
                    None,
                )
                .await;
                let session = app.issue_session(&fixture.owner_user_id).await;

                let forbidden_response = app
                    .rpc_call(
                        "billing.syncSeats",
                        json!([{ "teamId": fixture.other_team_id }]),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                assert_eq!(forbidden_response.status, StatusCode::OK);
                assert_handler_error(
                    &forbidden_response.body,
                    "FORBIDDEN",
                    "You can only sync seats for your own team",
                );

                let success_response = app
                    .rpc_call(
                        "billing.syncSeats",
                        json!([{}]),
                        authenticated_json_headers(&session.token),
                    )
                    .await;
                assert_eq!(success_response.status, StatusCode::OK);
                assert_eq!(success_response.body["result"]["Ok"]["synced"], json!(true));
                assert_eq!(success_response.body["result"]["Ok"]["reason"], Value::Null);
                assert_eq!(success_response.body["result"]["Ok"]["quantity"], json!(3));

                let team_row = load_team_billing_row(&app.pool, &fixture.team_id).await;
                assert_eq!(team_row.seats_purchased, Some(3));
                assert_eq!(
                    stripe_mock_calls(),
                    vec![StripeMockCall::UpdateSubscriptionItemQuantity {
                        subscription_item_id: "si_team_123".to_string(),
                        quantity: 3,
                    }],
                );
            })
            .await;
        },
    )
    .await;
}

#[tokio::test]
async fn billing_preview_additional_team_seat_returns_none_and_maps_preview_response() {
    with_billing_test_env_async(
        BillingTestEnv {
            stripe_secret_key: Some("sk_test_123"),
            stripe_mock: Some(StripeMockState::default()),
            ..BillingTestEnv::default()
        },
        async {
            with_rpc_test_app(
                "billing_preview_additional_team_seat_paths",
                |app| async move {
                    let fixture = build_billing_router_fixture(&app.pool).await;
                    let session = app.issue_session(&fixture.owner_user_id).await;

                    let none_response = app
                        .rpc_call(
                            "billing.previewAdditionalTeamSeat",
                            json!([]),
                            authenticated_json_headers(&session.token),
                        )
                        .await;
                    assert_eq!(none_response.status, StatusCode::OK);
                    assert_eq!(none_response.body["result"]["Ok"], Value::Null);

                    update_team_billing_state(
                        &app.pool,
                        &fixture.team_id,
                        "team",
                        "active",
                        Some("cus_preview_123"),
                        Some("sub_preview_123"),
                        Some("si_preview_123"),
                        Some("price_team_123"),
                        Some(3),
                        false,
                        None,
                    )
                    .await;
                    let preview_response = app
                        .rpc_call(
                            "billing.previewAdditionalTeamSeat",
                            json!([]),
                            authenticated_json_headers(&session.token),
                        )
                        .await;
                    assert_eq!(preview_response.status, StatusCode::OK);
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["currency"],
                        json!("usd")
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["currentQuantity"],
                        json!(3)
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["nextQuantity"],
                        json!(4)
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["estimatedNextPaymentCents"],
                        json!(750)
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["totalLineItemsCents"],
                        json!(750)
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["lines"][0]["id"],
                        json!("il_preview_123")
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["lines"][0]["description"],
                        json!("Additional team seat")
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["lines"][0]["amountCents"],
                        json!(750)
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["lines"][0]["unitAmountCents"],
                        json!(750)
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["lines"][0]["isProration"],
                        json!(true)
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["lines"][0]["periodStart"],
                        json!(format_timestamp(
                            OffsetDateTime::from_unix_timestamp(1_717_300_000)
                                .expect("preview period start should be valid"),
                        )),
                    );
                    assert_eq!(
                        preview_response.body["result"]["Ok"]["lines"][0]["periodEnd"],
                        json!(format_timestamp(
                            OffsetDateTime::from_unix_timestamp(1_719_892_800)
                                .expect("preview period end should be valid"),
                        )),
                    );

                    assert_eq!(
                        stripe_mock_calls(),
                        vec![StripeMockCall::PreviewUpcomingTeamSeatInvoice {
                            stripe_customer_id: "cus_preview_123".to_string(),
                            stripe_subscription_id: "sub_preview_123".to_string(),
                            stripe_subscription_item_id: Some("si_preview_123".to_string()),
                            seats_purchased: Some(3),
                            seat_increment: 1,
                        }],
                    );
                },
            )
            .await;
        },
    )
    .await;
}

#[tokio::test]
async fn billing_create_portal_and_preview_require_billing_admin() {
    with_billing_test_env_async(
        BillingTestEnv {
            stripe_secret_key: Some("sk_test_123"),
            ..BillingTestEnv::default()
        },
        async {
            with_rpc_test_app("billing_admin_only_handlers", |app| async move {
                let fixture = build_billing_router_fixture(&app.pool).await;
                let member_session = app.issue_session(&fixture.member_user_id).await;

                for method in [
                    "billing.createPortalSession",
                    "billing.previewAdditionalTeamSeat",
                ] {
                    let response = app
                        .rpc_call(
                            method,
                            json!([]),
                            authenticated_json_headers(&member_session.token),
                        )
                        .await;
                    assert_eq!(
                        response.status,
                        StatusCode::OK,
                        "unexpected status for {method}"
                    );
                    assert_handler_error(
                        &response.body,
                        "FORBIDDEN",
                        "Only team owner or admin can manage billing",
                    );
                }
            })
            .await;
        },
    )
    .await;
}
