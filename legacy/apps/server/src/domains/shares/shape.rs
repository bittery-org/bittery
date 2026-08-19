//! Canonical field lists for the share-link surface.

/// A freshly created share link.
macro_rules! create_share_link_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
            // `token` is the only time the raw token is ever disclosed. The database holds just
            // its digest, so a link that is not copied here cannot be reconstructed later.
            token: String,
            expires_at: String,
            base_share_url: String,
        } }
    };
}

/// One address on a share link's allow list, and whether it has passed the email challenge.
macro_rules! allowed_email_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            email: String,
            verified: bool,
        } }
    };
}

/// One share link as its owner sees it.
macro_rules! share_link_list_entry_shape {
    ($emit:ident $args:tt, email = $email:ty) => {
        $crate::shapes::$emit! { $args {
            id: String,
            status: $crate::db::enums::ShareLinkStatus,
            access_mode: $crate::db::enums::ShareLinkAccessMode,
            is_one_time_use: bool,
            access_count: i32,
            #[serde(skip_serializing_if = "Option::is_none")]
            max_access_count: Option<i32>,
            @schema(max_items = 100)
            allowed_emails: Vec<$email> = each,
            expires_at: String,
            created_at: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            last_accessed_at: Option<String>,
        } }
    };
}

/// Every share link on one item, plus the base URL they are rendered against.
macro_rules! share_link_list_shape {
    ($emit:ident $args:tt, link = $link:ty) => {
        $crate::shapes::$emit! { $args {
            @schema(max_items = 100)
            links: Vec<$link> = each,
            base_share_url: String,
        } }
    };
}

/// One recorded attempt to open a share link, successful or not.
macro_rules! share_access_log_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            accessed_by_email: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            ip_address: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            user_agent: Option<String>,
            success: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            failure_reason: Option<String>,
            accessed_at: String,
        } }
    };
}

/// What an unauthenticated visitor may learn about a link before opening it.
macro_rules! public_share_info_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            valid: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            reason: Option<String>,
            access_mode: $crate::db::enums::ShareLinkAccessMode,
            #[serde(skip_serializing_if = "Option::is_none")]
            is_one_time_use: Option<bool>,
            #[serde(skip_serializing_if = "Option::is_none")]
            expires_at: Option<String>,
        } }
    };
}

/// The shared item's ciphertext and the wrapped key that opens it.
macro_rules! public_share_access_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            encrypted_item_data: String,
            encryption_iv: String,
            encrypted_share_key: String,
            share_key_iv: String,
        } }
    };
}

/// The outcome of asking for an email challenge code.
macro_rules! email_verification_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            success: bool,
            message: String,
        } }
    };
}

pub(crate) use {
    allowed_email_shape, create_share_link_shape, email_verification_shape,
    public_share_access_shape, public_share_info_shape, share_access_log_shape,
    share_link_list_entry_shape, share_link_list_shape,
};
