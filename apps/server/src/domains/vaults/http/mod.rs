use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{header::ETAG, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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
        middleware::NEXT_CURSOR_HEADER,
        openapi::ORDINARY_API_BODY_LIMIT_BYTES,
        pagination::{
            decode_page_key, page_prefetched, page_prefetched_with_more, page_values, query_limit,
            timestamp_cursor_key, ApiPageQuery, CursorContext,
        },
    },
    shapes::{
        attachment_download_shape, attachment_shape, bulk_import_item_shape,
        convert_vault_type_shape, create_attachment_shape, item_shape, update_vault_shape,
        vault_available_member_shape, vault_details_shape, vault_list_entry_shape,
        vault_member_shape, vault_stats_shape, vault_summary_shape,
    },
    AppState,
};

mod attachments;
mod catalog;
mod items;
mod members;
pub(crate) mod rotation;
pub(crate) mod travel_mode;
mod vault_image_staging;

pub(crate) const ITEM_BODY_LIMIT_BYTES: usize = ITEM_CIPHERTEXT_BYTES as usize + 64 * 1024;

/// The largest Import request body this Server will read.
///
/// It is deliberately *not* `BULK_IMPORT_ITEMS * ITEM_CIPHERTEXT_BYTES`, which would be about
/// 200 MiB. A `413` here carries no Operation outcome, so the Client Runtime bounds one accepted
/// batch's frozen request bytes below this limit at accept time instead — see
/// `MAX_IMPORT_REQUEST_BYTES` in `runtime/import.rs`, guarded on this side by
/// `import_request_bounds_match_the_runtime_batch_derivation`.
pub(crate) const BULK_IMPORT_BODY_LIMIT_BYTES: usize = BULK_IMPORT_BYTES as usize;

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateVaultBody {
    #[schema(min_length = 2, max_length = 200)]
    name: String,
    vault_type: VaultType,
    #[schema(max_length = 65536)]
    encrypted_vault_key: String,
    #[schema(min_length = 1, max_length = 128)]
    icon: String,
    image_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VaultImageStagingBody {
    vault_id: String,
    byte_length: i64,
    content_type: VaultImageContentType,
    sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, ToSchema)]
enum VaultImageContentType {
    #[serde(rename = "image/jpeg")]
    Jpeg,
    #[serde(rename = "image/png")]
    Png,
    #[serde(rename = "image/webp")]
    Webp,
    #[serde(rename = "image/gif")]
    Gif,
    #[serde(rename = "image/avif")]
    Avif,
}

