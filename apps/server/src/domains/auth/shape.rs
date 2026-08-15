//! Canonical field lists for auth responses that are identical on both sides of the transport
//! seam. Responses with cursor construction, timestamp formatting, or nested transformations stay
//! explicit in the HTTP module.

macro_rules! reset_password_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            token: String,
            session_id: String,
            expires_at: String,
            user_id: String,
        } }
    };
}

macro_rules! me_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
            email: String,
            name: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            team_id: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            team_name: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            team_type: Option<$crate::db::enums::TeamType>,
            #[serde(skip_serializing_if = "Option::is_none")]
            team_avatar_url: Option<String>,
            role: $crate::db::enums::TeamRole,
            #[serde(skip_serializing_if = "Option::is_none")]
            secret_key_hint: Option<String>,
            public_key: String,
            encrypted_private_key: String,
            has_recovery_key: bool,
            created_at: String,
        } }
    };
}

macro_rules! session_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            device_name: Option<String>,
            platform: String,
            #[serde(skip_serializing_if = "Option::is_none")]
            browser_name: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            browser_version: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            os_name: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            os_version: Option<String>,
            #[serde(skip_serializing_if = "Option::is_none")]
            ip_address: Option<String>,
            last_active_at: String,
            created_at: String,
            is_current_session: bool,
        } }
    };
}

macro_rules! refresh_session_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            token: String,
            session_id: String,
            expires_at: String,
        } }
    };
}

pub(crate) use {me_shape, refresh_session_shape, reset_password_shape, session_shape};
