use std::collections::HashMap;

use serde_json::json;
use sqlx::{query, query_as, query_scalar, PgPool, Postgres, Transaction};
use time::OffsetDateTime;

use super::{
    access::{
        assert_item_read_access, find_item_row, find_vault_access, insert_item_sync_event,
        load_vault_access,
    },
    attachments::load_item_attachments,
    pagination::{bounded_page_ids, ByteBoundedPage, ItemPageWeight, ITEM_PAGE_QUERY_BYTES},
};
use super::{
    CreateItemEffectInput, DeletedVaultItemWithVaultResponse, FavoriteItemEffectInput,
    ImportItemsOperationInput, ItemEffect, ItemEffectInput, ItemIdInput, MoveItemEffectInput,
    UpdateItemEffectInput, VaultIdInput, VaultItemDetailsResponse, VaultItemResponse,
    VaultItemWithVaultResponse, VaultSummaryResponse,
};
use crate::{
    config::DeploymentMode,
    db::events::{
        begin_sync_event_transaction, generate_resource_id, insert_audit_event, insert_sync_event,
        insert_user_sync_event,
    },
    db::{
        enums::{OperationRejectionCode, SyncEntityType, SyncEventType},
        models::{DbBootstrapItemRow, DbBootstrapVaultAccessRow, BOOTSTRAP_ITEM_COLUMNS},
    },
    domains::billing::entitlements::attachments_enabled_for_user,
    domains::operations::{
        import_items_operation_fingerprint, import_items_rejection_code, ImportItemsAppliedPayload,
        ImportItemsOperationResult, OperationResolution,
    },
    error::AppError,
    integrations::storage,
    shared::transaction::{acquire_operation_lock, database_error},
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
) -> Result<ItemEffect, AppError> {
    let mut rejection = if input.encrypted_data.len() > input.ciphertext_limit {
        Some(OperationRejectionCode::InvalidCiphertext)
    } else {
        writable_vault_rejection(
            &mut **transaction,
            &input.vault_id,
            user_id,
            OperationRejectionCode::VaultAccessDenied,
            OperationRejectionCode::VaultReadOnly,
        )
        .await?
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
            rejection = Some(OperationRejectionCode::ItemIdConflict);
        }
    }

    if let Some(code) = rejection {
        return reject_item_operation(
            transaction,
            "item_create_rejected",
            &input.item_id,
            user_id,
            Some(&input.vault_id),
            code,
        )
        .await;
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
    Ok(ItemEffect::Applied {
        item_id: input.item_id,
        version,
    })
}

/// Runs one Import batch to a terminal answer, exactly once per `(User, Operation ID)`.
///
/// Import retains an applied *payload* rather than an entity identity and version, so it follows
/// the create-Vault Operation shape: validate, fingerprint, lock the Operation, probe the retained
/// answer, then apply or reject inside the one transaction that also writes `operation_resolved`.
/// The Vault access check lives inside that transaction on purpose — a check taken outside it
/// could let one replay answer differently from the batch it is replaying.
pub(crate) async fn execute_import_items_operation(
    pool: &PgPool,
    user_id: &str,
    input: ImportItemsOperationInput,
) -> Result<OperationResolution, AppError> {
    let fingerprint = import_items_operation_fingerprint(&input.vault_id, &input.raw_body);
    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start Import Operation"))?;
    acquire_operation_lock(
        &mut *transaction,
        user_id,
        &input.operation_id,
        "Failed to serialize Import Operation",
    )
    .await?;
    if let Some(existing) = query_as::<_, (Vec<u8>,)>(
        "SELECT request_fingerprint FROM operation_outcome WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(&input.operation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to load Import outcome"))?
    {
        if existing.0 != fingerprint {
            transaction.rollback().await.ok();
            return Ok(OperationResolution::IdReused);
        }
        transaction
            .commit()
            .await
            .map_err(|error| database_error(error, "Failed to replay Import outcome"))?;
        let outcome =
            crate::domains::operations::get_operation_outcome(pool, user_id, &input.operation_id)
                .await?
                .ok_or_else(|| AppError::internal("Retained Import outcome disappeared"))?;
        return Ok(OperationResolution::Outcome {
            outcome,
            newly_committed: false,
        });
    }

    let result = apply_import_items(&mut transaction, user_id, &input, &fingerprint).await?;
    insert_user_sync_event(
        &mut transaction,
        SyncEventType::OperationResolved,
        &input.operation_id,
        SyncEntityType::Operation,
        user_id,
        1,
        input.client_id.as_deref(),
        None,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Import Operation"))?;
    Ok(OperationResolution::Outcome {
        outcome: crate::domains::operations::OperationOutcome::new_import_items(
            input.operation_id,
            result,
        ),
        newly_committed: true,
    })
}

