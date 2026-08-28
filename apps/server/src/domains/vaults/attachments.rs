use std::{collections::HashMap, sync::LazyLock};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, KeyInit, Mac};
use rand::random;
use regex::Regex;
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, query_scalar, PgPool};
use time::OffsetDateTime;

use super::{
    access::{assert_item_write_access, insert_item_sync_event, load_item_row, load_vault_access},
    AttachmentDownloadResponse, AttachmentIdInput, AttachmentMoveManifestInput,
    AttachmentMoveManifestResponse, AttachmentMoveUploadResponse, CreateAttachmentInput,
    CreateAttachmentResponse, CreateAttachmentUploadInput, CreateAttachmentUploadResponse,
    ItemIdInput, SuccessResponse, UpdateAttachmentInput, VaultAttachmentResponse,
};

const ATTACHMENT_MOVE_STAGING_LEASE_HOURS: i64 = 24;

pub(crate) async fn create_attachment_move_manifest(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: AttachmentMoveManifestInput,
) -> Result<AttachmentMoveManifestResponse, AppError> {
    if input.attachments.is_empty()
        || input.attachments.iter().any(|entry| {
            entry.attachment_id.is_empty()
                || entry.envelope_version <= 0
                || entry.ciphertext_sha256.len() != crate::http::limits::CIPHERTEXT_SHA256_HEX_CHARS
                || !entry
                    .ciphertext_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    {
        return Err(AppError::bad_request("Invalid Attachment Move manifest"));
    }
    if query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM operation_outcome WHERE user_id = $1 AND operation_id = $2)",
    )
    .bind(user_id)
    .bind(&input.operation_id)
    .fetch_one(pool)
    .await
    .map_err(|error| database_error(error, "Failed to check completed Attachment Move"))?
    {
        return Err(AppError::conflict(
            "Attachment Move Operation is already resolved",
        ));
    }
    let _actor = load_attachment_actor(pool, user_id, deployment_mode).await?;
    let item = load_item_row(pool, &input.item_id).await?;
    if item.vault_id != input.source_vault_id {
        return Err(AppError::attachment_authority_stale(
            "Attachment Move source authority changed",
        ));
    }
    assert_item_write_access(
        load_vault_access(pool, &input.source_vault_id, user_id)
            .await?
            .role,
        "Access denied",
    )?;
    assert_item_write_access(
        load_vault_access(pool, &input.target_vault_id, user_id)
            .await?
            .role,
        "Access denied",
    )?;

    let mut expected = input
        .attachments
        .iter()
        .map(|entry| (entry.attachment_id.clone(), entry.envelope_version))
        .collect::<Vec<_>>();
    expected.sort();
    expected.dedup();
    if expected.len() != input.attachments.len() {
        return Err(AppError::bad_request("Duplicate Attachment identity"));
    }
    let current = query_as::<_, (String, i32, i64)>(
        "SELECT id, envelope_version, storage_size::bigint FROM item_attachment WHERE item_id = $1 ORDER BY id",
    )
    .bind(&input.item_id)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load Attachment Move authority"))?;
    let current_identity = current
        .iter()
        .map(|(id, version, _)| (id.clone(), *version))
        .collect::<Vec<_>>();
    if current_identity != expected {
        return Err(AppError::attachment_authority_stale(
            "Attachment Move authority changed",
        ));
    }
    let current_sizes = current
        .into_iter()
        .map(|(id, _, storage_size)| (id, storage_size))
        .collect::<HashMap<_, _>>();

    let fingerprint = hex::encode(Sha256::digest(&input.request_bytes));
    let now = OffsetDateTime::now_utc();
    let expires_at = now + time::Duration::hours(ATTACHMENT_MOVE_STAGING_LEASE_HOURS);
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to start Attachment Move manifest"))?;
    for (attachment_id, _) in &expected {
        acquire_advisory_lock(
            &mut *transaction,
            &format!(
                "attachment-move-owner:{}:{}",
                attachment_id.len(),
                attachment_id
            ),
            "Failed to lock Attachment Move ownership",
        )
        .await?;
    }
    acquire_operation_lock(
        &mut *transaction,
        user_id,
        &input.operation_id,
        "Failed to lock Attachment Move manifest",
    )
    .await?;
    if query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM operation_outcome WHERE user_id = $1 AND operation_id = $2)",
    )
    .bind(user_id)
    .bind(&input.operation_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to recheck completed Attachment Move"))?
    {
        return Err(AppError::conflict(
            "Attachment Move Operation is already resolved",
        ));
    }
    let conflicts = query_as::<_, (String, String, OffsetDateTime)>(
        "SELECT m.user_id, m.operation_id, m.expires_at FROM attachment_move_staging s INNER JOIN attachment_move_manifest m USING (user_id, operation_id) WHERE s.attachment_id = ANY($2) AND NOT (s.user_id = $1 AND s.operation_id = $3) FOR UPDATE OF m",
    )
    .bind(user_id)
    .bind(expected.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>())
    .bind(&input.operation_id)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to inspect Attachment Move ownership"))?
    .into_iter()
    .map(|(owner_user_id, operation_id, expires_at)| {
        ((owner_user_id, operation_id), expires_at)
    })
    .collect::<HashMap<_, _>>();
    if conflicts
        .values()
        .any(|expires_at| *expires_at > OffsetDateTime::now_utc())
    {
        return Err(AppError::attachment_staging_busy(
            "A live Attachment Move already owns this Attachment.",
        ));
    }
    for (conflicting_user_id, conflicting_operation_id) in conflicts.keys() {
        query("INSERT INTO attachment_move_cleanup (user_id, operation_id, storage_key) SELECT user_id, operation_id, storage_key FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2 ON CONFLICT DO NOTHING")
            .bind(conflicting_user_id)
            .bind(conflicting_operation_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| database_error(error, "Failed to queue expired Attachment Move staging"))?;
        query("DELETE FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2")
            .bind(conflicting_user_id)
            .bind(conflicting_operation_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                database_error(error, "Failed to release expired Attachment Move ownership")
            })?;
    }
    let existing = query_as::<_, (String,)>(
        "SELECT request_fingerprint FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(&input.operation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to read Attachment Move manifest"))?;
    if let Some((existing_fingerprint,)) = existing {
        if existing_fingerprint != fingerprint {
            return Err(AppError::conflict(
                "Operation ID was reused with a different Attachment Move manifest",
            ));
        }
        query("UPDATE attachment_move_manifest SET expires_at = $1 WHERE user_id = $2 AND operation_id = $3")
            .bind(expires_at)
            .bind(user_id)
            .bind(&input.operation_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| database_error(error, "Failed to renew Attachment Move manifest"))?;
    } else {
        let generation = query_scalar::<_, i64>(
            "INSERT INTO attachment_move_staging_generation (user_id, operation_id, request_fingerprint, generation) VALUES ($1, $2, $3, 1) ON CONFLICT (user_id, operation_id) DO UPDATE SET generation = attachment_move_staging_generation.generation + 1 WHERE attachment_move_staging_generation.request_fingerprint = EXCLUDED.request_fingerprint RETURNING generation",
        )
        .bind(user_id)
        .bind(&input.operation_id)
        .bind(&fingerprint)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to advance Attachment Move staging generation"))?
        .ok_or_else(|| {
            AppError::conflict(
                "Operation ID was reused with a different Attachment Move manifest",
            )
        })?;
        query("INSERT INTO attachment_move_manifest (user_id, operation_id, item_id, source_vault_id, target_vault_id, request_fingerprint, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)")
            .bind(user_id)
            .bind(&input.operation_id)
            .bind(&input.item_id)
            .bind(&input.source_vault_id)
            .bind(&input.target_vault_id)
            .bind(&fingerprint)
            .bind(expires_at)
            .bind(now)
            .execute(&mut *transaction)
            .await
            .map_err(|error| database_error(error, "Failed to create Attachment Move manifest"))?;
        for entry in &input.attachments {
            let identity = hex::encode(Sha256::digest(
                format!(
                    "{}\0{}\0{}\0{}",
                    user_id, input.operation_id, entry.attachment_id, generation
                )
                .as_bytes(),
            ));
            let storage_key = format!("attachments/staging/{identity}");
            let storage_size = current_sizes
                .get(&entry.attachment_id)
                .copied()
                .ok_or_else(|| AppError::conflict("Attachment Move authority changed"))?;
            query("INSERT INTO attachment_move_staging (user_id, operation_id, attachment_id, expected_envelope_version, ciphertext_sha256, storage_key, storage_size) VALUES ($1, $2, $3, $4, $5, $6, $7)")
                .bind(user_id)
                .bind(&input.operation_id)
                .bind(&entry.attachment_id)
                .bind(entry.envelope_version)
                .bind(&entry.ciphertext_sha256)
                .bind(storage_key)
                .bind(storage_size)
                .execute(&mut *transaction)
                .await
                .map_err(|error| database_error(error, "Failed to create Attachment Move staging identity"))?;
        }
    }
    let rows = query_as::<_, (String, String, i64, String)>(
        "SELECT attachment_id, storage_key, storage_size, ciphertext_sha256 FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2 ORDER BY attachment_id",
    )
    .bind(user_id)
    .bind(&input.operation_id)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to read Attachment Move uploads"))?;
    let storage_keys = rows
        .iter()
        .map(|(_, key, _, _)| key.clone())
        .collect::<Vec<_>>();
    let cleanup_claimed = query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM attachment_move_cleanup WHERE user_id = $1 AND operation_id = $2 AND storage_key = ANY($3) AND claim_token IS NOT NULL AND claimed_at > NOW() - INTERVAL '5 minutes')",
    )
    .bind(user_id)
    .bind(&input.operation_id)
    .bind(&storage_keys)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to inspect Attachment Move cleanup claim"))?;
    if cleanup_claimed {
        return Err(AppError::attachment_staging_busy(
            "Attachment Move staging cleanup is active.",
        ));
    }
    query("DELETE FROM attachment_move_cleanup WHERE user_id = $1 AND operation_id = $2 AND storage_key = ANY($3) AND (claim_token IS NULL OR claimed_at <= NOW() - INTERVAL '5 minutes')")
        .bind(user_id)
        .bind(&input.operation_id)
        .bind(&storage_keys)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to cancel obsolete Attachment Move cleanup"))?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Attachment Move manifest"))?;

    let mut attachments = Vec::with_capacity(rows.len());
    for (attachment_id, storage_key, storage_size, ciphertext_sha256) in rows {
        let upload = object_storage
            .presign_upload(
                &storage_key,
                "application/octet-stream",
                Some(storage_size),
                Some(&ciphertext_sha256),
                Some(300),
            )
            .await
            .map_err(|error| {
                tracing::error!(error = %error, "Attachment Move credential creation failed");
                AppError::internal("An internal error occurred")
            })?;
        attachments.push(AttachmentMoveUploadResponse {
            attachment_id,
            storage_key: upload.key,
            upload_url: upload.upload_url,
        });
    }
    Ok(AttachmentMoveManifestResponse {
        operation_id: input.operation_id,
        expires_at: expires_at
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|_| AppError::internal("Failed to format Attachment Move lease"))?,
        attachments,
    })
}

