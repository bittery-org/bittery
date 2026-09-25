//! Physical image keys through the existing store owner, independent of publication authority.
use crate::{wire::map_only_serde, AccountId, RuntimeError, RuntimeErrorCode};
#[cfg(not(target_arch = "wasm32"))]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

const KEY_BYTES: usize = 4096;
const PAGE_ENTRIES: usize = 128;
const CONTROL_BYTES: usize = 262_144;
const CURSOR_BYTES: usize = 98_304;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VaultImageInventoryFamily {
    VaultImages,
}

/// Physical key layout, not a new SQLite database stamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VaultImageInventorySchema {
    SqliteV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum VaultImageInventoryContinuation {
    More { cursor: String },
    End {},
}

/// The empty publication ID is the physical legacy raw generation, not absent evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum VaultImagePhysicalKey {
    Metadata {
        account_id: AccountId,
        operation_id: String,
        publication_id: String,
    },
    Chunk {
        account_id: AccountId,
        operation_id: String,
        publication_id: String,
        chunk_index: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultImageInventoryPage {
    pub version: u32,
    pub family: VaultImageInventoryFamily,
    pub schema: VaultImageInventorySchema,
    pub entries: Vec<VaultImagePhysicalKey>,
    pub continuation: VaultImageInventoryContinuation,
}

map_only_serde!(
    VaultImageInventoryContinuation,
    VaultImagePhysicalKey,
    VaultImageInventoryPage,
);

impl VaultImageInventoryPage {
    /// Validate bounded physical evidence before Runtime interprets ownership.
    #[doc(hidden)]
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.version != 1 || self.entries.len() > PAGE_ENTRIES {
            return Err(invalid("Vault image inventory page is invalid"));
        }
        for key in &self.entries {
            validate_key(key)?;
        }
        if self
            .entries
            .windows(2)
            .any(|pair| compare(&pair[0], &pair[1]) != Ordering::Less)
        {
            return Err(invalid("Vault image inventory keys do not advance"));
        }
        if let VaultImageInventoryContinuation::More { cursor } = &self.continuation {
            validate_cursor(Some(cursor))?;
            if self.entries.is_empty() {
                return Err(invalid("Vault image inventory continuation has no entries"));
            }
        }
        if response_bytes(self)? > CONTROL_BYTES {
            return Err(bound());
        }
        Ok(())
    }
}

pub(super) fn validate_text(bytes: &[u8], allow_empty: bool) -> Result<&str, RuntimeError> {
    if !allow_empty && bytes.is_empty() {
        return Err(invalid("Vault image inventory key is empty"));
    }
    if bytes.len() > KEY_BYTES {
        return Err(bound());
    }
    std::str::from_utf8(bytes).map_err(|_| invalid("Vault image inventory key is not UTF-8"))
}

fn validate_key(key: &VaultImagePhysicalKey) -> Result<(), RuntimeError> {
    let (account, operation, publication) = match key {
        VaultImagePhysicalKey::Metadata {
            account_id,
            operation_id,
            publication_id,
        }
        | VaultImagePhysicalKey::Chunk {
            account_id,
            operation_id,
            publication_id,
            ..
        } => (account_id, operation_id, publication_id),
    };
    validate_text(account.as_str().as_bytes(), false)?;
    validate_text(operation.as_bytes(), false)?;
    validate_text(publication.as_bytes(), true)?;
    Ok(())
}

/// Table order, then its complete physical primary key in UTF-8 byte/numeric order.
fn compare(left: &VaultImagePhysicalKey, right: &VaultImagePhysicalKey) -> Ordering {
    fn parts(key: &VaultImagePhysicalKey) -> (u8, &str, &str, &str, u32) {
        match key {
            VaultImagePhysicalKey::Metadata {
                account_id,
                operation_id,
                publication_id,
            } => (0, account_id.as_str(), operation_id, publication_id, 0),
            VaultImagePhysicalKey::Chunk {
                account_id,
                operation_id,
                publication_id,
                chunk_index,
            } => (
                1,
                account_id.as_str(),
                operation_id,
                publication_id,
                *chunk_index,
            ),
        }
    }
    parts(left).cmp(&parts(right))
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    version: u32,
    owner: String,
    after: VaultImagePhysicalKey,
}

