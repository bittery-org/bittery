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
use rand::random;
use qubit::{
	builder::IntoResponse,
	handler,
	server::{ErrorCode, Router, RpcError},
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{query, query_as, PgPool};
use time::OffsetDateTime;
use tokio::{sync::broadcast, time::sleep};
use ts_rs::TS;
use tracing::warn;

use crate::{
	auth::{RefreshSessionContext, VerifiedSession},
	db::models::*,
	session_control::load_session_revocation,
	storage, AppState,
};

#[derive(Debug, Clone, Serialize, TS)]
pub struct SyncRpcError {
	pub code: String,
	pub message: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CheckConflictInput {
	pub item_id: String,
	pub expected_version: i32,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GetEventsSinceInput {
	pub since_id: Option<String>,
	pub vault_ids: Option<Vec<String>>,
	pub limit: Option<i32>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct AcknowledgeEventsInput {
	pub event_ids: Vec<String>,
	pub client_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GetLastAcknowledgedInput {
	pub client_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GetSyncStateInput {
	pub vault_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BootstrapItemsInput {
	pub cursor: Option<String>,
	pub limit: Option<i32>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CheckConflictResponse {
	pub has_conflict: bool,
	pub current_version: Option<i32>,
	pub last_modified_by: Option<String>,
	pub last_modified_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeEventsResponse {
	pub acknowledged: i32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct LastAcknowledgedResponse {
	pub event_id: String,
	pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateEntry {
	pub latest_event_id: Option<String>,
	pub latest_timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyncEventDto {
	pub id: String,
	#[serde(rename = "type")]
	pub event_type: String,
	pub entity_id: String,
	pub entity_type: String,
	pub vault_id: Option<String>,
	pub version: i32,
	pub client_id: Option<String>,
	pub user_id: String,
	pub metadata: Option<serde_json::Value>,
	pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SyncCursorResponse {
	pub id: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GetEventsSinceResponse {
	pub events: Vec<SyncEventDto>,
	pub cursor: Option<SyncCursorResponse>,
	pub has_more: bool,
	pub requires_full_refresh: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapVaultSummary {
	pub id: String,
	pub name: String,
	pub vault_type: String,
	pub icon: Option<String>,
	pub image_url: Option<String>,
	pub encrypted_vault_key: String,
	pub role: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapAttachmentResponse {
	pub id: String,
	pub item_id: String,
	pub vault_id: String,
	pub storage_key: String,
	pub encrypted_name: String,
	pub encrypted_content_type: String,
	pub encryption_iv: String,
	pub encrypted_content_type_iv: Option<String>,
	pub encryption_algorithm: String,
	pub file_size: i32,
	pub uploaded_by: Option<String>,
	pub created_at: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapItemResponse {
	pub id: String,
	pub vault_id: String,
	pub category: String,
	pub favorite: bool,
	pub encrypted_data: String,
	pub encryption_iv: String,
	pub encryption_algorithm: String,
	pub version: i32,
	pub last_modified_by: Option<String>,
	pub created_at: String,
	pub updated_at: String,
	pub deleted_at: Option<String>,
	pub attachments: Vec<BootstrapAttachmentResponse>,
	pub vault: Option<BootstrapVaultSummary>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapItemsResponse {
	pub items: Vec<BootstrapItemResponse>,
	pub next_cursor: Option<String>,
	pub has_more: bool,
}

const DEFAULT_EVENTS_LIMIT: i32 = 100;
const DEFAULT_BOOTSTRAP_LIMIT: i32 = 500;
const SYNC_STREAM_POLL_INTERVAL_MS: u64 = 2_000;
const SYNC_STREAM_HEARTBEAT_INTERVAL_MS: u64 = 15_000;
const SYNC_CONTROL_CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionControlPayload {
	#[serde(rename = "type")]
	pub control_type: String,
	pub user_id: String,
	pub session_id: String,
	pub timestamp: i64,
	pub reason: Option<String>,
}

impl SessionControlPayload {
	fn session_revoked(user_id: &str, session_id: &str, reason: Option<&str>) -> Self {
		Self {
			control_type: "session_revoked".to_string(),
			user_id: user_id.to_string(),
			session_id: session_id.to_string(),
			timestamp: timestamp_millis(OffsetDateTime::now_utc()),
			reason: reason.map(ToOwned::to_owned),
		}
	}
}

#[derive(Clone)]
pub struct SyncControlBroker {
	sender: broadcast::Sender<SessionControlPayload>,
}

impl Default for SyncControlBroker {
	fn default() -> Self {
		let (sender, _) = broadcast::channel(SYNC_CONTROL_CHANNEL_CAPACITY);
		Self { sender }
	}
}

impl SyncControlBroker {
	pub fn subscribe(&self) -> broadcast::Receiver<SessionControlPayload> {
		self.sender.subscribe()
	}

	pub fn publish_session_revoked(&self, user_id: &str, session_id: &str, reason: &str) {
		let _ = self.sender.send(SessionControlPayload::session_revoked(
			user_id,
			session_id,
			Some(reason),
		));
	}
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn checkConflict(
	ctx: RefreshSessionContext,
	input: CheckConflictInput,
) -> Result<CheckConflictResponse, SyncRpcError> {
	validate_resource_id(&input.item_id)?;

	let pool = db_pool(&ctx.app_state)?;
	let accessible_item = load_scoped_item_access(pool, &ctx.session.user_id, &input.item_id)
		.await?
		.ok_or_else(|| not_found_error("Item not found"))?;

	let latest_item_event = query_as::<_, DbSyncConflictRow>(
		"SELECT version, user_id, created_at FROM sync_event WHERE entity_id = $1 AND entity_type = 'item'::sync_entity_type AND vault_id = $2 ORDER BY created_at DESC LIMIT 1",
	)
	.bind(&input.item_id)
	.bind(&accessible_item.vault_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load latest sync event"); internal_error("Failed to load latest sync event") })?;

	let Some(latest_item_event) = latest_item_event else {
		return Ok(CheckConflictResponse {
			has_conflict: false,
			current_version: None,
			last_modified_by: None,
			last_modified_at: None,
		});
	};

	Ok(CheckConflictResponse {
		has_conflict: latest_item_event.version > input.expected_version,
		current_version: Some(latest_item_event.version),
		last_modified_by: Some(latest_item_event.user_id),
		last_modified_at: Some(timestamp_millis(latest_item_event.created_at)),
	})
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getEventsSince(
	ctx: RefreshSessionContext,
	input: GetEventsSinceInput,
) -> Result<GetEventsSinceResponse, SyncRpcError> {
	if let Some(since_id) = &input.since_id {
		validate_resource_id(since_id)?;
	}
	if let Some(vault_ids) = &input.vault_ids {
		if vault_ids.len() > 200 {
			return Err(bad_request_error("Invalid params"));
		}
		for vault_id in vault_ids {
			validate_resource_id(vault_id)?;
		}
	}
	let limit = input.limit.unwrap_or(DEFAULT_EVENTS_LIMIT);
	if !(1..=1000).contains(&limit) {
		return Err(bad_request_error("Invalid params"));
	}

	let pool = db_pool(&ctx.app_state)?;
	let user_vault_ids = fetch_user_vault_ids(pool, &ctx.session.user_id).await?;
	let target_vault_ids = match input.vault_ids {
		Some(vault_ids) => vault_ids
			.into_iter()
			.filter(|vault_id| user_vault_ids.contains(vault_id))
			.collect::<Vec<_>>(),
		None => user_vault_ids,
	};

	let cursor_seq = match input.since_id.as_deref() {
		Some(since_id) => {
			let cursor_event = fetch_visible_cursor_event(pool, &ctx.session.user_id, &target_vault_ids, since_id)
				.await?;
			let Some(cursor_event) = cursor_event else {
				let latest_visible_event_id =
					fetch_latest_visible_event_id(pool, &ctx.session.user_id, &target_vault_ids).await?;
				return Ok(GetEventsSinceResponse {
					events: Vec::new(),
					cursor: latest_visible_event_id.map(|id| SyncCursorResponse { id }),
					has_more: false,
					requires_full_refresh: true,
				});
			};
			cursor_event.seq
		}
		None => 0,
	};

	let events = fetch_visible_events_since(
		pool,
		&ctx.session.user_id,
		&target_vault_ids,
		cursor_seq,
		limit,
	)
	.await?;
	let has_more = events.len() > limit as usize;
	let result_events = if has_more {
		events.into_iter().take(limit as usize).collect::<Vec<_>>()
	} else {
		events
	};
	let cursor = result_events
		.last()
		.map(|event| SyncCursorResponse { id: event.id.clone() });
	let mapped_events = result_events
		.into_iter()
		.map(sync_event_dto)
		.collect::<Result<Vec<_>, _>>()?;

	Ok(GetEventsSinceResponse {
		events: mapped_events,
		cursor,
		has_more: has_more,
		requires_full_refresh: false,
	})
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn bootstrapItems(
	ctx: RefreshSessionContext,
	input: BootstrapItemsInput,
) -> Result<BootstrapItemsResponse, SyncRpcError> {
	if let Some(cursor) = &input.cursor {
		validate_resource_id(cursor)?;
	}
	let limit = input.limit.unwrap_or(DEFAULT_BOOTSTRAP_LIMIT);
	if !(1..=1000).contains(&limit) {
		return Err(bad_request_error("Invalid params"));
	}

	let pool = db_pool(&ctx.app_state)?;
	let attachments_enabled = attachments_enabled_for_user(pool, &ctx.session.user_id).await?;
	let user_vaults = query_as::<_, DbBootstrapVaultAccessRow>(
		"SELECT vk.vault_id, v.name AS vault_name, v.type::text AS vault_type, v.icon AS vault_icon, v.image_key AS vault_image_key, vk.encrypted_vault_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 ORDER BY vk.created_at ASC",
	)
	.bind(&ctx.session.user_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user vaults"); internal_error("Failed to load user vaults") })?;
	if user_vaults.is_empty() {
		return Ok(BootstrapItemsResponse {
			items: Vec::new(),
			next_cursor: None,
			has_more: false,
		});
	}

	let vault_ids: Vec<String> = user_vaults.iter().map(|vault| vault.vault_id.clone()).collect();
	let paged_items = fetch_bootstrap_items(pool, &vault_ids, input.cursor.as_deref(), limit).await?;
	let has_more = paged_items.len() > limit as usize;
	let result_items = if has_more {
		paged_items.into_iter().take(limit as usize).collect::<Vec<_>>()
	} else {
		paged_items
	};
	let next_cursor = result_items.last().map(|item| item.id.clone());

	let attachments_by_item = if attachments_enabled && !result_items.is_empty() {
		load_bootstrap_attachments(pool, &result_items).await?
	} else {
		std::collections::HashMap::new()
	};
	let vault_map: std::collections::HashMap<String, BootstrapVaultSummary> = user_vaults
		.into_iter()
		.map(|vault| {
			(
				vault.vault_id.clone(),
				BootstrapVaultSummary {
					id: vault.vault_id,
					name: vault.vault_name,
					vault_type: vault.vault_type,
					icon: vault.vault_icon,
					image_url: vault
						.vault_image_key
						.as_deref()
						.and_then(storage::public_asset_url),
					encrypted_vault_key: vault.encrypted_vault_key,
					role: vault.role,
				},
			)
		})
		.collect();

	Ok(BootstrapItemsResponse {
		items: result_items
			.into_iter()
			.map(|item| BootstrapItemResponse {
				id: item.id.clone(),
				vault_id: item.vault_id.clone(),
				category: item.category,
				favorite: item.favorite,
				encrypted_data: item.encrypted_data,
				encryption_iv: item.encryption_iv,
				encryption_algorithm: item.encryption_algorithm,
				version: item.version,
				last_modified_by: item.last_modified_by,
				created_at: format_timestamp(item.created_at),
				updated_at: format_timestamp(item.updated_at),
				deleted_at: item.deleted_at.map(format_timestamp),
				attachments: attachments_by_item.get(&item.id).cloned().unwrap_or_default(),
				vault: vault_map.get(&item.vault_id).cloned(),
			})
			.collect(),
		next_cursor,
		has_more,
	})
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn acknowledgeEvents(
	ctx: RefreshSessionContext,
	input: AcknowledgeEventsInput,
) -> Result<AcknowledgeEventsResponse, SyncRpcError> {
	validate_client_id(&input.client_id)?;
	if input.event_ids.len() > 500 {
		return Err(bad_request_error("Invalid params"));
	}
	for event_id in &input.event_ids {
		validate_resource_id(event_id)?;
	}
	if input.event_ids.is_empty() {
		return Ok(AcknowledgeEventsResponse { acknowledged: 0 });
	}

	let pool = db_pool(&ctx.app_state)?;
	let events = query_as::<_, DbSyncEventVaultRow>(
		"SELECT id, vault_id FROM sync_event WHERE id = ANY($1)",
	)
	.bind(&input.event_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load sync events"); internal_error("Failed to load sync events") })?;
	let user_vaults = query_as::<_, DbVaultAccessRow>(
		"SELECT vault_id FROM vault_key WHERE user_id = $1",
	)
	.bind(&ctx.session.user_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault access"); internal_error("Failed to load vault access") })?;
	let accessible_vault_ids: std::collections::HashSet<String> = user_vaults
		.into_iter()
		.map(|record| record.vault_id)
		.collect();

	let accessible_event_ids: Vec<String> = events
		.into_iter()
		.filter(|event| {
			event
				.vault_id
				.as_ref()
				.map(|vault_id| accessible_vault_ids.contains(vault_id))
				.unwrap_or(false)
		})
		.map(|event| event.id)
		.collect();

	for event_id in &accessible_event_ids {
		query(
			"INSERT INTO sync_event_ack (id, event_id, user_id, client_id) VALUES ($1, $2, $3, $4)",
		)
		.bind(generate_sync_ack_id())
		.bind(event_id)
		.bind(&ctx.session.user_id)
		.bind(&input.client_id)
		.execute(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to acknowledge sync event"); internal_error("Failed to acknowledge sync event") })?;
	}

	Ok(AcknowledgeEventsResponse {
		acknowledged: accessible_event_ids.len() as i32,
	})
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getLastAcknowledged(
	ctx: RefreshSessionContext,
	input: GetLastAcknowledgedInput,
) -> Result<Option<LastAcknowledgedResponse>, SyncRpcError> {
	validate_client_id(&input.client_id)?;

	let pool = db_pool(&ctx.app_state)?;
	let last_ack = query_as::<_, DbLastAcknowledgedRow>(
		"SELECT sea.event_id, se.created_at FROM sync_event_ack sea INNER JOIN sync_event se ON sea.event_id = se.id WHERE sea.user_id = $1 AND sea.client_id = $2 ORDER BY sea.acknowledged_at DESC LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.bind(&input.client_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load last acknowledged event"); internal_error("Failed to load last acknowledged event") })?;

	Ok(last_ack.map(|ack| LastAcknowledgedResponse {
		event_id: ack.event_id,
		timestamp: timestamp_millis(ack.created_at),
	}))
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getSyncState(
	ctx: RefreshSessionContext,
	input: GetSyncStateInput,
) -> Result<std::collections::BTreeMap<String, SyncStateEntry>, SyncRpcError> {
	if input.vault_ids.len() > 200 {
		return Err(bad_request_error("Invalid params"));
	}
	for vault_id in &input.vault_ids {
		validate_resource_id(vault_id)?;
	}

	let pool = db_pool(&ctx.app_state)?;
	let accessible_vaults = query_as::<_, DbVaultAccessRow>(
		"SELECT vault_id FROM vault_key WHERE user_id = $1 AND vault_id = ANY($2)",
	)
	.bind(&ctx.session.user_id)
	.bind(&input.vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load accessible vaults"); internal_error("Failed to load accessible vaults") })?;

	let mut states = std::collections::BTreeMap::new();
	for vault_access in accessible_vaults {
		let latest_event = query_as::<_, DbSyncStateEventRow>(
			"SELECT id, created_at FROM sync_event WHERE vault_id = $1 ORDER BY created_at DESC LIMIT 1",
		)
		.bind(&vault_access.vault_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load latest sync state event"); internal_error("Failed to load latest sync state event") })?;

		states.insert(
			vault_access.vault_id,
			SyncStateEntry {
				latest_event_id: latest_event.as_ref().map(|event| event.id.clone()),
				latest_timestamp: latest_event.map(|event| timestamp_millis(event.created_at)),
			},
		);
	}

	Ok(states)
}

pub fn create_sync_router() -> Router<AppState> {
	Router::new()
		.handler(bootstrapItems)
		.handler(getEventsSince)
		.handler(acknowledgeEvents)
		.handler(getLastAcknowledged)
		.handler(getSyncState)
		.handler(checkConflict)
}

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
		return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorized" }))).into_response();
	};
	let Some(pool) = state.db_pool.clone() else {
		return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": "Sync unavailable" }))).into_response();
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
	let initial_seq = match fetch_latest_visible_event_seq(&pool, &session.user_id, &initial_vault_ids).await {
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
				_ = sleep(poll_interval) => {}
			}
		}
	};

	Sse::new(stream).into_response()
}

fn db_pool(app_state: &AppState) -> Result<&PgPool, SyncRpcError> {
	app_state
		.db_pool
		.as_ref()
		.ok_or_else(|| internal_error("Database is not configured"))
}

async fn fetch_user_vault_ids(pool: &PgPool, user_id: &str) -> Result<Vec<String>, SyncRpcError> {
	let user_vaults = query_as::<_, DbVaultAccessRow>(
		"SELECT vault_id FROM vault_key WHERE user_id = $1",
	)
	.bind(user_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault access"); internal_error("Failed to load vault access") })?;

	Ok(user_vaults.into_iter().map(|record| record.vault_id).collect())
}

async fn load_scoped_item_access(
	pool: &PgPool,
	actor_user_id: &str,
	item_id: &str,
) -> Result<Option<DbScopedItemAccessRow>, SyncRpcError> {
	query_as::<_, DbScopedItemAccessRow>(
		"SELECT i.id AS item_id, i.vault_id, vk.role::text AS role FROM item i INNER JOIN vault_key vk ON vk.vault_id = i.vault_id AND vk.user_id = $1 WHERE i.id = $2 LIMIT 1",
	)
	.bind(actor_user_id)
	.bind(item_id)
	.fetch_optional(pool)
	.await
	.map_err(|_| internal_error("Failed to load scoped item access"))
}

fn timestamp_millis(value: OffsetDateTime) -> i64 {
	(value.unix_timestamp_nanos() / 1_000_000) as i64
}

fn validate_client_id(client_id: &str) -> Result<(), SyncRpcError> {
	let regex = Regex::new(r"^[A-Za-z0-9_-]{1,64}$").expect("client id regex should be valid");
	if regex.is_match(client_id) {
		Ok(())
	} else {
		Err(bad_request_error("Invalid client ID"))
	}
}

fn validate_resource_id(value: &str) -> Result<(), SyncRpcError> {
	let regex = Regex::new(
		r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[A-Za-z0-9_-]{10,64})$",
	)
	.expect("resource id regex should be valid");
	if value.len() <= 64 && regex.is_match(value) {
		Ok(())
	} else {
		Err(bad_request_error("Invalid resource ID"))
	}
}

fn generate_sync_ack_id() -> String {
	format!("syncack_{:016x}", random::<u64>())
}

fn generate_sync_connection_id() -> String {
	format!("{}-{:016x}", timestamp_millis(OffsetDateTime::now_utc()), random::<u64>())
}

fn sync_event_dto(event: DbSyncEventRow) -> Result<SyncEventDto, SyncRpcError> {
	let metadata = match event.metadata {
		Some(value) => Some(
			serde_json::from_str::<serde_json::Value>(&value)
				.map_err(|e| { tracing::error!(error = %e, "Failed to parse sync event metadata"); internal_error("Failed to parse sync event metadata") })?,
		),
		None => None,
	};

	Ok(SyncEventDto {
		id: event.id,
		event_type: event.event_type,
		entity_id: event.entity_id,
		entity_type: event.entity_type,
		vault_id: event.vault_id,
		version: event.version,
		client_id: event.client_id,
		user_id: event.user_id,
		metadata,
		timestamp: timestamp_millis(event.created_at),
	})
}

fn sync_stream_event_dto(
	event: DbSyncEventRow,
	recipient_user_id: &str,
) -> Result<SyncEventDto, SyncRpcError> {
	let is_own_event = event.event_type != "vault_access_revoked" && recipient_user_id == event.user_id;
	let origin_client_id = event.client_id.clone();
	let mut dto = sync_event_dto(event)?;
	let mut metadata = match dto.metadata.take() {
		Some(serde_json::Value::Object(map)) => map,
		Some(_) | None => serde_json::Map::new(),
	};

	metadata.insert("isOwnEvent".to_string(), serde_json::Value::Bool(is_own_event));
	metadata.insert(
		"originClientId".to_string(),
		origin_client_id
			.map(serde_json::Value::String)
			.unwrap_or(serde_json::Value::Null),
	);
	dto.metadata = Some(serde_json::Value::Object(metadata));

	Ok(dto)
}

fn sse_json_event<T: Serialize>(event_name: &str, payload: &T) -> Result<Event, SyncRpcError> {
	let data = serde_json::to_string(payload)
		.map_err(|e| { tracing::error!(error = %e, "Failed to serialize sync event"); internal_error("Failed to serialize sync event") })?;
	Ok(Event::default().event(event_name).data(data))
}

fn sse_heartbeat_event() -> Result<Event, SyncRpcError> {
	Ok(Event::default().comment(format!(
		"heartbeat {}",
		timestamp_millis(OffsetDateTime::now_utc())
	)))
}

async fn fetch_visible_cursor_event(
	pool: &PgPool,
	user_id: &str,
	target_vault_ids: &[String],
	since_id: &str,
) -> Result<Option<DbSyncEventCursorRow>, SyncRpcError> {
	if target_vault_ids.is_empty() {
		return query_as::<_, DbSyncEventCursorRow>(
			"SELECT id, seq FROM sync_event WHERE id = $1 AND user_id = $2 AND event_type = 'vault_access_revoked'::sync_event_type LIMIT 1",
		)
		.bind(since_id)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map_err(|_| internal_error("Failed to load sync cursor event"));
	}

	query_as::<_, DbSyncEventCursorRow>(
		"SELECT id, seq FROM sync_event WHERE id = $1 AND (vault_id = ANY($2) OR (user_id = $3 AND event_type = 'vault_access_revoked'::sync_event_type)) LIMIT 1",
	)
	.bind(since_id)
	.bind(target_vault_ids)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|_| internal_error("Failed to load sync cursor event"))
}

async fn fetch_latest_visible_event_id(
	pool: &PgPool,
	user_id: &str,
	target_vault_ids: &[String],
) -> Result<Option<String>, SyncRpcError> {
	if target_vault_ids.is_empty() {
		return query_as::<_, DbSyncEventIdRow>(
			"SELECT id FROM sync_event WHERE user_id = $1 AND event_type = 'vault_access_revoked'::sync_event_type ORDER BY seq DESC LIMIT 1",
		)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map(|row| row.map(|row| row.id))
		.map_err(|_| internal_error("Failed to load latest visible event"));
	}

	query_as::<_, DbSyncEventIdRow>(
		"SELECT id FROM sync_event WHERE vault_id = ANY($1) OR (user_id = $2 AND event_type = 'vault_access_revoked'::sync_event_type) ORDER BY seq DESC LIMIT 1",
	)
	.bind(target_vault_ids)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map(|row| row.map(|row| row.id))
	.map_err(|_| internal_error("Failed to load latest visible event"))
}

async fn fetch_latest_visible_event_seq(
	pool: &PgPool,
	user_id: &str,
	target_vault_ids: &[String],
) -> Result<i64, SyncRpcError> {
	let Some(latest_event_id) = fetch_latest_visible_event_id(pool, user_id, target_vault_ids).await? else {
		return Ok(0);
	};
	let Some(cursor_event) = fetch_visible_cursor_event(pool, user_id, target_vault_ids, &latest_event_id).await? else {
		return Ok(0);
	};

	Ok(cursor_event.seq)
}

async fn fetch_visible_events_since(
	pool: &PgPool,
	user_id: &str,
	target_vault_ids: &[String],
	cursor_seq: i64,
	limit: i32,
) -> Result<Vec<DbSyncEventRow>, SyncRpcError> {
	if target_vault_ids.is_empty() {
		return query_as::<_, DbSyncEventRow>(
			"SELECT id, seq, event_type::text AS event_type, entity_id, entity_type::text AS entity_type, vault_id, version, client_id, user_id, metadata, created_at FROM sync_event WHERE user_id = $1 AND event_type = 'vault_access_revoked'::sync_event_type AND seq > $2 ORDER BY seq ASC LIMIT $3",
		)
		.bind(user_id)
		.bind(cursor_seq)
		.bind(limit + 1)
		.fetch_all(pool)
		.await
		.map_err(|_| internal_error("Failed to load sync events"));
	}

	query_as::<_, DbSyncEventRow>(
		"SELECT id, seq, event_type::text AS event_type, entity_id, entity_type::text AS entity_type, vault_id, version, client_id, user_id, metadata, created_at FROM sync_event WHERE (vault_id = ANY($1) OR (user_id = $2 AND event_type = 'vault_access_revoked'::sync_event_type)) AND seq > $3 ORDER BY seq ASC LIMIT $4",
	)
	.bind(target_vault_ids)
	.bind(user_id)
	.bind(cursor_seq)
	.bind(limit + 1)
	.fetch_all(pool)
	.await
	.map_err(|_| internal_error("Failed to load sync events"))
}

fn bad_request_error(message: &str) -> SyncRpcError {
	SyncRpcError {
		code: "BAD_REQUEST".to_string(),
		message: message.to_string(),
	}
}

fn format_timestamp(value: OffsetDateTime) -> String {
	value
		.format(&time::format_description::well_known::Rfc3339)
		.unwrap_or_else(|_| value.unix_timestamp().to_string())
}

async fn attachments_enabled_for_user(
	pool: &PgPool,
	user_id: &str,
) -> Result<bool, SyncRpcError> {
	let actor = query_as::<_, DbTeamBillingEntitlementRow>(
		"SELECT u.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load attachment entitlements"); internal_error("Failed to load attachment entitlements") })?;
	if bittery_mode() == "self-hosted" {
		return Ok(true);
	}
	let Some(actor) = actor else {
		return Ok(false);
	};
	let Some(_team_id) = actor.team_id else {
		return Ok(false);
	};
	let Some(plan) = actor.billing_plan.as_deref() else {
		return Ok(false);
	};
	let Some(status) = actor.billing_status.as_deref() else {
		return Ok(false);
	};

	Ok(matches!(plan, "personal" | "family" | "team") && matches!(status, "active" | "trialing"))
}

fn bittery_mode() -> &'static str {
	match std::env::var("BITTERY_MODE") {
		Ok(value) => {
			let normalized = value.trim().to_ascii_lowercase();
			if normalized == "self-hosted"
				|| normalized == "self_hosted"
				|| normalized == "selfhosted"
			{
				"self-hosted"
			} else {
				"cloud"
			}
		}
		Err(_) => "cloud",
	}
}

async fn fetch_bootstrap_items(
	pool: &PgPool,
	vault_ids: &[String],
	cursor: Option<&str>,
	limit: i32,
) -> Result<Vec<DbBootstrapItemRow>, SyncRpcError> {
	match cursor {
		Some(cursor) => query_as::<_, DbBootstrapItemRow>(
			"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = ANY($1) AND id > $2 ORDER BY id ASC LIMIT $3",
		)
		.bind(vault_ids)
		.bind(cursor)
		.bind(limit + 1)
		.fetch_all(pool)
		.await
		.map_err(|_| internal_error("Failed to load bootstrap items")),
		None => query_as::<_, DbBootstrapItemRow>(
			"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = ANY($1) ORDER BY id ASC LIMIT $2",
		)
		.bind(vault_ids)
		.bind(limit + 1)
		.fetch_all(pool)
		.await
		.map_err(|_| internal_error("Failed to load bootstrap items")),
	}
}

async fn load_bootstrap_attachments(
	pool: &PgPool,
	items: &[DbBootstrapItemRow],
) -> Result<std::collections::HashMap<String, Vec<BootstrapAttachmentResponse>>, SyncRpcError> {
	let item_ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
	let attachment_rows = query_as::<_, DbBootstrapAttachmentRow>(
		"SELECT id, item_id, vault_id, storage_key, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, uploaded_by, created_at FROM item_attachment WHERE item_id = ANY($1) ORDER BY created_at ASC",
	)
	.bind(&item_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load bootstrap attachments"); internal_error("Failed to load bootstrap attachments") })?;

	let mut grouped = std::collections::HashMap::<String, Vec<BootstrapAttachmentResponse>>::new();
	for attachment in attachment_rows {
		grouped
			.entry(attachment.item_id.clone())
			.or_default()
			.push(BootstrapAttachmentResponse {
				id: attachment.id,
				item_id: attachment.item_id,
				vault_id: attachment.vault_id,
				storage_key: attachment.storage_key,
				encrypted_name: attachment.encrypted_name,
				encrypted_content_type: attachment.encrypted_content_type,
				encryption_iv: attachment.encryption_iv,
				encrypted_content_type_iv: attachment.encrypted_content_type_iv,
				encryption_algorithm: attachment.encryption_algorithm,
				file_size: attachment.file_size,
				uploaded_by: attachment.uploaded_by,
				created_at: format_timestamp(attachment.created_at),
			});
	}

	Ok(grouped)
}

fn not_found_error(message: &str) -> SyncRpcError {
	SyncRpcError {
		code: "NOT_FOUND".to_string(),
		message: message.to_string(),
	}
}

fn internal_error(message: &str) -> SyncRpcError {
	SyncRpcError {
		code: "INTERNAL_SERVER_ERROR".to_string(),
		message: message.to_string(),
	}
}

impl From<SyncRpcError> for RpcError {
	fn from(value: SyncRpcError) -> Self {
		let code = match value.code.as_str() {
			"BAD_REQUEST" => ErrorCode::InvalidParams,
			"NOT_FOUND" => ErrorCode::ServerError(404),
			_ => ErrorCode::InternalError,
		};

		RpcError {
			code,
			message: value.message,
			data: None,
		}
	}
}

impl IntoResponse for SyncRpcError {
	type Output = <RpcError as IntoResponse>::Output;

	fn into_response(self) -> jsonrpsee::ResponsePayload<'static, Self::Output> {
		RpcError::from(self).into_response()
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn sync_control_broker_publishes_session_revocations() {
		let broker = SyncControlBroker::default();
		let mut receiver = broker.subscribe();

		broker.publish_session_revoked("user-1", "session-1", "device_revoked");

		let payload = receiver.recv().await.expect("sync control payload should be received");
		assert_eq!(payload.control_type, "session_revoked");
		assert_eq!(payload.user_id, "user-1");
		assert_eq!(payload.session_id, "session-1");
		assert_eq!(payload.reason.as_deref(), Some("device_revoked"));
	}

	#[test]
	fn sync_stream_event_dto_enriches_metadata_for_stream_consumers() {
		let payload = sync_stream_event_dto(
			DbSyncEventRow {
				id: "event-1".to_string(),
				seq: 1,
				event_type: "item_updated".to_string(),
				entity_id: "item-1".to_string(),
				entity_type: "item".to_string(),
				vault_id: Some("vault-1".to_string()),
				version: 2,
				client_id: Some("client-1".to_string()),
				user_id: "user-1".to_string(),
				metadata: Some(r#"{"reason":"bulk_import"}"#.to_string()),
				created_at: OffsetDateTime::now_utc(),
			},
			"user-1",
		)
		.expect("sync stream payload should be created");

		let metadata = payload.metadata.expect("metadata should be present");
		assert_eq!(metadata["reason"], "bulk_import");
		assert_eq!(metadata["isOwnEvent"], true);
		assert_eq!(metadata["originClientId"], "client-1");
	}
}