use std::{convert::Infallible, time::Duration};

use async_stream::stream;
use axum::{
    extract::State,
    response::{
        sse::{Event, Sse},
        IntoResponse as AxumIntoResponse, Response as AxumResponse,
    },
    Extension,
};
use serde_json::json;
use time::OffsetDateTime;
use tokio::sync::broadcast;
use tracing::warn;

use crate::{
    http::api::{error::ApiError, error_code::ErrorCode},
    services::connection_registry::{resolve_connection_limit, ConnectionGuard},
    services::session::VerifiedSession,
    services::session_control::load_session_revocation,
    services::sync::{
        generate_sync_connection_id, sse_heartbeat_event, sse_json_event, timestamp_millis,
        SYNC_STREAM_HEARTBEAT_INTERVAL_MS,
    },
    services::sync_pubsub::SyncNotification,
    AppState,
};

/// Interval for refreshing the Redis connection TTL (60s).
const CONN_TTL_REFRESH_INTERVAL_MS: u64 = 60_000;

pub(crate) async fn sync_events(
    State(state): State<AppState>,
    session: Option<Extension<VerifiedSession>>,
) -> AxumResponse {
    let Some(Extension(session)) = session else {
        return ApiError::unauthorized("A valid bearer session is required.").into_response();
    };
    let Some(ref pool) = state.db_pool else {
        return ApiError::service_unavailable(
            ErrorCode::ServiceUnavailable,
            "Sync is temporarily unavailable.",
        )
        .into_response();
    };

    // Determine device identity for connection tracking
    let device_id = session
        .client_id
        .clone()
        .unwrap_or_else(|| session.session_id.clone());

    // Enforce per-plan connection limit via Redis (if available)
    if state.connection_registry.is_active() {
        let plan_limit = resolve_connection_limit(&state.redis, pool, &session.user_id).await;

        match state
            .connection_registry
            .try_register(&session.user_id, &device_id, &state.instance_id, plan_limit)
            .await
        {
            Ok(true) => { /* registered successfully */ }
            Ok(false) => {
                let user_id = session.user_id.clone();
                let rejection_stream = stream! {
                    match sse_json_event("limit_exceeded", &json!({
                        "type": "limit_exceeded",
                        "userId": user_id,
                        "limit": plan_limit,
                        "timestamp": timestamp_millis(OffsetDateTime::now_utc()),
                    })) {
                        Ok(event) => yield Ok::<Event, Infallible>(event),
                        Err(error) => {
                            warn!(error = %error.message, "failed to encode limit_exceeded event");
                        }
                    }
                };
                return Sse::new(rejection_stream).into_response();
            }
            Err(error) => {
                warn!(error = %error, "Redis connection registry error, allowing connection");
            }
        }
    }

    // Create connection guard that unregisters on drop
    let _connection_guard = if state.connection_registry.is_active() {
        Some(ConnectionGuard::new(
            state.connection_registry.clone(),
            session.user_id.clone(),
            device_id.clone(),
        ))
    } else {
        None
    };

    // Check for persisted session revocation before establishing stream
    match load_session_revocation(pool, &session.user_id, &session.session_id).await {
        Ok(Some(revocation)) => {
            let rejection_stream = stream! {
                match sse_json_event("session_revoked", &json!({
                    "session_id": session.session_id,
                    "reason": revocation.reason,
                    "timestamp": revocation.timestamp,
                })) {
                    Ok(event) => yield Ok::<Event, Infallible>(event),
                    Err(error) => {
                        warn!(error = %error.message, "failed to encode session_revoked event");
                    }
                }
            };
            return Sse::new(rejection_stream).into_response();
        }
        Ok(None) => {}
        Err(error) => {
            warn!(user_id = %session.user_id, error = %error, "failed to check session revocation");
        }
    }

    // Subscribe to notifications
    let (mut sync_rx, mut control_rx) = state.sync_pubsub.subscribe(&session.user_id).await;

    let sync_pubsub = state.sync_pubsub.clone();
    let connection_registry = state.connection_registry.clone();
    let sessions = state.sessions.clone();
    let session_user_id = session.user_id.clone();
    let session_id = session.session_id.clone();
    let session_token = session.token.clone();
    let connection_id = generate_sync_connection_id();
    let heartbeat_interval = Duration::from_millis(SYNC_STREAM_HEARTBEAT_INTERVAL_MS);
    let ttl_refresh_interval = Duration::from_millis(CONN_TTL_REFRESH_INTERVAL_MS);

    let stream = stream! {
        // Move connection guard into the stream so it's dropped when the stream ends
        let _guard = _connection_guard;

        let mut last_heartbeat_at = std::time::Instant::now();
        let mut last_ttl_refresh_at = std::time::Instant::now();

        // Send connected event
        match sse_json_event(
            "connected",
            &json!({
                "type": "connected",
                "userId": session_user_id,
                "connectionId": connection_id,
                "timestamp": timestamp_millis(OffsetDateTime::now_utc()),
            }),
        ) {
            Ok(event) => yield Ok::<Event, Infallible>(event),
            Err(error) => {
                warn!(error = %error.message, "failed to initialize sync event stream");
                sync_pubsub.unsubscribe(&session_user_id).await;
                return;
            }
        }

        loop {
            // Heartbeat
            if last_heartbeat_at.elapsed() >= heartbeat_interval {
                // Verify session is still valid
                if sessions.verify_token(&session_token).await.is_none() {
                    break;
                }

                match sse_heartbeat_event() {
                    Ok(event) => yield Ok(event),
                    Err(error) => {
                        warn!(error = %error.message, "failed to encode heartbeat");
                        break;
                    }
                }
                last_heartbeat_at = std::time::Instant::now();
            }

            // Redis connection TTL refresh
            if connection_registry.is_active() && last_ttl_refresh_at.elapsed() >= ttl_refresh_interval {
                connection_registry.refresh_ttl(&session_user_id).await;
                last_ttl_refresh_at = std::time::Instant::now();
            }

            // Wait for a notification or heartbeat timeout
            tokio::select! {
                result = sync_rx.recv() => {
                    match result {
                        Ok(()) => {
                            // Something changed — tell client to fetch
                            match sse_json_event("sync", &json!({
                                "timestamp": timestamp_millis(OffsetDateTime::now_utc()),
                            })) {
                                Ok(event) => yield Ok(event),
                                Err(error) => {
                                    warn!(error = %error.message, "failed to encode sync ping");
                                    break;
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            // Missed some notifications — just send one sync ping
                            match sse_json_event("sync", &json!({
                                "timestamp": timestamp_millis(OffsetDateTime::now_utc()),
                            })) {
                                Ok(event) => yield Ok(event),
                                Err(error) => {
                                    warn!(error = %error.message, "failed to encode sync ping");
                                    break;
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                result = control_rx.recv() => {
                    match result {
                        Ok(SyncNotification::SessionRevoked { session_id: revoked_id, reason }) => {
                            if revoked_id == session_id {
                                match sse_json_event("session_revoked", &json!({
                                    "session_id": revoked_id,
                                    "reason": reason,
                                    "timestamp": timestamp_millis(OffsetDateTime::now_utc()),
                                })) {
                                    Ok(event) => yield Ok(event),
                                    Err(error) => {
                                        warn!(error = %error.message, "failed to encode session_revoked");
                                    }
                                }
                                break;
                            }
                        }
                        Ok(SyncNotification::Sync) => {
                            // Shouldn't arrive on control channel, but handle gracefully
                            match sse_json_event("sync", &json!({
                                "timestamp": timestamp_millis(OffsetDateTime::now_utc()),
                            })) {
                                Ok(event) => yield Ok(event),
                                Err(_) => break,
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
                _ = tokio::time::sleep(heartbeat_interval) => {
                    // Heartbeat timeout — loop back to top for heartbeat/TTL handling
                }
            }
        }

        // Cleanup
        sync_pubsub.unsubscribe(&session_user_id).await;
    };

    Sse::new(stream).into_response()
}

#[cfg(test)]
mod tests {
    use axum::{
        body::to_bytes,
        extract::State,
        http::{header::CONTENT_TYPE, StatusCode},
        Extension,
    };
    use serde_json::Value;
    use time::OffsetDateTime;

    use crate::{services::session::VerifiedSession, AppState};

    use super::sync_events;

    async fn assert_problem(response: axum::response::Response, status: StatusCode, code: &str) {
        assert_eq!(response.status(), status);
        assert_eq!(
            response.headers().get(CONTENT_TYPE).unwrap(),
            "application/problem+json"
        );
        let request_id = response
            .headers()
            .get("bittery-request-id")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let body: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("problem body should be readable"),
        )
        .expect("problem body should be JSON");
        assert_eq!(body["status"], status.as_u16());
        assert_eq!(body["code"], code);
        assert_eq!(body["requestId"], request_id);
    }

    #[tokio::test]
    async fn missing_session_uses_problem_details() {
        let response = sync_events(State(AppState::default()), None).await;

        assert_problem(response, StatusCode::UNAUTHORIZED, "UNAUTHORIZED").await;
    }

    #[tokio::test]
    async fn unavailable_sync_service_uses_retryable_problem_details() {
        let session = VerifiedSession {
            token: "test-token".to_string(),
            session_id: "test-session".to_string(),
            user_id: "test-user".to_string(),
            expires_at: OffsetDateTime::now_utc(),
            platform: "test".to_string(),
            client_id: None,
        };

        let response = sync_events(State(AppState::default()), Some(Extension(session))).await;

        assert_eq!(response.headers().get("retry-after").unwrap(), "1");
        assert_problem(
            response,
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
        )
        .await;
    }
}
