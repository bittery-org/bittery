use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{query, query_as, query_scalar, PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use utoipa::ToSchema;

use crate::{
    config::{bittery_mode, format_timestamp},
    db::models::*,
    error::{AppError, AppErrorCode},
    integrations::storage,
    repo::common::{generate_resource_id, insert_audit_event, insert_sync_event},
    services::team_billing::{
        load_team_billing_entitlement, resolve_attachment_entitlement,
        resolve_vault_sharing_entitlement as shared_resolve_vault_sharing_entitlement,
        VaultSharingEntitlement,
    },
};

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VaultIdInput {
    pub vault_id: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateVaultImageUploadInput {
    pub vault_id: Option<String>,
    pub file_name: String,
    pub content_type: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ItemIdInput {
    pub item_id: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateAttachmentUploadInput {
    pub item_id: String,
    pub file_name: String,
    pub content_type: String,
    pub file_size: i32,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateAttachmentInput {
    pub item_id: String,
    pub storage_key: String,
    pub encrypted_name: String,
    pub encrypted_content_type: String,
    pub encryption_iv: String,
    pub encrypted_content_type_iv: String,
    pub encryption_algorithm: Option<String>,
    pub file_size: i32,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateAttachmentResponse {
    pub attachment_id: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct AttachmentIdInput {
    pub attachment_id: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateAttachmentInput {
    pub attachment_id: String,
    pub encrypted_name: String,
    pub encryption_iv: String,
    pub encryption_algorithm: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateVaultMemberRoleInput {
    pub vault_id: String,
    pub user_id: String,
    pub role: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LookupVaultUserInput {
    pub vault_id: String,
    pub email: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct AddVaultMemberInput {
    pub vault_id: String,
    pub user_id: String,
    pub role: String,
    pub encrypted_vault_key: String,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GetVaultRotationDataInput {
    pub vault_id: String,
    pub exclude_user_id: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RotationMemberKeyInput {
    pub user_id: String,
    pub encrypted_vault_key: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RotationReEncryptedItemInput {
    pub item_id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VaultKeyRotationInput {
    pub member_keys: Vec<RotationMemberKeyInput>,
    pub re_encrypted_items: Vec<RotationReEncryptedItemInput>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RemoveVaultMemberInput {
    pub vault_id: String,
    pub user_id: String,
    pub key_rotation: VaultKeyRotationInput,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateItemInput {
    pub item_id: Option<String>,
    pub vault_id: String,
    pub category: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: Option<String>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateItemResponse {
    pub item_id: String,
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BulkImportItemInput {
    pub item_id: String,
    pub category: String,
    pub favorite: Option<bool>,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BulkImportItemsInput {
    pub vault_id: String,
    pub client_id: Option<String>,
    pub items: Vec<BulkImportItemInput>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct BulkImportItemsResponse {
    pub success: bool,
    pub imported_count: usize,
    pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateItemInput {
    pub item_id: String,
    pub encrypted_data: Option<String>,
    pub encryption_iv: Option<String>,
    pub encryption_algorithm: Option<String>,
    pub expected_version: Option<i32>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateItemResponse {
    pub success: bool,
    pub version: i32,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct MoveItemInput {
    pub item_id: String,
    pub source_vault_id: String,
    pub target_vault_id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: Option<String>,
    pub expected_version: Option<i32>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ToggleFavoriteInput {
    pub item_id: String,
    pub favorite: bool,
    pub expected_version: Option<i32>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ItemClientInput {
    pub item_id: String,
    pub expected_version: Option<i32>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateVaultInput {
    pub vault_id: Option<String>,
    pub name: String,
    pub vault_type: String,
    pub encrypted_vault_key: String,
    pub icon: Option<String>,
    pub image_key: Option<String>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultItemResponse {
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
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultListEntryResponse {
    pub id: String,
    pub name: String,
    pub vault_type: String,
    pub icon: Option<String>,
    pub image_url: Option<String>,
    pub role: String,
    pub items: Vec<VaultItemResponse>,
    pub encrypted_vault_key: String,
    pub created_by_id: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultDetailsResponse {
    pub id: String,
    pub name: String,
    pub vault_type: String,
    pub icon: Option<String>,
    pub image_url: Option<String>,
    pub user_role: String,
    pub item_count: i64,
    pub member_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateVaultResponse {
    pub vault_id: String,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateVaultInput {
    pub vault_id: String,
    pub name: Option<String>,
    pub icon: Option<Option<String>>,
    pub image_key: Option<Option<String>>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateVaultResponse {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ConvertVaultTypeInput {
    pub vault_id: String,
    pub target_type: String,
    pub personal_encrypted_vault_key: Option<String>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConvertVaultTypeResponse {
    pub success: bool,
    pub vault_id: String,
    pub previous_type: String,
    pub new_type: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SuccessResponse {
    pub success: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultAttachmentResponse {
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

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultItemDetailsResponse {
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
    pub attachments: Vec<VaultAttachmentResponse>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultSummaryResponse {
    pub id: String,
    pub name: String,
    pub vault_type: String,
    pub icon: Option<String>,
    pub image_url: Option<String>,
    pub encrypted_vault_key: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultItemWithVaultResponse {
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
    pub attachments: Vec<VaultAttachmentResponse>,
    pub vault: Option<VaultSummaryResponse>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeletedVaultItemWithVaultResponse {
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
    pub vault: Option<VaultSummaryResponse>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatsResponse {
    pub team_count: i32,
    pub vault_count: i64,
    pub item_count: i64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultMemberResponse {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultAvailableMemberResponse {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultLookupUserResponse {
    pub id: String,
    pub name: String,
    pub email: String,
    pub public_key: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultRotationMemberResponse {
    pub user_id: String,
    pub public_key: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultRotationItemResponse {
    pub id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
    /// The client rebuilds this item's AAD from these; rotation does not change either.
    pub version: i32,
    pub last_modified_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultRotationDataResponse {
    pub key_version: i32,
    pub members: Vec<VaultRotationMemberResponse>,
    pub items: Vec<VaultRotationItemResponse>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VaultKeyRotationSummaryResponse {
    pub id: String,
    pub new_key_version: i32,
    pub items_re_encrypted: usize,
    pub members_updated: usize,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoveVaultMemberResponse {
    pub success: bool,
    pub key_rotation: VaultKeyRotationSummaryResponse,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDownloadResponse {
    pub download_url: String,
    pub encrypted_name: String,
    pub encrypted_content_type: String,
    pub encryption_iv: String,
    pub encrypted_content_type_iv: String,
    pub encryption_algorithm: String,
    pub file_size: i32,
}

struct AttachmentActor {
    team_id: String,
    attachment_max_file_size_bytes: Option<i64>,
    attachment_storage_bytes: Option<i64>,
}

async fn fetch_vaults_and_items(
    user_id: &str,
    pool: &PgPool,
) -> Result<Vec<VaultListEntryResponse>, AppError> {
    let vault_rows = query_as::<_, DbVaultListRow>(
        "SELECT v.id, v.name, v.type::text AS vault_type, v.icon, v.image_key, vk.role::text AS role, vk.encrypted_vault_key, v.created_by_id FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 ORDER BY v.created_at ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load vaults");
        AppError::internal("Failed to load vaults")
    })?;

    if vault_rows.is_empty() {
        return Ok(Vec::new());
    }

    let vault_ids: Vec<String> = vault_rows.iter().map(|vault| vault.id.clone()).collect();
    let item_rows = query_as::<_, DbBootstrapItemRow>(
        "SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = ANY($1) ORDER BY created_at ASC",
    )
    .bind(&vault_ids)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load vault items");
        AppError::internal("Failed to load vault items")
    })?;

    let mut items_by_vault = HashMap::<String, Vec<VaultItemResponse>>::new();
    for item in item_rows {
        items_by_vault
            .entry(item.vault_id.clone())
            .or_default()
            .push(map_item(item));
    }

    Ok(vault_rows
        .into_iter()
        .map(|vault| VaultListEntryResponse {
            id: vault.id.clone(),
            name: vault.name,
            vault_type: vault.vault_type,
            icon: vault.icon,
            image_url: vault
                .image_key
                .as_deref()
                .and_then(storage::public_asset_url),
            role: vault.role,
            items: items_by_vault.remove(&vault.id).unwrap_or_default(),
            encrypted_vault_key: vault.encrypted_vault_key,
            created_by_id: vault.created_by_id,
        })
        .collect())
}

pub(crate) async fn list_vaults(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<VaultListEntryResponse>, AppError> {
    fetch_vaults_and_items(user_id, pool).await
}

pub(crate) async fn get_vault(
    pool: &PgPool,
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault"); AppError::internal("Failed to load vault") })?
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
            .and_then(storage::public_asset_url),
        user_role: vault.user_role,
        item_count: vault.item_count,
        member_count: vault.member_count,
        created_at: format_timestamp(vault.created_at),
    })
}

pub(crate) async fn create_vault_image_upload(
    pool: &PgPool,
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
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault role"); AppError::internal("Failed to load vault role") })?;
        let Some(role) = role else {
            return Err(AppError::forbidden("Access denied"));
        };
        if role.role != "owner" && role.role != "admin" {
            return Err(AppError::forbidden("Access denied"));
        }
    }

    let key = storage::create_vault_image_key(user_id, input.vault_id.as_deref(), &input.file_name);
    storage::create_presigned_upload(&key, &input.content_type, None, None)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Internal error");
            AppError::internal("An internal error occurred")
        })
}

pub(crate) async fn create_vault_attachment_upload(
    pool: &PgPool,
    user_id: &str,
    input: CreateAttachmentUploadInput,
) -> Result<storage::PresignedUploadResult, AppError> {
    if input.file_name.trim().is_empty()
        || input.content_type.trim().is_empty()
        || input.file_size <= 0
    {
        return Err(AppError::bad_request("Invalid attachment upload request"));
    }
    let actor = load_attachment_actor(pool, user_id).await?;
    let scoped_item = load_item_row(pool, &input.item_id).await?;
    let access = load_vault_access(pool, &scoped_item.vault_id, user_id).await?;
    assert_item_write_access(&access.role, "Access denied")?;
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
    query(
		"INSERT INTO pending_attachment_upload (id, team_id, vault_id, item_id, storage_key, file_size, storage_size, content_type, created_by, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
	)
	.bind(generate_resource_id("attachment_pending"))
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

    storage::create_presigned_upload(
        &key,
        &input.content_type,
        Some(i64::from(storage_size)),
        None,
    )
    .await
    .map_err(|error| {
        tracing::error!(error = %error, "Internal error");
        AppError::internal("An internal error occurred")
    })
}

pub(crate) async fn create_vault_attachment(
    pool: &PgPool,
    user_id: &str,
    request_client_id: Option<&str>,
    input: CreateAttachmentInput,
) -> Result<CreateAttachmentResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id).await?;
    let scoped_item = load_item_row(pool, &input.item_id).await?;
    let access = load_vault_access(pool, &scoped_item.vault_id, user_id).await?;
    assert_item_write_access(&access.role, "Access denied")?;
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
    let Some(uploaded_object) =
        storage::head_object(&input.storage_key)
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
    let attachment_id = generate_resource_id("attachment");
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start attachment create transaction");
        AppError::internal("Failed to start attachment create transaction")
    })?;
    query(
		"INSERT INTO item_attachment (id, item_id, vault_id, storage_key, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, storage_size, uploaded_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
	)
	.bind(&attachment_id)
	.bind(&input.item_id)
	.bind(&scoped_item.vault_id)
	.bind(&input.storage_key)
	.bind(&input.encrypted_name)
	.bind(&input.encrypted_content_type)
	.bind(&input.encryption_iv)
	.bind(&input.encrypted_content_type_iv)
	.bind(input.encryption_algorithm.as_deref().unwrap_or("AES-GCM-AAD-V1"))
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
        &mut transaction,
        "item_updated",
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

    Ok(CreateAttachmentResponse { attachment_id })
}

pub(crate) async fn list_vault_attachments(
    pool: &PgPool,
    user_id: &str,
    input: ItemIdInput,
) -> Result<Vec<VaultAttachmentResponse>, AppError> {
    let _actor = load_attachment_actor(pool, user_id).await?;
    let scoped_item = load_item_row(pool, &input.item_id).await?;
    let _access = load_vault_access(pool, &scoped_item.vault_id, user_id).await?;
    let attachment_rows = query_as::<_, DbBootstrapAttachmentRow>(
		"SELECT id, item_id, vault_id, storage_key, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, uploaded_by, created_at FROM item_attachment WHERE item_id = $1 ORDER BY created_at ASC",
	)
	.bind(&input.item_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load item attachments"); AppError::internal("Failed to load item attachments") })?;
    Ok(attachment_rows.into_iter().map(map_attachment).collect())
}

pub(crate) async fn get_attachment_download_url(
    pool: &PgPool,
    user_id: &str,
    input: AttachmentIdInput,
) -> Result<AttachmentDownloadResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id).await?;
    let attachment = load_attachment_access(pool, &input.attachment_id, user_id).await?;
    let download_url = storage::create_presigned_download(&attachment.storage_key, Some(300))
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
        encrypted_content_type_iv: attachment
            .encrypted_content_type_iv
            .unwrap_or_else(|| attachment.encryption_iv.clone()),
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
    assert_item_write_access(&attachment.role, "Access denied")?;
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start attachment update transaction");
        AppError::internal("Failed to start attachment update transaction")
    })?;
    query(
		"UPDATE item_attachment SET encrypted_name = $1, encryption_iv = $2, encryption_algorithm = $3 WHERE id = $4",
	)
	.bind(&input.encrypted_name)
	.bind(&input.encryption_iv)
	.bind(input.encryption_algorithm.as_deref().unwrap_or("AES-GCM-AAD-V1"))
	.bind(&input.attachment_id)
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to update attachment"); AppError::internal("Failed to update attachment") })?;
    insert_item_sync_event(
        &mut transaction,
        "item_updated",
        &input.attachment_id,
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
    user_id: &str,
    request_client_id: Option<&str>,
    input: AttachmentIdInput,
) -> Result<SuccessResponse, AppError> {
    let _actor = load_attachment_actor(pool, user_id).await?;
    let attachment = load_attachment_access(pool, &input.attachment_id, user_id).await?;
    if attachment.role == "member" {
        if attachment.uploaded_by.as_deref() != Some(user_id.to_string().as_str()) {
            return Err(AppError::forbidden(
                "You can only delete your own attachments",
            ));
        }
    } else if attachment.role != "owner" && attachment.role != "admin" {
        return Err(AppError::forbidden("Access denied"));
    }
    storage::delete_object(&attachment.storage_key)
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
        &mut transaction,
        "item_updated",
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

pub(crate) async fn create_vault(
    pool: &PgPool,
    user_id: &str,
    request_client_id: Option<&str>,
    input: CreateVaultInput,
) -> Result<CreateVaultResponse, AppError> {
    if input.name.trim().is_empty() || input.encrypted_vault_key.trim().is_empty() {
        return Err(AppError::bad_request("Invalid params"));
    }
    if input.vault_type != "personal" && input.vault_type != "team" {
        return Err(AppError::bad_request("Invalid params"));
    }

    let vault_id = input
        .vault_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("vault"));
    let mut team_id: Option<String> = None;
    let mut shared_vault_limit: Option<i64> = None;
    if input.vault_type == "team" {
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
        let Some(plan) = actor.billing_plan.as_deref() else {
            return Err(AppError::bad_request(
                "You must belong to a team to create a team vault",
            ));
        };
        let Some(status) = actor.billing_status.as_deref() else {
            return Err(AppError::bad_request(
                "You must belong to a team to create a team vault",
            ));
        };

        let entitlement = resolve_vault_sharing_entitlement(plan, status);
        if !entitlement.allowed {
            return Err(AppError::forbidden(
                "Shared vaults are only available on Family or Team plans with active billing.",
            ));
        }
        team_id = Some(actor_team_id);
        shared_vault_limit = entitlement.shared_vault_limit;
    }

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start vault transaction");
        AppError::internal("Failed to start vault transaction")
    })?;
    if input.vault_type == "team" {
        if let (Some(team_id), Some(limit)) = (team_id.as_deref(), shared_vault_limit) {
            query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(format!("shared-vaults:{team_id}"))
                .execute(&mut *transaction)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to acquire shared vault limit lock");
                    AppError::internal("Failed to acquire shared vault limit lock")
                })?;
            let existing_count: i64 = query_scalar(
                "SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1 AND type = 'team'",
            )
            .bind(team_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to count shared vaults");
                AppError::internal("Failed to count shared vaults")
            })?;
            if existing_count >= limit {
                return Err(AppError::forbidden(format!(
                    "Your current plan allows up to {limit} shared vaults. Upgrade to add more.",
                )));
            }
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
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit vault transaction");
        AppError::internal("Failed to commit vault transaction")
    })?;

    insert_vault_created_audit_log(pool, &vault_id, user_id).await?;

    Ok(CreateVaultResponse { vault_id })
}

pub(crate) async fn update_vault(
    pool: &PgPool,
    user_id: &str,
    request_client_id: Option<&str>,
    input: UpdateVaultInput,
) -> Result<UpdateVaultResponse, AppError> {
    if let Some(name) = input.name.as_deref() {
        if name.trim().is_empty() {
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault"); AppError::internal("Failed to load vault") })?
	else {
		return Err(AppError::forbidden("Access denied"));
	};
    if current_vault.role != "owner" && current_vault.role != "admin" {
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

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start vault transaction");
        AppError::internal("Failed to start vault transaction")
    })?;
    query("UPDATE vault SET name = $1, icon = $2, image_key = $3, updated_at = $4 WHERE id = $5")
        .bind(&updated_name)
        .bind(updated_icon.as_deref())
        .bind(updated_image_key.as_deref())
        .bind(OffsetDateTime::now_utc())
        .bind(&input.vault_id)
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to update vault");
            AppError::internal("Failed to update vault")
        })?;
    insert_vault_updated_sync_event(
        &mut transaction,
        &input.vault_id,
        user_id,
        input.client_id.as_deref().or(request_client_id),
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit vault update");
        AppError::internal("Failed to commit vault update")
    })?;

    insert_vault_updated_audit_log(pool, &input.vault_id, user_id).await?;
    if let Some(old_image_key) = old_image_key {
        if Some(old_image_key.as_str()) != updated_image_key.as_deref() {
            let _ = storage::delete_object(&old_image_key).await;
        }
    }

    Ok(UpdateVaultResponse {
        id: input.vault_id,
        name: updated_name,
        icon: updated_icon,
        image_url: updated_image_key
            .as_deref()
            .and_then(storage::public_asset_url),
    })
}

pub(crate) async fn convert_vault_type(
    pool: &PgPool,
    user_id: &str,
    request_client_id: Option<&str>,
    input: ConvertVaultTypeInput,
) -> Result<ConvertVaultTypeResponse, AppError> {
    if input.target_type != "personal" && input.target_type != "team" {
        return Err(AppError::bad_request("Invalid params"));
    }
    let Some(owner_vault) = query_as::<_, DbVaultOwnerAccessRow>(
		"SELECT vk.user_id, v.id AS vault_id, v.type::text AS vault_type, v.team_id, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.vault_id = $1 AND vk.user_id = $2 LIMIT 1",
	)
	.bind(&input.vault_id)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault ownership"); AppError::internal("Failed to load vault ownership") })?
	else {
		return Err(AppError::forbidden("Only the vault owner can convert vault type"));
	};
    if owner_vault.role != "owner" {
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
    if previous_type == "personal" && input.target_type == "team" {
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
        let Some(plan) = actor.billing_plan.as_deref() else {
            return Err(AppError::bad_request(
                "You must belong to a team to convert to a shared vault",
            ));
        };
        let Some(status) = actor.billing_status.as_deref() else {
            return Err(AppError::bad_request(
                "You must belong to a team to convert to a shared vault",
            ));
        };
        let entitlement = resolve_vault_sharing_entitlement(plan, status);
        if !entitlement.allowed {
            return Err(AppError::forbidden(
                "Shared vaults are only available on Family or Team plans with active billing.",
            ));
        }
        target_team_id = Some(team_id);
        shared_vault_limit = entitlement.shared_vault_limit;
    }

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start vault conversion transaction");
        AppError::internal("Failed to start vault conversion transaction")
    })?;
    if previous_type == "personal" && input.target_type == "team" {
        if let (Some(team_id), Some(limit)) = (target_team_id.as_deref(), shared_vault_limit) {
            query("SELECT pg_advisory_xact_lock(hashtext($1))")
                .bind(format!("shared-vaults:{team_id}"))
                .execute(&mut *transaction)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to acquire shared vault limit lock");
                    AppError::internal("Failed to acquire shared vault limit lock")
                })?;
            let existing_count: i64 = query_scalar(
                "SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1 AND type = 'team'",
            )
            .bind(team_id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to count shared vaults");
                AppError::internal("Failed to count shared vaults")
            })?;
            if existing_count >= limit {
                return Err(AppError::forbidden(format!(
                    "Your current plan allows up to {limit} shared vaults. Upgrade to add more.",
                )));
            }
        }
        query("UPDATE vault SET type = 'team'::vault_type, team_id = $1, updated_at = $2 WHERE id = $3")
			.bind(target_team_id.as_deref())
			.bind(OffsetDateTime::now_utc())
			.bind(&input.vault_id)
			.execute(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to convert vault to team"); AppError::internal("Failed to convert vault to team") })?;
    } else if previous_type == "team" && input.target_type == "personal" {
        let member_rows = query_as::<_, DbVaultRoleRow>(
			"SELECT vault_id, role::text AS role FROM vault_key WHERE vault_id = $1 ORDER BY created_at ASC",
		)
		.bind(&input.vault_id)
		.fetch_all(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault members"); AppError::internal("Failed to load vault members") })?;
        let member_count: i64 =
            query_scalar("SELECT COUNT(*)::bigint FROM vault_key WHERE vault_id = $1")
                .bind(&input.vault_id)
                .fetch_one(&mut *transaction)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to count vault members");
                    AppError::internal("Failed to count vault members")
                })?;
        if member_count != 1 || member_rows.first().map(|row| row.role.as_str()) != Some("owner") {
            return Err(AppError::bad_request(
                "Team vault can only be converted to personal when the owner is the only member",
            ));
        }
        query("UPDATE vault SET type = 'personal'::vault_type, team_id = NULL, updated_at = $1 WHERE id = $2")
			.bind(OffsetDateTime::now_utc())
			.bind(&input.vault_id)
			.execute(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to convert vault to personal"); AppError::internal("Failed to convert vault to personal") })?;
        if let Some(personal_key) = input.personal_encrypted_vault_key.as_deref() {
            query("UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3")
				.bind(personal_key)
				.bind(&input.vault_id)
				.bind(user_id)
				.execute(&mut *transaction)
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to update personal vault key"); AppError::internal("Failed to update personal vault key") })?;
        }
    }
    insert_vault_updated_sync_event(
        &mut transaction,
        &input.vault_id,
        user_id,
        input.client_id.as_deref().or(request_client_id),
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit vault conversion");
        AppError::internal("Failed to commit vault conversion")
    })?;

    insert_vault_updated_audit_log(pool, &input.vault_id, user_id).await?;

    Ok(ConvertVaultTypeResponse {
        success: true,
        vault_id: input.vault_id,
        previous_type,
        new_type: input.target_type,
    })
}

pub(crate) async fn delete_vault(
    pool: &PgPool,
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault"); AppError::internal("Failed to load vault") })?
	else {
		return Err(AppError::forbidden("Only the vault owner can delete the vault"));
	};
    if vault.role != "owner" {
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
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load vault members");
        AppError::internal("Failed to load vault members")
    })?;

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start vault delete transaction");
        AppError::internal("Failed to start vault delete transaction")
    })?;
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
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to delete vault attachments");
            AppError::internal("Failed to delete vault attachments")
        })?;
    query("DELETE FROM item WHERE vault_id = $1")
        .bind(&input.vault_id)
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to delete vault items");
            AppError::internal("Failed to delete vault items")
        })?;
    query("DELETE FROM vault_key WHERE vault_id = $1")
        .bind(&input.vault_id)
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to delete vault memberships");
            AppError::internal("Failed to delete vault memberships")
        })?;
    query("DELETE FROM vault WHERE id = $1")
        .bind(&input.vault_id)
        .execute(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to delete vault");
            AppError::internal("Failed to delete vault")
        })?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit vault deletion");
        AppError::internal("Failed to commit vault deletion")
    })?;

    insert_vault_deleted_audit_log(pool, &input.vault_id, user_id).await?;
    if let Some(image_key) = vault.image_key {
        let _ = storage::delete_object(&image_key).await;
    }

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn list_vault_items(
    pool: &PgPool,
    user_id: &str,
    input: VaultIdInput,
) -> Result<Vec<VaultItemDetailsResponse>, AppError> {
    let vault_access = query_as::<_, DbItemVaultAccessRow>(
        "SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(&input.vault_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to verify vault access");
        AppError::internal("Failed to verify vault access")
    })?;
    if vault_access.is_none() {
        return Err(AppError::forbidden("Access denied to this vault"));
    }
    let item_rows = query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC",
	)
	.bind(&input.vault_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault items"); AppError::internal("Failed to load vault items") })?;
    let attachments_enabled = attachments_enabled_for_user(pool, user_id).await?;
    let attachments_by_item = if attachments_enabled {
        load_item_attachments(pool, &item_rows).await?
    } else {
        HashMap::new()
    };

    Ok(item_rows
        .into_iter()
        .map(|item| VaultItemDetailsResponse {
            attachments: attachments_by_item
                .get(&item.id)
                .cloned()
                .unwrap_or_default(),
            ..map_item_details(item)
        })
        .collect())
}

pub(crate) async fn list_all_vault_items(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<VaultItemWithVaultResponse>, AppError> {
    let user_vaults = load_user_vault_summaries(pool, user_id).await?;
    if user_vaults.is_empty() {
        return Ok(Vec::new());
    }
    let vault_ids: Vec<String> = user_vaults
        .iter()
        .map(|vault| vault.vault_id.clone())
        .collect();
    let item_rows = query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = ANY($1) AND deleted_at IS NULL ORDER BY updated_at DESC",
	)
	.bind(&vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load items"); AppError::internal("Failed to load items") })?;
    let attachments_enabled = attachments_enabled_for_user(pool, user_id).await?;
    let attachments_by_item = if attachments_enabled {
        load_item_attachments(pool, &item_rows).await?
    } else {
        HashMap::new()
    };
    let vault_map = build_vault_summary_map(user_vaults);

    Ok(item_rows
        .into_iter()
        .map(|item| VaultItemWithVaultResponse {
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
        .collect())
}

pub(crate) async fn list_all_deleted_vault_items(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<DeletedVaultItemWithVaultResponse>, AppError> {
    let user_vaults = load_user_vault_summaries(pool, user_id).await?;
    if user_vaults.is_empty() {
        return Ok(Vec::new());
    }
    let vault_ids: Vec<String> = user_vaults
        .iter()
        .map(|vault| vault.vault_id.clone())
        .collect();
    let item_rows = query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = ANY($1) AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
	)
	.bind(&vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load deleted items"); AppError::internal("Failed to load deleted items") })?;
    let vault_map = build_vault_summary_map(user_vaults);

    Ok(item_rows
        .into_iter()
        .map(|item| DeletedVaultItemWithVaultResponse {
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
            vault: vault_map.get(&item.vault_id).cloned(),
        })
        .collect())
}

pub(crate) async fn get_vault_item(
    pool: &PgPool,
    user_id: &str,
    input: ItemIdInput,
) -> Result<VaultItemDetailsResponse, AppError> {
    let item_row = query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE id = $1 LIMIT 1",
	)
	.bind(&input.item_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load item"); AppError::internal("Failed to load item") })?
	.ok_or_else(|| AppError::not_found("Item not found"))?;
    let vault_access = query_as::<_, DbItemVaultAccessRow>(
        "SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(&item_row.vault_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to verify item access");
        AppError::internal("Failed to verify item access")
    })?;
    if vault_access.is_none() {
        return Err(AppError::forbidden("Access denied"));
    }
    let attachments_enabled = attachments_enabled_for_user(pool, user_id).await?;
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

pub(crate) async fn create_vault_item(
    pool: &PgPool,
    user_id: &str,
    input: CreateItemInput,
) -> Result<CreateItemResponse, AppError> {
    let access = load_vault_access(pool, &input.vault_id, user_id).await?;
    assert_item_write_access(&access.role, "Read-only access cannot create items")?;
    let item_id = input
        .item_id
        .clone()
        .unwrap_or_else(|| generate_resource_id("item"));
    let version = 1;
    let encryption_algorithm = input
        .encryption_algorithm
        .as_deref()
        .unwrap_or("AES-GCM-AAD-V1");

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start item transaction");
        AppError::internal("Failed to start item transaction")
    })?;
    query(
		"INSERT INTO item (id, vault_id, category, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by) VALUES ($1, $2, $3::item_category, $4, $5, $6, $7, $8)",
	)
	.bind(&item_id)
	.bind(&input.vault_id)
	.bind(&input.category)
	.bind(&input.encrypted_data)
	.bind(&input.encryption_iv)
	.bind(encryption_algorithm)
	.bind(version)
	.bind(user_id)
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create item"); AppError::internal("Failed to create item") })?;
    insert_item_sync_event(
        &mut transaction,
        "item_created",
        &item_id,
        &input.vault_id,
        user_id,
        input.client_id.as_deref(),
        version,
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit item creation");
        AppError::internal("Failed to commit item creation")
    })?;
    insert_item_audit_log(
        pool,
        "item_created",
        &item_id,
        user_id,
        Some(json!({ "vaultId": input.vault_id, "category": input.category })),
    )
    .await?;

    Ok(CreateItemResponse {
        item_id: item_id.clone(),
        id: item_id,
    })
}

pub(crate) async fn bulk_import_vault_items(
    pool: &PgPool,
    user_id: &str,
    input: BulkImportItemsInput,
) -> Result<BulkImportItemsResponse, AppError> {
    let access = load_vault_access(pool, &input.vault_id, user_id).await?;
    assert_item_write_access(&access.role, "Read-only access cannot create items")?;
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

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start bulk import transaction");
        AppError::internal("Failed to start bulk import transaction")
    })?;
    for item in &input.items {
        query(
			"INSERT INTO item (id, vault_id, category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by) VALUES ($1, $2, $3::item_category, $4, $5, $6, $7, 1, $8)",
		)
		.bind(&item.item_id)
		.bind(&input.vault_id)
		.bind(&item.category)
		.bind(item.favorite.unwrap_or(false))
		.bind(&item.encrypted_data)
		.bind(&item.encryption_iv)
		.bind(item.encryption_algorithm.as_deref().unwrap_or("AES-GCM-AAD-V1"))
		.bind(user_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to import vault items"); AppError::internal("Failed to import vault items") })?;
    }
    insert_vault_updated_sync_event_with_metadata(
        &mut transaction,
        &input.vault_id,
        user_id,
        input.client_id.as_deref(),
        json!({ "reason": "bulk_import", "importedCount": item_ids.len() }),
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit bulk import");
        AppError::internal("Failed to commit bulk import")
    })?;
    insert_vault_audit_log_with_metadata(
        pool,
        "vault_updated",
        &input.vault_id,
        user_id,
        json!({ "reason": "bulk_import", "importedCount": item_ids.len() }),
    )
    .await?;

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
    assert_item_write_access(&access.role, "Access denied")?;
    let expected_version = input.expected_version.unwrap_or(existing_item.version);

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start item update transaction");
        AppError::internal("Failed to start item update transaction")
    })?;
    let new_version = query_scalar::<_, i32>(
		"UPDATE item SET encrypted_data = COALESCE($1, encrypted_data), encryption_iv = COALESCE($2, encryption_iv), encryption_algorithm = COALESCE($3, encryption_algorithm), version = version + 1, last_modified_by = $4, updated_at = $5 WHERE id = $6 AND version = $7 RETURNING version",
	)
	.bind(input.encrypted_data.as_deref())
	.bind(input.encryption_iv.as_deref())
	.bind(input.encryption_algorithm.as_deref())
	.bind(user_id)
	.bind(OffsetDateTime::now_utc())
	.bind(&input.item_id)
	.bind(expected_version)
	.fetch_optional(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to update item"); AppError::internal("Failed to update item") })?
    .ok_or_else(item_version_conflict)?;
    insert_item_sync_event(
        &mut transaction,
        "item_updated",
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit item update");
        AppError::internal("Failed to commit item update")
    })?;

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
    assert_item_write_access(&access.role, "Access denied")?;

    let expected_version = input.expected_version.unwrap_or(existing_item.version);
    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start favorite update transaction");
        AppError::internal("Failed to start favorite update transaction")
    })?;
    let new_version = query_scalar::<_, i32>(
        "UPDATE item SET favorite = $1, version = version + 1, updated_at = $2 WHERE id = $3 AND version = $4 RETURNING version",
    )
        .bind(input.favorite)
        .bind(OffsetDateTime::now_utc())
        .bind(&input.item_id)
        .bind(expected_version)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to update favorite state");
            AppError::internal("Failed to update favorite state")
        })?
        .ok_or_else(item_version_conflict)?;
    insert_item_sync_event(
        &mut transaction,
        "item_updated",
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        None,
        new_version,
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit favorite update");
        AppError::internal("Failed to commit favorite update")
    })?;

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn delete_vault_item(
    pool: &PgPool,
    user_id: &str,
    input: ItemClientInput,
) -> Result<SuccessResponse, AppError> {
    let existing_item = load_item_row(pool, &input.item_id).await?;
    let access = load_vault_access(pool, &existing_item.vault_id, user_id).await?;
    assert_item_write_access(&access.role, "Access denied")?;
    let expected_version = input.expected_version.unwrap_or(existing_item.version);

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start item delete transaction");
        AppError::internal("Failed to start item delete transaction")
    })?;
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
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to delete item");
            AppError::internal("Failed to delete item")
        })?
        .ok_or_else(item_version_conflict)?;
    insert_item_sync_event(
        &mut transaction,
        "item_deleted",
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit item delete");
        AppError::internal("Failed to commit item delete")
    })?;
    insert_item_audit_log(
        pool,
        "item_deleted",
        &input.item_id,
        user_id,
        Some(json!({ "vaultId": existing_item.vault_id, "version": new_version })),
    )
    .await?;

    Ok(SuccessResponse { success: true })
}