/// Renews the reproducible staging lease and proves every deterministic object is present.
/// Missing preparation is deliberately not a semantic Operation outcome.
pub(crate) async fn verify_attachment_move_staging(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    operation_id: &str,
    intent: AttachmentMoveFinalizeIntent<'_>,
) -> Result<AttachmentMoveStagingStatus, AppError> {
    let now = OffsetDateTime::now_utc();
    let expires_at = now + time::Duration::hours(ATTACHMENT_MOVE_STAGING_LEASE_HOURS);
    let manifest = query_as::<_, (String, String, String, OffsetDateTime)>(
        "SELECT item_id, source_vault_id, target_vault_id, expires_at FROM attachment_move_manifest WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(operation_id)
    .bind(now)
    .fetch_optional(pool)
    .await
    .map_err(|error| database_error(error, "Failed to read Attachment Move manifest"))?;
    let Some((manifest_item_id, manifest_source_id, manifest_target_id, manifest_expires_at)) =
        manifest
    else {
        return Ok(AttachmentMoveStagingStatus::Absent);
    };
    if manifest_expires_at <= now {
        return Ok(AttachmentMoveStagingStatus::Incomplete);
    }
    let mut manifest_attachments = query_as::<_, (String, i32)>(
        "SELECT attachment_id, expected_envelope_version FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2 ORDER BY attachment_id",
    )
    .bind(user_id)
    .bind(operation_id)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to read Attachment Move intent"))?;
    let mut expected_attachments = intent.attachments.to_vec();
    expected_attachments.sort();
    manifest_attachments.sort();
    if manifest_item_id != intent.item_id
        || manifest_source_id != intent.source_vault_id
        || manifest_target_id != intent.target_vault_id
        || manifest_attachments != expected_attachments
    {
        return Ok(AttachmentMoveStagingStatus::Mismatch);
    }
    let renewed = query(
        "UPDATE attachment_move_manifest SET expires_at = $1 WHERE user_id = $2 AND operation_id = $3 AND expires_at > $4",
    )
    .bind(expires_at)
    .bind(user_id)
    .bind(operation_id)
    .bind(now)
    .execute(pool)
    .await
    .map_err(|error| database_error(error, "Failed to renew Attachment Move staging"))?;
    if renewed.rows_affected() != 1 {
        return Ok(AttachmentMoveStagingStatus::Incomplete);
    }
    let rows = query_as::<_, (String, i64)>(
        "SELECT storage_key, storage_size FROM attachment_move_staging WHERE user_id = $1 AND operation_id = $2 ORDER BY attachment_id",
    )
    .bind(user_id)
    .bind(operation_id)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to read Attachment Move staging"))?;
    if rows.is_empty() {
        return Ok(AttachmentMoveStagingStatus::Incomplete);
    }
    for (storage_key, storage_size) in rows {
        let object = object_storage.head(&storage_key).await.map_err(|error| {
            tracing::error!(error = %error, "Attachment Move staging check failed");
            AppError::internal("An internal error occurred")
        })?;
        if !object.is_some_and(|object| object.size == storage_size) {
            return Ok(AttachmentMoveStagingStatus::Incomplete);
        }
    }
    Ok(AttachmentMoveStagingStatus::Ready)
}

pub(crate) enum AttachmentMoveStagingStatus {
    Ready,
    Absent,
    Incomplete,
    Mismatch,
}

pub(crate) struct AttachmentMoveFinalizeIntent<'a> {
    pub(crate) item_id: &'a str,
    pub(crate) source_vault_id: &'a str,
    pub(crate) target_vault_id: &'a str,
    pub(crate) attachments: &'a [(String, i32)],
}
use crate::{
    config::DeploymentMode,
    db::events::{begin_sync_event_transaction, generate_resource_id},
    db::{
        enums::{SyncEventType, VaultRole},
        models::{DbBootstrapAttachmentRow, DbBootstrapItemRow},
    },
    domains::billing::entitlements::{
        load_team_billing_entitlement, resolve_attachment_entitlement,
    },
    error::AppError,
    integrations::storage,
    shared::transaction::{
        acquire_advisory_lock, acquire_item_attachment_writer_lock, acquire_operation_lock,
        database_error,
    },
};

