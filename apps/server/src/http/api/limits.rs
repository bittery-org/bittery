//! The protocol bounds the API publishes, in one place.
//!
//! Every `#[schema(max_length = ...)]`, `#[schema(max_items = ...)]` and pagination bound in the
//! transport layer states one of these numbers. They are also the numbers the runtime validators
//! enforce, so a bound that appears in the OpenAPI document is the bound a request actually hits.
//!
//! # Why the literals are still hand-typed
//!
//! utoipa 5.5 parses `max_length`, `max_items`, `min_items`, `minimum`, `maximum` and `default`
//! with a token-tree scanner that accepts only a numeric *literal* — an identifier is rejected
//! with `no `literal` value found after this point`. So the attributes cannot reference these
//! constants directly. `limits_tests.rs` closes the gap from the other side: it reads the
//! generated OpenAPI document and asserts each emitted bound equals the constant here, so a
//! constant that changes without its literals fails the build.

/// Maximum ciphertext bytes for one encrypted item payload.
pub const ITEM_CIPHERTEXT_BYTES: u64 = 1_048_576;

/// Maximum total bytes for one bulk import request.
pub const BULK_IMPORT_BYTES: u64 = 16_777_216;

/// Maximum items in one bulk import request.
pub const BULK_IMPORT_ITEMS: u16 = 200;

/// Page size used when a request omits `limit`.
pub const DEFAULT_PAGE_SIZE: u16 = 100;

/// Largest page size a cursor-paginated collection will serve.
pub const MAX_PAGE_SIZE: u16 = 500;

/// Maximum bytes for a wrapped vault key, matching
/// [`ENCRYPTED_VAULT_KEY_MAX_BYTES`](crate::services::vault_key::ENCRYPTED_VAULT_KEY_MAX_BYTES).
pub const ENCRYPTED_VAULT_KEY_BYTES: usize =
    crate::services::vault_key::ENCRYPTED_VAULT_KEY_MAX_BYTES;

/// Maximum characters in a vault or team display name, matching
/// [`VAULT_NAME_MAX_CHARS`](crate::services::vault::VAULT_NAME_MAX_CHARS).
pub const NAME_MAX_CHARS: usize = crate::services::vault::VAULT_NAME_MAX_CHARS;

/// Maximum entries in a bounded request or response batch: rotation keys, re-encrypted items,
/// allowed emails, hidden vaults, pending vault keys and field errors all share this cap.
pub const MAX_BATCH_ITEMS: usize = 100;

/// Maximum capability strings advertised by `GET /api/meta`.
pub const MAX_CAPABILITIES: usize = 32;

/// `GET /api/meta` advertises exactly one supported major today.
pub const SUPPORTED_MAJORS: usize = 1;

/// Largest audit page a request may ask for, matching
/// [`MAX_LIMIT`](crate::services::audit::MAX_LIMIT).
pub const MAX_AUDIT_EVENTS: u16 = crate::services::audit::MAX_LIMIT as u16;

/// Audit page size used when a request omits `limit`, matching
/// [`DEFAULT_LIMIT`](crate::services::audit::DEFAULT_LIMIT).
pub const DEFAULT_AUDIT_EVENTS: u16 = crate::services::audit::DEFAULT_LIMIT as u16;

/// Maximum bytes in an audit search term.
pub const MAX_AUDIT_SEARCH_BYTES: usize = 200;

#[cfg(test)]
#[path = "limits_tests.rs"]
mod tests;
