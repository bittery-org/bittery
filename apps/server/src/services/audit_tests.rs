use std::{collections::HashMap, future::Future};

use axum::http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, Method};
use serde_json::json;
use sqlx::{query, PgPool};
use time::{macros::datetime, OffsetDateTime};

use super::*;
use crate::config::bittery_mode;
use crate::db::enums::{BillingPlan, BillingStatus};
use crate::error::AppErrorCode;
use crate::repo::common::hash_token;
use crate::services::team_billing::team_management_enabled;
use crate::test_support::{
    acquire_env_lock, acquire_env_lock_async, assign_user_to_team, authenticated_json_headers,
    seed_item, seed_team, seed_user, seed_vault, seed_vault_key, with_api_test_app,
};

fn with_bittery_mode<T>(value: Option<&str>, test_fn: impl FnOnce() -> T) -> T {
    let _guard = acquire_env_lock();
    let previous = std::env::var("BITTERY_MODE").ok();

    match value {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }

    let result = test_fn();

    match previous.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }

    result
}

async fn with_bittery_mode_async<T, F>(value: Option<&str>, future: F) -> T
where
    F: Future<Output = T>,
{
    let _guard = acquire_env_lock_async().await;
    let previous = std::env::var("BITTERY_MODE").ok();
    match value {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }

    let result = future.await;

    match previous.as_deref() {
        Some(value) => unsafe { std::env::set_var("BITTERY_MODE", value) },
        None => unsafe { std::env::remove_var("BITTERY_MODE") },
    }

    result
}

fn sample_event(id: &str, timestamp: &str, source: EventSource) -> TeamEvent {
    TeamEvent {
        id: id.to_string(),
        timestamp: timestamp.to_string(),
        source,
        action: "team_member_added".to_string(),
        action_group: AuditActionGroup::Team,
        actor: TeamEventActor {
            user_id: Some("user_1".to_string()),
            name: Some("Alice".to_string()),
            email: Some("alice@example.com".to_string()),
        },
        entity: TeamEventEntity {
            r#type: Some("team".to_string()),
            id: Some("team_1".to_string()),
        },
        result: TeamEventResult::Success,
        network: TeamEventNetwork {
            masked_ip: Some("10.0.x.x".to_string()),
            masked_user_agent: Some("Chrome".to_string()),
            full_ip: Some("10.0.0.1".to_string()),
            full_user_agent: Some("Chrome/123.0".to_string()),
        },
        metadata: None,
    }
}

fn sample_member_map() -> HashMap<String, TeamMemberRow> {
    HashMap::from([(
        "user_1".to_string(),
        TeamMemberRow {
            id: "user_1".to_string(),
            name: Some("Alice".to_string()),
            email: Some("alice@example.com".to_string()),
        },
    )])
}

#[test]
fn normalize_input_applies_defaults_and_trims_search() {
    let input = TeamEventsInput {
        cursor: None,
        limit: Some(250),
        from: Some("2025-05-01T00:00:00Z".to_string()),
        to: Some("2025-05-02T00:00:00Z".to_string()),
        action_group: None,
        actor_user_id: Some("user_1".to_string()),
        result: None,
        search: Some("  alice@example.com  ".to_string()),
    };

    let normalized = normalize_input(&input).expect("input should normalize");

    assert_eq!(normalized.limit, MAX_LIMIT);
    assert_eq!(normalized.action_group, AuditActionGroupFilter::All);
    assert_eq!(normalized.result, AuditResultFilter::All);
    assert_eq!(normalized.actor_user_id.as_deref(), Some("user_1"));
    assert_eq!(
        normalized.search_pattern.as_deref(),
        Some("%alice@example.com%")
    );
    assert_eq!(normalized.from, Some(datetime!(2025-05-01 0:00 UTC)));
    assert_eq!(normalized.to, Some(datetime!(2025-05-02 0:00 UTC)));
}

