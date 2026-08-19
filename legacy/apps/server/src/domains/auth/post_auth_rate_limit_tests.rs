use std::sync::Arc;

use axum::http::{Method, StatusCode};
use serde_json::{json, Value};
use time::OffsetDateTime;

use crate::{
    shared::rate_limit::{
        SCOPE_CHANGE_PASSWORD_USER, SCOPE_DELETE_ACCOUNT_USER, SCOPE_REGENERATE_SECRET_KEY_USER,
        SCOPE_RENAME_SESSION_ACTOR, SCOPE_REVOKE_SESSION_ACTOR, SCOPE_UPDATE_EMAIL_USER,
    },
    test_support::{authenticated_json_headers, seed_user, with_api_test_app_state, ApiTestApp},
};

use super::devices::device_rate_limit_key;

fn invalid_credentials_payload() -> Value {
    json!({
        "srpSalt": "invalid",
        "srpVerifier": "invalid",
        "encryptedPrivateKey": "encrypted",
        "encryptedVaultKeys": [],
        "kdfParams": {
            "schemaVersion": 1,
            "algorithm": "pbkdf2-sha256",
            "iterations": 600000
        }
    })
}

fn invalid_secret_key_payload() -> Value {
    let mut payload = invalid_credentials_payload();
    payload["secretKeyHint"] = json!("hint");
    payload
}

fn configure_limits(mut state: crate::AppState) -> crate::AppState {
    let config = Arc::make_mut(&mut state.config);
    config.rate_limit.account_mutation = 1;
    config.rate_limit.device_revoke = 1;
    config.rate_limit.device_rename = 1;
    state
}

async fn assert_first_allowed_then_limited(
    app: &ApiTestApp,
    method: Method,
    path: &str,
    payload: Option<Value>,
    token: &str,
) {
    let first = app
        .api_json(
            method.clone(),
            path,
            payload.clone(),
            authenticated_json_headers(token),
        )
        .await;
    assert_ne!(first.status, StatusCode::TOO_MANY_REQUESTS);

    let limited = app
        .api_json(method, path, payload, authenticated_json_headers(token))
        .await;
    assert_eq!(limited.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(limited.body["code"], json!("RATE_LIMITED"));
    assert_eq!(limited.headers["retry-after"], "60");
}

#[tokio::test]
async fn sensitive_account_operations_have_independent_per_user_limits() {
    with_api_test_app_state(
        "post_auth_account_rate_limits",
        configure_limits,
        |app| async move {
            seed_user(&app.pool, "usr_limit_a", "Limit A", "limit-a@example.com").await;
            seed_user(&app.pool, "usr_limit_b", "Limit B", "limit-b@example.com").await;
            let session_a = app.issue_session("usr_limit_a").await;
            let session_b = app.issue_session("usr_limit_b").await;

            for (method, path, payload, scope) in [
                (
                    Method::POST,
                    "/api/v1/users/me/email-changes",
                    Some(json!({
                        "newEmail": "new@example.com",
                        "srpSalt": "invalid",
                        "srpVerifier": "invalid",
                        "encryptedPrivateKey": "encrypted",
                        "encryptedVaultKeys": [],
                        "kdfParams": {
                            "schemaVersion": 1,
                            "algorithm": "pbkdf2-sha256",
                            "iterations": 600000
                        }
                    })),
                    SCOPE_UPDATE_EMAIL_USER,
                ),
                (
                    Method::POST,
                    "/api/v1/users/me/password-changes",
                    Some(invalid_credentials_payload()),
                    SCOPE_CHANGE_PASSWORD_USER,
                ),
                (
                    Method::POST,
                    "/api/v1/users/me/secret-key-rotations",
                    Some(invalid_secret_key_payload()),
                    SCOPE_REGENERATE_SECRET_KEY_USER,
                ),
                (
                    Method::DELETE,
                    "/api/v1/users/me",
                    Some(json!({ "confirmEmail": "wrong@example.com" })),
                    SCOPE_DELETE_ACCOUNT_USER,
                ),
            ] {
                assert_first_allowed_then_limited(&app, method, path, payload, &session_a.token)
                    .await;

                let count = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*)::bigint FROM rate_limit_state WHERE scope = $1 AND key = $2",
                )
                .bind(scope)
                .bind(&session_a.user_id)
                .fetch_one(&app.pool)
                .await
                .expect("rate-limit state should load");
                assert_eq!(count, 1);
            }

            let other_user = app
                .api_json(
                    Method::POST,
                    "/api/v1/users/me/password-changes",
                    Some(invalid_credentials_payload()),
                    authenticated_json_headers(&session_b.token),
                )
                .await;
            assert_ne!(other_user.status, StatusCode::TOO_MANY_REQUESTS);
        },
    )
    .await;
}

