use axum::{
    body::to_bytes,
    extract::{DefaultBodyLimit, FromRequest, Path, State},
    http::{
        header::{CONTENT_TYPE, ETAG},
        HeaderMap, HeaderValue, Request, StatusCode,
    },
    response::{IntoResponse, Response},
    Json,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use utoipa::{IntoParams, IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    config::db_pool,
    error::{AppError, AppErrorCode},
    integrations::storage::PresignedUploadResult,
    services::vault,
    AppState, NotifySyncExt,
};

use super::{
    dto::{
        CursorPage, DecimalString, PageCursor, PageRequest, PatchField, ProblemDetails,
        BULK_IMPORT_BYTES, BULK_IMPORT_ITEMS, DEFAULT_PAGE_SIZE, ITEM_CIPHERTEXT_BYTES,
    },
    error::ApiError,
    extract::{ApiMergePatch, ApiQuery, AuthenticatedRequest},
    idempotency,
    pagination::{
        decode_page_key, page_prefetched, page_prefetched_with_more, page_values, query_limit,
        timestamp_cursor_key, ApiPageQuery,
    },
    ORDINARY_API_BODY_LIMIT_BYTES,
};

const ITEM_BODY_LIMIT_BYTES: usize = ITEM_CIPHERTEXT_BYTES as usize + 64 * 1024;

struct ApiJson<T>(T);

#[derive(Debug)]
struct ApiJsonBytes<T> {
    value: T,
    bytes: Vec<u8>,
}

#[derive(Debug)]
struct ApiMergePatchBytes<T> {
    value: T,
    bytes: Vec<u8>,
}

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
    Json<T>: FromRequest<S, Rejection = axum::extract::rejection::JsonRejection>,
{
    type Rejection = ApiError;

    async fn from_request(
        request: Request<axum::body::Body>,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(|error| match error.status() {
                StatusCode::UNSUPPORTED_MEDIA_TYPE => {
                    ApiError::unsupported_media_type(error.body_text())
                }
                StatusCode::PAYLOAD_TOO_LARGE => {
                    ApiError::payload_too_large("The request body exceeds this route's byte limit.")
                }
                _ => ApiError::bad_request("INVALID_JSON", error.body_text()),
            })
    }
}

impl<S, T> FromRequest<S> for ApiJsonBytes<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(
        request: Request<axum::body::Body>,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        let content_type = request
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim);
        if !matches!(content_type, Some("application/json"))
            && !content_type.is_some_and(|value| value.ends_with("+json"))
        {
            return Err(ApiError::unsupported_media_type(
                "Expected a JSON request content type.",
            ));
        }
        let bytes = to_bytes(request.into_body(), ITEM_BODY_LIMIT_BYTES)
            .await
            .map_err(|_| {
                ApiError::payload_too_large("The request body exceeds this route's byte limit.")
            })?;
        let Json(value) = Json::<T>::from_bytes(&bytes)
            .map_err(|error| ApiError::bad_request("INVALID_JSON", error.body_text()))?;
        Ok(Self {
            value,
            bytes: bytes.to_vec(),
        })
    }
}

