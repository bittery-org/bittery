use axum::response::sse::Event;
use sqlx::PgPool;
use rand::random;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::{query, query_as};
use time::OffsetDateTime;
use tokio::sync::broadcast;
use std::sync::LazyLock;
use ts_rs::TS;

use crate::{
    db::models::*,
    error::AppError,
    repo::{
        common::load_scoped_item_access,
        sync::{
            fetch_bootstrap_items, fetch_latest_visible_event_id,
            fetch_user_vault_ids, fetch_visible_cursor_event, fetch_visible_events_since,
            load_bootstrap_attachment_rows,
        },
    },
    config::{bittery_mode, format_timestamp},
    services::team_billing::{load_team_billing_entitlement, resolve_attachment_entitlement},
    integrations::storage, AppState,
};


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

pub(crate) const DEFAULT_EVENTS_LIMIT: i32 = 100;
const DEFAULT_BOOTSTRAP_LIMIT: i32 = 500;
pub(crate) const SYNC_STREAM_POLL_INTERVAL_MS: u64 = 2_000;
pub(crate) const SYNC_STREAM_HEARTBEAT_INTERVAL_MS: u64 = 15_000;
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

pub(crate) async fn check_conflict(
    pool: &PgPool,
    user_id: &str,
    input: CheckConflictInput,
) -> Result<CheckConflictResponse, AppError> {
    validate_resource_id(&input.item_id)?;

    let accessible_item = load_scoped_item_access(pool, user_id, &input.item_id)
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

pub(crate) async fn get_events_since(
    pool: &PgPool,
    user_id: &str,
    input: GetEventsSinceInput,
) -> Result<GetEventsSinceResponse, AppError> {
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
    let user_vault_ids = fetch_user_vault_ids(pool, user_id).await?;
    let target_vault_ids = match input.vault_ids {
        Some(vault_ids) => vault_ids
            .into_iter()
            .filter(|vault_id| user_vault_ids.contains(vault_id))
            .collect::<Vec<_>>(),
        None => user_vault_ids,
    };

    let cursor_seq = match input.since_id.as_deref() {
        Some(since_id) => {
            let cursor_event =
                fetch_visible_cursor_event(pool, user_id, &target_vault_ids, since_id)
                    .await?;
            let Some(cursor_event) = cursor_event else {
                let latest_visible_event_id =
                    fetch_latest_visible_event_id(pool, user_id, &target_vault_ids)
                        .await?;
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
        user_id,
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
    let cursor = result_events.last().map(|event| SyncCursorResponse {
        id: event.id.clone(),
    });
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

pub(crate) async fn bootstrap_items(
    pool: &PgPool,
    user_id: &str,
    input: BootstrapItemsInput,
) -> Result<BootstrapItemsResponse, AppError> {
    if let Some(cursor) = &input.cursor {
        validate_resource_id(cursor)?;
    }
    let limit = input.limit.unwrap_or(DEFAULT_BOOTSTRAP_LIMIT);
    if !(1..=1000).contains(&limit) {
        return Err(bad_request_error("Invalid params"));
    }
    let attachments_enabled = attachments_enabled_for_user(pool, user_id).await?;
    let user_vaults = query_as::<_, DbBootstrapVaultAccessRow>(
		"SELECT vk.vault_id, v.name AS vault_name, v.type::text AS vault_type, v.icon AS vault_icon, v.image_key AS vault_image_key, vk.encrypted_vault_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 ORDER BY vk.created_at ASC",
	)
	.bind(user_id)
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

    let vault_ids: Vec<String> = user_vaults
        .iter()
        .map(|vault| vault.vault_id.clone())
        .collect();
    let paged_items =
        fetch_bootstrap_items(pool, &vault_ids, input.cursor.as_deref(), limit).await?;
    let has_more = paged_items.len() > limit as usize;
    let result_items = if has_more {
        paged_items
            .into_iter()
            .take(limit as usize)
            .collect::<Vec<_>>()
    } else {
        paged_items
    };
    let next_cursor = if has_more {
        result_items.last().map(|item| item.id.clone())
    } else {
        None
    };

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
                attachments: attachments_by_item
                    .get(&item.id)
                    .cloned()
                    .unwrap_or_default(),
                vault: vault_map.get(&item.vault_id).cloned(),
            })
            .collect(),
        next_cursor,
        has_more,
    })
}

pub(crate) async fn acknowledge_events(
    pool: &PgPool,
    user_id: &str,
    input: AcknowledgeEventsInput,
) -> Result<AcknowledgeEventsResponse, AppError> {
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
    let events = query_as::<_, DbSyncEventVaultRow>(
        "SELECT id, vault_id FROM sync_event WHERE id = ANY($1)",
    )
    .bind(&input.event_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load sync events");
        internal_error("Failed to load sync events")
    })?;
    let user_vaults =
        query_as::<_, DbVaultAccessRow>("SELECT vault_id FROM vault_key WHERE user_id = $1")
            .bind(user_id)
            .fetch_all(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to load vault access");
                internal_error("Failed to load vault access")
            })?;
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
        .bind(user_id)
        .bind(&input.client_id)
        .execute(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to acknowledge sync event");
            internal_error("Failed to acknowledge sync event")
        })?;
    }

    Ok(AcknowledgeEventsResponse {
        acknowledged: accessible_event_ids.len() as i32,
    })
}

