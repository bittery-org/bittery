use std::collections::HashMap;

use sqlx::{query, query_as, query_scalar, PgPool};
use time::OffsetDateTime;

use super::{
    access::{assert_item_write_access, insert_item_sync_event, load_item_row, load_vault_access},
    AttachmentDownloadResponse, AttachmentIdInput, CreateAttachmentInput, CreateAttachmentResponse,
    CreateAttachmentUploadInput, CreateAttachmentUploadResponse, ItemIdInput, SuccessResponse,
    UpdateAttachmentInput, VaultAttachmentResponse,
};
use crate::{
    config::bittery_mode,
    db::{
        enums::{SyncEventType, VaultRole},
        models::{DbBootstrapAttachmentRow, DbBootstrapItemRow},
    },
    error::AppError,
    integrations::storage,
    repo::common::generate_resource_id,
    services::team_billing::{load_team_billing_entitlement, resolve_attachment_entitlement},
};

const ATTACHMENT_ENVELOPE_VERSION: i32 = 1;

#[derive(Debug, sqlx::FromRow)]
struct DbPendingAttachmentReservationRow {
    id: String,
    attachment_id: String,
    file_size: i32,
    storage_size: i32,
}

#[derive(Debug, sqlx::FromRow)]
struct DbScopedAttachmentAccessRow {
    item_id: String,
    vault_id: String,
    storage_key: String,
    encrypted_name: String,
    encrypted_content_type: String,
    encryption_iv: String,
    encrypted_content_type_iv: String,
    encryption_algorithm: String,
    file_size: i32,
    uploaded_by: String,
    role: VaultRole,
}

struct AttachmentActor {
    team_id: String,
    attachment_max_file_size_bytes: Option<i64>,
    attachment_storage_bytes: Option<i64>,
}

pub(crate) async fn create_vault_attachment_upload(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    input: CreateAttachmentUploadInput,
) -> Result<CreateAttachmentUploadResponse, AppError> {
    if input.file_name.trim().is_empty()
        || input.content_type.trim().is_empty()
        || input.file_size <= 0
    {
        return Err(AppError::bad_request("Invalid attachment upload request"));
    }
    let actor = load_attachment_actor(pool, user_id).await?;
    let scoped_item = load_item_row(pool, &input.item_id).await?;
    let access = load_vault_access(pool, &scoped_item.vault_id, user_id).await?;
    assert_item_write_access(access.role, "Access denied")?;
    if let Some(max_bytes) = actor.attachment_max_file_size_bytes {
        if i64::from(input.file_size) > max_bytes {
            return Err(AppError::bad_request(
                "Attachment file exceeds the maximum allowed size for your current plan.",
            ));
        }
    }
    let key = storage::create_attachment_key(user_id, &input.item_id, &input.file_name).map_err(
        |error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        },
    )?;
    let storage_size = encrypted_attachment_storage_size(input.file_size);
    let now = OffsetDateTime::now_utc();
    let expires_at = pending_attachment_upload_expiry(now);

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start attachment upload transaction");
        AppError::internal("Failed to start attachment upload transaction")
    })?;
    query("SELECT pg_advisory_xact_lock(hashtext($1))")
        .bind(attachment_quota_lock_key(&actor.team_id))
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to lock attachment quota");
            AppError::internal("Failed to lock attachment quota")
        })?;
    let committed_usage = query_scalar::<_, i64>(
		"SELECT COALESCE(SUM(ia.storage_size), 0)::bigint FROM item_attachment ia INNER JOIN \"user\" u ON ia.uploaded_by = u.id WHERE u.team_id = $1",
	)
	.bind(&actor.team_id)
	.fetch_one(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load attachment usage"); AppError::internal("Failed to load attachment usage") })?;
    let pending_usage = query_scalar::<_, i64>(
		"SELECT COALESCE(SUM(storage_size), 0)::bigint FROM pending_attachment_upload WHERE team_id = $1 AND consumed_at IS NULL AND expires_at > $2",
	)
	.bind(&actor.team_id)
	.bind(now)
	.fetch_one(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load pending attachment usage"); AppError::internal("Failed to load pending attachment usage") })?;
    let current_usage = committed_usage + pending_usage;
    if let Some(quota_bytes) = actor.attachment_storage_bytes {
        if current_usage + i64::from(storage_size) > quota_bytes {
            return Err(AppError::forbidden(
                "Attachment storage quota has been reached for your current plan.",
            ));
        }
    }
    let attachment_id = generate_resource_id("attachment");
    query(
		"INSERT INTO pending_attachment_upload (id, attachment_id, team_id, vault_id, item_id, storage_key, file_size, storage_size, content_type, created_by, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
	)
	.bind(generate_resource_id("attachment_pending"))
	.bind(&attachment_id)
	.bind(&actor.team_id)
	.bind(&scoped_item.vault_id)
	.bind(&input.item_id)
	.bind(&key)
	.bind(input.file_size)
	.bind(storage_size)
	.bind(&input.content_type)
	.bind(user_id)
	.bind(expires_at)
	.bind(now)
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to reserve attachment upload"); AppError::internal("Failed to reserve attachment upload") })?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit attachment upload reservation");
        AppError::internal("Failed to commit attachment upload reservation")
    })?;

    let upload = object_storage
        .presign_upload(
            &key,
            &input.content_type,
            Some(i64::from(storage_size)),
            None,
        )
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })?;
    Ok(CreateAttachmentUploadResponse {
        attachment_id,
        storage_key: upload.key,
        upload_url: upload.upload_url,
    })
}

