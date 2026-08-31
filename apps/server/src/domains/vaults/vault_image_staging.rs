use sha2::{Digest, Sha256};
use sqlx::{query, query_as, query_scalar, PgPool};
use time::OffsetDateTime;

use crate::{
    error::AppError,
    integrations::storage::ObjectStorage,
    shared::{
        transaction::{acquire_advisory_lock, acquire_operation_lock, database_error},
        validate_resource_id,
    },
};

const MAX_USER_BINDINGS: i64 = 64;
const MAX_USER_RAW_BYTES: i64 = 128 * 1024 * 1024;
const MAX_IMAGE_BYTES: i64 = 2 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES: &[&str] = &[
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
];

#[cfg(test)]
fn inject_database_failure(
    operation_id: &str,
    boundary: crate::test_support::VaultImageDatabaseBoundary,
    context: &'static str,
) -> Result<(), AppError> {
    crate::test_support::fail_vault_image_database_boundary(operation_id, boundary)
        .map_err(|error| database_error(error, context))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VaultImageStagingBinding {
    pub(crate) operation_id: String,
    pub(crate) vault_id: String,
    pub(crate) raw_sha256: String,
    pub(crate) raw_length: i64,
    pub(crate) content_type: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VaultImageStagingGrant {
    pub(crate) object_key: String,
    pub(crate) upload_url: String,
    pub(crate) generation: i64,
    pub(crate) lease_expires_at: OffsetDateTime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum VaultImageStagingState {
    Unconfirmed,
    Confirmed,
    CleanupPending,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VaultImageStagingStatus {
    pub(crate) object_key: String,
    pub(crate) state: VaultImageStagingState,
    pub(crate) generation: i64,
    pub(crate) lease_expires_at: OffsetDateTime,
}

impl VaultImageStagingState {
    fn from_db(value: &str) -> Result<Self, AppError> {
        match value {
            "unconfirmed" => Ok(Self::Unconfirmed),
            "confirmed" => Ok(Self::Confirmed),
            "cleanup_pending" => Ok(Self::CleanupPending),
            _ => Err(AppError::internal("Invalid Vault image staging state")),
        }
    }
}

fn validate_binding(binding: &VaultImageStagingBinding) -> Result<(), AppError> {
    validate_resource_id(&binding.operation_id)?;
    validate_resource_id(&binding.vault_id)?;
    if binding.raw_sha256.len() != 64
        || !binding
            .raw_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || !(1..=MAX_IMAGE_BYTES).contains(&binding.raw_length)
        || !ALLOWED_CONTENT_TYPES.contains(&binding.content_type.as_str())
    {
        return Err(AppError::bad_request("Invalid Vault image staging binding"));
    }
    Ok(())
}

fn binding_fingerprint(binding: &VaultImageStagingBinding) -> String {
    hex::encode(Sha256::digest(
        format!(
            "{}\0{}\0{}\0{}\0{}",
            binding.operation_id,
            binding.vault_id,
            binding.raw_sha256,
            binding.raw_length,
            binding.content_type
        )
        .as_bytes(),
    ))
}

fn object_key(user_id: &str, binding: &VaultImageStagingBinding) -> String {
    format!(
        "vaults/{}/{}/create/{}-{}",
        user_id, binding.vault_id, binding.operation_id, binding.raw_sha256
    )
}

pub(crate) async fn grant_vault_image_staging(
    pool: &PgPool,
    object_storage: &dyn ObjectStorage,
    user_id: &str,
    binding: VaultImageStagingBinding,
) -> Result<VaultImageStagingGrant, AppError> {
    validate_resource_id(user_id)?;
    validate_binding(&binding)?;
    let fingerprint = binding_fingerprint(&binding);
    let key = object_key(user_id, &binding);
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to begin Vault image staging"))?;
    acquire_advisory_lock(
        &mut *transaction,
        &format!("vault-image-user-quota:{}:{user_id}", user_id.len()),
        "Failed to lock Vault image staging quota",
    )
    .await?;
    acquire_operation_lock(
        &mut *transaction,
        user_id,
        &binding.operation_id,
        "Failed to lock Vault image staging binding",
    )
    .await?;

    let existing = query_as::<_, (String, i64, String)>(
        "SELECT binding_fingerprint, generation, COALESCE((SELECT state FROM vault_image_staging WHERE user_id = $1 AND operation_id = $2), 'absent') FROM vault_image_staging_generation WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(&binding.operation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to read Vault image staging binding"))?;
    let generation = match existing {
        Some((existing_fingerprint, generation, state)) => {
            if existing_fingerprint != fingerprint {
                return Err(AppError::operation_id_reused(
                    "Operation ID was reused with a different Vault image binding",
                ));
            }
            if state == "cleanup_pending" {
                return Err(AppError::conflict("Vault image staging cleanup is active"));
            }
            if state == "absent" {
                let generation = query_scalar::<_, i64>("UPDATE vault_image_staging_generation SET generation = generation + 1 WHERE user_id = $1 AND operation_id = $2 RETURNING generation")
                    .bind(user_id)
                    .bind(&binding.operation_id)
                    .fetch_one(&mut *transaction)
                    .await
                    .map_err(|error| database_error(error, "Failed to advance Vault image staging generation"))?;
                #[cfg(test)]
                inject_database_failure(
                    &binding.operation_id,
                    crate::test_support::VaultImageDatabaseBoundary::GenerationAdvance,
                    "Failed to advance Vault image staging generation",
                )?;
                generation
            } else {
                generation
            }
        }
        None => {
            query("INSERT INTO vault_image_staging_generation (user_id, operation_id, binding_fingerprint, generation) VALUES ($1, $2, $3, 1)")
                .bind(user_id)
                .bind(&binding.operation_id)
                .bind(&fingerprint)
                .execute(&mut *transaction)
                .await
                .map_err(|error| database_error(error, "Failed to create Vault image staging generation"))?;
            #[cfg(test)]
            inject_database_failure(
                &binding.operation_id,
                crate::test_support::VaultImageDatabaseBoundary::GenerationInsert,
                "Failed to create Vault image staging generation",
            )?;
            1
        }
    };

    let present = query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM vault_image_staging WHERE user_id = $1 AND operation_id = $2)",
    )
    .bind(user_id)
    .bind(&binding.operation_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to inspect Vault image staging replay"))?;
    let lease_expires_at = if present {
        let lease_expires_at = query_scalar::<_, OffsetDateTime>("UPDATE vault_image_staging SET lease_expires_at = NOW() + INTERVAL '24 hours', updated_at = NOW() WHERE user_id = $1 AND operation_id = $2 RETURNING lease_expires_at")
            .bind(user_id)
            .bind(&binding.operation_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|error| database_error(error, "Failed to renew Vault image staging lease"))?;
        #[cfg(test)]
        inject_database_failure(
            &binding.operation_id,
            crate::test_support::VaultImageDatabaseBoundary::ReplayRenewal,
            "Failed to renew Vault image staging lease",
        )?;
        lease_expires_at
    } else {
        let (slots, bytes) = query_as::<_, (i64, i64)>(
            "SELECT COUNT(*)::bigint, COALESCE(SUM(raw_length), 0)::bigint FROM vault_image_staging WHERE user_id = $1",
        )
        .bind(user_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to read Vault image staging quota"))?;
        #[cfg(test)]
        inject_database_failure(
            &binding.operation_id,
            crate::test_support::VaultImageDatabaseBoundary::QuotaRead,
            "Failed to read Vault image staging quota",
        )?;
        if slots >= MAX_USER_BINDINGS || bytes + binding.raw_length > MAX_USER_RAW_BYTES {
            return Err(AppError::vault_image_staging_quota_exceeded(
                "Vault image staging quota exceeded",
            ));
        }
        let lease_expires_at = query_scalar::<_, OffsetDateTime>("INSERT INTO vault_image_staging (user_id, operation_id, vault_id, object_key, raw_sha256, raw_length, content_type, state, generation, lease_expires_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'unconfirmed', $8, NOW() + INTERVAL '24 hours', NOW()) RETURNING lease_expires_at")
            .bind(user_id)
            .bind(&binding.operation_id)
            .bind(&binding.vault_id)
            .bind(&key)
            .bind(&binding.raw_sha256)
            .bind(binding.raw_length)
            .bind(&binding.content_type)
            .bind(generation)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|error| database_error(error, "Failed to create Vault image staging binding"))?;
        #[cfg(test)]
        inject_database_failure(
            &binding.operation_id,
            crate::test_support::VaultImageDatabaseBoundary::QuotaAdmission,
            "Failed to create Vault image staging binding",
        )?;
        lease_expires_at
    };
    #[cfg(test)]
    inject_database_failure(
        &binding.operation_id,
        crate::test_support::VaultImageDatabaseBoundary::GrantCommit,
        "Failed to commit Vault image staging binding",
    )?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Vault image staging binding"))?;

    let upload = object_storage
        .presign_exact_upload(
            &key,
            &binding.content_type,
            binding.raw_length,
            &binding.raw_sha256,
            Some(300),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "Vault image staging credential creation failed");
            AppError::internal("Vault image staging credential creation failed")
        })?;
    if upload.key != key {
        return Err(AppError::internal(
            "Vault image staging credential named a different object",
        ));
    }
    Ok(VaultImageStagingGrant {
        object_key: upload.key,
        upload_url: upload.upload_url,
        generation,
        lease_expires_at,
    })
}

