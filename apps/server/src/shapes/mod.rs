//! Canonical field lists for the shapes that exist on both sides of the transport seam.
//!
//! [ADR 0011](../../../docs/adr/0011-axum-rest-openapi-replaces-qubit.md) keeps transport DTOs
//! distinct from service models: the wire shape is not the domain shape, and the two must be free
//! to diverge. That decision is about *types*, not about *typing*. Before this module the field
//! lists were retyped for every variant, so a struct pair that differed only in derives was still
//! two hand-maintained copies plus a hand-written `From`.
//!
//! A shape here is a macro that yields one canonical field list. Each side invokes it with its own
//! attributes and gets its own type; the transport side invokes it once more to get the `From`
//! impl. Adding a field means editing one list.
//!
//! # Writing a shape
//!
//! ```ignore
//! macro_rules! example_shape {
//!     ($emit:ident $args:tt) => {
//!         $crate::shapes::$emit! { $args {
//!             id: String,
//!             #[serde(skip_serializing_if = "Option::is_none")]
//!             @schema(max_length = 65536)
//!             encrypted_vault_key: Option<String>,
//!             count: $crate::http::api::dto::DecimalString = into,
//!         } }
//!     };
//! }
//! ```
//!
//! - Plain `#[...]` attributes apply to both sides. They are the shared serde behaviour.
//! - `@schema(...)` is utoipa bound metadata and reaches the transport struct only. Service models
//!   carry no `ToSchema`, so their schemas were never registered in `ApiDoc` and never published.
//! - `= into` / `= each` / `= maybe` say how [`shape_from`] converts that field. Omit it when both
//!   sides hold the same type. This is per-field on purpose: the transport side spells `i64` as a
//!   `DecimalString` for some fields and not others.
//! - A field whose *type* differs per side is a macro parameter, so each side passes its own.
//!
//! Unqualified type names resolve at the invocation site, which is what lets both sides name their
//! own nested DTO. Anything else should be spelled `$crate::…` so the list does not depend on what
//! the invoking module happens to import.
//!
//! `#[serde(flatten)]` would express the item shapes more directly, but utoipa 5.5 renders a
//! flattened field as `{"allOf": [{"$ref": ...}]}` instead of an inline object, which would rewrite
//! every item schema in the committed `openapi.v1.json`. The macros keep the emitted schema
//! byte-identical to a hand-written struct.

mod auth;
mod billing;
mod item;
mod share;
mod sync;
mod team;
mod vault;

/// Emits a transport DTO: the canonical fields plus their `@schema(...)` bounds.
macro_rules! wire_struct {
    (
        { $(#[$meta:meta])* $vis:vis struct $name:ident }
        { $(
            $(#[$field_meta:meta])*
            $(@schema($($bound:tt)*))?
            $field:ident : $ty:ty
            $(= $conv:ident)?
        ),* $(,)? }
    ) => {
        $(#[$meta])*
        $vis struct $name {
            $(
                $(#[$field_meta])*
                $(#[schema($($bound)*)])?
                $vis $field: $ty,
            )*
        }
    };
}

/// Emits a service model: the canonical fields without the transport's utoipa bounds.
macro_rules! service_struct {
    (
        { $(#[$meta:meta])* $vis:vis struct $name:ident }
        { $(
            $(#[$field_meta:meta])*
            $(@schema($($bound:tt)*))?
            $field:ident : $ty:ty
            $(= $conv:ident)?
        ),* $(,)? }
    ) => {
        $(#[$meta])*
        $vis struct $name {
            $( $(#[$field_meta])* $vis $field: $ty, )*
        }
    };
}

/// Emits the mapping between two variants of one shape, honouring the per-field conversions.
macro_rules! shape_from {
    (
        { $src:ty => $dst:ty }
        { $(
            $(#[$field_meta:meta])*
            $(@schema($($bound:tt)*))?
            $field:ident : $ty:ty
            $(= $conv:ident)?
        ),* $(,)? }
    ) => {
        impl From<$src> for $dst {
            fn from(value: $src) -> Self {
                Self {
                    $( $field: $crate::shapes::shape_value!($($conv)? ; value.$field), )*
                }
            }
        }
    };
}

/// The per-field conversions [`shape_from`] understands.
macro_rules! shape_value {
    (; $value:expr) => {
        $value
    };
    (into; $value:expr) => {
        ::core::convert::Into::into($value)
    };
    (each; $value:expr) => {
        $value
            .into_iter()
            .map(::core::convert::Into::into)
            .collect()
    };
    (maybe; $value:expr) => {
        $value.map(::core::convert::Into::into)
    };
}

pub(crate) use service_struct;
pub(crate) use shape_from;
pub(crate) use shape_value;
pub(crate) use wire_struct;

pub(crate) use self::item::{attachment_shape, item_shape, AttachmentPayload, ItemPayload};

pub(crate) use self::auth::*;
pub(crate) use self::billing::*;
pub(crate) use self::share::*;
pub(crate) use self::sync::*;
pub(crate) use self::team::*;
pub(crate) use self::vault::*;
