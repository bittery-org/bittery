use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, Method, StatusCode};
use serde_json::{json, Value};
use sqlx::{query, query_as, query_scalar, FromRow, PgPool};
use std::sync::Arc;
use time::{macros::datetime, OffsetDateTime};

use super::{
    assert_cloud_billing_enabled, format_timestamp, get_billing_snapshot,
    self_hosted_billing_status, web_app_url, GB,
};
use crate::config::{Config, DeploymentMode};
use crate::db::enums::{BillingPlan, BillingStatus};
use crate::error::AppErrorCode;
use crate::integrations::stripe::{
    BillingGatewayCall, CheckoutSessionInput, StripeBillingGateway, TestBillingGateway,
};
use crate::test_support::{
    assign_user_to_team, authenticated_json_headers, seed_item, seed_team, seed_user, seed_vault,
    with_api_test_app, with_api_test_app_state, with_test_config_value,
};

struct BillingTestEnv<'a> {
    bittery_mode: Option<&'a str>,
    cloud_billing_enabled: Option<&'a str>,
    stripe_secret_key: Option<&'a str>,
    web_app_url: Option<&'a str>,
    stripe_price_personal: Option<&'a str>,
    stripe_price_family: Option<&'a str>,
    stripe_price_team: Option<&'a str>,
}

impl Default for BillingTestEnv<'_> {
    fn default() -> Self {
        Self {
            bittery_mode: Some("cloud"),
            cloud_billing_enabled: Some("true"),
            stripe_secret_key: None,
            web_app_url: None,
            stripe_price_personal: None,
            stripe_price_family: None,
            stripe_price_team: None,
        }
    }
}

#[derive(Clone)]
struct BillingRouterFixture {
    owner_user_id: String,
    admin_user_id: String,
    member_user_id: String,
    no_team_user_id: String,
    team_id: String,
    vault_id: String,
    item_id: String,
}

#[derive(FromRow)]
#[allow(dead_code)]
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

fn with_billing_test_config(state: crate::AppState, env: BillingTestEnv<'_>) -> crate::AppState {
    let mut config = Config::for_test();
    config.server.mode = match env.bittery_mode {
        Some("self-hosted") => DeploymentMode::SelfHosted,
        None | Some("cloud") => DeploymentMode::Cloud,
        Some(value) => panic!("unsupported test deployment mode: {value}"),
    };
    config.server.cloud_billing = env.cloud_billing_enabled != Some("false");
    config.stripe.secret_key = env.stripe_secret_key.map(str::to_owned);
    config.server.web_app_url = env.web_app_url.map(str::to_owned);
    config.stripe.personal_monthly_price_id = env.stripe_price_personal.map(str::to_owned);
    config.stripe.family_monthly_price_id = env.stripe_price_family.map(str::to_owned);
    config.stripe.team_seat_monthly_price_id = env.stripe_price_team.map(str::to_owned);
    with_test_config_value(state, config)
}

fn unauthenticated_json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "bittery-client-platform",
        HeaderValue::from_static("desktop"),
    );
    headers.insert(
        "bittery-client-id",
        HeaderValue::from_static("integration-test"),
    );
    headers
}

fn assert_handler_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["code"], json!(code));
    assert_eq!(body["detail"], json!(message));
}

fn assert_transport_error(body: &Value, code: &str, message: &str) {
    assert_eq!(body["detail"], json!(message));
    assert_eq!(body["code"], json!(code));
}

