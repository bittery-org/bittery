//! The registry of stable Bittery error codes.
//!
//! [ADR 0011](../../../../../docs/adr/0011-axum-rest-openapi-replaces-qubit.md) makes the code
//! — not the human-readable `detail` — the part of a problem response clients are allowed to
//! branch on. That only holds if the set is closed, so every code lives here and
//! [`ProblemDetails::code`](super::dto::ProblemDetails) is this type rather than a `String`.
//!
//! The wire spelling is `SCREAMING_SNAKE_CASE`, and it also determines the RFC 9457 `type` URI:
//! `INVALID_QUERY` becomes `https://bittery.com/problems/invalid-query`. Both are contract, and
//! `error_code_tests.rs` pins them.

use serde::Serialize;
use utoipa::ToSchema;

/// A stable, machine-readable Bittery error code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    // Status-shaped codes, produced by mapping an `AppError` onto HTTP.
    /// 500 — the request failed for a reason the client cannot act on.
    InternalError,
    /// 400 — the request was rejected by domain validation.
    BadRequest,
    /// 404 — the addressed resource does not exist, or is not visible to the caller.
    NotFound,
    /// 403 — the caller is authenticated but not permitted.
    Forbidden,
    /// 401 — no usable credential was presented.
    Unauthorized,
    /// 409 — the request conflicts with the current state of the resource.
    Conflict,
    /// 429 — the caller exceeded a rate limit. Accompanied by `Retry-After`.
    RateLimited,
    /// 413 — the request body exceeded a protocol limit.
    PayloadTooLarge,

    // Transport-level codes, produced before a handler runs.
    /// 4xx — the request could not be parsed into the operation's input.
    InvalidRequest,
    /// 415 — the request media type is not supported for this operation.
    UnsupportedMediaType,
    /// 428 — the operation requires `If-Match`.
    PreconditionRequired,
    /// 412 — `If-Match` did not match the current resource version.
    VersionConflict,
    /// 404 — no route is registered under `/api`.
    ApiRouteNotFound,
    /// 405 — the route exists but does not support this method.
    MethodNotAllowed,
    /// 503 — a dependency is temporarily unavailable. Accompanied by `Retry-After`.
    ServiceUnavailable,

    // Request-shape codes.
    /// The query string could not be deserialized.
    InvalidQuery,
    /// `limit` is outside the documented pagination bounds.
    InvalidPageLimit,
    /// `limit` is outside the bounds of a non-cursor listing.
    InvalidLimit,
    /// The opaque page cursor is malformed, or was minted for a different query.
    InvalidCursor,
    /// `If-Match` is not a single strong item-version ETag.
    InvalidIfMatch,
    /// An item version could not be rendered as an ETag.
    InvalidVersion,
    /// `state` is not one of the supported item states.
    InvalidItemState,
    /// An email address exceeds the documented length.
    InvalidEmail,
    /// A JSON Merge Patch set a field to `null` that cannot be cleared.
    FieldCannotBeCleared,
    /// The audit search term exceeds the documented length.
    SearchTooLong,
    /// Travel mode was asked to hide more vaults than the protocol allows.
    TooManyHiddenVaults,

    // Idempotency codes.
    /// `Idempotency-Key` is not 1 to 255 visible ASCII characters.
    InvalidIdempotencyKey,
    /// `Idempotency-Key` was already used for a request with different bytes.
    IdempotencyKeyReused,
    /// `Idempotency-Key` is not accepted because the response carries a one-time secret.
    IdempotencyNotAllowed,
    /// An identical idempotent request is still executing.
    IdempotencyRequestInProgress,
    /// A claim outlived its execution lease; the outcome needs operator recovery.
    IdempotencyOutcomeIndeterminate,
    /// The outcome could not be stored or replayed.
    IdempotencyResponseUnavailable,
    /// The stable Operation ID is missing or malformed.
    InvalidOperationId,
    /// An Operation ID was already bound to different immutable request bytes.
    OperationIdReused,
    /// No retained outcome exists for this User and Operation ID.
    OperationOutcomeNotFound,
    RotationStaleVaultVersion,
    RotationStaleMemberSet,
    RotationStaleItemState,
    RotationStaleAttachmentState,
}

