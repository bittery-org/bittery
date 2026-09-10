use super::*;
use sqlx::postgres::PgPoolOptions;
use time::{Duration, OffsetDateTime};

#[test]
fn session_platform_helpers_normalize_inputs_and_web_client_ids() {
    assert_eq!(normalize_session_platform(None), "desktop");
    assert_eq!(normalize_session_platform(Some(" web ")), "web");
    assert_eq!(normalize_session_platform(Some(" iOS ")), "mobile");
    assert_eq!(normalize_session_platform(Some("unknown")), "desktop");

    assert_eq!(session_duration_for_platform("web"), Duration::hours(24));
    assert_eq!(
        session_duration_for_platform("extension"),
        Duration::days(7)
    );
    assert_eq!(session_duration_for_platform("desktop"), Duration::days(30));

    assert_eq!(
        normalized_session_client_id(Some("web"), Some(" browser-1 ".to_string())).as_deref(),
        Some("browser-1"),
    );
    assert_eq!(
        normalized_session_client_id(Some("desktop"), Some("desktop-client".to_string())),
        Some("desktop-client".to_string()),
    );
    assert_eq!(
        normalized_session_client_id(Some("web"), Some("   ".to_string())),
        None,
    );
}

#[test]
fn device_helpers_prefer_explicit_platform_and_build_expected_labels() {
    assert_eq!(
        detect_platform("mozilla/5.0 (iphone)", Some("extension")),
        "extension"
    );
    assert_eq!(detect_platform("mozilla/5.0 (iphone)", None), "ios");
    assert_eq!(detect_platform("mozilla/5.0 (android)", None), "android");
    assert_eq!(detect_platform("mozilla/5.0 (macintosh)", None), "web");

    assert_eq!(
        build_device_name("extension", Some("macOS"), None, Some("Safari")),
        "Bittery Extension (Safari on macOS)",
    );
    assert_eq!(
        build_device_name("ios", Some("iOS"), Some("17.5"), None),
        "Bittery on iOS 17.5",
    );
    assert_eq!(
        build_device_name("web", Some("Windows"), None, Some("Chrome")),
        "Chrome on Windows",
    );
    assert_eq!(build_device_name("web", None, None, None), "Unknown Device");
}

#[tokio::test]
async fn postgres_verification_propagates_backend_failures() {
    let pool = PgPoolOptions::new()
        .connect_lazy("postgres://test:test@127.0.0.1:1/bittery_session_failure")
        .expect("fixed unavailable database URL should parse");
    let sessions = SessionService::from_pool(pool.clone());
    pool.close().await;

    let error = sessions
        .verify_token("token")
        .await
        .expect_err("an unavailable session store must not look like a missing session");

    assert_eq!(error.code, crate::error::AppErrorCode::InternalServerError);
    assert_eq!(error.message, "Session store is unavailable");
}

#[tokio::test]
async fn unknown_token_is_a_successful_missing_session_lookup() {
    let sessions = SessionService::default();

    let session = sessions
        .verify_token("unknown-token")
        .await
        .expect("memory session lookup should succeed");

    assert!(session.is_none());
}

#[tokio::test]
async fn refresh_rotates_the_previous_session() {
    let sessions = SessionService::default();
    let seeded = sessions
        .seeded_session()
        .expect("memory backend should seed");
    let current = sessions
        .verify_token(&seeded.token)
        .await
        .expect("session lookup should succeed")
        .expect("seeded session should be valid");

    let next = sessions
        .refresh_session(&current)
        .await
        .expect("refresh should succeed");

    assert_ne!(next.session_id, seeded.session_id);
    assert!(sessions
        .verify_token(&seeded.token)
        .await
        .expect("session lookup should succeed")
        .is_none());
    assert!(sessions
        .verify_token(&next.token)
        .await
        .expect("session lookup should succeed")
        .is_some());
}