const ATTACHMENT_ENVELOPE_VERSION: i32 = 1;
const ATTACHMENT_UPLOAD_KEY_TTL_MS: i64 = 15 * 60 * 1000;

type HmacSha256 = Hmac<Sha256>;

static ATTACHMENT_UPLOAD_KEY_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^attachments/([^/]+)/([^/]+)/(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-([A-Za-z0-9_-]{43})-([A-Za-z0-9._-]{1,120})$")
        .expect("attachment upload key regex should compile")
});

#[derive(Debug, sqlx::FromRow)]
struct DbPendingAttachmentReservationRow {
    id: String,
    attachment_id: String,
    file_size: i32,
    storage_size: i32,
}

#[derive(Debug, sqlx::FromRow)]
struct DbScopedAttachmentAccessRow {
    attachment_id: String,
    item_id: String,
    vault_id: String,
    storage_key: String,
    envelope_version: i32,
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
    attachment_upload_secret: &str,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: CreateAttachmentUploadInput,
) -> Result<CreateAttachmentUploadResponse, AppError> {
    if input.file_name.trim().is_empty()
        || input.content_type.trim().is_empty()
        || input.file_size <= 0
    {
        return Err(AppError::bad_request("Invalid attachment upload request"));
    }
    let actor = load_attachment_actor(pool, user_id, deployment_mode).await?;
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
    let key = create_attachment_key(
        attachment_upload_secret,
        user_id,
        &input.item_id,
        &input.file_name,
    )
    .map_err(|error| {
        tracing::error!(error = %error, "Internal error");
        AppError::internal("An internal error occurred")
    })?;
    let storage_size = encrypted_attachment_storage_size(input.file_size);
    let now = OffsetDateTime::now_utc();
    let expires_at = pending_attachment_upload_expiry(now);

    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to start attachment upload transaction"))?;
    acquire_advisory_lock(
        &mut *transaction,
        &attachment_quota_lock_key(&actor.team_id),
        "Failed to lock attachment quota",
    )
    .await?;
    let committed_usage = query_scalar::<_, i64>(
		"SELECT COALESCE(SUM(ia.storage_size), 0)::bigint FROM item_attachment ia INNER JOIN \"user\" u ON ia.uploaded_by = u.id WHERE u.team_id = $1",
	)
	.bind(&actor.team_id)
	.fetch_one(&mut *transaction)
	.await
	.map_err(|error| database_error(error, "Failed to load attachment usage"))?;
    let pending_usage = query_scalar::<_, i64>(
		"SELECT COALESCE(SUM(storage_size), 0)::bigint FROM pending_attachment_upload WHERE team_id = $1 AND consumed_at IS NULL AND expires_at > $2",
	)
	.bind(&actor.team_id)
	.bind(now)
	.fetch_one(&mut *transaction)
	.await
	.map_err(|error| database_error(error, "Failed to load pending attachment usage"))?;
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
	.map_err(|error| database_error(error, "Failed to reserve attachment upload"))?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit attachment upload reservation"))?;

    let upload = object_storage
        .presign_upload(
            &key,
            &input.content_type,
            Some(i64::from(storage_size)),
            None,
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
    attachment_upload_secret: &str,
    deployment_mode: DeploymentMode,
    user_id: &str,
    request_client_id: Option<&str>,
    input: CreateAttachmentInput,
) -> Result<CreateAttachmentResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id, deployment_mode).await?;
    let scoped_item = load_item_row(pool, &input.item_id).await?;
    let access = load_vault_access(pool, &scoped_item.vault_id, user_id).await?;
    assert_item_write_access(access.role, "Access denied")?;
    if input.envelope_version != ATTACHMENT_ENVELOPE_VERSION {
        return Err(AppError::bad_request(
            "Unsupported attachment envelope version",
        ));
    }
    let is_valid_key = is_valid_attachment_upload_key(
        attachment_upload_secret,
        &input.storage_key,
        user_id,
        &input.item_id,
        None,
    )
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
    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start attachment create transaction"))?;
    acquire_item_attachment_writer_lock(
        &mut *transaction,
        &input.item_id,
        "Failed to lock Item Attachment writer",
    )
    .await?;
    let current_vault_id = query_scalar::<_, String>("SELECT vault_id FROM item WHERE id = $1")
        .bind(&input.item_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to recheck attachment Item authority"))?;
    if current_vault_id.as_deref() != Some(scoped_item.vault_id.as_str()) {
        return Err(AppError::conflict("Item authority changed"));
    }
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
	.map_err(|error| database_error(error, "Failed to create attachment"))?;
    query("UPDATE pending_attachment_upload SET consumed_at = $1 WHERE id = $2")
        .bind(OffsetDateTime::now_utc())
        .bind(&reservation.id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to consume attachment reservation"))?;
    insert_item_sync_event(
        &mut transaction,
        SyncEventType::ItemUpdated,
        &input.item_id,
        &scoped_item.vault_id,
        user_id,
        request_client_id,
        scoped_item.version,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit attachment create"))?;

    Ok(CreateAttachmentResponse {
        attachment_id: input.attachment_id,
    })
}

fn create_attachment_key(
    signing_secret: &str,
    user_id: &str,
    item_id: &str,
    file_name: &str,
) -> Result<String, storage::StorageError> {
    let safe_name = storage::sanitize_file_name(file_name);
    let upload_id = random_uuid_like();
    let expires_at_ms = chrono::Utc::now().timestamp_millis() + ATTACHMENT_UPLOAD_KEY_TTL_MS;
    let signature = sign_attachment_upload_intent(
        signing_secret,
        &format!("{user_id}:{item_id}:{upload_id}:{expires_at_ms}"),
    )?;
    Ok(format!(
        "attachments/{user_id}/{item_id}/{expires_at_ms}-{upload_id}-{signature}-{safe_name}"
    ))
}

fn is_valid_attachment_upload_key(
    signing_secret: &str,
    key: &str,
    user_id: &str,
    item_id: &str,
    now_ms: Option<i64>,
) -> Result<bool, storage::StorageError> {
    let Some(captures) = ATTACHMENT_UPLOAD_KEY_PATTERN.captures(key) else {
        return Ok(false);
    };
    let key_user_id = captures
        .get(1)
        .map(|value| value.as_str())
        .unwrap_or_default();
    let key_item_id = captures
        .get(2)
        .map(|value| value.as_str())
        .unwrap_or_default();
    if key_user_id != user_id || key_item_id != item_id {
        return Ok(false);
    }
    let Some(expires_at_ms) = captures
        .get(3)
        .and_then(|value| value.as_str().parse::<i64>().ok())
    else {
        return Ok(false);
    };
    if expires_at_ms < now_ms.unwrap_or_else(|| chrono::Utc::now().timestamp_millis()) {
        return Ok(false);
    }
    let upload_id = captures
        .get(4)
        .map(|value| value.as_str())
        .unwrap_or_default();
    let signature = captures
        .get(5)
        .map(|value| value.as_str())
        .unwrap_or_default();
    verify_attachment_upload_intent(
        signing_secret,
        &format!("{key_user_id}:{key_item_id}:{upload_id}:{expires_at_ms}"),
        signature,
    )
}

fn attachment_upload_mac(
    signing_secret: &str,
    payload: &str,
) -> Result<HmacSha256, storage::StorageError> {
    let mut mac = HmacSha256::new_from_slice(signing_secret.as_bytes())
        .map_err(|error| storage::StorageError::InvalidConfig(error.to_string()))?;
    mac.update(payload.as_bytes());
    Ok(mac)
}

fn sign_attachment_upload_intent(
    signing_secret: &str,
    payload: &str,
) -> Result<String, storage::StorageError> {
    let mac = attachment_upload_mac(signing_secret, payload)?;
    Ok(URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes()))
}

fn verify_attachment_upload_intent(
    signing_secret: &str,
    payload: &str,
    signature: &str,
) -> Result<bool, storage::StorageError> {
    let mac = attachment_upload_mac(signing_secret, payload)?;
    // An undecodable signature is treated exactly like a wrong one.
    let Ok(tag) = URL_SAFE_NO_PAD.decode(signature) else {
        return Ok(false);
    };
    // `verify_slice` compares the tag in constant time, so validation timing does not depend on how
    // many leading bytes of a supplied signature happen to be correct.
    Ok(mac.verify_slice(&tag).is_ok())
}

fn random_uuid_like() -> String {
    let bytes = random::<[u8; 16]>();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

pub(crate) async fn list_vault_attachments_page(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: ItemIdInput,
    cursor: Option<(OffsetDateTime, String)>,
    limit: i64,
) -> Result<Vec<VaultAttachmentResponse>, AppError> {
    let _actor = load_attachment_actor(pool, user_id, deployment_mode).await?;
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
    .map_err(|error| database_error(error, "Failed to load item attachment page"))?;
    Ok(attachment_rows.into_iter().map(map_attachment).collect())
}

pub(crate) async fn get_attachment_download_url(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    deployment_mode: DeploymentMode,
    user_id: &str,
    input: AttachmentIdInput,
) -> Result<AttachmentDownloadResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id, deployment_mode).await?;
    let attachment = load_attachment_access(pool, &input.attachment_id, user_id).await?;
    let download_url = object_storage
        .presign_download(&attachment.storage_key, Some(300))
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })?;
    Ok(AttachmentDownloadResponse {
        attachment_id: attachment.attachment_id,
        item_id: attachment.item_id,
        vault_id: attachment.vault_id,
        storage_key: attachment.storage_key,
        envelope_version: attachment.envelope_version,
        uploaded_by: attachment.uploaded_by,
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
    deployment_mode: DeploymentMode,
    user_id: &str,
    request_client_id: Option<&str>,
    input: UpdateAttachmentInput,
) -> Result<SuccessResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id, deployment_mode).await?;
    let attachment = load_attachment_access(pool, &input.attachment_id, user_id).await?;
    assert_item_write_access(attachment.role, "Access denied")?;
    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start attachment update transaction"))?;
    acquire_item_attachment_writer_lock(
        &mut *transaction,
        &attachment.item_id,
        "Failed to lock Item Attachment writer",
    )
    .await?;
    let updated = query(
		"UPDATE item_attachment SET encrypted_name = $1, encryption_iv = $2, encryption_algorithm = $3 WHERE id = $4 AND vault_id = $5 AND envelope_version = $6",
	)
	.bind(&input.encrypted_name)
	.bind(&input.encryption_iv)
	.bind(&input.encryption_algorithm)
	.bind(&input.attachment_id)
	.bind(&attachment.vault_id)
	.bind(attachment.envelope_version)
	.execute(&mut *transaction)
	.await
	.map_err(|error| database_error(error, "Failed to update attachment"))?;
    if updated.rows_affected() != 1 {
        return Err(AppError::conflict("Attachment authority changed"));
    }
    insert_item_sync_event(
        &mut transaction,
        SyncEventType::ItemUpdated,
        &attachment.item_id,
        &attachment.vault_id,
        user_id,
        request_client_id,
        load_item_row(pool, &attachment.item_id).await?.version,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit attachment update"))?;
    Ok(SuccessResponse { success: true })
}

