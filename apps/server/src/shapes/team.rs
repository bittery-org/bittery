//! Canonical field lists for the team surface.

/// A team as it appears next to the caller's own membership.
macro_rules! team_summary_shape {
    ($emit:ident $args:tt, count = $count:ty) => {
        $crate::shapes::$emit! { $args {
            id: String,
            name: String,
            team_type: $crate::db::enums::TeamType,
            owner_id: String,
            role: $crate::db::enums::TeamRole,
            member_count: $count = into,
            #[serde(skip_serializing_if = "Option::is_none")]
            member_limit: Option<i32>,
            #[serde(skip_serializing_if = "Option::is_none")]
            image_url: Option<String>,
            created_at: String,
        } }
    };
}

/// One team in full, as its settings screen shows it.
macro_rules! team_details_shape {
    ($emit:ident $args:tt, count = $count:ty) => {
        $crate::shapes::$emit! { $args {
            id: String,
            name: String,
            team_type: $crate::db::enums::TeamType,
            owner_id: String,
            owner_name: String,
            user_role: $crate::db::enums::TeamRole,
            member_count: $count = into,
            #[serde(skip_serializing_if = "Option::is_none")]
            member_limit: Option<i32>,
            #[serde(skip_serializing_if = "Option::is_none")]
            image_url: Option<String>,
            created_at: String,
            updated_at: String,
        } }
    };
}

macro_rules! member_vault_access_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
            name: String,
            vault_type: $crate::db::enums::VaultType,
            role: $crate::db::enums::VaultRole,
            granted_at: String,
            item_count: u32,
        } }
    };
}

macro_rules! member_device_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            device_name: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            platform: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            browser_name: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            os_name: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            masked_ip: Option<String>,
            created_at: String,
            last_active_at: String,
            expires_at: String,
        } }
    };
}

macro_rules! member_share_link_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
            item_id: String,
            status: $crate::db::enums::ShareLinkStatus,
            access_mode: $crate::db::enums::ShareLinkAccessMode,
            access_count: u32,
            #[serde(skip_serializing_if = "Option::is_none")]
            max_access_count: Option<u32>,
            expires_at: String,
            created_at: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            last_accessed_at: Option<String>,
            is_expired: bool,
        } }
    };
}

macro_rules! member_access_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            @schema(max_items = 500)
            vaults: Vec<MemberVaultAccessResponse> = each,
            @schema(max_items = 500)
            devices: Vec<MemberDeviceResponse> = each,
            @schema(max_items = 100)
            share_links: Vec<MemberShareLinkResponse> = each,
            share_link_total: u32,
            active_share_link_count: u32,
        } }
    };
}

pub(crate) use {
    member_access_shape, member_device_shape, member_share_link_shape, member_vault_access_shape,
    team_details_shape, team_summary_shape,
};