fn assert_invalid_params_error(body: &Value) {
    assert!(
        body["code"].is_string(),
        "unexpected invalid params body: {body}"
    );
    let message = body["detail"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    assert!(
        (body["code"] == json!("INVALID_REQUEST") || message.contains("invalid")),
        "unexpected invalid params body: {body}"
    );
}

async fn build_billing_router_fixture(pool: &PgPool) -> BillingRouterFixture {
    let owner_user_id = "user_billing_owner".to_string();
    let admin_user_id = "user_billing_admin".to_string();
    let member_user_id = "user_billing_member".to_string();
    let no_team_user_id = "user_billing_no_team".to_string();
    let team_id = "team_billing_primary".to_string();
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
			"INSERT INTO item_attachment (id, item_id, vault_id, storage_key, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm, envelope_version, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, storage_size, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
		)
		.bind(attachment_id)
		.bind(item_id)
		.bind(vault_id)
		.bind(format!("attachments/{attachment_id}"))
		.bind("encrypted-attachment-key")
		.bind("attachment-key-iv")
		.bind("AES-GCM-AAD-V1")
		.bind(1_i32)
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

#[allow(clippy::too_many_arguments)]
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
    assert_eq!(status.plan, BillingPlan::Free);
    assert_eq!(status.status, BillingStatus::None);
    assert!(!status.requires_payment);
}

#[test]
fn free_cloud_plan_disables_paid_entitlements() {
    let snapshot = get_billing_snapshot("cloud", BillingPlan::Free, BillingStatus::None);

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
    let snapshot = get_billing_snapshot("cloud", BillingPlan::Personal, BillingStatus::Incomplete);

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
    let snapshot = get_billing_snapshot("self-hosted", BillingPlan::Team, BillingStatus::Active);

    assert!(snapshot.entitlements.sentinel);
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
fn stripe_gateway_and_billing_url_use_startup_config() {
    let mut config = Config::for_test();
    config.stripe.secret_key = Some("sk_test_123".to_string());
    config.server.web_app_url = Some("https://app.example.com/".to_string());
    assert!(StripeBillingGateway::from_config(&config.stripe)
        .unwrap()
        .is_some());
    assert_eq!(web_app_url(&config.server), "https://app.example.com/");

    config.stripe.secret_key = None;
    config.server.web_app_url = None;
    assert!(StripeBillingGateway::from_config(&config.stripe)
        .unwrap()
        .is_none());
    assert_eq!(web_app_url(&config.server), "http://localhost:3001");
}

#[test]
fn cloud_billing_guard_rejects_self_hosted_and_missing_stripe_configuration() {
    let mut config = Config::for_test();
    config.server.mode = DeploymentMode::SelfHosted;
    let error = assert_cloud_billing_enabled(&config.server, true)
        .expect_err("self-hosted mode should disable cloud billing handlers");
    assert_eq!(error.code, AppErrorCode::Forbidden);
    assert_eq!(error.message, "Billing is disabled in self-hosted mode");

    config.server.mode = DeploymentMode::Cloud;
    let error = assert_cloud_billing_enabled(&config.server, false)
        .expect_err("missing Stripe config should be rejected");
    assert_eq!(error.code, AppErrorCode::InternalServerError);
    assert_eq!(error.message, "Stripe is not configured");

    assert!(assert_cloud_billing_enabled(&config.server, true).is_ok());
}

#[tokio::test]
async fn billing_handlers_require_authentication() {
    with_api_test_app(
        "billing_handlers_require_authentication",
        |app| async move {
            let protected_calls = vec![
                (Method::GET, "/api/v1/billing/status", None),
                (Method::GET, "/api/v1/billing/entitlements", None),
                (Method::GET, "/api/v1/billing/attachment-usage", None),
                (Method::POST, "/api/v1/billing/checkout-sessions", None),
                (Method::POST, "/api/v1/billing/portal-sessions", None),
                (
                    Method::GET,
                    "/api/v1/billing/team-seats/addition-preview",
                    None,
                ),
            ];

            for (method, path, payload) in protected_calls {
                let response = app
                    .api_json(method, path, payload, unauthenticated_json_headers())
                    .await;
                response.assert_contract_status();
                assert_transport_error(
                    &response.body,
                    "UNAUTHORIZED",
                    "A valid bearer session is required.",
                );
            }
        },
    )
    .await;
}

#[tokio::test]
async fn billing_query_handlers_return_expected_status_entitlements_and_attachment_usage() {
    let gateway = Arc::new(TestBillingGateway::default());
    let config = BillingTestEnv {
        web_app_url: Some("https://app.example.com"),
        ..BillingTestEnv::default()
    };
    with_api_test_app_state(
        "billing_query_handlers_success",
        |state| with_billing_test_config(state, config).with_billing_gateway(gateway),
        |app| async move {
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
                .api_json(Method::GET, "/api/v1/billing/status", None, headers.clone())
                .await;
            status_response.assert_contract_status();
            assert_eq!(status_response.body["enabled"], json!(true));
            assert_eq!(status_response.body["plan"], json!("team"));
            assert_eq!(status_response.body["status"], json!("active"));
            assert_eq!(status_response.body["isActive"], json!(true));
            assert_eq!(status_response.body["requiresPayment"], json!(true));
            assert_eq!(status_response.body["isStripeConfigured"], json!(true));
            assert_eq!(
                status_response.body["stripeCustomerId"],
                json!("cus_team_123")
            );
            assert_eq!(
                status_response.body["stripeSubscriptionId"],
                json!("sub_team_123")
            );
            assert_eq!(
                status_response.body["stripePriceId"],
                json!("price_team_123")
            );
            assert_eq!(
                status_response.body["currentPeriodEnd"],
                json!(format_timestamp(period_end))
            );
            assert_eq!(status_response.body["cancelAtPeriodEnd"], json!(true));
            assert_eq!(status_response.body["seatsPurchased"], json!(3));

            let entitlements_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/billing/entitlements",
                    None,
                    headers.clone(),
                )
                .await;
            entitlements_response.assert_contract_status();
            assert_eq!(entitlements_response.body["mode"], json!("cloud"));
            assert_eq!(entitlements_response.body["billingEnabled"], json!(true));
            assert_eq!(entitlements_response.body["plan"], json!("team"));
            assert_eq!(entitlements_response.body["status"], json!("active"));
            assert_eq!(entitlements_response.body["isActive"], json!(true));
            assert_eq!(
                entitlements_response.body["entitlements"]["teamManagement"],
                json!(true)
            );
            assert_eq!(
                entitlements_response.body["entitlements"]["attachments"],
                json!(true)
            );
            assert_eq!(
                entitlements_response.body["limits"]["attachmentStorageBytes"],
                json!((2 * GB).to_string())
            );

            let usage_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/billing/attachment-usage",
                    None,
                    headers,
                )
                .await;
            usage_response.assert_contract_status();
            assert_eq!(usage_response.body["mode"], json!("cloud"));
            assert_eq!(usage_response.body["attachmentsEnabled"], json!(true));
            assert_eq!(
                usage_response.body["quotaBytes"],
                json!((2 * GB).to_string())
            );
            assert_eq!(usage_response.body["committedStorageBytes"], json!("3072"));
        },
    )
    .await;
}