pub(crate) async fn list_deleted_vault_items(
    pool: &PgPool,
    user_id: &str,
    input: VaultIdInput,
) -> Result<Vec<VaultItemResponse>, AppError> {
    let access = load_vault_access(pool, &input.vault_id, user_id).await?;
    let _ = access;
    let item_rows = query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC NULLS LAST",
	)
	.bind(&input.vault_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load deleted items"); AppError::internal("Failed to load deleted items") })?;

    Ok(item_rows.into_iter().map(map_item).collect())
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
    assert_item_write_access(&access.role, "Access denied")?;
    let expected_version = input.expected_version.unwrap_or(existing_item.version);

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start item restore transaction");
        AppError::internal("Failed to start item restore transaction")
    })?;
    let new_version = query_scalar::<_, i32>(
        "UPDATE item SET deleted_at = NULL, version = version + 1, last_modified_by = $1, updated_at = $2 WHERE id = $3 AND version = $4 RETURNING version",
    )
    .bind(user_id)
    .bind(OffsetDateTime::now_utc())
    .bind(&input.item_id)
    .bind(expected_version)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to restore item");
        AppError::internal("Failed to restore item")
    })?
    .ok_or_else(item_version_conflict)?;
    insert_item_sync_event(
        &mut transaction,
        "item_restored",
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit item restore");
        AppError::internal("Failed to commit item restore")
    })?;
    insert_item_audit_log(
        pool,
        "item_restored",
        &input.item_id,
        user_id,
        Some(json!({ "vaultId": existing_item.vault_id, "version": new_version })),
    )
    .await?;

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
        &source_access.role,
        "Cannot move items from a read-only vault",
    )?;
    let target_access = load_vault_access(pool, &input.target_vault_id, user_id).await?;
    assert_item_write_access(
        &target_access.role,
        "Cannot move items to a read-only vault",
    )?;
    let expected_version = input.expected_version.unwrap_or(existing_item.version);

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start item move transaction");
        AppError::internal("Failed to start item move transaction")
    })?;
    let new_version = query_scalar::<_, i32>(
		"UPDATE item SET vault_id = $1, encrypted_data = $2, encryption_iv = $3, encryption_algorithm = COALESCE($4, encryption_algorithm), version = version + 1, last_modified_by = $5, updated_at = $6 WHERE id = $7 AND version = $8 RETURNING version",
	)
	.bind(&input.target_vault_id)
	.bind(&input.encrypted_data)
	.bind(&input.encryption_iv)
	.bind(input.encryption_algorithm.as_deref())
	.bind(user_id)
	.bind(OffsetDateTime::now_utc())
	.bind(&input.item_id)
	.bind(expected_version)
	.fetch_optional(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to move item"); AppError::internal("Failed to move item") })?
    .ok_or_else(item_version_conflict)?;
    insert_item_sync_event_with_metadata(
        &mut transaction,
        "item_moved",
        &input.item_id,
        &input.target_vault_id,
        user_id,
        input.client_id.as_deref(),
        new_version,
        json!({ "sourceVaultId": input.source_vault_id }),
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit item move");
        AppError::internal("Failed to commit item move")
    })?;
    insert_item_audit_log(
        pool,
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
    assert_item_write_access(&access.role, "Access denied")?;
    let expected_version = input.expected_version.unwrap_or(existing_item.version);

    let mut transaction = pool.begin().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to start permanent delete transaction");
        AppError::internal("Failed to start permanent delete transaction")
    })?;
    let deleted_version = query_scalar::<_, i32>(
        "DELETE FROM item WHERE id = $1 AND version = $2 RETURNING version + 1",
    )
    .bind(&input.item_id)
    .bind(expected_version)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to permanently delete item");
        AppError::internal("Failed to permanently delete item")
    })?
    .ok_or_else(item_version_conflict)?;
    insert_item_sync_event(
        &mut transaction,
        "item_permanently_deleted",
        &input.item_id,
        &existing_item.vault_id,
        user_id,
        input.client_id.as_deref(),
        deleted_version,
    )
    .await?;
    transaction.commit().await.map_err(|e| {
        tracing::error!(error = %e, "Failed to commit permanent delete");
        AppError::internal("Failed to commit permanent delete")
    })?;
    insert_item_audit_log(
        pool,
        "item_permanently_deleted",
        &input.item_id,
        user_id,
        Some(json!({ "vaultId": existing_item.vault_id, "version": deleted_version })),
    )
    .await?;

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
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user team info"); AppError::internal("Failed to load user team info") })?
	.unwrap_or(0) as i32;
    let vault_count =
        query_scalar::<_, i64>("SELECT COUNT(*)::bigint FROM vault_key WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to count user vaults");
                AppError::internal("Failed to count user vaults")
            })?;
    let item_count = query_scalar::<_, i64>(
		"SELECT COUNT(*)::bigint FROM item i INNER JOIN vault_key vk ON vk.vault_id = i.vault_id WHERE vk.user_id = $1 AND i.deleted_at IS NULL",
	)
	.bind(user_id)
	.fetch_one(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to count vault items"); AppError::internal("Failed to count vault items") })?;

    Ok(VaultStatsResponse {
        team_count,
        vault_count,
        item_count,
    })
}

