use std::collections::HashMap;

use serde_json::json;
use sqlx::{query, query_as, query_scalar, PgPool, Postgres, Transaction};
use time::OffsetDateTime;

use super::{
    access::{
        assert_item_read_access, assert_item_write_access, find_vault_access,
        insert_item_sync_event, load_item_row, load_vault_access,
    },
    attachments::load_item_attachments,
    pagination::{bounded_page_ids, ByteBoundedPage, ItemPageWeight, ITEM_PAGE_QUERY_BYTES},
};
use super::{
    BulkImportItemsInput, BulkImportItemsResponse, CreateItemEffect, CreateItemEffectInput,
    DeletedVaultItemWithVaultResponse, ItemClientInput, ItemIdInput, MoveItemInput,
    SuccessResponse, ToggleFavoriteInput, UpdateItemInput, UpdateItemResponse, VaultIdInput,
    VaultItemDetailsResponse, VaultItemResponse, VaultItemWithVaultResponse, VaultSummaryResponse,
};
use crate::{
    config::DeploymentMode,
    db::events::{
        begin_sync_event_transaction, generate_resource_id, insert_audit_event, insert_sync_event,
    },
    db::{
        enums::{CreateItemRejectionCode, SyncEntityType, SyncEventType},
        models::{DbBootstrapItemRow, DbBootstrapVaultAccessRow, BOOTSTRAP_ITEM_COLUMNS},
    },
    domains::billing::entitlements::attachments_enabled_for_user,
    error::AppError,
    integrations::storage,
    shared::transaction::database_error,
};

pub(crate) async fn list_vault_items_page(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: VaultIdInput,
    cursor: Option<(OffsetDateTime, String)>,
    limit: i64,
) -> Result<ByteBoundedPage<VaultItemDetailsResponse>, AppError> {
    let _access = load_vault_access(pool, &input.vault_id, user_id).await?;
    let cursor_timestamp = cursor.as_ref().map(|(timestamp, _)| *timestamp);
    let cursor_id = cursor.as_ref().map(|(_, id)| id.as_str());
    let weights = query_as::<_, ItemPageWeight>(
        r#"WITH candidates AS (
            SELECT i.id,
                   ROW_NUMBER() OVER (ORDER BY i.updated_at DESC, i.id DESC)::bigint AS position,
                   (16384 + octet_length(i.id) + octet_length(i.vault_id) + octet_length(i.category::text)
                    + octet_length(i.encrypted_data) + octet_length(i.encryption_iv)
                    + octet_length(i.encryption_algorithm) + octet_length(i.last_modified_by)
                    + coalesce((SELECT sum(1024 + octet_length(a.id) + octet_length(a.item_id)
                        + octet_length(a.vault_id) + octet_length(a.storage_key) + octet_length(a.encrypted_name)
                        + octet_length(a.encrypted_content_type) + octet_length(a.encryption_iv)
                        + coalesce(octet_length(a.encrypted_content_type_iv), 0)
                        + octet_length(a.encryption_algorithm) + coalesce(octet_length(a.uploaded_by), 0))
                      FROM item_attachment a WHERE a.item_id = i.id), 0))::bigint AS estimated_bytes
            FROM item i
            WHERE i.vault_id = $1 AND i.deleted_at IS NULL
              AND ($2::timestamptz IS NULL OR (i.updated_at, i.id) < ($2, $3))
            ORDER BY i.updated_at DESC, i.id DESC
            LIMIT $4
        ), weighted AS (
            SELECT id, position, count(*) OVER ()::bigint AS candidate_count,
                   sum(estimated_bytes) OVER (ORDER BY position)::bigint AS cumulative_bytes
            FROM candidates
        )
        SELECT id, position, candidate_count, cumulative_bytes FROM weighted
        WHERE cumulative_bytes <= $5 OR position = 1 ORDER BY position"#,
    )
    .bind(&input.vault_id)
    .bind(cursor_timestamp)
    .bind(cursor_id)
    .bind(limit)
    .bind(ITEM_PAGE_QUERY_BYTES)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load vault item page"))?;
    let (item_ids, source_has_more) = bounded_page_ids(
        weights,
        ITEM_PAGE_QUERY_BYTES,
        "A single item exceeds the response page byte budget.",
    )?;
    if item_ids.is_empty() {
        return Ok(ByteBoundedPage {
            values: Vec::new(),
            has_more: false,
        });
    }
    let item_rows = query_as::<_, DbBootstrapItemRow>(&format!(
        "SELECT {BOOTSTRAP_ITEM_COLUMNS} FROM item WHERE id = ANY($1) ORDER BY array_position($1::text[], id)"
    ))
    .bind(&item_ids)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to materialize bounded vault item page"))?;
    let attachments_enabled = attachments_enabled_for_user(pool, user_id, deployment_mode).await?;
    let attachments_by_item = if attachments_enabled {
        load_item_attachments(pool, &item_rows).await?
    } else {
        HashMap::new()
    };

    let values = item_rows
        .into_iter()
        .map(|item| VaultItemDetailsResponse {
            attachments: attachments_by_item
                .get(&item.id)
                .cloned()
                .unwrap_or_default(),
            ..map_item_details(item)
        })
        .collect();
    Ok(ByteBoundedPage {
        values,
        has_more: source_has_more,
    })
}

