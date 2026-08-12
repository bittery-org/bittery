//! The item surface: shapes that repeat across a database row, several service response variants
//! and several transport DTOs.
//!
//! These shapes predate the generic emitters in the parent module and keep their own form: a
//! variant is the canonical fields *plus extras*, so each macro also emits `compose` (canonical
//! payload + extras -> variant) and `decompose` (variant -> canonical payload + extras). That is
//! what lets six variants of an item convert into one another without restating a field list.

use crate::{
    config::format_timestamp,
    db::models::{DbBootstrapAttachmentRow, DbBootstrapItemRow},
};

/// Declares a struct carrying the canonical item fields, plus any extra fields the variant adds.
///
/// Also emits `compose` (canonical payload + extras -> variant) and `decompose` (variant ->
/// canonical payload + extras), so conversions between variants never restate a field list.
macro_rules! item_shape {
    (
        $(#[$meta:meta])*
        $vis:vis struct $name:ident {
            $( $(#[$extra_meta:meta])* $extra:ident : $extra_ty:ty ),* $(,)?
        }
    ) => {
        $(#[$meta])*
        $vis struct $name {
            $vis id: String,
            $vis vault_id: String,
            $vis category: $crate::db::enums::ItemCategory,
            $vis favorite: bool,
            $vis encrypted_data: String,
            $vis encryption_iv: String,
            $vis encryption_algorithm: String,
            $vis version: i32,
            $vis encryption_version: i32,
            $vis encrypted_by_user_id: String,
            $vis last_modified_by: String,
            $vis created_at: String,
            $vis updated_at: String,
            $vis deleted_at: Option<String>,
            $( $(#[$extra_meta])* $vis $extra: $extra_ty, )*
        }

        impl $name {
            #[allow(dead_code)]
            $vis fn compose(
                payload: $crate::shapes::ItemPayload,
                $($extra: $extra_ty,)*
            ) -> Self {
                Self {
                    id: payload.id,
                    vault_id: payload.vault_id,
                    category: payload.category,
                    favorite: payload.favorite,
                    encrypted_data: payload.encrypted_data,
                    encryption_iv: payload.encryption_iv,
                    encryption_algorithm: payload.encryption_algorithm,
                    version: payload.version,
                    encryption_version: payload.encryption_version,
                    encrypted_by_user_id: payload.encrypted_by_user_id,
                    last_modified_by: payload.last_modified_by,
                    created_at: payload.created_at,
                    updated_at: payload.updated_at,
                    deleted_at: payload.deleted_at,
                    $($extra,)*
                }
            }

            #[allow(dead_code)]
            $vis fn decompose(self) -> ($crate::shapes::ItemPayload, ($($extra_ty,)*)) {
                (
                    $crate::shapes::ItemPayload {
                        id: self.id,
                        vault_id: self.vault_id,
                        category: self.category,
                        favorite: self.favorite,
                        encrypted_data: self.encrypted_data,
                        encryption_iv: self.encryption_iv,
                        encryption_algorithm: self.encryption_algorithm,
                        version: self.version,
                        encryption_version: self.encryption_version,
                        encrypted_by_user_id: self.encrypted_by_user_id,
                        last_modified_by: self.last_modified_by,
                        created_at: self.created_at,
                        updated_at: self.updated_at,
                        deleted_at: self.deleted_at,
                    },
                    ($(self.$extra,)*),
                )
            }
        }
    };
}

/// Declares a struct carrying the canonical item-attachment fields.
macro_rules! attachment_shape {
    (
        $(#[$meta:meta])*
        $vis:vis struct $name:ident {
            $( $(#[$extra_meta:meta])* $extra:ident : $extra_ty:ty ),* $(,)?
        }
    ) => {
        $(#[$meta])*
        $vis struct $name {
            $vis id: String,
            $vis item_id: String,
            $vis vault_id: String,
            $vis storage_key: String,
			$vis encrypted_attachment_key: String,
			$vis attachment_key_iv: String,
			$vis attachment_key_algorithm: String,
			$vis envelope_version: i32,
            $vis encrypted_name: String,
            $vis encrypted_content_type: String,
            $vis encryption_iv: String,
            $vis encrypted_content_type_iv: String,
            $vis encryption_algorithm: String,
            $vis file_size: i32,
            $vis uploaded_by: String,
            $vis created_at: String,
            $( $(#[$extra_meta])* $vis $extra: $extra_ty, )*
        }

        impl $name {
            #[allow(dead_code)]
            $vis fn compose(
                payload: $crate::shapes::AttachmentPayload,
                $($extra: $extra_ty,)*
            ) -> Self {
                Self {
                    id: payload.id,
                    item_id: payload.item_id,
                    vault_id: payload.vault_id,
                    storage_key: payload.storage_key,
					encrypted_attachment_key: payload.encrypted_attachment_key,
					attachment_key_iv: payload.attachment_key_iv,
					attachment_key_algorithm: payload.attachment_key_algorithm,
					envelope_version: payload.envelope_version,
                    encrypted_name: payload.encrypted_name,
                    encrypted_content_type: payload.encrypted_content_type,
                    encryption_iv: payload.encryption_iv,
                    encrypted_content_type_iv: payload.encrypted_content_type_iv,
                    encryption_algorithm: payload.encryption_algorithm,
                    file_size: payload.file_size,
                    uploaded_by: payload.uploaded_by,
                    created_at: payload.created_at,
                    $($extra,)*
                }
            }

            #[allow(dead_code)]
            $vis fn decompose(self) -> ($crate::shapes::AttachmentPayload, ($($extra_ty,)*)) {
                (
                    $crate::shapes::AttachmentPayload {
                        id: self.id,
                        item_id: self.item_id,
                        vault_id: self.vault_id,
                        storage_key: self.storage_key,
						encrypted_attachment_key: self.encrypted_attachment_key,
						attachment_key_iv: self.attachment_key_iv,
						attachment_key_algorithm: self.attachment_key_algorithm,
						envelope_version: self.envelope_version,
                        encrypted_name: self.encrypted_name,
                        encrypted_content_type: self.encrypted_content_type,
                        encryption_iv: self.encryption_iv,
                        encrypted_content_type_iv: self.encrypted_content_type_iv,
                        encryption_algorithm: self.encryption_algorithm,
                        file_size: self.file_size,
                        uploaded_by: self.uploaded_by,
                        created_at: self.created_at,
                    },
                    ($(self.$extra,)*),
                )
            }
        }
    };
}

pub(crate) use attachment_shape;
pub(crate) use item_shape;

item_shape! {
    /// The canonical item shape, in wire form. Every item response variant is this plus extras.
    #[derive(Debug, Clone)]
    pub(crate) struct ItemPayload {}
}

attachment_shape! {
    /// The canonical item-attachment shape, in wire form.
    #[derive(Debug, Clone)]
    pub(crate) struct AttachmentPayload {}
}

/// The single row -> wire mapping for items. Timestamps are the only transformation.
impl From<DbBootstrapItemRow> for ItemPayload {
    fn from(row: DbBootstrapItemRow) -> Self {
        Self {
            id: row.id,
            vault_id: row.vault_id,
            category: row.category,
            favorite: row.favorite,
            encrypted_data: row.encrypted_data,
            encryption_iv: row.encryption_iv,
            encryption_algorithm: row.encryption_algorithm,
            version: row.version,
            encryption_version: row.encryption_version,
            encrypted_by_user_id: row.encrypted_by_user_id,
            last_modified_by: row.last_modified_by,
            created_at: format_timestamp(row.created_at),
            updated_at: format_timestamp(row.updated_at),
            deleted_at: row.deleted_at.map(format_timestamp),
        }
    }
}

/// The single row -> wire mapping for item attachments.
impl From<DbBootstrapAttachmentRow> for AttachmentPayload {
    fn from(row: DbBootstrapAttachmentRow) -> Self {
        Self {
            id: row.id,
            item_id: row.item_id,
            vault_id: row.vault_id,
            storage_key: row.storage_key,
            encrypted_attachment_key: row.encrypted_attachment_key,
            attachment_key_iv: row.attachment_key_iv,
            attachment_key_algorithm: row.attachment_key_algorithm,
            envelope_version: row.envelope_version,
            encrypted_name: row.encrypted_name,
            encrypted_content_type: row.encrypted_content_type,
            encryption_iv: row.encryption_iv,
            encrypted_content_type_iv: row.encrypted_content_type_iv,
            encryption_algorithm: row.encryption_algorithm,
            file_size: row.file_size,
            uploaded_by: row.uploaded_by,
            created_at: format_timestamp(row.created_at),
        }
    }
}