/// Decides one Import batch inside the caller's Operation transaction and retains the answer.
///
/// Every refusal here is a terminal semantic rejection, never a transport error: the request was
/// well formed and authenticated, and the Server decided. Only a database failure leaves through
/// `Err`, and that rolls the whole Operation back without retaining anything.
async fn apply_import_items(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    input: &ImportItemsOperationInput,
    fingerprint: &[u8; 32],
) -> Result<ImportItemsOperationResult, AppError> {
    let mut rejection = if input
        .items
        .iter()
        .any(|item| oversized(Some(&item.encrypted_data), input.ciphertext_limit))
    {
        Some(OperationRejectionCode::InvalidCiphertext)
    } else {
        writable_vault_rejection(
            &mut **transaction,
            &input.vault_id,
            user_id,
            OperationRejectionCode::VaultAccessDenied,
            OperationRejectionCode::VaultReadOnly,
        )
        .await?
    };

    if rejection.is_none() && !input.items.is_empty() {
        // One statement inserts the whole batch, and a savepoint keeps it all-or-nothing.
        //
        // `ON CONFLICT DO NOTHING` answers both ways an identity can already be taken: an Item
        // that exists in any Vault, and a second occurrence of the same ID inside these frozen
        // bytes. The Server cannot tell those apart at commit time and must not answer one
        // collision two ways, so both are `ItemIdConflict` — a retained, replayable decision
        // rather than a request error the Runtime would retry forever. Anything skipped means the
        // batch is not the complete set the caller asked for, so the savepoint discards the rest.
        let mut batch = sqlx::Acquire::begin(&mut **transaction)
            .await
            .map_err(|error| database_error(error, "Failed to open the Import batch savepoint"))?;
        let inserted = query(
            r#"INSERT INTO item (id, vault_id, category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, encryption_version, encrypted_by_user_id, last_modified_by)
            SELECT draft.id, $1, draft.category::item_category, draft.favorite, draft.encrypted_data, draft.encryption_iv, draft.encryption_algorithm, 1, 1, $2, $2
            FROM UNNEST($3::text[], $4::text[], $5::bool[], $6::text[], $7::text[], $8::text[])
                AS draft(id, category, favorite, encrypted_data, encryption_iv, encryption_algorithm)
            ON CONFLICT (id) DO NOTHING"#,
        )
        .bind(&input.vault_id)
        .bind(user_id)
        .bind(input.items.iter().map(|item| item.item_id.clone()).collect::<Vec<_>>())
        .bind(input.items.iter().map(|item| item.category.as_str().to_owned()).collect::<Vec<_>>())
        .bind(input.items.iter().map(|item| item.favorite.unwrap_or(false)).collect::<Vec<_>>())
        .bind(input.items.iter().map(|item| item.encrypted_data.clone()).collect::<Vec<_>>())
        .bind(input.items.iter().map(|item| item.encryption_iv.clone()).collect::<Vec<_>>())
        .bind(input.items.iter().map(|item| item.encryption_algorithm.clone()).collect::<Vec<_>>())
        .execute(&mut *batch)
        .await
        .map_err(|error| database_error(error, "Failed to import Vault Items"))?;
        if inserted.rows_affected() == input.items.len() as u64 {
            batch
                .commit()
                .await
                .map_err(|error| database_error(error, "Failed to close the Import batch"))?;
        } else {
            batch.rollback().await.map_err(|error| {
                database_error(error, "Failed to discard the conflicted Import batch")
            })?;
            rejection = Some(OperationRejectionCode::ItemIdConflict);
        }
    }

    if let Some(code) = rejection {
        // The rejection audit row every sibling Operation writes: `vault_create_rejected` in
        // `catalog.rs`, `share_create_rejected` in `operations/mod.rs`, `item_create_rejected`
        // above. It records that the Server decided and why.
        //
        // It is on the Operation, not on the Vault, and its action is not `vault_updated`. That
        // keeps it strictly separate from the applied batch's Vault audit row, so "an applied
        // empty batch writes no audit and no `vault_updated`" stays exactly true.
        insert_audit_event(
            &mut **transaction,
            &generate_resource_id("audit"),
            user_id,
            "item_import_rejected",
            "operation",
            &input.operation_id,
            Some(json!({ "vaultId": input.vault_id, "code": code.as_str() })),
        )
        .await?;
        query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, $2, 'import_items', $3, 'rejected', $4::operation_rejection_code)",
        )
        .bind(user_id)
        .bind(&input.operation_id)
        .bind(fingerprint.as_slice())
        .bind(code)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to retain rejected Import outcome"))?;
        return Ok(ImportItemsOperationResult::Rejected {
            code: import_items_rejection_code(code)?,
        });
    }

    let imported_count = input.items.len();
    // An applied empty batch is a decision about the Vault, not a change to it: no Item moved, so
    // no audit row and no `vault_updated` may claim one did.
    if imported_count > 0 {
        let metadata = json!({ "reason": "bulk_import", "importedCount": imported_count });
        insert_bulk_import_sync_event(
            transaction,
            &input.vault_id,
            user_id,
            input.client_id.as_deref(),
            metadata.clone(),
        )
        .await?;
        insert_bulk_import_audit_event(
            &mut **transaction,
            "vault_updated",
            &input.vault_id,
            user_id,
            metadata,
        )
        .await?;
    }
    let imported_count = i32::try_from(imported_count)
        .map_err(|_| AppError::internal("Import batch size is out of range"))?;
    let payload = serde_json::to_value(ImportItemsAppliedPayload {
        vault_id: input.vault_id.clone(),
        imported_count,
    })
    .map_err(|_| AppError::internal("Failed to encode Import outcome"))?;
    query(
        "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, applied_payload) VALUES ($1, $2, 'import_items', $3, 'applied', $4)",
    )
    .bind(user_id)
    .bind(&input.operation_id)
    .bind(fingerprint.as_slice())
    .bind(payload)
    .execute(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to retain applied Import outcome"))?;
    Ok(ImportItemsOperationResult::Applied {
        vault_id: input.vault_id.clone(),
        imported_count,
    })
}

