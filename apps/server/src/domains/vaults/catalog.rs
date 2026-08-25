use serde_json::json;
use sqlx::{query, query_as, query_scalar, PgPool, Postgres, Transaction};
use time::OffsetDateTime;

use super::pagination::{bounded_page_ids, ItemPageWeight, VAULT_PAGE_QUERY_BYTES};
use super::{
    ByteBoundedPage, ConvertVaultTypeInput, ConvertVaultTypeResponse, CreateVaultImageUploadInput,
    CreateVaultInput, CreateVaultResponse, SuccessResponse, UpdateVaultInput, UpdateVaultResponse,
    VaultDetailsResponse, VaultIdInput, VaultListEntryResponse, VaultStatsResponse,
    VAULT_NAME_MAX_CHARS,
};
use crate::{
    config::{format_timestamp, DeploymentMode},
    db::events::{
        begin_sync_event_transaction, generate_resource_id, insert_audit_event, insert_sync_event,
    },
    db::{
        enums::{BillingPlan, BillingStatus, SyncEntityType, SyncEventType, VaultRole, VaultType},
        models::DbVaultRoleRow,
    },
    domains::{
        billing::entitlements::{
            load_team_billing_entitlement,
            resolve_vault_sharing_entitlement as shared_resolve_vault_sharing_entitlement,
            VaultSharingEntitlement,
        },
        vaults::key::validate_encrypted_vault_key,
    },
    error::AppError,
    integrations::storage,
    shared::transaction::{acquire_advisory_lock, database_error},
};

#[derive(Debug, sqlx::FromRow)]
struct DbVaultListRow {
    id: String,
    name: String,
    vault_type: VaultType,
    icon: Option<String>,
    image_key: Option<String>,
    role: VaultRole,
    encrypted_vault_key: String,
    created_by_id: String,
    item_count: i64,
}
#[derive(Debug, sqlx::FromRow)]
struct DbVaultGetRow {
    id: String,
    name: String,
    vault_type: VaultType,
    icon: Option<String>,
    image_key: Option<String>,
    user_role: VaultRole,
    item_count: i64,
    member_count: i64,
    created_at: OffsetDateTime,
}
#[derive(Debug, sqlx::FromRow)]
struct DbManagedVaultRow {
    name: String,
    icon: Option<String>,
    image_key: Option<String>,
    role: VaultRole,
}
#[derive(Debug, sqlx::FromRow)]
pub(super) struct DbVaultOwnerAccessRow {
    pub(super) vault_type: VaultType,
    pub(super) team_id: Option<String>,
    pub(super) role: VaultRole,
}
#[derive(Debug, sqlx::FromRow)]
struct DbVaultDeleteRow {
    image_key: Option<String>,
    role: VaultRole,
}
#[derive(Debug, sqlx::FromRow)]
struct DbVaultMemberAccessRow {
    user_id: String,
}
pub(crate) async fn list_vaults_page(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    cursor_id: Option<&str>,
    limit: i64,
) -> Result<ByteBoundedPage<VaultListEntryResponse>, AppError> {
    let cursor_created_at = if let Some(cursor_id) = cursor_id {
        let created_at = query_scalar::<_, OffsetDateTime>(
            "SELECT v.created_at FROM vault v JOIN vault_key vk ON vk.vault_id = v.id WHERE vk.user_id = $1 AND v.id = $2",
        )
        .bind(user_id)
        .bind(cursor_id)
        .fetch_optional(pool)
        .await
        .map_err(|error| database_error(error, "Failed to resolve vault page cursor"))?
        .ok_or_else(|| AppError::bad_request("Invalid cursor"))?;
        Some(created_at)
    } else {
        None
    };
    let weights = query_as::<_, ItemPageWeight>(
        r#"WITH candidates AS (
            SELECT v.id, ROW_NUMBER() OVER (ORDER BY v.created_at, v.id)::bigint AS position,
                   (8192 + octet_length(v.id) + octet_length(v.name) + octet_length(v.type::text)
                    + coalesce(octet_length(v.icon), 0) + coalesce(octet_length(v.image_key), 0)
                    + octet_length(vk.role::text) + octet_length(vk.encrypted_vault_key)
                    + octet_length(v.created_by_id))::bigint AS estimated_bytes
            FROM vault_key vk JOIN vault v ON v.id = vk.vault_id
            WHERE vk.user_id = $1
              AND ($2::timestamptz IS NULL OR (v.created_at, v.id) > ($2, $3))
            ORDER BY v.created_at, v.id LIMIT $4
        ), weighted AS (
            SELECT id, position, count(*) OVER ()::bigint AS candidate_count,
                   sum(estimated_bytes) OVER (ORDER BY position)::bigint AS cumulative_bytes
            FROM candidates
        )
        SELECT id, position, candidate_count, cumulative_bytes FROM weighted
        WHERE cumulative_bytes <= $5 OR position = 1 ORDER BY position"#,
    )
    .bind(user_id)
    .bind(cursor_created_at)
    .bind(cursor_id)
    .bind(limit)
    .bind(VAULT_PAGE_QUERY_BYTES)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load vaults"))?;

    let (vault_ids, has_more) = bounded_page_ids(
        weights,
        VAULT_PAGE_QUERY_BYTES,
        "A single vault exceeds the response page byte budget.",
    )?;
    if vault_ids.is_empty() {
        return Ok(ByteBoundedPage {
            values: Vec::new(),
            has_more: false,
        });
    }
    let vault_rows = query_as::<_, DbVaultListRow>(
        "SELECT v.id, v.name, v.type::text AS vault_type, v.icon, v.image_key, vk.role::text AS role, vk.encrypted_vault_key, v.created_by_id, (SELECT COUNT(*)::bigint FROM item i WHERE i.vault_id = v.id AND i.deleted_at IS NULL) AS item_count FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 AND v.id = ANY($2) ORDER BY array_position($2::text[], v.id)",
    )
    .bind(user_id)
    .bind(&vault_ids)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to materialize bounded vault page"))?;
    let values = vault_rows
        .into_iter()
        .map(|vault| VaultListEntryResponse {
            id: vault.id.clone(),
            name: vault.name,
            vault_type: vault.vault_type,
            icon: vault.icon,
            image_url: vault
                .image_key
                .as_deref()
                .and_then(|key| object_storage.public_url(key)),
            role: vault.role,
            item_count: vault.item_count.to_string(),
            encrypted_vault_key: vault.encrypted_vault_key,
            created_by_id: vault.created_by_id,
        })
        .collect();
    Ok(ByteBoundedPage { values, has_more })
}

