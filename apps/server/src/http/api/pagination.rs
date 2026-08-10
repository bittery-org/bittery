#[cfg(not(test))]
use std::env;

use axum::{
    extract::{FromRequestParts, Query},
    http::request::Parts,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use super::{
    dto::{CursorPage, PageCursor, PageRequest, MAX_PAGE_SIZE},
    error::ApiError,
};

type HmacSha256 = Hmac<Sha256>;

pub(crate) const RESPONSE_PAGE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const RESPONSE_PAGE_ITEMS_BYTES: usize = RESPONSE_PAGE_BYTES - 16 * 1024;

pub(crate) fn truncate_serialized<T: Serialize>(
    values: &mut Vec<T>,
    maximum_bytes: usize,
) -> Result<bool, ApiError> {
    let mut serialized_bytes = 2usize;
    let mut keep = 0usize;
    for value in values.iter() {
        let item_bytes = serde_json::to_vec(value)
            .map_err(|_| ApiError::internal())?
            .len()
            + usize::from(keep > 0);
        if serialized_bytes + item_bytes > maximum_bytes {
            if keep == 0 {
                return Err(ApiError::payload_too_large(
                    "A single response item exceeds the page byte budget.",
                ));
            }
            break;
        }
        serialized_bytes += item_bytes;
        keep += 1;
    }
    let truncated = keep < values.len();
    values.truncate(keep);
    Ok(truncated)
}

pub(crate) struct ApiPageQuery(pub(crate) PageRequest);

impl<S> FromRequestParts<S> for ApiPageQuery
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let Query(request) = Query::<PageRequest>::from_request_parts(parts, state)
            .await
            .map_err(|error| ApiError::bad_request("INVALID_QUERY", error.body_text()))?;
        validate_page_request(&request)?;
        Ok(Self(request))
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CursorPayload {
    version: u8,
    principal: String,
    scope: String,
    filters: String,
    key: String,
}

fn cursor_secret() -> Result<Vec<u8>, ApiError> {
    #[cfg(test)]
    return Ok(Sha256::digest(b"pagination-test-secret").to_vec());
    #[cfg(not(test))]
    if let Ok(secret) = env::var("JWT_SECRET") {
        if !secret.trim().is_empty() {
            let mut hasher = Sha256::new();
            hasher.update(b"bittery-page-cursor-v1\0");
            hasher.update(secret.as_bytes());
            return Ok(hasher.finalize().to_vec());
        }
    }
    #[cfg(not(test))]
    Err(ApiError::internal())
}

fn principal_digest(principal: &str) -> String {
    hex::encode(Sha256::digest(principal.as_bytes()))
}

fn encode_cursor(
    principal: &str,
    scope: &str,
    filters: &str,
    key: String,
) -> Result<PageCursor, ApiError> {
    let payload = serde_json::to_vec(&CursorPayload {
        version: 1,
        principal: principal_digest(principal),
        scope: scope.to_string(),
        filters: filters.to_string(),
        key,
    })
    .map_err(|_| ApiError::internal())?;
    let encoded_payload = URL_SAFE_NO_PAD.encode(payload);
    let mut mac =
        HmacSha256::new_from_slice(&cursor_secret()?).map_err(|_| ApiError::internal())?;
    mac.update(encoded_payload.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(PageCursor::new(format!("{encoded_payload}.{signature}")))
}

fn decode_cursor(
    cursor: &PageCursor,
    principal: &str,
    scope: &str,
    filters: &str,
) -> Result<String, ApiError> {
    let (encoded_payload, encoded_signature) =
        cursor.as_str().split_once('.').ok_or_else(invalid_cursor)?;
    let signature = URL_SAFE_NO_PAD
        .decode(encoded_signature)
        .map_err(|_| invalid_cursor())?;
    let mut mac =
        HmacSha256::new_from_slice(&cursor_secret()?).map_err(|_| ApiError::internal())?;
    mac.update(encoded_payload.as_bytes());
    mac.verify_slice(&signature).map_err(|_| invalid_cursor())?;
    let payload = URL_SAFE_NO_PAD
        .decode(encoded_payload)
        .map_err(|_| invalid_cursor())?;
    let payload: CursorPayload = serde_json::from_slice(&payload).map_err(|_| invalid_cursor())?;
    if payload.version != 1
        || payload.principal != principal_digest(principal)
        || payload.scope != scope
        || payload.filters != filters
    {
        return Err(invalid_cursor());
    }
    Ok(payload.key)
}

fn invalid_cursor() -> ApiError {
    ApiError::bad_request(
        "INVALID_CURSOR",
        "The page cursor is invalid for this request.",
    )
}

pub(crate) fn decode_page_key(
    request: &PageRequest,
    principal: &str,
    scope: &str,
    filters: &str,
) -> Result<Option<String>, ApiError> {
    request
        .cursor
        .as_ref()
        .map(|cursor| decode_cursor(cursor, principal, scope, filters))
        .transpose()
}

pub(crate) fn timestamp_cursor_key(key: &str) -> Result<(OffsetDateTime, String), ApiError> {
    let (timestamp, id) = key.split_once('\0').ok_or_else(invalid_cursor)?;
    if id.is_empty() {
        return Err(invalid_cursor());
    }
    let timestamp = OffsetDateTime::parse(timestamp, &Rfc3339).map_err(|_| invalid_cursor())?;
    Ok((timestamp, id.to_string()))
}

pub(crate) fn query_limit(request: &PageRequest) -> Result<i64, ApiError> {
    validate_page_request(request)?;
    Ok(i64::from(request.limit) + 1)
}

pub(crate) fn page_prefetched<T, F>(
    values: Vec<T>,
    request: &PageRequest,
    principal: &str,
    scope: &str,
    filters: &str,
    key: F,
) -> Result<CursorPage<T>, ApiError>
where
    T: Serialize,
    F: Fn(&T) -> String,
{
    page_prefetched_with_more(values, false, request, principal, scope, filters, key)
}

pub(crate) fn page_prefetched_with_more<T, F>(
    mut values: Vec<T>,
    source_has_more: bool,
    request: &PageRequest,
    principal: &str,
    scope: &str,
    filters: &str,
    key: F,
) -> Result<CursorPage<T>, ApiError>
where
    T: Serialize,
    F: Fn(&T) -> String,
{
    validate_page_request(request)?;
    let count_truncated = values.len() > usize::from(request.limit);
    values.truncate(usize::from(request.limit));
    let bytes_truncated = truncate_serialized(&mut values, RESPONSE_PAGE_ITEMS_BYTES)?;
    let has_more = source_has_more || count_truncated || bytes_truncated;
    let next_cursor = if has_more {
        values
            .last()
            .map(|value| encode_cursor(principal, scope, filters, key(value)))
            .transpose()?
    } else {
        None
    };
    Ok(CursorPage {
        items: values,
        next_cursor,
        has_more,
    })
}

pub(crate) fn validate_page_request(request: &PageRequest) -> Result<(), ApiError> {
    if request.limit == 0 || request.limit > MAX_PAGE_SIZE {
        return Err(ApiError::bad_request(
            "INVALID_PAGE_LIMIT",
            format!("limit must be between 1 and {MAX_PAGE_SIZE}"),
        ));
    }
    Ok(())
}

pub(crate) fn page_values<T, F>(
    values: Vec<T>,
    request: &PageRequest,
    principal: &str,
    scope: &str,
    filters: &str,
    key: F,
) -> Result<CursorPage<T>, ApiError>
where
    T: Serialize,
    F: Fn(&T) -> String,
{
    validate_page_request(request)?;
    let start = match request.cursor.as_ref() {
        Some(cursor) => {
            let cursor_key = decode_cursor(cursor, principal, scope, filters)?;
            values
                .iter()
                .position(|value| key(value) == cursor_key)
                .map(|index| index + 1)
                .ok_or_else(invalid_cursor)?
        }
        None => 0,
    };

    let total = values.len();
    let mut items = Vec::new();
    let mut serialized_bytes = 2usize;
    for value in values.into_iter().skip(start) {
        if items.len() >= usize::from(request.limit) {
            break;
        }
        let item_bytes = serde_json::to_vec(&value)
            .map_err(|_| ApiError::internal())?
            .len()
            + usize::from(!items.is_empty());
        if serialized_bytes + item_bytes > RESPONSE_PAGE_ITEMS_BYTES {
            if items.is_empty() {
                return Err(ApiError::payload_too_large(
                    "A single response item exceeds the page byte budget.",
                ));
            }
            break;
        }
        serialized_bytes += item_bytes;
        items.push(value);
    }

    let has_more = start + items.len() < total;
    let next_cursor = if has_more {
        items
            .last()
            .map(|value| encode_cursor(principal, scope, filters, key(value)))
            .transpose()?
    } else {
        None
    };
    Ok(CursorPage {
        items,
        next_cursor,
        has_more,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Serialize)]
    struct Row {
        timestamp: &'static str,
        id: &'static str,
        payload: String,
    }

    fn rows() -> Vec<Row> {
        vec![
            Row {
                timestamp: "same",
                id: "a",
                payload: "a".into(),
            },
            Row {
                timestamp: "same",
                id: "b",
                payload: "b".into(),
            },
            Row {
                timestamp: "older",
                id: "c",
                payload: "c".into(),
            },
        ]
    }

    fn key(row: &Row) -> String {
        format!("{}\0{}", row.timestamp, row.id)
    }

    #[test]
    fn pages_continue_across_equal_timestamps_without_duplicates() {
        let first = page_values(
            rows(),
            &PageRequest {
                cursor: None,
                limit: 1,
            },
            "user-a",
            "items",
            "active",
            key,
        )
        .unwrap();
        let second = page_values(
            rows(),
            &PageRequest {
                cursor: first.next_cursor,
                limit: 2,
            },
            "user-a",
            "items",
            "active",
            key,
        )
        .unwrap();
        assert_eq!(
            second.items.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        assert!(!second.has_more);
    }

    #[test]
    fn cursor_rejects_tampering_principal_endpoint_and_filters() {
        let page = page_values(
            rows(),
            &PageRequest {
                cursor: None,
                limit: 1,
            },
            "user-a",
            "items",
            "active",
            key,
        )
        .unwrap();
        let cursor = page.next_cursor.unwrap();
        let mut tampered = cursor.as_str().as_bytes().to_vec();
        tampered[0] = if tampered[0] == b'a' { b'b' } else { b'a' };
        let tampered = PageCursor::new(String::from_utf8(tampered).unwrap());
        for (candidate, principal, scope, filters) in [
            (tampered, "user-a", "items", "active"),
            (cursor.clone(), "user-b", "items", "active"),
            (cursor.clone(), "user-a", "vaults", "active"),
            (cursor, "user-a", "items", "trashed"),
        ] {
            let error = page_values(
                rows(),
                &PageRequest {
                    cursor: Some(candidate),
                    limit: 1,
                },
                principal,
                scope,
                filters,
                key,
            )
            .unwrap_err();
            assert_eq!(error.code(), "INVALID_CURSOR");
        }
    }

    #[test]
    fn page_stops_before_the_serialized_byte_budget() {
        let values = (0..10)
            .map(|index| Row {
                timestamp: "same",
                id: Box::leak(index.to_string().into_boxed_str()),
                payload: "x".repeat(RESPONSE_PAGE_BYTES / 2),
            })
            .collect();
        let page = page_values(
            values,
            &PageRequest {
                cursor: None,
                limit: 10,
            },
            "user-a",
            "items",
            "active",
            key,
        )
        .unwrap();
        assert_eq!(page.items.len(), 1);
        assert!(page.has_more);
    }

    #[test]
    fn page_rejects_a_first_item_larger_than_the_serialized_byte_budget() {
        let error = page_values(
            vec![Row {
                timestamp: "same",
                id: "oversized",
                payload: "x".repeat(RESPONSE_PAGE_BYTES),
            }],
            &PageRequest {
                cursor: None,
                limit: 1,
            },
            "user-a",
            "items",
            "active",
            key,
        )
        .unwrap_err();

        assert_eq!(error.code(), "PAYLOAD_TOO_LARGE");
    }

    #[test]
    fn truncation_rejects_a_first_item_larger_than_the_requested_budget() {
        let mut values = vec![Row {
            timestamp: "same",
            id: "oversized",
            payload: "x".repeat(32),
        }];

        let error = truncate_serialized(&mut values, 16).unwrap_err();

        assert_eq!(error.code(), "PAYLOAD_TOO_LARGE");
    }
}