#[tokio::test]
async fn billing_cloud_beta_flag_disables_checkout_portal_and_paid_entitlements() {
    let config = BillingTestEnv {
        cloud_billing_enabled: Some("false"),
        stripe_secret_key: Some("sk_test_123"),
        ..BillingTestEnv::default()
    };
    with_api_test_app_state(
        "billing_cloud_beta_disabled",
        |state| with_billing_test_config(state, config),
        |app| async move {
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
                Some(3),
                false,
                None,
            )
            .await;

            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            let status_response = app
                .api_json(Method::GET, "/api/v1/billing/status", None, headers.clone())
                .await;
            status_response.assert_contract_status();
            assert_eq!(status_response.body["enabled"], json!(false));
            assert_eq!(status_response.body["plan"], json!("free"));
            assert_eq!(status_response.body["status"], json!("none"));
            assert_eq!(status_response.body["requiresPayment"], json!(false));
            assert_eq!(status_response.body["isStripeConfigured"], json!(false));

            let entitlements_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/billing/entitlements",
                    None,
                    headers.clone(),
                )
                .await;
            entitlements_response.assert_contract_status();
            assert_eq!(entitlements_response.body["billingEnabled"], json!(false));
            assert_eq!(entitlements_response.body["plan"], json!("free"));
            assert_eq!(
                entitlements_response.body["entitlements"]["billingPortal"],
                json!(false)
            );
            assert_eq!(
                entitlements_response.body["entitlements"]["teamManagement"],
                json!(false)
            );

            for (method, path, payload) in [
                (
                    Method::POST,
                    "/api/v1/billing/checkout-sessions",
                    Some(json!({ "plan": "team" })),
                ),
                (Method::POST, "/api/v1/billing/portal-sessions", None),
                (
                    Method::GET,
                    "/api/v1/billing/team-seats/addition-preview",
                    None,
                ),
            ] {
                let response = app.api_json(method, path, payload, headers.clone()).await;
                response.assert_contract_status();
                assert_handler_error(
                    &response.body,
                    "FORBIDDEN",
                    "Billing is disabled during the hosted beta",
                );
            }
        },
    )
    .await;
}