pub(crate) async fn create_vault_attachment(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    request_client_id: Option<&str>,
    input: CreateAttachmentInput,
) -> Result<CreateAttachmentResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id).await?;
    let scoped_item = load_item_row(pool, &input.item_id).await?;
    let access = load_vault_access(pool, &scoped_item.vault_id, user_id).await?;
    assert_item_write_access(access.role, "Access denied")?;
    if input.envelope_version != ATTACHMENT_ENVELOPE_VERSION {
        return Err(AppError::bad_request(
            "Unsupported attachment envelope version",
        ));
    }
    let is_valid_key =
        storage::is_valid_attachment_upload_key(&input.storage_key, user_id, &input.item_id, None)
            .map_err(|error| {
                tracing::error!(error = %error, "Internal error");
                AppError::internal("An internal error occurred")
            })?;
    if !is_valid_key {
        return Err(AppError::bad_request(
            "Invalid or expired attachment upload key",
        ));
    }
    let Some(reservation) =
        load_pending_attachment_reservation(pool, &input.storage_key, &input.item_id, user_id)
            .await?
    else {
        return Err(AppError::bad_request(
            "Invalid or expired attachment upload reservation",
        ));
    };
    if reservation.file_size != input.file_size {
        return Err(AppError::bad_request(
            "Attachment metadata does not match the reserved upload.",
        ));
    }
    if reservation.attachment_id != input.attachment_id {
        return Err(AppError::bad_request(
            "Attachment metadata does not match the reserved upload.",
        ));
    }
    let Some(uploaded_object) = object_storage
        .head(&input.storage_key)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })?
    else {
        return Err(AppError::bad_request(
            "Uploaded attachment does not match the reserved encrypted size.",
        ));
    };
    if uploaded_object.size != i64::from(reservation.storage_size) {
        return Err(AppError::bad_request(
            "Uploaded attachment does not match the reserved encrypted size.",
        ));
    }
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start attachment create transaction");
        AppError::internal("Failed to start attachment create transaction")
    })?;
    query(
		"INSERT INTO item_attachment (id, item_id, vault_id, storage_key, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm, envelope_version, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, storage_size, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
	)
	.bind(&input.attachment_id)
	.bind(&input.item_id)
	.bind(&scoped_item.vault_id)
	.bind(&input.storage_key)
	.bind(&input.encrypted_attachment_key)
	.bind(&input.attachment_key_iv)
	.bind(&input.attachment_key_algorithm)
	.bind(input.envelope_version)
	.bind(&input.encrypted_name)
	.bind(&input.encrypted_content_type)
	.bind(&input.encryption_iv)
	.bind(&input.encrypted_content_type_iv)
	.bind(&input.encryption_algorithm)
	.bind(reservation.file_size)
	.bind(reservation.storage_size)
	.bind(user_id)
	.bind(OffsetDateTime::now_utc())
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create attachment"); AppError::internal("Failed to create attachment") })?;
    query("UPDATE pending_attachment_upload SET consumed_at = $1 WHERE id = $2")
        .bind(OffsetDateTime::now_utc())
        .bind(&reservation.id)
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to consume attachment reservation");
            AppError::internal("Failed to consume attachment reservation")
        })?;
    insert_item_sync_event(
        &mut *transaction,
        SyncEventType::ItemUpdated,
        &input.item_id,
        &scoped_item.vault_id,
        user_id,
        request_client_id,
        scoped_item.version,
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit attachment create");
        AppError::internal("Failed to commit attachment create")
    })?;

    Ok(CreateAttachmentResponse {
        attachment_id: input.attachment_id,
    })
}

