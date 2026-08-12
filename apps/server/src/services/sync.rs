use axum::response::sse::Event;
use rand::random;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sqlx::query_as;
use sqlx::PgPool;
use std::sync::LazyLock;
use time::OffsetDateTime;

use crate::{
    config::bittery_mode,
    db::models::*,
    error::AppError,
    integrations::storage,
    repo::sync::{
        fetch_bootstrap_items, fetch_latest_visible_event_id, fetch_user_vault_ids,
        fetch_visible_cursor_event, fetch_visible_events_since, load_bootstrap_attachment_rows,
    },
    services::team_billing::{load_team_billing_entitlement, resolve_attachment_entitlement},
    shapes::{
        attachment_shape, bootstrap_items_shape, bootstrap_vault_summary_shape, item_shape,
        sync_changes_shape, sync_cursor_shape, sync_event_shape,
    },
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GetEventsSinceInput {
    pub since_id: Option<String>,
    pub vault_ids: Option<Vec<String>>,
    pub limit: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BootstrapItemsInput {
    pub cursor: Option<String>,
    pub sync_cursor: Option<String>,
    pub sync_cursor_captured: bool,
    pub limit: Option<i32>,
}

sync_event_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SyncEventDto
}, timestamp = i64);

sync_cursor_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct SyncCursorResponse
});

sync_changes_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct GetEventsSinceResponse
}, event = SyncEventDto);

bootstrap_vault_summary_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BootstrapVaultSummary
});

attachment_shape! {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BootstrapAttachmentResponse {}
}

item_shape! {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BootstrapItemResponse {
        attachments: Vec<BootstrapAttachmentResponse>,
        vault: Option<BootstrapVaultSummary>,
    }
}

bootstrap_items_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BootstrapItemsResponse
});

pub(crate) const DEFAULT_EVENTS_LIMIT: i32 = 100;
const DEFAULT_BOOTSTRAP_LIMIT: i32 = 500;
pub(crate) const SYNC_STREAM_HEARTBEAT_INTERVAL_MS: u64 = 15_000;

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
            return Err(AppError::bad_request("Invalid params"));
        }
        for vault_id in vault_ids {
            validate_resource_id(vault_id)?;
        }
    }
    let limit = input.limit.unwrap_or(DEFAULT_EVENTS_LIMIT);
    if !(1..=1000).contains(&limit) {
        return Err(AppError::bad_request("Invalid params"));
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
    let count_has_more = events.rows.len() > limit as usize;
    let has_more = events.has_more || count_has_more;
    let result_events = if count_has_more {
        events
            .rows
            .into_iter()
            .take(limit as usize)
            .collect::<Vec<_>>()
    } else {
        events.rows
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
    if let Some(sync_cursor) = &input.sync_cursor {
        validate_resource_id(sync_cursor)?;
    }
    let limit = input.limit.unwrap_or(DEFAULT_BOOTSTRAP_LIMIT);
    if !(1..=1000).contains(&limit) {
        return Err(AppError::bad_request("Invalid params"));
    }

    let user_vault_ids = fetch_user_vault_ids(pool, user_id).await?;
    let sync_cursor = match (input.sync_cursor_captured, input.sync_cursor.as_deref()) {
        (_, Some(sync_cursor)) => {
            let visible_cursor =
                fetch_visible_cursor_event(pool, user_id, &user_vault_ids, sync_cursor).await?;
            let Some(visible_cursor) = visible_cursor else {
                return Err(AppError::bad_request("Invalid params"));
            };
            Some(SyncCursorResponse {
                id: visible_cursor.id,
            })
        }
        (true, None) => None,
        (false, None) => fetch_latest_visible_event_id(pool, user_id, &user_vault_ids)
            .await?
            .map(|id| SyncCursorResponse { id }),
    };

    let attachments_enabled = attachments_enabled_for_user(pool, user_id).await?;
    let paged_items = fetch_bootstrap_items(pool, user_id, input.cursor.as_deref(), limit).await?;
    let count_has_more = paged_items.rows.len() > limit as usize;
    let has_more = paged_items.has_more || count_has_more;
    let paged_items = paged_items.rows;
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
    let mut selected_vault_ids: Vec<String> = result_items
        .iter()
        .map(|item| item.vault_id.clone())
        .collect();
    selected_vault_ids.sort_unstable();
    selected_vault_ids.dedup();
    let user_vaults = if selected_vault_ids.is_empty() {
        Vec::new()
    } else {
        query_as::<_, DbBootstrapVaultAccessRow>(
            "SELECT vk.vault_id, v.name AS vault_name, v.type::text AS vault_type, v.icon AS vault_icon, v.image_key AS vault_image_key, vk.encrypted_vault_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 AND vk.vault_id = ANY($2)",
        )
        .bind(user_id)
        .bind(&selected_vault_ids)
        .fetch_all(pool)
        .await
        .map_err(|e| { tracing::error!(error = %e, "Failed to load bounded bootstrap vault summaries"); AppError::internal("Failed to load user vaults") })?
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
            .map(|item| {
                let attachments = attachments_by_item
                    .get(&item.id)
                    .cloned()
                    .unwrap_or_default();
                let vault = vault_map.get(&item.vault_id).cloned();
                BootstrapItemResponse::compose(item.into(), attachments, vault)
            })
            .collect(),
        next_cursor,
        sync_cursor,
        has_more,
    })
}

pub(crate) fn timestamp_millis(value: OffsetDateTime) -> i64 {
    (value.unix_timestamp_nanos() / 1_000_000) as i64
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
        Err(AppError::bad_request("Invalid resource ID"))
    }
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
                AppError::internal("Failed to parse sync event metadata")
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
        AppError::internal("Failed to serialize sync event")
    })?;
    Ok(Event::default().event(event_name).data(data))
}

pub(crate) fn sse_heartbeat_event() -> Result<Event, AppError> {
    Ok(Event::default().comment(format!(
        "heartbeat {}",
        timestamp_millis(OffsetDateTime::now_utc())
    )))
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

    Ok(resolve_attachment_entitlement(mode, actor.billing_plan, actor.billing_status).enabled)
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
            .push(BootstrapAttachmentResponse::compose(attachment.into()));
    }

    Ok(grouped)
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
