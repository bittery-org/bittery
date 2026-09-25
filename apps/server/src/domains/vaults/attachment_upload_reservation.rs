//! One reservation owns ordinary allocation and renewable exact Attachment upload identity.
#[path = "attachment_upload_reservation_cleanup.rs"]
mod cleanup;
pub(crate) use cleanup::cleanup_durable_attachment_uploads;

use super::*;
use crate::{
    domains::billing::entitlements::load_team_billing_entitlement_locked,
    shared::{
        transaction::{acquire_team_authority_lock, acquire_user_authority_lock},
        validate_resource_id,
    },
};
use sqlx::{Postgres, Transaction};

struct UploadAuthority<'a> {
    transaction: Transaction<'a, Postgres>,
    actor: AttachmentActor,
    item: DbBootstrapItemRow,
}

/// Sync -> User/Team/billing -> quota -> Vault membership/Item -> reservation.
async fn authority<'a>(
    pool: &'a PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    item_id: &str,
) -> Result<UploadAuthority<'a>, AppError> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|e| database_error(e, "Failed to begin Attachment reservation"))?;
    // Set the database deadline before the first lock. Dropping a canceled HTTP future queues
    // SQLx rollback behind its pending query, so the edge timeout alone cannot drain that wait.
    query("SET LOCAL statement_timeout = '30s'")
        .execute(&mut *transaction)
        .await
        .map_err(|e| database_error(e, "Failed to bound Attachment reservation"))?;
    crate::db::events::lock_sync_event_order(&mut transaction)
        .await
        .map_err(|e| database_error(e, "Failed to lock Attachment Sync order"))?;
    acquire_user_authority_lock(&mut transaction, user_id, "Failed to lock Attachment actor")
        .await?;
    let item = load_item_row(&mut *transaction, item_id).await?;
    let user_team = query_scalar::<_, Option<String>>("SELECT team_id FROM \"user\" WHERE id=$1")
        .bind(user_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|e| database_error(e, "Failed to locate Attachment actor"))?
        .flatten()
        .ok_or_else(|| AppError::forbidden("Attachment actor is unavailable"))?;
    let vault_team = query_scalar::<_, Option<String>>("SELECT team_id FROM vault WHERE id=$1")
        .bind(&item.vault_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|e| database_error(e, "Failed to locate Attachment Vault"))?
        .flatten();
    let mut teams = vec![user_team];
    teams.extend(vault_team);
    teams.sort();
    teams.dedup();
    for team in teams {
        acquire_team_authority_lock(&mut *transaction, &team, "Failed to lock Attachment Team")
            .await?;
    }
    let entitlement = load_team_billing_entitlement_locked(
        &mut transaction,
        user_id,
        "Failed to lock Attachment billing",
    )
    .await?;
    let actor = resolve_attachment_actor(entitlement, deployment_mode, user_id)?;
    acquire_advisory_lock(
        &mut *transaction,
        &attachment_quota_lock_key(&actor.team_id),
        "Failed to lock Attachment quota",
    )
    .await?;
    let role = query_scalar::<_, VaultRole>(
        "SELECT vk.role FROM vault v JOIN vault_key vk ON vk.vault_id=v.id WHERE v.id=$1 AND vk.user_id=$2 FOR UPDATE OF v,vk",
    )
    .bind(&item.vault_id)
    .bind(user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|e| database_error(e, "Failed to lock Attachment Vault authority"))?
    .ok_or_else(|| AppError::forbidden("Access denied to this vault"))?;
    assert_item_write_access(role, "Access denied")?;
    acquire_item_attachment_writer_lock(
        &mut *transaction,
        item_id,
        "Failed to lock Attachment Item writer",
    )
    .await?;
    let current_vault =
        query_scalar::<_, String>("SELECT vault_id FROM item WHERE id=$1 FOR UPDATE")
            .bind(item_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|e| database_error(e, "Failed to lock Attachment Item"))?;
    if current_vault.as_deref() != Some(item.vault_id.as_str()) {
        return Err(AppError::conflict("Item authority changed"));
    }
    let item = load_item_row(&mut *transaction, item_id).await?;
    Ok(UploadAuthority {
        transaction,
        actor,
        item,
    })
}