#[cfg(not(target_arch = "wasm32"))]
map_only_serde!(Cursor);

fn validate_cursor(cursor: Option<&str>) -> Result<(), RuntimeError> {
    if cursor.is_some_and(|cursor| cursor.is_empty() || cursor.len() > CURSOR_BYTES) {
        return Err(invalid("Vault image inventory cursor is invalid"));
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn decode_cursor(
    owner: &str,
    cursor: Option<&str>,
) -> Result<Option<VaultImagePhysicalKey>, RuntimeError> {
    validate_cursor(cursor)?;
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| invalid("Vault image inventory cursor is invalid"))?;
    let cursor: Cursor = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("Vault image inventory cursor is invalid"))?;
    if cursor.version != 1 || cursor.owner != owner {
        return Err(invalid(
            "Vault image inventory cursor belongs to another owner",
        ));
    }
    validate_key(&cursor.after)?;
    Ok(Some(cursor.after))
}

#[cfg(not(target_arch = "wasm32"))]
fn encode_cursor(owner: &str, after: &VaultImagePhysicalKey) -> Result<String, RuntimeError> {
    let bytes = serde_json::to_vec(&Cursor {
        version: 1,
        owner: owner.into(),
        after: after.clone(),
    })
    .map_err(|_| invalid("Vault image inventory cursor could not serialize"))?;
    let cursor = URL_SAFE_NO_PAD.encode(bytes);
    if cursor.len() > CURSOR_BYTES {
        return Err(bound());
    }
    Ok(cursor)
}

fn response_bytes(page: &VaultImageInventoryPage) -> Result<usize, RuntimeError> {
    #[derive(Serialize)]
    #[serde(tag = "type", rename_all = "camelCase")]
    enum Response<'a> {
        InventoryPage(&'a VaultImageInventoryPage),
    }
    serde_json::to_vec(&Response::InventoryPage(page))
        .map(|bytes| bytes.len())
        .map_err(|_| invalid("Vault image inventory page could not serialize"))
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) struct PageBuilder<'a> {
    owner: &'a str,
    after: Option<&'a VaultImagePhysicalKey>,
    page: VaultImageInventoryPage,
}

#[cfg(not(target_arch = "wasm32"))]
impl<'a> PageBuilder<'a> {
    pub(super) fn new(owner: &'a str, after: Option<&'a VaultImagePhysicalKey>) -> Self {
        Self {
            owner,
            after,
            page: VaultImageInventoryPage {
                version: 1,
                family: VaultImageInventoryFamily::VaultImages,
                schema: VaultImageInventorySchema::SqliteV1,
                entries: Vec::new(),
                continuation: VaultImageInventoryContinuation::End {},
            },
        }
    }

    /// False leaves this validated row for the next page; no physical row is consumed.
    pub(super) fn push(&mut self, key: VaultImagePhysicalKey) -> Result<bool, RuntimeError> {
        validate_key(&key)?;
        if self
            .after
            .is_some_and(|after| compare(&key, after) != Ordering::Greater)
        {
            return Ok(true);
        }
        if self
            .page
            .entries
            .last()
            .is_some_and(|previous| compare(previous, &key) != Ordering::Less)
        {
            return Err(invalid("Vault image inventory keys do not advance"));
        }
        if self.page.entries.len() == PAGE_ENTRIES {
            return Ok(false);
        }
        let previous = self.page.continuation.clone();
        self.page.continuation = VaultImageInventoryContinuation::More {
            cursor: encode_cursor(self.owner, &key)?,
        };
        self.page.entries.push(key);
        if response_bytes(&self.page)? > CONTROL_BYTES {
            self.page.entries.pop();
            self.page.continuation = previous;
            if self.page.entries.is_empty() {
                return Err(bound());
            }
            return Ok(false);
        }
        Ok(true)
    }

    pub(super) fn finish(mut self, more: bool) -> Result<VaultImageInventoryPage, RuntimeError> {
        if !more {
            self.page.continuation = VaultImageInventoryContinuation::End {};
        }
        self.page.validate()?;
        Ok(self.page)
    }
}

pub(super) fn invalid(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::StorageUnavailable, message)
}

fn bound() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::SizeRejected,
        "Vault image inventory exceeds its bounded key page",
    )
}
