use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header::ETAG, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, IntoResponses, ToSchema};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::{
    db::enums::{ItemCategory, VaultRole, VaultType},
    error::{AppError, AppErrorCode},
    services::vault,
    shapes::{
        attachment_download_shape, attachment_shape, bulk_import_item_shape,
        bulk_import_result_shape, convert_vault_type_shape, create_attachment_shape,
        create_item_shape, create_vault_shape, item_shape, update_item_shape, update_vault_shape,
        vault_available_member_shape, vault_details_shape, vault_list_entry_shape,
        vault_member_shape, vault_stats_shape, vault_summary_shape,
    },
    AppState, NotifySyncExt,
};

use super::{
    dto::{
        CursorPage, DecimalString, PageCursor, PageRequest, PatchField, PresignedUploadResponse,
        ProblemDetails, SuccessResponse, BULK_IMPORT_BYTES, BULK_IMPORT_ITEMS, DEFAULT_PAGE_SIZE,
        ITEM_CIPHERTEXT_BYTES,
    },
    error::ApiError,
    error_code::ErrorCode,
    extract::{
        ApiJson, ApiJsonBytes, ApiMergePatch, ApiMergePatchBytes, ApiQuery, AuthenticatedRequest,
    },
    idempotency,
    pagination::{
        decode_page_key, page_prefetched, page_prefetched_with_more, page_values, query_limit,
        timestamp_cursor_key, ApiPageQuery, CursorContext,
    },
    ORDINARY_API_BODY_LIMIT_BYTES,
};

pub(crate) const ITEM_BODY_LIMIT_BYTES: usize = ITEM_CIPHERTEXT_BYTES as usize + 64 * 1024;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateVaultBody {
    #[schema(max_length = 200)]
    name: String,
    vault_type: VaultType,
    #[schema(max_length = 65536)]
    encrypted_vault_key: String,
    icon: Option<String>,
    image_key: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateVaultBody {
    #[serde(default)]
    #[schema(value_type = Option<String>, nullable = true, max_length = 200)]
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
    target_type: VaultType,
    #[schema(max_length = 65536)]
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
    category: ItemCategory,
    #[schema(max_length = 1048576)]
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BulkImportBody {
    #[schema(max_items = 200)]
    items: Vec<BulkImportItemInput>,
}

bulk_import_item_shape!(wire_struct {
    #[derive(Debug, Deserialize, ToSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct BulkImportItemInput
});
bulk_import_item_shape!(shape_from {
    BulkImportItemInput => vault::BulkImportItemInput
});

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

item_shape! {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct AllItemResponse {
        #[serde(skip_serializing_if = "Option::is_none")]
        attachments: Option<Vec<VaultAttachmentResponse>>,
        vault: Option<VaultSummaryResponse>,
    }
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
        let (item, (attachments, vault)) = value.decompose();
        Self::compose(
            item,
            Some(attachments.into_iter().map(Into::into).collect()),
            vault.map(Into::into),
        )
    }
}

impl From<vault::DeletedVaultItemWithVaultResponse> for AllItemResponse {
    fn from(value: vault::DeletedVaultItemWithVaultResponse) -> Self {
        // Trashed items carry no attachments: `attachments` is absent, not an empty list.
        let (item, (vault,)) = value.decompose();
        Self::compose(item, None, vault.map(Into::into))
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
    encryption_algorithm: String,
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
    attachment_id: String,
    storage_key: String,
    encrypted_attachment_key: String,
    attachment_key_iv: String,
    attachment_key_algorithm: String,
    envelope_version: i32,
    encrypted_name: String,
    encrypted_content_type: String,
    encryption_iv: String,
    encrypted_content_type_iv: String,
    encryption_algorithm: String,
    file_size: i32,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct AttachmentUploadResponse {
    attachment_id: String,
    key: String,
    upload_url: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateAttachmentBody {
    encrypted_name: String,
    encryption_iv: String,
    encryption_algorithm: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddVaultMemberBody {
    role: VaultRole,
    #[schema(max_length = 65536)]
    encrypted_vault_key: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateVaultMemberRoleBody {
    role: VaultRole,
}

create_vault_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct CreateVaultResponse
});
create_vault_shape!(shape_from { vault::CreateVaultResponse => CreateVaultResponse });

update_vault_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct UpdateVaultResponse
});
update_vault_shape!(shape_from { vault::UpdateVaultResponse => UpdateVaultResponse });

convert_vault_type_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct ConvertVaultTypeResponse
});
convert_vault_type_shape!(shape_from {
    vault::ConvertVaultTypeResponse => ConvertVaultTypeResponse
});

