//! Canonical field lists for the vault surface.

/// A bare acknowledgement. Endpoints that have nothing to return still return a body.
macro_rules! success_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            success: bool,
        } }
    };
}

/// The id of a freshly created vault.
macro_rules! create_vault_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            vault_id: String,
        } }
    };
}

/// A vault after a rename or a re-icon.
macro_rules! update_vault_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
            name: String,
            icon: Option<String>,
            image_url: Option<String>,
        } }
    };
}

/// The before and after of moving a vault between personal and team ownership.
macro_rules! convert_vault_type_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            success: bool,
            vault_id: String,
            previous_type: $crate::db::enums::VaultType,
            new_type: $crate::db::enums::VaultType,
        } }
    };
}

/// One item of a bulk import, as the client supplies it.
macro_rules! bulk_import_item_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            item_id: String,
            category: $crate::db::enums::ItemCategory,
            favorite: Option<bool>,
            @schema(max_length = 1048576)
            encrypted_data: String,
            encryption_iv: String,
            encryption_algorithm: String,
        } }
    };
}

/// A created item. `itemId` is the client-generated id and `id` the stored one; they agree unless
/// the client supplied none.
macro_rules! create_item_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            item_id: String,
            id: String,
        } }
    };
}

/// The outcome of a bulk import.
macro_rules! bulk_import_result_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            success: bool,
            imported_count: usize,
            item_ids: Vec<String>,
        } }
    };
}

/// An item mutation, carrying the version the caller must send back as `If-Match`.
macro_rules! update_item_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            success: bool,
            version: i32,
        } }
    };
}

/// The id of a freshly registered attachment.
macro_rules! create_attachment_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            attachment_id: String,
        } }
    };
}

/// A vault as it appears in the caller's vault list.
macro_rules! vault_list_entry_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
            name: String,
            vault_type: $crate::db::enums::VaultType,
            icon: Option<String>,
            image_url: Option<String>,
            role: $crate::db::enums::VaultRole,
            // Counted in SQL and already rendered, so it never crosses an f64.
            @schema(pattern = r"^(0|[1-9][0-9]*)$")
            item_count: String,
            encrypted_vault_key: String,
            created_by_id: String,
        } }
    };
}

/// The vault an item belongs to, inlined next to the item.
macro_rules! vault_summary_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
            name: String,
            vault_type: $crate::db::enums::VaultType,
            icon: Option<String>,
            image_url: Option<String>,
            encrypted_vault_key: String,
            role: $crate::db::enums::VaultRole,
        } }
    };
}

/// One vault member and the role they hold in it.
macro_rules! vault_member_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            user_id: String,
            name: String,
            email: String,
            role: $crate::db::enums::VaultRole,
        } }
    };
}

/// A teammate who could be added to this vault, with the key to wrap the vault key for.
macro_rules! vault_available_member_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            user_id: String,
            name: String,
            email: String,
            public_key: String,
        } }
    };
}

/// A presigned attachment download, with the metadata needed to decrypt what it returns.
macro_rules! attachment_download_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            download_url: String,
            encrypted_name: String,
            encrypted_content_type: String,
            encryption_iv: String,
            encrypted_content_type_iv: String,
            encryption_algorithm: String,
            file_size: i32,
        } }
    };
}

/// One vault in full, with the counts a detail screen shows.
macro_rules! vault_details_shape {
    ($emit:ident $args:tt, count = $count:ty) => {
        $crate::shapes::$emit! { $args {
            id: String,
            name: String,
            vault_type: $crate::db::enums::VaultType,
            icon: Option<String>,
            image_url: Option<String>,
            user_role: $crate::db::enums::VaultRole,
            item_count: $count = into,
            member_count: $count = into,
            created_at: String,
        } }
    };
}

/// The caller's totals across every vault they can reach.
macro_rules! vault_stats_shape {
    ($emit:ident $args:tt, count = $count:ty) => {
        $crate::shapes::$emit! { $args {
            team_count: i32,
            vault_count: $count = into,
            item_count: $count = into,
        } }
    };
}

pub(crate) use {
    attachment_download_shape, bulk_import_item_shape, bulk_import_result_shape,
    convert_vault_type_shape, create_attachment_shape, create_item_shape, create_vault_shape,
    success_shape, update_item_shape, update_vault_shape, vault_available_member_shape,
    vault_details_shape, vault_list_entry_shape, vault_member_shape, vault_stats_shape,
    vault_summary_shape,
};
