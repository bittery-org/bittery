//! Bounded, owner-bound physical key pages. Cursors retain no scan registry or payload bytes.
use super::{
    persistence_contract::replica_invariant, ReplicaInventoryContinuation, ReplicaInventoryFamily,
    ReplicaInventoryPage, ReplicaPersistenceResponse, ReplicaPhysicalKey,
};
use crate::{wire::map_only_serde, RuntimeError, RuntimeErrorCode};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

pub(super) const KEY_BYTES: usize = 4096;
pub(super) const PAGE_ENTRIES: usize = 128;
const PAGE_BYTES: usize = 262_144;
const CURSOR_BYTES: usize = 96 * 1024;

pub(super) fn validate_cursor_size(cursor: Option<&str>) -> Result<(), RuntimeError> {
    if cursor.is_some_and(|cursor| cursor.is_empty() || cursor.len() > CURSOR_BYTES) {
        return Err(invalid("Replica inventory cursor is invalid"));
    }
    Ok(())
}

pub(super) fn validate_response_size(bytes: usize) -> Result<(), RuntimeError> {
    if bytes > PAGE_BYTES {
        return Err(bound());
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    version: u32,
    owner: String,
    after: ReplicaPhysicalKey,
}

map_only_serde!(Cursor);

pub(super) fn decode_cursor(
    owner: &str,
    cursor: Option<&str>,
) -> Result<Option<ReplicaPhysicalKey>, RuntimeError> {
    validate_cursor_size(cursor)?;
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| invalid("Replica inventory cursor is invalid"))?;
    let cursor: Cursor = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("Replica inventory cursor is invalid"))?;
    if cursor.version != 1 || cursor.owner != owner {
        return Err(invalid("Replica inventory cursor belongs to another owner"));
    }
    validate_key(&cursor.after)?;
    Ok(Some(cursor.after))
}

fn encode_cursor(owner: &str, after: &ReplicaPhysicalKey) -> Result<String, RuntimeError> {
    let bytes = serde_json::to_vec(&Cursor {
        version: 1,
        owner: owner.into(),
        after: after.clone(),
    })
    .map_err(|_| invalid("Replica inventory cursor could not be encoded"))?;
    let cursor = URL_SAFE_NO_PAD.encode(bytes);
    if cursor.len() > CURSOR_BYTES {
        return Err(bound());
    }
    Ok(cursor)
}

pub(super) fn validate_text(bytes: &[u8]) -> Result<&str, RuntimeError> {
    if bytes.is_empty() {
        return Err(invalid("Replica inventory key is empty"));
    }
    if bytes.len() > KEY_BYTES {
        return Err(bound());
    }
    std::str::from_utf8(bytes).map_err(|_| invalid("Replica inventory key is not UTF-8"))
}

pub(super) fn validate_key(key: &ReplicaPhysicalKey) -> Result<(), RuntimeError> {
    match key {
        ReplicaPhysicalKey::Head { account_id } => {
            validate_text(account_id.as_str().as_bytes())?;
        }
        ReplicaPhysicalKey::Row {
            account_id,
            record_id,
            ..
        } => {
            validate_text(account_id.as_str().as_bytes())?;
            validate_text(record_id.as_bytes())?;
        }
    }
    Ok(())
}

/// Heads precede rows, then each family's native SQLite primary-key order.
pub(super) fn compare(left: &ReplicaPhysicalKey, right: &ReplicaPhysicalKey) -> Ordering {
    fn key(value: &ReplicaPhysicalKey) -> (u8, &str, i64, &str) {
        match value {
            ReplicaPhysicalKey::Head { account_id } => (0, account_id.as_str(), 0, ""),
            ReplicaPhysicalKey::Row {
                account_id,
                store,
                record_id,
            } => (1, account_id.as_str(), store.physical_id(), record_id),
        }
    }
    key(left).cmp(&key(right))
}