pub(crate) async fn delete_vault_attachment(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    deployment_mode: DeploymentMode,
    user_id: &str,
    request_client_id: Option<&str>,
    input: AttachmentIdInput,
) -> Result<SuccessResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id, deployment_mode).await?;
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
    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start attachment delete transaction"))?;
    acquire_item_attachment_writer_lock(
        &mut *transaction,
        &attachment.item_id,
        "Failed to lock Item Attachment writer",
    )
    .await?;
    let deleted =
        query("DELETE FROM item_attachment WHERE id = $1 AND vault_id = $2 AND storage_key = $3")
            .bind(&input.attachment_id)
            .bind(&attachment.vault_id)
            .bind(&attachment.storage_key)
            .execute(&mut *transaction)
            .await
            .map_err(|error| database_error(error, "Failed to delete attachment"))?;
    if deleted.rows_affected() != 1 {
        return Err(AppError::conflict("Attachment authority changed"));
    }
    insert_item_sync_event(
        &mut transaction,
        SyncEventType::ItemUpdated,
        &attachment.item_id,
        &attachment.vault_id,
        user_id,
        request_client_id,
        item_version,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit attachment delete"))?;
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
	.map_err(|error| database_error(error, "Failed to load item attachments"))?;

    let mut grouped = HashMap::<String, Vec<VaultAttachmentResponse>>::new();
    for attachment in attachment_rows {
        grouped
            .entry(attachment.item_id.clone())
            .or_default()
            .push(map_attachment(attachment));
    }
    Ok(grouped)
}