pub(crate) async fn status_vault_image_staging(
    pool: &PgPool,
    user_id: &str,
    binding: &VaultImageStagingBinding,
) -> Result<Option<VaultImageStagingStatus>, AppError> {
    validate_resource_id(user_id)?;
    validate_binding(binding)?;
    let fingerprint = binding_fingerprint(binding);
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to begin Vault image staging status"))?;
    acquire_operation_lock(
        &mut *transaction,
        user_id,
        &binding.operation_id,
        "Failed to lock Vault image staging status",
    )
    .await?;
    let generation_fingerprint = query_scalar::<_, String>(
        "SELECT binding_fingerprint FROM vault_image_staging_generation WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(&binding.operation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to read Vault image staging identity"))?;
    let Some(generation_fingerprint) = generation_fingerprint else {
        transaction.rollback().await.ok();
        return Ok(None);
    };
    if generation_fingerprint != fingerprint {
        return Err(AppError::operation_id_reused(
            "Operation ID was reused with a different Vault image binding",
        ));
    }
    let row = query_as::<_, (String, String, i64, OffsetDateTime)>(
        "UPDATE vault_image_staging SET lease_expires_at = CASE WHEN state = 'cleanup_pending' THEN lease_expires_at ELSE NOW() + INTERVAL '24 hours' END, updated_at = CASE WHEN state = 'cleanup_pending' THEN updated_at ELSE NOW() END WHERE user_id = $1 AND operation_id = $2 RETURNING object_key, state, generation, lease_expires_at",
    )
    .bind(user_id)
    .bind(&binding.operation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to renew Vault image staging status"))?;
    #[cfg(test)]
    inject_database_failure(
        &binding.operation_id,
        crate::test_support::VaultImageDatabaseBoundary::StatusRenewal,
        "Failed to renew Vault image staging status",
    )?;
    #[cfg(test)]
    inject_database_failure(
        &binding.operation_id,
        crate::test_support::VaultImageDatabaseBoundary::StatusCommit,
        "Failed to commit Vault image staging status",
    )?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Vault image staging status"))?;
    row.map(|(object_key, state, generation, lease_expires_at)| {
        Ok(VaultImageStagingStatus {
            object_key,
            state: VaultImageStagingState::from_db(&state)?,
            generation,
            lease_expires_at,
        })
    })
    .transpose()
}