#[tokio::test]
async fn waitlist_endpoint_upserts_without_email_enumeration() {
    with_api_test_app("waitlist_endpoint_upserts", |app| async move {
        let first = app
            .post_public_json(
                "/waitlist",
                json!({
                    "email": "Beta.User@Example.com",
                    "name": "Beta User",
                    "useCase": "Hosted beta access",
                    "source": "marketing",
                }),
                unauthenticated_json_headers(),
            )
            .await;
        first.assert_contract_status();
        assert_eq!(first.body["success"], json!(true));

        let duplicate = app
            .post_public_json(
                "/waitlist",
                json!({
                    "email": "beta.user@example.com",
                    "name": "Updated Name",
                    "useCase": null,
                    "source": "landing",
                }),
                unauthenticated_json_headers(),
            )
            .await;
        duplicate.assert_contract_status();
        assert_eq!(duplicate.body["success"], json!(true));

        let count = query_scalar::<_, i64>("SELECT COUNT(*) FROM beta_waitlist")
            .fetch_one(&app.pool)
            .await
            .expect("waitlist count should load");
        assert_eq!(count, 1);

        let stored = query_as::<_, (String, Option<String>, Option<String>, Option<String>)>(
            "SELECT email, name, use_case, source FROM beta_waitlist LIMIT 1",
        )
        .fetch_one(&app.pool)
        .await
        .expect("waitlist row should load");
        assert_eq!(stored.0, "beta.user@example.com");
        assert_eq!(stored.1.as_deref(), Some("Updated Name"));
        assert_eq!(stored.2.as_deref(), Some("Hosted beta access"));
        assert_eq!(stored.3.as_deref(), Some("landing"));

        let invalid = app
            .post_public_json(
                "/waitlist",
                json!({ "email": "not-an-email" }),
                unauthenticated_json_headers(),
            )
            .await;
        assert_eq!(invalid.status, StatusCode::BAD_REQUEST);
        assert_eq!(invalid.body["error"], json!("Enter a valid email address"));
    })
    .await;
}

#[tokio::test]
async fn billing_cloud_queries_return_team_not_found_without_team() {
    with_api_test_app_state(
        "billing_cloud_queries_team_not_found",
        |state| with_billing_test_config(state, BillingTestEnv::default()),
        |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.no_team_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            for path in [
                "/api/v1/billing/status",
                "/api/v1/billing/entitlements",
                "/api/v1/billing/attachment-usage",
            ] {
                let response = app.api_json(Method::GET, path, None, headers.clone()).await;
                response.assert_contract_status();
                assert_handler_error(&response.body, "NOT_FOUND", "Team not found");
            }
        },
    )
    .await;
}

