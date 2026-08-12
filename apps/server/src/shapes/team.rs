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

/// A member who must be rewrapped a key while a team-wide rotation runs.
macro_rules! rotation_member_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            user_id: String,
            public_key: String,
            role: $crate::db::enums::VaultRole,
        } }
    };
}

/// One vault's slice of a team-wide rotation.
macro_rules! rotation_vault_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            vault_id: String,
            vault_name: String,
            key_version: i32,
            @schema(max_items = 100)
            members: Vec<RotationMemberResponse> = each,
            @schema(max_items = 100)
            items: Vec<RotationItemResponse> = each,
        } }
    };
}

/// Every vault a departing member's removal forces a rotation of.
macro_rules! rotation_data_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            @schema(max_items = 100)
            vaults: Vec<RotationVaultResponse> = each,
        } }
    };
}

pub(crate) use {
    rotation_data_shape, rotation_member_shape, rotation_vault_shape, team_details_shape,
    team_summary_shape,
};