pub(crate) mod member_handlers {
    use super::*;

    pub(crate) async fn list_vault_members(
        pool: &PgPool,
        user_id: &str,
        input: VaultIdInput,
    ) -> Result<Vec<VaultMemberResponse>, AppError> {
        let _access = load_vault_access(pool, &input.vault_id, user_id).await?;
        let members = query_as::<_, DbTeamMemberRow>(
			"SELECT vk.user_id, u.name, u.email, vk.role::text AS role, vk.created_at AS joined_at FROM vault_key vk INNER JOIN \"user\" u ON vk.user_id = u.id WHERE vk.vault_id = $1 ORDER BY vk.created_at ASC",
		)
		.bind(&input.vault_id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault members"); AppError::internal("Failed to load vault members") })?;
        Ok(members
            .into_iter()
            .map(|member| VaultMemberResponse {
                user_id: member.user_id,
                name: member.name,
                email: member.email,
                role: member.role,
            })
            .collect())
    }

    pub(crate) async fn available_team_members(
        pool: &PgPool,
        user_id: &str,
        input: VaultIdInput,
    ) -> Result<Vec<VaultAvailableMemberResponse>, AppError> {
        let actor = load_managed_team_vault_actor(pool, &input.vault_id, user_id).await?;
        let team_members = query_as::<_, DbVaultAvailableMemberRow>(
			"SELECT id AS user_id, name, email, public_key FROM \"user\" WHERE team_id = $1 ORDER BY created_at ASC",
		)
		.bind(actor.team_id.as_deref())
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load team members"); AppError::internal("Failed to load team members") })?;
        let existing_member_ids =
            query_scalar::<_, String>("SELECT user_id FROM vault_key WHERE vault_id = $1")
                .bind(&input.vault_id)
                .fetch_all(pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to load vault members");
                    AppError::internal("Failed to load vault members")
                })?;
        let existing_member_ids: std::collections::HashSet<String> =
            existing_member_ids.into_iter().collect();
        Ok(team_members
            .into_iter()
            .filter(|member| !existing_member_ids.contains(&member.user_id))
            .map(|member| VaultAvailableMemberResponse {
                user_id: member.user_id,
                name: member.name,
                email: member.email,
                public_key: member.public_key,
            })
            .collect())
    }