pub(crate) async fn list_vault_attachments_page(
    pool: &PgPool,
    user_id: &str,
    input: ItemIdInput,
    cursor: Option<(OffsetDateTime, String)>,
    limit: i64,
) -> Result<Vec<VaultAttachmentResponse>, AppError> {
    let _actor = load_attachment_actor(pool, user_id).await?;
    let scoped_item = load_item_row(pool, &input.item_id).await?;
    let _access = load_vault_access(pool, &scoped_item.vault_id, user_id).await?;
    let cursor_timestamp = cursor.as_ref().map(|(timestamp, _)| *timestamp);
    let cursor_id = cursor.as_ref().map(|(_, id)| id.as_str());
    let attachment_rows = query_as::<_, DbBootstrapAttachmentRow>(
		"SELECT id, item_id, vault_id, storage_key, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm, envelope_version, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, uploaded_by, created_at FROM item_attachment WHERE item_id = $1 AND ($2::timestamptz IS NULL OR (created_at, id) > ($2, $3)) ORDER BY created_at ASC, id ASC LIMIT $4",
    )
    .bind(&input.item_id)
    .bind(cursor_timestamp)
    .bind(cursor_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load item attachment page");
        AppError::internal("Failed to load item attachments")
    })?;
    Ok(attachment_rows.into_iter().map(map_attachment).collect())
}

pub(crate) async fn get_attachment_download_url(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    input: AttachmentIdInput,
) -> Result<AttachmentDownloadResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id).await?;
    let attachment = load_attachment_access(pool, &input.attachment_id, user_id).await?;
    let download_url = object_storage
        .presign_download(&attachment.storage_key, Some(300))
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })?;
    Ok(AttachmentDownloadResponse {
        download_url,
        encrypted_name: attachment.encrypted_name,
        encrypted_content_type: attachment.encrypted_content_type,
        encryption_iv: attachment.encryption_iv.clone(),
        encrypted_content_type_iv: attachment.encrypted_content_type_iv,
        encryption_algorithm: attachment.encryption_algorithm,
        file_size: attachment.file_size,
    })
}

