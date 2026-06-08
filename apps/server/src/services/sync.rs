use axum::response::sse::Event;
use rand::random;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use sqlx::{query, query_as};
use std::sync::LazyLock;
use time::OffsetDateTime;
use ts_rs::TS;

use crate::{
    config::{bittery_mode, format_timestamp},
    db::models::*,
    error::AppError,
    integrations::storage,
    repo::{
        common::load_scoped_item_access,
        sync::{
            fetch_bootstrap_items, fetch_latest_visible_event_id, fetch_user_vault_ids,
            fetch_visible_cursor_event, fetch_visible_events_since, load_bootstrap_attachment_rows,
        },
    },
    services::team_billing::{load_team_billing_entitlement, resolve_attachment_entitlement},
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
pub(crate) const SYNC_STREAM_HEARTBEAT_INTERVAL_MS: u64 = 15_000;

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
                fetch_visible_cursor_event(pool, user_id, &target_vault_ids, since_id).await?;
            let Some(cursor_event) = cursor_event else {
                let latest_visible_event_id =
                    fetch_latest_visible_event_id(pool, user_id, &target_vault_ids).await?;
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

    let events =
        fetch_visible_events_since(pool, user_id, &target_vault_ids, cursor_seq, limit).await?;
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
        has_more,
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
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9_-]{1,64}$").expect("client id regex should be valid")
    });
    if RE.is_match(client_id) {
        Ok(())
    } else {
        Err(bad_request_error("Invalid client ID"))
    }
}

fn validate_resource_id(value: &str) -> Result<(), AppError> {
    static RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
		r"^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|[A-Za-z0-9_-]{10,64})$",
	).expect("resource id regex should be valid")
    });
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

pub(crate) fn sse_json_event<T: Serialize>(
    event_name: &str,
    payload: &T,
) -> Result<Event, AppError> {
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

    let actor =
        load_team_billing_entitlement(pool, user_id, "Failed to load attachment entitlements")
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
#[path = "sync_tests.rs"]
mod tests;