    pub(crate) async fn update_vault_member_role(
        pool: &PgPool,
        user_id: &str,
        input: UpdateVaultMemberRoleInput,
    ) -> Result<SuccessResponse, AppError> {
        let role = validate_vault_member_role(&input.role)?;
        let actor = load_managed_team_vault_actor(pool, &input.vault_id, user_id).await?;
        if input.user_id == user_id {
            return Err(AppError::bad_request("Cannot change your own role"));
        }
        let target_access = load_vault_access(pool, &input.vault_id, &input.user_id)
            .await
            .map_err(|error| {
                if error.code == AppErrorCode::Forbidden {
                    AppError::not_found("Member not found")
                } else {
                    error
                }
            })?;
        if target_access.role == "owner" {
            return Err(AppError::forbidden("Cannot change vault owner's role"));
        }
        if actor.role == "admin" && target_access.role == "admin" {
            return Err(AppError::forbidden("Admins cannot change other admins"));
        }
        query("UPDATE vault_key SET role = $1::vault_role WHERE vault_id = $2 AND user_id = $3")
            .bind(role)
            .bind(&input.vault_id)
            .bind(&input.user_id)
            .execute(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to update vault member role");
                AppError::internal("Failed to update vault member role")
            })?;
        Ok(SuccessResponse { success: true })
    }

    pub(crate) async fn lookup_vault_user(
        pool: &PgPool,
        user_id: &str,
        input: LookupVaultUserInput,
    ) -> Result<VaultLookupUserResponse, AppError> {
        let actor = load_managed_team_vault_actor(pool, &input.vault_id, user_id).await?;
        let normalized_email = input.email.trim().to_ascii_lowercase();
        let current_user_email =
            query_scalar::<_, String>("SELECT email FROM \"user\" WHERE id = $1 LIMIT 1")
                .bind(user_id)
                .fetch_optional(pool)
                .await
                .map_err(|e| {
                    tracing::error!(error = %e, "Failed to load current user");
                    AppError::internal("Failed to load current user")
                })?;
        if current_user_email
            .as_deref()
            .map(|email| email.eq_ignore_ascii_case(&normalized_email))
            .unwrap_or(false)
        {
            return Err(AppError::bad_request("Cannot add yourself as a member"));
        }
        let found_user = query_as::<_, DbVaultLookupUserRow>(
			"SELECT id, name, email, public_key, team_id FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1",
		)
		.bind(&normalized_email)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to look up user"); AppError::internal("Failed to look up user") })?
		.ok_or_else(|| AppError::not_found("User not found"))?;
        if found_user.team_id.as_deref() != actor.team_id.as_deref() {
            return Err(AppError::not_found("User not found"));
        }
        let existing_member = query_scalar::<_, String>(
            "SELECT user_id FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
        )
        .bind(&input.vault_id)
        .bind(&found_user.id)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load existing vault member");
            AppError::internal("Failed to load existing vault member")
        })?;
        if existing_member.is_some() {
            return Err(AppError::bad_request(
                "User is already a member of this vault",
            ));
        }
        Ok(VaultLookupUserResponse {
            id: found_user.id,
            name: found_user.name,
            email: found_user.email,
            public_key: found_user.public_key,
        })
    }

    pub(crate) async fn add_vault_member(
        pool: &PgPool,
        user_id: &str,
        request_client_id: Option<&str>,
        input: AddVaultMemberInput,
    ) -> Result<SuccessResponse, AppError> {
        let role = validate_vault_member_role(&input.role)?;
        let actor = load_managed_team_vault_actor(pool, &input.vault_id, user_id).await?;
        let target_user = query_as::<_, DbVaultLookupUserRow>(
            "SELECT id, name, email, public_key, team_id FROM \"user\" WHERE id = $1 LIMIT 1",
        )
        .bind(&input.user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load target user");
            AppError::internal("Failed to load target user")
        })?
        .ok_or_else(|| AppError::not_found("User not found"))?;
        if target_user.team_id.as_deref() != actor.team_id.as_deref() {
            return Err(AppError::bad_request(
                "User must belong to the same team as this vault",
            ));
        }
        let existing_member = query_scalar::<_, String>(
            "SELECT user_id FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
        )
        .bind(&input.vault_id)
        .bind(&input.user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load existing vault member");
            AppError::internal("Failed to load existing vault member")
        })?;
        if existing_member.is_some() {
            return Err(AppError::conflict("User is already a member of this vault"));
        }
        let mut transaction = pool.begin().await.map_err(|e| {
            tracing::error!(error = %e, "Failed to start vault member add transaction");
            AppError::internal("Failed to start vault member add transaction")
        })?;
        query(
			"INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role, created_at) VALUES ($1, $2, $3, $4, $5::vault_role, $6)",
		)
		.bind(generate_resource_id("vault_key"))
		.bind(&input.vault_id)
		.bind(&input.user_id)
		.bind(&input.encrypted_vault_key)
		.bind(role)
		.bind(OffsetDateTime::now_utc())
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to add vault member"); AppError::internal("Failed to add vault member") })?;
        insert_vault_member_sync_event(
            &mut transaction,
            "vault_member_added",
            &input.user_id,
            &input.vault_id,
            user_id,
            input.client_id.as_deref().or(request_client_id),
            json!({ "addedUserId": input.user_id, "role": role }),
        )
        .await?;
        transaction.commit().await.map_err(|e| {
            tracing::error!(error = %e, "Failed to commit vault member add");
            AppError::internal("Failed to commit vault member add")
        })?;
        insert_vault_audit_log_with_metadata(
            pool,
            "vault_member_added",
            &input.vault_id,
            user_id,
            json!({ "addedUserId": input.user_id, "role": role }),
        )
        .await?;
        Ok(SuccessResponse { success: true })
    }

    pub(crate) async fn get_vault_rotation_data(
        pool: &PgPool,
        user_id: &str,
        input: GetVaultRotationDataInput,
    ) -> Result<VaultRotationDataResponse, AppError> {
        let _actor = load_managed_team_vault_actor(pool, &input.vault_id, user_id).await?;
        let vault_record = query_as::<_, DbTeamRotationVaultRow>(
            "SELECT id, name, key_version FROM vault WHERE id = $1 LIMIT 1",
        )
        .bind(&input.vault_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load vault");
            AppError::internal("Failed to load vault")
        })?
        .ok_or_else(|| AppError::not_found("Vault not found"))?;
        let members = query_as::<_, DbRotationMemberRow>(
			"SELECT vk.user_id, u.public_key, vk.role::text AS role FROM vault_key vk INNER JOIN \"user\" u ON vk.user_id = u.id WHERE vk.vault_id = $1 AND vk.user_id != $2 ORDER BY vk.created_at ASC",
		)
		.bind(&input.vault_id)
		.bind(&input.exclude_user_id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load rotation members"); AppError::internal("Failed to load rotation members") })?;
        let items = query_as::<_, DbRotationItemRow>(
			"SELECT id, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by FROM item WHERE vault_id = $1 ORDER BY created_at ASC",
		)
		.bind(&input.vault_id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load rotation items"); AppError::internal("Failed to load rotation items") })?;
        Ok(VaultRotationDataResponse {
            key_version: vault_record.key_version,
            members: members
                .into_iter()
                .map(|member| VaultRotationMemberResponse {
                    user_id: member.user_id,
                    public_key: member.public_key,
                    role: member.role,
                })
                .collect(),
            items: items
                .into_iter()
                .map(|item| VaultRotationItemResponse {
                    id: item.id,
                    encrypted_data: item.encrypted_data,
                    encryption_iv: item.encryption_iv,
                    encryption_algorithm: item.encryption_algorithm,
                    version: item.version,
                    last_modified_by: item.last_modified_by,
                })
                .collect(),
        })
    }

    pub(crate) async fn remove_vault_member(
        pool: &PgPool,
        user_id: &str,
        request_client_id: Option<&str>,
        input: RemoveVaultMemberInput,
    ) -> Result<RemoveVaultMemberResponse, AppError> {
        let actor = load_managed_team_vault_actor(pool, &input.vault_id, user_id).await?;
        if input.user_id == user_id {
            return Err(AppError::bad_request("Cannot remove yourself"));
        }
        let target_access = load_vault_access(pool, &input.vault_id, &input.user_id)
            .await
            .map_err(|error| {
                if error.code == AppErrorCode::Forbidden {
                    AppError::not_found("Member not found")
                } else {
                    error
                }
            })?;
        if target_access.role == "owner" {
            return Err(AppError::forbidden("Cannot remove vault owner"));
        }
        if actor.role == "admin" && target_access.role == "admin" {
            return Err(AppError::forbidden("Admins cannot remove other admins"));
        }
        let current_vault = query_as::<_, DbTeamRotationVaultRow>(
            "SELECT id, name, key_version FROM vault WHERE id = $1 LIMIT 1",
        )
        .bind(&input.vault_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "Failed to load vault");
            AppError::internal("Failed to load vault")
        })?
        .ok_or_else(|| AppError::not_found("Vault not found"))?;
        let new_key_version = current_vault.key_version + 1;
        let rotation_id = generate_resource_id("rotation");
        query(
			"INSERT INTO vault_key_rotation (id, vault_id, key_version, reason, initiated_by_id, removed_user_id, items_re_encrypted, members_updated, status, created_at) VALUES ($1, $2, $3, 'member_removed'::key_rotation_reason, $4, $5, $6, $7, 'in_progress', $8)",
		)
		.bind(&rotation_id)
		.bind(&input.vault_id)
		.bind(new_key_version)
		.bind(user_id)
		.bind(&input.user_id)
		.bind(input.key_rotation.re_encrypted_items.len() as i32)
		.bind(input.key_rotation.member_keys.len() as i32)
		.bind(OffsetDateTime::now_utc())
		.execute(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to create vault key rotation"); AppError::internal("Failed to create vault key rotation") })?;

        let removal_result = async {
			let mut transaction = pool
				.begin()
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to start vault member removal transaction"); AppError::internal("Failed to start vault member removal transaction") })?;
			let deleted_rows = query(
				"DELETE FROM vault_key WHERE vault_id = $1 AND user_id = $2",
			)
			.bind(&input.vault_id)
			.bind(&input.user_id)
			.execute(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to remove vault member"); AppError::internal("Failed to remove vault member") })?
			.rows_affected();
			if deleted_rows == 0 {
				return Err(AppError::not_found("Member not found"));
			}
			for member_key in &input.key_rotation.member_keys {
				let updated_rows = query(
					"UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3",
				)
				.bind(&member_key.encrypted_vault_key)
				.bind(&input.vault_id)
				.bind(&member_key.user_id)
				.execute(&mut *transaction)
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to update rotated member key"); AppError::internal("Failed to update rotated member key") })?
				.rows_affected();
				if updated_rows == 0 {
					return Err(AppError::not_found("Member key not found for rotation"));
				}
			}
			for item in &input.key_rotation.re_encrypted_items {
				let updated_rows = query(
					"UPDATE item SET encrypted_data = $1, encryption_iv = $2, updated_at = $3 WHERE id = $4 AND vault_id = $5",
				)
				.bind(&item.encrypted_data)
				.bind(&item.encryption_iv)
				.bind(OffsetDateTime::now_utc())
				.bind(&item.item_id)
				.bind(&input.vault_id)
				.execute(&mut *transaction)
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to update rotated item"); AppError::internal("Failed to update rotated item") })?
				.rows_affected();
				if updated_rows == 0 {
					return Err(AppError::not_found("Item not found in vault during rotation"));
				}
			}
			query("UPDATE vault SET key_version = $1, updated_at = $2 WHERE id = $3")
				.bind(new_key_version)
				.bind(OffsetDateTime::now_utc())
				.bind(&input.vault_id)
				.execute(&mut *transaction)
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to update vault key version"); AppError::internal("Failed to update vault key version") })?;
			query(
				"UPDATE vault_key_rotation SET status = 'completed', completed_at = $1 WHERE id = $2",
			)
			.bind(OffsetDateTime::now_utc())
			.bind(&rotation_id)
			.execute(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to finalize vault key rotation"); AppError::internal("Failed to finalize vault key rotation") })?;
			insert_vault_access_revoked_sync_event_with_metadata(
				&mut transaction,
				&input.vault_id,
				&input.user_id,
				input.client_id.as_deref().or(request_client_id),
				new_key_version,
				json!({ "reason": "member_removed", "removedUserId": input.user_id }),
			)
			.await?;
			insert_vault_member_sync_event(
				&mut transaction,
				"vault_member_removed",
				&input.user_id,
				&input.vault_id,
				user_id,
				input.client_id.as_deref().or(request_client_id),
				json!({ "removedUserId": input.user_id }),
			)
			.await?;
			insert_vault_key_rotated_sync_event(
				&mut transaction,
				&input.vault_id,
				user_id,
				input.client_id.as_deref().or(request_client_id),
				new_key_version,
				json!({ "reason": "member_removed", "keyRotationId": rotation_id }),
			)
			.await?;
			transaction
				.commit()
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to commit vault member removal"); AppError::internal("Failed to commit vault member removal") })?;
			Ok(())
		}
		.await;

        if let Err(error) = removal_result {
            query(
                "UPDATE vault_key_rotation SET status = 'failed', error_message = $1 WHERE id = $2",
            )
            .bind(error.message.clone())
            .bind(&rotation_id)
            .execute(pool)
            .await
            .map_err(|e| {
                tracing::error!(error = %e, "Failed to mark vault key rotation as failed");
                AppError::internal("Failed to mark vault key rotation as failed")
            })?;
            return Err(AppError::internal("Key rotation failed. Please try again."));
        }

        insert_vault_audit_log_with_metadata(
            pool,
            "vault_member_removed",
            &input.vault_id,
            user_id,
            json!({
                "removedUserId": input.user_id,
                "keyRotationId": rotation_id,
                "newKeyVersion": new_key_version,
                "itemsReEncrypted": input.key_rotation.re_encrypted_items.len(),
                "membersUpdated": input.key_rotation.member_keys.len(),
            }),
        )
        .await?;

        Ok(RemoveVaultMemberResponse {
            success: true,
            key_rotation: VaultKeyRotationSummaryResponse {
                id: rotation_id,
                new_key_version,
                items_re_encrypted: input.key_rotation.re_encrypted_items.len(),
                members_updated: input.key_rotation.member_keys.len(),
            },
        })
    }

    struct ManagedVaultActor {
        role: String,
        team_id: Option<String>,
    }

    async fn load_managed_team_vault_actor(
        pool: &PgPool,
        vault_id: &str,
        user_id: &str,
    ) -> Result<ManagedVaultActor, AppError> {
        let actor = query_as::<_, DbVaultOwnerAccessRow>(
			"SELECT vk.vault_id, v.type::text AS vault_type, v.team_id, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON v.id = vk.vault_id WHERE vk.vault_id = $1 AND vk.user_id = $2 LIMIT 1",
		)
		.bind(vault_id)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault access"); AppError::internal("Failed to load vault access") })?
		.ok_or_else(|| AppError::forbidden("Access denied to this vault"))?;
        let billing =
            load_team_billing_entitlement(pool, user_id, "Failed to load billing entitlements")
                .await?;
        assert_vault_sharing_available(billing.as_ref())?;
        if actor.role != "owner" && actor.role != "admin" {
            return Err(AppError::forbidden(
                "Only vault owner or admin can manage members",
            ));
        }
        if actor.vault_type != "team" || actor.team_id.is_none() {
            return Err(AppError::bad_request(
                "Only team vaults support adding members",
            ));
        }
        Ok(ManagedVaultActor {
            role: actor.role,
            team_id: actor.team_id,
        })
    }

    fn assert_vault_sharing_available(
        billing: Option<&DbTeamBillingEntitlementRow>,
    ) -> Result<(), AppError> {
        if bittery_mode() == "self-hosted" {
            return Ok(());
        }
        let Some(billing) = billing else {
            return Err(AppError::forbidden(
				"Shared vault management is only available on Family or Team plans with active billing.",
			));
        };
        let entitlement = resolve_vault_sharing_entitlement(
            billing.billing_plan.as_deref().unwrap_or("free"),
            billing.billing_status.as_deref().unwrap_or("none"),
        );
        if !entitlement.allowed {
            return Err(AppError::forbidden(
				"Shared vault management is only available on Family or Team plans with active billing.",
			));
        }
        Ok(())
    }

    fn validate_vault_member_role(role: &str) -> Result<&str, AppError> {
        if matches!(role, "admin" | "member" | "read-only") {
            Ok(role)
        } else {
            Err(AppError::bad_request("Invalid member role"))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{
            assert_vault_sharing_available, bittery_mode, resolve_vault_sharing_entitlement,
            validate_vault_member_role,
        };
        use crate::db::models::DbTeamBillingEntitlementRow;
        use crate::error::AppErrorCode;
        use crate::test_support::acquire_env_lock;

        fn set_env_var(key: &str, value: Option<&str>) {
            match value {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
        }

        fn restore_env_var(key: &str, value: Option<String>) {
            match value {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
        }

        fn with_bittery_mode<T>(value: Option<&str>, test_fn: impl FnOnce() -> T) -> T {
            let _guard = acquire_env_lock();
            let previous = std::env::var("BITTERY_MODE").ok();

            set_env_var("BITTERY_MODE", value);
            let result = test_fn();
            restore_env_var("BITTERY_MODE", previous);

            result
        }

        #[test]
        fn validate_vault_member_role_accepts_supported_roles() {
            for role in ["admin", "member", "read-only"] {
                assert_eq!(validate_vault_member_role(role).unwrap(), role);
            }
        }

        #[test]
        fn validate_vault_member_role_rejects_invalid_roles() {
            let error = validate_vault_member_role("owner").unwrap_err();

            assert_eq!(error.code, AppErrorCode::BadRequest);
            assert_eq!(error.message, "Invalid member role");
        }

        #[test]
        fn bittery_mode_normalizes_self_hosted_aliases_and_defaults_to_cloud() {
            with_bittery_mode(None, || {
                assert_eq!(bittery_mode(), "cloud");
            });

            for value in ["self-hosted", "self_hosted", "selfhosted", " SELF_HOSTED "] {
                with_bittery_mode(Some(value), || {
                    assert_eq!(bittery_mode(), "self-hosted");
                });
            }

            with_bittery_mode(Some("cloud"), || {
                assert_eq!(bittery_mode(), "cloud");
            });
        }

        #[test]
        fn resolve_vault_sharing_entitlement_respects_plan_status_and_mode() {
            with_bittery_mode(None, || {
                let family = resolve_vault_sharing_entitlement("family", "active");
                assert!(family.allowed);
                assert_eq!(family.shared_vault_limit, Some(5));

                let team = resolve_vault_sharing_entitlement("team", "trialing");
                assert!(team.allowed);
                assert_eq!(team.shared_vault_limit, None);

                let free = resolve_vault_sharing_entitlement("free", "active");
                assert!(!free.allowed);
                assert_eq!(free.shared_vault_limit, Some(0));
            });

            with_bittery_mode(Some("self-hosted"), || {
                let entitlement = resolve_vault_sharing_entitlement("free", "none");
                assert!(entitlement.allowed);
                assert_eq!(entitlement.shared_vault_limit, None);
            });
        }

        #[test]
        fn assert_vault_sharing_available_requires_cloud_entitlement() {
            with_bittery_mode(None, || {
                assert!(
                    assert_vault_sharing_available(Some(&DbTeamBillingEntitlementRow {
                        team_id: Some("team_123".to_string()),
                        billing_plan: Some("family".to_string()),
                        billing_status: Some("active".to_string()),
                    }))
                    .is_ok()
                );

                let missing = assert_vault_sharing_available(None).unwrap_err();
                assert_eq!(missing.code, AppErrorCode::Forbidden);
                assert_eq!(
					missing.message,
					"Shared vault management is only available on Family or Team plans with active billing."
				);

                let free_plan =
                    assert_vault_sharing_available(Some(&DbTeamBillingEntitlementRow {
                        team_id: Some("team_123".to_string()),
                        billing_plan: Some("free".to_string()),
                        billing_status: Some("active".to_string()),
                    }))
                    .unwrap_err();
                assert_eq!(free_plan.code, AppErrorCode::Forbidden);
            });

            with_bittery_mode(Some("self-hosted"), || {
                assert!(assert_vault_sharing_available(None).is_ok());
            });
        }
    }
}

fn assert_item_write_access(role: &str, message: &str) -> Result<(), AppError> {
    if role == "read-only" {
        Err(AppError::forbidden(message))
    } else {
        Ok(())
    }
}

async fn insert_item_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: &str,
    item_id: &str,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    version: i32,
) -> Result<(), AppError> {
    insert_sync_event(
        &mut **transaction,
        event_type,
        item_id,
        "item",
        vault_id,
        user_id,
        version,
        client_id,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn insert_item_sync_event_with_metadata(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: &str,
    item_id: &str,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    version: i32,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    insert_sync_event(
        &mut **transaction,
        event_type,
        item_id,
        "item",
        vault_id,
        user_id,
        version,
        client_id,
        Some(&metadata.to_string()),
    )
    .await
}

async fn insert_item_audit_log(
    pool: &PgPool,
    action: &str,
    item_id: &str,
    user_id: &str,
    metadata: Option<serde_json::Value>,
) -> Result<(), AppError> {
    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        user_id,
        action,
        "item",
        item_id,
        metadata,
    )
    .await
}

async fn insert_vault_member_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    event_type: &str,
    entity_id: &str,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    insert_sync_event(
        &mut **transaction,
        event_type,
        entity_id,
        "vault_member",
        vault_id,
        user_id,
        1,
        client_id,
        Some(&metadata.to_string()),
    )
    .await
}

async fn insert_vault_access_revoked_sync_event_with_metadata(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    version: i32,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    insert_sync_event(
        &mut **transaction,
        "vault_access_revoked",
        vault_id,
        "vault",
        vault_id,
        user_id,
        version,
        client_id,
        Some(&metadata.to_string()),
    )
    .await
}

async fn insert_vault_key_rotated_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    version: i32,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    insert_sync_event(
        &mut **transaction,
        "vault_key_rotated",
        vault_id,
        "vault_key",
        vault_id,
        user_id,
        version,
        client_id,
        Some(&metadata.to_string()),
    )
    .await
}

fn map_item(item: DbBootstrapItemRow) -> VaultItemResponse {
    VaultItemResponse {
        id: item.id,
        vault_id: item.vault_id,
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
    }
}

fn map_attachment(attachment: DbBootstrapAttachmentRow) -> VaultAttachmentResponse {
    VaultAttachmentResponse {
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
    }
}

fn map_item_details(item: DbBootstrapItemRow) -> VaultItemDetailsResponse {
    VaultItemDetailsResponse {
        id: item.id,
        vault_id: item.vault_id,
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
        attachments: Vec::new(),
    }
}

fn build_vault_summary_map(
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
                        .and_then(storage::public_asset_url),
                    encrypted_vault_key: vault.encrypted_vault_key,
                    role: vault.role,
                },
            )
        })
        .collect()
}