pub(crate) async fn update_vault_attachment(
    pool: &PgPool,
    user_id: &str,
    request_client_id: Option<&str>,
    input: UpdateAttachmentInput,
) -> Result<SuccessResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id).await?;
    let attachment = load_attachment_access(pool, &input.attachment_id, user_id).await?;
    assert_item_write_access(attachment.role, "Access denied")?;
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start attachment update transaction");
        AppError::internal("Failed to start attachment update transaction")
    })?;
    query(
		"UPDATE item_attachment SET encrypted_name = $1, encryption_iv = $2, encryption_algorithm = $3 WHERE id = $4",
	)
	.bind(&input.encrypted_name)
	.bind(&input.encryption_iv)
	.bind(&input.encryption_algorithm)
	.bind(&input.attachment_id)
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to update attachment"); AppError::internal("Failed to update attachment") })?;
    insert_item_sync_event(
        &mut *transaction,
        SyncEventType::ItemUpdated,
        &attachment.item_id,
        &attachment.vault_id,
        user_id,
        request_client_id,
        load_item_row(pool, &attachment.item_id).await?.version,
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit attachment update");
        AppError::internal("Failed to commit attachment update")
    })?;
    Ok(SuccessResponse { success: true })
}

pub(crate) async fn delete_vault_attachment(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    request_client_id: Option<&str>,
    input: AttachmentIdInput,
) -> Result<SuccessResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id).await?;
    let attachment = load_attachment_access(pool, &input.attachment_id, user_id).await?;
    match attachment.role {
        VaultRole::Owner | VaultRole::Admin => {}
        VaultRole::Member if attachment.uploaded_by == user_id => {}
        VaultRole::Member => {
            return Err(AppError::forbidden(
                "You can only delete your own attachments",
            ))
        }
        VaultRole::ReadOnly => return Err(AppError::forbidden("Access denied")),
    }
    object_storage
        .delete(&attachment.storage_key)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })?;
    let item_version = load_item_row(pool, &attachment.item_id).await?.version;
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start attachment delete transaction");
        AppError::internal("Failed to start attachment delete transaction")
    })?;
    query("DELETE FROM item_attachment WHERE id = $1")
        .bind(&input.attachment_id)
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to delete attachment");
            AppError::internal("Failed to delete attachment")
        })?;
    insert_item_sync_event(
        &mut *transaction,
        SyncEventType::ItemUpdated,
        &attachment.item_id,
        &attachment.vault_id,
        user_id,
        request_client_id,
        item_version,
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit attachment delete");
        AppError::internal("Failed to commit attachment delete")
    })?;
    Ok(SuccessResponse { success: true })
}

