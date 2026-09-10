//! Ties the bounds literals in `#[schema(...)]`/`#[param(...)]` back to [`super`].
//!
//! utoipa 5.5 will not accept a constant in those attributes (see the module docs), so the
//! literals are hand-typed. These tests read the generated document and check them from the
//! other side: a constant that changes without its literals, or a literal that drifts to an
//! unregistered number, fails here.

use std::collections::BTreeSet;

use serde_json::Value;

use super::*;

/// The JSON Schema keywords whose values are protocol bounds.
const BOUND_KEYWORDS: &[&str] = &[
    "maxItems",
    "minItems",
    "maxLength",
    "minLength",
    "maximum",
    "minimum",
];

fn openapi_document() -> Value {
    let (_, document) = crate::http::openapi::openapi_router().split_for_parts();
    serde_json::to_value(document).expect("OpenAPI should serialize")
}

/// Every bound keyword in the document, paired with the JSON pointer that produced it.
fn bounds(value: &Value) -> Vec<(String, u64)> {
    fn walk(value: &Value, path: &str, found: &mut Vec<(String, u64)>) {
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    let child_path = format!("{path}/{key}");
                    if BOUND_KEYWORDS.contains(&key.as_str()) {
                        found.push((
                            child_path.clone(),
                            child
                                .as_u64()
                                .unwrap_or_else(|| panic!("{child_path} must be a whole number")),
                        ));
                    }
                    walk(child, &child_path, found);
                }
            }
            Value::Array(items) => {
                for (index, child) in items.iter().enumerate() {
                    walk(child, &format!("{path}/{index}"), found);
                }
            }
            _ => {}
        }
    }

    let mut found = Vec::new();
    walk(value, "", &mut found);
    found
}

/// The complete set of numbers the transport layer is allowed to publish as a bound.
fn registered_bounds() -> BTreeSet<u64> {
    BTreeSet::from([
        // utoipa derives `minimum: 0` from every unsigned integer field; `1` is the trivial
        // lower bound the transport declares by hand.
        0,
        1,
        ITEM_CIPHERTEXT_BYTES,
        u64::from(BULK_IMPORT_ITEMS),
        u64::from(MAX_PAGE_SIZE),
        ENCRYPTED_VAULT_KEY_BYTES as u64,
        NAME_MIN_CHARS as u64,
        NAME_MAX_CHARS as u64,
        ICON_MAX_CHARS as u64,
        MAX_BATCH_ITEMS as u64,
        MAX_CAPABILITIES as u64,
        SUPPORTED_MAJORS as u64,
        u64::from(MAX_AUDIT_EVENTS),
        MAX_AUDIT_SEARCH_BYTES as u64,
        CIPHERTEXT_SHA256_HEX_CHARS as u64,
    ])
}

#[test]
fn every_published_bound_is_a_registered_limit() {
    let registered = registered_bounds();
    let document = openapi_document();
    let bounds = bounds(&document);

    assert!(
        !bounds.is_empty(),
        "the generated document should publish bounds"
    );
    for (pointer, value) in &bounds {
        assert!(
            registered.contains(value),
            "{pointer} publishes {value}, which is not a constant in `http::limits`",
        );
    }

    // Nothing in `limits` may go stale: every registered number must still be published.
    let published: BTreeSet<u64> = bounds.iter().map(|(_, value)| *value).collect();
    for value in &registered {
        assert!(
            published.contains(value),
            "no schema publishes the registered limit {value}; delete it or use it",
        );
    }
}