/// Reads the authoritative state of an explicit set of Item identities inside one Vault.
///
/// Ordered by identity so one page's last ID is a cursor the next page strictly advances past.
/// Identities outside this Vault, and identities that do not exist, simply do not answer.
pub(crate) async fn list_vault_item_authority_page(
    pool: &PgPool,
    user_id: &str,
    vault_id: &str,
    item_ids: &[String],
    after_id: Option<&str>,
    limit: i64,
) -> Result<Vec<VaultItemResponse>, AppError> {
    assert_item_read_access(pool, vault_id, user_id).await?;
    let rows = query_as::<_, DbBootstrapItemRow>(&format!(
        "SELECT {BOOTSTRAP_ITEM_COLUMNS} FROM item WHERE vault_id = $1 AND id = ANY($2) AND ($3::text IS NULL OR id > $3) ORDER BY id LIMIT $4"
    ))
    .bind(vault_id)
    .bind(item_ids)
    .bind(after_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load the Item authority page"))?;
    Ok(rows
        .into_iter()
        .map(|row| VaultItemResponse::compose(row.into()))
        .collect())
}

/// Applies one Item update inside the caller's Operation transaction, or proves why it cannot.
///
/// Every refusal on this path is a terminal semantic rejection, never a transport error: the
/// request was well formed and authenticated, and the Server decided. Only a database failure
/// leaves through `Err`, and that rolls the whole Operation back without retaining anything.
pub(crate) async fn apply_update_item(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    input: UpdateItemEffectInput,
) -> Result<ItemEffect, AppError> {
    const REJECTED: &str = "item_update_rejected";
    if oversized(input.encrypted_data.as_deref(), input.ciphertext_limit) {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            None,
            OperationRejectionCode::InvalidCiphertext,
        )
        .await;
    }
    let Some(existing_item) = find_item_row(&mut **transaction, &input.item_id).await? else {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            None,
            OperationRejectionCode::ItemNotFound,
        )
        .await;
    };
    if let Some(code) = writable_vault_rejection(
        &mut **transaction,
        &existing_item.vault_id,
        user_id,
        OperationRejectionCode::VaultAccessDenied,
        OperationRejectionCode::VaultReadOnly,
    )
    .await?
    {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            code,
        )
        .await;
    }

    let updates_ciphertext = input.encrypted_data.is_some()
        || input.encryption_iv.is_some()
        || input.encryption_algorithm.is_some();
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
	.bind(input.expected_version)
	.fetch_optional(&mut **transaction)
	.await
	.map_err(|error| database_error(error, "Failed to update item"))?;
    let Some(new_version) = new_version else {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            OperationRejectionCode::ItemVersionConflict,
        )
        .await;
    };
    insert_item_sync_event(
        transaction,
        SyncEventType::ItemUpdated,
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;

    Ok(ItemEffect::Applied {
        item_id: input.item_id,
        version: new_version,
    })
}