#[tokio::test]
async fn refresh_preserves_platform_duration_policy() {
    let sessions = SessionService::default();
    let current = sessions
        .issue_session_for_tests("extension-user", "extension", Some("extension-client"))
        .await;

    let next = sessions
        .refresh_session(&current)
        .await
        .expect("refresh should succeed");
    let refreshed = sessions
        .verify_token(&next.token)
        .await
        .expect("session lookup should succeed")
        .expect("refreshed token should remain valid");

    assert_eq!(refreshed.platform, "extension");
    assert_eq!(refreshed.client_id.as_deref(), Some("extension-client"));

    let remaining_days = (refreshed.expires_at - time::OffsetDateTime::now_utc()).whole_days();
    assert!(remaining_days >= 6);
    assert!(remaining_days <= 7);
}

#[tokio::test]
async fn expired_sessions_cannot_be_refreshed() {
    let sessions = SessionService::default();
    let mut expired = sessions
        .issue_session_for_tests("expired-user", "desktop", None)
        .await;
    expired.expires_at = time::OffsetDateTime::now_utc() - time::Duration::minutes(1);

    let error = sessions
        .refresh_session(&expired)
        .await
        .expect_err("expired session should fail");

    assert_eq!(error.message, "Session expired");
}

#[tokio::test]
async fn delete_session_removes_only_the_target_session() {
    let sessions = SessionService::default();
    let seeded = sessions
        .seeded_session()
        .expect("memory backend should seed");
    let other = sessions
        .issue_session_for_tests("dev-user", "desktop", None)
        .await;

    sessions
        .delete_session(&seeded.session_id)
        .await
        .expect("delete_session should succeed");

    assert!(sessions
        .verify_token(&seeded.token)
        .await
        .expect("session lookup should succeed")
        .is_none());
    assert!(sessions
        .verify_token(&other.token)
        .await
        .expect("session lookup should succeed")
        .is_some());
}

#[tokio::test]
async fn delete_all_user_sessions_keeps_other_users_signed_in() {
    let sessions = SessionService::default();
    let target = sessions
        .issue_session_for_tests("target-user", "desktop", None)
        .await;
    let other = sessions
        .issue_session_for_tests("other-user", "desktop", None)
        .await;

    sessions
        .delete_all_user_sessions("target-user")
        .await
        .expect("delete_all_user_sessions should succeed");

    assert!(sessions
        .verify_token(&target.token)
        .await
        .expect("session lookup should succeed")
        .is_none());
    assert!(sessions
        .verify_token(&other.token)
        .await
        .expect("session lookup should succeed")
        .is_some());
}

#[tokio::test]
async fn list_devices_collapses_grouped_web_sessions() {
    let sessions = SessionService::default();
    let current = sessions
        .issue_session_for_tests("user-a", "desktop", None)
        .await;
    let web_a = sessions
        .issue_session_for_tests("user-a", "web", Some("web-group"))
        .await;
    let web_b = sessions
        .issue_session_for_tests("user-a", "web", Some("web-group"))
        .await;

    if let SessionBackend::Memory(inner) = &sessions.backend {
        let mut records = inner.sessions_by_token.write();
        for record in records.values_mut() {
            if record.session_id == web_a.session_id {
                record.last_active_at = OffsetDateTime::now_utc() - Duration::days(2);
            }
            if record.session_id == web_b.session_id {
                record.last_active_at = OffsetDateTime::now_utc() - Duration::days(1);
            }
        }
    }

    let devices = sessions
        .list_devices("user-a", &current.session_id)
        .await
        .expect("list_devices should succeed");

    let web_ids = devices
        .iter()
        .filter(|device| device.platform == "web")
        .map(|device| device.id.clone())
        .collect::<Vec<_>>();

    assert_eq!(web_ids, vec![web_b.session_id]);
    assert!(devices
        .iter()
        .any(|device| device.id == current.session_id && device.is_current_session));
}