pub(crate) async fn get_vault(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    input: VaultIdInput,
) -> Result<VaultDetailsResponse, AppError> {
    let Some(vault) = query_as::<_, DbVaultGetRow>(
		"SELECT v.id, v.name, v.type::text AS vault_type, v.icon, v.image_key, vk.role::text AS user_role, (SELECT COUNT(*)::bigint FROM item i WHERE i.vault_id = v.id AND i.deleted_at IS NULL) AS item_count, (SELECT COUNT(*)::bigint FROM vault_key member WHERE member.vault_id = v.id) AS member_count, v.created_at FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 AND v.id = $2 LIMIT 1",
	)
	.bind(user_id)
	.bind(&input.vault_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load vault"))?
	else {
		return Err(AppError::not_found("Vault not found or access denied"));
	};

    Ok(VaultDetailsResponse {
        id: vault.id,
        name: vault.name,
        vault_type: vault.vault_type,
        icon: vault.icon,
        image_url: vault
            .image_key
            .as_deref()
            .and_then(|key| object_storage.public_url(key)),
        user_role: vault.user_role,
        item_count: vault.item_count,
        member_count: vault.member_count,
        created_at: format_timestamp(vault.created_at),
    })
}

pub(crate) async fn create_vault_image_upload(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    input: CreateVaultImageUploadInput,
) -> Result<storage::PresignedUploadResult, AppError> {
    if !input.content_type.starts_with("image/") {
        return Err(AppError::bad_request("Only image uploads are allowed"));
    }
    if let Some(vault_id) = input.vault_id.as_deref() {
        let role = query_as::<_, DbVaultRoleRow>(
			"SELECT vault_id, role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
		)
		.bind(vault_id)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map_err(|error| database_error(error, "Failed to load vault role"))?;
        let Some(role) = role else {
            return Err(AppError::forbidden("Access denied"));
        };
        if !role.role.can_manage() {
            return Err(AppError::forbidden("Access denied"));
        }
    }

    let key = storage::create_vault_image_key(user_id, input.vault_id.as_deref(), &input.file_name);
    object_storage
        .presign_upload(&key, &input.content_type, None, None, None)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })
}