pub(crate) async fn list_all_vault_items_page(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    deployment_mode: DeploymentMode,
    user_id: &str,
    cursor: Option<(OffsetDateTime, String)>,
    limit: i64,
) -> Result<ByteBoundedPage<VaultItemWithVaultResponse>, AppError> {
    let cursor_timestamp = cursor.as_ref().map(|(timestamp, _)| *timestamp);
    let cursor_id = cursor.as_ref().map(|(_, id)| id.as_str());
    let weights = query_as::<_, ItemPageWeight>(
        r#"WITH candidates AS (
            SELECT i.id,
                   ROW_NUMBER() OVER (ORDER BY i.updated_at DESC, i.id DESC)::bigint AS position,
                   (20480 + octet_length(i.id) + octet_length(i.vault_id) + octet_length(i.category::text)
                    + octet_length(i.encrypted_data) + octet_length(i.encryption_iv)
                    + octet_length(i.encryption_algorithm) + octet_length(i.last_modified_by)
                    + coalesce((SELECT sum(1024 + octet_length(a.id) + octet_length(a.item_id)
                        + octet_length(a.vault_id) + octet_length(a.storage_key) + octet_length(a.encrypted_name)
                        + octet_length(a.encrypted_content_type) + octet_length(a.encryption_iv)
                        + coalesce(octet_length(a.encrypted_content_type_iv), 0)
                        + octet_length(a.encryption_algorithm) + coalesce(octet_length(a.uploaded_by), 0))
                      FROM item_attachment a WHERE a.item_id = i.id), 0)
                    + coalesce((SELECT octet_length(v.name) + coalesce(octet_length(v.icon), 0)
                        + coalesce(octet_length(v.image_key), 0) + octet_length(v.type::text)
                        + octet_length(vk.encrypted_vault_key) + octet_length(vk.role::text)
                      FROM vault v JOIN vault_key vk ON vk.vault_id = v.id
                      WHERE v.id = i.vault_id AND vk.user_id = $1 LIMIT 1), 4096))::bigint AS estimated_bytes
            FROM item i
            WHERE EXISTS (SELECT 1 FROM vault_key access WHERE access.vault_id = i.vault_id AND access.user_id = $1)
              AND i.deleted_at IS NULL
              AND ($2::timestamptz IS NULL OR (i.updated_at, i.id) < ($2, $3))
            ORDER BY i.updated_at DESC, i.id DESC
            LIMIT $4
        ), weighted AS (
            SELECT id, position, count(*) OVER ()::bigint AS candidate_count,
                   sum(estimated_bytes) OVER (ORDER BY position)::bigint AS cumulative_bytes
            FROM candidates
        )
        SELECT id, position, candidate_count, cumulative_bytes FROM weighted
        WHERE cumulative_bytes <= $5 OR position = 1 ORDER BY position"#,
    )
    .bind(user_id)
    .bind(cursor_timestamp)
    .bind(cursor_id)
    .bind(limit)
    .bind(ITEM_PAGE_QUERY_BYTES)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load item page"))?;
    let (item_ids, source_has_more) = bounded_page_ids(
        weights,
        ITEM_PAGE_QUERY_BYTES,
        "A single item exceeds the response page byte budget.",
    )?;
    if item_ids.is_empty() {
        return Ok(ByteBoundedPage {
            values: Vec::new(),
            has_more: false,
        });
    }
    let item_rows = query_as::<_, DbBootstrapItemRow>(&format!(
        "SELECT {BOOTSTRAP_ITEM_COLUMNS} FROM item WHERE id = ANY($1) ORDER BY array_position($1::text[], id)"
    ))
    .bind(&item_ids)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to materialize bounded item page"))?;
    let attachments_enabled = attachments_enabled_for_user(pool, user_id, deployment_mode).await?;
    let attachments_by_item = if attachments_enabled {
        load_item_attachments(pool, &item_rows).await?
    } else {
        HashMap::new()
    };
    let selected_vault_ids = distinct_item_vault_ids(&item_rows);
    let vault_map = build_vault_summary_map(
        object_storage,
        load_user_vault_summaries(pool, user_id, &selected_vault_ids).await?,
    );

    let values = item_rows
        .into_iter()
        .map(|item| {
            let attachments = attachments_by_item
                .get(&item.id)
                .cloned()
                .unwrap_or_default();
            let vault = vault_map.get(&item.vault_id).cloned();
            VaultItemWithVaultResponse::compose(item.into(), attachments, vault)
        })
        .collect();
    Ok(ByteBoundedPage {
        values,
        has_more: source_has_more,
    })
}