async fn load_attachment_actor(
    pool: &PgPool,
    user_id: &str,
    deployment_mode: DeploymentMode,
) -> Result<AttachmentActor, AppError> {
    let actor =
        load_team_billing_entitlement(pool, user_id, "Failed to load attachment entitlements")
            .await?;
    let mode = deployment_mode.as_str();
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
	.map_err(|error| database_error(error, "Failed to load attachment reservation"))
}

async fn load_attachment_access(
    pool: &PgPool,
    attachment_id: &str,
    user_id: &str,
) -> Result<DbScopedAttachmentAccessRow, AppError> {
    query_as::<_, DbScopedAttachmentAccessRow>(
		"SELECT ia.id AS attachment_id, ia.item_id, ia.vault_id, ia.storage_key, ia.encrypted_attachment_key, ia.attachment_key_iv, ia.attachment_key_algorithm, ia.envelope_version, ia.encrypted_name, ia.encrypted_content_type, ia.encryption_iv, ia.encrypted_content_type_iv, ia.encryption_algorithm, ia.file_size, ia.uploaded_by, ia.created_at, vk.role::text AS role FROM item_attachment ia INNER JOIN vault_key vk ON vk.vault_id = ia.vault_id AND vk.user_id = $2 WHERE ia.id = $1 LIMIT 1",
	)
	.bind(attachment_id)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load attachment"))?
        .ok_or_else(|| AppError::not_found("Attachment not found"))
}