async fn lock_identity(
    transaction: &mut Transaction<'_, Postgres>,
    attachment_id: &str,
) -> Result<(), AppError> {
    acquire_advisory_lock(
        &mut **transaction,
        &format!("attachment-upload:{}:{attachment_id}", attachment_id.len()),
        "Failed to lock Attachment upload identity",
    )
    .await
}

#[derive(sqlx::FromRow)]
struct Reservation {
    id: String,
    attachment_id: String,
    storage_key: String,
    file_size: i32,
    storage_size: i32,
    content_type: String,
    created_by: Option<String>,
    item_id: Option<String>,
    vault_id: Option<String>,
    team_id: Option<String>,
    durable_created_by: Option<String>,
    durable_item_id: Option<String>,
    durable_vault_id: Option<String>,
    durable_team_id: Option<String>,
    durable_request_fingerprint: Option<String>,
    ciphertext_sha256: Option<String>,
    expires_at: OffsetDateTime,
    consumed_at: Option<OffsetDateTime>,
    next_cleanup_at: Option<OffsetDateTime>,
    cleanup_attempt_id: Option<String>,
}

async fn load(
    transaction: &mut Transaction<'_, Postgres>,
    attachment_id: &str,
) -> Result<Option<Reservation>, AppError> {
    query_as::<_, Reservation>("SELECT id,attachment_id,storage_key,file_size,storage_size,content_type,created_by,item_id,vault_id,team_id,durable_created_by,durable_item_id,durable_vault_id,durable_team_id,durable_request_fingerprint,ciphertext_sha256,expires_at,consumed_at,next_cleanup_at,cleanup_attempt_id FROM pending_attachment_upload WHERE attachment_id=$1 FOR UPDATE")
        .bind(attachment_id).fetch_optional(&mut **transaction).await
        .map_err(|e| database_error(e, "Failed to load Attachment reservation"))
}

impl Reservation {
    fn matches_live(&self, user_id: &str, scope: &UploadAuthority<'_>) -> bool {
        self.created_by.as_deref() == Some(user_id)
            && self.item_id.as_deref() == Some(scope.item.id.as_str())
            && self.vault_id.as_deref() == Some(scope.item.vault_id.as_str())
            && self.team_id.as_deref() == Some(scope.actor.team_id.as_str())
            && self.durable_created_by == self.created_by
            && self.durable_item_id == self.item_id
            && self.durable_vault_id == self.vault_id
            && self.durable_team_id == self.team_id
    }
}

fn storage_size(file_size: i32) -> Result<i32, AppError> {
    i32::try_from(encrypted_attachment_storage_size(file_size))
        .map_err(|_| AppError::bad_request("Attachment encrypted size is too large"))
}

async fn check_quota(
    scope: &mut UploadAuthority<'_>,
    file_size: i32,
    storage_size: i32,
    reservation_id: Option<&str>,
) -> Result<(), AppError> {
    if scope
        .actor
        .attachment_max_file_size_bytes
        .is_some_and(|max| i64::from(file_size) > max)
    {
        return Err(AppError::bad_request(
            "Attachment file exceeds the maximum allowed size for your current plan.",
        ));
    }
    let Some(quota) = scope.actor.attachment_storage_bytes else {
        return Ok(());
    };
    let committed = query_scalar::<_, i64>("SELECT COALESCE(SUM(ia.storage_size),0)::bigint FROM item_attachment ia JOIN \"user\" u ON ia.uploaded_by=u.id WHERE u.team_id=$1")
        .bind(&scope.actor.team_id).fetch_one(&mut *scope.transaction).await
        .map_err(|e| database_error(e, "Failed to read Attachment usage"))?;
    let pending = query_scalar::<_, i64>("SELECT COALESCE(SUM(storage_size),0)::bigint FROM pending_attachment_upload WHERE team_id=$1 AND consumed_at IS NULL AND expires_at>$2 AND ($3::text IS NULL OR id<>$3)")
        .bind(&scope.actor.team_id).bind(OffsetDateTime::now_utc()).bind(reservation_id)
        .fetch_one(&mut *scope.transaction).await
        .map_err(|e| database_error(e, "Failed to read Attachment reservations"))?;
    if committed + pending + i64::from(storage_size) > quota {
        return Err(AppError::attachment_quota_exceeded(
            "Attachment storage quota has been reached for your current plan.",
        ));
    }
    Ok(())
}