fn map_attachment(attachment: DbBootstrapAttachmentRow) -> VaultAttachmentResponse {
    VaultAttachmentResponse::compose(attachment.into())
}
pub(super) async fn load_item_attachments(
    pool: &PgPool,
    items: &[DbBootstrapItemRow],
) -> Result<HashMap<String, Vec<VaultAttachmentResponse>>, AppError> {
    if items.is_empty() {
        return Ok(HashMap::new());
    }
    let item_ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
    let attachment_rows = query_as::<_, DbBootstrapAttachmentRow>(
		"SELECT id, item_id, vault_id, storage_key, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm, envelope_version, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, uploaded_by, created_at FROM item_attachment WHERE item_id = ANY($1) ORDER BY created_at ASC",
	)
	.bind(&item_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load item attachments"); AppError::internal("Failed to load item attachments") })?;

    let mut grouped = HashMap::<String, Vec<VaultAttachmentResponse>>::new();
    for attachment in attachment_rows {
        grouped
            .entry(attachment.item_id.clone())
            .or_default()
            .push(map_attachment(attachment));
    }
    Ok(grouped)
}

pub(super) async fn attachments_enabled_for_user(
    pool: &PgPool,
    user_id: &str,
) -> Result<bool, AppError> {
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

async fn load_attachment_actor(pool: &PgPool, user_id: &str) -> Result<AttachmentActor, AppError> {
    let actor =
        load_team_billing_entitlement(pool, user_id, "Failed to load attachment entitlements")
            .await?;
    let mode = bittery_mode();
    let Some(actor) = actor else {
        if mode == "self-hosted" {
            return Ok(AttachmentActor {
                team_id: format!("self-hosted:{user_id}"),
                attachment_max_file_size_bytes: None,
                attachment_storage_bytes: None,
            });
        }
        return Err(AppError::forbidden(
            "Attachments are only available on paid plans with active billing.",
        ));
    };
    let Some(team_id) = actor.team_id else {
        if mode == "self-hosted" {
            return Ok(AttachmentActor {
                team_id: format!("self-hosted:{user_id}"),
                attachment_max_file_size_bytes: None,
                attachment_storage_bytes: None,
            });
        }
        return Err(AppError::forbidden(
            "Attachments are only available on paid plans with active billing.",
        ));
    };
    if mode == "self-hosted" {
        return Ok(AttachmentActor {
            team_id,
            attachment_max_file_size_bytes: None,
            attachment_storage_bytes: None,
        });
    }
    let entitlement =
        resolve_attachment_entitlement(mode, actor.billing_plan, actor.billing_status);
    if !entitlement.enabled {
        return Err(AppError::forbidden(
            "Attachments are only available on paid plans with active billing.",
        ));
    }
    Ok(AttachmentActor {
        team_id,
        attachment_max_file_size_bytes: entitlement.max_file_size_bytes,
        attachment_storage_bytes: entitlement.storage_bytes,
    })
}

pub(super) fn attachment_quota_lock_key(team_id: &str) -> String {
    format!("attachment-quota:{team_id}")
}

pub(super) fn base64_encoded_length(byte_length: i32) -> i32 {
    ((byte_length + 2) / 3) * 4
}

pub(super) fn encrypted_attachment_storage_size(file_size: i32) -> i32 {
    let base64_plaintext_length = base64_encoded_length(file_size);
    let ciphertext_length = base64_encoded_length(base64_plaintext_length + 16);
    let iv_length = base64_encoded_length(12);
    40 + ciphertext_length + iv_length + "AES-GCM-AAD-V1".len() as i32
}

pub(super) fn pending_attachment_upload_expiry(now: OffsetDateTime) -> OffsetDateTime {
    now + time::Duration::minutes(15)
}

async fn load_pending_attachment_reservation(
    pool: &PgPool,
    storage_key: &str,
    item_id: &str,
    created_by: &str,
) -> Result<Option<DbPendingAttachmentReservationRow>, AppError> {
    query_as::<_, DbPendingAttachmentReservationRow>(
		"SELECT id, attachment_id, file_size, storage_size FROM pending_attachment_upload WHERE storage_key = $1 AND item_id = $2 AND created_by = $3 AND consumed_at IS NULL AND expires_at > $4 LIMIT 1",
	)
	.bind(storage_key)
	.bind(item_id)
	.bind(created_by)
	.bind(OffsetDateTime::now_utc())
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load attachment reservation"); AppError::internal("Failed to load attachment reservation") })
}

async fn load_attachment_access(
    pool: &PgPool,
    attachment_id: &str,
    user_id: &str,
) -> Result<DbScopedAttachmentAccessRow, AppError> {
    query_as::<_, DbScopedAttachmentAccessRow>(
		"SELECT ia.id, ia.item_id, ia.vault_id, ia.storage_key, ia.encrypted_attachment_key, ia.attachment_key_iv, ia.attachment_key_algorithm, ia.envelope_version, ia.encrypted_name, ia.encrypted_content_type, ia.encryption_iv, ia.encrypted_content_type_iv, ia.encryption_algorithm, ia.file_size, ia.uploaded_by, ia.created_at, vk.role::text AS role FROM item_attachment ia INNER JOIN vault_key vk ON vk.vault_id = ia.vault_id AND vk.user_id = $2 WHERE ia.id = $1 LIMIT 1",
	)
	.bind(attachment_id)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load attachment"); AppError::internal("Failed to load attachment") })?
	.ok_or_else(|| AppError::not_found("Attachment not found"))
}