#[cfg(test)]
mod capability_token_tests {
    use super::{
        create_attachment_key, is_valid_attachment_upload_key, sign_attachment_upload_intent,
    };

    const ATTACHMENT_TEST_SECRET: &str = "attachment-test-secret";

    #[test]
    fn attachment_upload_key_validation_round_trips() {
        let key = create_attachment_key(
            ATTACHMENT_TEST_SECRET,
            "user_123",
            "item_456",
            "secret file.enc",
        )
        .expect("attachment key should be created");

        assert!(is_valid_attachment_upload_key(
            ATTACHMENT_TEST_SECRET,
            &key,
            "user_123",
            "item_456",
            None,
        )
        .expect("validation should succeed"));
        assert!(!is_valid_attachment_upload_key(
            ATTACHMENT_TEST_SECRET,
            &key,
            "user_123",
            "other_item",
            None,
        )
        .expect("validation should succeed"));
    }

    #[test]
    fn attachment_upload_key_signature_checks_accept_only_the_expected_tag() {
        const UPLOAD_ID: &str = "00000000-0000-0000-0000-000000000000";

        let now_ms = chrono::Utc::now().timestamp_millis();
        let expires_at_ms = now_ms + 60_000;
        let build_key = |signature: &str| {
            format!(
                "attachments/user_123/item_456/{expires_at_ms}-{UPLOAD_ID}-{signature}-file.enc"
            )
        };

        let valid_signature = sign_attachment_upload_intent(
            ATTACHMENT_TEST_SECRET,
            &format!("user_123:item_456:{UPLOAD_ID}:{expires_at_ms}"),
        )
        .expect("signature should be created");
        assert!(is_valid_attachment_upload_key(
            ATTACHMENT_TEST_SECRET,
            &build_key(&valid_signature),
            "user_123",
            "item_456",
            Some(now_ms),
        )
        .expect("validation should succeed"));

        let foreign_signature = sign_attachment_upload_intent(
            ATTACHMENT_TEST_SECRET,
            &format!("user_123:other_item:{UPLOAD_ID}:{expires_at_ms}"),
        )
        .expect("signature should be created");
        assert!(!is_valid_attachment_upload_key(
            ATTACHMENT_TEST_SECRET,
            &build_key(&foreign_signature),
            "user_123",
            "item_456",
            Some(now_ms),
        )
        .expect("validation should succeed"));

        // Set the discarded trailing bits of the final base64url symbol: the tag bytes would be
        // unchanged, so this only fails validation because decoding rejects it.
        const URL_SAFE_ALPHABET: &[u8] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let last_symbol = valid_signature.as_bytes()[valid_signature.len() - 1];
        let last_index = URL_SAFE_ALPHABET
            .iter()
            .position(|symbol| *symbol == last_symbol)
            .expect("signature should be base64url");
        let malformed_signature = format!(
            "{}{}",
            &valid_signature[..valid_signature.len() - 1],
            URL_SAFE_ALPHABET[last_index + 1] as char,
        );
        assert!(!is_valid_attachment_upload_key(
            ATTACHMENT_TEST_SECRET,
            &build_key(&malformed_signature),
            "user_123",
            "item_456",
            Some(now_ms),
        )
        .expect("malformed signatures should not error"));
    }
}