#[tokio::test]
async fn sensitive_device_operations_are_limited_without_sharing_a_scope() {
    with_api_test_app_state(
        "post_auth_device_rate_limits",
        configure_limits,
        |app| async move {
            seed_user(
                &app.pool,
                "usr_device_limit",
                "Device Limit",
                "device-limit@example.com",
            )
            .await;
            let legitimate = app.issue_session("usr_device_limit").await;
            let attacker = app.issue_session("usr_device_limit").await;
            let first_target = app.issue_session("usr_device_limit").await;
            let second_target = app.issue_session("usr_device_limit").await;

            assert_first_allowed_then_limited(
                &app,
                Method::PATCH,
                &format!("/api/v1/sessions/{}", attacker.session_id),
                Some(json!({ "deviceName": "Attacker device" })),
                &attacker.token,
            )
            .await;
            let legitimate_rename = app
                .api_json(
                    Method::PATCH,
                    &format!("/api/v1/sessions/{}", legitimate.session_id),
                    Some(json!({ "deviceName": "Primary device" })),
                    authenticated_json_headers(&legitimate.token),
                )
                .await;
            assert_eq!(legitimate_rename.status, StatusCode::OK);

            assert_first_allowed_then_limited(
                &app,
                Method::DELETE,
                &format!("/api/v1/sessions/{}", first_target.session_id),
                None,
                &attacker.token,
            )
            .await;

            let second_target_still_exists = app
                .state
                .sessions
                .get_owned_session(&second_target.session_id, &legitimate.user_id)
                .await
                .expect("session lookup should succeed")
                .is_some();
            assert!(second_target_still_exists);

            let legitimate_revoke = app
                .api_json(
                    Method::DELETE,
                    &format!("/api/v1/sessions/{}", attacker.session_id),
                    None,
                    authenticated_json_headers(&legitimate.token),
                )
                .await;
            assert_eq!(legitimate_revoke.status, StatusCode::OK);

            for scope in [SCOPE_RENAME_SESSION_ACTOR, SCOPE_REVOKE_SESSION_ACTOR] {
                let count = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*)::bigint FROM rate_limit_state WHERE scope = $1",
                )
                .bind(scope)
                .fetch_one(&app.pool)
                .await
                .expect("rate-limit state should load");
                assert_eq!(count, 2);
            }
        },
    )
    .await;
}

#[test]
fn device_limit_identity_survives_refresh_without_merging_devices() {
    let session = |session_id: &str, client_id: Option<&str>| {
        crate::domains::sessions::service::VerifiedSession {
            token: format!("token-{session_id}"),
            session_id: session_id.to_owned(),
            user_id: "usr_device_identity".to_owned(),
            expires_at: OffsetDateTime::now_utc(),
            platform: "desktop".to_owned(),
            client_id: client_id.map(str::to_owned),
        }
    };

    assert_eq!(
        device_rate_limit_key(&session("ses_before_refresh", Some("client-a"))),
        device_rate_limit_key(&session("ses_after_refresh", Some("client-a"))),
    );
    assert_ne!(
        device_rate_limit_key(&session("ses_a", Some("client-a"))),
        device_rate_limit_key(&session("ses_b", Some("client-b"))),
    );
    assert_ne!(
        device_rate_limit_key(&session("ses_a", None)),
        device_rate_limit_key(&session("ses_b", None)),
    );
}