pub(crate) async fn confirm_vault_image_staging(
    pool: &PgPool,
    object_storage: &dyn ObjectStorage,
    user_id: &str,
    binding: &VaultImageStagingBinding,
) -> Result<VaultImageStagingStatus, AppError> {
    validate_resource_id(user_id)?;
    validate_binding(binding)?;
    let fingerprint = binding_fingerprint(binding);
    let mut transaction = pool.begin().await.map_err(|error| {
        database_error(error, "Failed to begin Vault image staging confirmation")
    })?;
    acquire_operation_lock(
        &mut *transaction,
        user_id,
        &binding.operation_id,
        "Failed to lock Vault image staging confirmation",
    )
    .await?;
    let existing_fingerprint = query_scalar::<_, String>(
        "SELECT binding_fingerprint FROM vault_image_staging_generation WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(&binding.operation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to read Vault image staging confirmation identity"))?
    .ok_or_else(|| AppError::conflict("Vault image staging binding is absent"))?;
    if existing_fingerprint != fingerprint {
        return Err(AppError::operation_id_reused(
            "Operation ID was reused with a different Vault image binding",
        ));
    }
    let status = query_as::<_, (String, String, i64, OffsetDateTime)>(
        "SELECT object_key, state, generation, lease_expires_at FROM vault_image_staging WHERE user_id = $1 AND operation_id = $2 FOR UPDATE",
    )
    .bind(user_id)
    .bind(&binding.operation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to read Vault image staging confirmation"))?
    .ok_or_else(|| AppError::conflict("Vault image staging binding is absent"))?;
    if VaultImageStagingState::from_db(&status.1)? == VaultImageStagingState::CleanupPending {
        return Err(AppError::conflict("Vault image staging cleanup is active"));
    }
    let head = object_storage
        .head(&status.0)
        .await
        .map_err(|error| {
            tracing::error!(%error, "Vault image staging confirmation failed");
            AppError::internal("Vault image staging confirmation failed")
        })?
        .ok_or_else(|| AppError::conflict("Vault image staging object is absent"))?;
    if head.size != binding.raw_length
        || head.content_type.as_deref() != Some(binding.content_type.as_str())
        || head.payload_sha256.as_deref() != Some(binding.raw_sha256.as_str())
    {
        return Err(AppError::conflict(
            "Vault image staging object does not match",
        ));
    }
    let row = query_as::<_, (String, String, i64, OffsetDateTime)>(
        "UPDATE vault_image_staging SET state = 'confirmed', lease_expires_at = NOW() + INTERVAL '24 hours', updated_at = NOW() WHERE user_id = $1 AND operation_id = $2 AND generation = $3 AND state IN ('unconfirmed', 'confirmed') RETURNING object_key, state, generation, lease_expires_at",
    )
    .bind(user_id)
    .bind(&binding.operation_id)
    .bind(status.2)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to confirm Vault image staging object"))?
    .ok_or_else(|| AppError::conflict("Vault image staging generation changed"))?;
    #[cfg(test)]
    inject_database_failure(
        &binding.operation_id,
        crate::test_support::VaultImageDatabaseBoundary::Confirmation,
        "Failed to confirm Vault image staging object",
    )?;
    #[cfg(test)]
    inject_database_failure(
        &binding.operation_id,
        crate::test_support::VaultImageDatabaseBoundary::ConfirmationCommit,
        "Failed to commit Vault image staging confirmation",
    )?;
    transaction.commit().await.map_err(|error| {
        database_error(error, "Failed to commit Vault image staging confirmation")
    })?;
    Ok(VaultImageStagingStatus {
        object_key: row.0,
        state: VaultImageStagingState::from_db(&row.1)?,
        generation: row.2,
        lease_expires_at: row.3,
    })
}