impl<S, T> FromRequest<S> for ApiMergePatchBytes<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(
        request: Request<axum::body::Body>,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        let content_type = request
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim);
        if content_type != Some("application/merge-patch+json") {
            return Err(ApiError::unsupported_media_type(
                "Expected application/merge-patch+json.",
            ));
        }
        let bytes = to_bytes(request.into_body(), ITEM_BODY_LIMIT_BYTES)
            .await
            .map_err(|_| {
                ApiError::payload_too_large("The request body exceeds this route's byte limit.")
            })?;
        let Json(value) = Json::<T>::from_bytes(&bytes)
            .map_err(|error| ApiError::bad_request("INVALID_JSON", error.body_text()))?;
        Ok(Self {
            value,
            bytes: bytes.to_vec(),
        })
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateVaultBody {
    name: String,
    vault_type: String,
    encrypted_vault_key: String,
    icon: Option<String>,
    image_key: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateVaultBody {
    #[serde(default)]
    #[schema(value_type = Option<String>, nullable = true)]
    name: PatchField<String>,
    #[serde(default)]
    #[schema(value_type = Option<String>, nullable = true)]
    icon: PatchField<String>,
    #[serde(default)]
    #[schema(value_type = Option<String>, nullable = true)]
    image_key: PatchField<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConvertVaultBody {
    target_type: String,
    personal_encrypted_vault_key: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageUploadBody {
    file_name: String,
    content_type: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateItemBody {
    category: String,
    #[schema(max_length = 1048576)]
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BulkImportBody {
    #[schema(max_items = 200)]
    items: Vec<BulkImportItemInput>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BulkImportItemInput {
    item_id: String,
    category: String,
    favorite: Option<bool>,
    #[schema(max_length = 1048576)]
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: Option<String>,
}

impl From<BulkImportItemInput> for vault::BulkImportItemInput {
    fn from(value: BulkImportItemInput) -> Self {
        Self {
            item_id: value.item_id,
            category: value.category,
            favorite: value.favorite,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
            encryption_algorithm: value.encryption_algorithm,
        }
    }
}

#[derive(Debug, Deserialize, IntoParams, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[into_params(parameter_in = Query, rename_all = "camelCase")]
struct AllItemsQuery {
    state: Option<String>,
    cursor: Option<PageCursor>,
    #[serde(default = "default_page_limit")]
    #[schema(minimum = 1, maximum = 500, default = 100)]
    limit: u16,
}

fn default_page_limit() -> u16 {
    DEFAULT_PAGE_SIZE
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct AllItemsResponse {
    #[schema(max_items = 500)]
    items: Vec<AllItemResponse>,
    next_cursor: Option<PageCursor>,
    has_more: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct AllItemResponse {
    id: String,
    vault_id: String,
    category: String,
    favorite: bool,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
    version: i32,
    last_modified_by: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachments: Option<Vec<VaultAttachmentResponse>>,
    vault: Option<VaultSummaryResponse>,
}

impl From<CursorPage<vault::VaultItemWithVaultResponse>> for AllItemsResponse {
    fn from(page: CursorPage<vault::VaultItemWithVaultResponse>) -> Self {
        Self {
            items: page.items.into_iter().map(AllItemResponse::from).collect(),
            next_cursor: page.next_cursor,
            has_more: page.has_more,
        }
    }
}

impl From<CursorPage<vault::DeletedVaultItemWithVaultResponse>> for AllItemsResponse {
    fn from(page: CursorPage<vault::DeletedVaultItemWithVaultResponse>) -> Self {
        Self {
            items: page.items.into_iter().map(AllItemResponse::from).collect(),
            next_cursor: page.next_cursor,
            has_more: page.has_more,
        }
    }
}

impl From<vault::VaultItemWithVaultResponse> for AllItemResponse {
    fn from(value: vault::VaultItemWithVaultResponse) -> Self {
        Self {
            id: value.id,
            vault_id: value.vault_id,
            category: value.category,
            favorite: value.favorite,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
            encryption_algorithm: value.encryption_algorithm,
            version: value.version,
            last_modified_by: value.last_modified_by,
            created_at: value.created_at,
            updated_at: value.updated_at,
            deleted_at: value.deleted_at,
            attachments: Some(value.attachments.into_iter().map(Into::into).collect()),
            vault: value.vault.map(Into::into),
        }
    }
}

impl From<vault::DeletedVaultItemWithVaultResponse> for AllItemResponse {
    fn from(value: vault::DeletedVaultItemWithVaultResponse) -> Self {
        Self {
            id: value.id,
            vault_id: value.vault_id,
            category: value.category,
            favorite: value.favorite,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
            encryption_algorithm: value.encryption_algorithm,
            version: value.version,
            last_modified_by: value.last_modified_by,
            created_at: value.created_at,
            updated_at: value.updated_at,
            deleted_at: value.deleted_at,
            attachments: None,
            vault: value.vault.map(Into::into),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateItemBody {
    #[serde(default)]
    #[schema(value_type = Option<String>, nullable = true, max_length = 1048576)]
    encrypted_data: PatchField<String>,
    #[serde(default)]
    #[schema(value_type = Option<String>, nullable = true)]
    encryption_iv: PatchField<String>,
    #[serde(default)]
    #[schema(value_type = Option<String>, nullable = true)]
    encryption_algorithm: PatchField<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FavoriteBody {
    favorite: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveItemBody {
    source_vault_id: String,
    target_vault_id: String,
    #[schema(max_length = 1048576)]
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentUploadBody {
    file_name: String,
    content_type: String,
    file_size: i32,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateAttachmentBody {
    storage_key: String,
    encrypted_name: String,
    encrypted_content_type: String,
    encryption_iv: String,
    encrypted_content_type_iv: String,
    encryption_algorithm: Option<String>,
    file_size: i32,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateAttachmentBody {
    encrypted_name: String,
    encryption_iv: String,
    encryption_algorithm: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddVaultMemberBody {
    role: String,
    encrypted_vault_key: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateVaultMemberRoleBody {
    role: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveVaultMemberBody {
    key_rotation: VaultKeyRotationInput,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RotationMemberKeyInput {
    user_id: String,
    encrypted_vault_key: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RotationReEncryptedItemInput {
    item_id: String,
    encrypted_data: String,
    encryption_iv: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultKeyRotationInput {
    #[schema(max_items = 100)]
    member_keys: Vec<RotationMemberKeyInput>,
    #[schema(max_items = 100)]
    re_encrypted_items: Vec<RotationReEncryptedItemInput>,
}

impl From<VaultKeyRotationInput> for vault::VaultKeyRotationInput {
    fn from(value: VaultKeyRotationInput) -> Self {
        Self {
            member_keys: value
                .member_keys
                .into_iter()
                .map(|key| vault::RotationMemberKeyInput {
                    user_id: key.user_id,
                    encrypted_vault_key: key.encrypted_vault_key,
                })
                .collect(),
            re_encrypted_items: value
                .re_encrypted_items
                .into_iter()
                .map(|item| vault::RotationReEncryptedItemInput {
                    item_id: item.item_id,
                    encrypted_data: item.encrypted_data,
                    encryption_iv: item.encryption_iv,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct SuccessResponse {
    success: bool,
}

impl From<vault::SuccessResponse> for SuccessResponse {
    fn from(value: vault::SuccessResponse) -> Self {
        Self {
            success: value.success,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateVaultResponse {
    vault_id: String,
}

impl From<vault::CreateVaultResponse> for CreateVaultResponse {
    fn from(value: vault::CreateVaultResponse) -> Self {
        Self {
            vault_id: value.vault_id,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct UpdateVaultResponse {
    id: String,
    name: String,
    icon: Option<String>,
    image_url: Option<String>,
}

impl From<vault::UpdateVaultResponse> for UpdateVaultResponse {
    fn from(value: vault::UpdateVaultResponse) -> Self {
        Self {
            id: value.id,
            name: value.name,
            icon: value.icon,
            image_url: value.image_url,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct ConvertVaultTypeResponse {
    success: bool,
    vault_id: String,
    previous_type: String,
    new_type: String,
}

impl From<vault::ConvertVaultTypeResponse> for ConvertVaultTypeResponse {
    fn from(value: vault::ConvertVaultTypeResponse) -> Self {
        Self {
            success: value.success,
            vault_id: value.vault_id,
            previous_type: value.previous_type,
            new_type: value.new_type,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateItemResponse {
    item_id: String,
    id: String,
}

impl From<vault::CreateItemResponse> for CreateItemResponse {
    fn from(value: vault::CreateItemResponse) -> Self {
        Self {
            item_id: value.item_id,
            id: value.id,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct BulkImportItemsResponse {
    success: bool,
    imported_count: usize,
    item_ids: Vec<String>,
}

impl From<vault::BulkImportItemsResponse> for BulkImportItemsResponse {
    fn from(value: vault::BulkImportItemsResponse) -> Self {
        Self {
            success: value.success,
            imported_count: value.imported_count,
            item_ids: value.item_ids,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct UpdateItemResponse {
    success: bool,
    version: i32,
}

impl From<vault::UpdateItemResponse> for UpdateItemResponse {
    fn from(value: vault::UpdateItemResponse) -> Self {
        Self {
            success: value.success,
            version: value.version,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct CreateAttachmentResponse {
    attachment_id: String,
}

impl From<vault::CreateAttachmentResponse> for CreateAttachmentResponse {
    fn from(value: vault::CreateAttachmentResponse) -> Self {
        Self {
            attachment_id: value.attachment_id,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultListEntryResponse {
    id: String,
    name: String,
    vault_type: String,
    icon: Option<String>,
    image_url: Option<String>,
    role: String,
    #[schema(pattern = r"^(0|[1-9][0-9]*)$")]
    item_count: String,
    encrypted_vault_key: String,
    created_by_id: String,
}

impl From<vault::VaultListEntryResponse> for VaultListEntryResponse {
    fn from(value: vault::VaultListEntryResponse) -> Self {
        Self {
            id: value.id,
            name: value.name,
            vault_type: value.vault_type,
            icon: value.icon,
            image_url: value.image_url,
            role: value.role,
            item_count: value.item_count,
            encrypted_vault_key: value.encrypted_vault_key,
            created_by_id: value.created_by_id,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultAttachmentResponse {
    id: String,
    item_id: String,
    vault_id: String,
    storage_key: String,
    encrypted_name: String,
    encrypted_content_type: String,
    encryption_iv: String,
    encrypted_content_type_iv: Option<String>,
    encryption_algorithm: String,
    file_size: i32,
    uploaded_by: Option<String>,
    created_at: String,
}

impl From<vault::VaultAttachmentResponse> for VaultAttachmentResponse {
    fn from(value: vault::VaultAttachmentResponse) -> Self {
        Self {
            id: value.id,
            item_id: value.item_id,
            vault_id: value.vault_id,
            storage_key: value.storage_key,
            encrypted_name: value.encrypted_name,
            encrypted_content_type: value.encrypted_content_type,
            encryption_iv: value.encryption_iv,
            encrypted_content_type_iv: value.encrypted_content_type_iv,
            encryption_algorithm: value.encryption_algorithm,
            file_size: value.file_size,
            uploaded_by: value.uploaded_by,
            created_at: value.created_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultSummaryResponse {
    id: String,
    name: String,
    vault_type: String,
    icon: Option<String>,
    image_url: Option<String>,
    encrypted_vault_key: String,
    role: String,
}

impl From<vault::VaultSummaryResponse> for VaultSummaryResponse {
    fn from(value: vault::VaultSummaryResponse) -> Self {
        Self {
            id: value.id,
            name: value.name,
            vault_type: value.vault_type,
            icon: value.icon,
            image_url: value.image_url,
            encrypted_vault_key: value.encrypted_vault_key,
            role: value.role,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultItemResponse {
    id: String,
    vault_id: String,
    category: String,
    favorite: bool,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
    version: i32,
    last_modified_by: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
}

impl From<vault::VaultItemResponse> for VaultItemResponse {
    fn from(value: vault::VaultItemResponse) -> Self {
        Self {
            id: value.id,
            vault_id: value.vault_id,
            category: value.category,
            favorite: value.favorite,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
            encryption_algorithm: value.encryption_algorithm,
            version: value.version,
            last_modified_by: value.last_modified_by,
            created_at: value.created_at,
            updated_at: value.updated_at,
            deleted_at: value.deleted_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultItemDetailsResponse {
    id: String,
    vault_id: String,
    category: String,
    favorite: bool,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
    version: i32,
    last_modified_by: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    attachments: Vec<VaultAttachmentResponse>,
}

impl From<vault::VaultItemDetailsResponse> for VaultItemDetailsResponse {
    fn from(value: vault::VaultItemDetailsResponse) -> Self {
        Self {
            id: value.id,
            vault_id: value.vault_id,
            category: value.category,
            favorite: value.favorite,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
            encryption_algorithm: value.encryption_algorithm,
            version: value.version,
            last_modified_by: value.last_modified_by,
            created_at: value.created_at,
            updated_at: value.updated_at,
            deleted_at: value.deleted_at,
            attachments: value.attachments.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct DeletedVaultItemWithVaultResponse {
    id: String,
    vault_id: String,
    category: String,
    favorite: bool,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
    version: i32,
    last_modified_by: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    vault: Option<VaultSummaryResponse>,
}

impl From<vault::DeletedVaultItemWithVaultResponse> for DeletedVaultItemWithVaultResponse {
    fn from(value: vault::DeletedVaultItemWithVaultResponse) -> Self {
        Self {
            id: value.id,
            vault_id: value.vault_id,
            category: value.category,
            favorite: value.favorite,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
            encryption_algorithm: value.encryption_algorithm,
            version: value.version,
            last_modified_by: value.last_modified_by,
            created_at: value.created_at,
            updated_at: value.updated_at,
            deleted_at: value.deleted_at,
            vault: value.vault.map(Into::into),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultMemberResponse {
    user_id: String,
    name: String,
    email: String,
    role: String,
}

impl From<vault::VaultMemberResponse> for VaultMemberResponse {
    fn from(value: vault::VaultMemberResponse) -> Self {
        Self {
            user_id: value.user_id,
            name: value.name,
            email: value.email,
            role: value.role,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultAvailableMemberResponse {
    user_id: String,
    name: String,
    email: String,
    public_key: String,
}

impl From<vault::VaultAvailableMemberResponse> for VaultAvailableMemberResponse {
    fn from(value: vault::VaultAvailableMemberResponse) -> Self {
        Self {
            user_id: value.user_id,
            name: value.name,
            email: value.email,
            public_key: value.public_key,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultRotationMemberResponse {
    user_id: String,
    public_key: String,
    role: String,
}

impl From<vault::VaultRotationMemberResponse> for VaultRotationMemberResponse {
    fn from(value: vault::VaultRotationMemberResponse) -> Self {
        Self {
            user_id: value.user_id,
            public_key: value.public_key,
            role: value.role,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultRotationItemResponse {
    id: String,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
    version: i32,
    last_modified_by: Option<String>,
}

impl From<vault::VaultRotationItemResponse> for VaultRotationItemResponse {
    fn from(value: vault::VaultRotationItemResponse) -> Self {
        Self {
            id: value.id,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
            encryption_algorithm: value.encryption_algorithm,
            version: value.version,
            last_modified_by: value.last_modified_by,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultRotationDataResponse {
    key_version: i32,
    members: Vec<VaultRotationMemberResponse>,
    items: Vec<VaultRotationItemResponse>,
}

impl From<vault::VaultRotationDataResponse> for VaultRotationDataResponse {
    fn from(value: vault::VaultRotationDataResponse) -> Self {
        Self {
            key_version: value.key_version,
            members: value.members.into_iter().map(Into::into).collect(),
            items: value.items.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultKeyRotationSummaryResponse {
    id: String,
    new_key_version: i32,
    items_re_encrypted: usize,
    members_updated: usize,
}

impl From<vault::VaultKeyRotationSummaryResponse> for VaultKeyRotationSummaryResponse {
    fn from(value: vault::VaultKeyRotationSummaryResponse) -> Self {
        Self {
            id: value.id,
            new_key_version: value.new_key_version,
            items_re_encrypted: value.items_re_encrypted,
            members_updated: value.members_updated,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct RemoveVaultMemberResponse {
    success: bool,
    key_rotation: VaultKeyRotationSummaryResponse,
}

impl From<vault::RemoveVaultMemberResponse> for RemoveVaultMemberResponse {
    fn from(value: vault::RemoveVaultMemberResponse) -> Self {
        Self {
            success: value.success,
            key_rotation: value.key_rotation.into(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct AttachmentDownloadResponse {
    download_url: String,
    encrypted_name: String,
    encrypted_content_type: String,
    encryption_iv: String,
    encrypted_content_type_iv: String,
    encryption_algorithm: String,
    file_size: i32,
}

impl From<vault::AttachmentDownloadResponse> for AttachmentDownloadResponse {
    fn from(value: vault::AttachmentDownloadResponse) -> Self {
        Self {
            download_url: value.download_url,
            encrypted_name: value.encrypted_name,
            encrypted_content_type: value.encrypted_content_type,
            encryption_iv: value.encryption_iv,
            encrypted_content_type_iv: value.encrypted_content_type_iv,
            encryption_algorithm: value.encryption_algorithm,
            file_size: value.file_size,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct PresignedUploadResponse {
    key: String,
    upload_url: String,
    public_url: Option<String>,
}

impl From<PresignedUploadResult> for PresignedUploadResponse {
    fn from(value: PresignedUploadResult) -> Self {
        Self {
            key: value.key,
            upload_url: value.upload_url,
            public_url: value.public_url,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultDetailsResponseDto {
    id: String,
    name: String,
    vault_type: String,
    icon: Option<String>,
    image_url: Option<String>,
    user_role: String,
    item_count: DecimalString,
    member_count: DecimalString,
    created_at: String,
}

impl From<vault::VaultDetailsResponse> for VaultDetailsResponseDto {
    fn from(value: vault::VaultDetailsResponse) -> Self {
        Self {
            id: value.id,
            name: value.name,
            vault_type: value.vault_type,
            icon: value.icon,
            image_url: value.image_url,
            user_role: value.user_role,
            item_count: value.item_count.into(),
            member_count: value.member_count.into(),
            created_at: value.created_at,
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultStatsResponseDto {
    team_count: i32,
    vault_count: DecimalString,
    item_count: DecimalString,
}

impl From<vault::VaultStatsResponse> for VaultStatsResponseDto {
    fn from(value: vault::VaultStatsResponse) -> Self {
        Self {
            team_count: value.team_count,
            vault_count: value.vault_count.into(),
            item_count: value.item_count.into(),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct ItemResponseDto {
    id: String,
    vault_id: String,
    category: String,
    favorite: bool,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
    version: i32,
    last_modified_by: Option<String>,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
}

impl From<vault::VaultItemDetailsResponse> for ItemResponseDto {
    fn from(value: vault::VaultItemDetailsResponse) -> Self {
        Self {
            id: value.id,
            vault_id: value.vault_id,
            category: value.category,
            favorite: value.favorite,
            encrypted_data: value.encrypted_data,
            encryption_iv: value.encryption_iv,
            encryption_algorithm: value.encryption_algorithm,
            version: value.version,
            last_modified_by: value.last_modified_by,
            created_at: value.created_at,
            updated_at: value.updated_at,
            deleted_at: value.deleted_at,
        }
    }
}

fn request_client_id(auth: &AuthenticatedRequest) -> Option<String> {
    auth.metadata
        .client_id
        .clone()
        .or_else(|| auth.session.client_id.clone())
}

fn check_ciphertext(value: &str) -> Result<(), ApiError> {
    if value.len() > ITEM_CIPHERTEXT_BYTES as usize {
        Err(ApiError::payload_too_large(format!(
            "Item ciphertext cannot exceed {ITEM_CIPHERTEXT_BYTES} bytes."
        )))
    } else {
        Ok(())
    }
}

fn check_bulk_import(body: &BulkImportBody) -> Result<(), ApiError> {
    if body.items.len() > BULK_IMPORT_ITEMS as usize {
        return Err(ApiError::payload_too_large(format!(
            "Bulk imports cannot contain more than {BULK_IMPORT_ITEMS} items."
        )));
    }
    for item in &body.items {
        check_ciphertext(&item.encrypted_data)?;
    }
    Ok(())
}

fn optional_patch_value(
    field: PatchField<String>,
    pointer: &str,
) -> Result<Option<String>, ApiError> {
    match field {
        PatchField::Missing => Ok(None),
        PatchField::Value(value) => Ok(Some(value)),
        PatchField::Null => Err(ApiError::bad_request(
            "FIELD_CANNOT_BE_CLEARED",
            format!("{pointer} cannot be null."),
        )),
    }
}

fn nullable_patch_value(field: PatchField<String>) -> Option<Option<String>> {
    match field {
        PatchField::Missing => None,
        PatchField::Null => Some(None),
        PatchField::Value(value) => Some(Some(value)),
    }
}

fn required_item_version(headers: &HeaderMap) -> Result<i32, ApiError> {
    let value = headers
        .get("if-match")
        .ok_or_else(|| {
            ApiError::precondition_required("If-Match is required for this item mutation.")
        })?
        .to_str()
        .map_err(|_| ApiError::bad_request("INVALID_IF_MATCH", "If-Match is not valid UTF-8."))?;
    if value.starts_with("W/") || value.contains(',') || value == "*" {
        return Err(ApiError::bad_request(
            "INVALID_IF_MATCH",
            "If-Match must contain exactly one strong item version ETag.",
        ));
    }
    let version = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .and_then(|value| value.parse::<i32>().ok())
        .filter(|version| *version > 0)
        .ok_or_else(|| {
            ApiError::bad_request(
                "INVALID_IF_MATCH",
                "If-Match must be a quoted positive item version.",
            )
        })?;
    Ok(version)
}

fn item_mutation_error(error: AppError) -> ApiError {
    if error.code == AppErrorCode::Conflict {
        ApiError::version_conflict(error.message)
    } else {
        error.into()
    }
}

fn versioned_json<T: Serialize>(value: T, version: i32) -> Result<Response, ApiError> {
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        ETAG,
        HeaderValue::from_str(&format!("\"{version}\""))
            .map_err(|_| ApiError::bad_request("INVALID_VERSION", "Item version is invalid."))?,
    );
    Ok(response)
}

#[derive(IntoResponses)]
#[allow(dead_code)]
enum VaultErrorResponses {
    #[response(
        status = 400,
        description = "Bad request",
        content_type = "application/problem+json"
    )]
    BadRequest(ProblemDetails),
    #[response(
        status = 401,
        description = "Authentication required",
        content_type = "application/problem+json"
    )]
    Unauthorized(ProblemDetails),
    #[response(
        status = 403,
        description = "Forbidden",
        content_type = "application/problem+json"
    )]
    Forbidden(ProblemDetails),
    #[response(
        status = 404,
        description = "Not found",
        content_type = "application/problem+json"
    )]
    NotFound(ProblemDetails),
    #[response(
        status = 409,
        description = "Conflict",
        content_type = "application/problem+json"
    )]
    Conflict(ProblemDetails),
    #[response(
        status = 412,
        description = "Item version does not match",
        content_type = "application/problem+json"
    )]
    VersionConflict(ProblemDetails),
    #[response(
        status = 428,
        description = "If-Match is required",
        content_type = "application/problem+json"
    )]
    PreconditionRequired(ProblemDetails),
    #[response(
        status = 413,
        description = "Payload too large",
        content_type = "application/problem+json"
    )]
    PayloadTooLarge(ProblemDetails),
    #[response(
        status = 415,
        description = "Unsupported media type",
        content_type = "application/problem+json"
    )]
    UnsupportedMediaType(ProblemDetails),
    #[response(
        status = 422,
        description = "Idempotency key was reused with a different request",
        content_type = "application/problem+json"
    )]
    Unprocessable(ProblemDetails),
    #[response(
        status = 503,
        description = "An identical idempotent request is still pending",
        content_type = "application/problem+json",
        headers(("Retry-After" = String, description = "Seconds before retrying"))
    )]
    ServiceUnavailable(ProblemDetails),
    #[response(
        status = 500,
        description = "Internal error",
        content_type = "application/problem+json"
    )]
    Internal(ProblemDetails),
}

#[utoipa::path(get, path = "/vaults", operation_id = "listVaults", tag = "vaults", params(PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultListEntryResponse>), VaultErrorResponses))]
async fn list_vaults(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultListEntryResponse>>, ApiError> {
    let pool = db_pool(&state)?;
    let values = vault::list_vaults(pool, &auth.session.user_id).await?;
    let values: Vec<VaultListEntryResponse> = values.into_iter().map(Into::into).collect();
    Ok(Json(page_values(
        values,
        &page,
        &auth.session.user_id,
        "vaults",
        "",
        |vault| vault.id.clone(),
    )?))
}

#[utoipa::path(get, path = "/vaults/{vaultId}", operation_id = "getVault", tag = "vaults", params(("vaultId" = String, Path)), responses((status = 200, description = "Success", body = VaultDetailsResponseDto), VaultErrorResponses))]
async fn get_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
) -> Result<Json<VaultDetailsResponseDto>, ApiError> {
    let pool = db_pool(&state)?;
    Ok(Json(
        vault::get_vault(
            pool,
            &auth.session.user_id,
            vault::VaultIdInput { vault_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(put, path = "/vaults/{vaultId}", operation_id = "createVault", tag = "vaults", params(("vaultId" = String, Path)), request_body = CreateVaultBody, responses((status = 200, description = "Success", body = CreateVaultResponse), VaultErrorResponses))]
async fn create_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiJson(body): ApiJson<CreateVaultBody>,
) -> Result<Json<CreateVaultResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let result = vault::create_vault(
        pool,
        &auth.session.user_id,
        request_client_id(&auth).as_deref(),
        vault::CreateVaultInput {
            vault_id: Some(vault_id),
            name: body.name,
            vault_type: body.vault_type,
            encrypted_vault_key: body.encrypted_vault_key,
            icon: body.icon,
            image_key: body.image_key,
            client_id: request_client_id(&auth),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(patch, path = "/vaults/{vaultId}", operation_id = "updateVault", tag = "vaults", params(("vaultId" = String, Path)), request_body(content = UpdateVaultBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Success", body = UpdateVaultResponse), VaultErrorResponses))]
async fn update_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiMergePatch(body): ApiMergePatch<UpdateVaultBody>,
) -> Result<Json<UpdateVaultResponse>, ApiError> {
    let name = optional_patch_value(body.name, "/name")?;
    let icon = nullable_patch_value(body.icon);
    let image_key = nullable_patch_value(body.image_key);
    let pool = db_pool(&state)?;
    let result = vault::update_vault(
        pool,
        &auth.session.user_id,
        request_client_id(&auth).as_deref(),
        vault::UpdateVaultInput {
            vault_id,
            name,
            icon,
            image_key,
            client_id: request_client_id(&auth),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(post, path = "/vaults/{vaultId}/type-conversions", operation_id = "convertVaultType", tag = "vaults", params(("vaultId" = String, Path)), request_body = ConvertVaultBody, responses((status = 200, description = "Success", body = ConvertVaultTypeResponse), VaultErrorResponses))]
async fn convert_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiJson(body): ApiJson<ConvertVaultBody>,
) -> Result<Json<ConvertVaultTypeResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let result = vault::convert_vault_type(
        pool,
        &auth.session.user_id,
        request_client_id(&auth).as_deref(),
        vault::ConvertVaultTypeInput {
            vault_id,
            target_type: body.target_type,
            personal_encrypted_vault_key: body.personal_encrypted_vault_key,
            client_id: request_client_id(&auth),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(delete, path = "/vaults/{vaultId}", operation_id = "deleteVault", tag = "vaults", params(("vaultId" = String, Path)), responses((status = 200, description = "Success", body = SuccessResponse), VaultErrorResponses))]
async fn delete_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let result = vault::delete_vault(
        pool,
        &auth.session.user_id,
        request_client_id(&auth).as_deref(),
        vault::VaultIdInput { vault_id },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(post, path = "/vaults/{vaultId}/image-uploads", operation_id = "createVaultImageUpload", tag = "vaults", params(("vaultId" = String, Path)), request_body = ImageUploadBody, responses((status = 200, description = "Success", body = PresignedUploadResponse), VaultErrorResponses))]
async fn create_image_upload(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiJson(body): ApiJson<ImageUploadBody>,
) -> Result<Json<PresignedUploadResponse>, ApiError> {
    let pool = db_pool(&state)?;
    Ok(Json(
        vault::create_vault_image_upload(
            pool,
            &auth.session.user_id,
            vault::CreateVaultImageUploadInput {
                vault_id: Some(vault_id),
                file_name: body.file_name,
                content_type: body.content_type,
            },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(get, path = "/vaults/{vaultId}/items", operation_id = "listVaultItems", tag = "items", params(("vaultId" = String, Path), PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultItemDetailsResponse>), VaultErrorResponses))]
async fn list_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultItemDetailsResponse>>, ApiError> {
    let pool = db_pool(&state)?;
    let cursor = decode_page_key(&page, &auth.session.user_id, "vault-items", &vault_id)?
        .map(|key| timestamp_cursor_key(&key))
        .transpose()?;
    let limit = query_limit(&page)?;
    let values = vault::list_vault_items_page(
        pool,
        &auth.session.user_id,
        vault::VaultIdInput {
            vault_id: vault_id.clone(),
        },
        cursor,
        limit,
    )
    .await?;
    let source_has_more = values.has_more;
    let values: Vec<VaultItemDetailsResponse> = values.values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched_with_more(
        values,
        source_has_more,
        &page,
        &auth.session.user_id,
        "vault-items",
        &vault_id,
        |item| format!("{}\0{}", item.updated_at, item.id),
    )?))
}

#[utoipa::path(get, path = "/items", operation_id = "listAllItems", tag = "items", params(AllItemsQuery), responses((status = 200, description = "Accessible active or trashed items", body = AllItemsResponse), VaultErrorResponses))]
async fn list_all_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    ApiQuery(query): ApiQuery<AllItemsQuery>,
) -> Result<Json<AllItemsResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let state_filter = query.state.as_deref().unwrap_or("active");
    let page = PageRequest {
        cursor: query.cursor,
        limit: query.limit,
    };
    match state_filter {
        "active" => {
            let cursor = decode_page_key(&page, &auth.session.user_id, "items", state_filter)?
                .map(|key| timestamp_cursor_key(&key))
                .transpose()?;
            let values = vault::list_all_vault_items_page(
                pool,
                &auth.session.user_id,
                cursor,
                query_limit(&page)?,
            )
            .await?;
            let source_has_more = values.has_more;
            Ok(Json(
                page_prefetched_with_more(
                    values.values,
                    source_has_more,
                    &page,
                    &auth.session.user_id,
                    "items",
                    state_filter,
                    |item| format!("{}\0{}", item.updated_at, item.id),
                )?
                .into(),
            ))
        }
        "trashed" => {
            let cursor = decode_page_key(&page, &auth.session.user_id, "items", state_filter)?
                .map(|key| timestamp_cursor_key(&key))
                .transpose()?;
            let values = vault::list_all_deleted_vault_items_page(
                pool,
                &auth.session.user_id,
                cursor,
                query_limit(&page)?,
            )
            .await?;
            let source_has_more = values.has_more;
            Ok(Json(
                page_prefetched_with_more(
                    values.values,
                    source_has_more,
                    &page,
                    &auth.session.user_id,
                    "items",
                    state_filter,
                    |item| {
                        format!(
                            "{}\0{}",
                            item.deleted_at.as_deref().unwrap_or_default(),
                            item.id
                        )
                    },
                )?
                .into(),
            ))
        }
        _ => Err(ApiError::bad_request(
            "INVALID_ITEM_STATE",
            "state must be either active or trashed.",
        )),
    }
}

#[utoipa::path(get, path = "/items/trashed", operation_id = "listAllTrashedItems", tag = "items", params(PageRequest), responses((status = 200, description = "All accessible trashed items", body = CursorPage<DeletedVaultItemWithVaultResponse>), VaultErrorResponses))]
async fn list_all_trashed_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<DeletedVaultItemWithVaultResponse>>, ApiError> {
    let cursor = decode_page_key(&page, &auth.session.user_id, "items", "trashed")?
        .map(|key| timestamp_cursor_key(&key))
        .transpose()?;
    let values = vault::list_all_deleted_vault_items_page(
        db_pool(&state)?,
        &auth.session.user_id,
        cursor,
        query_limit(&page)?,
    )
    .await?;
    let source_has_more = values.has_more;
    let values: Vec<DeletedVaultItemWithVaultResponse> =
        values.values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched_with_more(
        values,
        source_has_more,
        &page,
        &auth.session.user_id,
        "items",
        "trashed",
        |item| {
            format!(
                "{}\0{}",
                item.deleted_at.as_deref().unwrap_or_default(),
                item.id
            )
        },
    )?))
}

#[utoipa::path(get, path = "/vaults/{vaultId}/items/trashed", operation_id = "listTrashedVaultItems", tag = "items", params(("vaultId" = String, Path), PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultItemResponse>), VaultErrorResponses))]
async fn list_deleted_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultItemResponse>>, ApiError> {
    let pool = db_pool(&state)?;
    let filter = format!("{vault_id}:trashed");
    let cursor = decode_page_key(&page, &auth.session.user_id, "vault-items", &filter)?
        .map(|key| timestamp_cursor_key(&key))
        .transpose()?;
    let values = vault::list_deleted_vault_items_page(
        pool,
        &auth.session.user_id,
        vault::VaultIdInput {
            vault_id: vault_id.clone(),
        },
        cursor,
        query_limit(&page)?,
    )
    .await?;
    let source_has_more = values.has_more;
    let values: Vec<VaultItemResponse> = values.values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched_with_more(
        values,
        source_has_more,
        &page,
        &auth.session.user_id,
        "vault-items",
        &filter,
        |item| {
            format!(
                "{}\0{}",
                item.deleted_at.as_deref().unwrap_or_default(),
                item.id
            )
        },
    )?))
}

#[utoipa::path(get, path = "/items/{itemId}", operation_id = "getItem", tag = "items", params(("itemId" = String, Path)), responses((status = 200, description = "Success", body = ItemResponseDto, headers(("ETag" = String, description = "Strong item version validator"))), VaultErrorResponses))]
async fn get_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(item_id): Path<String>,
) -> Result<Response, ApiError> {
    let pool = db_pool(&state)?;
    let item: ItemResponseDto =
        vault::get_vault_item(pool, &auth.session.user_id, vault::ItemIdInput { item_id })
            .await?
            .into();
    let version = item.version;
    versioned_json(item, version)
}

#[utoipa::path(put, path = "/vaults/{vaultId}/items/{itemId}", operation_id = "createItem", tag = "items", params(("vaultId" = String, Path), ("itemId" = String, Path), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same queued mutation outcome for 24 hours when request bytes match")), request_body = CreateItemBody, responses((status = 200, description = "Success", body = CreateItemResponse, headers(("ETag" = String, description = "Created strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
async fn create_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path((vault_id, item_id)): Path<(String, String)>,
    ApiJsonBytes { value: body, bytes }: ApiJsonBytes<CreateItemBody>,
) -> Result<Response, ApiError> {
    check_ciphertext(&body.encrypted_data)?;
    let pool = db_pool(&state)?.clone();
    let operation_pool = pool.clone();
    let principal_id = auth.session.user_id.clone();
    let operation_principal_id = principal_id.clone();
    let client_id = request_client_id(&auth);
    let route_target = format!("/api/v1/vaults/{vault_id}/items/{item_id}");
    idempotency::execute(
        &pool,
        &headers,
        &principal_id,
        "PUT",
        &route_target,
        &bytes,
        || async move {
            let result = vault::create_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::CreateItemInput {
                    item_id: Some(item_id),
                    vault_id,
                    category: body.category,
                    encrypted_data: body.encrypted_data,
                    encryption_iv: body.encryption_iv,
                    encryption_algorithm: body.encryption_algorithm,
                    client_id,
                },
            )
            .await
            .notify_sync(&state)?;
            versioned_json(CreateItemResponse::from(result), 1)
        },
    )
    .await
}

#[utoipa::path(post, path = "/vaults/{vaultId}/item-imports", operation_id = "bulkImportItems", tag = "items", params(("vaultId" = String, Path)), request_body = BulkImportBody, responses((status = 200, description = "Success", body = BulkImportItemsResponse), VaultErrorResponses))]
async fn bulk_import_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiJson(body): ApiJson<BulkImportBody>,
) -> Result<Json<BulkImportItemsResponse>, ApiError> {
    check_bulk_import(&body)?;
    let pool = db_pool(&state)?;
    let result = vault::bulk_import_vault_items(
        pool,
        &auth.session.user_id,
        vault::BulkImportItemsInput {
            vault_id,
            client_id: request_client_id(&auth),
            items: body.items.into_iter().map(Into::into).collect(),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(patch, path = "/items/{itemId}", operation_id = "updateItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same outcome for 24 hours when request bytes and preconditions match")), request_body(content = UpdateItemBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Success", body = UpdateItemResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
async fn update_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    ApiMergePatchBytes { value: body, bytes }: ApiMergePatchBytes<UpdateItemBody>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let encrypted_data = optional_patch_value(body.encrypted_data, "/encryptedData")?;
    let encryption_iv = optional_patch_value(body.encryption_iv, "/encryptionIv")?;
    let encryption_algorithm =
        optional_patch_value(body.encryption_algorithm, "/encryptionAlgorithm")?;
    if let Some(value) = encrypted_data.as_deref() {
        check_ciphertext(value)?;
    }
    let pool = db_pool(&state)?.clone();
    let operation_pool = pool.clone();
    let principal_id = auth.session.user_id.clone();
    let operation_principal_id = principal_id.clone();
    let client_id = request_client_id(&auth);
    let route_target = format!("/api/v1/items/{item_id}");
    idempotency::execute(
        &pool,
        &headers,
        &principal_id,
        "PATCH",
        &route_target,
        &bytes,
        || async move {
            let result = vault::update_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::UpdateItemInput {
                    item_id,
                    encrypted_data,
                    encryption_iv,
                    encryption_algorithm,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            let version = result.version;
            versioned_json(UpdateItemResponse::from(result), version)
        },
    )
    .await
}

#[utoipa::path(patch, path = "/items/{itemId}/favorite", operation_id = "setItemFavorite", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same outcome for 24 hours when request bytes and preconditions match")), request_body(content = FavoriteBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Success", body = SuccessResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
async fn set_favorite(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    ApiMergePatchBytes { value: body, bytes }: ApiMergePatchBytes<FavoriteBody>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let pool = db_pool(&state)?.clone();
    let operation_pool = pool.clone();
    let principal_id = auth.session.user_id.clone();
    let operation_principal_id = principal_id.clone();
    let route_target = format!("/api/v1/items/{item_id}/favorite");
    idempotency::execute(
        &pool,
        &headers,
        &principal_id,
        "PATCH",
        &route_target,
        &bytes,
        || async move {
            let result = vault::toggle_vault_favorite(
                &operation_pool,
                &operation_principal_id,
                vault::ToggleFavoriteInput {
                    item_id,
                    favorite: body.favorite,
                    expected_version: Some(expected_version),
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            versioned_json(SuccessResponse::from(result), expected_version + 1)
        },
    )
    .await
}

#[utoipa::path(delete, path = "/items/{itemId}", operation_id = "trashItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same queued mutation outcome for 24 hours when preconditions match")), responses((status = 200, description = "Success", body = SuccessResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
async fn delete_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let pool = db_pool(&state)?.clone();
    let operation_pool = pool.clone();
    let principal_id = auth.session.user_id.clone();
    let operation_principal_id = principal_id.clone();
    let client_id = request_client_id(&auth);
    let route_target = format!("/api/v1/items/{item_id}");
    idempotency::execute(
        &pool,
        &headers,
        &principal_id,
        "DELETE",
        &route_target,
        &[],
        || async move {
            let result = vault::delete_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::ItemClientInput {
                    item_id,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            versioned_json(SuccessResponse::from(result), expected_version + 1)
        },
    )
    .await
}

#[utoipa::path(post, path = "/items/{itemId}/restore", operation_id = "restoreItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same outcome for 24 hours when preconditions match")), responses((status = 200, description = "Success", body = SuccessResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
async fn restore_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let pool = db_pool(&state)?.clone();
    let operation_pool = pool.clone();
    let principal_id = auth.session.user_id.clone();
    let operation_principal_id = principal_id.clone();
    let client_id = request_client_id(&auth);
    let route_target = format!("/api/v1/items/{item_id}/restore");
    idempotency::execute(
        &pool,
        &headers,
        &principal_id,
        "POST",
        &route_target,
        &[],
        || async move {
            let result = vault::restore_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::ItemClientInput {
                    item_id,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            versioned_json(SuccessResponse::from(result), expected_version + 1)
        },
    )
    .await
}

#[utoipa::path(post, path = "/items/{itemId}/moves", operation_id = "moveItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same outcome for 24 hours when request bytes and preconditions match")), request_body = MoveItemBody, responses((status = 200, description = "Success", body = UpdateItemResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
async fn move_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
    ApiJsonBytes { value: body, bytes }: ApiJsonBytes<MoveItemBody>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    check_ciphertext(&body.encrypted_data)?;
    let pool = db_pool(&state)?.clone();
    let operation_pool = pool.clone();
    let principal_id = auth.session.user_id.clone();
    let operation_principal_id = principal_id.clone();
    let client_id = request_client_id(&auth);
    let route_target = format!("/api/v1/items/{item_id}/moves");
    idempotency::execute(
        &pool,
        &headers,
        &principal_id,
        "POST",
        &route_target,
        &bytes,
        || async move {
            let result = vault::move_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::MoveItemInput {
                    item_id,
                    source_vault_id: body.source_vault_id,
                    target_vault_id: body.target_vault_id,
                    encrypted_data: body.encrypted_data,
                    encryption_iv: body.encryption_iv,
                    encryption_algorithm: body.encryption_algorithm,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            let version = result.version;
            versioned_json(UpdateItemResponse::from(result), version)
        },
    )
    .await
}

#[utoipa::path(delete, path = "/items/{itemId}/permanent", operation_id = "permanentlyDeleteItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same queued mutation outcome for 24 hours when preconditions match")), responses((status = 200, description = "Success", body = SuccessResponse, headers(("ETag" = String, description = "Final strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
async fn permanently_delete_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let pool = db_pool(&state)?.clone();
    let operation_pool = pool.clone();
    let principal_id = auth.session.user_id.clone();
    let operation_principal_id = principal_id.clone();
    let client_id = request_client_id(&auth);
    let route_target = format!("/api/v1/items/{item_id}/permanent");
    idempotency::execute(
        &pool,
        &headers,
        &principal_id,
        "DELETE",
        &route_target,
        &[],
        || async move {
            let result = vault::permanently_delete_vault_item(
                &operation_pool,
                &operation_principal_id,
                vault::ItemClientInput {
                    item_id,
                    expected_version: Some(expected_version),
                    client_id,
                },
            )
            .await
            .notify_sync(&state)
            .map_err(item_mutation_error)?;
            versioned_json(SuccessResponse::from(result), expected_version + 1)
        },
    )
    .await
}

#[utoipa::path(get, path = "/vault-stats", operation_id = "getVaultStats", tag = "vaults", responses((status = 200, description = "Success", body = VaultStatsResponseDto), VaultErrorResponses))]
async fn stats(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
) -> Result<Json<VaultStatsResponseDto>, ApiError> {
    let pool = db_pool(&state)?;
    Ok(Json(
        vault::get_vault_stats(pool, &auth.session.user_id)
            .await?
            .into(),
    ))
}

#[utoipa::path(post, path = "/items/{itemId}/attachment-uploads", operation_id = "createAttachmentUpload", tag = "attachments", params(("itemId" = String, Path)), request_body = AttachmentUploadBody, responses((status = 200, description = "Success", body = PresignedUploadResponse), VaultErrorResponses))]
async fn create_attachment_upload(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(item_id): Path<String>,
    ApiJson(body): ApiJson<AttachmentUploadBody>,
) -> Result<Json<PresignedUploadResponse>, ApiError> {
    let pool = db_pool(&state)?;
    Ok(Json(
        vault::create_vault_attachment_upload(
            pool,
            &auth.session.user_id,
            vault::CreateAttachmentUploadInput {
                item_id,
                file_name: body.file_name,
                content_type: body.content_type,
                file_size: body.file_size,
            },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(post, path = "/items/{itemId}/attachments", operation_id = "createAttachment", tag = "attachments", params(("itemId" = String, Path)), request_body = CreateAttachmentBody, responses((status = 200, description = "Success", body = CreateAttachmentResponse), VaultErrorResponses))]
async fn create_attachment(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(item_id): Path<String>,
    ApiJson(body): ApiJson<CreateAttachmentBody>,
) -> Result<Json<CreateAttachmentResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let result = vault::create_vault_attachment(
        pool,
        &auth.session.user_id,
        request_client_id(&auth).as_deref(),
        vault::CreateAttachmentInput {
            item_id,
            storage_key: body.storage_key,
            encrypted_name: body.encrypted_name,
            encrypted_content_type: body.encrypted_content_type,
            encryption_iv: body.encryption_iv,
            encrypted_content_type_iv: body.encrypted_content_type_iv,
            encryption_algorithm: body.encryption_algorithm,
            file_size: body.file_size,
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(get, path = "/items/{itemId}/attachments", operation_id = "listAttachments", tag = "attachments", params(("itemId" = String, Path), PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultAttachmentResponse>), VaultErrorResponses))]
async fn list_attachments(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(item_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultAttachmentResponse>>, ApiError> {
    let pool = db_pool(&state)?;
    let cursor = decode_page_key(&page, &auth.session.user_id, "attachments", &item_id)?
        .map(|key| timestamp_cursor_key(&key))
        .transpose()?;
    let values = vault::list_vault_attachments_page(
        pool,
        &auth.session.user_id,
        vault::ItemIdInput {
            item_id: item_id.clone(),
        },
        cursor,
        query_limit(&page)?,
    )
    .await?;
    let values: Vec<VaultAttachmentResponse> = values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched(
        values,
        &page,
        &auth.session.user_id,
        "attachments",
        &item_id,
        |attachment| format!("{}\0{}", attachment.created_at, attachment.id),
    )?))
}

#[utoipa::path(post, path = "/attachments/{attachmentId}/download-urls", operation_id = "createAttachmentDownloadUrl", tag = "attachments", params(("attachmentId" = String, Path)), responses((status = 200, description = "Success", body = AttachmentDownloadResponse), VaultErrorResponses))]
async fn create_attachment_download_url(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(attachment_id): Path<String>,
) -> Result<Json<AttachmentDownloadResponse>, ApiError> {
    let pool = db_pool(&state)?;
    Ok(Json(
        vault::get_attachment_download_url(
            pool,
            &auth.session.user_id,
            vault::AttachmentIdInput { attachment_id },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(patch, path = "/attachments/{attachmentId}", operation_id = "updateAttachment", tag = "attachments", params(("attachmentId" = String, Path)), request_body(content = UpdateAttachmentBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Success", body = SuccessResponse), VaultErrorResponses))]
async fn update_attachment(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(attachment_id): Path<String>,
    ApiMergePatch(body): ApiMergePatch<UpdateAttachmentBody>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let result = vault::update_vault_attachment(
        pool,
        &auth.session.user_id,
        request_client_id(&auth).as_deref(),
        vault::UpdateAttachmentInput {
            attachment_id,
            encrypted_name: body.encrypted_name,
            encryption_iv: body.encryption_iv,
            encryption_algorithm: body.encryption_algorithm,
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(delete, path = "/attachments/{attachmentId}", operation_id = "deleteAttachment", tag = "attachments", params(("attachmentId" = String, Path)), responses((status = 200, description = "Success", body = SuccessResponse), VaultErrorResponses))]
async fn delete_attachment(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(attachment_id): Path<String>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let result = vault::delete_vault_attachment(
        pool,
        &auth.session.user_id,
        request_client_id(&auth).as_deref(),
        vault::AttachmentIdInput { attachment_id },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(get, path = "/vaults/{vaultId}/members", operation_id = "listVaultMembers", tag = "vault-members", params(("vaultId" = String, Path), PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultMemberResponse>), VaultErrorResponses))]
async fn list_members(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultMemberResponse>>, ApiError> {
    let pool = db_pool(&state)?;
    let values = vault::member_handlers::list_vault_members(
        pool,
        &auth.session.user_id,
        vault::VaultIdInput {
            vault_id: vault_id.clone(),
        },
    )
    .await?;
    let values: Vec<VaultMemberResponse> = values.into_iter().map(Into::into).collect();
    Ok(Json(page_values(
        values,
        &page,
        &auth.session.user_id,
        "vault-members",
        &vault_id,
        |member| member.user_id.clone(),
    )?))
}

#[utoipa::path(get, path = "/vaults/{vaultId}/available-team-members", operation_id = "listAvailableTeamMembers", tag = "vault-members", params(("vaultId" = String, Path), PageRequest), responses((status = 200, description = "Success", body = CursorPage<VaultAvailableMemberResponse>), VaultErrorResponses))]
async fn available_team_members(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
    ApiPageQuery(page): ApiPageQuery,
) -> Result<Json<CursorPage<VaultAvailableMemberResponse>>, ApiError> {
    let pool = db_pool(&state)?;
    let values = vault::member_handlers::available_team_members(
        pool,
        &auth.session.user_id,
        vault::VaultIdInput {
            vault_id: vault_id.clone(),
        },
    )
    .await?;
    let values: Vec<VaultAvailableMemberResponse> = values.into_iter().map(Into::into).collect();
    Ok(Json(page_values(
        values,
        &page,
        &auth.session.user_id,
        "available-vault-members",
        &vault_id,
        |member| member.user_id.clone(),
    )?))
}

#[utoipa::path(put, path = "/vaults/{vaultId}/members/{userId}", operation_id = "addVaultMember", tag = "vault-members", params(("vaultId" = String, Path), ("userId" = String, Path)), request_body = AddVaultMemberBody, responses((status = 200, description = "Success", body = SuccessResponse), VaultErrorResponses))]
async fn add_member(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path((vault_id, user_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<AddVaultMemberBody>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let result = vault::member_handlers::add_vault_member(
        pool,
        &auth.session.user_id,
        request_client_id(&auth).as_deref(),
        vault::AddVaultMemberInput {
            vault_id,
            user_id,
            role: body.role,
            encrypted_vault_key: body.encrypted_vault_key,
            client_id: request_client_id(&auth),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(patch, path = "/vaults/{vaultId}/members/{userId}", operation_id = "updateVaultMemberRole", tag = "vault-members", params(("vaultId" = String, Path), ("userId" = String, Path)), request_body(content = UpdateVaultMemberRoleBody, content_type = "application/merge-patch+json"), responses((status = 200, description = "Success", body = SuccessResponse), VaultErrorResponses))]
async fn update_member_role(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path((vault_id, user_id)): Path<(String, String)>,
    ApiMergePatch(body): ApiMergePatch<UpdateVaultMemberRoleBody>,
) -> Result<Json<SuccessResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let result = vault::member_handlers::update_vault_member_role(
        pool,
        &auth.session.user_id,
        vault::UpdateVaultMemberRoleInput {
            vault_id,
            user_id,
            role: body.role,
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

#[utoipa::path(get, path = "/vaults/{vaultId}/members/{userId}/removal-rotation-data", operation_id = "getVaultMemberRemovalRotationData", tag = "vault-members", params(("vaultId" = String, Path), ("userId" = String, Path)), responses((status = 200, description = "Success", body = VaultRotationDataResponse), VaultErrorResponses))]
async fn get_rotation_data(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path((vault_id, user_id)): Path<(String, String)>,
) -> Result<Json<VaultRotationDataResponse>, ApiError> {
    let pool = db_pool(&state)?;
    Ok(Json(
        vault::member_handlers::get_vault_rotation_data(
            pool,
            &auth.session.user_id,
            vault::GetVaultRotationDataInput {
                vault_id,
                exclude_user_id: user_id,
            },
        )
        .await?
        .into(),
    ))
}

#[utoipa::path(delete, path = "/vaults/{vaultId}/members/{userId}", operation_id = "removeVaultMember", tag = "vault-members", params(("vaultId" = String, Path), ("userId" = String, Path)), request_body = RemoveVaultMemberBody, responses((status = 200, description = "Success", body = RemoveVaultMemberResponse), VaultErrorResponses))]
async fn remove_member(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path((vault_id, user_id)): Path<(String, String)>,
    ApiJson(body): ApiJson<RemoveVaultMemberBody>,
) -> Result<Json<RemoveVaultMemberResponse>, ApiError> {
    let pool = db_pool(&state)?;
    let result = vault::member_handlers::remove_vault_member(
        pool,
        &auth.session.user_id,
        request_client_id(&auth).as_deref(),
        vault::RemoveVaultMemberInput {
            vault_id,
            user_id,
            key_rotation: body.key_rotation.into(),
            client_id: request_client_id(&auth),
        },
    )
    .await
    .notify_sync(&state)?;
    Ok(Json(result.into()))
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    let reads = OpenApiRouter::new()
        .routes(routes!(list_vaults))
        .routes(routes!(get_vault))
        .routes(routes!(list_items))
        .routes(routes!(list_all_items))
        .routes(routes!(list_all_trashed_items))
        .routes(routes!(list_deleted_items))
        .routes(routes!(get_item))
        .routes(routes!(stats))
        .routes(routes!(list_attachments))
        .routes(routes!(list_members))
        .routes(routes!(available_team_members))
        .routes(routes!(get_rotation_data));
    let ordinary_writes = OpenApiRouter::new()
        .routes(routes!(create_vault))
        .routes(routes!(update_vault))
        .routes(routes!(convert_vault))
        .routes(routes!(delete_vault))
        .routes(routes!(create_image_upload))
        .routes(routes!(set_favorite))
        .routes(routes!(delete_item))
        .routes(routes!(restore_item))
        .routes(routes!(permanently_delete_item))
        .routes(routes!(create_attachment_upload))
        .routes(routes!(create_attachment))
        .routes(routes!(create_attachment_download_url))
        .routes(routes!(update_attachment))
        .routes(routes!(delete_attachment))
        .routes(routes!(add_member))
        .routes(routes!(update_member_role))
        .routes(routes!(remove_member))
        .route_layer(DefaultBodyLimit::max(ORDINARY_API_BODY_LIMIT_BYTES));
    let item_writes = OpenApiRouter::new()
        .routes(routes!(create_item))
        .routes(routes!(update_item))
        .routes(routes!(move_item))
        .route_layer(DefaultBodyLimit::max(ITEM_BODY_LIMIT_BYTES));
    let bulk = OpenApiRouter::new()
        .routes(routes!(bulk_import_items))
        .route_layer(DefaultBodyLimit::max(BULK_IMPORT_BYTES as usize));

    reads.merge(ordinary_writes).merge(item_writes).merge(bulk)
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{to_bytes, Body},
        extract::FromRequest,
        http::{Request, StatusCode},
        response::IntoResponse,
    };
    use serde_json::json;
    use utoipa::PartialSchema;

    use super::{
        check_bulk_import, check_ciphertext, nullable_patch_value, router, AllItemsResponse,
        ApiJsonBytes, BulkImportBody, BulkImportItemInput, FavoriteBody, RemoveVaultMemberBody,
        UpdateVaultBody, VaultItemDetailsResponse, VaultStatsResponseDto,
    };
    use crate::{
        http::api::dto::{CursorPage, PatchField},
        services::vault::{
            DeletedVaultItemWithVaultResponse, VaultItemWithVaultResponse, VaultStatsResponse,
        },
    };

    fn item(ciphertext: String) -> BulkImportItemInput {
        BulkImportItemInput {
            item_id: "item_test".to_string(),
            category: "Login".to_string(),
            favorite: None,
            encrypted_data: ciphertext,
            encryption_iv: "iv".to_string(),
            encryption_algorithm: None,
        }
    }

    #[test]
    fn item_ciphertext_limit_is_byte_based_and_inclusive() {
        assert!(check_ciphertext(&"a".repeat(1_048_576)).is_ok());
        assert!(check_ciphertext(&"a".repeat(1_048_577)).is_err());
        assert!(check_ciphertext(&"é".repeat(524_288)).is_ok());
        assert!(check_ciphertext(&format!("{}a", "é".repeat(524_288))).is_err());
    }

    #[tokio::test]
    async fn idempotent_item_json_preserves_unsupported_media_type() {
        let request = Request::builder()
            .header("content-type", "text/plain")
            .body(Body::from(r#"{"favorite":true}"#))
            .expect("request should build");
        let error = ApiJsonBytes::<FavoriteBody>::from_request(request, &())
            .await
            .expect_err("plain text must not be accepted as item JSON");
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let body: serde_json::Value = serde_json::from_slice(
            &to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("problem body should load"),
        )
        .expect("problem body should be JSON");
        assert_eq!(body["code"], "UNSUPPORTED_MEDIA_TYPE");
    }

    #[test]
    fn bulk_import_rejects_too_many_items_and_oversized_ciphertext() {
        let too_many = BulkImportBody {
            items: (0..201)
                .map(|index| {
                    let mut value = item("ciphertext".to_string());
                    value.item_id = format!("item_{index}");
                    value
                })
                .collect(),
        };
        assert!(check_bulk_import(&too_many).is_err());

        assert!(check_bulk_import(&BulkImportBody {
            items: vec![item("a".repeat(1_048_577))],
        })
        .is_err());
    }

    #[test]
    fn vault_request_dtos_reject_unknown_nested_fields() {
        assert!(serde_json::from_value::<BulkImportBody>(json!({
            "items": [{
                "itemId": "item_test",
                "category": "login",
                "encryptedData": "ciphertext",
                "encryptionIv": "iv",
                "unknown": true
            }]
        }))
        .is_err());
        assert!(serde_json::from_value::<RemoveVaultMemberBody>(json!({
            "keyRotation": {
                "memberKeys": [{
                    "userId": "user_test",
                    "encryptedVaultKey": "wrapped",
                    "unknown": true
                }],
                "reEncryptedItems": []
            }
        }))
        .is_err());
    }

    #[test]
    fn vault_item_wire_dto_preserves_service_serialization_and_schema() {
        let service = crate::services::vault::VaultItemDetailsResponse {
            id: "item_test".to_string(),
            vault_id: "vault_test".to_string(),
            category: "login".to_string(),
            favorite: true,
            encrypted_data: "ciphertext".to_string(),
            encryption_iv: "iv".to_string(),
            encryption_algorithm: "aes-gcm".to_string(),
            version: 7,
            last_modified_by: Some("user_test".to_string()),
            created_at: "2026-08-10T00:00:00Z".to_string(),
            updated_at: "2026-08-10T00:01:00Z".to_string(),
            deleted_at: None,
            attachments: vec![crate::services::vault::VaultAttachmentResponse {
                id: "attachment_test".to_string(),
                item_id: "item_test".to_string(),
                vault_id: "vault_test".to_string(),
                storage_key: "attachments/test".to_string(),
                encrypted_name: "name".to_string(),
                encrypted_content_type: "type".to_string(),
                encryption_iv: "attachment-iv".to_string(),
                encrypted_content_type_iv: Some("content-type-iv".to_string()),
                encryption_algorithm: "aes-gcm".to_string(),
                file_size: 128,
                uploaded_by: Some("user_test".to_string()),
                created_at: "2026-08-10T00:00:00Z".to_string(),
            }],
        };
        let expected_json = serde_json::to_value(&service).unwrap();
        let wire = VaultItemDetailsResponse::from(service);

        assert_eq!(serde_json::to_value(wire).unwrap(), expected_json);
        assert_eq!(
            serde_json::to_value(VaultItemDetailsResponse::schema()).unwrap(),
            serde_json::to_value(crate::services::vault::VaultItemDetailsResponse::schema())
                .unwrap()
        );
    }

    #[test]
    fn vault_patch_preserves_absent_null_and_value() {
        let missing: UpdateVaultBody = serde_json::from_value(json!({})).unwrap();
        assert!(matches!(missing.icon, PatchField::Missing));

        let null: UpdateVaultBody = serde_json::from_value(json!({ "icon": null })).unwrap();
        assert_eq!(nullable_patch_value(null.icon), Some(None));

        let value: UpdateVaultBody = serde_json::from_value(json!({ "icon": "key" })).unwrap();
        assert_eq!(
            nullable_patch_value(value.icon),
            Some(Some("key".to_string()))
        );
    }

    #[test]
    fn vault_counts_are_decimal_strings() {
        let response: VaultStatsResponseDto = VaultStatsResponse {
            team_count: 1,
            vault_count: i64::MAX,
            item_count: i64::MAX - 1,
        }
        .into();

        assert_eq!(
            serde_json::to_value(response).unwrap(),
            json!({
                "teamCount": 1,
                "vaultCount": i64::MAX.to_string(),
                "itemCount": (i64::MAX - 1).to_string(),
            })
        );
    }

    #[test]
    fn all_items_transport_preserves_active_and_trashed_wire_shapes() {
        let active = CursorPage {
            items: vec![VaultItemWithVaultResponse {
                id: "active-item".to_string(),
                vault_id: "vault".to_string(),
                category: "login".to_string(),
                favorite: false,
                encrypted_data: "ciphertext".to_string(),
                encryption_iv: "iv".to_string(),
                encryption_algorithm: "aes-gcm".to_string(),
                version: 1,
                last_modified_by: None,
                created_at: "2026-08-10T00:00:00Z".to_string(),
                updated_at: "2026-08-10T00:00:00Z".to_string(),
                deleted_at: None,
                attachments: Vec::new(),
                vault: None,
            }],
            next_cursor: None,
            has_more: false,
        };
        let expected_active = serde_json::to_value(&active).unwrap();
        assert_eq!(
            serde_json::to_value(AllItemsResponse::from(active)).unwrap(),
            expected_active
        );

        let trashed = CursorPage {
            items: vec![DeletedVaultItemWithVaultResponse {
                id: "trashed-item".to_string(),
                vault_id: "vault".to_string(),
                category: "login".to_string(),
                favorite: false,
                encrypted_data: "ciphertext".to_string(),
                encryption_iv: "iv".to_string(),
                encryption_algorithm: "aes-gcm".to_string(),
                version: 2,
                last_modified_by: None,
                created_at: "2026-08-10T00:00:00Z".to_string(),
                updated_at: "2026-08-10T00:00:00Z".to_string(),
                deleted_at: Some("2026-08-10T00:01:00Z".to_string()),
                vault: None,
            }],
            next_cursor: None,
            has_more: false,
        };
        let expected_trashed = serde_json::to_value(&trashed).unwrap();
        assert_eq!(
            serde_json::to_value(AllItemsResponse::from(trashed)).unwrap(),
            expected_trashed
        );
    }

    #[test]
    fn all_items_openapi_uses_one_non_overlapping_page_schema() {
        let openapi = serde_json::to_value(router().split_for_parts().1).unwrap();
        let schema = &openapi["components"]["schemas"]["AllItemsResponse"];

        assert_eq!(schema["type"], "object");
        assert!(schema.get("oneOf").is_none());
        assert!(schema.get("anyOf").is_none());
        assert_eq!(schema["properties"]["items"]["maxItems"], 500);
    }

    #[test]
    fn router_registers_all_used_vault_operations_only() {
        let openapi = serde_json::to_value(router().split_for_parts().1).unwrap();
        let rendered = openapi.to_string();
        assert_eq!(rendered.matches("operationId").count(), 33);
        assert!(rendered.contains("listAllTrashedItems"));
        assert!(rendered.contains("/items/trashed"));
        assert!(!rendered.contains("lookupUser"));
        assert!(rendered.contains("If-Match"));
        assert!(rendered.contains("428"));
        assert!(rendered.contains("412"));
    }
}