create_item_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct CreateItemResponse
});
create_item_shape!(shape_from { vault::CreateItemResponse => CreateItemResponse });

bulk_import_result_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct BulkImportItemsResponse
});
bulk_import_result_shape!(shape_from {
    vault::BulkImportItemsResponse => BulkImportItemsResponse
});

update_item_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct UpdateItemResponse
});
update_item_shape!(shape_from { vault::UpdateItemResponse => UpdateItemResponse });

create_attachment_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct CreateAttachmentResponse
});
create_attachment_shape!(shape_from {
    vault::CreateAttachmentResponse => CreateAttachmentResponse
});

vault_list_entry_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct VaultListEntryResponse
});
vault_list_entry_shape!(shape_from {
    vault::VaultListEntryResponse => VaultListEntryResponse
});

attachment_shape! {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct VaultAttachmentResponse {}
}

impl From<vault::VaultAttachmentResponse> for VaultAttachmentResponse {
    fn from(value: vault::VaultAttachmentResponse) -> Self {
        Self::compose(value.decompose().0)
    }
}

vault_summary_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct VaultSummaryResponse
});
vault_summary_shape!(shape_from { vault::VaultSummaryResponse => VaultSummaryResponse });

item_shape! {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct VaultItemResponse {}
}

impl From<vault::VaultItemResponse> for VaultItemResponse {
    fn from(value: vault::VaultItemResponse) -> Self {
        Self::compose(value.decompose().0)
    }
}

item_shape! {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct VaultItemDetailsResponse {
        attachments: Vec<VaultAttachmentResponse>,
    }
}

impl From<vault::VaultItemDetailsResponse> for VaultItemDetailsResponse {
    fn from(value: vault::VaultItemDetailsResponse) -> Self {
        let (item, (attachments,)) = value.decompose();
        Self::compose(item, attachments.into_iter().map(Into::into).collect())
    }
}

item_shape! {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct DeletedVaultItemWithVaultResponse {
        vault: Option<VaultSummaryResponse>,
    }
}

impl From<vault::DeletedVaultItemWithVaultResponse> for DeletedVaultItemWithVaultResponse {
    fn from(value: vault::DeletedVaultItemWithVaultResponse) -> Self {
        let (item, (vault,)) = value.decompose();
        Self::compose(item, vault.map(Into::into))
    }
}

vault_member_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct VaultMemberResponse
});
vault_member_shape!(shape_from { vault::VaultMemberResponse => VaultMemberResponse });

vault_available_member_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct VaultAvailableMemberResponse
});
vault_available_member_shape!(shape_from {
    vault::VaultAvailableMemberResponse => VaultAvailableMemberResponse
});

attachment_download_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct AttachmentDownloadResponse
});
attachment_download_shape!(shape_from {
    vault::AttachmentDownloadResponse => AttachmentDownloadResponse
});

vault_details_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct VaultDetailsResponseDto
}, count = DecimalString);
vault_details_shape!(shape_from {
    vault::VaultDetailsResponse => VaultDetailsResponseDto
}, count = DecimalString);

vault_stats_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct VaultStatsResponseDto
}, count = DecimalString);
vault_stats_shape!(shape_from {
    vault::VaultStatsResponse => VaultStatsResponseDto
}, count = DecimalString);

item_shape! {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct ItemResponseDto {}
}