async fn load_item_attachments(
    pool: &PgPool,
    items: &[DbBootstrapItemRow],
) -> Result<HashMap<String, Vec<VaultAttachmentResponse>>, AppError> {
    if items.is_empty() {
        return Ok(HashMap::new());
    }
    let item_ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
    let attachment_rows = query_as::<_, DbBootstrapAttachmentRow>(
		"SELECT id, item_id, vault_id, storage_key, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, uploaded_by, created_at FROM item_attachment WHERE item_id = ANY($1) ORDER BY created_at ASC",
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
            .push(VaultAttachmentResponse {
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
    let entitlement = resolve_attachment_entitlement(
        mode,
        actor.billing_plan.as_deref(),
        actor.billing_status.as_deref(),
    );
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

fn attachment_quota_lock_key(team_id: &str) -> String {
    format!("attachment-quota:{team_id}")
}

fn base64_encoded_length(byte_length: i32) -> i32 {
    ((byte_length + 2) / 3) * 4
}

fn encrypted_attachment_storage_size(file_size: i32) -> i32 {
    let base64_plaintext_length = base64_encoded_length(file_size);
    let ciphertext_length = base64_encoded_length(base64_plaintext_length + 16);
    let iv_length = base64_encoded_length(12);
    40 + ciphertext_length + iv_length + "AES-GCM-AAD-V1".len() as i32
}

fn pending_attachment_upload_expiry(now: OffsetDateTime) -> OffsetDateTime {
    now + time::Duration::minutes(15)
}

async fn load_pending_attachment_reservation(
    pool: &PgPool,
    storage_key: &str,
    item_id: &str,
    created_by: &str,
) -> Result<Option<DbPendingAttachmentReservationRow>, AppError> {
    query_as::<_, DbPendingAttachmentReservationRow>(
		"SELECT id, file_size, storage_size FROM pending_attachment_upload WHERE storage_key = $1 AND item_id = $2 AND created_by = $3 AND consumed_at IS NULL AND expires_at > $4 LIMIT 1",
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
		"SELECT ia.id, ia.item_id, ia.vault_id, ia.storage_key, ia.encrypted_name, ia.encrypted_content_type, ia.encryption_iv, ia.encrypted_content_type_iv, ia.encryption_algorithm, ia.file_size, ia.uploaded_by, ia.created_at, vk.role::text AS role FROM item_attachment ia INNER JOIN vault_key vk ON vk.vault_id = ia.vault_id AND vk.user_id = $2 WHERE ia.id = $1 LIMIT 1",
	)
	.bind(attachment_id)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load attachment"); AppError::internal("Failed to load attachment") })?
	.ok_or_else(|| AppError::not_found("Attachment not found"))
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
	.bind(&input.vault_type)
	.bind(input.icon.as_deref())
	.bind(input.image_key.as_deref())
	.bind(user_id)
	.bind(team_id)
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create vault"); AppError::internal("Failed to create vault") })?;
    Ok(())
}

async fn insert_vault_key(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    encrypted_vault_key: &str,
) -> Result<(), AppError> {
    query(
		"INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role, created_at) VALUES ($1, $2, $3, $4, 'owner', $5)",
	)
	.bind(generate_resource_id("vault_key"))
	.bind(vault_id)
	.bind(user_id)
	.bind(encrypted_vault_key)
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create vault key"); AppError::internal("Failed to create vault key") })?;
    Ok(())
}

async fn insert_vault_created_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
) -> Result<(), AppError> {
    insert_sync_event(
        &mut **transaction,
        "vault_created",
        vault_id,
        "vault",
        vault_id,
        user_id,
        1,
        client_id,
        None,
    )
    .await
}

async fn insert_vault_created_audit_log(
    pool: &PgPool,
    vault_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    insert_audit_event(
        pool,
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
        &mut **transaction,
        "vault_updated",
        vault_id,
        "vault",
        vault_id,
        user_id,
        1,
        client_id,
        None,
    )
    .await
}

async fn insert_vault_updated_sync_event_with_metadata(
    transaction: &mut Transaction<'_, Postgres>,
    vault_id: &str,
    user_id: &str,
    client_id: Option<&str>,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    insert_sync_event(
        &mut **transaction,
        "vault_updated",
        vault_id,
        "vault",
        vault_id,
        user_id,
        1,
        client_id,
        Some(&metadata.to_string()),
    )
    .await
}

async fn insert_vault_updated_audit_log(
    pool: &PgPool,
    vault_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        user_id,
        "vault_updated",
        "vault",
        vault_id,
        None,
    )
    .await
}

async fn insert_vault_audit_log_with_metadata(
    pool: &PgPool,
    action: &str,
    vault_id: &str,
    user_id: &str,
    metadata: serde_json::Value,
) -> Result<(), AppError> {
    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        user_id,
        action,
        "vault",
        vault_id,
        Some(metadata),
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
        &mut **transaction,
        "vault_deleted",
        vault_id,
        "vault",
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
        &mut **transaction,
        "vault_access_revoked",
        vault_id,
        "vault",
        vault_id,
        user_id,
        1,
        client_id,
        Some(&json!({ "reason": "vault_deleted", "vaultId": vault_id }).to_string()),
    )
    .await
}

async fn insert_vault_deleted_audit_log(
    pool: &PgPool,
    vault_id: &str,
    user_id: &str,
) -> Result<(), AppError> {
    insert_audit_event(
        pool,
        &generate_resource_id("audit"),
        user_id,
        "vault_deleted",
        "vault",
        vault_id,
        None,
    )
    .await
}

fn resolve_vault_sharing_entitlement(plan: &str, status: &str) -> VaultSharingEntitlement {
    shared_resolve_vault_sharing_entitlement(bittery_mode(), Some(plan), Some(status))
}

async fn load_item_row(pool: &PgPool, item_id: &str) -> Result<DbBootstrapItemRow, AppError> {
    query_as::<_, DbBootstrapItemRow>(
        "SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE id = $1 LIMIT 1",
    )
    .bind(item_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load item");
        AppError::internal("Failed to load item")
    })?
    .ok_or_else(|| AppError::not_found("Item not found"))
}

async fn load_vault_access(
    pool: &PgPool,
    vault_id: &str,
    user_id: &str,
) -> Result<DbItemVaultAccessRow, AppError> {
    query_as::<_, DbItemVaultAccessRow>(
        "SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(vault_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to verify vault access");
        AppError::internal("Failed to verify vault access")
    })?
    .ok_or_else(|| AppError::forbidden("Access denied to this vault"))
}

async fn load_user_vault_summaries(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<DbBootstrapVaultAccessRow>, AppError> {
    query_as::<_, DbBootstrapVaultAccessRow>(
        "SELECT vk.vault_id, v.name AS vault_name, v.type::text AS vault_type, v.icon AS vault_icon, v.image_key AS vault_image_key, vk.encrypted_vault_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 ORDER BY vk.created_at ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "Failed to load user vaults");
        AppError::internal("Failed to load user vaults")
    })
}

#[cfg(test)]
#[path = "vault_tests.rs"]
mod tests;
