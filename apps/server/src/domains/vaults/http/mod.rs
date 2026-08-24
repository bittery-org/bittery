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
    app::NotifySyncExt,
    db::enums::{ItemCategory, VaultRole, VaultType},
    domains::{
        operations::{
            ItemOperationEffect, ItemOperationInput, OperationOutcome, OperationResolution,
        },
        vaults as vault,
    },
    http::{
        dto::{
            CursorPage, DecimalString, PageCursor, PageRequest, PatchField,
            PresignedUploadResponse, ProblemDetails, SuccessResponse, BULK_IMPORT_BYTES,
            BULK_IMPORT_ITEMS, DEFAULT_PAGE_SIZE, ITEM_CIPHERTEXT_BYTES,
        },
        error::ApiError,
        error_code::ErrorCode,
        extractors::{
            ApiJson, ApiJsonBytes, ApiMergePatch, ApiMergePatchBytes, ApiQuery,
            AuthenticatedRequest,
        },
        openapi::ORDINARY_API_BODY_LIMIT_BYTES,
        pagination::{
            decode_page_key, page_prefetched, page_prefetched_with_more, page_values, query_limit,
            timestamp_cursor_key, ApiPageQuery, CursorContext,
        },
    },
    shapes::{
        attachment_download_shape, attachment_shape, bulk_import_item_shape,
        bulk_import_result_shape, convert_vault_type_shape, create_attachment_shape,
        create_vault_shape, item_shape, update_vault_shape, vault_available_member_shape,
        vault_details_shape, vault_list_entry_shape, vault_member_shape, vault_stats_shape,
        vault_summary_shape,
    },
    AppState,
};

mod attachments;
mod catalog;
mod items;
mod members;
pub(crate) mod rotation;
pub(crate) mod travel_mode;

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

bulk_import_result_shape!(wire_struct {
    #[derive(Debug, Serialize, ToSchema)]
    #[serde(rename_all = "camelCase")]
    struct BulkImportItemsResponse
});
bulk_import_result_shape!(shape_from {
    vault::BulkImportItemsResponse => BulkImportItemsResponse
});

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

#[derive(IntoResponses)]
#[allow(dead_code)]
enum ItemOperationErrorResponses {
    #[response(
        status = 400,
        description = "Malformed request or Operation ID",
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
        description = "Operation ID was reused with different immutable request bytes",
        content_type = "application/problem+json"
    )]
    OperationIdReused(ProblemDetails),
    #[response(
        status = 500,
        description = "Internal error",
        content_type = "application/problem+json"
    )]
    Internal(ProblemDetails),
}

/// The transport-level refusals an Item mutation Operation can answer with.
///
/// A mutation adds `428` to the create set because it requires `If-Match`. Every other refusal it
/// can produce is a semantic rejection carried inside a `200` outcome, not a status code.
#[derive(IntoResponses)]
#[allow(dead_code)]
enum ItemMutationOperationErrorResponses {
    #[response(
        status = 400,
        description = "Malformed request, Operation ID, or If-Match",
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
        description = "Operation ID was reused with different immutable request bytes",
        content_type = "application/problem+json"
    )]
    OperationIdReused(ProblemDetails),
    #[response(
        status = 428,
        description = "If-Match is required for this Item mutation",
        content_type = "application/problem+json"
    )]
    PreconditionRequired(ProblemDetails),
    #[response(
        status = 500,
        description = "Internal error",
        content_type = "application/problem+json"
    )]
    Internal(ProblemDetails),
}

pub(crate) fn router() -> OpenApiRouter<AppState> {
    let reads = OpenApiRouter::new()
        .routes(routes!(catalog::list_vaults))
        .routes(routes!(catalog::get_vault))
        .routes(routes!(items::list_items))
        .routes(routes!(items::list_all_items))
        .routes(routes!(items::list_all_trashed_items))
        .routes(routes!(items::list_deleted_items))
        .routes(routes!(items::get_item))
        .routes(routes!(catalog::stats))
        .routes(routes!(attachments::list_attachments))
        .routes(routes!(members::list_members))
        .routes(routes!(members::available_team_members));
    let ordinary_writes = OpenApiRouter::new()
        .routes(routes!(catalog::create_vault))
        .routes(routes!(catalog::update_vault))
        .routes(routes!(catalog::convert_vault))
        .routes(routes!(catalog::delete_vault))
        .routes(routes!(catalog::create_image_upload))
        .routes(routes!(items::set_favorite))
        .routes(routes!(items::delete_item))
        .routes(routes!(items::restore_item))
        .routes(routes!(items::permanently_delete_item))
        .routes(routes!(attachments::create_attachment_upload))
        .routes(routes!(attachments::create_attachment))
        .routes(routes!(attachments::create_attachment_download_url))
        .routes(routes!(attachments::update_attachment))
        .routes(routes!(attachments::delete_attachment))
        .routes(routes!(members::add_member))
        .routes(routes!(members::update_member_role))
        .route_layer(DefaultBodyLimit::max(ORDINARY_API_BODY_LIMIT_BYTES));
    let item_writes = OpenApiRouter::new()
        .routes(routes!(items::create_item))
        .routes(routes!(items::update_item))
        .routes(routes!(items::move_item))
        .route_layer(DefaultBodyLimit::max(ITEM_BODY_LIMIT_BYTES));
    let bulk = OpenApiRouter::new()
        .routes(routes!(items::bulk_import_items))
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
        domains::vaults::{
            DeletedVaultItemWithVaultResponse, VaultItemWithVaultResponse, VaultStatsResponse,
        },
        http::{
            dto::{CursorPage, PatchField},
            extractors::ApiJsonBytes,
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
        let service = crate::domains::vaults::VaultItemDetailsResponse {
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
            attachments: vec![crate::domains::vaults::VaultAttachmentResponse {
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

    /// No Item route may reach the legacy response-cache wrapper any more.
    ///
    /// Rotation still uses it, so `idempotency_record` and its module survive until ticket 29.
    /// This assertion holds the line that the Item half of the migration cannot slip back.
    #[test]
    fn no_item_route_reaches_the_legacy_response_cache() {
        let source = include_str!("items.rs");
        assert!(
            !source.contains("idempotency::execute"),
            "Item routes must resolve through the retained Operation contract"
        );
        assert!(
            include_str!("rotation.rs").contains("idempotency::execute"),
            "this assertion is only meaningful while some caller still exists"
        );
    }

    #[test]
    fn router_registers_all_used_vault_operations_only() {
        let openapi = serde_json::to_value(router().split_for_parts().1).unwrap();
        let rendered = openapi["paths"].to_string();
        // Counted over `paths` alone: the retained Operation outcome schema carries an
        // `operationId` property of its own, and that is a field name, not a route.
        assert_eq!(rendered.matches("operationId").count(), 31);
        assert!(rendered.contains("listAllTrashedItems"));
        assert!(rendered.contains("/items/trashed"));
        assert!(!rendered.contains("lookupUser"));
        assert!(rendered.contains("If-Match"));
        assert!(rendered.contains("428"));
        assert!(rendered.contains("412"));
    }
}