/// Whether a ciphertext the caller supplied exceeds the Item ciphertext budget.
pub(super) fn oversized(value: Option<&str>, limit: usize) -> bool {
    value.is_some_and(|value| value.len() > limit)
}

/// The Vault-level refusal that stops a write, if there is one.
async fn writable_vault_rejection<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    vault_id: &str,
    user_id: &str,
    denied: OperationRejectionCode,
    read_only: OperationRejectionCode,
) -> Result<Option<OperationRejectionCode>, AppError> {
    Ok(
        match find_vault_access(executor, vault_id, user_id).await? {
            None => Some(denied),
            Some(access) if !access.role.can_write() => Some(read_only),
            Some(_) => None,
        },
    )
}

/// Records the rejection audit that proves the Server decided, and reports the closed code.
async fn reject_item_operation(
    transaction: &mut Transaction<'_, Postgres>,
    action: &str,
    item_id: &str,
    user_id: &str,
    vault_id: Option<&str>,
    code: OperationRejectionCode,
) -> Result<ItemEffect, AppError> {
    let metadata = match vault_id {
        Some(vault_id) => json!({ "vaultId": vault_id, "code": code }),
        None => json!({ "code": code }),
    };
    insert_item_audit_log(&mut **transaction, action, item_id, user_id, Some(metadata)).await?;
    Ok(ItemEffect::Rejected(code))
}

/// Applies one favorite change inside the caller's Operation transaction, or proves why it cannot.
pub(crate) async fn apply_set_item_favorite(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    input: FavoriteItemEffectInput,
) -> Result<ItemEffect, AppError> {
    const REJECTED: &str = "item_favorite_rejected";
    let Some(existing_item) = find_item_row(&mut **transaction, &input.item_id).await? else {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            None,
            OperationRejectionCode::ItemNotFound,
        )
        .await;
    };
    if let Some(code) = writable_vault_rejection(
        &mut **transaction,
        &existing_item.vault_id,
        user_id,
        OperationRejectionCode::VaultAccessDenied,
        OperationRejectionCode::VaultReadOnly,
    )
    .await?
    {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            code,
        )
        .await;
    }

    let new_version = query_scalar::<_, i32>(
        "UPDATE item SET favorite = $1, version = version + 1, updated_at = $2 WHERE id = $3 AND version = $4 RETURNING version",
    )
        .bind(input.favorite)
        .bind(OffsetDateTime::now_utc())
        .bind(&input.item_id)
        .bind(input.expected_version)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to update favorite state"))?;
    let Some(new_version) = new_version else {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            OperationRejectionCode::ItemVersionConflict,
        )
        .await;
    };
    insert_item_sync_event(
        transaction,
        SyncEventType::ItemUpdated,
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;

    Ok(ItemEffect::Applied {
        item_id: input.item_id,
        version: new_version,
    })
}