pub(crate) async fn list_all_deleted_vault_items_page(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    cursor: Option<(OffsetDateTime, String)>,
    limit: i64,
) -> Result<ByteBoundedPage<DeletedVaultItemWithVaultResponse>, AppError> {
    let cursor_timestamp = cursor.as_ref().map(|(timestamp, _)| *timestamp);
    let cursor_id = cursor.as_ref().map(|(_, id)| id.as_str());
    let weights = query_as::<_, ItemPageWeight>(
        r#"WITH candidates AS (
            SELECT i.id,
                   ROW_NUMBER() OVER (ORDER BY i.deleted_at DESC, i.id DESC)::bigint AS position,
                   (20480 + octet_length(i.id) + octet_length(i.vault_id) + octet_length(i.category::text)
                    + octet_length(i.encrypted_data) + octet_length(i.encryption_iv)
                    + octet_length(i.encryption_algorithm) + octet_length(i.last_modified_by)
                    + coalesce((SELECT octet_length(v.name) + coalesce(octet_length(v.icon), 0)
                        + coalesce(octet_length(v.image_key), 0) + octet_length(v.type::text)
                        + octet_length(vk.encrypted_vault_key) + octet_length(vk.role::text)
                      FROM vault v JOIN vault_key vk ON vk.vault_id = v.id
                      WHERE v.id = i.vault_id AND vk.user_id = $1 LIMIT 1), 4096))::bigint AS estimated_bytes
            FROM item i
            WHERE EXISTS (SELECT 1 FROM vault_key access WHERE access.vault_id = i.vault_id AND access.user_id = $1)
              AND i.deleted_at IS NOT NULL
              AND ($2::timestamptz IS NULL OR (i.deleted_at, i.id) < ($2, $3))
            ORDER BY i.deleted_at DESC, i.id DESC
            LIMIT $4
        ), weighted AS (
            SELECT id, position, count(*) OVER ()::bigint AS candidate_count,
                   sum(estimated_bytes) OVER (ORDER BY position)::bigint AS cumulative_bytes
            FROM candidates
        )
        SELECT id, position, candidate_count, cumulative_bytes FROM weighted
        WHERE cumulative_bytes <= $5 OR position = 1 ORDER BY position"#,
    )
    .bind(user_id)
    .bind(cursor_timestamp)
    .bind(cursor_id)
    .bind(limit)
    .bind(ITEM_PAGE_QUERY_BYTES)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load deleted item page"))?;
    let (item_ids, source_has_more) = bounded_page_ids(
        weights,
        ITEM_PAGE_QUERY_BYTES,
        "A single item exceeds the response page byte budget.",
    )?;
    if item_ids.is_empty() {
        return Ok(ByteBoundedPage {
            values: Vec::new(),
            has_more: false,
        });
    }
    let item_rows = query_as::<_, DbBootstrapItemRow>(&format!(
        "SELECT {BOOTSTRAP_ITEM_COLUMNS} FROM item WHERE id = ANY($1) ORDER BY array_position($1::text[], id)"
    ))
    .bind(&item_ids)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to materialize bounded deleted item page"))?;
    let selected_vault_ids = distinct_item_vault_ids(&item_rows);
    let vault_map = build_vault_summary_map(
        object_storage,
        load_user_vault_summaries(pool, user_id, &selected_vault_ids).await?,
    );

    let values = item_rows
        .into_iter()
        .map(|item| {
            let vault = vault_map.get(&item.vault_id).cloned();
            DeletedVaultItemWithVaultResponse::compose(item.into(), vault)
        })
        .collect();
    Ok(ByteBoundedPage {
        values,
        has_more: source_has_more,
    })
}