#[tokio::test]
async fn billing_self_hosted_queries_use_self_hosted_defaults() {
    let config = BillingTestEnv {
        bittery_mode: Some("self-hosted"),
        ..BillingTestEnv::default()
    };
    with_api_test_app_state(
        "billing_self_hosted_queries_defaults",
        |state| with_billing_test_config(state, config),
        |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.no_team_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            let status_response = app
                .api_json(Method::GET, "/api/v1/billing/status", None, headers.clone())
                .await;
            status_response.assert_contract_status();
            assert_eq!(status_response.body["enabled"], json!(false));
            assert_eq!(status_response.body["plan"], json!("free"));
            assert_eq!(status_response.body["status"], json!("none"));

            let entitlements_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/billing/entitlements",
                    None,
                    headers.clone(),
                )
                .await;
            entitlements_response.assert_contract_status();
            assert_eq!(entitlements_response.body["mode"], json!("self-hosted"));
            assert_eq!(entitlements_response.body["plan"], json!("team"));
            assert_eq!(entitlements_response.body["status"], json!("active"));
            assert_eq!(
                entitlements_response.body["entitlements"]["billingPortal"],
                json!(false)
            );
            assert_eq!(
                entitlements_response.body["limits"]["attachmentStorageBytes"],
                Value::Null
            );

            let usage_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/billing/attachment-usage",
                    None,
                    headers,
                )
                .await;
            usage_response.assert_contract_status();
            assert_eq!(usage_response.body["mode"], json!("self-hosted"));
            assert_eq!(usage_response.body["attachmentsEnabled"], json!(true));
            assert_eq!(usage_response.body["quotaBytes"], Value::Null);
            assert_eq!(usage_response.body["committedStorageBytes"], json!("0"));
        },
    )
    .await;
}

#[tokio::test]
async fn billing_mutation_handlers_reject_self_hosted_mode() {
    let config = BillingTestEnv {
        bittery_mode: Some("self-hosted"),
        ..BillingTestEnv::default()
    };
    with_api_test_app_state(
        "billing_mutations_reject_self_hosted",
        |state| with_billing_test_config(state, config),
        |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);
            let mutation_calls = vec![
                (
                    Method::POST,
                    "/api/v1/billing/checkout-sessions",
                    Some(json!({ "plan": "team" })),
                ),
                (Method::POST, "/api/v1/billing/portal-sessions", None),
                (
                    Method::GET,
                    "/api/v1/billing/team-seats/addition-preview",
                    None,
                ),
            ];

            for (method, path, payload) in mutation_calls {
                let response = app.api_json(method, path, payload, headers.clone()).await;
                response.assert_contract_status();
                assert_handler_error(
                    &response.body,
                    "FORBIDDEN",
                    "Billing is disabled in self-hosted mode",
                );
            }
        },
    )
    .await;
}

#[tokio::test]
async fn billing_create_checkout_session_rejects_invalid_payload_shape() {
    let config = BillingTestEnv {
        stripe_secret_key: Some("sk_test_123"),
        stripe_price_team: Some("price_team_123"),
        ..BillingTestEnv::default()
    };
    with_api_test_app_state(
        "billing_create_checkout_invalid_payload",
        |state| with_billing_test_config(state, config),
        |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;

            let response = app
                .api_json(
                    Method::POST,
                    "/api/v1/billing/checkout-sessions",
                    Some(json!({ "plan": 123 })),
                    authenticated_json_headers(&session.token),
                )
                .await;

            response.assert_contract_status();
            assert_invalid_params_error(&response.body);
        },
    )
    .await;
}

#[tokio::test]
async fn billing_create_checkout_session_enforces_admin_and_plan_validation() {
    let gateway = Arc::new(TestBillingGateway::default());
    let config = BillingTestEnv {
        stripe_price_team: Some("price_team_123"),
        ..BillingTestEnv::default()
    };
    with_api_test_app_state(
        "billing_create_checkout_access_and_validation_v2",
        |state| with_billing_test_config(state, config).with_billing_gateway(gateway),
        |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let member_session = app.issue_session(&fixture.member_user_id).await;
            let forbidden_response = app
                .api_json(
                    Method::POST,
                    "/api/v1/billing/checkout-sessions",
                    Some(json!({ "plan": "team" })),
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            assert_eq!(
                forbidden_response.status,
                StatusCode::FORBIDDEN,
                "unexpected checkout response: {}",
                forbidden_response.body
            );
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
                .api_json(
                    Method::POST,
                    "/api/v1/billing/checkout-sessions",
                    Some(json!({ "plan": null })),
                    authenticated_json_headers(&owner_session.token),
                )
                .await;
            bad_request_response.assert_contract_status();
            assert_eq!(bad_request_response.body["code"], json!("BAD_REQUEST"));
        },
    )
    .await;
}

