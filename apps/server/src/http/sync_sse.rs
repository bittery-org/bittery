use std::{convert::Infallible, time::Duration};

use async_stream::stream;
use axum::{
    extract::State,
    http::StatusCode,
    response::{
        sse::{Event, Sse},
        IntoResponse as AxumIntoResponse, Response as AxumResponse,
    },
    routing::get,
    Extension, Json, Router as AxumRouter,
};
use serde_json::json;
use time::OffsetDateTime;
use tokio::sync::broadcast;
use tokio::time::sleep;
use tracing::warn;

use crate::{
    repo::sync::{
        fetch_latest_visible_event_seq, fetch_user_vault_ids, fetch_visible_events_since,
    },
    services::session::VerifiedSession,
    services::session_control::load_session_revocation,
    services::sync::{
        generate_sync_connection_id, sse_heartbeat_event, sse_json_event, sync_stream_event_dto,
        timestamp_millis, SessionControlPayload, DEFAULT_EVENTS_LIMIT,
        SYNC_STREAM_HEARTBEAT_INTERVAL_MS, SYNC_STREAM_POLL_INTERVAL_MS,
    },
    AppState,
};

pub fn create_sync_http_router() -> AxumRouter<AppState> {
    AxumRouter::new()
        .route("/events", get(sync_events))
        .route("/health", get(sync_health))
}

async fn sync_health() -> Json<serde_json::Value> {
    Json(json!({ "status": "ok" }))
}

async fn sync_events(
    State(state): State<AppState>,
    session: Option<Extension<VerifiedSession>>,
) -> AxumResponse {
    let Some(Extension(session)) = session else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Unauthorized" })),
        )
            .into_response();
    };
    let Some(pool) = state.db_pool.clone() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "Sync unavailable" })),
        )
            .into_response();
    };

    let initial_vault_ids = match fetch_user_vault_ids(&pool, &session.user_id).await {
        Ok(vault_ids) => vault_ids,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error.message })),
            )
                .into_response();
        }
    };
    let initial_seq =
        match fetch_latest_visible_event_seq(&pool, &session.user_id, &initial_vault_ids).await {
            Ok(seq) => seq,
            Err(error) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": error.message })),
                )
                    .into_response();
            }
        };

    let sessions = state.sessions.clone();
    let sync_control = state.sync_control.clone();
    let sync_notify = state.sync_notify.clone();
    let session_user_id = session.user_id.clone();
    let session_id = session.session_id.clone();
    let session_token = session.token.clone();
    let connection_id = generate_sync_connection_id();
    let poll_interval = Duration::from_millis(SYNC_STREAM_POLL_INTERVAL_MS);
    let heartbeat_interval = Duration::from_millis(SYNC_STREAM_HEARTBEAT_INTERVAL_MS);

    let stream = stream! {
        let mut last_seen_seq = initial_seq;
        let mut last_heartbeat_at = std::time::Instant::now();
        let mut control_rx = sync_control.subscribe();

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
                return;
            }
        }

        'outer: loop {
            loop {
                match control_rx.try_recv() {
                    Ok(payload) => {
                        if payload.user_id == session_user_id && payload.session_id == session_id {
                            match sse_json_event("control", &payload) {
                                Ok(event) => yield Ok(event),
                                Err(error) => {
                                    warn!(error = %error.message, "failed to encode session control payload");
                                }
                            }
                            break 'outer;
                        }
                    }
                    Err(broadcast::error::TryRecvError::Empty) => break,
                    Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                    Err(broadcast::error::TryRecvError::Closed) => break,
                }
            }

            match load_session_revocation(&pool, &session_user_id, &session_id).await {
                Ok(Some(revocation)) => {
                    let payload = SessionControlPayload {
                        control_type: "session_revoked".to_string(),
                        user_id: session_user_id.clone(),
                        session_id: session_id.clone(),
                        timestamp: revocation.timestamp,
                        reason: revocation.reason,
                    };
                    match sse_json_event("control", &payload) {
                        Ok(event) => yield Ok(event),
                        Err(error) => {
                            warn!(error = %error.message, "failed to encode persisted session control payload");
                        }
                    }
                    break 'outer;
                }
                Ok(None) => {}
                Err(error) => {
                    warn!(user_id = %session_user_id, error = %error, "failed to load persisted session control payload");
                    break 'outer;
                }
            }

            if sessions.verify_token(&session_token).await.is_none() {
                break;
            }

            let target_vault_ids = match fetch_user_vault_ids(&pool, &session_user_id).await {
                Ok(vault_ids) => vault_ids,
                Err(error) => {
                    warn!(user_id = %session_user_id, error = %error.message, "failed to refresh sync vault access");
                    break;
                }
            };
            let events = match fetch_visible_events_since(
                &pool,
                &session_user_id,
                &target_vault_ids,
                last_seen_seq,
                DEFAULT_EVENTS_LIMIT,
            )
            .await {
                Ok(events) => events,
                Err(error) => {
                    warn!(user_id = %session_user_id, error = %error.message, "failed to poll sync events");
                    break;
                }
            };

            let has_more = events.len() > DEFAULT_EVENTS_LIMIT as usize;
            let result_events = if has_more {
                events.into_iter().take(DEFAULT_EVENTS_LIMIT as usize).collect::<Vec<_>>()
            } else {
                events
            };

            if !result_events.is_empty() {
                for event in result_events {
                    let next_seq = event.seq;
                    let payload = match sync_stream_event_dto(event, &session_user_id) {
                        Ok(payload) => payload,
                        Err(error) => {
                            warn!(user_id = %session_user_id, error = %error.message, "failed to decode sync event payload");
                            break 'outer;
                        }
                    };

                    match sse_json_event("sync", &payload) {
                        Ok(sse_event) => {
                            last_seen_seq = next_seq;
                            yield Ok(sse_event);
                        }
                        Err(error) => {
                            warn!(user_id = %session_user_id, error = %error.message, "failed to encode sync stream event");
                            break 'outer;
                        }
                    }
                }

                if has_more {
                    continue;
                }
            }

            if last_heartbeat_at.elapsed() >= heartbeat_interval {
                match sse_heartbeat_event() {
                    Ok(event) => yield Ok(event),
                    Err(error) => {
                        warn!(user_id = %session_user_id, error = %error.message, "failed to encode sync heartbeat");
                        break;
                    }
                }
                last_heartbeat_at = std::time::Instant::now();
            }

            tokio::select! {
                control = control_rx.recv() => {
                    match control {
                        Ok(payload) => {
                            if payload.user_id == session_user_id && payload.session_id == session_id {
                                match sse_json_event("control", &payload) {
                                    Ok(event) => yield Ok(event),
                                    Err(error) => {
                                        warn!(error = %error.message, "failed to encode session control payload");
                                    }
                                }
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => {}
                    }
                }
                _ = sync_notify.notified() => {}
                _ = sleep(poll_interval) => {}
            }
        }
    };

    Sse::new(stream).into_response()
}