#[tokio::test]
async fn create_session_reuses_existing_desktop_client_id() {
    let sessions = SessionService::default();
    let request = RequestMetadata {
        auth_token: None,
        client_id: Some("desktop-device-1".to_string()),
        app_platform: Some("desktop".to_string()),
        user_agent: Some("integration-test".to_string()),
        ip_address: Some("127.0.0.1".to_string()),
    };

    let first = sessions
        .create_session("user-desktop", &request)
        .await
        .expect("first session should be created");
    let second = sessions
        .create_session("user-desktop", &request)
        .await
        .expect("second session should be created");

    assert!(sessions
        .verify_token(&first.token)
        .await
        .expect("session lookup should succeed")
        .is_none());
    assert!(sessions
        .verify_token(&second.token)
        .await
        .expect("session lookup should succeed")
        .is_some());

    let devices = sessions
        .list_devices("user-desktop", &second.session_id)
        .await
        .expect("list_devices should succeed");

    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].id, second.session_id);
    assert_eq!(devices[0].platform, "desktop");
    assert!(devices[0].is_current_session);
}

#[tokio::test]
async fn rename_device_updates_active_grouped_web_sessions() {
    let sessions = SessionService::default();
    let grouped_a = sessions
        .issue_session_for_tests("user-b", "web", Some("rename-group"))
        .await;
    let grouped_b = sessions
        .issue_session_for_tests("user-b", "web", Some("rename-group"))
        .await;

    sessions
        .rename_device(&grouped_a.session_id, "user-b", "Unified Browser")
        .await
        .expect("rename_device should succeed");

    let devices = sessions
        .list_devices("user-b", &grouped_a.session_id)
        .await
        .expect("list_devices should succeed");

    assert!(devices
        .iter()
        .filter(|device| device.platform == "web")
        .all(|device| device.device_name.as_deref() == Some("Unified Browser")));
    assert!(sessions
        .verify_token(&grouped_b.token)
        .await
        .expect("session lookup should succeed")
        .is_some());
}

#[tokio::test]
async fn revoke_device_revokes_grouped_web_sessions() {
    let sessions = SessionService::default();
    let grouped_a = sessions
        .issue_session_for_tests("user-c", "web", Some("revoke-group"))
        .await;
    let grouped_b = sessions
        .issue_session_for_tests("user-c", "web", Some("revoke-group"))
        .await;

    let revoked = sessions
        .revoke_device(&grouped_a.session_id, "user-c")
        .await
        .expect("revoke_device should succeed");

    assert_eq!(revoked.len(), 2);
    assert!(sessions
        .verify_token(&grouped_a.token)
        .await
        .expect("session lookup should succeed")
        .is_none());
    assert!(sessions
        .verify_token(&grouped_b.token)
        .await
        .expect("session lookup should succeed")
        .is_none());
}

#[tokio::test]
async fn heartbeat_updates_last_active_timestamp() {
    let sessions = SessionService::default();
    let current = sessions
        .issue_session_for_tests("user-d", "desktop", None)
        .await;
    let before = sessions
        .list_devices("user-d", &current.session_id)
        .await
        .expect("list_devices should succeed")
        .into_iter()
        .find(|device| device.id == current.session_id)
        .expect("current device should exist")
        .last_active_at;

    sessions
        .heartbeat(&current.session_id)
        .await
        .expect("heartbeat should succeed");

    let after = sessions
        .list_devices("user-d", &current.session_id)
        .await
        .expect("list_devices should succeed")
        .into_iter()
        .find(|device| device.id == current.session_id)
        .expect("current device should exist")
        .last_active_at;

    // Compare parsed instants, not the RFC3339 strings: `time` trims trailing
    // zeros from subseconds, so a later timestamp can sort lexicographically
    // BEFORE an earlier one (e.g. "…00.51Z" < "…00.5Z", since '1' < 'Z').
    assert!(parse_rfc3339(&after) >= parse_rfc3339(&before));
}

fn parse_rfc3339(value: &str) -> OffsetDateTime {
    OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .expect("timestamp should be valid RFC3339")
}
