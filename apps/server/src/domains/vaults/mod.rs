use serde::{Deserialize, Serialize};

use crate::{
    db::enums::{CreateItemRejectionCode, ItemCategory, VaultRole, VaultType},
    shapes::{
        attachment_download_shape, attachment_shape, bulk_import_item_shape,
        bulk_import_result_shape, convert_vault_type_shape, create_attachment_shape,
        create_vault_shape, item_shape, success_shape, update_item_shape, update_vault_shape,
        vault_available_member_shape, vault_details_shape, vault_list_entry_shape,
        vault_member_shape, vault_stats_shape, vault_summary_shape,
    },
};

pub(crate) const VAULT_NAME_MAX_CHARS: usize = 200;

mod access;
mod attachments;
mod catalog;
mod favicon;
pub(crate) mod http;
mod items;
pub(crate) mod key;
mod members;
mod pagination;
pub(crate) mod rotation;
pub(crate) mod shapes;
pub(crate) mod travel_mode;

pub(crate) use attachments::{
    create_vault_attachment, create_vault_attachment_upload, delete_vault_attachment,
    get_attachment_download_url, list_vault_attachments_page, update_vault_attachment,
};
pub(crate) use catalog::{
    convert_vault_type, create_vault, create_vault_image_upload, delete_vault, get_vault,
    get_vault_stats, list_vaults_page, update_vault,
};
pub(crate) use favicon::{fetch_and_store_favicon, get_fetched_favicon, list_domains_to_refresh};
pub(crate) use items::{
    apply_create_item, bulk_import_vault_items, delete_vault_item, get_vault_item,
    list_all_deleted_vault_items_page, list_all_vault_items_page, list_deleted_vault_items_page,
    list_vault_items_page, move_vault_item, permanently_delete_vault_item, restore_vault_item,
    toggle_vault_favorite, update_vault_item,
};
pub(crate) use members::{
    add_vault_member, available_team_members, list_vault_members, update_vault_member_role,
};
pub(crate) use pagination::ByteBoundedPage;

#[cfg(test)]
use access::assert_item_write_access;
#[cfg(test)]
use attachments::{
    attachment_quota_lock_key, base64_encoded_length, encrypted_attachment_storage_size,
    pending_attachment_upload_expiry,
};

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct VaultIdInput {
    pub vault_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateVaultImageUploadInput {
    pub vault_id: Option<String>,
    pub file_name: String,
    pub content_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ItemIdInput {
    pub item_id: String,
}

pub(crate) struct CreateItemEffectInput {
    pub(crate) item_id: String,
    pub(crate) vault_id: String,
    pub(crate) category: ItemCategory,
    pub(crate) encrypted_data: String,
    pub(crate) encryption_iv: String,
    pub(crate) encryption_algorithm: String,
    pub(crate) client_id: Option<String>,
    pub(crate) ciphertext_limit: usize,
}

pub(crate) enum CreateItemEffect {
    Applied { item_id: String, version: i32 },
    Rejected(CreateItemRejectionCode),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateAttachmentUploadInput {
    pub item_id: String,
    pub file_name: String,
    pub content_type: String,
    pub file_size: i32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateAttachmentInput {
    pub item_id: String,
    pub attachment_id: String,
    pub storage_key: String,
    pub encrypted_attachment_key: String,
    pub attachment_key_iv: String,
    pub attachment_key_algorithm: String,
    pub envelope_version: i32,
    pub encrypted_name: String,
    pub encrypted_content_type: String,
    pub encryption_iv: String,
    pub encrypted_content_type_iv: String,
    pub encryption_algorithm: String,
    pub file_size: i32,
}

create_attachment_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CreateAttachmentResponse
});

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct AttachmentIdInput {
    pub attachment_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateAttachmentInput {
    pub attachment_id: String,
    pub encrypted_name: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAttachmentUploadResponse {
    pub attachment_id: String,
    pub storage_key: String,
    pub upload_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateVaultMemberRoleInput {
    pub vault_id: String,
    pub user_id: String,
    pub role: VaultRole,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct AddVaultMemberInput {
    pub vault_id: String,
    pub user_id: String,
    pub role: VaultRole,
    pub encrypted_vault_key: String,
    pub client_id: Option<String>,
}

bulk_import_item_shape!(service_struct {
    #[derive(Debug, Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[serde(deny_unknown_fields)]
    pub struct BulkImportItemInput
});

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct BulkImportItemsInput {
    pub vault_id: String,
    pub client_id: Option<String>,
    pub items: Vec<BulkImportItemInput>,
}

bulk_import_result_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BulkImportItemsResponse
});

#[derive(Debug, Clone, Deserialize)]
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

update_item_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateItemResponse
});

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct MoveItemInput {
    pub item_id: String,
    pub source_vault_id: String,
    pub target_vault_id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
    pub expected_version: Option<i32>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ToggleFavoriteInput {
    pub item_id: String,
    pub favorite: bool,
    pub expected_version: Option<i32>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ItemClientInput {
    pub item_id: String,
    pub expected_version: Option<i32>,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct CreateVaultInput {
    pub vault_id: Option<String>,
    pub name: String,
    pub vault_type: VaultType,
    pub encrypted_vault_key: String,
    pub icon: Option<String>,
    pub image_key: Option<String>,
    pub client_id: Option<String>,
}

item_shape! {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VaultItemResponse {}
}

vault_list_entry_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VaultListEntryResponse
});

vault_details_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VaultDetailsResponse
}, count = i64);

create_vault_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CreateVaultResponse
});

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct UpdateVaultInput {
    pub vault_id: String,
    pub name: Option<String>,
    pub icon: Option<Option<String>>,
    pub image_key: Option<Option<String>>,
    pub client_id: Option<String>,
}

update_vault_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateVaultResponse
});

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct ConvertVaultTypeInput {
    pub vault_id: String,
    pub target_type: VaultType,
    pub personal_encrypted_vault_key: Option<String>,
    pub client_id: Option<String>,
}

convert_vault_type_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ConvertVaultTypeResponse
});

success_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    pub struct SuccessResponse
});

attachment_shape! {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VaultAttachmentResponse {}
}

item_shape! {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VaultItemDetailsResponse {
        attachments: Vec<VaultAttachmentResponse>,
    }
}

vault_summary_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VaultSummaryResponse
});

item_shape! {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VaultItemWithVaultResponse {
        attachments: Vec<VaultAttachmentResponse>,
        vault: Option<VaultSummaryResponse>,
    }
}

item_shape! {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DeletedVaultItemWithVaultResponse {
        vault: Option<VaultSummaryResponse>,
    }
}

vault_stats_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VaultStatsResponse
}, count = i64);

vault_member_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VaultMemberResponse
});

vault_available_member_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct VaultAvailableMemberResponse
});

attachment_download_shape!(service_struct {
    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AttachmentDownloadResponse
});