impl From<vault::VaultItemDetailsResponse> for ItemResponseDto {
    fn from(value: vault::VaultItemDetailsResponse) -> Self {
        // `GET /items/{itemId}` deliberately omits attachments; `listAttachments` serves them.
        Self::compose(value.decompose().0)
    }
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
            ErrorCode::FieldCannotBeCleared,
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
        .map_err(|_| {
            ApiError::bad_request(ErrorCode::InvalidIfMatch, "If-Match is not valid UTF-8.")
        })?;
    if value.starts_with("W/") || value.contains(',') || value == "*" {
        return Err(ApiError::bad_request(
            ErrorCode::InvalidIfMatch,
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
                ErrorCode::InvalidIfMatch,
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
        HeaderValue::from_str(&format!("\"{version}\"")).map_err(|_| {
            ApiError::bad_request(ErrorCode::InvalidVersion, "Item version is invalid.")
        })?,
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
    let pool = &state.db_pool;
    let cursor = decode_page_key(
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vaults",
            "",
            &state.config.auth.jwt_secret,
        ),
    )?;
    let values = vault::list_vaults_page(
        pool,
        state.object_storage.as_ref(),
        &auth.session.user_id,
        cursor.as_deref(),
        query_limit(&page)?,
    )
    .await?;
    let source_has_more = values.has_more;
    let values: Vec<VaultListEntryResponse> = values.values.into_iter().map(Into::into).collect();
    Ok(Json(page_prefetched_with_more(
        values,
        source_has_more,
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vaults",
            "",
            &state.config.auth.jwt_secret,
        ),
        |vault| vault.id.clone(),
    )?))
}

#[utoipa::path(get, path = "/vaults/{vaultId}", operation_id = "getVault", tag = "vaults", params(("vaultId" = String, Path)), responses((status = 200, description = "Success", body = VaultDetailsResponseDto), VaultErrorResponses))]
async fn get_vault(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(vault_id): Path<String>,
) -> Result<Json<VaultDetailsResponseDto>, ApiError> {
    let pool = &state.db_pool;
    Ok(Json(
        vault::get_vault(
            pool,
            state.object_storage.as_ref(),
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
    let pool = &state.db_pool;
    let result = vault::create_vault(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::CreateVaultInput {
            vault_id: Some(vault_id),
            name: body.name,
            vault_type: body.vault_type,
            encrypted_vault_key: body.encrypted_vault_key,
            icon: body.icon,
            image_key: body.image_key,
            client_id: auth.effective_client_id(),
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
    let pool = &state.db_pool;
    let result = vault::update_vault(
        pool,
        state.object_storage.as_ref(),
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::UpdateVaultInput {
            vault_id,
            name,
            icon,
            image_key,
            client_id: auth.effective_client_id(),
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
    let pool = &state.db_pool;
    let result = vault::convert_vault_type(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::ConvertVaultTypeInput {
            vault_id,
            target_type: body.target_type,
            personal_encrypted_vault_key: body.personal_encrypted_vault_key,
            client_id: auth.effective_client_id(),
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
    let pool = &state.db_pool;
    let result = vault::delete_vault(
        pool,
        state.object_storage.as_ref(),
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
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
    let pool = &state.db_pool;
    Ok(Json(
        vault::create_vault_image_upload(
            pool,
            state.object_storage.as_ref(),
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
    let pool = &state.db_pool;
    let cursor = decode_page_key(
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vault-items",
            &vault_id,
            &state.config.auth.jwt_secret,
        ),
    )?
    .map(|key| timestamp_cursor_key(&key))
    .transpose()?;
    let limit = query_limit(&page)?;
    let values = vault::list_vault_items_page(
        pool,
        state.config.server.mode,
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
        CursorContext::new(
            &auth.session.user_id,
            "vault-items",
            &vault_id,
            &state.config.auth.jwt_secret,
        ),
        |item| format!("{}\0{}", item.updated_at, item.id),
    )?))
}

#[utoipa::path(get, path = "/items", operation_id = "listAllItems", tag = "items", params(AllItemsQuery), responses((status = 200, description = "Accessible active or trashed items", body = AllItemsResponse), VaultErrorResponses))]
async fn list_all_items(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    ApiQuery(query): ApiQuery<AllItemsQuery>,
) -> Result<Json<AllItemsResponse>, ApiError> {
    let pool = &state.db_pool;
    let state_filter = query.state.as_deref().unwrap_or("active");
    let page = PageRequest {
        cursor: query.cursor,
        limit: query.limit,
    };
    match state_filter {
        "active" => {
            let cursor = decode_page_key(
                &page,
                CursorContext::new(
                    &auth.session.user_id,
                    "items",
                    state_filter,
                    &state.config.auth.jwt_secret,
                ),
            )?
            .map(|key| timestamp_cursor_key(&key))
            .transpose()?;
            let values = vault::list_all_vault_items_page(
                pool,
                state.object_storage.as_ref(),
                state.config.server.mode,
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
                    CursorContext::new(
                        &auth.session.user_id,
                        "items",
                        state_filter,
                        &state.config.auth.jwt_secret,
                    ),
                    |item| format!("{}\0{}", item.updated_at, item.id),
                )?
                .into(),
            ))
        }
        "trashed" => {
            let cursor = decode_page_key(
                &page,
                CursorContext::new(
                    &auth.session.user_id,
                    "items",
                    state_filter,
                    &state.config.auth.jwt_secret,
                ),
            )?
            .map(|key| timestamp_cursor_key(&key))
            .transpose()?;
            let values = vault::list_all_deleted_vault_items_page(
                pool,
                state.object_storage.as_ref(),
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
                    CursorContext::new(
                        &auth.session.user_id,
                        "items",
                        state_filter,
                        &state.config.auth.jwt_secret,
                    ),
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
            ErrorCode::InvalidItemState,
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
    let cursor = decode_page_key(
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "items",
            "trashed",
            &state.config.auth.jwt_secret,
        ),
    )?
    .map(|key| timestamp_cursor_key(&key))
    .transpose()?;
    let values = vault::list_all_deleted_vault_items_page(
        &state.db_pool,
        state.object_storage.as_ref(),
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
        CursorContext::new(
            &auth.session.user_id,
            "items",
            "trashed",
            &state.config.auth.jwt_secret,
        ),
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
    let pool = &state.db_pool;
    let filter = format!("{vault_id}:trashed");
    let cursor = decode_page_key(
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "vault-items",
            &filter,
            &state.config.auth.jwt_secret,
        ),
    )?
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
        CursorContext::new(
            &auth.session.user_id,
            "vault-items",
            &filter,
            &state.config.auth.jwt_secret,
        ),
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
    let pool = &state.db_pool;
    let item: ItemResponseDto = vault::get_vault_item(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        vault::ItemIdInput { item_id },
    )
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
    ApiJsonBytes { value: body, bytes }: ApiJsonBytes<CreateItemBody, ITEM_BODY_LIMIT_BYTES>,
) -> Result<Response, ApiError> {
    check_ciphertext(&body.encrypted_data)?;
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/vaults/{vault_id}/items/{item_id}");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "PUT",
        &route_target,
        &bytes,
        |operation_pool, operation_principal_id| async move {
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
    let pool = &state.db_pool;
    let result = vault::bulk_import_vault_items(
        pool,
        &auth.session.user_id,
        vault::BulkImportItemsInput {
            vault_id,
            client_id: auth.effective_client_id(),
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
    ApiMergePatchBytes { value: body, bytes }: ApiMergePatchBytes<
        UpdateItemBody,
        ITEM_BODY_LIMIT_BYTES,
    >,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let encrypted_data = optional_patch_value(body.encrypted_data, "/encryptedData")?;
    let encryption_iv = optional_patch_value(body.encryption_iv, "/encryptionIv")?;
    let encryption_algorithm =
        optional_patch_value(body.encryption_algorithm, "/encryptionAlgorithm")?;
    if let Some(value) = encrypted_data.as_deref() {
        check_ciphertext(value)?;
    }
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/items/{item_id}");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "PATCH",
        &route_target,
        &bytes,
        |operation_pool, operation_principal_id| async move {
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
    ApiMergePatchBytes { value: body, bytes }: ApiMergePatchBytes<
        FavoriteBody,
        ITEM_BODY_LIMIT_BYTES,
    >,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let client_id = auth.effective_client_id();
    let pool = state.db_pool.clone();
    let route_target = format!("/api/v1/items/{item_id}/favorite");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "PATCH",
        &route_target,
        &bytes,
        |operation_pool, operation_principal_id| async move {
            let result = vault::toggle_vault_favorite(
                &operation_pool,
                &operation_principal_id,
                vault::ToggleFavoriteInput {
                    item_id,
                    favorite: body.favorite,
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

#[utoipa::path(delete, path = "/items/{itemId}", operation_id = "trashItem", tag = "items", params(("itemId" = String, Path), ("If-Match" = String, Header, description = "Strong item version ETag"), ("Idempotency-Key" = Option<String>, Header, description = "Replays the same queued mutation outcome for 24 hours when preconditions match")), responses((status = 200, description = "Success", body = SuccessResponse, headers(("ETag" = String, description = "Updated strong item version validator"), ("Idempotency-Replayed" = String, description = "true when this is a stored replay"))), VaultErrorResponses))]
async fn delete_item(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    headers: HeaderMap,
    Path(item_id): Path<String>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/items/{item_id}");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "DELETE",
        &route_target,
        &[],
        |operation_pool, operation_principal_id| async move {
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
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/items/{item_id}/restore");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "POST",
        &route_target,
        &[],
        |operation_pool, operation_principal_id| async move {
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
    ApiJsonBytes { value: body, bytes }: ApiJsonBytes<MoveItemBody, ITEM_BODY_LIMIT_BYTES>,
) -> Result<Response, ApiError> {
    let expected_version = required_item_version(&headers)?;
    check_ciphertext(&body.encrypted_data)?;
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/items/{item_id}/moves");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "POST",
        &route_target,
        &bytes,
        |operation_pool, operation_principal_id| async move {
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
    let pool = state.db_pool.clone();
    let client_id = auth.effective_client_id();
    let route_target = format!("/api/v1/items/{item_id}/permanent");
    idempotency::execute(
        pool,
        &headers,
        auth.session.user_id.clone(),
        "DELETE",
        &route_target,
        &[],
        |operation_pool, operation_principal_id| async move {
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
    let pool = &state.db_pool;
    Ok(Json(
        vault::get_vault_stats(pool, &auth.session.user_id)
            .await?
            .into(),
    ))
}

#[utoipa::path(post, path = "/items/{itemId}/attachment-uploads", operation_id = "createAttachmentUpload", tag = "attachments", params(("itemId" = String, Path)), request_body = AttachmentUploadBody, responses((status = 200, description = "Success", body = AttachmentUploadResponse), VaultErrorResponses))]
async fn create_attachment_upload(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(item_id): Path<String>,
    ApiJson(body): ApiJson<AttachmentUploadBody>,
) -> Result<Json<AttachmentUploadResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::create_vault_attachment_upload(
        pool,
        state.object_storage.as_ref(),
        &state.config.storage.attachment_upload_secret,
        state.config.server.mode,
        &auth.session.user_id,
        vault::CreateAttachmentUploadInput {
            item_id,
            file_name: body.file_name,
            content_type: body.content_type,
            file_size: body.file_size,
        },
    )
    .await?;
    Ok(Json(AttachmentUploadResponse {
        attachment_id: result.attachment_id,
        key: result.storage_key,
        upload_url: result.upload_url,
    }))
}

#[utoipa::path(post, path = "/items/{itemId}/attachments", operation_id = "createAttachment", tag = "attachments", params(("itemId" = String, Path)), request_body = CreateAttachmentBody, responses((status = 200, description = "Success", body = CreateAttachmentResponse), VaultErrorResponses))]
async fn create_attachment(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(item_id): Path<String>,
    ApiJson(body): ApiJson<CreateAttachmentBody>,
) -> Result<Json<CreateAttachmentResponse>, ApiError> {
    let pool = &state.db_pool;
    let result = vault::create_vault_attachment(
        pool,
        state.object_storage.as_ref(),
        &state.config.storage.attachment_upload_secret,
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::CreateAttachmentInput {
            item_id,
            attachment_id: body.attachment_id,
            storage_key: body.storage_key,
            encrypted_attachment_key: body.encrypted_attachment_key,
            attachment_key_iv: body.attachment_key_iv,
            attachment_key_algorithm: body.attachment_key_algorithm,
            envelope_version: body.envelope_version,
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
    let pool = &state.db_pool;
    let cursor = decode_page_key(
        &page,
        CursorContext::new(
            &auth.session.user_id,
            "attachments",
            &item_id,
            &state.config.auth.jwt_secret,
        ),
    )?
    .map(|key| timestamp_cursor_key(&key))
    .transpose()?;
    let values = vault::list_vault_attachments_page(
        pool,
        state.config.server.mode,
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
        CursorContext::new(
            &auth.session.user_id,
            "attachments",
            &item_id,
            &state.config.auth.jwt_secret,
        ),
        |attachment| format!("{}\0{}", attachment.created_at, attachment.id),
    )?))
}

#[utoipa::path(post, path = "/attachments/{attachmentId}/download-urls", operation_id = "createAttachmentDownloadUrl", tag = "attachments", params(("attachmentId" = String, Path)), responses((status = 200, description = "Success", body = AttachmentDownloadResponse), VaultErrorResponses))]
async fn create_attachment_download_url(
    State(state): State<AppState>,
    auth: AuthenticatedRequest,
    Path(attachment_id): Path<String>,
) -> Result<Json<AttachmentDownloadResponse>, ApiError> {
    let pool = &state.db_pool;
    Ok(Json(
        vault::get_attachment_download_url(
            pool,
            state.object_storage.as_ref(),
            state.config.server.mode,
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
    let pool = &state.db_pool;
    let result = vault::update_vault_attachment(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
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
    let pool = &state.db_pool;
    let result = vault::delete_vault_attachment(
        pool,
        state.object_storage.as_ref(),
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
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
    let pool = &state.db_pool;
    let values = vault::list_vault_members(
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
        CursorContext::new(
            &auth.session.user_id,
            "vault-members",
            &vault_id,
            &state.config.auth.jwt_secret,
        ),
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
    let pool = &state.db_pool;
    let values = vault::available_team_members(
        pool,
        state.config.server.mode,
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
        CursorContext::new(
            &auth.session.user_id,
            "available-vault-members",
            &vault_id,
            &state.config.auth.jwt_secret,
        ),
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
    let pool = &state.db_pool;
    let result = vault::add_vault_member(
        pool,
        state.config.server.mode,
        &auth.session.user_id,
        auth.effective_client_id().as_deref(),
        vault::AddVaultMemberInput {
            vault_id,
            user_id,
            role: body.role,
            encrypted_vault_key: body.encrypted_vault_key,
            client_id: auth.effective_client_id(),
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
    let pool = &state.db_pool;
    let result = vault::update_vault_member_role(
        pool,
        state.config.server.mode,
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
        .routes(routes!(available_team_members));
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

    use super::{
        check_bulk_import, check_ciphertext, nullable_patch_value, router, AllItemsResponse,
        BulkImportBody, BulkImportItemInput, FavoriteBody, ItemCategory, UpdateVaultBody,
        VaultItemDetailsResponse, VaultStatsResponseDto, ITEM_BODY_LIMIT_BYTES,
    };
    use crate::{
        http::api::{
            dto::{CursorPage, PatchField},
            extract::ApiJsonBytes,
        },
        services::vault::{
            DeletedVaultItemWithVaultResponse, VaultItemWithVaultResponse, VaultStatsResponse,
        },
    };

    fn item(ciphertext: String) -> BulkImportItemInput {
        BulkImportItemInput {
            item_id: "item_test".to_string(),
            category: ItemCategory::Login,
            favorite: None,
            encrypted_data: ciphertext,
            encryption_iv: "iv".to_string(),
            encryption_algorithm: "AES-GCM-AAD-V1".to_string(),
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
        let error = ApiJsonBytes::<FavoriteBody, ITEM_BODY_LIMIT_BYTES>::from_request(request, &())
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
    }

    /// The two types now share one field list, so their schemas can no longer drift apart and the
    /// schema half of this check is gone. Serialization is still worth pinning: the shape does not
    /// fix `rename_all`, and only the transport side is published.
    #[test]
    fn vault_item_wire_dto_preserves_service_serialization() {
        let service = crate::services::vault::VaultItemDetailsResponse {
            id: "item_test".to_string(),
            vault_id: "vault_test".to_string(),
            category: ItemCategory::Login,
            favorite: true,
            encrypted_data: "ciphertext".to_string(),
            encryption_iv: "iv".to_string(),
            encryption_algorithm: "aes-gcm".to_string(),
            version: 7,
            encryption_version: 3,
            encrypted_by_user_id: "user_test".to_string(),
            last_modified_by: "user_test".to_string(),
            created_at: "2026-08-10T00:00:00Z".to_string(),
            updated_at: "2026-08-10T00:01:00Z".to_string(),
            deleted_at: None,
            attachments: vec![crate::services::vault::VaultAttachmentResponse {
                id: "attachment_test".to_string(),
                item_id: "item_test".to_string(),
                vault_id: "vault_test".to_string(),
                storage_key: "attachments/test".to_string(),
                encrypted_attachment_key: "attachment-key".to_string(),
                attachment_key_iv: "attachment-key-iv".to_string(),
                attachment_key_algorithm: "aes-gcm".to_string(),
                envelope_version: 1,
                encrypted_name: "name".to_string(),
                encrypted_content_type: "type".to_string(),
                encryption_iv: "attachment-iv".to_string(),
                encrypted_content_type_iv: "content-type-iv".to_string(),
                encryption_algorithm: "aes-gcm".to_string(),
                file_size: 128,
                uploaded_by: "user_test".to_string(),
                created_at: "2026-08-10T00:00:00Z".to_string(),
            }],
        };
        let expected_json = serde_json::to_value(&service).unwrap();
        let wire = VaultItemDetailsResponse::from(service);

        assert_eq!(serde_json::to_value(wire).unwrap(), expected_json);
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
                category: ItemCategory::Login,
                favorite: false,
                encrypted_data: "ciphertext".to_string(),
                encryption_iv: "iv".to_string(),
                encryption_algorithm: "aes-gcm".to_string(),
                version: 1,
                encryption_version: 1,
                encrypted_by_user_id: "user_test".to_string(),
                last_modified_by: "user_test".to_string(),
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
                category: ItemCategory::Login,
                favorite: false,
                encrypted_data: "ciphertext".to_string(),
                encryption_iv: "iv".to_string(),
                encryption_algorithm: "aes-gcm".to_string(),
                version: 2,
                encryption_version: 1,
                encrypted_by_user_id: "user_test".to_string(),
                last_modified_by: "user_test".to_string(),
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

    /// The item variants share one field list via `item_shape!`. Expressing that with
    /// `#[serde(flatten)]` instead would make utoipa emit `{"allOf": [{"$ref": ...}]}`, rewriting
    /// every item schema in the committed contract without changing a single byte on the wire.
    #[test]
    fn item_schemas_stay_inline_objects_carrying_the_canonical_field_set() {
        let openapi = serde_json::to_value(router().split_for_parts().1).unwrap();
        let canonical = [
            "id",
            "vaultId",
            "category",
            "favorite",
            "encryptedData",
            "encryptionIv",
            "encryptionAlgorithm",
            "version",
            "encryptionVersion",
            "encryptedByUserId",
            "lastModifiedBy",
            "createdAt",
            "updatedAt",
            "deletedAt",
        ];

        for name in [
            "AllItemResponse",
            "VaultItemResponse",
            "VaultItemDetailsResponse",
            "DeletedVaultItemWithVaultResponse",
            "ItemResponseDto",
        ] {
            let schema = &openapi["components"]["schemas"][name];
            assert_eq!(
                schema["type"], "object",
                "{name} must stay an inline object"
            );
            assert!(schema.get("allOf").is_none(), "{name} must not use allOf");
            for field in canonical {
                assert!(
                    schema["properties"].get(field).is_some(),
                    "{name} is missing {field}"
                );
            }
        }

        // `getItem` deliberately omits attachments; `listAttachments` serves them separately.
        assert!(
            openapi["components"]["schemas"]["ItemResponseDto"]["properties"]
                .get("attachments")
                .is_none()
        );
    }

    #[test]
    fn router_registers_all_used_vault_operations_only() {
        let openapi = serde_json::to_value(router().split_for_parts().1).unwrap();
        let rendered = openapi.to_string();
        assert_eq!(rendered.matches("operationId").count(), 31);
        assert!(rendered.contains("listAllTrashedItems"));
        assert!(rendered.contains("/items/trashed"));
        assert!(!rendered.contains("lookupUser"));
        assert!(rendered.contains("If-Match"));
        assert!(rendered.contains("428"));
        assert!(rendered.contains("412"));
    }
}