impl VaultImageContentType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Webp => "image/webp",
            Self::Gif => "image/gif",
            Self::Avif => "image/avif",
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultImageStagingGrantResponse {
    object_key: String,
    upload_url: String,
    generation: i64,
    lease_expires_at: String,
    upload_headers: Vec<VaultImageStagingUploadHeader>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct VaultImageStagingUploadHeader {
    name: String,
    value: String,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum VaultImageStagingStatusResponse {
    Absent {},
    Unconfirmed {
        #[serde(rename = "objectKey")]
        object_key: String,
        generation: i64,
        #[serde(rename = "leaseExpiresAt")]
        lease_expires_at: String,
    },
    Confirmed {
        #[serde(rename = "objectKey")]
        object_key: String,
        generation: i64,
        #[serde(rename = "leaseExpiresAt")]
        lease_expires_at: String,
    },
    CleanupPending {
        #[serde(rename = "objectKey")]
        object_key: String,
        generation: i64,
        #[serde(rename = "leaseExpiresAt")]
        lease_expires_at: String,
    },
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

/// The Item identities one authority page asks for, plus where to continue.
// The identity set travels in a request body because up to 200 identities do not belong in a
// query string. `get_item_authority_page` records the rest of the reasoning; it stays out of the
// published contract, which describes vocabulary rather than Server internals.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemAuthorityPageBody {
    #[schema(max_items = 200)]
    item_ids: Vec<String>,
    #[serde(default)]
    cursor: Option<PageCursor>,
    #[serde(default = "default_item_authority_page_limit")]
    #[schema(minimum = 1, maximum = 200, default = 200)]
    limit: u16,
}

fn default_item_authority_page_limit() -> u16 {
    BULK_IMPORT_ITEMS
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
#[serde(
    tag = "mode",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum MoveItemBody {
    Prepared {
        #[serde(rename = "sourceVaultId")]
        source_vault_id: String,
        #[serde(rename = "targetVaultId")]
        target_vault_id: String,
        #[serde(rename = "encryptedData")]
        #[schema(max_length = 1048576)]
        encrypted_data: String,
        #[serde(rename = "encryptionIv")]
        encryption_iv: String,
        #[serde(rename = "encryptionAlgorithm")]
        encryption_algorithm: String,
        #[serde(default)]
        attachments: Vec<MoveAttachmentBody>,
    },
    RejectStaleAuthority {
        #[serde(rename = "sourceVaultId")]
        source_vault_id: String,
        #[serde(rename = "targetVaultId")]
        target_vault_id: String,
        attachments: Vec<MoveAttachmentIntentBody>,
    },
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveAttachmentBody {
    attachment_id: String,
    expected_envelope_version: i32,
    encrypted_attachment_key: String,
    attachment_key_iv: String,
    attachment_key_algorithm: String,
    encrypted_name: String,
    encrypted_content_type: String,
    encryption_iv: String,
    encrypted_content_type_iv: String,
    encryption_algorithm: String,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveAttachmentIntentBody {
    attachment_id: String,
    expected_envelope_version: i32,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentMoveManifestBody {
    item_id: String,
    source_vault_id: String,
    target_vault_id: String,
    attachments: Vec<AttachmentMoveManifestEntryBody>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentMoveManifestEntryBody {
    attachment_id: String,
    envelope_version: i32,
    #[schema(min_length = 64, max_length = 64, pattern = "^[0-9a-f]{64}$")]
    ciphertext_sha256: String,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct AttachmentMoveManifestResponse {
    operation_id: String,
    expires_at: String,
    attachments: Vec<AttachmentMoveUploadResponse>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
struct AttachmentMoveUploadResponse {
    attachment_id: String,
    storage_key: String,
    upload_url: String,
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

/// The one Import refusal that is not a retained decision.
///
/// A batch beyond the published Item bound is malformed, not state-dependent: retrying the same
/// bytes can never make it valid, and no closed Import rejection code describes it. It is also
/// unreachable from a Client Runtime, which refuses both an over-count batch (`MAX_IMPORT_ITEMS`)
/// and an over-byte batch (`MAX_IMPORT_REQUEST_BYTES`) at accept time, so no accepted Operation
/// can meet this refusal and be left retrying a status that carries no outcome.
///
/// An oversized ciphertext is different: it reaches the executor and becomes
/// `invalid_ciphertext`, a terminal answer the Runtime can retain and replay.
fn check_bulk_import(body: &BulkImportBody) -> Result<(), ApiError> {
    if body.items.len() > BULK_IMPORT_ITEMS as usize {
        return Err(ApiError::payload_too_large(format!(
            "Bulk imports cannot contain more than {BULK_IMPORT_ITEMS} items."
        )));
    }
    Ok(())
}

fn check_item_authority_page_limit(limit: u16) -> Result<u16, ApiError> {
    if limit == 0 || limit > BULK_IMPORT_ITEMS {
        return Err(ApiError::bad_request(
            ErrorCode::InvalidPageLimit,
            format!("limit must be between 1 and {BULK_IMPORT_ITEMS}"),
        ));
    }
    Ok(limit)
}

/// A published bound is the bound a request actually hits, so the schema's `maxItems` is enforced
/// here rather than only documented. One authority read answers at most one Import batch, and
/// `check_bulk_import` holds the same number on the sibling Import route.
fn check_item_authority_page_ids(item_ids: &[String]) -> Result<(), ApiError> {
    if item_ids.len() > BULK_IMPORT_ITEMS as usize {
        return Err(ApiError::bad_request(
            ErrorCode::InvalidRequest,
            format!("An authority page cannot name more than {BULK_IMPORT_ITEMS} Items."),
        ));
    }
    Ok(())
}

/// Binds one authority cursor to the exact identity set it was issued for.
///
/// Two things make an authority page mean what it means: the Vault and the Item identities asked
/// for. Both belong in the cursor's filters, or a cursor issued for one set could be replayed
/// against a different set in the same Vault and silently skip past Items the caller named.
/// `cursor_rejects_tampering_principal_endpoint_and_filters` is the rule this follows.
fn item_authority_cursor_filters(vault_id: &str, item_ids: &[String]) -> String {
    let mut identities: Vec<&str> = item_ids.iter().map(String::as_str).collect();
    identities.sort_unstable();
    identities.dedup();
    let mut digest = Sha256::new();
    for identity in identities {
        digest.update((identity.len() as u64).to_be_bytes());
        digest.update(identity.as_bytes());
    }
    format!("{vault_id}\0{}", hex::encode(digest.finalize()))
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
        status = 409,
        description = "Attachment Move staging is incomplete",
        content_type = "application/problem+json"
    )]
    Conflict(ProblemDetails),
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
        // A read that names its Items in a body; see `items::get_item_authority_page`.
        .routes(routes!(items::get_item_authority_page))
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
        .routes(routes!(vault_image_staging::grant))
        .routes(routes!(vault_image_staging::status))
        .routes(routes!(vault_image_staging::confirm))
        .routes(routes!(vault_image_staging::cleanup))
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
        .routes(routes!(items::create_attachment_move_manifest))
        .route_layer(DefaultBodyLimit::max(ITEM_BODY_LIMIT_BYTES));
    let bulk = OpenApiRouter::new()
        .routes(routes!(items::bulk_import_items))
        .route_layer(DefaultBodyLimit::max(BULK_IMPORT_BODY_LIMIT_BYTES));

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
        check_bulk_import, check_item_authority_page_ids, check_item_authority_page_limit,
        item_authority_cursor_filters, nullable_patch_value, router, AllItemsResponse,
        BulkImportBody, BulkImportItemInput, FavoriteBody, ItemCategory, UpdateVaultBody,
        VaultImageContentType, VaultImageStagingBody, VaultImageStagingStatusResponse,
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
    fn vault_image_staging_wire_values_are_closed_and_correlated() {
        for content_type in [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            "image/avif",
        ] {
            let body: VaultImageStagingBody = serde_json::from_value(json!({
                "vaultId": "vault_test",
                "byteLength": 12,
                "contentType": content_type,
                "sha256": "0".repeat(64),
            }))
            .expect("allowed Vault image MIME must decode");
            assert_eq!(body.content_type.as_str(), content_type);
            assert_eq!(
                serde_json::to_value(body.content_type).unwrap(),
                json!(content_type)
            );
        }
        assert!(serde_json::from_value::<VaultImageStagingBody>(json!({
            "vaultId": "vault_test",
            "byteLength": 12,
            "contentType": "image/svg+xml",
            "sha256": "0".repeat(64),
        }))
        .is_err());

        let authority = || {
            (
                "vaults/key".to_string(),
                7_i64,
                "2026-08-31T12:00:00Z".to_string(),
            )
        };
        let values = [
            VaultImageStagingStatusResponse::Absent {},
            VaultImageStagingStatusResponse::Unconfirmed {
                object_key: authority().0,
                generation: authority().1,
                lease_expires_at: authority().2,
            },
            VaultImageStagingStatusResponse::Confirmed {
                object_key: authority().0,
                generation: authority().1,
                lease_expires_at: authority().2,
            },
            VaultImageStagingStatusResponse::CleanupPending {
                object_key: authority().0,
                generation: authority().1,
                lease_expires_at: authority().2,
            },
        ];
        for value in values {
            let encoded = serde_json::to_value(&value).unwrap();
            let decoded: VaultImageStagingStatusResponse =
                serde_json::from_value(encoded.clone()).unwrap();
            assert_eq!(serde_json::to_value(decoded).unwrap(), encoded);
        }
        assert!(
            serde_json::from_value::<VaultImageStagingStatusResponse>(json!({
                "state": "absent",
                "objectKey": "impossible"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<VaultImageStagingStatusResponse>(json!({
                "state": "confirmed"
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<VaultImageContentType>(json!("text/plain")).is_err());
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

    /// Only the Item bound is a request error now; an oversized ciphertext is a retained
    /// `invalid_ciphertext` decision the executor makes, covered by the Import Operation tests.
    #[test]
    fn bulk_import_refuses_only_a_batch_beyond_its_item_bound() {
        let batch = |count: usize| BulkImportBody {
            items: (0..count)
                .map(|index| {
                    let mut value = item("ciphertext".to_string());
                    value.item_id = format!("item_{index}");
                    value
                })
                .collect(),
        };
        assert!(check_bulk_import(&batch(201)).is_err());
        assert!(check_bulk_import(&batch(200)).is_ok());
        assert!(check_bulk_import(&BulkImportBody {
            items: vec![item("a".repeat(1_048_577))],
        })
        .is_ok());
    }

    #[test]
    fn item_authority_page_limit_stays_within_one_import_batch() {
        assert!(check_item_authority_page_limit(0).is_err());
        assert!(check_item_authority_page_limit(1).is_ok());
        assert!(check_item_authority_page_limit(200).is_ok());
        assert!(check_item_authority_page_limit(201).is_err());

        let ids = |count: usize| (0..count).map(|i| format!("item_{i}")).collect::<Vec<_>>();
        assert!(check_item_authority_page_ids(&ids(0)).is_ok());
        assert!(check_item_authority_page_ids(&ids(200)).is_ok());
        assert!(check_item_authority_page_ids(&ids(201)).is_err());
    }

    /// A cursor means "after this Item, in this Vault, among these identities".
    #[test]
    fn item_authority_cursor_filters_bind_the_vault_and_the_identity_set() {
        let set = |ids: &[&str]| {
            item_authority_cursor_filters(
                "vault_1",
                &ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>(),
            )
        };
        assert_eq!(set(&["a", "b"]), set(&["b", "a"]), "order is not identity");
        assert_eq!(
            set(&["a", "a", "b"]),
            set(&["a", "b"]),
            "a set has no duplicates"
        );
        assert_ne!(set(&["a", "b"]), set(&["a"]));
        assert_ne!(
            set(&["ab", "c"]),
            set(&["a", "bc"]),
            "parts are length-prefixed"
        );
        assert_ne!(
            set(&["a"]),
            item_authority_cursor_filters("vault_2", &["a".to_owned()]),
            "the Vault stays part of the filters"
        );
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
        assert_eq!(rendered.matches("operationId").count(), 47);
        assert!(rendered.contains("listAllTrashedItems"));
        assert!(rendered.contains("getVaultItemAuthorityPage"));
        assert!(rendered.contains("/items/trashed"));
        assert!(!rendered.contains("lookupUser"));
        assert!(rendered.contains("If-Match"));
        assert!(rendered.contains("428"));
        assert!(rendered.contains("412"));
    }
}