pub(super) fn validate_page(page: &ReplicaInventoryPage) -> Result<(), RuntimeError> {
    if page.version != 1 || page.entries.len() > PAGE_ENTRIES {
        return Err(invalid("Replica inventory page is invalid"));
    }
    for key in &page.entries {
        validate_key(key)?;
    }
    if page
        .entries
        .windows(2)
        .any(|keys| compare(&keys[0], &keys[1]) != Ordering::Less)
    {
        return Err(invalid("Replica inventory keys do not advance"));
    }
    if let ReplicaInventoryContinuation::More { cursor } = &page.continuation {
        if page.entries.is_empty() || cursor.is_empty() || cursor.len() > CURSOR_BYTES {
            return Err(invalid("Replica inventory continuation is invalid"));
        }
    }
    validate_response_size(response_bytes(page)?)
}

fn response_bytes(page: &ReplicaInventoryPage) -> Result<usize, RuntimeError> {
    serde_json::to_vec(&ReplicaPersistenceResponse::InventoryPage(page.clone()))
        .map(|bytes| bytes.len())
        .map_err(|_| replica_invariant("Replica inventory page could not be encoded"))
}

pub(super) struct PageBuilder<'a> {
    owner: &'a str,
    after: Option<&'a ReplicaPhysicalKey>,
    page: ReplicaInventoryPage,
}

/// The InMemory adapter has unordered maps. Retain only the next page and its lookahead key.
pub(super) fn select_key(
    selected: &mut Vec<ReplicaPhysicalKey>,
    after: Option<&ReplicaPhysicalKey>,
    key: ReplicaPhysicalKey,
) -> Result<(), RuntimeError> {
    validate_key(&key)?;
    if after.is_some_and(|after| compare(&key, after) != Ordering::Greater) {
        return Ok(());
    }
    let index = selected
        .binary_search_by(|candidate| compare(candidate, &key))
        .map_or_else(Ok, |_| Err(invalid("Replica inventory key is duplicated")))?;
    if index <= PAGE_ENTRIES {
        selected.insert(index, key);
        selected.truncate(PAGE_ENTRIES + 1);
    }
    Ok(())
}

impl<'a> PageBuilder<'a> {
    pub(super) fn new(owner: &'a str, after: Option<&'a ReplicaPhysicalKey>) -> Self {
        Self {
            owner,
            after,
            page: ReplicaInventoryPage {
                version: 1,
                family: ReplicaInventoryFamily::Replica,
                entries: Vec::new(),
                continuation: ReplicaInventoryContinuation::End {},
            },
        }
    }

    /// False means this validated key belongs to the next page. The caller stops its raw scan.
    pub(super) fn push(&mut self, key: ReplicaPhysicalKey) -> Result<bool, RuntimeError> {
        validate_key(&key)?;
        if self
            .page
            .entries
            .last()
            .or(self.after)
            .is_some_and(|previous| compare(previous, &key) != Ordering::Less)
        {
            return Err(invalid("Replica inventory keys do not advance"));
        }
        if self.page.entries.len() == PAGE_ENTRIES {
            return Ok(false);
        }
        let previous_continuation = self.page.continuation.clone();
        self.page.continuation = ReplicaInventoryContinuation::More {
            cursor: encode_cursor(self.owner, &key)?,
        };
        self.page.entries.push(key);
        if response_bytes(&self.page)? > PAGE_BYTES {
            self.page.entries.pop();
            self.page.continuation = previous_continuation;
            if self.page.entries.is_empty() {
                return Err(bound());
            }
            return Ok(false);
        }
        Ok(true)
    }

    pub(super) fn finish(mut self, more: bool) -> Result<ReplicaInventoryPage, RuntimeError> {
        if !more {
            self.page.continuation = ReplicaInventoryContinuation::End {};
        }
        validate_page(&self.page)?;
        Ok(self.page)
    }
}

fn invalid(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::StorageUnavailable, message)
}

fn bound() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::SizeRejected,
        "Replica inventory exceeds its bounded key page",
    )
}