pub(crate) async fn request_vault_image_staging_cleanup(
    pool: &PgPool,
    user_id: &str,
    binding: &VaultImageStagingBinding,
) -> Result<(), AppError> {
    validate_resource_id(user_id)?;
    validate_binding(binding)?;
    let fingerprint = binding_fingerprint(binding);
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to begin Vault image staging cleanup"))?;
    acquire_operation_lock(
        &mut *transaction,
        user_id,
        &binding.operation_id,
        "Failed to lock Vault image staging cleanup",
    )
    .await?;
    let existing = query_scalar::<_, String>(
        "SELECT binding_fingerprint FROM vault_image_staging_generation WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(&binding.operation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to read Vault image staging cleanup identity"))?;
    let Some(existing) = existing else {
        transaction.rollback().await.ok();
        return Ok(());
    };
    if existing != fingerprint {
        return Err(AppError::operation_id_reused(
            "Operation ID was reused with a different Vault image binding",
        ));
    }
    query("UPDATE vault_image_staging SET state = 'cleanup_pending', updated_at = NOW() WHERE user_id = $1 AND operation_id = $2")
        .bind(user_id)
        .bind(&binding.operation_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to request Vault image staging cleanup"))?;
    #[cfg(test)]
    inject_database_failure(
        &binding.operation_id,
        crate::test_support::VaultImageDatabaseBoundary::CleanupRequest,
        "Failed to request Vault image staging cleanup",
    )?;
    #[cfg(test)]
    inject_database_failure(
        &binding.operation_id,
        crate::test_support::VaultImageDatabaseBoundary::CleanupRequestCommit,
        "Failed to commit Vault image staging cleanup",
    )?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Vault image staging cleanup"))?;
    Ok(())
}
