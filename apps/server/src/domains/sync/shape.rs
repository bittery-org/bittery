//! Canonical field lists for the sync surface.

/// The vault a bootstrapped item belongs to, as bootstrap inlines it.
macro_rules! bootstrap_vault_summary_shape {
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

/// The position in the event log a client has consumed up to.
macro_rules! sync_cursor_shape {
    ($emit:ident $args:tt) => {
        $crate::shapes::$emit! { $args {
            id: String,
        } }
    };
}

/// One sync event. `timestamp` is epoch milliseconds, which exceeds an IEEE 754 safe integer, so
/// the transport spells it as a decimal string.
macro_rules! sync_event_shape {
    ($emit:ident $args:tt, timestamp = $timestamp:ty) => {
        $crate::shapes::$emit! { $args {
            id: String,
            #[serde(rename = "type")]
            event_type: $crate::db::enums::SyncEventType,
            entity_id: String,
            entity_type: $crate::db::enums::SyncEntityType,
            vault_id: Option<String>,
            version: i32,
            client_id: Option<String>,
            user_id: String,
            metadata: Option<::serde_json::Value>,
            timestamp: $timestamp = into,
        } }
    };
}

/// A bounded page of sync events. `requires_full_refresh` reports a cursor the server can no
/// longer resolve, which is the client's signal to bootstrap again.
macro_rules! sync_changes_shape {
    ($emit:ident $args:tt, event = $event:ty) => {
        $crate::shapes::$emit! { $args {
            @schema(max_items = 500)
            events: Vec<$event> = each,
            cursor: Option<SyncCursorResponse> = maybe,
            has_more: bool,
            requires_full_refresh: bool,
        } }
    };
}

pub(crate) use {
    bootstrap_vault_summary_shape, sync_changes_shape, sync_cursor_shape, sync_event_shape,
};