pub(crate) async fn get_last_acknowledged(
    pool: &PgPool,
    user_id: &str,
    input: GetLastAcknowledgedInput,
) -> Result<Option<LastAcknowledgedResponse>, AppError> {
    validate_client_id(&input.client_id)?;
    let last_ack = query_as::<_, DbLastAcknowledgedRow>(
		"SELECT sea.event_id, se.created_at FROM sync_event_ack sea INNER JOIN sync_event se ON sea.event_id = se.id WHERE sea.user_id = $1 AND sea.client_id = $2 ORDER BY sea.acknowledged_at DESC LIMIT 1",
	)
	.bind(user_id)
	.bind(&input.client_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load last acknowledged event"); internal_error("Failed to load last acknowledged event") })?;

    Ok(last_ack.map(|ack| LastAcknowledgedResponse {
        event_id: ack.event_id,
        timestamp: timestamp_millis(ack.created_at),
    }))
}

pub(crate) async fn get_sync_state(
    pool: &PgPool,
    user_id: &str,
    input: GetSyncStateInput,
) -> Result<std::collections::BTreeMap<String, SyncStateEntry>, AppError> {
    if input.vault_ids.len() > 200 {
        return Err(bad_request_error("Invalid params"));
    }
    for vault_id in &input.vault_ids {
        validate_resource_id(vault_id)?;
    }
    let accessible_vaults = query_as::<_, DbVaultAccessRow>(
        "SELECT vault_id FROM vault_key WHERE user_id = $1 AND vault_id = ANY($2)",
    )
    .bind(user_id)
    .bind(&input.vault_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load accessible vaults");
        internal_error("Failed to load accessible vaults")
    })?;

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



pub(crate) fn timestamp_millis(value: OffsetDateTime) -> i64 {
    (value.unix_timestamp_nanos() / 1_000_000) as i64
}

fn validate_client_id(client_id: &str) -> Result<(), AppError> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]{1,64}$").expect("client id regex should be valid"));
    if RE.is_match(client_id) {
        Ok(())
    } else {
        Err(bad_request_error("Invalid client ID"))
    }
}

fn validate_resource_id(value: &str) -> Result<(), AppError> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(
		r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[A-Za-z0-9_-]{10,64})$",
	).expect("resource id regex should be valid"));
    if value.len() <= 64 && RE.is_match(value) {
        Ok(())
    } else {
        Err(bad_request_error("Invalid resource ID"))
    }
}

fn generate_sync_ack_id() -> String {
    format!("syncack_{:016x}", random::<u64>())
}

pub(crate) fn generate_sync_connection_id() -> String {
    format!(
        "{}-{:016x}",
        timestamp_millis(OffsetDateTime::now_utc()),
        random::<u64>()
    )
}