pub(crate) async fn create_vault(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    request_client_id: Option<&str>,
    input: CreateVaultInput,
) -> Result<CreateVaultResponse, AppError> {
    if input.name.trim().is_empty()
        || input.name.chars().count() > VAULT_NAME_MAX_CHARS
        || validate_encrypted_vault_key(&input.encrypted_vault_key).is_err()
    {
        return Err(AppError::bad_request("Invalid params"));
    }

    let vault_id = input
        .vault_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("vault"));
    let mut team_id: Option<String> = None;
    let mut shared_vault_limit: Option<i64> = None;
    if input.vault_type == VaultType::Team {
        let actor =
            load_team_billing_entitlement(pool, user_id, "Failed to load team membership").await?;
        let Some(actor) = actor else {
            return Err(AppError::bad_request(
                "You must belong to a team to create a team vault",
            ));
        };
        let Some(actor_team_id) = actor.team_id else {
            return Err(AppError::bad_request(
                "You must belong to a team to create a team vault",
            ));
        };
        let Some(plan) = actor.billing_plan else {
            return Err(AppError::bad_request(
                "You must belong to a team to create a team vault",
            ));
        };
        let Some(status) = actor.billing_status else {
            return Err(AppError::bad_request(
                "You must belong to a team to create a team vault",
            ));
        };

        let entitlement = resolve_vault_sharing_entitlement(deployment_mode, plan, status);
        if !entitlement.allowed {
            return Err(AppError::forbidden(
                "Shared vaults are only available on Family or Team plans with active billing.",
            ));
        }
        team_id = Some(actor_team_id);
        shared_vault_limit = entitlement.shared_vault_limit;
    }

    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start vault transaction"))?;
    if input.vault_type == VaultType::Team {
        if let (Some(team_id), Some(limit)) = (team_id.as_deref(), shared_vault_limit) {
            assert_shared_vault_quota(&mut transaction, team_id, limit).await?;
        }
    }

    insert_vault(
        &mut transaction,
        &vault_id,
        user_id,
        team_id.as_deref(),
        &input,
    )
    .await?;
    insert_vault_key(
        &mut transaction,
        &vault_id,
        user_id,
        &input.encrypted_vault_key,
    )
    .await?;
    insert_vault_created_sync_event(
        &mut transaction,
        &vault_id,
        user_id,
        input.client_id.as_deref().or(request_client_id),
    )
    .await?;
    insert_vault_created_audit_log(&mut *transaction, &vault_id, user_id).await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit vault transaction"))?;

    Ok(CreateVaultResponse { vault_id })
}