/// Spot-checks the bounds that clients rely on most, by name rather than by value alone.
#[test]
fn key_schemas_publish_their_named_limits() {
    let document = openapi_document();
    let schemas = &document["components"]["schemas"];

    let page_limit = &schemas["PageRequest"]["properties"]["limit"];
    assert_eq!(page_limit["minimum"], 1);
    assert_eq!(page_limit["maximum"], u64::from(MAX_PAGE_SIZE));
    assert_eq!(page_limit["default"], u64::from(DEFAULT_PAGE_SIZE));

    assert_eq!(
        schemas["ApiMetadata"]["properties"]["capabilities"]["maxItems"],
        MAX_CAPABILITIES as u64
    );
    assert_eq!(
        schemas["ApiVersionMetadata"]["properties"]["supportedMajors"]["maxItems"],
        SUPPORTED_MAJORS as u64
    );
    assert_eq!(
        schemas["ProblemDetails"]["properties"]["errors"]["maxItems"],
        MAX_BATCH_ITEMS as u64
    );
    assert_eq!(
        schemas["CreateItemBody"]["properties"]["encryptedData"]["maxLength"],
        ITEM_CIPHERTEXT_BYTES
    );
    assert_eq!(
        schemas["BulkImportBody"]["properties"]["items"]["maxItems"],
        u64::from(BULK_IMPORT_ITEMS)
    );
    assert_eq!(
        schemas["CreateVaultBody"]["properties"]["encryptedVaultKey"]["maxLength"],
        ENCRYPTED_VAULT_KEY_BYTES as u64
    );
    assert_eq!(
        schemas["CreateVaultBody"]["properties"]["name"]["maxLength"],
        NAME_MAX_CHARS as u64
    );
    assert_eq!(
        schemas["CreateVaultBody"]["properties"]["name"]["minLength"],
        NAME_MIN_CHARS as u64
    );
    assert_eq!(
        schemas["CreateVaultBody"]["properties"]["icon"]["maxLength"],
        ICON_MAX_CHARS as u64
    );
    // `AuditEventsQuery` is `IntoParams`, so its bounds land on the operation's parameters.
    let audit_parameters = &document["paths"]["/api/v1/audit-events"]["get"]["parameters"];
    let audit_parameter = |name: &str| {
        audit_parameters
            .as_array()
            .expect("audit-events should declare query parameters")
            .iter()
            .find(|parameter| parameter["name"] == name)
            .unwrap_or_else(|| panic!("audit-events should declare `{name}`"))["schema"]
            .clone()
    };

    let audit_limit = audit_parameter("limit");
    assert_eq!(audit_limit["minimum"], 1);
    assert_eq!(audit_limit["maximum"], u64::from(MAX_AUDIT_EVENTS));
    assert_eq!(audit_limit["default"], u64::from(DEFAULT_AUDIT_EVENTS));
    assert_eq!(
        audit_parameter("search")["maxLength"],
        MAX_AUDIT_SEARCH_BYTES as u64
    );
}

/// The Client Runtime derives its accepted Import batch bound from these two published numbers.
///
/// It cannot import them — the crates do not depend on each other — so it mirrors the literals in
/// `packages/client-runtime/crates/bittery-client-core/src/runtime/import.rs` and guards them
/// there with `import_batch_bytes_fit_the_server_and_authority_ceilings`. This is the other half
/// of that guard. If either number moves here without moving there, Runtime can accept a batch
/// this Server will refuse with a `413`, which carries no Operation outcome, so the accepted
/// Operation would retry forever instead of terminating.
#[test]
fn import_request_bounds_match_the_runtime_batch_derivation() {
    assert_eq!(BULK_IMPORT_BYTES, 16 * 1024 * 1024);
    assert_eq!(BULK_IMPORT_ITEMS, 200);

    // The published per-Item bound deliberately does not multiply out to the body limit: at 200
    // Items it would be about 200 MiB. The total is bounded once, at Runtime acceptance.
    assert!(
        u64::from(BULK_IMPORT_ITEMS) * ITEM_CIPHERTEXT_BYTES > BULK_IMPORT_BYTES,
        "if the per-Item bounds ever fit the body limit, the Runtime batch bound can be retired",
    );
}

/// The runtime validators and the published bounds must agree.
#[test]
fn published_limits_match_the_runtime_validators() {
    assert_eq!(
        ENCRYPTED_VAULT_KEY_BYTES,
        crate::domains::vaults::key::ENCRYPTED_VAULT_KEY_MAX_BYTES
    );
    assert_eq!(NAME_MIN_CHARS, crate::domains::vaults::VAULT_NAME_MIN_CHARS);
    assert_eq!(NAME_MAX_CHARS, crate::domains::vaults::VAULT_NAME_MAX_CHARS);
    assert_eq!(ICON_MAX_CHARS, crate::domains::vaults::VAULT_ICON_MAX_CHARS);
    assert_eq!(
        ITEM_CIPHERTEXT_BYTES as usize + 64 * 1024,
        crate::domains::vaults::http::ITEM_BODY_LIMIT_BYTES,
        "the item body limit must leave room for the ciphertext bound plus envelope",
    );
}
