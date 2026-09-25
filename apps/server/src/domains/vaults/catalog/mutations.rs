//! Legacy and retained routes share the same locked Vault metadata effect.
use super::*;
use crate::db::enums::OperationKind;
use crate::domains::operations::{
    vault_mutation_operation_fingerprint, VaultMutationOperationRejectionCode,
    VaultMutationOperationResult,
};

pub(crate) struct UpdateVaultOperationInput {
    pub(crate) operation_id: String,
    pub(crate) raw_body: Vec<u8>,
    pub(crate) update: UpdateVaultInput,
}
struct UpdatedVault {
    name: String,
    icon: Option<String>,
    image_key: Option<String>,
    obsolete_image: Option<String>,
}
#[derive(sqlx::FromRow)]
struct LockedVault {
    name: String,
    icon: Option<String>,
    image_key: Option<String>,
    team_id: Option<String>,
    role: VaultRole,
}

fn validate_update(input: &UpdateVaultInput, retained: bool) -> Result<(), AppError> {
    if let Some(name) = input.name.as_deref() {
        if name.trim().chars().count() < if retained { VAULT_NAME_MIN_CHARS } else { 1 }
            || name.chars().count() > VAULT_NAME_MAX_CHARS
        {
            return Err(AppError::bad_request("Invalid params"));
        }
    }
    Ok(())
}