pub(crate) async fn update_vault(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    request_client_id: Option<&str>,
    input: UpdateVaultInput,
) -> Result<UpdateVaultResponse, AppError> {
    if let Some(name) = input.name.as_deref() {
        if name.trim().is_empty() || name.chars().count() > VAULT_NAME_MAX_CHARS {
            return Err(AppError::bad_request("Invalid params"));
        }
    }
    let Some(current_vault) = query_as::<_, DbManagedVaultRow>(
		"SELECT v.id, v.name, v.icon, v.image_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.vault_id = $1 AND vk.user_id = $2 LIMIT 1",
	)
	.bind(&input.vault_id)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load vault"))?
	else {
		return Err(AppError::forbidden("Access denied"));
	};
    if !current_vault.role.can_manage() {
        return Err(AppError::forbidden("Access denied"));
    }

    let old_image_key = current_vault.image_key.clone();
    let updated_name = input
        .name
        .as_deref()
        .map(str::trim)
        .unwrap_or(current_vault.name.as_str())
        .to_string();
    let updated_icon = input.icon.clone().unwrap_or(current_vault.icon.clone());
    let updated_image_key = input
        .image_key
        .clone()
        .unwrap_or(current_vault.image_key.clone());

    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start vault transaction"))?;
    query("UPDATE vault SET name = $1, icon = $2, image_key = $3, updated_at = $4 WHERE id = $5")
        .bind(&updated_name)
        .bind(updated_icon.as_deref())
        .bind(updated_image_key.as_deref())
        .bind(OffsetDateTime::now_utc())
        .bind(&input.vault_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to update vault"))?;
    insert_vault_updated_sync_event(
        &mut transaction,
        &input.vault_id,
        user_id,
        input.client_id.as_deref().or(request_client_id),
    )
    .await?;
    insert_vault_updated_audit_log(&mut *transaction, &input.vault_id, user_id).await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit vault update"))?;
    if let Some(old_image_key) = old_image_key {
        if Some(old_image_key.as_str()) != updated_image_key.as_deref() {
            let _ = object_storage.delete(&old_image_key).await;
        }
    }

    Ok(UpdateVaultResponse {
        id: input.vault_id,
        name: updated_name,
        icon: updated_icon,
        image_url: updated_image_key
            .as_deref()
            .and_then(|key| object_storage.public_url(key)),
    })
}

pub(crate) async fn convert_vault_type(
    pool: &PgPool,
    deployment_mode: DeploymentMode,
    user_id: &str,
    request_client_id: Option<&str>,
    input: ConvertVaultTypeInput,
) -> Result<ConvertVaultTypeResponse, AppError> {
    if let Some(personal_key) = input.personal_encrypted_vault_key.as_deref() {
        validate_encrypted_vault_key(personal_key)?;
    }
    let Some(owner_vault) = query_as::<_, DbVaultOwnerAccessRow>(
		"SELECT vk.user_id, v.id AS vault_id, v.type::text AS vault_type, v.team_id, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.vault_id = $1 AND vk.user_id = $2 LIMIT 1",
	)
	.bind(&input.vault_id)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load vault ownership"))?
	else {
		return Err(AppError::forbidden("Only the vault owner can convert vault type"));
	};
    if owner_vault.role != VaultRole::Owner {
        return Err(AppError::forbidden(
            "Only the vault owner can convert vault type",
        ));
    }
    let previous_type = owner_vault.vault_type;
    if previous_type == input.target_type {
        return Err(AppError::bad_request("Vault is already the requested type"));
    }

    let mut target_team_id = owner_vault.team_id.clone();
    let mut shared_vault_limit: Option<i64> = None;
    if previous_type == VaultType::Personal && input.target_type == VaultType::Team {
        let actor =
            load_team_billing_entitlement(pool, user_id, "Failed to load team membership").await?;
        let Some(actor) = actor else {
            return Err(AppError::bad_request(
                "You must belong to a team to convert to a shared vault",
            ));
        };
        let Some(team_id) = actor.team_id else {
            return Err(AppError::bad_request(
                "You must belong to a team to convert to a shared vault",
            ));
        };
        let Some(plan) = actor.billing_plan else {
            return Err(AppError::bad_request(
                "You must belong to a team to convert to a shared vault",
            ));
        };
        let Some(status) = actor.billing_status else {
            return Err(AppError::bad_request(
                "You must belong to a team to convert to a shared vault",
            ));
        };
        let entitlement = resolve_vault_sharing_entitlement(deployment_mode, plan, status);
        if !entitlement.allowed {
            return Err(AppError::forbidden(
                "Shared vaults are only available on Family or Team plans with active billing.",
            ));
        }
        target_team_id = Some(team_id);
        shared_vault_limit = entitlement.shared_vault_limit;
    }

    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start vault conversion transaction"))?;
    if previous_type == VaultType::Personal && input.target_type == VaultType::Team {
        if let (Some(team_id), Some(limit)) = (target_team_id.as_deref(), shared_vault_limit) {
            assert_shared_vault_quota(&mut transaction, team_id, limit).await?;
        }
        query("UPDATE vault SET type = 'team'::vault_type, team_id = $1, updated_at = $2 WHERE id = $3")
			.bind(target_team_id.as_deref())
			.bind(OffsetDateTime::now_utc())
			.bind(&input.vault_id)
			.execute(&mut *transaction)
			.await
			.map_err(|error| database_error(error, "Failed to convert vault to team"))?;
    } else if previous_type == VaultType::Team && input.target_type == VaultType::Personal {
        let member_rows = query_as::<_, DbVaultRoleRow>(
			"SELECT vault_id, role::text AS role FROM vault_key WHERE vault_id = $1 ORDER BY created_at ASC",
		)
		.bind(&input.vault_id)
		.fetch_all(&mut *transaction)
		.await
		.map_err(|error| database_error(error, "Failed to load vault members"))?;
        let member_count: i64 =
            query_scalar("SELECT COUNT(*)::bigint FROM vault_key WHERE vault_id = $1")
                .bind(&input.vault_id)
                .fetch_one(&mut *transaction)
                .await
                .map_err(|error| database_error(error, "Failed to count vault members"))?;
        if member_count != 1 || member_rows.first().map(|row| row.role) != Some(VaultRole::Owner) {
            return Err(AppError::bad_request(
                "Team vault can only be converted to personal when the owner is the only member",
            ));
        }
        query("UPDATE vault SET type = 'personal'::vault_type, team_id = NULL, updated_at = $1 WHERE id = $2")
			.bind(OffsetDateTime::now_utc())
			.bind(&input.vault_id)
			.execute(&mut *transaction)
			.await
			.map_err(|error| database_error(error, "Failed to convert vault to personal"))?;
        if let Some(personal_key) = input.personal_encrypted_vault_key.as_deref() {
            query("UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3")
				.bind(personal_key)
				.bind(&input.vault_id)
				.bind(user_id)
				.execute(&mut *transaction)
				.await
				.map_err(|error| database_error(error, "Failed to update personal vault key"))?;
        }
    }
    insert_vault_updated_sync_event(
        &mut transaction,
        &input.vault_id,
        user_id,
        input.client_id.as_deref().or(request_client_id),
    )
    .await?;
    insert_vault_updated_audit_log(&mut *transaction, &input.vault_id, user_id).await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit vault conversion"))?;

    Ok(ConvertVaultTypeResponse {
        success: true,
        vault_id: input.vault_id,
        previous_type,
        new_type: input.target_type,
    })
}

pub(crate) async fn delete_vault(
    pool: &PgPool,
    object_storage: &dyn storage::ObjectStorage,
    user_id: &str,
    request_client_id: Option<&str>,
    input: VaultIdInput,
) -> Result<SuccessResponse, AppError> {
    let Some(vault) = query_as::<_, DbVaultDeleteRow>(
		"SELECT v.id, v.name, v.type::text AS vault_type, v.image_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.vault_id = $1 AND vk.user_id = $2 LIMIT 1",
	)
	.bind(&input.vault_id)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load vault"))?
	else {
		return Err(AppError::forbidden("Only the vault owner can delete the vault"));
	};
    if vault.role != VaultRole::Owner {
        return Err(AppError::forbidden(
            "Only the vault owner can delete the vault",
        ));
    }

    let member_rows = query_as::<_, DbVaultMemberAccessRow>(
        "SELECT user_id FROM vault_key WHERE vault_id = $1 ORDER BY created_at ASC",
    )
    .bind(&input.vault_id)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load vault members"))?;

    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start vault delete transaction"))?;
    insert_vault_deleted_sync_event(
        &mut transaction,
        &input.vault_id,
        user_id,
        request_client_id,
    )
    .await?;
    for member in member_rows {
        if member.user_id == user_id {
            continue;
        }
        insert_vault_access_revoked_sync_event(
            &mut transaction,
            &input.vault_id,
            &member.user_id,
            request_client_id,
        )
        .await?;
    }
    query("DELETE FROM item_attachment WHERE vault_id = $1")
        .bind(&input.vault_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete vault attachments"))?;
    query("DELETE FROM item WHERE vault_id = $1")
        .bind(&input.vault_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete vault items"))?;
    query("DELETE FROM vault_key WHERE vault_id = $1")
        .bind(&input.vault_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete vault memberships"))?;
    query("DELETE FROM vault WHERE id = $1")
        .bind(&input.vault_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to delete vault"))?;
    insert_vault_deleted_audit_log(&mut *transaction, &input.vault_id, user_id).await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit vault deletion"))?;
    if let Some(image_key) = vault.image_key {
        let _ = object_storage.delete(&image_key).await;
    }

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn get_vault_stats(
    pool: &PgPool,
    user_id: &str,
) -> Result<VaultStatsResponse, AppError> {
    let team_count = query_scalar::<_, i64>(
		"SELECT CASE WHEN team_id IS NULL THEN 0 ELSE 1 END::bigint FROM \"user\" WHERE id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|error| database_error(error, "Failed to load user team info"))?
	.unwrap_or(0) as i32;
    let vault_count =
        query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM vault_key WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .map_err(|error| database_error(error, "Failed to count user vaults"))?;
    let item_count = query_scalar::<_, i64>(
		"SELECT COUNT(*)::bigint FROM item i INNER JOIN vault_key vk ON vk.vault_id = i.vault_id WHERE vk.user_id = $1 AND i.deleted_at IS NULL",
	)
	.bind(user_id)
	.fetch_one(pool)
	.await
	.map_err(|error| database_error(error, "Failed to count vault items"))?;

    Ok(VaultStatsResponse {
        team_count,
        vault_count,
        item_count,
    })
}

async fn insert_vault(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    team_id: Option<&str>,
    input: &CreateVaultInput,
) -> Result<(), AppError> {
    query(
		"INSERT INTO vault (id, name, type, icon, image_key, created_by_id, team_id, created_at, updated_at) VALUES ($1, $2, $3::vault_type, $4, $5, $6, $7, $8, $8)",
	)
	.bind(vault_id)
	.bind(input.name.trim())
	.bind(input.vault_type)
	.bind(input.icon.as_deref())
	.bind(input.image_key.as_deref())
	.bind(user_id)
	.bind(team_id)
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|error| database_error(error, "Failed to create vault"))?;
    Ok(())
}

async fn insert_vault_key(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    encrypted_vault_key: &str,
) -> Result<(), AppError> {
    validate_encrypted_vault_key(encrypted_vault_key)?;
    query("INSERT INTO vault_key (id,vault_id,user_id,encrypted_vault_key,role,created_at) VALUES ($1,$2,$3,$4,'owner',$5)")
        .bind(generate_resource_id("vault_key")).bind(vault_id).bind(user_id).bind(encrypted_vault_key).bind(OffsetDateTime::now_utc())
        .execute(&mut **transaction).await.map_err(|error| database_error(error, "Failed to create vault key"))?;
    Ok(())
}

async fn insert_vault_created_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
) -> Result<(), AppError> {
    insert_sync_event(
        transaction,
        SyncEventType::VaultCreated,
        vault_id,
        SyncEntityType::Vault,
        vault_id,
        user_id,
        1,
        client_id,
        None,
    )
    .await
}

async fn insert_vault_created_audit_log<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    vault_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    insert_audit_event(
        executor,
        &generate_resource_id("audit"),
        user_id,
        "vault_created",
        "vault",
        vault_id,
        None,
    )
    .await
}

async fn insert_vault_updated_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
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
        None,
    )
    .await
}

async fn insert_vault_updated_audit_log<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    vault_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    insert_audit_event(
        executor,
        &generate_resource_id("audit"),
        user_id,
        "vault_updated",
        "vault",
        vault_id,
        None,
    )
    .await
}

pub(crate) async fn insert_vault_audit_log_with_metadata<'e>(
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

pub(super) async fn insert_vault_member_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: SyncEventType,
    entity_id: &str,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    insert_sync_event(
        transaction,
        event_type,
        entity_id,
        SyncEntityType::VaultMember,
        vault_id,
        user_id,
        1,
        client_id,
        Some(&metadata.to_string()),
    )
    .await
}

