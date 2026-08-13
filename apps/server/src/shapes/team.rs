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

pub(crate) use {team_details_shape, team_summary_shape};