/// Authority is re-read after User, Team and Vault locks; an earlier catalog read never authorizes
/// a mutation or supplies omitted-field values. Concurrent legacy and retained edits share this.
async fn lock_vault(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    vault_id: &str,
) -> Result<Option<LockedVault>, AppError> {
    acquire_user_authority_lock(transaction, user_id, "Failed to lock Vault mutation actor")
        .await?;
    let Some(team_id) = query_scalar::<_, Option<String>>("SELECT team_id FROM vault WHERE id=$1")
        .bind(vault_id)
        .fetch_optional(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to locate Vault mutation authority"))?
    else {
        return Ok(None);
    };
    if let Some(team_id) = &team_id {
        acquire_team_authority_lock(
            &mut **transaction,
            team_id,
            "Failed to lock Vault mutation Team",
        )
        .await?;
    }
    let current = query_as::<_, LockedVault>(
        "SELECT v.name,v.icon,v.image_key,v.team_id,vk.role FROM vault v JOIN vault_key vk ON vk.vault_id=v.id WHERE v.id=$1 AND vk.user_id=$2 FOR UPDATE OF v,vk",
    ).bind(vault_id).bind(user_id).fetch_optional(&mut **transaction).await
        .map_err(|error| database_error(error, "Failed to lock current Vault mutation authority"))?;
    if current
        .as_ref()
        .is_some_and(|current| current.team_id != team_id)
    {
        return Err(AppError::retryable_conflict(
            "Vault authority changed while acquiring its locks. Retry the request.",
        ));
    }
    Ok(current)
}

async fn apply_update(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    request_client_id: Option<&str>,
    input: &UpdateVaultInput,
    object_storage: &dyn storage::ObjectStorage,
) -> Result<Option<UpdatedVault>, AppError> {
    let Some(current) = lock_vault(transaction, user_id, &input.vault_id).await? else {
        return Ok(None);
    };
    if !current.role.can_manage() {
        return Ok(None);
    }
    if input.name.is_none() && input.icon.is_none() && input.image_key.is_none() {
        return Ok(Some(UpdatedVault {
            name: current.name,
            icon: current.icon,
            image_key: current.image_key,
            obsolete_image: None,
        }));
    }
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .unwrap_or(&current.name)
        .to_owned();
    let icon = input.icon.clone().unwrap_or(current.icon);
    let image_key = input
        .image_key
        .clone()
        .unwrap_or_else(|| current.image_key.clone());
    super::super::vault_image_cleanup::prepare_change(
        transaction,
        current.image_key.as_deref(),
        image_key.as_deref(),
    )
    .await?;
    if image_key != current.image_key {
        if let Some(key) = image_key.as_deref() {
            let exists = object_storage.head(key).await.map_err(|_| {
                AppError::internal("Failed to verify Vault image object before adoption")
            })?;
            if exists.is_none() {
                return Err(AppError::bad_request("Vault image object is absent"));
            }
        }
    }
    query("UPDATE vault SET name=$1,icon=$2,image_key=$3,updated_at=$4 WHERE id=$5")
        .bind(&name)
        .bind(&icon)
        .bind(&image_key)
        .bind(OffsetDateTime::now_utc())
        .bind(&input.vault_id)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to update Vault metadata"))?;
    insert_vault_updated_sync_event(
        transaction,
        &input.vault_id,
        user_id,
        input.client_id.as_deref().or(request_client_id),
    )
    .await?;
    insert_vault_updated_audit_log(&mut **transaction, &input.vault_id, user_id).await?;
    let obsolete_image = current
        .image_key
        .filter(|old| Some(old) != image_key.as_ref());
    Ok(Some(UpdatedVault {
        name,
        icon,
        image_key,
        obsolete_image,
    }))
}

pub(crate) async fn update_vault(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    request_client_id: Option<&str>,
    input: UpdateVaultInput,
) -> Result<UpdateVaultResponse, AppError> {
    validate_update(&input, false)?;
    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start Vault update"))?;
    let updated = apply_update(
        &mut transaction,
        user_id,
        request_client_id,
        &input,
        object_storage,
    )
    .await?
    .ok_or_else(|| AppError::forbidden("Access denied"))?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Vault update"))?;
    if let Some(obsolete) = updated.obsolete_image {
        let _ =
            super::super::vault_image_cleanup::cleanup_key(pool, object_storage, &obsolete).await;
    }
    Ok(UpdateVaultResponse {
        id: input.vault_id,
        name: updated.name,
        icon: updated.icon,
        image_url: updated
            .image_key
            .as_deref()
            .and_then(|key| object_storage.public_url(key)),
    })
}

struct DeletedVault {
    obsolete_image: Option<String>,
}

async fn apply_delete(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: &str,
    request_client_id: Option<&str>,
    input: &VaultIdInput,
) -> Result<Option<DeletedVault>, AppError> {
    let Some(vault) = lock_vault(transaction, user_id, &input.vault_id).await? else {
        return Ok(None);
    };
    if vault.role != VaultRole::Owner {
        return Ok(None);
    }
    super::super::vault_image_cleanup::prepare_change(
        transaction,
        vault.image_key.as_deref(),
        None,
    )
    .await?;
    let member_rows = query_as::<_, DbVaultMemberAccessRow>(
        "SELECT user_id FROM vault_key WHERE vault_id=$1 ORDER BY created_at ASC FOR UPDATE",
    )
    .bind(&input.vault_id)
    .fetch_all(&mut **transaction)
    .await
    .map_err(|error| database_error(error, "Failed to lock Vault deletion members"))?;
    insert_vault_deleted_sync_event(transaction, &input.vault_id, user_id, request_client_id)
        .await?;
    for member in member_rows {
        if member.user_id == user_id {
            continue;
        }
        insert_vault_access_revoked_sync_event(
            transaction,
            &input.vault_id,
            &member.user_id,
            request_client_id,
        )
        .await?;
    }
    query("DELETE FROM item_attachment WHERE vault_id = $1")
        .bind(&input.vault_id)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete vault attachments"))?;
    query("DELETE FROM item WHERE vault_id = $1")
        .bind(&input.vault_id)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete vault items"))?;
    query("DELETE FROM vault_key WHERE vault_id = $1")
        .bind(&input.vault_id)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete vault memberships"))?;
    query("DELETE FROM vault WHERE id = $1")
        .bind(&input.vault_id)
        .execute(&mut **transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete vault"))?;
    insert_vault_deleted_audit_log(&mut **transaction, &input.vault_id, user_id).await?;
    Ok(Some(DeletedVault {
        obsolete_image: vault.image_key,
    }))
}

pub(crate) async fn delete_vault(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    request_client_id: Option<&str>,
    input: VaultIdInput,
) -> Result<SuccessResponse, AppError> {
    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start Vault deletion"))?;
    let deleted = apply_delete(&mut transaction, user_id, request_client_id, &input)
        .await?
        .ok_or_else(|| AppError::forbidden("Only the vault owner can delete the vault"))?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Vault deletion"))?;
    if let Some(obsolete) = deleted.obsolete_image {
        let _ =
            super::super::vault_image_cleanup::cleanup_key(pool, object_storage, &obsolete).await;
    }
    Ok(SuccessResponse { success: true })
}

pub(crate) struct DeleteVaultOperationInput {
    pub(crate) operation_id: String,
    pub(crate) raw_body: Vec<u8>,
    pub(crate) vault_id: String,
    pub(crate) client_id: Option<String>,
}

enum VaultMutation {
    Update(UpdateVaultInput),
    Delete {
        vault: VaultIdInput,
        client_id: Option<String>,
    },
}
impl VaultMutation {
    fn kind(&self) -> OperationKind {
        match self {
            Self::Update(_) => OperationKind::UpdateVault,
            Self::Delete { .. } => OperationKind::DeleteVault,
        }
    }
    fn vault_id(&self) -> &str {
        match self {
            Self::Update(input) => &input.vault_id,
            Self::Delete { vault, .. } => &vault.vault_id,
        }
    }
    fn client_id(&self) -> Option<&str> {
        match self {
            Self::Update(input) => input.client_id.as_deref(),
            Self::Delete { client_id, .. } => client_id.as_deref(),
        }
    }
}

pub(crate) async fn execute_update_vault_operation(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    input: UpdateVaultOperationInput,
) -> Result<OperationResolution, AppError> {
    validate_update(&input.update, true)?;
    execute_vault_mutation(
        pool,
        object_storage,
        user_id,
        input.operation_id,
        input.raw_body,
        VaultMutation::Update(input.update),
    )
    .await
}

pub(crate) async fn execute_delete_vault_operation(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    input: DeleteVaultOperationInput,
) -> Result<OperationResolution, AppError> {
    execute_vault_mutation(
        pool,
        object_storage,
        user_id,
        input.operation_id,
        input.raw_body,
        VaultMutation::Delete {
            vault: VaultIdInput {
                vault_id: input.vault_id,
            },
            client_id: input.client_id,
        },
    )
    .await
}

async fn execute_vault_mutation(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    operation_id: String,
    raw_body: Vec<u8>,
    mutation: VaultMutation,
) -> Result<OperationResolution, AppError> {
    validate_resource_id(mutation.vault_id())?;
    let kind = mutation.kind();
    let fingerprint = vault_mutation_operation_fingerprint(kind, mutation.vault_id(), &raw_body);
    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start retained Vault mutation"))?;
    acquire_operation_lock(
        &mut *transaction,
        user_id,
        &operation_id,
        "Failed to serialize Vault mutation Operation",
    )
    .await?;
    if let Some(existing) = query_scalar::<_, Vec<u8>>(
        "SELECT request_fingerprint FROM operation_outcome WHERE user_id=$1 AND operation_id=$2",
    )
    .bind(user_id)
    .bind(&operation_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to load retained Vault mutation"))?
    {
        if existing != fingerprint {
            return Ok(OperationResolution::IdReused);
        }
        transaction
            .commit()
            .await
            .map_err(|error| database_error(error, "Failed to replay retained Vault mutation"))?;
        let outcome =
            crate::domains::operations::get_operation_outcome(pool, user_id, &operation_id)
                .await?
                .ok_or_else(|| AppError::internal("Retained Vault mutation disappeared"))?;
        return Ok(OperationResolution::Outcome {
            outcome,
            newly_committed: false,
        });
    }
    let staged_image = match &mutation {
        VaultMutation::Update(input) => input.image_key.as_ref().and_then(|key| key.as_deref()),
        VaultMutation::Delete { .. } => None,
    };
    if let Some(image_key) = staged_image {
        super::super::vault_image_staging::require_confirmed_publication(
            &mut transaction,
            user_id,
            &operation_id,
            mutation.vault_id(),
            image_key,
        )
        .await?;
    }
    let obsolete_image = match &mutation {
        VaultMutation::Update(input) => {
            apply_update(&mut transaction, user_id, None, input, object_storage)
                .await?
                .map(|updated| updated.obsolete_image)
        }
        VaultMutation::Delete { vault, client_id } => {
            apply_delete(&mut transaction, user_id, client_id.as_deref(), vault)
                .await?
                .map(|deleted| deleted.obsolete_image)
        }
    };
    let result = if obsolete_image.is_some() {
        query("INSERT INTO operation_outcome(user_id,operation_id,operation_kind,request_fingerprint,result_status,applied_payload) VALUES($1,$2,$3::operation_kind,$4,'applied',$5)")
            .bind(user_id).bind(&operation_id).bind(kind).bind(fingerprint.as_slice()).bind(json!({"vaultId":mutation.vault_id()}))
            .execute(&mut *transaction).await.map_err(|error| database_error(error, "Failed to retain applied Vault mutation"))?;
        VaultMutationOperationResult::Applied {
            vault_id: mutation.vault_id().to_owned(),
        }
    } else {
        let audit_action = match kind {
            OperationKind::UpdateVault => "vault_update_rejected",
            OperationKind::DeleteVault => "vault_delete_rejected",
            _ => unreachable!(),
        };
        insert_audit_event(
            &mut *transaction,
            &generate_resource_id("audit"),
            user_id,
            audit_action,
            "operation",
            &operation_id,
            Some(json!({"code":"vault_access_denied"})),
        )
        .await?;
        query("INSERT INTO operation_outcome(user_id,operation_id,operation_kind,request_fingerprint,result_status,rejection_code) VALUES($1,$2,$3::operation_kind,$4,'rejected','vault_access_denied')")
            .bind(user_id).bind(&operation_id).bind(kind).bind(fingerprint.as_slice()).execute(&mut *transaction).await
            .map_err(|error| database_error(error, "Failed to retain rejected Vault mutation"))?;
        VaultMutationOperationResult::Rejected {
            code: VaultMutationOperationRejectionCode::VaultAccessDenied,
        }
    };
    if staged_image.is_some() {
        super::super::vault_image_staging::resolve_publication(
            &mut transaction,
            user_id,
            &operation_id,
            obsolete_image.is_some(),
        )
        .await?;
    }
    insert_user_sync_event(
        &mut transaction,
        SyncEventType::OperationResolved,
        &operation_id,
        SyncEntityType::Operation,
        user_id,
        1,
        mutation.client_id(),
        None,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit retained Vault mutation"))?;
    if let Some(Some(obsolete)) = obsolete_image {
        let _ =
            super::super::vault_image_cleanup::cleanup_key(pool, object_storage, &obsolete).await;
    }
    Ok(OperationResolution::Outcome {
        outcome: OperationOutcome::new_vault_mutation(kind, operation_id, result),
        newly_committed: true,
    })
}