#[test]
fn normalize_input_rejects_invalid_dates_and_cursor() {
    let invalid_dates = TeamEventsInput {
        cursor: None,
        limit: None,
        from: Some("2025-05-03T00:00:00Z".to_string()),
        to: Some("2025-05-02T00:00:00Z".to_string()),
        action_group: None,
        actor_user_id: None,
        result: None,
        search: None,
    };

    let date_error = normalize_input(&invalid_dates).unwrap_err();
    assert_eq!(date_error.code, AppErrorCode::BadRequest);
    assert_eq!(
        date_error.message,
        "The from date must be before the to date"
    );

    let invalid_cursor = TeamEventsInput {
        cursor: Some("not-base64".to_string()),
        limit: None,
        from: None,
        to: None,
        action_group: None,
        actor_user_id: None,
        result: None,
        search: None,
    };

    let cursor_error = normalize_input(&invalid_cursor).unwrap_err();
    assert_eq!(cursor_error.code, AppErrorCode::BadRequest);
    assert_eq!(cursor_error.message, "Invalid pagination cursor");
}

#[test]
fn cursor_round_trip_preserves_timestamp_source_and_id() {
    let event = sample_event("evt_2", "2025-05-02T12:30:00Z", EventSource::ShareAccessLog);

    let encoded = encode_cursor(&event);
    let decoded = decode_cursor(&encoded).expect("cursor should decode");

    assert_eq!(decoded.timestamp, event.timestamp);
    assert_eq!(decoded.source, event.source);
    assert_eq!(decoded.id, event.id);
}

