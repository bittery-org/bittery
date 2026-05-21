use std::collections::HashMap;

use qubit::{
	builder::IntoResponse,
	handler,
	server::{ErrorCode, Router, RpcError},
};
use rand::random;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{query, query_as, query_scalar, PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use ts_rs::TS;

use crate::{auth::RefreshSessionContext, db::models::*, storage, AppState};

#[derive(Debug, Clone, Serialize, TS)]
pub struct VaultRpcError {
	pub code: String,
	pub message: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VaultIdInput {
	pub vault_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateVaultImageUploadInput {
	pub vault_id: Option<String>,
	pub file_name: String,
	pub content_type: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ItemIdInput {
	pub item_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateAttachmentUploadInput {
	pub item_id: String,
	pub file_name: String,
	pub content_type: String,
	pub file_size: i32,
}

#[derive(Debug, Clone, Deserialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateAttachmentResponse {
	pub attachment_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct AttachmentIdInput {
	pub attachment_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateAttachmentInput {
	pub attachment_id: String,
	pub encrypted_name: String,
	pub encryption_iv: String,
	pub encryption_algorithm: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateVaultMemberRoleInput {
	pub vault_id: String,
	pub user_id: String,
	pub role: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct LookupVaultUserInput {
	pub vault_id: String,
	pub email: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct AddVaultMemberInput {
	pub vault_id: String,
	pub user_id: String,
	pub role: String,
	pub encrypted_vault_key: String,
	pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct GetVaultRotationDataInput {
	pub vault_id: String,
	pub exclude_user_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RotationMemberKeyInput {
	pub user_id: String,
	pub encrypted_vault_key: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RotationReEncryptedItemInput {
	pub item_id: String,
	pub encrypted_data: String,
	pub encryption_iv: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VaultKeyRotationInput {
	pub member_keys: Vec<RotationMemberKeyInput>,
	pub re_encrypted_items: Vec<RotationReEncryptedItemInput>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct RemoveVaultMemberInput {
	pub vault_id: String,
	pub user_id: String,
	pub key_rotation: VaultKeyRotationInput,
	pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateItemResponse {
	pub item_id: String,
	pub id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
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

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BulkImportItemsInput {
	pub vault_id: String,
	pub client_id: Option<String>,
	pub items: Vec<BulkImportItemInput>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BulkImportItemsResponse {
	pub success: bool,
	pub imported_count: usize,
	pub item_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateItemResponse {
	pub success: bool,
	pub version: i32,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct MoveItemInput {
	pub item_id: String,
	pub source_vault_id: String,
	pub target_vault_id: String,
	pub encrypted_data: String,
	pub encryption_iv: String,
	pub encryption_algorithm: Option<String>,
	pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ToggleFavoriteInput {
	pub item_id: String,
	pub favorite: bool,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ItemClientInput {
	pub item_id: String,
	pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateVaultResponse {
	pub vault_id: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateVaultInput {
	pub vault_id: String,
	pub name: Option<String>,
	pub icon: Option<Option<String>>,
	pub image_key: Option<Option<String>>,
	pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateVaultResponse {
	pub id: String,
	pub name: String,
	pub icon: Option<String>,
	pub image_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ConvertVaultTypeInput {
	pub vault_id: String,
	pub target_type: String,
	pub personal_encrypted_vault_key: Option<String>,
	pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConvertVaultTypeResponse {
	pub success: bool,
	pub vault_id: String,
	pub previous_type: String,
	pub new_type: String,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct SuccessResponse {
	pub success: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
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

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatsResponse {
	pub team_count: i32,
	pub vault_count: i64,
	pub item_count: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VaultMemberResponse {
	pub user_id: String,
	pub name: String,
	pub email: String,
	pub role: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VaultAvailableMemberResponse {
	pub user_id: String,
	pub name: String,
	pub email: String,
	pub public_key: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VaultLookupUserResponse {
	pub id: String,
	pub name: String,
	pub email: String,
	pub public_key: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VaultRotationMemberResponse {
	pub user_id: String,
	pub public_key: String,
	pub role: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VaultRotationItemResponse {
	pub id: String,
	pub encrypted_data: String,
	pub encryption_iv: String,
	pub encryption_algorithm: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VaultRotationDataResponse {
	pub key_version: i32,
	pub members: Vec<VaultRotationMemberResponse>,
	pub items: Vec<VaultRotationItemResponse>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct VaultKeyRotationSummaryResponse {
	pub id: String,
	pub new_key_version: i32,
	pub items_re_encrypted: usize,
	pub members_updated: usize,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoveVaultMemberResponse {
	pub success: bool,
	pub key_rotation: VaultKeyRotationSummaryResponse,
}

#[derive(Debug, Clone, Serialize, TS)]
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

#[allow(non_snake_case)]
#[handler(query)]
pub async fn list(ctx: RefreshSessionContext) -> Result<Vec<VaultListEntryResponse>, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let vault_rows = query_as::<_, DbVaultListRow>(
		"SELECT v.id, v.name, v.type::text AS vault_type, v.icon, v.image_key, vk.role::text AS role, vk.encrypted_vault_key, v.created_by_id FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 ORDER BY v.created_at ASC",
	)
	.bind(&ctx.session.user_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vaults"); internal_error("Failed to load vaults") })?;
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault items"); internal_error("Failed to load vault items") })?;

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
			image_url: vault.image_key.as_deref().and_then(storage::public_asset_url),
			role: vault.role,
			items: items_by_vault.remove(&vault.id).unwrap_or_default(),
			encrypted_vault_key: vault.encrypted_vault_key,
			created_by_id: vault.created_by_id,
		})
		.collect())
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn get(
	ctx: RefreshSessionContext,
	input: VaultIdInput,
) -> Result<VaultDetailsResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let Some(vault) = query_as::<_, DbVaultGetRow>(
		"SELECT v.id, v.name, v.type::text AS vault_type, v.icon, v.image_key, vk.role::text AS user_role, (SELECT COUNT(*)::bigint FROM item i WHERE i.vault_id = v.id AND i.deleted_at IS NULL) AS item_count, (SELECT COUNT(*)::bigint FROM vault_key member WHERE member.vault_id = v.id) AS member_count, v.created_at FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 AND v.id = $2 LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.bind(&input.vault_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault"); internal_error("Failed to load vault") })?
	else {
		return Err(not_found_error("Vault not found or access denied"));
	};

	Ok(VaultDetailsResponse {
		id: vault.id,
		name: vault.name,
		vault_type: vault.vault_type,
		icon: vault.icon,
		image_url: vault.image_key.as_deref().and_then(storage::public_asset_url),
		user_role: vault.user_role,
		item_count: vault.item_count,
		member_count: vault.member_count,
		created_at: format_timestamp(vault.created_at),
	})
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createImageUpload(
	ctx: RefreshSessionContext,
	input: CreateVaultImageUploadInput,
) -> Result<storage::PresignedUploadResult, VaultRpcError> {
	if !input.content_type.starts_with("image/") {
		return Err(bad_request_error("Only image uploads are allowed"));
	}
	let pool = db_pool(&ctx.app_state)?;
	if let Some(vault_id) = input.vault_id.as_deref() {
		let role = query_as::<_, DbVaultRoleRow>(
			"SELECT vault_id, role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
		)
		.bind(vault_id)
		.bind(&ctx.session.user_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault role"); internal_error("Failed to load vault role") })?;
		let Some(role) = role else {
			return Err(forbidden_error("Access denied"));
		};
		if role.role != "owner" && role.role != "admin" {
			return Err(forbidden_error("Access denied"));
		}
	}

	let key = storage::create_vault_image_key(
		&ctx.session.user_id,
		input.vault_id.as_deref(),
		&input.file_name,
	);
	storage::create_presigned_upload(&key, &input.content_type, None, None)
		.await
		.map_err(|error| internal_error(&error.to_string()))
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createAttachmentUpload(
	ctx: RefreshSessionContext,
	input: CreateAttachmentUploadInput,
) -> Result<storage::PresignedUploadResult, VaultRpcError> {
	if input.file_name.trim().is_empty()
		|| input.content_type.trim().is_empty()
		|| input.file_size <= 0
	{
		return Err(bad_request_error("Invalid attachment upload request"));
	}
	let pool = db_pool(&ctx.app_state)?;
	let actor = load_attachment_actor(pool, &ctx.session.user_id).await?;
	let scoped_item = load_item_row(pool, &input.item_id).await?;
	let access = load_vault_access(pool, &scoped_item.vault_id, &ctx.session.user_id).await?;
	assert_item_write_access(&access.role, "Access denied")?;
	if let Some(max_bytes) = actor.attachment_max_file_size_bytes {
		if i64::from(input.file_size) > max_bytes {
			return Err(bad_request_error(
				"Attachment file exceeds the maximum allowed size for your current plan.",
			));
		}
	}
	let key = storage::create_attachment_key(&ctx.session.user_id, &input.item_id, &input.file_name)
		.map_err(|error| internal_error(&error.to_string()))?;
	let storage_size = encrypted_attachment_storage_size(input.file_size);
	let now = OffsetDateTime::now_utc();
	let expires_at = pending_attachment_upload_expiry(now);

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start attachment upload transaction"); internal_error("Failed to start attachment upload transaction") })?;
	query("SELECT pg_advisory_xact_lock(hashtext($1))")
		.bind(attachment_quota_lock_key(&actor.team_id))
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to lock attachment quota"); internal_error("Failed to lock attachment quota") })?;
	let committed_usage = query_scalar::<_, i64>(
		"SELECT COALESCE(SUM(ia.storage_size), 0)::bigint FROM item_attachment ia INNER JOIN \"user\" u ON ia.uploaded_by = u.id WHERE u.team_id = $1",
	)
	.bind(&actor.team_id)
	.fetch_one(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load attachment usage"); internal_error("Failed to load attachment usage") })?;
	let pending_usage = query_scalar::<_, i64>(
		"SELECT COALESCE(SUM(storage_size), 0)::bigint FROM pending_attachment_upload WHERE team_id = $1 AND consumed_at IS NULL AND expires_at > $2",
	)
	.bind(&actor.team_id)
	.bind(now)
	.fetch_one(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load pending attachment usage"); internal_error("Failed to load pending attachment usage") })?;
	let current_usage = committed_usage + pending_usage;
	if let Some(quota_bytes) = actor.attachment_storage_bytes {
		if current_usage + i64::from(storage_size) > quota_bytes {
			return Err(forbidden_error(
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
	.bind(&ctx.session.user_id)
	.bind(expires_at)
	.bind(now)
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to reserve attachment upload"); internal_error("Failed to reserve attachment upload") })?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit attachment upload reservation"); internal_error("Failed to commit attachment upload reservation") })?;

	storage::create_presigned_upload(
		&key,
		&input.content_type,
		Some(i64::from(storage_size)),
		None,
	)
	.await
	.map_err(|error| internal_error(&error.to_string()))
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createAttachment(
	ctx: RefreshSessionContext,
	input: CreateAttachmentInput,
) -> Result<CreateAttachmentResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let _actor = load_attachment_actor(pool, &ctx.session.user_id).await?;
	let scoped_item = load_item_row(pool, &input.item_id).await?;
	let access = load_vault_access(pool, &scoped_item.vault_id, &ctx.session.user_id).await?;
	assert_item_write_access(&access.role, "Access denied")?;
	let is_valid_key = storage::is_valid_attachment_upload_key(
		&input.storage_key,
		&ctx.session.user_id,
		&input.item_id,
		None,
	)
	.map_err(|error| internal_error(&error.to_string()))?;
	if !is_valid_key {
		return Err(bad_request_error("Invalid or expired attachment upload key"));
	}
	let Some(reservation) = load_pending_attachment_reservation(
		pool,
		&input.storage_key,
		&input.item_id,
		&ctx.session.user_id,
	)
	.await?
	else {
		return Err(bad_request_error(
			"Invalid or expired attachment upload reservation",
		));
	};
	if reservation.file_size != input.file_size {
		return Err(bad_request_error(
			"Attachment metadata does not match the reserved upload.",
		));
	}
	let Some(uploaded_object) = storage::head_object(&input.storage_key)
		.await
		.map_err(|error| internal_error(&error.to_string()))?
	else {
		return Err(bad_request_error(
			"Uploaded attachment does not match the reserved encrypted size.",
		));
	};
	if uploaded_object.size != i64::from(reservation.storage_size) {
		return Err(bad_request_error(
			"Uploaded attachment does not match the reserved encrypted size.",
		));
	}
	let attachment_id = generate_resource_id("attachment");
	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start attachment create transaction"); internal_error("Failed to start attachment create transaction") })?;
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
	.bind(&ctx.session.user_id)
	.bind(OffsetDateTime::now_utc())
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create attachment"); internal_error("Failed to create attachment") })?;
	query("UPDATE pending_attachment_upload SET consumed_at = $1 WHERE id = $2")
		.bind(OffsetDateTime::now_utc())
		.bind(&reservation.id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to consume attachment reservation"); internal_error("Failed to consume attachment reservation") })?;
	insert_item_sync_event(
		&mut transaction,
		"item_updated",
		&input.item_id,
		&scoped_item.vault_id,
		&ctx.session.user_id,
		ctx.request.client_id.as_deref(),
		scoped_item.version,
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit attachment create"); internal_error("Failed to commit attachment create") })?;

	Ok(CreateAttachmentResponse { attachment_id })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listAttachments(
	ctx: RefreshSessionContext,
	input: ItemIdInput,
) -> Result<Vec<VaultAttachmentResponse>, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let _actor = load_attachment_actor(pool, &ctx.session.user_id).await?;
	let scoped_item = load_item_row(pool, &input.item_id).await?;
	let _access = load_vault_access(pool, &scoped_item.vault_id, &ctx.session.user_id).await?;
	let attachment_rows = query_as::<_, DbBootstrapAttachmentRow>(
		"SELECT id, item_id, vault_id, storage_key, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, uploaded_by, created_at FROM item_attachment WHERE item_id = $1 ORDER BY created_at ASC",
	)
	.bind(&input.item_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load item attachments"); internal_error("Failed to load item attachments") })?;
	Ok(attachment_rows
		.into_iter()
		.map(map_attachment)
		.collect())
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn getAttachmentDownloadUrl(
	ctx: RefreshSessionContext,
	input: AttachmentIdInput,
) -> Result<AttachmentDownloadResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let _actor = load_attachment_actor(pool, &ctx.session.user_id).await?;
	let attachment = load_attachment_access(pool, &input.attachment_id, &ctx.session.user_id)
		.await?;
	let download_url = storage::create_presigned_download(&attachment.storage_key, Some(300))
		.await
		.map_err(|error| internal_error(&error.to_string()))?;
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn updateAttachment(
	ctx: RefreshSessionContext,
	input: UpdateAttachmentInput,
) -> Result<SuccessResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let _actor = load_attachment_actor(pool, &ctx.session.user_id).await?;
	let attachment = load_attachment_access(pool, &input.attachment_id, &ctx.session.user_id)
		.await?;
	assert_item_write_access(&attachment.role, "Access denied")?;
	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start attachment update transaction"); internal_error("Failed to start attachment update transaction") })?;
	query(
		"UPDATE item_attachment SET encrypted_name = $1, encryption_iv = $2, encryption_algorithm = $3 WHERE id = $4",
	)
	.bind(&input.encrypted_name)
	.bind(&input.encryption_iv)
	.bind(input.encryption_algorithm.as_deref().unwrap_or("AES-GCM-AAD-V1"))
	.bind(&input.attachment_id)
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to update attachment"); internal_error("Failed to update attachment") })?;
	insert_item_sync_event(
		&mut transaction,
		"item_updated",
		&attachment.item_id,
		&attachment.vault_id,
		&ctx.session.user_id,
		ctx.request.client_id.as_deref(),
		load_item_row(pool, &attachment.item_id).await?.version,
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit attachment update"); internal_error("Failed to commit attachment update") })?;
	Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn deleteAttachment(
	ctx: RefreshSessionContext,
	input: AttachmentIdInput,
) -> Result<SuccessResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let _actor = load_attachment_actor(pool, &ctx.session.user_id).await?;
	let attachment = load_attachment_access(pool, &input.attachment_id, &ctx.session.user_id)
		.await?;
	if attachment.role == "member" {
		if attachment.uploaded_by.as_deref() != Some(ctx.session.user_id.as_str()) {
			return Err(forbidden_error("You can only delete your own attachments"));
		}
	} else if attachment.role != "owner" && attachment.role != "admin" {
		return Err(forbidden_error("Access denied"));
	}
	storage::delete_object(&attachment.storage_key)
		.await
		.map_err(|error| internal_error(&error.to_string()))?;
	let item_version = load_item_row(pool, &attachment.item_id).await?.version;
	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start attachment delete transaction"); internal_error("Failed to start attachment delete transaction") })?;
	query("DELETE FROM item_attachment WHERE id = $1")
		.bind(&input.attachment_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to delete attachment"); internal_error("Failed to delete attachment") })?;
	insert_item_sync_event(
		&mut transaction,
		"item_updated",
		&attachment.item_id,
		&attachment.vault_id,
		&ctx.session.user_id,
		ctx.request.client_id.as_deref(),
		item_version,
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit attachment delete"); internal_error("Failed to commit attachment delete") })?;
	Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn create(
	ctx: RefreshSessionContext,
	input: CreateVaultInput,
) -> Result<CreateVaultResponse, VaultRpcError> {
	if input.name.trim().is_empty() || input.encrypted_vault_key.trim().is_empty() {
		return Err(bad_request_error("Invalid params"));
	}
	if input.vault_type != "personal" && input.vault_type != "team" {
		return Err(bad_request_error("Invalid params"));
	}

	let pool = db_pool(&ctx.app_state)?;
	let vault_id = input
		.vault_id
		.clone()
		.unwrap_or_else(|| generate_resource_id("vault"));
	let mut team_id: Option<String> = None;
	let mut shared_vault_limit: Option<i64> = None;
	if input.vault_type == "team" {
		let actor = query_as::<_, DbTeamBillingEntitlementRow>(
			"SELECT u.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
		)
		.bind(&ctx.session.user_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load team membership"); internal_error("Failed to load team membership") })?;
		let Some(actor) = actor else {
			return Err(bad_request_error("You must belong to a team to create a team vault"));
		};
		let Some(actor_team_id) = actor.team_id else {
			return Err(bad_request_error("You must belong to a team to create a team vault"));
		};
		let Some(plan) = actor.billing_plan.as_deref() else {
			return Err(bad_request_error("You must belong to a team to create a team vault"));
		};
		let Some(status) = actor.billing_status.as_deref() else {
			return Err(bad_request_error("You must belong to a team to create a team vault"));
		};

		let entitlement = resolve_vault_sharing_entitlement(plan, status);
		if !entitlement.allowed {
			return Err(forbidden_error(
				"Shared vaults are only available on Family or Team plans with active billing.",
			));
		}
		team_id = Some(actor_team_id);
		shared_vault_limit = entitlement.shared_vault_limit;
	}

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start vault transaction"); internal_error("Failed to start vault transaction") })?;
	if input.vault_type == "team" {
		if let (Some(team_id), Some(limit)) = (team_id.as_deref(), shared_vault_limit) {
			query("SELECT pg_advisory_xact_lock(hashtext($1))")
				.bind(format!("shared-vaults:{team_id}"))
				.execute(&mut *transaction)
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to acquire shared vault limit lock"); internal_error("Failed to acquire shared vault limit lock") })?;
			let existing_count: i64 = query_scalar(
				"SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1 AND type = 'team'",
			)
			.bind(team_id)
			.fetch_one(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to count shared vaults"); internal_error("Failed to count shared vaults") })?;
			if existing_count >= limit {
				return Err(forbidden_error(&format!(
					"Your current plan allows up to {limit} shared vaults. Upgrade to add more.",
				)));
			}
		}
	}

	insert_vault(&mut transaction, &vault_id, &ctx.session.user_id, team_id.as_deref(), &input)
		.await?;
	insert_vault_key(
		&mut transaction,
		&vault_id,
		&ctx.session.user_id,
		&input.encrypted_vault_key,
	)
	.await?;
	insert_vault_created_sync_event(
		&mut transaction,
		&vault_id,
		&ctx.session.user_id,
		input.client_id.as_deref().or(ctx.request.client_id.as_deref()),
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit vault transaction"); internal_error("Failed to commit vault transaction") })?;

	insert_vault_created_audit_log(pool, &vault_id, &ctx.session.user_id)
		.await?;

	Ok(CreateVaultResponse { vault_id })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn update(
	ctx: RefreshSessionContext,
	input: UpdateVaultInput,
) -> Result<UpdateVaultResponse, VaultRpcError> {
	if let Some(name) = input.name.as_deref() {
		if name.trim().is_empty() {
			return Err(bad_request_error("Invalid params"));
		}
	}
	let pool = db_pool(&ctx.app_state)?;
	let Some(current_vault) = query_as::<_, DbManagedVaultRow>(
		"SELECT v.id, v.name, v.icon, v.image_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.vault_id = $1 AND vk.user_id = $2 LIMIT 1",
	)
	.bind(&input.vault_id)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault"); internal_error("Failed to load vault") })?
	else {
		return Err(forbidden_error("Access denied"));
	};
	if current_vault.role != "owner" && current_vault.role != "admin" {
		return Err(forbidden_error("Access denied"));
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

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start vault transaction"); internal_error("Failed to start vault transaction") })?;
	query("UPDATE vault SET name = $1, icon = $2, image_key = $3, updated_at = $4 WHERE id = $5")
		.bind(&updated_name)
		.bind(updated_icon.as_deref())
		.bind(updated_image_key.as_deref())
		.bind(OffsetDateTime::now_utc())
		.bind(&input.vault_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to update vault"); internal_error("Failed to update vault") })?;
	insert_vault_updated_sync_event(
		&mut transaction,
		&input.vault_id,
		&ctx.session.user_id,
		input.client_id.as_deref().or(ctx.request.client_id.as_deref()),
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit vault update"); internal_error("Failed to commit vault update") })?;

	insert_vault_updated_audit_log(pool, &input.vault_id, &ctx.session.user_id)
		.await?;
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn convertType(
	ctx: RefreshSessionContext,
	input: ConvertVaultTypeInput,
) -> Result<ConvertVaultTypeResponse, VaultRpcError> {
	if input.target_type != "personal" && input.target_type != "team" {
		return Err(bad_request_error("Invalid params"));
	}
	let pool = db_pool(&ctx.app_state)?;
	let Some(owner_vault) = query_as::<_, DbVaultOwnerAccessRow>(
		"SELECT vk.user_id, v.id AS vault_id, v.type::text AS vault_type, v.team_id, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.vault_id = $1 AND vk.user_id = $2 LIMIT 1",
	)
	.bind(&input.vault_id)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault ownership"); internal_error("Failed to load vault ownership") })?
	else {
		return Err(forbidden_error("Only the vault owner can convert vault type"));
	};
	if owner_vault.role != "owner" {
		return Err(forbidden_error("Only the vault owner can convert vault type"));
	}
	let previous_type = owner_vault.vault_type;
	if previous_type == input.target_type {
		return Err(bad_request_error("Vault is already the requested type"));
	}

	let mut target_team_id = owner_vault.team_id.clone();
	let mut shared_vault_limit: Option<i64> = None;
	if previous_type == "personal" && input.target_type == "team" {
		let actor = query_as::<_, DbTeamBillingEntitlementRow>(
			"SELECT u.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
		)
		.bind(&ctx.session.user_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load team membership"); internal_error("Failed to load team membership") })?;
		let Some(actor) = actor else {
			return Err(bad_request_error(
				"You must belong to a team to convert to a shared vault",
			));
		};
		let Some(team_id) = actor.team_id else {
			return Err(bad_request_error(
				"You must belong to a team to convert to a shared vault",
			));
		};
		let Some(plan) = actor.billing_plan.as_deref() else {
			return Err(bad_request_error(
				"You must belong to a team to convert to a shared vault",
			));
		};
		let Some(status) = actor.billing_status.as_deref() else {
			return Err(bad_request_error(
				"You must belong to a team to convert to a shared vault",
			));
		};
		let entitlement = resolve_vault_sharing_entitlement(plan, status);
		if !entitlement.allowed {
			return Err(forbidden_error(
				"Shared vaults are only available on Family or Team plans with active billing.",
			));
		}
		target_team_id = Some(team_id);
		shared_vault_limit = entitlement.shared_vault_limit;
	}

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start vault conversion transaction"); internal_error("Failed to start vault conversion transaction") })?;
	if previous_type == "personal" && input.target_type == "team" {
		if let (Some(team_id), Some(limit)) = (target_team_id.as_deref(), shared_vault_limit) {
			query("SELECT pg_advisory_xact_lock(hashtext($1))")
				.bind(format!("shared-vaults:{team_id}"))
				.execute(&mut *transaction)
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to acquire shared vault limit lock"); internal_error("Failed to acquire shared vault limit lock") })?;
			let existing_count: i64 = query_scalar(
				"SELECT COUNT(*)::bigint FROM vault WHERE team_id = $1 AND type = 'team'",
			)
			.bind(team_id)
			.fetch_one(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to count shared vaults"); internal_error("Failed to count shared vaults") })?;
			if existing_count >= limit {
				return Err(forbidden_error(&format!(
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
			.map_err(|e| { tracing::error!(error = %e, "Failed to convert vault to team"); internal_error("Failed to convert vault to team") })?;
	} else if previous_type == "team" && input.target_type == "personal" {
		let member_rows = query_as::<_, DbVaultRoleRow>(
			"SELECT vault_id, role::text AS role FROM vault_key WHERE vault_id = $1 ORDER BY created_at ASC",
		)
		.bind(&input.vault_id)
		.fetch_all(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault members"); internal_error("Failed to load vault members") })?;
		let member_count: i64 = query_scalar("SELECT COUNT(*)::bigint FROM vault_key WHERE vault_id = $1")
			.bind(&input.vault_id)
			.fetch_one(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to count vault members"); internal_error("Failed to count vault members") })?;
		if member_count != 1 || member_rows.first().map(|row| row.role.as_str()) != Some("owner") {
			return Err(bad_request_error(
				"Team vault can only be converted to personal when the owner is the only member",
			));
		}
		query("UPDATE vault SET type = 'personal'::vault_type, team_id = NULL, updated_at = $1 WHERE id = $2")
			.bind(OffsetDateTime::now_utc())
			.bind(&input.vault_id)
			.execute(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to convert vault to personal"); internal_error("Failed to convert vault to personal") })?;
		if let Some(personal_key) = input.personal_encrypted_vault_key.as_deref() {
			query("UPDATE vault_key SET encrypted_vault_key = $1 WHERE vault_id = $2 AND user_id = $3")
				.bind(personal_key)
				.bind(&input.vault_id)
				.bind(&ctx.session.user_id)
				.execute(&mut *transaction)
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to update personal vault key"); internal_error("Failed to update personal vault key") })?;
		}
	}
	insert_vault_updated_sync_event(
		&mut transaction,
		&input.vault_id,
		&ctx.session.user_id,
		input.client_id.as_deref().or(ctx.request.client_id.as_deref()),
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit vault conversion"); internal_error("Failed to commit vault conversion") })?;

	insert_vault_updated_audit_log(pool, &input.vault_id, &ctx.session.user_id).await?;

	Ok(ConvertVaultTypeResponse {
		success: true,
		vault_id: input.vault_id,
		previous_type,
		new_type: input.target_type,
	})
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn delete(
	ctx: RefreshSessionContext,
	input: VaultIdInput,
) -> Result<SuccessResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let Some(vault) = query_as::<_, DbVaultDeleteRow>(
		"SELECT v.id, v.name, v.type::text AS vault_type, v.image_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.vault_id = $1 AND vk.user_id = $2 LIMIT 1",
	)
	.bind(&input.vault_id)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault"); internal_error("Failed to load vault") })?
	else {
		return Err(forbidden_error("Only the vault owner can delete the vault"));
	};
	if vault.role != "owner" {
		return Err(forbidden_error("Only the vault owner can delete the vault"));
	}

	let member_rows = query_as::<_, DbVaultMemberAccessRow>(
		"SELECT user_id FROM vault_key WHERE vault_id = $1 ORDER BY created_at ASC",
	)
	.bind(&input.vault_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault members"); internal_error("Failed to load vault members") })?;

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start vault delete transaction"); internal_error("Failed to start vault delete transaction") })?;
	insert_vault_deleted_sync_event(
		&mut transaction,
		&input.vault_id,
		&ctx.session.user_id,
		ctx.request.client_id.as_deref(),
	)
	.await?;
	for member in member_rows {
		if member.user_id == ctx.session.user_id {
			continue;
		}
		insert_vault_access_revoked_sync_event(
			&mut transaction,
			&input.vault_id,
			&member.user_id,
			ctx.request.client_id.as_deref(),
		)
		.await?;
	}
	query("DELETE FROM item_attachment WHERE vault_id = $1")
		.bind(&input.vault_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to delete vault attachments"); internal_error("Failed to delete vault attachments") })?;
	query("DELETE FROM item WHERE vault_id = $1")
		.bind(&input.vault_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to delete vault items"); internal_error("Failed to delete vault items") })?;
	query("DELETE FROM vault_key WHERE vault_id = $1")
		.bind(&input.vault_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to delete vault memberships"); internal_error("Failed to delete vault memberships") })?;
	query("DELETE FROM vault WHERE id = $1")
		.bind(&input.vault_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to delete vault"); internal_error("Failed to delete vault") })?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit vault deletion"); internal_error("Failed to commit vault deletion") })?;

	insert_vault_deleted_audit_log(pool, &input.vault_id, &ctx.session.user_id).await?;
	if let Some(image_key) = vault.image_key {
		let _ = storage::delete_object(&image_key).await;
	}

	Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listItems(
	ctx: RefreshSessionContext,
	input: VaultIdInput,
) -> Result<Vec<VaultItemDetailsResponse>, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let vault_access = query_as::<_, DbItemVaultAccessRow>(
		"SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
	)
	.bind(&input.vault_id)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to verify vault access"); internal_error("Failed to verify vault access") })?;
	if vault_access.is_none() {
		return Err(forbidden_error("Access denied to this vault"));
	}
	let item_rows = query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC",
	)
	.bind(&input.vault_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load vault items"); internal_error("Failed to load vault items") })?;
	let attachments_enabled = attachments_enabled_for_user(pool, &ctx.session.user_id).await?;
	let attachments_by_item = if attachments_enabled {
		load_item_attachments(pool, &item_rows).await?
	} else {
		HashMap::new()
	};

	Ok(item_rows
		.into_iter()
		.map(|item| VaultItemDetailsResponse {
			attachments: attachments_by_item.get(&item.id).cloned().unwrap_or_default(),
			..map_item_details(item)
		})
		.collect())
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listAllItems(
	ctx: RefreshSessionContext,
) -> Result<Vec<VaultItemWithVaultResponse>, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let user_vaults = load_user_vault_summaries(pool, &ctx.session.user_id).await?;
	if user_vaults.is_empty() {
		return Ok(Vec::new());
	}
	let vault_ids: Vec<String> = user_vaults.iter().map(|vault| vault.vault_id.clone()).collect();
	let item_rows = query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = ANY($1) AND deleted_at IS NULL ORDER BY updated_at DESC",
	)
	.bind(&vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load items"); internal_error("Failed to load items") })?;
	let attachments_enabled = attachments_enabled_for_user(pool, &ctx.session.user_id).await?;
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
			attachments: attachments_by_item.get(&item.id).cloned().unwrap_or_default(),
			vault: vault_map.get(&item.vault_id).cloned(),
		})
		.collect())
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listAllDeletedItems(
	ctx: RefreshSessionContext,
) -> Result<Vec<DeletedVaultItemWithVaultResponse>, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let user_vaults = load_user_vault_summaries(pool, &ctx.session.user_id).await?;
	if user_vaults.is_empty() {
		return Ok(Vec::new());
	}
	let vault_ids: Vec<String> = user_vaults.iter().map(|vault| vault.vault_id.clone()).collect();
	let item_rows = query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = ANY($1) AND deleted_at IS NOT NULL ORDER BY deleted_at DESC",
	)
	.bind(&vault_ids)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load deleted items"); internal_error("Failed to load deleted items") })?;
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

#[allow(non_snake_case)]
#[handler(query)]
pub async fn getItem(
	ctx: RefreshSessionContext,
	input: ItemIdInput,
) -> Result<VaultItemDetailsResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let item_row = query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE id = $1 LIMIT 1",
	)
	.bind(&input.item_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load item"); internal_error("Failed to load item") })?
	.ok_or_else(|| not_found_error("Item not found"))?;
	let vault_access = query_as::<_, DbItemVaultAccessRow>(
		"SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
	)
	.bind(&item_row.vault_id)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to verify item access"); internal_error("Failed to verify item access") })?;
	if vault_access.is_none() {
		return Err(forbidden_error("Access denied"));
	}
	let attachments_enabled = attachments_enabled_for_user(pool, &ctx.session.user_id).await?;
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn createItem(
	ctx: RefreshSessionContext,
	input: CreateItemInput,
) -> Result<CreateItemResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let access = load_vault_access(pool, &input.vault_id, &ctx.session.user_id).await?;
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

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start item transaction"); internal_error("Failed to start item transaction") })?;
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
	.bind(&ctx.session.user_id)
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create item"); internal_error("Failed to create item") })?;
	insert_item_sync_event(
		&mut transaction,
		"item_created",
		&item_id,
		&input.vault_id,
		&ctx.session.user_id,
		input.client_id.as_deref(),
		version,
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit item creation"); internal_error("Failed to commit item creation") })?;
	insert_item_audit_log(
		pool,
		"item_created",
		&item_id,
		&ctx.session.user_id,
		Some(json!({ "vaultId": input.vault_id, "category": input.category })),
	)
	.await?;

	Ok(CreateItemResponse {
		item_id: item_id.clone(),
		id: item_id,
	})
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn bulkImportItems(
	ctx: RefreshSessionContext,
	input: BulkImportItemsInput,
) -> Result<BulkImportItemsResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let access = load_vault_access(pool, &input.vault_id, &ctx.session.user_id).await?;
	assert_item_write_access(&access.role, "Read-only access cannot create items")?;
	if input.items.is_empty() {
		return Ok(BulkImportItemsResponse {
			success: true,
			imported_count: 0,
			item_ids: Vec::new(),
		});
	}
	if input.items.len() > 200 {
		return Err(bad_request_error("Cannot import more than 200 items at once"));
	}

	let item_ids: Vec<String> = input.items.iter().map(|item| item.item_id.clone()).collect();
	let unique_ids: std::collections::HashSet<&str> =
		item_ids.iter().map(std::string::String::as_str).collect();
	if unique_ids.len() != item_ids.len() {
		return Err(bad_request_error("Duplicate item IDs in import payload"));
	}

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start bulk import transaction"); internal_error("Failed to start bulk import transaction") })?;
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
		.bind(&ctx.session.user_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to import vault items"); internal_error("Failed to import vault items") })?;
	}
	insert_vault_updated_sync_event_with_metadata(
		&mut transaction,
		&input.vault_id,
		&ctx.session.user_id,
		input.client_id.as_deref(),
		json!({ "reason": "bulk_import", "importedCount": item_ids.len() }),
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit bulk import"); internal_error("Failed to commit bulk import") })?;
	insert_vault_audit_log_with_metadata(
		pool,
		"vault_updated",
		&input.vault_id,
		&ctx.session.user_id,
		json!({ "reason": "bulk_import", "importedCount": item_ids.len() }),
	)
	.await?;

	Ok(BulkImportItemsResponse {
		success: true,
		imported_count: item_ids.len(),
		item_ids,
	})
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn updateItem(
	ctx: RefreshSessionContext,
	input: UpdateItemInput,
) -> Result<UpdateItemResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let existing_item = load_item_row(pool, &input.item_id).await?;
	let access = load_vault_access(pool, &existing_item.vault_id, &ctx.session.user_id).await?;
	assert_item_write_access(&access.role, "Access denied")?;
	let current_version = existing_item.version;
	if let Some(expected_version) = input.expected_version {
		if expected_version != current_version {
			return Err(conflict_error("Item has been modified by another client"));
		}
	}
	let new_version = current_version + 1;

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start item update transaction"); internal_error("Failed to start item update transaction") })?;
	query(
		"UPDATE item SET encrypted_data = COALESCE($1, encrypted_data), encryption_iv = COALESCE($2, encryption_iv), encryption_algorithm = COALESCE($3, encryption_algorithm), version = $4, last_modified_by = $5, updated_at = $6 WHERE id = $7",
	)
	.bind(input.encrypted_data.as_deref())
	.bind(input.encryption_iv.as_deref())
	.bind(input.encryption_algorithm.as_deref())
	.bind(new_version)
	.bind(&ctx.session.user_id)
	.bind(OffsetDateTime::now_utc())
	.bind(&input.item_id)
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to update item"); internal_error("Failed to update item") })?;
	insert_item_sync_event(
		&mut transaction,
		"item_updated",
		&input.item_id,
		&existing_item.vault_id,
		&ctx.session.user_id,
		input.client_id.as_deref(),
		new_version,
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit item update"); internal_error("Failed to commit item update") })?;

	Ok(UpdateItemResponse {
		success: true,
		version: new_version,
	})
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn toggleFavorite(
	ctx: RefreshSessionContext,
	input: ToggleFavoriteInput,
) -> Result<SuccessResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let existing_item = load_item_row(pool, &input.item_id).await?;
	let access = load_vault_access(pool, &existing_item.vault_id, &ctx.session.user_id).await?;
	assert_item_write_access(&access.role, "Access denied")?;

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start favorite update transaction"); internal_error("Failed to start favorite update transaction") })?;
	query("UPDATE item SET favorite = $1, updated_at = $2 WHERE id = $3")
		.bind(input.favorite)
		.bind(OffsetDateTime::now_utc())
		.bind(&input.item_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to update favorite state"); internal_error("Failed to update favorite state") })?;
	insert_item_sync_event(
		&mut transaction,
		"item_updated",
		&input.item_id,
		&existing_item.vault_id,
		&ctx.session.user_id,
		None,
		existing_item.version,
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit favorite update"); internal_error("Failed to commit favorite update") })?;

	Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn deleteItem(
	ctx: RefreshSessionContext,
	input: ItemClientInput,
) -> Result<SuccessResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let existing_item = load_item_row(pool, &input.item_id).await?;
	let access = load_vault_access(pool, &existing_item.vault_id, &ctx.session.user_id).await?;
	assert_item_write_access(&access.role, "Access denied")?;

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start item delete transaction"); internal_error("Failed to start item delete transaction") })?;
	query("UPDATE item SET deleted_at = $1, last_modified_by = $2 WHERE id = $3")
		.bind(OffsetDateTime::now_utc())
		.bind(&ctx.session.user_id)
		.bind(&input.item_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to delete item"); internal_error("Failed to delete item") })?;
	insert_item_sync_event(
		&mut transaction,
		"item_deleted",
		&input.item_id,
		&existing_item.vault_id,
		&ctx.session.user_id,
		input.client_id.as_deref(),
		existing_item.version,
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit item delete"); internal_error("Failed to commit item delete") })?;
	insert_item_audit_log(
		pool,
		"item_deleted",
		&input.item_id,
		&ctx.session.user_id,
		Some(json!({ "vaultId": existing_item.vault_id, "version": existing_item.version })),
	)
	.await?;

	Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(query)]
pub async fn listDeletedItems(
	ctx: RefreshSessionContext,
	input: VaultIdInput,
) -> Result<Vec<VaultItemResponse>, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let access = load_vault_access(pool, &input.vault_id, &ctx.session.user_id).await?;
	let _ = access;
	let item_rows = query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE vault_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at DESC NULLS LAST",
	)
	.bind(&input.vault_id)
	.fetch_all(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load deleted items"); internal_error("Failed to load deleted items") })?;

	Ok(item_rows.into_iter().map(map_item).collect())
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn restoreItem(
	ctx: RefreshSessionContext,
	input: ItemClientInput,
) -> Result<SuccessResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let existing_item = load_item_row(pool, &input.item_id).await?;
	if existing_item.deleted_at.is_none() {
		return Err(bad_request_error("Item is not deleted"));
	}
	let access = load_vault_access(pool, &existing_item.vault_id, &ctx.session.user_id).await?;
	assert_item_write_access(&access.role, "Access denied")?;

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start item restore transaction"); internal_error("Failed to start item restore transaction") })?;
	query("UPDATE item SET deleted_at = NULL, last_modified_by = $1, updated_at = $2 WHERE id = $3")
		.bind(&ctx.session.user_id)
		.bind(OffsetDateTime::now_utc())
		.bind(&input.item_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to restore item"); internal_error("Failed to restore item") })?;
	insert_item_sync_event(
		&mut transaction,
		"item_restored",
		&input.item_id,
		&existing_item.vault_id,
		&ctx.session.user_id,
		input.client_id.as_deref(),
		existing_item.version,
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit item restore"); internal_error("Failed to commit item restore") })?;
	insert_item_audit_log(
		pool,
		"item_restored",
		&input.item_id,
		&ctx.session.user_id,
		Some(json!({ "vaultId": existing_item.vault_id, "version": existing_item.version })),
	)
	.await?;

	Ok(SuccessResponse { success: true })
}

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn moveItem(
	ctx: RefreshSessionContext,
	input: MoveItemInput,
) -> Result<UpdateItemResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let existing_item = load_item_row(pool, &input.item_id).await?;
	if existing_item.vault_id != input.source_vault_id {
		return Err(bad_request_error("Item does not belong to the source vault"));
	}
	if existing_item.deleted_at.is_some() {
		return Err(bad_request_error(
			"Cannot move items that are in trash. Restore first.",
		));
	}
	let _source_access = load_vault_access(pool, &input.source_vault_id, &ctx.session.user_id).await?;
	let target_access = load_vault_access(pool, &input.target_vault_id, &ctx.session.user_id).await?;
	assert_item_write_access(&target_access.role, "Cannot move items to a read-only vault")?;
	let new_version = existing_item.version + 1;

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start item move transaction"); internal_error("Failed to start item move transaction") })?;
	query(
		"UPDATE item SET vault_id = $1, encrypted_data = $2, encryption_iv = $3, encryption_algorithm = COALESCE($4, encryption_algorithm), version = $5, last_modified_by = $6, updated_at = $7 WHERE id = $8",
	)
	.bind(&input.target_vault_id)
	.bind(&input.encrypted_data)
	.bind(&input.encryption_iv)
	.bind(input.encryption_algorithm.as_deref())
	.bind(new_version)
	.bind(&ctx.session.user_id)
	.bind(OffsetDateTime::now_utc())
	.bind(&input.item_id)
	.execute(&mut *transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to move item"); internal_error("Failed to move item") })?;
	insert_item_sync_event_with_metadata(
		&mut transaction,
		"item_moved",
		&input.item_id,
		&input.target_vault_id,
		&ctx.session.user_id,
		input.client_id.as_deref(),
		new_version,
		json!({ "sourceVaultId": input.source_vault_id }),
	)
	.await?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit item move"); internal_error("Failed to commit item move") })?;
	insert_item_audit_log(
		pool,
		"item_moved",
		&input.item_id,
		&ctx.session.user_id,
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

#[allow(non_snake_case)]
#[handler(mutation)]
pub async fn permanentlyDeleteItem(
	ctx: RefreshSessionContext,
	input: ItemClientInput,
) -> Result<SuccessResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let existing_item = load_item_row(pool, &input.item_id).await?;
	if existing_item.deleted_at.is_none() {
		return Err(bad_request_error("Can only permanently delete items in trash"));
	}
	let access = load_vault_access(pool, &existing_item.vault_id, &ctx.session.user_id).await?;
	assert_item_write_access(&access.role, "Access denied")?;

	let mut transaction = pool
		.begin()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to start permanent delete transaction"); internal_error("Failed to start permanent delete transaction") })?;
	insert_item_sync_event(
		&mut transaction,
		"item_permanently_deleted",
		&input.item_id,
		&existing_item.vault_id,
		&ctx.session.user_id,
		input.client_id.as_deref(),
		existing_item.version,
	)
	.await?;
	query("DELETE FROM item WHERE id = $1")
		.bind(&input.item_id)
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to permanently delete item"); internal_error("Failed to permanently delete item") })?;
	transaction
		.commit()
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to commit permanent delete"); internal_error("Failed to commit permanent delete") })?;
	insert_item_audit_log(
		pool,
		"item_permanently_deleted",
		&input.item_id,
		&ctx.session.user_id,
		Some(json!({ "vaultId": existing_item.vault_id, "version": existing_item.version })),
	)
	.await?;

	Ok(SuccessResponse { success: true })
}

#[handler(query)]
pub async fn stats(ctx: RefreshSessionContext) -> Result<VaultStatsResponse, VaultRpcError> {
	let pool = db_pool(&ctx.app_state)?;
	let team_count = query_scalar::<_, i64>(
		"SELECT CASE WHEN team_id IS NULL THEN 0 ELSE 1 END::bigint FROM \"user\" WHERE id = $1 LIMIT 1",
	)
	.bind(&ctx.session.user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load user team info"); internal_error("Failed to load user team info") })?
	.unwrap_or(0) as i32;
	let vault_count = query_scalar::<_, i64>(
		"SELECT COUNT(*)::bigint FROM vault_key WHERE user_id = $1",
	)
	.bind(&ctx.session.user_id)
	.fetch_one(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to count user vaults"); internal_error("Failed to count user vaults") })?;
	let item_count = query_scalar::<_, i64>(
		"SELECT COUNT(*)::bigint FROM item i INNER JOIN vault_key vk ON vk.vault_id = i.vault_id WHERE vk.user_id = $1 AND i.deleted_at IS NULL",
	)
	.bind(&ctx.session.user_id)
	.fetch_one(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to count vault items"); internal_error("Failed to count vault items") })?;

	Ok(VaultStatsResponse {
		team_count,
		vault_count,
		item_count,
	})
}

mod member_handlers {
	use super::*;

	#[allow(non_snake_case)]
	#[handler(query)]
	pub async fn list(
		ctx: RefreshSessionContext,
		input: VaultIdInput,
	) -> Result<Vec<VaultMemberResponse>, VaultRpcError> {
		let pool = db_pool(&ctx.app_state)?;
		let _access = load_vault_access(pool, &input.vault_id, &ctx.session.user_id).await?;
		let members = query_as::<_, DbTeamMemberRow>(
			"SELECT vk.user_id, u.name, u.email, vk.role::text AS role, vk.created_at AS joined_at FROM vault_key vk INNER JOIN \"user\" u ON vk.user_id = u.id WHERE vk.vault_id = $1 ORDER BY vk.created_at ASC",
		)
		.bind(&input.vault_id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault members"); internal_error("Failed to load vault members") })?;
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

	#[allow(non_snake_case)]
	#[handler(query)]
	pub async fn availableTeamMembers(
		ctx: RefreshSessionContext,
		input: VaultIdInput,
	) -> Result<Vec<VaultAvailableMemberResponse>, VaultRpcError> {
		let pool = db_pool(&ctx.app_state)?;
		let actor = load_managed_team_vault_actor(pool, &input.vault_id, &ctx.session.user_id).await?;
		let team_members = query_as::<_, DbVaultAvailableMemberRow>(
			"SELECT id AS user_id, name, email, public_key FROM \"user\" WHERE team_id = $1 ORDER BY created_at ASC",
		)
		.bind(actor.team_id.as_deref())
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load team members"); internal_error("Failed to load team members") })?;
		let existing_member_ids = query_scalar::<_, String>(
			"SELECT user_id FROM vault_key WHERE vault_id = $1",
		)
		.bind(&input.vault_id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault members"); internal_error("Failed to load vault members") })?;
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

	#[allow(non_snake_case)]
	#[handler(mutation)]
	pub async fn updateRole(
		ctx: RefreshSessionContext,
		input: UpdateVaultMemberRoleInput,
	) -> Result<SuccessResponse, VaultRpcError> {
		let role = validate_vault_member_role(&input.role)?;
		let pool = db_pool(&ctx.app_state)?;
		let actor = load_managed_team_vault_actor(pool, &input.vault_id, &ctx.session.user_id).await?;
		if input.user_id == ctx.session.user_id {
			return Err(bad_request_error("Cannot change your own role"));
		}
		let target_access = load_vault_access(pool, &input.vault_id, &input.user_id)
			.await
			.map_err(|error| {
				if error.code == "FORBIDDEN" {
					not_found_error("Member not found")
				} else {
					error
				}
			})?;
		if target_access.role == "owner" {
			return Err(forbidden_error("Cannot change vault owner's role"));
		}
		if actor.role == "admin" && target_access.role == "admin" {
			return Err(forbidden_error("Admins cannot change other admins"));
		}
		query("UPDATE vault_key SET role = $1 WHERE vault_id = $2 AND user_id = $3")
			.bind(role)
			.bind(&input.vault_id)
			.bind(&input.user_id)
			.execute(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to update vault member role"); internal_error("Failed to update vault member role") })?;
		Ok(SuccessResponse { success: true })
	}

	#[allow(non_snake_case)]
	#[handler(query)]
	pub async fn lookupUser(
		ctx: RefreshSessionContext,
		input: LookupVaultUserInput,
	) -> Result<VaultLookupUserResponse, VaultRpcError> {
		let pool = db_pool(&ctx.app_state)?;
		let actor = load_managed_team_vault_actor(pool, &input.vault_id, &ctx.session.user_id).await?;
		let normalized_email = input.email.trim().to_ascii_lowercase();
		let current_user_email = query_scalar::<_, String>("SELECT email FROM \"user\" WHERE id = $1 LIMIT 1")
			.bind(&ctx.session.user_id)
			.fetch_optional(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to load current user"); internal_error("Failed to load current user") })?;
		if current_user_email
			.as_deref()
			.map(|email| email.eq_ignore_ascii_case(&normalized_email))
			.unwrap_or(false)
		{
			return Err(bad_request_error("Cannot add yourself as a member"));
		}
		let found_user = query_as::<_, DbVaultLookupUserRow>(
			"SELECT id, name, email, public_key, team_id FROM \"user\" WHERE LOWER(email) = $1 LIMIT 1",
		)
		.bind(&normalized_email)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to look up user"); internal_error("Failed to look up user") })?
		.ok_or_else(|| not_found_error("User not found"))?;
		if found_user.team_id.as_deref() != actor.team_id.as_deref() {
			return Err(not_found_error("User not found"));
		}
		let existing_member = query_scalar::<_, String>(
			"SELECT user_id FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
		)
		.bind(&input.vault_id)
		.bind(&found_user.id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load existing vault member"); internal_error("Failed to load existing vault member") })?;
		if existing_member.is_some() {
			return Err(bad_request_error("User is already a member of this vault"));
		}
		Ok(VaultLookupUserResponse {
			id: found_user.id,
			name: found_user.name,
			email: found_user.email,
			public_key: found_user.public_key,
		})
	}

	#[allow(non_snake_case)]
	#[handler(mutation)]
	pub async fn add(
		ctx: RefreshSessionContext,
		input: AddVaultMemberInput,
	) -> Result<SuccessResponse, VaultRpcError> {
		let role = validate_vault_member_role(&input.role)?;
		let pool = db_pool(&ctx.app_state)?;
		let actor = load_managed_team_vault_actor(pool, &input.vault_id, &ctx.session.user_id).await?;
		let target_user = query_as::<_, DbVaultLookupUserRow>(
			"SELECT id, name, email, public_key, team_id FROM \"user\" WHERE id = $1 LIMIT 1",
		)
		.bind(&input.user_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load target user"); internal_error("Failed to load target user") })?
		.ok_or_else(|| not_found_error("User not found"))?;
		if target_user.team_id.as_deref() != actor.team_id.as_deref() {
			return Err(bad_request_error(
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
		.map_err(|e| { tracing::error!(error = %e, "Failed to load existing vault member"); internal_error("Failed to load existing vault member") })?;
		if existing_member.is_some() {
			return Err(conflict_error("User is already a member of this vault"));
		}
		let mut transaction = pool
			.begin()
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to start vault member add transaction"); internal_error("Failed to start vault member add transaction") })?;
		query(
			"INSERT INTO vault_key (id, vault_id, user_id, encrypted_vault_key, role, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
		)
		.bind(generate_resource_id("vault_key"))
		.bind(&input.vault_id)
		.bind(&input.user_id)
		.bind(&input.encrypted_vault_key)
		.bind(role)
		.bind(OffsetDateTime::now_utc())
		.execute(&mut *transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to add vault member"); internal_error("Failed to add vault member") })?;
		insert_vault_member_sync_event(
			&mut transaction,
			"vault_member_added",
			&input.user_id,
			&input.vault_id,
			&ctx.session.user_id,
			input.client_id.as_deref().or(ctx.request.client_id.as_deref()),
			json!({ "addedUserId": input.user_id, "role": role }),
		)
		.await?;
		transaction
			.commit()
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to commit vault member add"); internal_error("Failed to commit vault member add") })?;
		insert_vault_audit_log_with_metadata(
			pool,
			"vault_member_added",
			&input.vault_id,
			&ctx.session.user_id,
			json!({ "addedUserId": input.user_id, "role": role }),
		)
		.await?;
		Ok(SuccessResponse { success: true })
	}

	#[allow(non_snake_case)]
	#[handler(query)]
	pub async fn getRotationData(
		ctx: RefreshSessionContext,
		input: GetVaultRotationDataInput,
	) -> Result<VaultRotationDataResponse, VaultRpcError> {
		let pool = db_pool(&ctx.app_state)?;
		let _actor = load_managed_team_vault_actor(pool, &input.vault_id, &ctx.session.user_id).await?;
		let vault_record = query_as::<_, DbTeamRotationVaultRow>(
			"SELECT id, name, key_version FROM vault WHERE id = $1 LIMIT 1",
		)
		.bind(&input.vault_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault"); internal_error("Failed to load vault") })?
		.ok_or_else(|| not_found_error("Vault not found"))?;
		let members = query_as::<_, DbRotationMemberRow>(
			"SELECT vk.user_id, u.public_key, vk.role::text AS role FROM vault_key vk INNER JOIN \"user\" u ON vk.user_id = u.id WHERE vk.vault_id = $1 AND vk.user_id != $2 ORDER BY vk.created_at ASC",
		)
		.bind(&input.vault_id)
		.bind(&input.exclude_user_id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load rotation members"); internal_error("Failed to load rotation members") })?;
		let items = query_as::<_, DbRotationItemRow>(
			"SELECT id, encrypted_data, encryption_iv, encryption_algorithm FROM item WHERE vault_id = $1 ORDER BY created_at ASC",
		)
		.bind(&input.vault_id)
		.fetch_all(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load rotation items"); internal_error("Failed to load rotation items") })?;
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
				})
				.collect(),
		})
	}

	#[allow(non_snake_case)]
	#[handler(mutation)]
	pub async fn remove(
		ctx: RefreshSessionContext,
		input: RemoveVaultMemberInput,
	) -> Result<RemoveVaultMemberResponse, VaultRpcError> {
		let pool = db_pool(&ctx.app_state)?;
		let actor = load_managed_team_vault_actor(pool, &input.vault_id, &ctx.session.user_id).await?;
		if input.user_id == ctx.session.user_id {
			return Err(bad_request_error("Cannot remove yourself"));
		}
		let target_access = load_vault_access(pool, &input.vault_id, &input.user_id)
			.await
			.map_err(|error| {
				if error.code == "FORBIDDEN" {
					not_found_error("Member not found")
				} else {
					error
				}
			})?;
		if target_access.role == "owner" {
			return Err(forbidden_error("Cannot remove vault owner"));
		}
		if actor.role == "admin" && target_access.role == "admin" {
			return Err(forbidden_error("Admins cannot remove other admins"));
		}
		let current_vault = query_as::<_, DbTeamRotationVaultRow>(
			"SELECT id, name, key_version FROM vault WHERE id = $1 LIMIT 1",
		)
		.bind(&input.vault_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault"); internal_error("Failed to load vault") })?
		.ok_or_else(|| not_found_error("Vault not found"))?;
		let new_key_version = current_vault.key_version + 1;
		let rotation_id = generate_resource_id("rotation");
		query(
			"INSERT INTO vault_key_rotation (id, vault_id, key_version, reason, initiated_by_id, removed_user_id, items_re_encrypted, members_updated, status, created_at) VALUES ($1, $2, $3, 'member_removed'::key_rotation_reason, $4, $5, $6, $7, 'in_progress', $8)",
		)
		.bind(&rotation_id)
		.bind(&input.vault_id)
		.bind(new_key_version)
		.bind(&ctx.session.user_id)
		.bind(&input.user_id)
		.bind(input.key_rotation.re_encrypted_items.len() as i32)
		.bind(input.key_rotation.member_keys.len() as i32)
		.bind(OffsetDateTime::now_utc())
		.execute(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to create vault key rotation"); internal_error("Failed to create vault key rotation") })?;

		let removal_result = async {
			let mut transaction = pool
				.begin()
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to start vault member removal transaction"); internal_error("Failed to start vault member removal transaction") })?;
			let deleted_rows = query(
				"DELETE FROM vault_key WHERE vault_id = $1 AND user_id = $2",
			)
			.bind(&input.vault_id)
			.bind(&input.user_id)
			.execute(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to remove vault member"); internal_error("Failed to remove vault member") })?
			.rows_affected();
			if deleted_rows == 0 {
				return Err(not_found_error("Member not found"));
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
				.map_err(|e| { tracing::error!(error = %e, "Failed to update rotated member key"); internal_error("Failed to update rotated member key") })?
				.rows_affected();
				if updated_rows == 0 {
					return Err(not_found_error("Member key not found for rotation"));
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
				.map_err(|e| { tracing::error!(error = %e, "Failed to update rotated item"); internal_error("Failed to update rotated item") })?
				.rows_affected();
				if updated_rows == 0 {
					return Err(not_found_error("Item not found in vault during rotation"));
				}
			}
			query("UPDATE vault SET key_version = $1, updated_at = $2 WHERE id = $3")
				.bind(new_key_version)
				.bind(OffsetDateTime::now_utc())
				.bind(&input.vault_id)
				.execute(&mut *transaction)
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to update vault key version"); internal_error("Failed to update vault key version") })?;
			query(
				"UPDATE vault_key_rotation SET status = 'completed', completed_at = $1 WHERE id = $2",
			)
			.bind(OffsetDateTime::now_utc())
			.bind(&rotation_id)
			.execute(&mut *transaction)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to finalize vault key rotation"); internal_error("Failed to finalize vault key rotation") })?;
			insert_vault_access_revoked_sync_event_with_metadata(
				&mut transaction,
				&input.vault_id,
				&input.user_id,
				input.client_id.as_deref().or(ctx.request.client_id.as_deref()),
				new_key_version,
				json!({ "reason": "member_removed", "removedUserId": input.user_id }),
			)
			.await?;
			insert_vault_member_sync_event(
				&mut transaction,
				"vault_member_removed",
				&input.user_id,
				&input.vault_id,
				&ctx.session.user_id,
				input.client_id.as_deref().or(ctx.request.client_id.as_deref()),
				json!({ "removedUserId": input.user_id }),
			)
			.await?;
			insert_vault_key_rotated_sync_event(
				&mut transaction,
				&input.vault_id,
				&ctx.session.user_id,
				input.client_id.as_deref().or(ctx.request.client_id.as_deref()),
				new_key_version,
				json!({ "reason": "member_removed", "keyRotationId": rotation_id }),
			)
			.await?;
			transaction
				.commit()
				.await
				.map_err(|e| { tracing::error!(error = %e, "Failed to commit vault member removal"); internal_error("Failed to commit vault member removal") })?;
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
			.map_err(|e| { tracing::error!(error = %e, "Failed to mark vault key rotation as failed"); internal_error("Failed to mark vault key rotation as failed") })?;
			return Err(internal_error("Key rotation failed. Please try again."));
		}

		insert_vault_audit_log_with_metadata(
			pool,
			"vault_member_removed",
			&input.vault_id,
			&ctx.session.user_id,
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
	) -> Result<ManagedVaultActor, VaultRpcError> {
		let actor = query_as::<_, DbVaultOwnerAccessRow>(
			"SELECT vk.vault_id, v.type::text AS vault_type, v.team_id, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON v.id = vk.vault_id WHERE vk.vault_id = $1 AND vk.user_id = $2 LIMIT 1",
		)
		.bind(vault_id)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load vault access"); internal_error("Failed to load vault access") })?
		.ok_or_else(|| forbidden_error("Access denied to this vault"))?;
		let billing = query_as::<_, DbTeamBillingEntitlementRow>(
			"SELECT u.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
		)
		.bind(user_id)
		.fetch_optional(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to load billing entitlements"); internal_error("Failed to load billing entitlements") })?;
		assert_vault_sharing_available(billing.as_ref())?;
		if actor.role != "owner" && actor.role != "admin" {
			return Err(forbidden_error("Only vault owner or admin can manage members"));
		}
		if actor.vault_type != "team" || actor.team_id.is_none() {
			return Err(bad_request_error("Only team vaults support adding members"));
		}
		Ok(ManagedVaultActor {
			role: actor.role,
			team_id: actor.team_id,
		})
	}

	fn assert_vault_sharing_available(
		billing: Option<&DbTeamBillingEntitlementRow>,
	) -> Result<(), VaultRpcError> {
		if bittery_mode() == "self-hosted" {
			return Ok(());
		}
		let Some(billing) = billing else {
			return Err(forbidden_error(
				"Shared vault management is only available on Family or Team plans with active billing.",
			));
		};
		let entitlement = resolve_vault_sharing_entitlement(
			billing.billing_plan.as_deref().unwrap_or("free"),
			billing.billing_status.as_deref().unwrap_or("none"),
		);
		if !entitlement.allowed {
			return Err(forbidden_error(
				"Shared vault management is only available on Family or Team plans with active billing.",
			));
		}
		Ok(())
	}

	fn validate_vault_member_role(role: &str) -> Result<&str, VaultRpcError> {
		if matches!(role, "admin" | "member" | "read-only") {
			Ok(role)
		} else {
			Err(bad_request_error("Invalid member role"))
		}
	}
}

fn create_vault_members_router() -> Router<AppState> {
	Router::new()
		.handler(member_handlers::list)
		.handler(member_handlers::availableTeamMembers)
		.handler(member_handlers::updateRole)
		.handler(member_handlers::lookupUser)
		.handler(member_handlers::add)
		.handler(member_handlers::getRotationData)
		.handler(member_handlers::remove)
}

async fn load_item_row(pool: &PgPool, item_id: &str) -> Result<DbBootstrapItemRow, VaultRpcError> {
	query_as::<_, DbBootstrapItemRow>(
		"SELECT id, vault_id, category::text AS category, favorite, encrypted_data, encryption_iv, encryption_algorithm, version, last_modified_by, created_at, updated_at, deleted_at FROM item WHERE id = $1 LIMIT 1",
	)
	.bind(item_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load item"); internal_error("Failed to load item") })?
	.ok_or_else(|| not_found_error("Item not found"))
}

async fn load_vault_access(
	pool: &PgPool,
	vault_id: &str,
	user_id: &str,
) -> Result<DbItemVaultAccessRow, VaultRpcError> {
	query_as::<_, DbItemVaultAccessRow>(
		"SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
	)
	.bind(vault_id)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to verify vault access"); internal_error("Failed to verify vault access") })?
	.ok_or_else(|| forbidden_error("Access denied to this vault"))
}

fn assert_item_write_access(role: &str, message: &str) -> Result<(), VaultRpcError> {
	if role == "read-only" {
		Err(forbidden_error(message))
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
) -> Result<(), VaultRpcError> {
	let query_text = format!(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, created_at) VALUES ($1, '{event_type}'::sync_event_type, $2, 'item'::sync_entity_type, $3, $4, $5, $6, $7)"
	);
	query(&query_text)
		.bind(generate_resource_id("sync"))
		.bind(item_id)
		.bind(vault_id)
		.bind(user_id)
		.bind(version)
		.bind(client_id)
		.bind(OffsetDateTime::now_utc())
		.execute(&mut **transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to create item sync event"); internal_error("Failed to create item sync event") })?;
	Ok(())
}

async fn insert_item_sync_event_with_metadata(
	transaction: &mut Transaction<'_, Postgres>,
	event_type: &str,
	item_id: &str,
	vault_id: &str,
	user_id: &str,
	client_id: Option<&str>,
	version: i32,
	metadata: serde_json::Value,
) -> Result<(), VaultRpcError> {
	let query_text = format!(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, '{event_type}'::sync_event_type, $2, 'item'::sync_entity_type, $3, $4, $5, $6, $7, $8)"
	);
	query(&query_text)
		.bind(generate_resource_id("sync"))
		.bind(item_id)
		.bind(vault_id)
		.bind(user_id)
		.bind(version)
		.bind(client_id)
		.bind(metadata.to_string())
		.bind(OffsetDateTime::now_utc())
		.execute(&mut **transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to create item sync event"); internal_error("Failed to create item sync event") })?;
	Ok(())
}

async fn insert_item_audit_log(
	pool: &PgPool,
	action: &str,
	item_id: &str,
	user_id: &str,
	metadata: Option<serde_json::Value>,
) -> Result<(), VaultRpcError> {
	if let Some(metadata) = metadata {
		let query_text = format!(
			"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, '{action}', 'item', $3, $4, $5)"
		);
		query(&query_text)
			.bind(generate_resource_id("audit"))
			.bind(user_id)
			.bind(item_id)
			.bind(metadata)
			.bind(OffsetDateTime::now_utc())
			.execute(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to record item audit event"); internal_error("Failed to record item audit event") })?;
	} else {
		let query_text = format!(
			"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, created_at) VALUES ($1, $2, '{action}', 'item', $3, $4)"
		);
		query(&query_text)
			.bind(generate_resource_id("audit"))
			.bind(user_id)
			.bind(item_id)
			.bind(OffsetDateTime::now_utc())
			.execute(pool)
			.await
			.map_err(|e| { tracing::error!(error = %e, "Failed to record item audit event"); internal_error("Failed to record item audit event") })?;
	}
	Ok(())
}

async fn insert_vault_member_sync_event(
	transaction: &mut Transaction<'_, Postgres>,
	event_type: &str,
	entity_id: &str,
	vault_id: &str,
	user_id: &str,
	client_id: Option<&str>,
	metadata: serde_json::Value,
) -> Result<(), VaultRpcError> {
	let query_text = format!(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, '{event_type}'::sync_event_type, $2, 'vault_member'::sync_entity_type, $3, $4, 1, $5, $6, $7)"
	);
	query(&query_text)
		.bind(generate_resource_id("sync"))
		.bind(entity_id)
		.bind(vault_id)
		.bind(user_id)
		.bind(client_id)
		.bind(metadata.to_string())
		.bind(OffsetDateTime::now_utc())
		.execute(&mut **transaction)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to create vault member sync event"); internal_error("Failed to create vault member sync event") })?;
	Ok(())
}

async fn insert_vault_access_revoked_sync_event_with_metadata(
	transaction: &mut Transaction<'_, Postgres>,
	vault_id: &str,
	user_id: &str,
	client_id: Option<&str>,
	version: i32,
	metadata: serde_json::Value,
) -> Result<(), VaultRpcError> {
	query(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, 'vault_access_revoked'::sync_event_type, $2, 'vault'::sync_entity_type, $3, $4, $5, $6, $7, $8)",
	)
	.bind(generate_resource_id("sync"))
	.bind(vault_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(version)
	.bind(client_id)
	.bind(metadata.to_string())
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create vault access revoked sync event"); internal_error("Failed to create vault access revoked sync event") })?;
	Ok(())
}

async fn insert_vault_key_rotated_sync_event(
	transaction: &mut Transaction<'_, Postgres>,
	vault_id: &str,
	user_id: &str,
	client_id: Option<&str>,
	version: i32,
	metadata: serde_json::Value,
) -> Result<(), VaultRpcError> {
	query(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, 'vault_key_rotated'::sync_event_type, $2, 'vault_key'::sync_entity_type, $3, $4, $5, $6, $7, $8)",
	)
	.bind(generate_resource_id("sync"))
	.bind(vault_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(version)
	.bind(client_id)
	.bind(metadata.to_string())
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create vault key rotation sync event"); internal_error("Failed to create vault key rotation sync event") })?;
	Ok(())
}

pub fn create_vault_router() -> Router<AppState> {
	Router::new()
		.handler(list)
		.handler(get)
		.handler(create)
		.handler(update)
		.handler(convertType)
		.handler(delete)
		.handler(listItems)
		.handler(listAllItems)
		.handler(listAllDeletedItems)
		.handler(listDeletedItems)
		.handler(getItem)
		.handler(createItem)
		.handler(bulkImportItems)
		.handler(updateItem)
		.handler(toggleFavorite)
		.handler(deleteItem)
		.handler(restoreItem)
		.handler(moveItem)
		.handler(permanentlyDeleteItem)
		.handler(stats)
		.handler(createImageUpload)
		.handler(createAttachmentUpload)
		.handler(createAttachment)
		.handler(listAttachments)
		.handler(getAttachmentDownloadUrl)
		.handler(updateAttachment)
		.handler(deleteAttachment)
		.nest("members", create_vault_members_router())
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

fn db_pool(app_state: &AppState) -> Result<&PgPool, VaultRpcError> {
	app_state
		.db_pool
		.as_ref()
		.ok_or_else(|| internal_error("Database is not configured"))
}

async fn load_user_vault_summaries(
	pool: &PgPool,
	user_id: &str,
) -> Result<Vec<DbBootstrapVaultAccessRow>, VaultRpcError> {
	query_as::<_, DbBootstrapVaultAccessRow>(
		"SELECT vk.vault_id, v.name AS vault_name, v.type::text AS vault_type, v.icon AS vault_icon, v.image_key AS vault_image_key, vk.encrypted_vault_key, vk.role::text AS role FROM vault_key vk INNER JOIN vault v ON vk.vault_id = v.id WHERE vk.user_id = $1 ORDER BY vk.created_at ASC",
	)
	.bind(user_id)
	.fetch_all(pool)
	.await
	.map_err(|_| internal_error("Failed to load user vaults"))
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
) -> Result<HashMap<String, Vec<VaultAttachmentResponse>>, VaultRpcError> {
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to load item attachments"); internal_error("Failed to load item attachments") })?;

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

async fn attachments_enabled_for_user(
	pool: &PgPool,
	user_id: &str,
) -> Result<bool, VaultRpcError> {
	let actor = query_as::<_, DbTeamBillingEntitlementRow>(
		"SELECT u.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load attachment entitlements"); internal_error("Failed to load attachment entitlements") })?;
	if bittery_mode() == "self-hosted" {
		return Ok(true);
	}
	let Some(actor) = actor else {
		return Ok(false);
	};
	let Some(_team_id) = actor.team_id else {
		return Ok(false);
	};
	let Some(plan) = actor.billing_plan.as_deref() else {
		return Ok(false);
	};
	let Some(status) = actor.billing_status.as_deref() else {
		return Ok(false);
	};
	Ok(matches!(plan, "personal" | "family" | "team") && matches!(status, "active" | "trialing"))
}

async fn load_attachment_actor(
	pool: &PgPool,
	user_id: &str,
) -> Result<AttachmentActor, VaultRpcError> {
	let actor = query_as::<_, DbTeamBillingEntitlementRow>(
		"SELECT u.team_id, t.billing_plan::text AS billing_plan, t.billing_status::text AS billing_status FROM \"user\" u LEFT JOIN team t ON u.team_id = t.id WHERE u.id = $1 LIMIT 1",
	)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load attachment entitlements"); internal_error("Failed to load attachment entitlements") })?;
	let mode = bittery_mode();
	let Some(actor) = actor else {
		if mode == "self-hosted" {
			return Ok(AttachmentActor {
				team_id: format!("self-hosted:{user_id}"),
				attachment_max_file_size_bytes: None,
				attachment_storage_bytes: None,
			});
		}
		return Err(forbidden_error(
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
		return Err(forbidden_error(
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
	let plan = actor.billing_plan.unwrap_or_else(|| "free".to_string());
	let status = actor.billing_status.unwrap_or_else(|| "none".to_string());
	let active = matches!(status.as_str(), "active" | "trialing");
	let (max_file_size, storage_quota) = if active {
		match plan.as_str() {
			"personal" => (Some(10 * 1024 * 1024), Some(250 * 1024 * 1024)),
			"family" => (Some(25 * 1024 * 1024), Some(1024 * 1024 * 1024)),
			"team" => (Some(50 * 1024 * 1024), Some(2 * 1024 * 1024 * 1024)),
			_ => (Some(0), Some(0)),
		}
	} else {
		(Some(0), Some(0))
	};
	if max_file_size == Some(0) || storage_quota == Some(0) {
		return Err(forbidden_error(
			"Attachments are only available on paid plans with active billing.",
		));
	}
	Ok(AttachmentActor {
		team_id,
		attachment_max_file_size_bytes: max_file_size.map(i64::from),
		attachment_storage_bytes: storage_quota.map(i64::from),
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
) -> Result<Option<DbPendingAttachmentReservationRow>, VaultRpcError> {
	query_as::<_, DbPendingAttachmentReservationRow>(
		"SELECT id, file_size, storage_size FROM pending_attachment_upload WHERE storage_key = $1 AND item_id = $2 AND created_by = $3 AND consumed_at IS NULL AND expires_at > $4 LIMIT 1",
	)
	.bind(storage_key)
	.bind(item_id)
	.bind(created_by)
	.bind(OffsetDateTime::now_utc())
	.fetch_optional(pool)
	.await
	.map_err(|_| internal_error("Failed to load attachment reservation"))
}

async fn load_attachment_access(
	pool: &PgPool,
	attachment_id: &str,
	user_id: &str,
) -> Result<DbScopedAttachmentAccessRow, VaultRpcError> {
	query_as::<_, DbScopedAttachmentAccessRow>(
		"SELECT ia.id, ia.item_id, ia.vault_id, ia.storage_key, ia.encrypted_name, ia.encrypted_content_type, ia.encryption_iv, ia.encrypted_content_type_iv, ia.encryption_algorithm, ia.file_size, ia.uploaded_by, ia.created_at, vk.role::text AS role FROM item_attachment ia INNER JOIN vault_key vk ON vk.vault_id = ia.vault_id AND vk.user_id = $2 WHERE ia.id = $1 LIMIT 1",
	)
	.bind(attachment_id)
	.bind(user_id)
	.fetch_optional(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to load attachment"); internal_error("Failed to load attachment") })?
	.ok_or_else(|| not_found_error("Attachment not found"))
}

async fn insert_vault(
	transaction: &mut Transaction<'_, Postgres>,
	vault_id: &str,
	user_id: &str,
	team_id: Option<&str>,
	input: &CreateVaultInput,
) -> Result<(), VaultRpcError> {
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to create vault"); internal_error("Failed to create vault") })?;
	Ok(())
}

async fn insert_vault_key(
	transaction: &mut Transaction<'_, Postgres>,
	vault_id: &str,
	user_id: &str,
	encrypted_vault_key: &str,
) -> Result<(), VaultRpcError> {
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
	.map_err(|e| { tracing::error!(error = %e, "Failed to create vault key"); internal_error("Failed to create vault key") })?;
	Ok(())
}

async fn insert_vault_created_sync_event(
	transaction: &mut Transaction<'_, Postgres>,
	vault_id: &str,
	user_id: &str,
	client_id: Option<&str>,
) -> Result<(), VaultRpcError> {
	query(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, created_at) VALUES ($1, 'vault_created'::sync_event_type, $2, 'vault'::sync_entity_type, $3, $4, 1, $5, $6)",
	)
	.bind(generate_resource_id("sync"))
	.bind(vault_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(client_id)
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create sync event"); internal_error("Failed to create sync event") })?;
	Ok(())
}

async fn insert_vault_created_audit_log(
	pool: &PgPool,
	vault_id: &str,
	user_id: &str,
) -> Result<(), VaultRpcError> {
	query(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, created_at) VALUES ($1, $2, 'vault_created', 'vault', $3, $4)",
	)
	.bind(generate_resource_id("audit"))
	.bind(user_id)
	.bind(vault_id)
	.bind(OffsetDateTime::now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record vault audit event"); internal_error("Failed to record vault audit event") })?;
	Ok(())
}

async fn insert_vault_updated_sync_event(
	transaction: &mut Transaction<'_, Postgres>,
	vault_id: &str,
	user_id: &str,
	client_id: Option<&str>,
) -> Result<(), VaultRpcError> {
	query(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, created_at) VALUES ($1, 'vault_updated'::sync_event_type, $2, 'vault'::sync_entity_type, $3, $4, 1, $5, $6)",
	)
	.bind(generate_resource_id("sync"))
	.bind(vault_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(client_id)
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create vault update sync event"); internal_error("Failed to create vault update sync event") })?;
	Ok(())
}

async fn insert_vault_updated_sync_event_with_metadata(
	transaction: &mut Transaction<'_, Postgres>,
	vault_id: &str,
	user_id: &str,
	client_id: Option<&str>,
	metadata: serde_json::Value,
) -> Result<(), VaultRpcError> {
	query(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, 'vault_updated'::sync_event_type, $2, 'vault'::sync_entity_type, $3, $4, 1, $5, $6, $7)",
	)
	.bind(generate_resource_id("sync"))
	.bind(vault_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(client_id)
	.bind(metadata.to_string())
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create vault update sync event"); internal_error("Failed to create vault update sync event") })?;
	Ok(())
}

async fn insert_vault_updated_audit_log(
	pool: &PgPool,
	vault_id: &str,
	user_id: &str,
) -> Result<(), VaultRpcError> {
	query(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, created_at) VALUES ($1, $2, 'vault_updated', 'vault', $3, $4)",
	)
	.bind(generate_resource_id("audit"))
	.bind(user_id)
	.bind(vault_id)
	.bind(OffsetDateTime::now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record vault update audit event"); internal_error("Failed to record vault update audit event") })?;
	Ok(())
}

async fn insert_vault_audit_log_with_metadata(
	pool: &PgPool,
	action: &str,
	vault_id: &str,
	user_id: &str,
	metadata: serde_json::Value,
) -> Result<(), VaultRpcError> {
	let query_text = format!(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata, created_at) VALUES ($1, $2, '{action}', 'vault', $3, $4, $5)"
	);
	query(&query_text)
		.bind(generate_resource_id("audit"))
		.bind(user_id)
		.bind(vault_id)
		.bind(metadata)
		.bind(OffsetDateTime::now_utc())
		.execute(pool)
		.await
		.map_err(|e| { tracing::error!(error = %e, "Failed to record vault audit event"); internal_error("Failed to record vault audit event") })?;
	Ok(())
}

async fn insert_vault_deleted_sync_event(
	transaction: &mut Transaction<'_, Postgres>,
	vault_id: &str,
	user_id: &str,
	client_id: Option<&str>,
) -> Result<(), VaultRpcError> {
	query(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, created_at) VALUES ($1, 'vault_deleted'::sync_event_type, $2, 'vault'::sync_entity_type, $3, $4, 1, $5, $6)",
	)
	.bind(generate_resource_id("sync"))
	.bind(vault_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(client_id)
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create vault delete sync event"); internal_error("Failed to create vault delete sync event") })?;
	Ok(())
}

async fn insert_vault_access_revoked_sync_event(
	transaction: &mut Transaction<'_, Postgres>,
	vault_id: &str,
	user_id: &str,
	client_id: Option<&str>,
) -> Result<(), VaultRpcError> {
	query(
		"INSERT INTO sync_event (id, event_type, entity_id, entity_type, vault_id, user_id, version, client_id, metadata, created_at) VALUES ($1, 'vault_access_revoked'::sync_event_type, $2, 'vault'::sync_entity_type, $3, $4, 1, $5, $6, $7)",
	)
	.bind(generate_resource_id("sync"))
	.bind(vault_id)
	.bind(vault_id)
	.bind(user_id)
	.bind(client_id)
	.bind(json!({ "reason": "vault_deleted", "vaultId": vault_id }).to_string())
	.bind(OffsetDateTime::now_utc())
	.execute(&mut **transaction)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to create vault access revoked sync event"); internal_error("Failed to create vault access revoked sync event") })?;
	Ok(())
}

async fn insert_vault_deleted_audit_log(
	pool: &PgPool,
	vault_id: &str,
	user_id: &str,
) -> Result<(), VaultRpcError> {
	query(
		"INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, created_at) VALUES ($1, $2, 'vault_deleted', 'vault', $3, $4)",
	)
	.bind(generate_resource_id("audit"))
	.bind(user_id)
	.bind(vault_id)
	.bind(OffsetDateTime::now_utc())
	.execute(pool)
	.await
	.map_err(|e| { tracing::error!(error = %e, "Failed to record vault delete audit event"); internal_error("Failed to record vault delete audit event") })?;
	Ok(())
}

fn resolve_vault_sharing_entitlement(plan: &str, status: &str) -> VaultSharingEntitlement {
	if bittery_mode() == "self-hosted" {
		return VaultSharingEntitlement {
			allowed: true,
			shared_vault_limit: None,
		};
	}
	let active = matches!(status, "active" | "trialing");
	match plan {
		"family" if active => VaultSharingEntitlement {
			allowed: true,
			shared_vault_limit: Some(5),
		},
		"team" if active => VaultSharingEntitlement {
			allowed: true,
			shared_vault_limit: None,
		},
		_ => VaultSharingEntitlement {
			allowed: false,
			shared_vault_limit: Some(0),
		},
	}
}

fn bittery_mode() -> &'static str {
	match std::env::var("BITTERY_MODE") {
		Ok(value) => {
			let normalized = value.trim().to_ascii_lowercase();
			if normalized == "self-hosted"
				|| normalized == "self_hosted"
				|| normalized == "selfhosted"
			{
				"self-hosted"
			} else {
				"cloud"
			}
		}
		Err(_) => "cloud",
	}
}

fn generate_resource_id(prefix: &str) -> String {
	format!("{prefix}_{:016x}", random::<u64>())
}

struct VaultSharingEntitlement {
	allowed: bool,
	shared_vault_limit: Option<i64>,
}

fn format_timestamp(value: OffsetDateTime) -> String {
	value
		.format(&time::format_description::well_known::Rfc3339)
		.unwrap_or_else(|_| value.unix_timestamp().to_string())
}

fn internal_error(message: &str) -> VaultRpcError {
	VaultRpcError {
		code: "INTERNAL_SERVER_ERROR".to_string(),
		message: message.to_string(),
	}
}

fn bad_request_error(message: &str) -> VaultRpcError {
	VaultRpcError {
		code: "BAD_REQUEST".to_string(),
		message: message.to_string(),
	}
}

fn forbidden_error(message: &str) -> VaultRpcError {
	VaultRpcError {
		code: "FORBIDDEN".to_string(),
		message: message.to_string(),
	}
}

fn not_found_error(message: &str) -> VaultRpcError {
	VaultRpcError {
		code: "NOT_FOUND".to_string(),
		message: message.to_string(),
	}
}

fn conflict_error(message: &str) -> VaultRpcError {
	VaultRpcError {
		code: "CONFLICT".to_string(),
		message: message.to_string(),
	}
}

impl IntoResponse for VaultRpcError {
	type Output = <RpcError as IntoResponse>::Output;

	fn into_response(self) -> jsonrpsee::ResponsePayload<'static, Self::Output> {
		RpcError::from(self).into_response()
	}
}

impl From<VaultRpcError> for RpcError {
	fn from(value: VaultRpcError) -> Self {
		let code = match value.code.as_str() {
			"NOT_FOUND" => ErrorCode::ServerError(404),
			"FORBIDDEN" => ErrorCode::ServerError(403),
			"CONFLICT" => ErrorCode::ServerError(409),
			"BAD_REQUEST" => ErrorCode::InvalidParams,
			_ => ErrorCode::InternalError,
		};

		RpcError {
			code,
			message: value.message,
			data: None,
		}
	}
}