pub(super) async fn grant(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    signing_secret: &str,
    mode: DeploymentMode,
    user_id: &str,
    input: CreateAttachmentUploadInput,
) -> Result<CreateAttachmentUploadResponse, AppError> {
    if input.file_name.trim().is_empty()
        || input.content_type.trim().is_empty()
        || input.file_size <= 0
    {
        return Err(AppError::bad_request("Invalid attachment upload request"));
    }
    let durable = input.durable_upload.as_ref();
    if let Some(durable) = durable {
        validate_resource_id(&durable.attachment_id)?;
        if durable.ciphertext_sha256.len() != 64
            || !durable
                .ciphertext_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || input.content_type != "application/octet-stream"
            || input.request_bytes.is_empty()
        {
            return Err(AppError::bad_request("Invalid durable Attachment upload"));
        }
    }
    let size = storage_size(input.file_size)?;
    let mut scope = authority(pool, mode, user_id, &input.item_id).await?;
    let attachment_id = durable
        .map(|d| d.attachment_id.clone())
        .unwrap_or_else(|| generate_resource_id("attachment"));
    lock_identity(&mut scope.transaction, &attachment_id).await?;
    let existing = load(&mut scope.transaction, &attachment_id).await?;
    if existing
        .as_ref()
        .is_some_and(|row| row.cleanup_attempt_id.is_some())
    {
        return Err(AppError::conflict(
            "Attachment upload identity has unresolved object cleanup",
        ));
    }
    let published =
        query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM item_attachment WHERE id=$1)")
            .bind(&attachment_id)
            .fetch_one(&mut *scope.transaction)
            .await
            .map_err(|e| database_error(e, "Failed to inspect Attachment identity"))?;
    if published || existing.as_ref().is_some_and(|r| r.consumed_at.is_some()) {
        return Err(AppError::conflict(
            "Attachment upload identity is already consumed",
        ));
    }
    let fingerprint = durable.map(|_| {
        let mut hash = Sha256::new();
        for field in [
            b"bittery:durable-attachment-upload:v1".as_slice(),
            user_id.as_bytes(),
            input.item_id.as_bytes(),
            input.request_bytes.as_slice(),
        ] {
            hash.update((field.len() as u64).to_be_bytes());
            hash.update(field);
        }
        hex::encode(hash.finalize())
    });
    if let Some(previous) = &existing {
        if durable.is_none()
            || !previous.matches_live(user_id, &scope)
            || previous.durable_request_fingerprint != fingerprint
            || previous.ciphertext_sha256.as_deref()
                != durable.map(|d| d.ciphertext_sha256.as_str())
            || previous.file_size != input.file_size
            || previous.storage_size != size
            || previous.content_type != input.content_type
        {
            return Err(AppError::conflict(
                "Attachment upload identity was reused or retired",
            ));
        }
    }
    check_quota(
        &mut scope,
        input.file_size,
        size,
        existing.as_ref().map(|r| r.id.as_str()),
    )
    .await?;
    let now = OffsetDateTime::now_utc();
    let expires = pending_attachment_upload_expiry(now);
    let key = if let Some(previous) = existing {
        query("UPDATE pending_attachment_upload SET expires_at=$1,next_cleanup_at=$1 WHERE id=$2")
            .bind(expires)
            .bind(&previous.id)
            .execute(&mut *scope.transaction)
            .await
            .map_err(|e| database_error(e, "Failed to renew Attachment reservation"))?;
        previous.storage_key
    } else {
        let key = if durable.is_some() {
            let identity = format!(
                "bittery:durable-attachment-object:v1\0{user_id}\0{}\0{attachment_id}",
                input.item_id
            );
            format!(
                "attachments/durable/{}",
                hex::encode(Sha256::digest(identity.as_bytes()))
            )
        } else {
            create_attachment_key(signing_secret, user_id, &input.item_id, &input.file_name)
                .map_err(|_| AppError::internal("Attachment upload signing failed"))?
        };
        query("INSERT INTO pending_attachment_upload (id,attachment_id,team_id,vault_id,item_id,storage_key,file_size,storage_size,content_type,created_by,expires_at,created_at,durable_request_fingerprint,ciphertext_sha256,durable_created_by,durable_item_id,durable_vault_id,durable_team_id,next_cleanup_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)")
            .bind(generate_resource_id("attachment_pending")).bind(&attachment_id).bind(&scope.actor.team_id)
            .bind(&scope.item.vault_id).bind(&input.item_id).bind(&key).bind(input.file_size).bind(size)
            .bind(&input.content_type).bind(user_id).bind(expires).bind(now).bind(fingerprint)
            .bind(durable.map(|d| &d.ciphertext_sha256)).bind(durable.map(|_| user_id))
            .bind(durable.map(|_| &input.item_id)).bind(durable.map(|_| &scope.item.vault_id))
            .bind(durable.map(|_| &scope.actor.team_id)).bind(durable.map(|_| expires))
            .execute(&mut *scope.transaction).await
            .map_err(|e| database_error(e, "Failed to retain Attachment reservation"))?;
        key
    };
    let upload = tokio::time::timeout(std::time::Duration::from_secs(30), async {
        if let Some(durable) = durable {
            object_storage
                .presign_exact_upload(
                    &key,
                    &input.content_type,
                    i64::from(size),
                    &durable.ciphertext_sha256,
                    Some(300),
                )
                .await
        } else {
            object_storage
                .presign_upload(&key, &input.content_type, Some(i64::from(size)), None, None)
                .await
        }
    })
    .await
    .map_err(|_| AppError::retryable_conflict("Attachment upload signing timed out"))?
    .map_err(|_| AppError::internal("Attachment upload signing failed"))?;
    if upload.key != key {
        return Err(AppError::internal(
            "Attachment upload signing returned another identity",
        ));
    }
    // Signing may await the provider. Set the final lease after it succeeds, then expose the
    // capability only after commit; its 300-second lifetime fits the retained 15-minute lease.
    let final_expiry = pending_attachment_upload_expiry(OffsetDateTime::now_utc());
    query("UPDATE pending_attachment_upload SET expires_at=$1,next_cleanup_at=CASE WHEN durable_request_fingerprint IS NOT NULL THEN $1 ELSE NULL END WHERE attachment_id=$2")
        .bind(final_expiry).bind(&attachment_id).execute(&mut *scope.transaction).await
        .map_err(|e| database_error(e, "Failed to finalize Attachment upload lease"))?;
    scope
        .transaction
        .commit()
        .await
        .map_err(|e| database_error(e, "Failed to commit Attachment reservation"))?;
    Ok(CreateAttachmentUploadResponse {
        attachment_id,
        storage_key: key,
        upload_url: upload.upload_url,
        upload_headers: if durable.is_some() {
            upload.required_headers
        } else {
            Vec::new()
        },
    })
}