/// Moves one Item to the Trash inside the caller's Operation transaction, or proves why it cannot.
pub(crate) async fn apply_trash_item(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    input: ItemEffectInput,
) -> Result<ItemEffect, AppError> {
    const REJECTED: &str = "item_delete_rejected";
    let Some(existing_item) = find_item_row(&mut **transaction, &input.item_id).await? else {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            None,
            OperationRejectionCode::ItemNotFound,
        )
        .await;
    };
    if let Some(code) = writable_vault_rejection(
        &mut **transaction,
        &existing_item.vault_id,
        user_id,
        OperationRejectionCode::VaultAccessDenied,
        OperationRejectionCode::VaultReadOnly,
    )
    .await?
    {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            code,
        )
        .await;
    }

    let new_version = query_scalar::<_, i32>(
        "UPDATE item SET deleted_at = $1, version = version + 1, last_modified_by = $2, updated_at = $3 WHERE id = $4 AND version = $5 RETURNING version",
    )
        .bind(OffsetDateTime::now_utc())
        .bind(user_id)
        .bind(OffsetDateTime::now_utc())
        .bind(&input.item_id)
        .bind(input.expected_version)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete item"))?;
    let Some(new_version) = new_version else {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            OperationRejectionCode::ItemVersionConflict,
        )
        .await;
    };
    insert_item_sync_event(
        transaction,
        SyncEventType::ItemDeleted,
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;
    insert_item_audit_log(
        &mut **transaction,
        "item_deleted",
        &input.item_id,
        user_id,
        Some(json!({ "vaultId": existing_item.vault_id, "version": new_version })),
    )
    .await?;

    Ok(ItemEffect::Applied {
        item_id: input.item_id,
        version: new_version,
    })
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

/// Restores one trashed Item inside the caller's Operation transaction, or proves why it cannot.
pub(crate) async fn apply_restore_item(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    input: ItemEffectInput,
) -> Result<ItemEffect, AppError> {
    const REJECTED: &str = "item_restore_rejected";
    let Some(existing_item) = find_item_row(&mut **transaction, &input.item_id).await? else {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            None,
            OperationRejectionCode::ItemNotFound,
        )
        .await;
    };
    if existing_item.deleted_at.is_none() {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            OperationRejectionCode::ItemNotTrashed,
        )
        .await;
    }
    if let Some(code) = writable_vault_rejection(
        &mut **transaction,
        &existing_item.vault_id,
        user_id,
        OperationRejectionCode::VaultAccessDenied,
        OperationRejectionCode::VaultReadOnly,
    )
    .await?
    {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            code,
        )
        .await;
    }

    let new_version = query_scalar::<_, i32>(
        "UPDATE item SET deleted_at = NULL, version = version + 1, last_modified_by = $1, updated_at = $2 WHERE id = $3 AND version = $4 RETURNING version",
    )
    .bind(user_id)
    .bind(OffsetDateTime::now_utc())
    .bind(&input.item_id)
    .bind(input.expected_version)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to restore item"))?;
    let Some(new_version) = new_version else {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            OperationRejectionCode::ItemVersionConflict,
        )
        .await;
    };
    insert_item_sync_event(
        transaction,
        SyncEventType::ItemRestored,
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;
    insert_item_audit_log(
        &mut **transaction,
        "item_restored",
        &input.item_id,
        user_id,
        Some(json!({ "vaultId": existing_item.vault_id, "version": new_version })),
    )
    .await?;

    Ok(ItemEffect::Applied {
        item_id: input.item_id,
        version: new_version,
    })
}

async fn reject_move_operation(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    operation_id: &str,
    has_staging: bool,
    item_id: &str,
    vault_id: Option<&str>,
    code: OperationRejectionCode,
) -> Result<ItemEffect, AppError> {
    if has_staging {
        enqueue_attachment_move_staging_cleanup(transaction, user_id, operation_id).await?;
    }
    delete_attachment_move_generation(transaction, user_id, operation_id).await?;
    reject_item_operation(
        transaction,
        "item_move_rejected",
        item_id,
        user_id,
        vault_id,
        code,
    )
    .await
}