pub(crate) async fn get_vault_item(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: ItemIdInput,
) -> Result<VaultItemDetailsResponse, AppError> {
    let item_row = query_as::<_, DbBootstrapItemRow>(&format!(
        "SELECT {BOOTSTRAP_ITEM_COLUMNS} FROM item WHERE id = $1 LIMIT 1"
    ))
    .bind(&input.item_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load item"))?
    .ok_or_else(|| AppError::not_found("Item not found"))?;
    assert_item_read_access(pool, &item_row.vault_id, user_id).await?;
    let attachments_enabled = attachments_enabled_for_user(pool, user_id, deployment_mode).await?;
    let attachments_by_item = if attachments_enabled {
        load_item_attachments(pool, std::slice::from_ref(&item_row)).await?
    } else {
        HashMap::new()
    };

    Ok(VaultItemDetailsResponse {
        attachments: attachments_by_item
            .get(&item_row.id)
            .cloned()
            .unwrap_or_default(),
        ..map_item_details(item_row)
    })
}

pub(crate) async fn apply_create_item(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    input: CreateItemEffectInput,
) -> Result<CreateItemEffect, AppError> {
    let access = find_vault_access(&mut **transaction, &input.vault_id, user_id).await?;
    let mut rejection = if input.encrypted_data.len() > input.ciphertext_limit {
        Some(CreateItemRejectionCode::InvalidCiphertext)
    } else {
        match access {
            None => Some(CreateItemRejectionCode::VaultAccessDenied),
            Some(access) if !access.role.can_write() => {
                Some(CreateItemRejectionCode::VaultReadOnly)
            }
            Some(_) => None,
        }
    };

    if rejection.is_none() {
        let inserted = query(
            "INSERT INTO item (id, vault_id, category, encrypted_data, encryption_iv, encryption_algorithm, version, encryption_version, encrypted_by_user_id, last_modified_by) VALUES ($1, $2, $3::item_category, $4, $5, $6, 1, 1, $7, $7) ON CONFLICT (id) DO NOTHING",
        )
        .bind(&input.item_id)
        .bind(&input.vault_id)
        .bind(input.category)
        .bind(&input.encrypted_data)
        .bind(&input.encryption_iv)
        .bind(&input.encryption_algorithm)
        .bind(user_id)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to create Item"))?;
        if inserted.rows_affected() == 0 {
            rejection = Some(CreateItemRejectionCode::ItemIdConflict);
        }
    }

    if let Some(code) = rejection {
        insert_item_audit_log(
            &mut **transaction,
            "item_create_rejected",
            &input.item_id,
            user_id,
            Some(json!({ "vaultId": input.vault_id, "code": code })),
        )
        .await?;
        return Ok(CreateItemEffect::Rejected(code));
    }

    let version = 1;
    insert_item_audit_log(
        &mut **transaction,
        "item_created",
        &input.item_id,
        user_id,
        Some(json!({ "vaultId": input.vault_id, "category": input.category })),
    )
    .await?;
    insert_item_sync_event(
        transaction,
        SyncEventType::ItemCreated,
        &input.item_id,
        &input.vault_id,
        user_id,
        input.client_id.as_deref(),
        version,
    )
    .await?;
    Ok(CreateItemEffect::Applied {
        item_id: input.item_id,
        version,
    })
}

pub(crate) async fn bulk_import_vault_items(
    pool: &PgPool,
    user_id: &str,
    input: BulkImportItemsInput,
) -> Result<BulkImportItemsResponse, AppError> {
    let access = load_vault_access(pool, &input.vault_id, user_id).await?;
    assert_item_write_access(access.role, "Read-only access cannot create items")?;
    if input.items.is_empty() {
        return Ok(BulkImportItemsResponse {
            success: true,
            imported_count: 0,
            item_ids: Vec::new(),
        });
    }
    if input.items.len() > 200 {
        return Err(AppError::bad_request(
            "Cannot import more than 200 items at once",
        ));
    }

    let item_ids: Vec<String> = input
        .items
        .iter()
        .map(|item| item.item_id.clone())
        .collect();
    let unique_ids: std::collections::HashSet<&str> =
        item_ids.iter().map(std::string::String::as_str).collect();
    if unique_ids.len() != item_ids.len() {
        return Err(AppError::bad_request(
            "Duplicate item IDs in import payload",
        ));
    }

    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start bulk import transaction"))?;
    for item in &input.items {
        query(
			"INSERT INTO item (id, vault_id, category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, encryption_version, encrypted_by_user_id, last_modified_by) VALUES ($1, $2, $3::item_category, $4, $5, $6, $7, 1, 1, $8, $8)",
		)
		.bind(&item.item_id)
		.bind(&input.vault_id)
		.bind(item.category)
		.bind(item.favorite.unwrap_or(false))
		.bind(&item.encrypted_data)
		.bind(&item.encryption_iv)
		.bind(&item.encryption_algorithm)
		.bind(user_id)
		.execute(&mut *transaction)
		.await
		.map_err(|error| database_error(error, "Failed to import vault items"))?;
    }
    insert_bulk_import_sync_event(
        &mut transaction,
        &input.vault_id,
        user_id,
        input.client_id.as_deref(),
        json!({ "reason": "bulk_import", "importedCount": item_ids.len() }),
    )
    .await?;
    insert_bulk_import_audit_event(
        &mut *transaction,
        "vault_updated",
        &input.vault_id,
        user_id,
        json!({ "reason": "bulk_import", "importedCount": item_ids.len() }),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit bulk import"))?;

    Ok(BulkImportItemsResponse {
        success: true,
        imported_count: item_ids.len(),
        item_ids,
    })
}

pub(crate) async fn update_vault_item(
    pool: &PgPool,
    user_id: &str,
    input: UpdateItemInput,
) -> Result<UpdateItemResponse, AppError> {
    let existing_item = load_item_row(pool, &input.item_id).await?;
    let access = load_vault_access(pool, &existing_item.vault_id, user_id).await?;
    assert_item_write_access(access.role, "Access denied")?;
    let expected_version = input.expected_version.unwrap_or(existing_item.version);
    let updates_ciphertext = input.encrypted_data.is_some()
        || input.encryption_iv.is_some()
        || input.encryption_algorithm.is_some();

    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start item update transaction"))?;
    let new_version = query_scalar::<_, i32>(
		"UPDATE item SET encrypted_data = COALESCE($1, encrypted_data), encryption_iv = COALESCE($2, encryption_iv), encryption_algorithm = COALESCE($3, encryption_algorithm), version = version + 1, encryption_version = CASE WHEN $4 THEN version + 1 ELSE encryption_version END, encrypted_by_user_id = CASE WHEN $4 THEN $5 ELSE encrypted_by_user_id END, last_modified_by = $5, updated_at = $6 WHERE id = $7 AND version = $8 RETURNING version",
	)
	.bind(input.encrypted_data.as_deref())
	.bind(input.encryption_iv.as_deref())
	.bind(input.encryption_algorithm.as_deref())
	.bind(updates_ciphertext)
	.bind(user_id)
	.bind(OffsetDateTime::now_utc())
	.bind(&input.item_id)
	.bind(expected_version)
	.fetch_optional(&mut *transaction)
	.await
	.map_err(|error| database_error(error, "Failed to update item"))?
    .ok_or_else(item_version_conflict)?;
    insert_item_sync_event(
        &mut transaction,
        SyncEventType::ItemUpdated,
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit item update"))?;

    Ok(UpdateItemResponse {
        success: true,
        version: new_version,
    })
}

fn item_version_conflict() -> AppError {
    AppError::conflict("Item has been modified by another client")
}

pub(crate) async fn toggle_vault_favorite(
    pool: &PgPool,
    user_id: &str,
    input: ToggleFavoriteInput,
) -> Result<SuccessResponse, AppError> {
    let existing_item = load_item_row(pool, &input.item_id).await?;
    let access = load_vault_access(pool, &existing_item.vault_id, user_id).await?;
    assert_item_write_access(access.role, "Access denied")?;

    let expected_version = input.expected_version.unwrap_or(existing_item.version);
    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start favorite update transaction"))?;
    let new_version = query_scalar::<_, i32>(
        "UPDATE item SET favorite = $1, version = version + 1, updated_at = $2 WHERE id = $3 AND version = $4 RETURNING version",
    )
        .bind(input.favorite)
        .bind(OffsetDateTime::now_utc())
        .bind(&input.item_id)
        .bind(expected_version)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to update favorite state"))?
        .ok_or_else(item_version_conflict)?;
    insert_item_sync_event(
        &mut transaction,
        SyncEventType::ItemUpdated,
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit favorite update"))?;

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn delete_vault_item(
    pool: &PgPool,
    user_id: &str,
    input: ItemClientInput,
) -> Result<SuccessResponse, AppError> {
    let existing_item = load_item_row(pool, &input.item_id).await?;
    let access = load_vault_access(pool, &existing_item.vault_id, user_id).await?;
    assert_item_write_access(access.role, "Access denied")?;
    let expected_version = input.expected_version.unwrap_or(existing_item.version);

    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start item delete transaction"))?;
    let new_version = query_scalar::<_, i32>(
        "UPDATE item SET deleted_at = $1, version = version + 1, last_modified_by = $2, updated_at = $3 WHERE id = $4 AND version = $5 RETURNING version",
    )
        .bind(OffsetDateTime::now_utc())
        .bind(user_id)
        .bind(OffsetDateTime::now_utc())
        .bind(&input.item_id)
        .bind(expected_version)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete item"))?
        .ok_or_else(item_version_conflict)?;
    insert_item_sync_event(
        &mut transaction,
        SyncEventType::ItemDeleted,
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;
    insert_item_audit_log(
        &mut *transaction,
        "item_deleted",
        &input.item_id,
        user_id,
        Some(json!({ "vaultId": existing_item.vault_id, "version": new_version })),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit item delete"))?;

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn list_deleted_vault_items_page(
    pool: &PgPool,
    user_id: &str,
    input: VaultIdInput,
    cursor: Option<(OffsetDateTime, String)>,
    limit: i64,
) -> Result<ByteBoundedPage<VaultItemResponse>, AppError> {
    let _access = load_vault_access(pool, &input.vault_id, user_id).await?;
    let cursor_timestamp = cursor.as_ref().map(|(timestamp, _)| *timestamp);
    let cursor_id = cursor.as_ref().map(|(_, id)| id.as_str());
    let weights = query_as::<_, ItemPageWeight>(
        r#"WITH candidates AS (
            SELECT i.id,
                   ROW_NUMBER() OVER (ORDER BY i.deleted_at DESC, i.id DESC)::bigint AS position,
                   (16384 + octet_length(i.id) + octet_length(i.vault_id) + octet_length(i.category::text)
                    + octet_length(i.encrypted_data) + octet_length(i.encryption_iv)
                    + octet_length(i.encryption_algorithm) + octet_length(i.last_modified_by))::bigint AS estimated_bytes
            FROM item i
            WHERE i.vault_id = $1 AND i.deleted_at IS NOT NULL
              AND ($2::timestamptz IS NULL OR (i.deleted_at, i.id) < ($2, $3))
            ORDER BY i.deleted_at DESC, i.id DESC
            LIMIT $4
        ), weighted AS (
            SELECT id, position, count(*) OVER ()::bigint AS candidate_count,
                   sum(estimated_bytes) OVER (ORDER BY position)::bigint AS cumulative_bytes
            FROM candidates
        )
        SELECT id, position, candidate_count, cumulative_bytes FROM weighted
        WHERE cumulative_bytes <= $5 OR position = 1 ORDER BY position"#,
    )
    .bind(&input.vault_id)
    .bind(cursor_timestamp)
    .bind(cursor_id)
    .bind(limit)
    .bind(ITEM_PAGE_QUERY_BYTES)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load deleted item page"))?;

    let (item_ids, source_has_more) = bounded_page_ids(
        weights,
        ITEM_PAGE_QUERY_BYTES,
        "A single item exceeds the response page byte budget.",
    )?;
    if item_ids.is_empty() {
        return Ok(ByteBoundedPage {
            values: Vec::new(),
            has_more: false,
        });
    }
    let item_rows = query_as::<_, DbBootstrapItemRow>(&format!(
        "SELECT {BOOTSTRAP_ITEM_COLUMNS} FROM item WHERE id = ANY($1) ORDER BY array_position($1::text[], id)"
    ))
    .bind(&item_ids)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to materialize bounded deleted vault item page"))?;

    Ok(ByteBoundedPage {
        values: item_rows.into_iter().map(map_item).collect(),
        has_more: source_has_more,
    })
}

pub(crate) async fn restore_vault_item(
    pool: &PgPool,
    user_id: &str,
    input: ItemClientInput,
) -> Result<SuccessResponse, AppError> {
    let existing_item = load_item_row(pool, &input.item_id).await?;
    if existing_item.deleted_at.is_none() {
        return Err(AppError::bad_request("Item is not deleted"));
    }
    let access = load_vault_access(pool, &existing_item.vault_id, user_id).await?;
    assert_item_write_access(access.role, "Access denied")?;
    let expected_version = input.expected_version.unwrap_or(existing_item.version);

    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start item restore transaction"))?;
    let new_version = query_scalar::<_, i32>(
        "UPDATE item SET deleted_at = NULL, version = version + 1, last_modified_by = $1, updated_at = $2 WHERE id = $3 AND version = $4 RETURNING version",
    )
    .bind(user_id)
    .bind(OffsetDateTime::now_utc())
    .bind(&input.item_id)
    .bind(expected_version)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to restore item"))?
    .ok_or_else(item_version_conflict)?;
    insert_item_sync_event(
        &mut transaction,
        SyncEventType::ItemRestored,
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;
    insert_item_audit_log(
        &mut *transaction,
        "item_restored",
        &input.item_id,
        user_id,
        Some(json!({ "vaultId": existing_item.vault_id, "version": new_version })),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit item restore"))?;

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn move_vault_item(
    pool: &PgPool,
    user_id: &str,
    input: MoveItemInput,
) -> Result<UpdateItemResponse, AppError> {
    let existing_item = load_item_row(pool, &input.item_id).await?;
    if existing_item.vault_id != input.source_vault_id {
        return Err(AppError::bad_request(
            "Item does not belong to the source vault",
        ));
    }
    if existing_item.deleted_at.is_some() {
        return Err(AppError::bad_request(
            "Cannot move items that are in trash. Restore first.",
        ));
    }
    let source_access = load_vault_access(pool, &input.source_vault_id, user_id).await?;
    assert_item_write_access(
        source_access.role,
        "Cannot move items from a read-only vault",
    )?;
    let target_access = load_vault_access(pool, &input.target_vault_id, user_id).await?;
    assert_item_write_access(target_access.role, "Cannot move items to a read-only vault")?;
    let expected_version = input.expected_version.unwrap_or(existing_item.version);

    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start item move transaction"))?;
    let new_version = query_scalar::<_, i32>(
		"UPDATE item SET vault_id = $1, encrypted_data = $2, encryption_iv = $3, encryption_algorithm = $4, version = version + 1, encryption_version = version + 1, encrypted_by_user_id = $5, last_modified_by = $5, updated_at = $6 WHERE id = $7 AND version = $8 RETURNING version",
	)
	.bind(&input.target_vault_id)
	.bind(&input.encrypted_data)
	.bind(&input.encryption_iv)
	.bind(&input.encryption_algorithm)
	.bind(user_id)
	.bind(OffsetDateTime::now_utc())
	.bind(&input.item_id)
	.bind(expected_version)
	.fetch_optional(&mut *transaction)
	.await
	.map_err(|error| database_error(error, "Failed to move item"))?
    .ok_or_else(item_version_conflict)?;
    insert_item_sync_event_with_metadata(
        &mut transaction,
        SyncEventType::ItemMoved,
        &input.item_id,
        &input.target_vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
        json!({ "sourceVaultId": input.source_vault_id }),
    )
    .await?;
    insert_item_audit_log(
        &mut *transaction,
        "item_moved",
        &input.item_id,
        user_id,
        Some(json!({
            "sourceVaultId": input.source_vault_id,
            "targetVaultId": input.target_vault_id,
            "version": new_version,
        })),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit item move"))?;

    Ok(UpdateItemResponse {
        success: true,
        version: new_version,
    })
}

pub(crate) async fn permanently_delete_vault_item(
    pool: &PgPool,
    user_id: &str,
    input: ItemClientInput,
) -> Result<SuccessResponse, AppError> {
    let existing_item = load_item_row(pool, &input.item_id).await?;
    if existing_item.deleted_at.is_none() {
        return Err(AppError::bad_request(
            "Can only permanently delete items in trash",
        ));
    }
    let access = load_vault_access(pool, &existing_item.vault_id, user_id).await?;
    assert_item_write_access(access.role, "Access denied")?;
    let expected_version = input.expected_version.unwrap_or(existing_item.version);

    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start permanent delete transaction"))?;
    let deleted_version = query_scalar::<_, i32>(
        "DELETE FROM item WHERE id = $1 AND version = $2 RETURNING version + 1",
    )
    .bind(&input.item_id)
    .bind(expected_version)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to permanently delete item"))?
    .ok_or_else(item_version_conflict)?;
    insert_item_sync_event(
        &mut transaction,
        SyncEventType::ItemPermanentlyDeleted,
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        deleted_version,
    )
    .await?;
    insert_item_audit_log(
        &mut *transaction,
        "item_permanently_deleted",
        &input.item_id,
        user_id,
        Some(json!({ "vaultId": existing_item.vault_id, "version": deleted_version })),
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit permanent delete"))?;

    Ok(SuccessResponse { success: true })
}

async fn insert_bulk_import_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    insert_sync_event(
        transaction,
        SyncEventType::VaultUpdated,
        vault_id,
        SyncEntityType::Vault,
        vault_id,
        user_id,
        1,
        client_id,
        Some(&metadata.to_string()),
    )
    .await
}

async fn insert_bulk_import_audit_event<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    action: &str,
    vault_id: &str,
    user_id: &str,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    insert_audit_event(
        executor,
        &generate_resource_id("audit"),
        user_id,
        action,
        "vault",
        vault_id,
        Some(metadata),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn insert_item_sync_event_with_metadata(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: SyncEventType,
    item_id: &str,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    version: i32,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    insert_sync_event(
        transaction,
        event_type,
        item_id,
        SyncEntityType::Item,
        vault_id,
        user_id,
        version,
        client_id,
        Some(&metadata.to_string()),
    )
    .await
}

async fn insert_item_audit_log<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    action: &str,
    item_id: &str,
    user_id: &str,
    metadata: Option<serde_json::Value>,
) -> Result<(), AppError> {
    insert_audit_event(
        executor,
        &generate_resource_id("audit"),
        user_id,
        action,
        "item",
        item_id,
        metadata,
    )
    .await
}

fn map_item(item: DbBootstrapItemRow) -> VaultItemResponse {
    VaultItemResponse::compose(item.into())
}

fn map_item_details(item: DbBootstrapItemRow) -> VaultItemDetailsResponse {
    VaultItemDetailsResponse::compose(item.into(), Vec::new())
}

fn build_vault_summary_map(
    object_storage: &dyn storage::ObjectStorage,
    vaults: Vec<DbBootstrapVaultAccessRow>,
) -> HashMap<String, VaultSummaryResponse> {
    vaults
        .into_iter()
        .map(|vault| {
            (
                vault.vault_id.clone(),
                VaultSummaryResponse {
                    id: vault.vault_id,
                    name: vault.vault_name,
                    vault_type: vault.vault_type,
                    icon: vault.vault_icon,
                    image_url: vault
                        .vault_image_key
                        .as_deref()
                        .and_then(|key| object_storage.public_url(key)),
                    encrypted_vault_key: vault.encrypted_vault_key,
                    role: vault.role,
                },
            )
        })
        .collect()
}

async fn load_user_vault_summaries(
    pool: &PgPool,
    user_id: &str,
    vault_ids: &[String],
) -> Result<Vec<DbBootstrapVaultAccessRow>, AppError> {
    if vault_ids.is_empty() {
        return Ok(Vec::new());
    }
    query_as::<_, DbBootstrapVaultAccessRow>(
        "SELECT vk.vault_id, v.name AS vault_name, v.type::text AS vault_type, v.icon AS vault_icon, v.image_key AS vault_image_key, vk.encrypted_vault_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 AND vk.vault_id = ANY($2)",
    )
    .bind(user_id)
    .bind(vault_ids)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load user vaults"))
}

fn distinct_item_vault_ids(items: &[DbBootstrapItemRow]) -> Vec<String> {
    let mut vault_ids: Vec<String> = items.iter().map(|item| item.vault_id.clone()).collect();
    vault_ids.sort_unstable();
    vault_ids.dedup();
    vault_ids
}