async fn insert_vault_deleted_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
) -> Result<(), AppError> {
    insert_sync_event(
        transaction,
        SyncEventType::VaultDeleted,
        vault_id,
        SyncEntityType::Vault,
        vault_id,
        user_id,
        1,
        client_id,
        None,
    )
    .await
}

async fn insert_vault_access_revoked_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
) -> Result<(), AppError> {
    insert_sync_event(
        transaction,
        SyncEventType::VaultAccessRevoked,
        vault_id,
        SyncEntityType::Vault,
        vault_id,
        user_id,
        1,
        client_id,
        Some(&json!({ "reason": "vault_deleted", "vaultId": vault_id }).to_string()),
    )
    .await
}

async fn insert_vault_deleted_audit_log<'e>(
    executor: impl sqlx::Executor<'e, Database = Postgres>,
    vault_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    insert_audit_event(
        executor,
        &generate_resource_id("audit"),
        user_id,
        "vault_deleted",
        "vault",
        vault_id,
        None,
    )
    .await
}

async fn assert_shared_vault_quota(
    transaction: &mut Transaction<'_, Postgres>,
    team_id: &str,
    limit: i64,
) -> Result<(), AppError> {
    acquire_advisory_lock(
        &mut **transaction,
        &format!("shared-vaults:{team_id}"),
        "Failed to acquire shared vault limit lock",
    )
    .await?;
    let existing_count: i64 =
        query_scalar("SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1 AND type = 'team'")
            .bind(team_id)
            .fetch_one(&mut **transaction)
            .await
            .map_err(|error| database_error(error, "Failed to count shared vaults"))?;
    if existing_count >= limit {
        return Err(AppError::forbidden(format!(
            "Your current plan allows up to {limit} shared vaults. Upgrade to add more.",
        )));
    }
    Ok(())
}

pub(super) fn resolve_vault_sharing_entitlement(
    deployment_mode: DeploymentMode,
    plan: BillingPlan,
    status: BillingStatus,
) -> VaultSharingEntitlement {
    shared_resolve_vault_sharing_entitlement(deployment_mode.as_str(), Some(plan), Some(status))
}