/// Moves one Item between Vaults inside the caller's Operation transaction, or proves why it cannot.
///
/// A move is the one Item Operation with two Vaults, so the destination keeps its own refusals.
/// Collapsing them into the source codes would tell a client to look at the wrong Vault.
pub(crate) async fn apply_move_item(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    input: MoveItemEffectInput,
) -> Result<ItemEffect, AppError> {
    crate::shared::transaction::acquire_item_attachment_writer_lock(
        &mut **transaction,
        &input.item_id,
        "Failed to lock Item Attachment writer",
    )
    .await?;
    let has_staging = query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2)",
    )
    .bind(user_id)
    .bind(&input.operation_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to inspect Attachment Move staging"))?;
    let prepared = match &input.finalization {
        super::MoveItemFinalizationInput::Prepared {
            encrypted_data,
            encryption_iv,
            encryption_algorithm,
            attachments,
        } => Some((
            encrypted_data,
            encryption_iv,
            encryption_algorithm,
            attachments,
        )),
        super::MoveItemFinalizationInput::RejectStaleAuthority { .. } => None,
    };
    if prepared.is_some_and(|(encrypted_data, _, _, _)| {
        oversized(Some(encrypted_data), input.ciphertext_limit)
    }) {
        return reject_move_operation(
            transaction,
            user_id,
            &input.operation_id,
            has_staging,
            &input.item_id,
            None,
            OperationRejectionCode::InvalidCiphertext,
        )
        .await;
    }
    let Some(existing_item) = find_item_row(&mut **transaction, &input.item_id).await? else {
        return reject_move_operation(
            transaction,
            user_id,
            &input.operation_id,
            has_staging,
            &input.item_id,
            None,
            OperationRejectionCode::ItemNotFound,
        )
        .await;
    };
    if existing_item.vault_id != input.source_vault_id {
        return reject_move_operation(
            transaction,
            user_id,
            &input.operation_id,
            has_staging,
            &input.item_id,
            Some(&existing_item.vault_id),
            OperationRejectionCode::SourceVaultMismatch,
        )
        .await;
    }
    if existing_item.deleted_at.is_some() {
        return reject_move_operation(
            transaction,
            user_id,
            &input.operation_id,
            has_staging,
            &input.item_id,
            Some(&existing_item.vault_id),
            OperationRejectionCode::ItemTrashed,
        )
        .await;
    }
    if let Some(code) = writable_vault_rejection(
        &mut **transaction,
        &input.source_vault_id,
        user_id,
        OperationRejectionCode::VaultAccessDenied,
        OperationRejectionCode::VaultReadOnly,
    )
    .await?
    {
        return reject_move_operation(
            transaction,
            user_id,
            &input.operation_id,
            has_staging,
            &input.item_id,
            Some(&input.source_vault_id),
            code,
        )
        .await;
    }
    if let Some(code) = writable_vault_rejection(
        &mut **transaction,
        &input.target_vault_id,
        user_id,
        OperationRejectionCode::TargetVaultAccessDenied,
        OperationRejectionCode::TargetVaultReadOnly,
    )
    .await?
    {
        return reject_move_operation(
            transaction,
            user_id,
            &input.operation_id,
            has_staging,
            &input.item_id,
            Some(&input.target_vault_id),
            code,
        )
        .await;
    }

    let current_attachments = query_as::<_, (String, i32, String)>(
        "SELECT id, envelope_version, storage_key FROM item_attachment WHERE item_id = $1 ORDER BY id FOR UPDATE",
    )
    .bind(&input.item_id)
    .fetch_all(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to lock Move Attachments"))?;
    let mut expected_attachments = match &input.finalization {
        super::MoveItemFinalizationInput::Prepared { attachments, .. } => attachments
            .iter()
            .map(|attachment| {
                (
                    attachment.attachment_id.clone(),
                    attachment.expected_envelope_version,
                )
            })
            .collect::<Vec<_>>(),
        super::MoveItemFinalizationInput::RejectStaleAuthority { attachments } => attachments
            .iter()
            .map(|attachment| {
                (
                    attachment.attachment_id.clone(),
                    attachment.expected_envelope_version,
                )
            })
            .collect::<Vec<_>>(),
    };
    expected_attachments.sort();
    let current_identity = current_attachments
        .iter()
        .map(|(id, version, _)| (id.clone(), *version))
        .collect::<Vec<_>>();
    if matches!(
        &input.finalization,
        super::MoveItemFinalizationInput::RejectStaleAuthority { .. }
    ) {
        if existing_item.version != input.expected_version {
            return reject_move_operation(
                transaction,
                user_id,
                &input.operation_id,
                has_staging,
                &input.item_id,
                Some(&input.source_vault_id),
                OperationRejectionCode::ItemVersionConflict,
            )
            .await;
        }
        if current_identity != expected_attachments {
            return reject_move_operation(
                transaction,
                user_id,
                &input.operation_id,
                has_staging,
                &input.item_id,
                Some(&input.source_vault_id),
                OperationRejectionCode::AttachmentStateConflict,
            )
            .await;
        }
        return Err(AppError::attachment_staging_incomplete(
            "Attachment Move preparation is still required.",
        ));
    }
    let manifest = query_as::<_, (String, String, String)>(
        "SELECT item_id, source_vault_id, target_vault_id FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2 AND expires_at > $3",
    )
    .bind(user_id)
    .bind(&input.operation_id)
    .bind(OffsetDateTime::now_utc())
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to validate Attachment Move manifest"))?;
    let (_, _, _, attachments) = prepared.expect("prepared Move checked above");
    if !attachments.is_empty() {
        let manifest_attachments = query_as::<_, (String, i32)>(
            "SELECT attachment_id, expected_envelope_version FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2 ORDER BY attachment_id",
        )
        .bind(user_id)
        .bind(&input.operation_id)
        .fetch_all(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to validate Attachment Move intent"))?;
        let Some((manifest_item_id, manifest_source_id, manifest_target_id)) = manifest else {
            return Err(AppError::attachment_staging_incomplete(
                "Attachment Move staging is missing, expired, or incomplete.",
            ));
        };
        let manifest_intent_matches = manifest_item_id == input.item_id
            && manifest_source_id == input.source_vault_id
            && manifest_target_id == input.target_vault_id
            && manifest_attachments == expected_attachments;
        if !manifest_intent_matches {
            return Err(AppError::attachment_staging_mismatch(
                "Attachment Move Finalize intent does not match its manifest.",
            ));
        }
    }
    if current_identity != expected_attachments {
        return reject_move_operation(
            transaction,
            user_id,
            &input.operation_id,
            has_staging,
            &input.item_id,
            Some(&input.source_vault_id),
            OperationRejectionCode::AttachmentStateConflict,
        )
        .await;
    }
    let (encrypted_data, encryption_iv, encryption_algorithm, attachments) =
        prepared.expect("prepared Move checked above");
    let new_version = query_scalar::<_, i32>(
		"UPDATE item SET vault_id = $1, encrypted_data = $2, encryption_iv = $3, encryption_algorithm = $4, version = version + 1, encryption_version = version + 1, encrypted_by_user_id = $5, last_modified_by = $5, updated_at = $6 WHERE id = $7 AND version = $8 RETURNING version",
	)
	.bind(&input.target_vault_id)
	.bind(encrypted_data)
	.bind(encryption_iv)
	.bind(encryption_algorithm)
	.bind(user_id)
	.bind(OffsetDateTime::now_utc())
	.bind(&input.item_id)
	.bind(input.expected_version)
	.fetch_optional(&mut **transaction)
	.await
	.map_err(|error| database_error(error, "Failed to move item"))?;
    let Some(new_version) = new_version else {
        return reject_move_operation(
            transaction,
            user_id,
            &input.operation_id,
            has_staging,
            &input.item_id,
            Some(&input.source_vault_id),
            OperationRejectionCode::ItemVersionConflict,
        )
        .await;
    };
    for attachment in attachments {
        let staged = query_as::<_, (String, i64)>(
            "SELECT storage_key, storage_size FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2 AND attachment_id = $3 AND expected_envelope_version = $4",
        )
        .bind(user_id)
        .bind(&input.operation_id)
        .bind(&attachment.attachment_id)
        .bind(attachment.expected_envelope_version)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to resolve staged Attachment"))?;
        let Some((staged_storage_key, staged_storage_size)) = staged else {
            return Err(AppError::internal(
                "Verified Attachment Move staging disappeared",
            ));
        };
        let updated = query(
            "UPDATE item_attachment SET vault_id = $1, storage_key = $2, encrypted_attachment_key = $3, attachment_key_iv = $4, attachment_key_algorithm = $5, envelope_version = envelope_version + 1, encrypted_name = $6, encrypted_content_type = $7, encryption_iv = $8, encrypted_content_type_iv = $9, encryption_algorithm = $10, storage_size = $11 WHERE id = $12 AND item_id = $13 AND envelope_version = $14",
        )
        .bind(&input.target_vault_id)
        .bind(staged_storage_key)
        .bind(&attachment.encrypted_attachment_key)
        .bind(&attachment.attachment_key_iv)
        .bind(&attachment.attachment_key_algorithm)
        .bind(&attachment.encrypted_name)
        .bind(&attachment.encrypted_content_type)
        .bind(&attachment.encryption_iv)
        .bind(&attachment.encrypted_content_type_iv)
        .bind(&attachment.encryption_algorithm)
        .bind(staged_storage_size)
        .bind(&attachment.attachment_id)
        .bind(&input.item_id)
        .bind(attachment.expected_envelope_version)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to finalize staged Attachment"))?;
        if updated.rows_affected() != 1 {
            return Err(AppError::internal(
                "Locked Attachment Move authority changed",
            ));
        }
    }
    for (_, _, old_storage_key) in &current_attachments {
        query("INSERT INTO attachment_move_cleanup (user_id, operation_id, storage_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING")
            .bind(user_id)
            .bind(&input.operation_id)
            .bind(old_storage_key)
            .execute(&mut **transaction)
            .await
            .map_err(|error| database_error(error, "Failed to enqueue old Attachment cleanup"))?;
    }
    if !attachments.is_empty() {
        query("DELETE FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2")
            .bind(user_id)
            .bind(&input.operation_id)
            .execute(&mut **transaction)
            .await
            .map_err(|error| database_error(error, "Failed to consume Attachment Move staging"))?;
        query("DELETE FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2")
            .bind(user_id)
            .bind(&input.operation_id)
            .execute(&mut **transaction)
            .await
            .map_err(|error| database_error(error, "Failed to close Attachment Move manifest"))?;
    }
    delete_attachment_move_generation(transaction, user_id, &input.operation_id).await?;
    insert_item_sync_event_with_metadata(
        transaction,
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
        &mut **transaction,
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

    Ok(ItemEffect::Applied {
        item_id: input.item_id,
        version: new_version,
    })
}

async fn delete_attachment_move_generation(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    operation_id: &str,
) -> Result<(), AppError> {
    query(
        "DELETE FROM attachment_move_staging_generation WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(operation_id)
    .execute(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to close Attachment Move generation"))?;
    Ok(())
}

async fn enqueue_attachment_move_staging_cleanup(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    operation_id: &str,
) -> Result<(), AppError> {
    query(
        "INSERT INTO attachment_move_cleanup (user_id, operation_id, storage_key) SELECT user_id, operation_id, storage_key FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2 ON CONFLICT DO NOTHING",
    )
    .bind(user_id)
    .bind(operation_id)
    .execute(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to enqueue staged Attachment cleanup"))?;
    query("DELETE FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2")
        .bind(user_id)
        .bind(operation_id)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to close rejected Attachment Move"))?;
    Ok(())
}

/// Deletes one trashed Item forever inside the caller's Operation transaction, or proves why it cannot.
pub(crate) async fn apply_permanently_delete_item(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    input: ItemEffectInput,
) -> Result<ItemEffect, AppError> {
    const REJECTED: &str = "item_permanent_delete_rejected";
    let Some(existing_item) = find_item_row(&mut **transaction, &input.item_id).await? else {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            None,
            OperationRejectionCode::ItemNotFound,
        )
        .await;
    };
    if existing_item.deleted_at.is_none() {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            OperationRejectionCode::ItemNotTrashed,
        )
        .await;
    }
    if let Some(code) = writable_vault_rejection(
        &mut **transaction,
        &existing_item.vault_id,
        user_id,
        OperationRejectionCode::VaultAccessDenied,
        OperationRejectionCode::VaultReadOnly,
    )
    .await?
    {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            code,
        )
        .await;
    }

    let deleted_version = query_scalar::<_, i32>(
        "DELETE FROM item WHERE id = $1 AND version = $2 RETURNING version + 1",
    )
    .bind(&input.item_id)
    .bind(input.expected_version)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to permanently delete item"))?;
    let Some(deleted_version) = deleted_version else {
        return reject_item_operation(
            transaction,
            REJECTED,
            &input.item_id,
            user_id,
            Some(&existing_item.vault_id),
            OperationRejectionCode::ItemVersionConflict,
        )
        .await;
    };
    insert_item_sync_event(
        transaction,
        SyncEventType::ItemPermanentlyDeleted,
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        deleted_version,
    )
    .await?;
    insert_item_audit_log(
        &mut **transaction,
        "item_permanently_deleted",
        &input.item_id,
        user_id,
        Some(json!({ "vaultId": existing_item.vault_id, "version": deleted_version })),
    )
    .await?;

    Ok(ItemEffect::Applied {
        item_id: input.item_id,
        version: deleted_version,
    })
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