impl ErrorCode {
    /// Every code, in declaration order. Used by the contract tests.
    #[cfg(test)]
    pub(crate) const ALL: &'static [Self] = &[
        Self::InternalError,
        Self::BadRequest,
        Self::NotFound,
        Self::Forbidden,
        Self::Unauthorized,
        Self::Conflict,
        Self::RateLimited,
        Self::PayloadTooLarge,
        Self::InvalidRequest,
        Self::UnsupportedMediaType,
        Self::PreconditionRequired,
        Self::VersionConflict,
        Self::ApiRouteNotFound,
        Self::MethodNotAllowed,
        Self::ServiceUnavailable,
        Self::InvalidQuery,
        Self::InvalidPageLimit,
        Self::InvalidLimit,
        Self::InvalidCursor,
        Self::InvalidIfMatch,
        Self::InvalidVersion,
        Self::InvalidItemState,
        Self::InvalidEmail,
        Self::FieldCannotBeCleared,
        Self::SearchTooLong,
        Self::TooManyHiddenVaults,
        Self::InvalidIdempotencyKey,
        Self::IdempotencyKeyReused,
        Self::IdempotencyNotAllowed,
        Self::IdempotencyRequestInProgress,
        Self::IdempotencyOutcomeIndeterminate,
        Self::IdempotencyResponseUnavailable,
        Self::InvalidOperationId,
        Self::OperationIdReused,
        Self::OperationOutcomeNotFound,
        Self::RotationStaleVaultVersion,
        Self::RotationStaleMemberSet,
        Self::RotationStaleItemState,
        Self::RotationStaleAttachmentState,
    ];

    pub(crate) const fn as_str(&self) -> &'static str {
        match self {
            Self::InternalError => "INTERNAL_ERROR",
            Self::BadRequest => "BAD_REQUEST",
            Self::NotFound => "NOT_FOUND",
            Self::Forbidden => "FORBIDDEN",
            Self::Unauthorized => "UNAUTHORIZED",
            Self::Conflict => "CONFLICT",
            Self::RateLimited => "RATE_LIMITED",
            Self::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            Self::InvalidRequest => "INVALID_REQUEST",
            Self::UnsupportedMediaType => "UNSUPPORTED_MEDIA_TYPE",
            Self::PreconditionRequired => "PRECONDITION_REQUIRED",
            Self::VersionConflict => "VERSION_CONFLICT",
            Self::ApiRouteNotFound => "API_ROUTE_NOT_FOUND",
            Self::MethodNotAllowed => "METHOD_NOT_ALLOWED",
            Self::ServiceUnavailable => "SERVICE_UNAVAILABLE",
            Self::InvalidQuery => "INVALID_QUERY",
            Self::InvalidPageLimit => "INVALID_PAGE_LIMIT",
            Self::InvalidLimit => "INVALID_LIMIT",
            Self::InvalidCursor => "INVALID_CURSOR",
            Self::InvalidIfMatch => "INVALID_IF_MATCH",
            Self::InvalidVersion => "INVALID_VERSION",
            Self::InvalidItemState => "INVALID_ITEM_STATE",
            Self::InvalidEmail => "INVALID_EMAIL",
            Self::FieldCannotBeCleared => "FIELD_CANNOT_BE_CLEARED",
            Self::SearchTooLong => "SEARCH_TOO_LONG",
            Self::TooManyHiddenVaults => "TOO_MANY_HIDDEN_VAULTS",
            Self::InvalidIdempotencyKey => "INVALID_IDEMPOTENCY_KEY",
            Self::IdempotencyKeyReused => "IDEMPOTENCY_KEY_REUSED",
            Self::IdempotencyNotAllowed => "IDEMPOTENCY_NOT_ALLOWED",
            Self::IdempotencyRequestInProgress => "IDEMPOTENCY_REQUEST_IN_PROGRESS",
            Self::IdempotencyOutcomeIndeterminate => "IDEMPOTENCY_OUTCOME_INDETERMINATE",
            Self::IdempotencyResponseUnavailable => "IDEMPOTENCY_RESPONSE_UNAVAILABLE",
            Self::InvalidOperationId => "INVALID_OPERATION_ID",
            Self::OperationIdReused => "OPERATION_ID_REUSED",
            Self::OperationOutcomeNotFound => "OPERATION_OUTCOME_NOT_FOUND",
            Self::RotationStaleVaultVersion => "ROTATION_STALE_VAULT_VERSION",
            Self::RotationStaleMemberSet => "ROTATION_STALE_MEMBER_SET",
            Self::RotationStaleItemState => "ROTATION_STALE_ITEM_STATE",
            Self::RotationStaleAttachmentState => "ROTATION_STALE_ATTACHMENT_STATE",
        }
    }

    /// The RFC 9457 `type` URI for this code.
    pub(crate) fn problem_type(&self) -> String {
        format!(
            "https://bittery.com/problems/{}",
            self.as_str().to_ascii_lowercase().replace('_', "-")
        )
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[cfg(test)]
#[path = "error_code_tests.rs"]
mod tests;