#[test]
fn parse_metadata_only_returns_objects() {
    assert_eq!(
        parse_metadata(Some(r#"{"actor":"alice"}"#)),
        Some(json!({ "actor": "alice" }))
    );
    assert_eq!(parse_metadata(Some(r#"[1,2,3]"#)), None);
    assert_eq!(parse_metadata(Some("not-json")), None);
    assert_eq!(parse_metadata(None), None);
}

#[test]
fn action_group_for_action_classifies_known_prefixes_and_auth_actions() {
    assert_eq!(
        action_group_for_action("team_member_added"),
        AuditActionGroup::Team
    );
    assert_eq!(
        action_group_for_action("vault_rotated"),
        AuditActionGroup::Vault
    );
    assert_eq!(
        action_group_for_action("item_deleted"),
        AuditActionGroup::Item
    );
    assert_eq!(
        action_group_for_action("share_link_created"),
        AuditActionGroup::Share
    );
    assert_eq!(
        action_group_for_action("password_changed"),
        AuditActionGroup::Auth
    );
    assert_eq!(
        action_group_for_action("custom_event"),
        AuditActionGroup::Other
    );
}

#[test]
fn compare_event_order_and_cursor_logic_follow_descending_sort() {
    let newest = sample_event("evt_3", "2025-05-03T00:00:00Z", EventSource::AuditLog);
    let same_time_audit = sample_event("evt_2", "2025-05-02T00:00:00Z", EventSource::AuditLog);
    let same_time_share =
        sample_event("evt_4", "2025-05-02T00:00:00Z", EventSource::ShareAccessLog);
    let same_time_lower_id =
        sample_event("evt_1", "2025-05-02T00:00:00Z", EventSource::ShareAccessLog);
    let oldest = sample_event("evt_0", "2025-05-01T00:00:00Z", EventSource::AuditLog);

    let mut events = [
        same_time_share.clone(),
        oldest.clone(),
        newest.clone(),
        same_time_lower_id.clone(),
        same_time_audit.clone(),
    ];
    events.sort_by(compare_event_order);

    assert_eq!(
        events
            .iter()
            .map(|event| event.id.as_str())
            .collect::<Vec<_>>(),
        vec!["evt_3", "evt_2", "evt_4", "evt_1", "evt_0"]
    );

    let cursor = CursorPayload {
        timestamp: "2025-05-02T00:00:00Z".to_string(),
        source: EventSource::ShareAccessLog,
        id: "evt_4".to_string(),
    };

    assert!(!event_after_cursor(&newest, &cursor));
    assert!(!event_after_cursor(&same_time_audit, &cursor));
    assert!(!event_after_cursor(&same_time_share, &cursor));
    assert!(event_after_cursor(&same_time_lower_id, &cursor));
    assert!(event_after_cursor(&oldest, &cursor));
}

#[test]
fn mask_ip_handles_ipv4_ipv6_and_unknown_values() {
    assert_eq!(
        mask_ip(Some("192.168.10.42")),
        Some("192.168.x.x".to_string())
    );
    assert_eq!(
        mask_ip(Some("2001:db8::1")),
        Some("2001:db8:xxxx:xxxx::*".to_string())
    );
    assert_eq!(mask_ip(Some("hostname")), Some("masked".to_string()));
    assert_eq!(mask_ip(None), None);
}

#[test]
fn mask_user_agent_handles_common_browsers_and_fallbacks() {
    assert_eq!(
        mask_user_agent(Some("Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36")),
        Some("Chrome".to_string())
    );
    assert_eq!(
        mask_user_agent(Some("Mozilla/5.0 Version/17.4 Safari/605.1.15")),
        Some("Safari".to_string())
    );
    assert_eq!(
        mask_user_agent(Some("CustomAgent/1.0 SomethingElse")),
        Some("CustomAgent/1.0".to_string())
    );
    assert_eq!(mask_user_agent(None), None);
}

#[test]
fn team_management_enabled_respects_billing_state_and_mode() {
    // The console gate resolves entitlement on the team plan; these assertions pin
    // the billing states it accepts. The gate itself lives in `services::team_admin`.
    let console_gate = |billing_status: Option<BillingStatus>| {
        team_management_enabled(bittery_mode(), Some(BillingPlan::Team), billing_status)
    };

    with_bittery_mode(None, || {
        assert!(!console_gate(None));
        assert!(!console_gate(Some(BillingStatus::PastDue)));
        assert!(console_gate(Some(BillingStatus::Active)));
        assert!(console_gate(Some(BillingStatus::Trialing)));
        assert_eq!(bittery_mode(), "cloud");
    });

    with_bittery_mode(Some("self-hosted"), || {
        assert!(console_gate(None));
        assert_eq!(bittery_mode(), "self-hosted");
    });
}

#[test]
fn to_audit_event_maps_actor_entity_network_and_metadata() {
    let row = AuditEventRow {
        id: "audit_1".to_string(),
        user_id: "user_1".to_string(),
        action: "password_changed".to_string(),
        entity_type: Some("user".to_string()),
        entity_id: Some("user_1".to_string()),
        ip_address: Some("192.168.10.42".to_string()),
        user_agent: Some("Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36".to_string()),
        metadata: Some(r#"{"ipAddress":"sensitive"}"#.to_string()),
        created_at: datetime!(2025-05-02 12:30 UTC),
    };

    let event = to_audit_event(row, &sample_member_map());

    assert_eq!(event.id, "audit_1");
    assert_eq!(event.timestamp, "2025-05-02T12:30:00Z");
    assert_eq!(event.source, EventSource::AuditLog);
    assert_eq!(event.action, "password_changed");
    assert_eq!(event.action_group, AuditActionGroup::Auth);
    assert_eq!(event.result, TeamEventResult::Success);
    assert_eq!(event.actor.user_id.as_deref(), Some("user_1"));
    assert_eq!(event.actor.name.as_deref(), Some("Alice"));
    assert_eq!(event.actor.email.as_deref(), Some("alice@example.com"));
    assert_eq!(event.entity.r#type.as_deref(), Some("user"));
    assert_eq!(event.entity.id.as_deref(), Some("user_1"));
    assert_eq!(event.network.masked_ip.as_deref(), Some("192.168.x.x"));
    assert_eq!(event.network.masked_user_agent.as_deref(), Some("Chrome"));
    assert_eq!(event.metadata, Some(json!({ "ipAddress": "sensitive" })));
}

#[test]
fn to_share_access_event_maps_failure_metadata_and_masks() {
    let row = ShareAccessEventRow {
        id: "share_access_1".to_string(),
        share_link_id: "share_link_1".to_string(),
        created_by_id: "user_1".to_string(),
        accessed_by_email: Some("guest@example.com".to_string()),
        ip_address: Some("2001:db8::1".to_string()),
        user_agent: Some("Mozilla/5.0 Firefox/124.0".to_string()),
        success: false,
        failure_reason: Some("expired".to_string()),
        accessed_at: datetime!(2025-05-02 12:45 UTC),
    };

    let event = to_share_access_event(row, &sample_member_map());

    assert_eq!(event.id, "share_access_1");
    assert_eq!(event.timestamp, "2025-05-02T12:45:00Z");
    assert_eq!(event.source, EventSource::ShareAccessLog);
    assert_eq!(event.action, "share_access_failed");
    assert_eq!(event.action_group, AuditActionGroup::Share);
    assert_eq!(event.result, TeamEventResult::Failure);
    assert_eq!(event.actor.user_id, None);
    assert_eq!(event.actor.name.as_deref(), Some("guest@example.com"));
    assert_eq!(event.entity.r#type.as_deref(), Some("share_link"));
    assert_eq!(event.entity.id.as_deref(), Some("share_link_1"));
    assert_eq!(
        event.network.masked_ip.as_deref(),
        Some("2001:db8:xxxx:xxxx::*")
    );
    assert_eq!(event.network.masked_user_agent.as_deref(), Some("Firefox"));
    assert_eq!(
        event.metadata,
        Some(json!({
            "failureReason": "expired",
            "createdByUserId": "user_1",
            "createdByName": "Alice",
            "createdByEmail": "alice@example.com"
        }))
    );
}

#[test]
fn parse_timestamp_rejects_invalid_rfc3339_values() {
    let error = parse_timestamp("not-a-timestamp").unwrap_err();

    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Invalid RFC3339 timestamp");
}

#[test]
fn decode_cursor_rejects_payload_with_invalid_timestamp() {
    let payload = CursorPayload {
        timestamp: "invalid".to_string(),
        source: EventSource::AuditLog,
        id: "evt_1".to_string(),
    };
    let raw =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("cursor should serialize"));

    let error = decode_cursor(&raw).unwrap_err();

    assert_eq!(error.code, AppErrorCode::BadRequest);
    assert_eq!(error.message, "Invalid RFC3339 timestamp");
}

#[test]
fn normalize_input_ignores_blank_search_terms() {
    let input = TeamEventsInput {
        cursor: None,
        limit: None,
        from: None,
        to: None,
        action_group: Some(AuditActionGroupFilter::Auth),
        actor_user_id: None,
        result: Some(AuditResultFilter::Success),
        search: Some("   ".to_string()),
    };

    let normalized = normalize_input(&input).expect("input should normalize");

    assert_eq!(normalized.limit, DEFAULT_LIMIT);
    assert_eq!(normalized.action_group, AuditActionGroupFilter::Auth);
    assert_eq!(normalized.result, AuditResultFilter::Success);
    assert_eq!(normalized.search_pattern, None);
    assert_eq!(normalized.cursor, None);
}

#[test]
fn source_rank_prioritizes_audit_log_after_share_access_log() {
    assert!(source_rank(EventSource::AuditLog) > source_rank(EventSource::ShareAccessLog));
}

#[test]
fn mask_ip_returns_masked_for_short_ipv6_sequences() {
    assert_eq!(mask_ip(Some("::1")), Some("masked".to_string()));
}

#[test]
fn to_audit_event_drops_non_object_metadata() {
    let row = AuditEventRow {
        id: "audit_2".to_string(),
        user_id: "user_1".to_string(),
        action: "custom_event".to_string(),
        entity_type: None,
        entity_id: None,
        ip_address: None,
        user_agent: None,
        metadata: Some(r#"[1,2,3]"#.to_string()),
        created_at: OffsetDateTime::UNIX_EPOCH,
    };

    let event = to_audit_event(row, &sample_member_map());

    assert_eq!(event.action_group, AuditActionGroup::Other);
    assert_eq!(event.metadata, None);
}

#[tokio::test]
async fn team_events_requires_authentication() {
    with_api_test_app(
        "audit_team_events_requires_authentication",
        |app| async move {
            let response = app
                .api_json(
                    Method::GET,
                    "/api/v1/audit-events",
                    None,
                    unauthenticated_json_headers(),
                )
                .await;

            response.assert_contract_status();
            assert_transport_error(
                &response.body,
                "UNAUTHORIZED",
                "A valid bearer session is required.",
            );
        },
    )
    .await;
}

#[tokio::test]
async fn team_events_enforce_access_control_and_team_not_found_paths() {
    with_api_test_app("audit_team_events_access_control", |app| async move {
        with_bittery_mode_async(Some("cloud"), async {
            let fixture = build_audit_router_fixture(&app.pool).await;

            let member_session = app.issue_session(&fixture.member_user_id).await;
            let member_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/audit-events",
                    None,
                    authenticated_json_headers(&member_session.token),
                )
                .await;
            member_response.assert_contract_status();
            assert_handler_error(
                &member_response.body,
                "FORBIDDEN",
                "Only team owner or admin can access this console",
            );

            let personal_session = app.issue_session(&fixture.personal_owner_user_id).await;
            let personal_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/audit-events",
                    None,
                    authenticated_json_headers(&personal_session.token),
                )
                .await;
            personal_response.assert_contract_status();
            assert_handler_error(
                &personal_response.body,
                "FORBIDDEN",
                "This console is only available on Team plans",
            );

            let inactive_session = app.issue_session(&fixture.inactive_owner_user_id).await;
            let inactive_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/audit-events",
                    None,
                    authenticated_json_headers(&inactive_session.token),
                )
                .await;
            inactive_response.assert_contract_status();
            assert_handler_error(
                &inactive_response.body,
                "FORBIDDEN",
                "Team management is unavailable until billing is active",
            );

            let no_team_session = app.issue_session(&fixture.no_team_user_id).await;
            let no_team_response = app
                .api_json(
                    Method::GET,
                    "/api/v1/audit-events",
                    None,
                    authenticated_json_headers(&no_team_session.token),
                )
                .await;
            no_team_response.assert_contract_status();
            assert_handler_error(&no_team_response.body, "NOT_FOUND", "Team not found");
        })
        .await;
    })
    .await;
}

#[tokio::test]
async fn team_events_allow_self_hosted_admins_without_team_plan() {
    with_api_test_app("audit_team_events_self_hosted", |app| async move {
        let fixture = build_audit_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.personal_owner_user_id).await;
        let response = with_bittery_mode_async(
            Some("self-hosted"),
            app.api_json(
                Method::GET,
                &format!("/api/v1/audit-events?limit={}", 1),
                None,
                authenticated_json_headers(&session.token),
            ),
        )
        .await;

        response.assert_contract_status();
        assert!(
            response.body["events"].is_array(),
            "expected team events payload, got {:?}",
            response.body
        );
    })
    .await;
}

#[tokio::test]
async fn team_events_reject_malformed_request_input() {
    with_api_test_app("audit_team_events_malformed_request", |app| async move {
        let fixture = build_audit_router_fixture(&app.pool).await;
        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);

        let date_response = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/audit-events?from={}&to={}",
                    "2025-05-03T00:00:00Z", "2025-05-02T00:00:00Z"
                ),
                None,
                headers.clone(),
            )
            .await;
        date_response.assert_contract_status();
        assert_handler_error(
            &date_response.body,
            "BAD_REQUEST",
            "The from date must be before the to date",
        );

        let cursor_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/audit-events?cursor={}", "not-base64"),
                None,
                headers,
            )
            .await;
        cursor_response.assert_contract_status();
        assert_handler_error(
            &cursor_response.body,
            "BAD_REQUEST",
            "Invalid pagination cursor",
        );
    })
    .await;
}