#[tokio::test]
async fn billing_create_checkout_session_success_persists_incomplete_state_and_stripe_customer() {
    let gateway = Arc::new(TestBillingGateway::default());
    let configured_gateway = gateway.clone();
    let config = BillingTestEnv {
        web_app_url: Some("https://app.example.com"),
        stripe_price_team: Some("price_team_123"),
        ..BillingTestEnv::default()
    };
    with_api_test_app_state(
        "billing_create_checkout_success",
        |state| with_billing_test_config(state, config).with_billing_gateway(configured_gateway),
        |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;

            let response = app
                .api_json(
                    Method::POST,
                    "/api/v1/billing/checkout-sessions",
                    Some(json!({ "plan": "team" })),
                    authenticated_json_headers(&session.token),
                )
                .await;

            response.assert_contract_status();
            assert_eq!(
                response.body["url"],
                json!("https://checkout.stripe.test/session/cs_test_123")
            );
            assert_eq!(response.body["sessionId"], json!("cs_test_123"));

            let team_row = load_team_billing_row(&app.pool, &fixture.team_id).await;
            assert_eq!(team_row.billing_plan, "team");
            assert_eq!(team_row.billing_status, "incomplete");
            assert_eq!(team_row.stripe_customer_id.as_deref(), Some("cus_test_123"));

            let calls = gateway.calls();
            assert_eq!(calls.len(), 2);
            assert_eq!(
                calls[0],
                BillingGatewayCall::CreateCustomer {
                    email: "billing-owner@example.com".to_string(),
                    name: "Billing Owner".to_string(),
                    team_id: fixture.team_id.clone(),
                    user_id: fixture.owner_user_id.clone(),
                },
            );
            assert_eq!(
                calls[1],
                BillingGatewayCall::CreateCheckoutSession(CheckoutSessionInput {
                    team_id: fixture.team_id,
                    user_id: fixture.owner_user_id,
                    customer_id: Some("cus_test_123".to_string()),
                    customer_email: "billing-owner@example.com".to_string(),
                    plan: "team".to_string(),
                    price_id: "price_team_123".to_string(),
                    quantity: 3,
                    success_url: "https://app.example.com/billing?checkout=success".to_string(),
                    cancel_url: "https://app.example.com/billing?checkout=cancel".to_string(),
                }),
            );
        },
    )
    .await;
}

#[tokio::test]
async fn billing_create_checkout_session_maps_gateway_failure() {
    let gateway = Arc::new(TestBillingGateway::failing("test gateway failure"));
    let configured_gateway = gateway.clone();
    let config = BillingTestEnv {
        stripe_price_team: Some("price_team_123"),
        ..BillingTestEnv::default()
    };
    with_api_test_app_state(
        "billing_create_checkout_gateway_failure",
        |state| with_billing_test_config(state, config).with_billing_gateway(configured_gateway),
        |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;

            let response = app
                .api_json(
                    Method::POST,
                    "/api/v1/billing/checkout-sessions",
                    Some(json!({ "plan": "team" })),
                    authenticated_json_headers(&session.token),
                )
                .await;

            response.assert_contract_status();
            assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(gateway.calls().len(), 1);
            assert!(matches!(
                &gateway.calls()[0],
                BillingGatewayCall::CreateCustomer { team_id, .. }
                    if team_id == &fixture.team_id
            ));
        },
    )
    .await;
}

#[tokio::test]
async fn billing_create_portal_session_requires_customer_and_returns_url() {
    let gateway = Arc::new(TestBillingGateway::default());
    let configured_gateway = gateway.clone();
    let config = BillingTestEnv {
        web_app_url: Some("https://app.example.com"),
        ..BillingTestEnv::default()
    };
    with_api_test_app_state(
        "billing_create_portal_session_paths",
        |state| with_billing_test_config(state, config).with_billing_gateway(configured_gateway),
        |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;

            let missing_customer_response = app
                .api_json(
                    Method::POST,
                    "/api/v1/billing/portal-sessions",
                    None,
                    authenticated_json_headers(&session.token),
                )
                .await;
            missing_customer_response.assert_contract_status();
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
                .api_json(
                    Method::POST,
                    "/api/v1/billing/portal-sessions",
                    None,
                    authenticated_json_headers(&session.token),
                )
                .await;
            success_response.assert_contract_status();
            assert_eq!(
                success_response.body["url"],
                json!("https://billing.stripe.test/portal/session_123")
            );

            assert_eq!(
                gateway.calls(),
                vec![BillingGatewayCall::CreateBillingPortalSession {
                    customer_id: "cus_portal_123".to_string(),
                    return_url: "https://app.example.com/billing".to_string(),
                }],
            );
        },
    )
    .await;
}