fn sync_event_dto(event: DbSyncEventRow) -> Result<SyncEventDto, AppError> {
    let metadata = match event.metadata {
        Some(value) => Some(
            serde_json::from_str::<serde_json::Value>(&value).map_err(|e| {
                tracing::error!(error = %e, "Failed to parse sync event metadata");
                internal_error("Failed to parse sync event metadata")
            })?,
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

pub(crate) fn sync_stream_event_dto(
    event: DbSyncEventRow,
    recipient_user_id: &str,
) -> Result<SyncEventDto, AppError> {
    let is_own_event =
        event.event_type != "vault_access_revoked" && recipient_user_id == event.user_id;
    let origin_client_id = event.client_id.clone();
    let mut dto = sync_event_dto(event)?;
    let mut metadata = match dto.metadata.take() {
        Some(serde_json::Value::Object(map)) => map,
        Some(_) | None => serde_json::Map::new(),
    };

    metadata.insert(
        "isOwnEvent".to_string(),
        serde_json::Value::Bool(is_own_event),
    );
    metadata.insert(
        "originClientId".to_string(),
        origin_client_id
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    dto.metadata = Some(serde_json::Value::Object(metadata));

    Ok(dto)
}

pub(crate) fn sse_json_event<T: Serialize>(event_name: &str, payload: &T) -> Result<Event, AppError> {
    let data = serde_json::to_string(payload).map_err(|e| {
        tracing::error!(error = %e, "Failed to serialize sync event");
        internal_error("Failed to serialize sync event")
    })?;
    Ok(Event::default().event(event_name).data(data))
}

pub(crate) fn sse_heartbeat_event() -> Result<Event, AppError> {
    Ok(Event::default().comment(format!(
        "heartbeat {}",
        timestamp_millis(OffsetDateTime::now_utc())
    )))
}

fn bad_request_error(message: &str) -> AppError {
    AppError::bad_request(message)
}

async fn attachments_enabled_for_user(pool: &PgPool, user_id: &str) -> Result<bool, AppError> {
    let mode = bittery_mode();
    if mode == "self-hosted" {
        return Ok(true);
    }

    let actor = load_team_billing_entitlement(
        pool,
        user_id,
        "Failed to load attachment entitlements",
    )
    .await?;

    let Some(actor) = actor else {
        return Ok(false);
    };
    let Some(_team_id) = actor.team_id else {
        return Ok(false);
    };

    Ok(resolve_attachment_entitlement(
        mode,
        actor.billing_plan.as_deref(),
        actor.billing_status.as_deref(),
    )
    .enabled)
}

async fn load_bootstrap_attachments(
    pool: &PgPool,
    items: &[DbBootstrapItemRow],
) -> Result<std::collections::HashMap<String, Vec<BootstrapAttachmentResponse>>, AppError> {
    let item_ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
    let attachment_rows = load_bootstrap_attachment_rows(pool, &item_ids).await?;

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

fn not_found_error(message: &str) -> AppError {
    AppError::not_found(message)
}

fn internal_error(message: &str) -> AppError {
    AppError::internal(message)
}

#[cfg(test)]
mod tests {
    use std::future::Future;

    use axum::{
        body::{to_bytes, Body},
        http::{header::CONTENT_TYPE, HeaderMap, HeaderValue, Request, StatusCode},
        middleware, Router as HttpRouter,
    };
    use rand::random;
    use serde_json::{json, Value};
    use sqlx::{query, query_scalar, PgPool};
    use time::{macros::datetime, OffsetDateTime};
    use tower::util::ServiceExt;

    use super::*;
    use crate::{
        http::sync_sse::create_sync_http_router,
        rpc_request_context_middleware,
        services::session_control::record_session_revocations,
        test_support::{
            acquire_env_lock, authenticated_json_headers, seed_item, seed_user, seed_vault,
            seed_vault_key, with_rpc_test_app, RpcTestApp,
        },
        AppState,
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
        let _guard = acquire_env_lock();
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

    #[test]
    fn session_control_payload_builder_sets_expected_fields() {
        let payload =
            SessionControlPayload::session_revoked("user-1", "session-1", Some("device_revoked"));

        assert_eq!(payload.control_type, "session_revoked");
        assert_eq!(payload.user_id, "user-1");
        assert_eq!(payload.session_id, "session-1");
        assert_eq!(payload.reason.as_deref(), Some("device_revoked"));
        assert!(payload.timestamp > 0);
    }

    #[test]
    fn validate_client_id_accepts_and_rejects_expected_values() {
        assert!(validate_client_id("client_1-test").is_ok());
        assert!(validate_client_id("").is_err());
        assert!(validate_client_id("contains space").is_err());
        assert!(validate_client_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn validate_resource_id_accepts_uuid_and_slug_variants() {
        assert!(validate_resource_id("550e8400-e29b-41d4-a716-446655440000").is_ok());
        assert!(validate_resource_id("resource_01").is_ok());
        assert!(validate_resource_id("short").is_err());
        assert!(validate_resource_id("resource.with.dot").is_err());
        assert!(validate_resource_id(&"a".repeat(65)).is_err());
    }

    #[test]
    fn bittery_mode_normalizes_self_hosted_variants() {
        with_bittery_mode(Some("self-hosted"), || {
            assert_eq!(bittery_mode(), "self-hosted");
        });
        with_bittery_mode(Some("SELF_HOSTED"), || {
            assert_eq!(bittery_mode(), "self-hosted");
        });
        with_bittery_mode(Some("selfhosted"), || {
            assert_eq!(bittery_mode(), "self-hosted");
        });
        with_bittery_mode(Some("cloud"), || {
            assert_eq!(bittery_mode(), "cloud");
        });
        with_bittery_mode(None, || {
            assert_eq!(bittery_mode(), "cloud");
        });
    }

    #[test]
    fn sync_event_dto_parses_metadata_and_rejects_invalid_json() {
        let payload = sync_event_dto(DbSyncEventRow {
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
        })
        .expect("sync event dto should parse metadata");

        let metadata = payload.metadata.expect("metadata should be present");
        assert_eq!(metadata["reason"], "bulk_import");

        let error = sync_event_dto(DbSyncEventRow {
            id: "event-2".to_string(),
            seq: 2,
            event_type: "item_updated".to_string(),
            entity_id: "item-1".to_string(),
            entity_type: "item".to_string(),
            vault_id: Some("vault-1".to_string()),
            version: 3,
            client_id: None,
            user_id: "user-1".to_string(),
            metadata: Some("not-json".to_string()),
            created_at: OffsetDateTime::now_utc(),
        })
        .expect_err("invalid metadata json should error");

        assert_eq!(error.code, "INTERNAL_SERVER_ERROR");
        assert_eq!(error.message, "Failed to parse sync event metadata");
    }

    #[tokio::test]
    async fn sync_control_broker_publishes_session_revocations() {
        let broker = SyncControlBroker::default();
        let mut receiver = broker.subscribe();

        broker.publish_session_revoked("user-1", "session-1", "device_revoked");

        let payload = receiver
            .recv()
            .await
            .expect("sync control payload should be received");
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

    #[test]
    fn sync_stream_event_dto_marks_vault_revocations_as_not_own_events() {
        let payload = sync_stream_event_dto(
            DbSyncEventRow {
                id: "event-2".to_string(),
                seq: 2,
                event_type: "vault_access_revoked".to_string(),
                entity_id: "vault-1".to_string(),
                entity_type: "vault".to_string(),
                vault_id: Some("vault-1".to_string()),
                version: 1,
                client_id: None,
                user_id: "user-1".to_string(),
                metadata: None,
                created_at: OffsetDateTime::now_utc(),
            },
            "user-1",
        )
        .expect("sync stream payload should be created");

        let metadata = payload.metadata.expect("metadata should be present");
        assert_eq!(metadata["isOwnEvent"], false);
        assert_eq!(metadata["originClientId"], serde_json::Value::Null);
    }

    #[derive(Clone)]
    struct SyncHttpTestApp {
        router: HttpRouter,
    }

    struct SyncHttpTestResponse {
        status: StatusCode,
        headers: HeaderMap,
        body: String,
    }

    impl SyncHttpTestApp {
        fn new(state: AppState) -> Self {
            let router = create_sync_http_router()
                .route_layer(middleware::from_fn_with_state(
                    state.clone(),
                    rpc_request_context_middleware,
                ))
                .with_state(state);

            Self { router }
        }

        async fn get(&self, path: &str, headers: HeaderMap) -> SyncHttpTestResponse {
            let mut builder = Request::builder().method("GET").uri(path);
            for (name, value) in &headers {
                builder = builder.header(name, value);
            }

            let response = self
                .router
                .clone()
                .oneshot(
                    builder
                        .body(Body::empty())
                        .expect("sync HTTP request should build"),
                )
                .await
                .expect("sync HTTP request should resolve");

            let status = response.status();
            let headers = response.headers().clone();
            let bytes = to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("sync HTTP response body should be readable");

            SyncHttpTestResponse {
                status,
                headers,
                body: String::from_utf8_lossy(&bytes).into_owned(),
            }
        }
    }

    struct SyncRouterFixture {
        owner_user_id: String,
        outsider_user_id: String,
        primary_vault_id: String,
        secondary_vault_id: String,
        hidden_vault_id: String,
        primary_item_id: String,
        secondary_item_id: String,
        hidden_item_id: String,
        old_primary_event_id: String,
        latest_primary_event_id: String,
        secondary_event_id: String,
        hidden_event_id: String,
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

    async fn with_sync_test_app<T, F, Fut>(test_name: &str, test_fn: F) -> T
    where
        F: FnOnce(RpcTestApp) -> Fut,
        Fut: Future<Output = T>,
    {
        let unique_name = format!("{test_name}_{:016x}", random::<u64>());
        with_rpc_test_app(&unique_name, test_fn).await
    }

    async fn build_sync_router_fixture(pool: &PgPool) -> SyncRouterFixture {
        let owner_user_id = "user_sync_owner".to_string();
        let outsider_user_id = "user_sync_outsider".to_string();
        let primary_vault_id = "vault_sync_primary".to_string();
        let secondary_vault_id = "vault_sync_secondary".to_string();
        let hidden_vault_id = "vault_sync_hidden".to_string();
        let primary_item_id = "item_sync_01".to_string();
        let secondary_item_id = "item_sync_02".to_string();
        let hidden_item_id = "item_sync_hidden".to_string();
        let old_primary_event_id = "event_sync_01".to_string();
        let hidden_event_id = "event_sync_hidden".to_string();
        let latest_primary_event_id = "event_sync_02".to_string();
        let secondary_event_id = "event_sync_03".to_string();

        seed_user(pool, &owner_user_id, "Sync Owner", "sync-owner@example.com").await;
        seed_user(
            pool,
            &outsider_user_id,
            "Sync Outsider",
            "sync-outsider@example.com",
        )
        .await;

        seed_vault(
            pool,
            &primary_vault_id,
            "Primary Vault",
            "personal",
            &owner_user_id,
            None,
        )
        .await;
        seed_vault(
            pool,
            &secondary_vault_id,
            "Secondary Vault",
            "personal",
            &owner_user_id,
            None,
        )
        .await;
        seed_vault(
            pool,
            &hidden_vault_id,
            "Hidden Vault",
            "personal",
            &outsider_user_id,
            None,
        )
        .await;

        seed_vault_key(
            pool,
            "vault_key_sync_primary_owner",
            &primary_vault_id,
            &owner_user_id,
            "encrypted-vault-key-primary",
            "owner",
        )
        .await;
        seed_vault_key(
            pool,
            "vault_key_sync_secondary_owner",
            &secondary_vault_id,
            &owner_user_id,
            "encrypted-vault-key-secondary",
            "owner",
        )
        .await;
        seed_vault_key(
            pool,
            "vault_key_sync_hidden_outsider",
            &hidden_vault_id,
            &outsider_user_id,
            "encrypted-vault-key-hidden",
            "owner",
        )
        .await;

        seed_item(
            pool,
            &primary_item_id,
            &primary_vault_id,
            "login",
            "encrypted-primary-item",
            "iv-primary-item",
            &owner_user_id,
        )
        .await;
        seed_item(
            pool,
            &secondary_item_id,
            &secondary_vault_id,
            "login",
            "encrypted-secondary-item",
            "iv-secondary-item",
            &owner_user_id,
        )
        .await;
        seed_item(
            pool,
            &hidden_item_id,
            &hidden_vault_id,
            "login",
            "encrypted-hidden-item",
            "iv-hidden-item",
            &outsider_user_id,
        )
        .await;

        seed_sync_event(
            pool,
            &old_primary_event_id,
            "item_updated",
            &primary_item_id,
            "item",
            Some(&primary_vault_id),
            &owner_user_id,
            2,
            Some("client-sync-1"),
            Some(r#"{"reason":"import"}"#),
            datetime!(2025-05-01 10:00 UTC),
        )
        .await;
        seed_sync_event(
            pool,
            &hidden_event_id,
            "item_updated",
            &hidden_item_id,
            "item",
            Some(&hidden_vault_id),
            &outsider_user_id,
            1,
            Some("client-hidden"),
            None,
            datetime!(2025-05-01 11:00 UTC),
        )
        .await;
        seed_sync_event(
            pool,
            &latest_primary_event_id,
            "item_updated",
            &primary_item_id,
            "item",
            Some(&primary_vault_id),
            &owner_user_id,
            3,
            Some("client-sync-2"),
            Some(r#"{"reason":"rotation"}"#),
            datetime!(2025-05-01 12:00 UTC),
        )
        .await;
        seed_sync_event(
            pool,
            &secondary_event_id,
            "item_updated",
            &secondary_item_id,
            "item",
            Some(&secondary_vault_id),
            &owner_user_id,
            1,
            Some("client-sync-3"),
            None,
            datetime!(2025-05-01 13:00 UTC),
        )
        .await;
        seed_attachment(
            pool,
            "attachment_sync_01",
            &primary_item_id,
            &primary_vault_id,
            &owner_user_id,
            datetime!(2025-05-01 14:00 UTC),
        )
        .await;

        SyncRouterFixture {
            owner_user_id,
            outsider_user_id,
            primary_vault_id,
            secondary_vault_id,
            hidden_vault_id,
            primary_item_id,
            secondary_item_id,
            hidden_item_id,
            old_primary_event_id,
            latest_primary_event_id,
            secondary_event_id,
            hidden_event_id,
        }
    }

    async fn seed_sync_event(
        pool: &PgPool,
        event_id: &str,
        event_type: &str,
        entity_id: &str,
        entity_type: &str,
        vault_id: Option<&str>,
        user_id: &str,
        version: i32,
        client_id: Option<&str>,
        metadata: Option<&str>,
        created_at: OffsetDateTime,
    ) {
        query(
			"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, $2::sync_event_type, $3, $4::sync_entity_type, $5, $6, $7, $8, $9, $10)",
		)
		.bind(event_id)
		.bind(event_type)
		.bind(entity_id)
		.bind(entity_type)
		.bind(vault_id)
		.bind(user_id)
		.bind(version)
		.bind(client_id)
		.bind(metadata)
		.bind(created_at)
		.execute(pool)
		.await
		.expect("sync event should seed");
    }

    async fn seed_attachment(
        pool: &PgPool,
        attachment_id: &str,
        item_id: &str,
        vault_id: &str,
        uploaded_by: &str,
        created_at: OffsetDateTime,
    ) {
        query(
			"INSERT INTO item_attachment (id, item_id, vault_id, storage_key, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, storage_size, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
		)
		.bind(attachment_id)
		.bind(item_id)
		.bind(vault_id)
		.bind(format!("attachments/{attachment_id}"))
		.bind("encrypted-attachment-name")
		.bind("encrypted-content-type")
		.bind("attachment-iv")
		.bind(Some("attachment-content-type-iv"))
		.bind("AES-GCM-AAD-V1")
		.bind(128_i32)
		.bind(128_i32)
		.bind(uploaded_by)
		.bind(created_at)
		.execute(pool)
		.await
		.expect("attachment should seed");
    }

    #[tokio::test]
    async fn sync_handlers_require_authentication() {
        with_sync_test_app("sync_handlers_require_authentication", |app| async move {
            let protected_calls = vec![
                ("sync.bootstrapItems", json!([{}])),
                ("sync.getEventsSince", json!([{}])),
                (
                    "sync.acknowledgeEvents",
                    json!([{ "eventIds": [], "clientId": "client-sync" }]),
                ),
                (
                    "sync.getLastAcknowledged",
                    json!([{ "clientId": "client-sync" }]),
                ),
                ("sync.getSyncState", json!([{ "vaultIds": [] }])),
                (
                    "sync.checkConflict",
                    json!([{ "itemId": "item_sync_01", "expectedVersion": 1 }]),
                ),
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
        })
        .await;
    }

    #[tokio::test]
    async fn sync_handlers_reject_malformed_request_input() {
        with_sync_test_app(
            "sync_handlers_reject_malformed_request_input",
            |app| async move {
                let fixture = build_sync_router_fixture(&app.pool).await;
                let session = app.issue_session(&fixture.owner_user_id).await;
                let headers = authenticated_json_headers(&session.token);

                let cases = vec![
                    (
                        "sync.bootstrapItems",
                        json!([{ "limit": 0 }]),
                        "BAD_REQUEST",
                        "Invalid params",
                    ),
                    (
                        "sync.getEventsSince",
                        json!([{ "sinceId": "bad!" }]),
                        "BAD_REQUEST",
                        "Invalid resource ID",
                    ),
                    (
                        "sync.acknowledgeEvents",
                        json!([{ "eventIds": [], "clientId": "bad client" }]),
                        "BAD_REQUEST",
                        "Invalid client ID",
                    ),
                    (
                        "sync.getLastAcknowledged",
                        json!([{ "clientId": "bad client" }]),
                        "BAD_REQUEST",
                        "Invalid client ID",
                    ),
                    (
                        "sync.getSyncState",
                        json!([{ "vaultIds": ["bad!"] }]),
                        "BAD_REQUEST",
                        "Invalid resource ID",
                    ),
                    (
                        "sync.checkConflict",
                        json!([{ "itemId": "bad!", "expectedVersion": 1 }]),
                        "BAD_REQUEST",
                        "Invalid resource ID",
                    ),
                ];

                for (method, params, code, message) in cases {
                    let response = app.rpc_call(method, params, headers.clone()).await;
                    assert_eq!(
                        response.status,
                        StatusCode::OK,
                        "unexpected status for {method}"
                    );
                    assert_handler_error(&response.body, code, message);
                }
            },
        )
        .await;
    }

    #[tokio::test]
    async fn check_conflict_reports_not_found_and_latest_version() {
        with_sync_test_app("sync_check_conflict_paths", |app| async move {
            let fixture = build_sync_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            let not_found = app
                .rpc_call(
                    "sync.checkConflict",
                    json!([{
                        "itemId": fixture.hidden_item_id,
                        "expectedVersion": 1
                    }]),
                    headers.clone(),
                )
                .await;
            assert_eq!(not_found.status, StatusCode::OK);
            assert_handler_error(&not_found.body, "NOT_FOUND", "Item not found");

            let no_conflict = app
                .rpc_call(
                    "sync.checkConflict",
                    json!([{
                        "itemId": fixture.primary_item_id,
                        "expectedVersion": 3
                    }]),
                    headers.clone(),
                )
                .await;
            assert_eq!(no_conflict.status, StatusCode::OK);
            assert_eq!(
                no_conflict.body["result"]["Ok"]["hasConflict"],
                json!(false)
            );
            assert_eq!(no_conflict.body["result"]["Ok"]["currentVersion"], json!(3));

            let conflict = app
                .rpc_call(
                    "sync.checkConflict",
                    json!([{
                        "itemId": fixture.primary_item_id,
                        "expectedVersion": 2
                    }]),
                    headers,
                )
                .await;
            assert_eq!(conflict.status, StatusCode::OK);
            assert_eq!(conflict.body["result"]["Ok"]["hasConflict"], json!(true));
            assert_eq!(
                conflict.body["result"]["Ok"]["lastModifiedBy"],
                json!(fixture.owner_user_id)
            );
            assert!(
                conflict.body["result"]["Ok"]["lastModifiedAt"]
                    .as_i64()
                    .expect("last modified timestamp should be present")
                    > 0
            );
        })
        .await;
    }

    #[tokio::test]
    async fn get_events_since_paginates_filters_and_requires_full_refresh() {
        with_sync_test_app("sync_get_events_since_paths", |app| async move {
            let fixture = build_sync_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            let first_page = app
                .rpc_call(
                    "sync.getEventsSince",
                    json!([{ "limit": 1 }]),
                    headers.clone(),
                )
                .await;
            assert_eq!(first_page.status, StatusCode::OK);
            assert_eq!(
                first_page.body["result"]["Ok"]["events"]
                    .as_array()
                    .expect("events should be an array")
                    .len(),
                1
            );
            assert_eq!(
                first_page.body["result"]["Ok"]["events"][0]["id"],
                json!(fixture.old_primary_event_id)
            );
            assert_eq!(
                first_page.body["result"]["Ok"]["events"][0]["metadata"]["reason"],
                json!("import")
            );
            assert_eq!(first_page.body["result"]["Ok"]["hasMore"], json!(true));
            assert_eq!(
                first_page.body["result"]["Ok"]["cursor"]["id"],
                json!(fixture.old_primary_event_id)
            );

            let filtered = app
				.rpc_call(
					"sync.getEventsSince",
					json!([{
						"vaultIds": [fixture.secondary_vault_id.clone(), fixture.hidden_vault_id.clone()]
					}]),
					headers.clone(),
				)
				.await;
            assert_eq!(filtered.status, StatusCode::OK);
            assert_eq!(
                filtered.body["result"]["Ok"]["events"]
                    .as_array()
                    .expect("events should be an array")
                    .len(),
                1
            );
            assert_eq!(
                filtered.body["result"]["Ok"]["events"][0]["id"],
                json!(fixture.secondary_event_id)
            );

            let next_page = app
                .rpc_call(
                    "sync.getEventsSince",
                    json!([{ "sinceId": fixture.old_primary_event_id }]),
                    headers.clone(),
                )
                .await;
            assert_eq!(next_page.status, StatusCode::OK);
            assert_eq!(
                next_page.body["result"]["Ok"]["events"]
                    .as_array()
                    .expect("events should be an array")
                    .len(),
                2
            );
            assert_eq!(
                next_page.body["result"]["Ok"]["events"][0]["id"],
                json!(fixture.latest_primary_event_id)
            );
            assert_eq!(
                next_page.body["result"]["Ok"]["events"][1]["id"],
                json!(fixture.secondary_event_id)
            );
            assert_eq!(next_page.body["result"]["Ok"]["hasMore"], json!(false));

            let full_refresh = app
                .rpc_call(
                    "sync.getEventsSince",
                    json!([{ "sinceId": fixture.hidden_event_id }]),
                    headers,
                )
                .await;
            assert_eq!(full_refresh.status, StatusCode::OK);
            assert_eq!(full_refresh.body["result"]["Ok"]["events"], json!([]));
            assert_eq!(
                full_refresh.body["result"]["Ok"]["requiresFullRefresh"],
                json!(true)
            );
            assert_eq!(
                full_refresh.body["result"]["Ok"]["cursor"]["id"],
                json!(fixture.secondary_event_id)
            );
        })
        .await;
    }

    #[tokio::test]
    async fn bootstrap_items_returns_paginated_items_with_vault_details_and_attachments() {
        with_bittery_mode_async(Some("self-hosted"), async {
            with_sync_test_app("sync_bootstrap_items_success", |app| async move {
                let fixture = build_sync_router_fixture(&app.pool).await;
                let session = app.issue_session(&fixture.owner_user_id).await;
                let headers = authenticated_json_headers(&session.token);

                let first_page = app
                    .rpc_call(
                        "sync.bootstrapItems",
                        json!([{ "limit": 1 }]),
                        headers.clone(),
                    )
                    .await;
                assert_eq!(first_page.status, StatusCode::OK);
                assert_eq!(
                    first_page.body["result"]["Ok"]["items"]
                        .as_array()
                        .expect("items should be an array")
                        .len(),
                    1
                );
                assert_eq!(
                    first_page.body["result"]["Ok"]["items"][0]["id"],
                    json!(fixture.primary_item_id)
                );
                assert_eq!(
                    first_page.body["result"]["Ok"]["items"][0]["attachments"]
                        .as_array()
                        .expect("attachments should be an array")
                        .len(),
                    1
                );
                assert_eq!(
                    first_page.body["result"]["Ok"]["items"][0]["vault"]["encryptedVaultKey"],
                    json!("encrypted-vault-key-primary")
                );
                assert_eq!(first_page.body["result"]["Ok"]["hasMore"], json!(true));
                assert_eq!(
                    first_page.body["result"]["Ok"]["nextCursor"],
                    json!(fixture.primary_item_id)
                );

                let second_page = app
                    .rpc_call(
                        "sync.bootstrapItems",
                        json!([{ "cursor": fixture.primary_item_id }]),
                        headers,
                    )
                    .await;
                assert_eq!(second_page.status, StatusCode::OK);
                assert_eq!(
                    second_page.body["result"]["Ok"]["items"]
                        .as_array()
                        .expect("items should be an array")
                        .len(),
                    1
                );
                assert_eq!(
                    second_page.body["result"]["Ok"]["items"][0]["id"],
                    json!(fixture.secondary_item_id)
                );
                assert_eq!(second_page.body["result"]["Ok"]["hasMore"], json!(false));
                assert_eq!(second_page.body["result"]["Ok"]["nextCursor"], Value::Null);
            })
            .await;
        })
        .await;
    }

    #[tokio::test]
    async fn acknowledge_events_and_get_last_acknowledged_filter_inaccessible_events() {
        with_sync_test_app("sync_acknowledge_and_last_acknowledged", |app| async move {
            let fixture = build_sync_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let headers = authenticated_json_headers(&session.token);

            let before_ack = app
                .rpc_call(
                    "sync.getLastAcknowledged",
                    json!([{ "clientId": "client-sync" }]),
                    headers.clone(),
                )
                .await;
            assert_eq!(before_ack.status, StatusCode::OK);
            assert_eq!(before_ack.body["result"]["Ok"], Value::Null);

            let acknowledge = app
				.rpc_call(
					"sync.acknowledgeEvents",
					json!([{
						"eventIds": [fixture.latest_primary_event_id.clone(), fixture.hidden_event_id.clone()],
						"clientId": "client-sync"
					}]),
					headers.clone(),
				)
				.await;
            assert_eq!(acknowledge.status, StatusCode::OK);
            assert_eq!(acknowledge.body["result"]["Ok"]["acknowledged"], json!(1));

            let ack_count = query_scalar::<_, i64>(
                "SELECT COUNT(*)::bigint FROM sync_event_ack WHERE user_id = $1 AND client_id = $2",
            )
            .bind(&fixture.owner_user_id)
            .bind("client-sync")
            .fetch_one(&app.pool)
            .await
            .expect("ack count should query");
            assert_eq!(ack_count, 1);

            let last_ack = app
                .rpc_call(
                    "sync.getLastAcknowledged",
                    json!([{ "clientId": "client-sync" }]),
                    headers,
                )
                .await;
            assert_eq!(last_ack.status, StatusCode::OK);
            assert_eq!(
                last_ack.body["result"]["Ok"]["eventId"],
                json!(fixture.latest_primary_event_id)
            );
            assert!(
                last_ack.body["result"]["Ok"]["timestamp"]
                    .as_i64()
                    .expect("ack timestamp should be present")
                    > 0
            );
        })
        .await;
    }

    #[tokio::test]
    async fn get_sync_state_returns_latest_visible_event_per_accessible_vault() {
        with_sync_test_app("sync_get_sync_state_paths", |app| async move {
            let fixture = build_sync_router_fixture(&app.pool).await;
            let session = app.issue_session(&fixture.owner_user_id).await;
            let response = app
                .rpc_call(
                    "sync.getSyncState",
                    json!([{
                        "vaultIds": [
                            fixture.primary_vault_id.clone(),
                            fixture.secondary_vault_id.clone(),
                            fixture.hidden_vault_id.clone()
                        ]
                    }]),
                    authenticated_json_headers(&session.token),
                )
                .await;

            assert_eq!(response.status, StatusCode::OK);
            assert_eq!(
                response.body["result"]["Ok"][&fixture.primary_vault_id]["latestEventId"],
                json!(fixture.latest_primary_event_id)
            );
            assert_eq!(
                response.body["result"]["Ok"][&fixture.secondary_vault_id]["latestEventId"],
                json!(fixture.secondary_event_id)
            );
            assert_eq!(
                response.body["result"]["Ok"][&fixture.hidden_vault_id],
                Value::Null
            );
        })
        .await;
    }

    #[tokio::test]
    async fn sync_http_routes_cover_health_auth_and_revocation_paths() {
        with_sync_test_app("sync_http_routes_paths", |app| async move {
            let fixture = build_sync_router_fixture(&app.pool).await;
            let http_app = SyncHttpTestApp::new(app.state.clone());

            let health = http_app.get("/health", HeaderMap::new()).await;
            assert_eq!(health.status, StatusCode::OK);
            assert!(health.body.contains(r#"{"status":"ok"}"#));

            let unauthorized = http_app.get("/events", HeaderMap::new()).await;
            assert_eq!(unauthorized.status, StatusCode::UNAUTHORIZED);
            assert!(unauthorized.body.contains(r#"{"error":"Unauthorized"}"#));

            let session = app.issue_session(&fixture.owner_user_id).await;
            record_session_revocations(
                &app.pool,
                &fixture.owner_user_id,
                &[session.session_id.clone()],
                "device_revoked",
            )
            .await
            .expect("session revocation should seed");

            let stream = http_app
                .get("/events", authenticated_json_headers(&session.token))
                .await;
            assert_eq!(stream.status, StatusCode::OK);
            assert_eq!(
                stream
                    .headers
                    .get(CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .expect("content type should be present"),
                "text/event-stream"
            );
            assert!(stream.body.contains("event: connected"));
            assert!(stream.body.contains("event: control"));
            assert!(stream.body.contains(r#""type":"connected""#));
            assert!(stream.body.contains(r#""type":"session_revoked""#));
            assert!(stream.body.contains(r#""reason":"device_revoked""#));
        })
        .await;
    }
}