#[tokio::test]
async fn team_events_return_paginated_merged_results_with_cursor() {
    with_api_test_app("audit_team_events_success_pagination", |app| async move {
        let fixture = build_audit_router_fixture(&app.pool).await;
        seed_audit_event(
            &app.pool,
            "audit_newest",
            &fixture.owner_user_id,
            "team_member_added",
            Some("team"),
            Some(&fixture.team_id),
            Some(r#"{"scope":"team"}"#),
            Some("10.20.30.40"),
            Some("Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36"),
            datetime!(2025-05-03 09:00 UTC),
        )
        .await;
        seed_audit_event(
            &app.pool,
            "audit_same_time",
            &fixture.owner_user_id,
            "password_changed",
            Some("user"),
            Some(&fixture.owner_user_id),
            Some(r#"{"reason":"rotation"}"#),
            Some("192.168.10.42"),
            Some("Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36"),
            datetime!(2025-05-02 12:00 UTC),
        )
        .await;
        seed_share_access_event(
            &app.pool,
            "share_success",
            &fixture.share_link_id,
            Some("guest@example.com"),
            Some("2001:db8::1"),
            Some("Mozilla/5.0 Firefox/124.0"),
            true,
            None,
            datetime!(2025-05-02 12:00 UTC),
        )
        .await;

        let session = app.issue_session(&fixture.owner_user_id).await;
        let first_page = app
            .api_json(
                Method::GET,
                &format!("/api/v1/audit-events?limit={}", 2),
                None,
                authenticated_json_headers(&session.token),
            )
            .await;

        first_page.assert_contract_status();
        assert_eq!(
            first_page.body["events"]
                .as_array()
                .expect("events should be an array")
                .len(),
            2
        );
        assert_eq!(first_page.body["events"][0]["id"], json!("audit_newest"));
        assert_eq!(first_page.body["events"][1]["id"], json!("audit_same_time"));
        assert_eq!(
            first_page.body["events"][0]["network"]["maskedIp"],
            json!("10.20.x.x")
        );
        assert_eq!(first_page.body["events"][1]["actionGroup"], json!("auth"));
        let next_cursor = first_page.body["nextCursor"]
            .as_str()
            .expect("next cursor should be present")
            .to_string();

        let second_page = app
            .api_json(
                Method::GET,
                &format!("/api/v1/audit-events?cursor={}", next_cursor),
                None,
                authenticated_json_headers(&session.token),
            )
            .await;

        second_page.assert_contract_status();
        assert_eq!(
            second_page.body["events"]
                .as_array()
                .expect("events should be an array")
                .len(),
            1
        );
        assert_eq!(second_page.body["events"][0]["id"], json!("share_success"));
        assert_eq!(
            second_page.body["events"][0]["source"],
            json!("share_access_log")
        );
        assert_eq!(second_page.body["nextCursor"], serde_json::Value::Null);
    })
    .await;
}

#[tokio::test]
async fn team_events_apply_share_other_and_actor_filters() {
    with_api_test_app("audit_team_events_filtering", |app| async move {
        let fixture = build_audit_router_fixture(&app.pool).await;
        seed_audit_event(
            &app.pool,
            "audit_other",
            &fixture.owner_user_id,
            "custom_audit_event",
            Some("team"),
            Some(&fixture.team_id),
            None,
            None,
            None,
            datetime!(2025-05-02 08:00 UTC),
        )
        .await;
        seed_audit_event(
            &app.pool,
            "audit_team",
            &fixture.owner_user_id,
            "team_member_removed",
            Some("team"),
            Some(&fixture.team_id),
            None,
            None,
            None,
            datetime!(2025-05-02 07:00 UTC),
        )
        .await;
        seed_share_access_event(
            &app.pool,
            "share_failed",
            &fixture.share_link_id,
            Some("failed@example.com"),
            None,
            None,
            false,
            Some("expired"),
            datetime!(2025-05-02 06:00 UTC),
        )
        .await;
        seed_share_access_event(
            &app.pool,
            "share_success_other",
            &fixture.share_link_id,
            Some("ok@example.com"),
            None,
            None,
            true,
            None,
            datetime!(2025-05-02 05:00 UTC),
        )
        .await;

        let session = app.issue_session(&fixture.owner_user_id).await;
        let headers = authenticated_json_headers(&session.token);

        let share_failure_response = app
            .api_json(
                Method::GET,
                &format!(
                    "/api/v1/audit-events?actionGroup={}&result={}",
                    "share", "failure"
                ),
                None,
                headers.clone(),
            )
            .await;
        share_failure_response.assert_contract_status();
        assert_eq!(
            share_failure_response.body["events"]
                .as_array()
                .expect("events should be an array")
                .len(),
            1
        );
        assert_eq!(
            share_failure_response.body["events"][0]["id"],
            json!("share_failed")
        );
        assert_eq!(
            share_failure_response.body["events"][0]["result"],
            json!("failure")
        );

        let other_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/audit-events?actionGroup={}", "other"),
                None,
                headers.clone(),
            )
            .await;
        other_response.assert_contract_status();
        assert_eq!(
            other_response.body["events"]
                .as_array()
                .expect("events should be an array")
                .len(),
            1
        );
        assert_eq!(other_response.body["events"][0]["id"], json!("audit_other"));
        assert_eq!(
            other_response.body["events"][0]["actionGroup"],
            json!("other")
        );

        let unknown_actor_response = app
            .api_json(
                Method::GET,
                &format!("/api/v1/audit-events?actorUserId={}", "missing_member"),
                None,
                headers,
            )
            .await;
        unknown_actor_response.assert_contract_status();
        assert_eq!(
            unknown_actor_response.body["events"]
                .as_array()
                .expect("events should be an array")
                .len(),
            0
        );
        assert_eq!(
            unknown_actor_response.body["nextCursor"],
            serde_json::Value::Null
        );
    })
    .await;
}

struct AuditRouterFixture {
    owner_user_id: String,
    member_user_id: String,
    personal_owner_user_id: String,
    inactive_owner_user_id: String,
    no_team_user_id: String,
    team_id: String,
    share_link_id: String,
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

fn assert_handler_error(body: &serde_json::Value, code: &str, message: &str) {
    assert_eq!(body["code"], json!(code));
    assert_eq!(body["detail"], json!(message));
}

fn assert_transport_error(body: &serde_json::Value, code: &str, message: &str) {
    assert_eq!(body["detail"], json!(message));
    assert_eq!(body["code"], json!(code));
}

async fn build_audit_router_fixture(pool: &PgPool) -> AuditRouterFixture {
    let owner_user_id = "audit_owner_user".to_string();
    let member_user_id = "audit_member_user".to_string();
    let personal_owner_user_id = "audit_personal_owner".to_string();
    let inactive_owner_user_id = "audit_inactive_owner".to_string();
    let no_team_user_id = "audit_no_team_user".to_string();
    let team_id = "audit_team_main".to_string();
    let share_link_id = "audit_share_link".to_string();

    seed_user(
        pool,
        &owner_user_id,
        "Audit Owner",
        "audit-owner@example.com",
    )
    .await;
    seed_user(
        pool,
        &member_user_id,
        "Audit Member",
        "audit-member@example.com",
    )
    .await;
    seed_user(
        pool,
        &personal_owner_user_id,
        "Personal Owner",
        "personal-owner@example.com",
    )
    .await;
    seed_user(
        pool,
        &inactive_owner_user_id,
        "Inactive Owner",
        "inactive-owner@example.com",
    )
    .await;
    seed_user(pool, &no_team_user_id, "No Team", "no-team@example.com").await;

    seed_team(
        pool,
        &team_id,
        "Audit Team",
        &owner_user_id,
        "organization",
        "team",
        "active",
    )
    .await;
    assign_user_to_team(pool, &owner_user_id, &team_id, "owner").await;
    assign_user_to_team(pool, &member_user_id, &team_id, "member").await;

    seed_team(
        pool,
        "audit_team_personal",
        "Personal Team",
        &personal_owner_user_id,
        "organization",
        "personal",
        "active",
    )
    .await;
    assign_user_to_team(
        pool,
        &personal_owner_user_id,
        "audit_team_personal",
        "owner",
    )
    .await;

    seed_team(
        pool,
        "audit_team_inactive",
        "Inactive Team",
        &inactive_owner_user_id,
        "organization",
        "team",
        "past_due",
    )
    .await;
    assign_user_to_team(
        pool,
        &inactive_owner_user_id,
        "audit_team_inactive",
        "owner",
    )
    .await;

    let vault_id = "audit_vault".to_string();
    let item_id = "audit_item".to_string();
    seed_vault(
        pool,
        &vault_id,
        "Audit Vault",
        "personal",
        &owner_user_id,
        Some(&team_id),
    )
    .await;
    seed_vault_key(
        pool,
        "audit_vault_key",
        &vault_id,
        &owner_user_id,
        "encrypted-vault-key",
        "owner",
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
    seed_share_link(pool, &share_link_id, &item_id, &owner_user_id).await;

    AuditRouterFixture {
        owner_user_id,
        member_user_id,
        personal_owner_user_id,
        inactive_owner_user_id,
        no_team_user_id,
        team_id,
        share_link_id,
    }
}

async fn seed_share_link(pool: &PgPool, share_link_id: &str, item_id: &str, user_id: &str) {
    query(
			"INSERT INTO share_link (id, item_id, created_by_id, token_hash, access_mode, is_one_time_use, encrypted_item_data, encryption_iv, encrypted_share_key, share_key_iv, max_access_count, expires_at) VALUES ($1, $2, $3, $4, 'anyone', false, $5, $6, $7, $8, NULL, $9)",
		)
		.bind(share_link_id)
		.bind(item_id)
		.bind(user_id)
		.bind(hash_token("audit-share-token"))
		.bind("encrypted-item-data")
		.bind("item-iv")
		.bind("encrypted-share-key")
		.bind("share-key-iv")
		.bind(datetime!(2030-01-01 0:00 UTC))
		.execute(pool)
		.await
		.expect("share link should seed");
}

#[allow(clippy::too_many_arguments)]
async fn seed_audit_event(
    pool: &PgPool,
    event_id: &str,
    user_id: &str,
    action: &str,
    entity_type: Option<&str>,
    entity_id: Option<&str>,
    metadata: Option<&str>,
    ip_address: Option<&str>,
    user_agent: Option<&str>,
    created_at: OffsetDateTime,
) {
    query(
			"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, ip_address, user_agent, metadata, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
		)
		.bind(event_id)
		.bind(user_id)
		.bind(action)
		.bind(entity_type)
		.bind(entity_id)
		.bind(ip_address)
		.bind(user_agent)
		.bind(metadata)
		.bind(created_at)
		.execute(pool)
		.await
		.expect("audit event should seed");
}

#[allow(clippy::too_many_arguments)]
async fn seed_share_access_event(
    pool: &PgPool,
    event_id: &str,
    share_link_id: &str,
    accessed_by_email: Option<&str>,
    ip_address: Option<&str>,
    user_agent: Option<&str>,
    success: bool,
    failure_reason: Option<&str>,
    accessed_at: OffsetDateTime,
) {
    query(
			"INSERT INTO share_access_log (id, share_link_id, accessed_by_email, ip_address, user_agent, success, failure_reason, accessed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
		)
		.bind(event_id)
		.bind(share_link_id)
		.bind(accessed_by_email)
		.bind(ip_address)
		.bind(user_agent)
		.bind(success)
		.bind(failure_reason)
		.bind(accessed_at)
		.execute(pool)
		.await
		.expect("share access event should seed");
}
