//! Pins the wire spelling of every error code and the `type` URI derived from it.

use serde_json::Value;

use super::ErrorCode;

/// The exact strings clients branch on. Written out longhand: a diff here is an API break.
const EXPECTED: &[&str] = &[
    "INTERNAL_ERROR",
    "BAD_REQUEST",
    "NOT_FOUND",
    "FORBIDDEN",
    "UNAUTHORIZED",
    "CONFLICT",
    "RATE_LIMITED",
    "PAYLOAD_TOO_LARGE",
    "INVALID_REQUEST",
    "UNSUPPORTED_MEDIA_TYPE",
    "PRECONDITION_REQUIRED",
    "VERSION_CONFLICT",
    "API_ROUTE_NOT_FOUND",
    "METHOD_NOT_ALLOWED",
    "SERVICE_UNAVAILABLE",
    "INVALID_QUERY",
    "INVALID_PAGE_LIMIT",
    "INVALID_LIMIT",
    "INVALID_CURSOR",
    "INVALID_IF_MATCH",
    "INVALID_VERSION",
    "INVALID_ITEM_STATE",
    "INVALID_EMAIL",
    "ACCOUNT_DELETION_CONFIRMATION_MISMATCH",
    "ACCOUNT_DELETION_BLOCKED",
    "FIELD_CANNOT_BE_CLEARED",
    "SEARCH_TOO_LONG",
    "TOO_MANY_HIDDEN_VAULTS",
    "INVALID_IDEMPOTENCY_KEY",
    "IDEMPOTENCY_KEY_REUSED",
    "IDEMPOTENCY_NOT_ALLOWED",
    "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    "IDEMPOTENCY_OUTCOME_INDETERMINATE",
    "IDEMPOTENCY_RESPONSE_UNAVAILABLE",
    "INVALID_OPERATION_ID",
    "OPERATION_ID_REUSED",
    "OPERATION_OUTCOME_NOT_FOUND",
    "ATTACHMENT_STAGING_INCOMPLETE",
    "ATTACHMENT_STAGING_MISMATCH",
    "ATTACHMENT_STAGING_BUSY",
    "ATTACHMENT_AUTHORITY_STALE",
    "ATTACHMENT_QUOTA_EXCEEDED",
    "ROTATION_STALE_VAULT_VERSION",
    "ROTATION_STALE_MEMBER_SET",
    "ROTATION_STALE_ITEM_STATE",
    "ROTATION_STALE_ATTACHMENT_STATE",
];

#[test]
fn every_code_keeps_its_wire_spelling() {
    let actual: Vec<&str> = ErrorCode::ALL.iter().map(ErrorCode::as_str).collect();
    assert_eq!(actual, EXPECTED);

    for code in ErrorCode::ALL {
        assert_eq!(
            serde_json::to_value(code).expect("error code should serialize"),
            Value::String(code.as_str().to_owned()),
            "{code:?} must serialize as its registry spelling",
        );
    }
}

/// `ApiError` derived this URI from the code string before the registry existed. Same output.
#[test]
fn problem_type_uris_are_the_lowercase_kebab_form_of_the_code() {
    for code in ErrorCode::ALL {
        let legacy = format!(
            "https://bittery.com/problems/{}",
            code.as_str().to_ascii_lowercase().replace('_', "-")
        );
        assert_eq!(code.problem_type(), legacy);
    }

    assert_eq!(
        ErrorCode::VersionConflict.problem_type(),
        "https://bittery.com/problems/version-conflict"
    );
    assert_eq!(
        ErrorCode::IdempotencyKeyReused.problem_type(),
        "https://bittery.com/problems/idempotency-key-reused"
    );
}