#[tokio::test]
async fn billing_preview_additional_team_seat_returns_none_and_maps_preview_response() {
    let gateway = Arc::new(TestBillingGateway::default());
    let configured_gateway = gateway.clone();
    let config = BillingTestEnv::default();
    with_api_test_app_state(
        "billing_preview_additional_team_seat_paths",
        |state| with_billing_test_config(state, config).with_billing_gateway(configured_gateway),
        |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;

            let none_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/billing/team-seats/addition-preview",
                    None,
                    authenticated_json_headers(&session.token),
                )
                .await;
            none_response.assert_contract_status();
            assert_eq!(none_response.body, Value::Null);

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
                .api_json(
                    Method::GET,
                    "/api/v1/billing/team-seats/addition-preview",
                    None,
                    authenticated_json_headers(&session.token),
                )
                .await;
            preview_response.assert_contract_status();
            assert_eq!(preview_response.body["currency"], json!("usd"));
            assert_eq!(preview_response.body["currentQuantity"], json!("3"));
            assert_eq!(preview_response.body["nextQuantity"], json!("4"));
            assert_eq!(
                preview_response.body["estimatedNextPaymentCents"],
                json!("750")
            );
            assert_eq!(preview_response.body["totalLineItemsCents"], json!("750"));
            assert_eq!(
                preview_response.body["lines"][0]["id"],
                json!("il_preview_123")
            );
            assert_eq!(
                preview_response.body["lines"][0]["description"],
                json!("Additional team seat")
            );
            assert_eq!(
                preview_response.body["lines"][0]["amountCents"],
                json!("750")
            );
            assert_eq!(
                preview_response.body["lines"][0]["unitAmountCents"],
                json!("750")
            );
            assert_eq!(
                preview_response.body["lines"][0]["isProration"],
                json!(true)
            );
            assert_eq!(
                preview_response.body["lines"][0]["periodStart"],
                json!(format_timestamp(
                    OffsetDateTime::from_unix_timestamp(1_717_300_000)
                        .expect("preview period start should be valid"),
                )),
            );
            assert_eq!(
                preview_response.body["lines"][0]["periodEnd"],
                json!(format_timestamp(
                    OffsetDateTime::from_unix_timestamp(1_719_892_800)
                        .expect("preview period end should be valid"),
                )),
            );

            assert_eq!(
                gateway.calls(),
                vec![BillingGatewayCall::PreviewUpcomingTeamSeatInvoice {
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
}

#[tokio::test]
async fn billing_create_portal_and_preview_require_billing_admin() {
    let gateway = Arc::new(TestBillingGateway::default());
    let config = BillingTestEnv::default();
    with_api_test_app_state(
        "billing_admin_only_handlers",
        |state| with_billing_test_config(state, config).with_billing_gateway(gateway),
        |app| async move {
            let fixture = build_billing_router_fixture(&app.pool).await;
            let member_session = app.issue_session(&fixture.member_user_id).await;

            for (method, path) in [
                (Method::POST, "/api/v1/billing/portal-sessions"),
                (Method::GET, "/api/v1/billing/team-seats/addition-preview"),
            ] {
                let response = app
                    .api_json(
                        method,
                        path,
                        None,
                        authenticated_json_headers(&member_session.token),
                    )
                    .await;
                response.assert_contract_status();
                assert_handler_error(
                    &response.body,
                    "FORBIDDEN",
                    "Only team owner or admin can manage billing",
                );
            }
        },
    )
    .await;
}