pub(super) async fn register(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    signing_secret: &str,
    mode: DeploymentMode,
    user_id: &str,
    request_client_id: Option<&str>,
    input: CreateAttachmentInput,
) -> Result<CreateAttachmentResponse, AppError> {
    let mut scope = authority(pool, mode, user_id, &input.item_id).await?;
    if input.envelope_version != ATTACHMENT_ENVELOPE_VERSION {
        return Err(AppError::bad_request(
            "Unsupported attachment envelope version",
        ));
    }
    lock_identity(&mut scope.transaction, &input.attachment_id).await?;
    let reservation = load(&mut scope.transaction, &input.attachment_id).await?;
    let durable = reservation
        .as_ref()
        .is_some_and(|row| row.durable_request_fingerprint.is_some());
    if !durable
        && !is_valid_attachment_upload_key(
            signing_secret,
            &input.storage_key,
            user_id,
            &input.item_id,
            None,
        )
        .map_err(|_| AppError::internal("Attachment upload key validation failed"))?
    {
        return Err(AppError::bad_request(
            "Invalid or expired attachment upload key",
        ));
    }
    let reservation = reservation
        .ok_or_else(|| AppError::bad_request("Invalid or expired attachment upload reservation"))?;
    if reservation.cleanup_attempt_id.is_some() {
        return Err(AppError::conflict(
            "Attachment upload identity has unresolved object cleanup",
        ));
    }
    if reservation.created_by.as_deref() == Some(user_id)
        && reservation.item_id.as_deref() == Some(input.item_id.as_str())
        && reservation
            .vault_id
            .as_deref()
            .is_some_and(|vault_id| vault_id != scope.item.vault_id)
    {
        // The original grant captures Item scope before a concurrent Move. Preserve the
        // ordinary registration conflict even when the Move committed before our Sync lock.
        return Err(AppError::conflict("Item authority changed"));
    }
    if reservation.consumed_at.is_some()
        || reservation.expires_at <= OffsetDateTime::now_utc()
        || reservation.created_by.as_deref() != Some(user_id)
        || reservation.item_id.as_deref() != Some(input.item_id.as_str())
        || reservation.vault_id.as_deref() != Some(scope.item.vault_id.as_str())
        || reservation.team_id.as_deref() != Some(scope.actor.team_id.as_str())
        || (durable && !reservation.matches_live(user_id, &scope))
    {
        return Err(AppError::bad_request(
            "Invalid or expired attachment upload reservation",
        ));
    }
    if reservation.attachment_id != input.attachment_id
        || reservation.storage_key != input.storage_key
        || reservation.file_size != input.file_size
    {
        return Err(AppError::bad_request(
            "Attachment metadata does not match the reserved upload.",
        ));
    }
    check_quota(
        &mut scope,
        input.file_size,
        reservation.storage_size,
        Some(&reservation.id),
    )
    .await?;
    let uploaded_object = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        object_storage.head(&input.storage_key),
    )
    .await
    .map_err(|_| AppError::retryable_conflict("Attachment object verification timed out"))?
    .map_err(|_| AppError::internal("Attachment object verification failed"))?
    .ok_or_else(|| {
        AppError::bad_request("Uploaded attachment does not match the reserved encrypted size.")
    })?;
    if uploaded_object.size != i64::from(reservation.storage_size) {
        return Err(AppError::bad_request(
            "Uploaded attachment does not match the reserved encrypted size.",
        ));
    }
    if durable
        && (uploaded_object.payload_sha256 != reservation.ciphertext_sha256
            || uploaded_object.content_type.as_deref() != Some(reservation.content_type.as_str()))
    {
        return Err(AppError::bad_request(
            "Uploaded attachment does not match the reserved ciphertext.",
        ));
    }
    if reservation.expires_at <= OffsetDateTime::now_utc() {
        return Err(AppError::bad_request(
            "Invalid or expired attachment upload reservation",
        ));
    }
    insert_registered_attachment(
        &mut scope.transaction,
        &input,
        &scope.item,
        user_id,
        request_client_id,
        &reservation.id,
        reservation.storage_size,
    )
    .await?;
    scope
        .transaction
        .commit()
        .await
        .map_err(|e| database_error(e, "Failed to commit Attachment registration"))?;
    Ok(CreateAttachmentResponse {
        attachment_id: input.attachment_id,
    })
}
