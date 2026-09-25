//! Bounded physical key pages through the existing artifact owner, without reachable-owner joins.
use crate::{wire::map_only_serde, AccountId, RuntimeError, RuntimeErrorCode};
#[cfg(not(target_arch = "wasm32"))]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

const KEY_BYTES: usize = 4096;
const PAGE_ENTRIES: usize = 128;
const CONTROL_BYTES: usize = 262_144;
const CURSOR_BYTES: usize = 96 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentArtifactInventoryFamily {
    AttachmentArtifacts,
}

/// Physical key layout, not a new SQLite database stamp.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentArtifactInventorySchema {
    SqliteV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum AttachmentArtifactInventoryContinuation {
    More { cursor: String },
    End {},
}

/// These are physical row keys only. Their presence confers no workflow or publication authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum AttachmentArtifactPhysicalKey {
    Artifact {
        account_id: AccountId,
        artifact_id: String,
    },
    ArtifactChunk {
        account_id: AccountId,
        artifact_id: String,
        chunk_index: u32,
    },
    // SQLite has one current row per scope; generation is a value, not part of this primary key.
    ProvisionalScope {
        account_id: AccountId,
        operation_id: String,
        attachment_id: String,
    },
    ProvisionalChunk {
        account_id: AccountId,
        operation_id: String,
        attachment_id: String,
        generation: String,
        chunk_index: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachmentArtifactInventoryPage {
    pub version: u32,
    pub family: AttachmentArtifactInventoryFamily,
    pub schema: AttachmentArtifactInventorySchema,
    pub entries: Vec<AttachmentArtifactPhysicalKey>,
    pub continuation: AttachmentArtifactInventoryContinuation,
}

map_only_serde!(
    AttachmentArtifactInventoryContinuation,
    AttachmentArtifactPhysicalKey,
    AttachmentArtifactInventoryPage,
);

impl AttachmentArtifactInventoryPage {
    /// Validate bounded physical evidence before Runtime interprets ownership.
    #[doc(hidden)]
    pub fn validate(&self) -> Result<(), RuntimeError> {
        if self.version != 1 || self.entries.len() > PAGE_ENTRIES {
            return Err(invalid("Attachment artifact inventory page is invalid"));
        }
        for key in &self.entries {
            validate_key(key)?;
        }
        if self
            .entries
            .windows(2)
            .any(|pair| compare(&pair[0], &pair[1]) != Ordering::Less)
        {
            return Err(invalid("Attachment artifact inventory keys do not advance"));
        }
        if let AttachmentArtifactInventoryContinuation::More { cursor } = &self.continuation {
            validate_cursor(Some(cursor))?;
            if self.entries.is_empty() {
                return Err(invalid(
                    "Attachment artifact inventory continuation has no entries",
                ));
            }
        }
        if response_bytes(self)? > CONTROL_BYTES {
            return Err(bound());
        }
        Ok(())
    }
}

pub(super) fn validate_text(bytes: &[u8]) -> Result<&str, RuntimeError> {
    if bytes.is_empty() {
        return Err(invalid("Attachment artifact inventory key is empty"));
    }
    if bytes.len() > KEY_BYTES {
        return Err(bound());
    }
    std::str::from_utf8(bytes)
        .map_err(|_| invalid("Attachment artifact inventory key is not UTF-8"))
}

fn validate_key(key: &AttachmentArtifactPhysicalKey) -> Result<(), RuntimeError> {
    use AttachmentArtifactPhysicalKey::*;
    let (account, strings) = match key {
        Artifact {
            account_id,
            artifact_id,
        }
        | ArtifactChunk {
            account_id,
            artifact_id,
            ..
        } => (account_id, vec![artifact_id.as_str()]),
        ProvisionalScope {
            account_id,
            operation_id,
            attachment_id,
        } => (
            account_id,
            vec![operation_id.as_str(), attachment_id.as_str()],
        ),
        ProvisionalChunk {
            account_id,
            operation_id,
            attachment_id,
            generation,
            ..
        } => (
            account_id,
            vec![
                operation_id.as_str(),
                attachment_id.as_str(),
                generation.as_str(),
            ],
        ),
    };
    validate_text(account.as_str().as_bytes())?;
    for value in strings {
        validate_text(value.as_bytes())?;
    }
    Ok(())
}

/// Table order followed by each table's native primary-key order, with UTF-8 byte text order.
pub(super) fn compare(
    left: &AttachmentArtifactPhysicalKey,
    right: &AttachmentArtifactPhysicalKey,
) -> Ordering {
    fn parts(key: &AttachmentArtifactPhysicalKey) -> (u8, &str, &str, &str, &str, u32) {
        use AttachmentArtifactPhysicalKey::*;
        match key {
            Artifact {
                account_id,
                artifact_id,
            } => (0, account_id.as_str(), artifact_id, "", "", 0),
            ArtifactChunk {
                account_id,
                artifact_id,
                chunk_index,
            } => (1, account_id.as_str(), artifact_id, "", "", *chunk_index),
            ProvisionalScope {
                account_id,
                operation_id,
                attachment_id,
            } => (2, account_id.as_str(), operation_id, attachment_id, "", 0),
            ProvisionalChunk {
                account_id,
                operation_id,
                attachment_id,
                generation,
                chunk_index,
            } => (
                3,
                account_id.as_str(),
                operation_id,
                attachment_id,
                generation,
                *chunk_index,
            ),
        }
    }
    parts(left).cmp(&parts(right))
}

#[derive(Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg(not(target_arch = "wasm32"))]
struct Cursor {
    version: u32,
    owner: String,
    after: AttachmentArtifactPhysicalKey,
}

#[cfg(not(target_arch = "wasm32"))]
map_only_serde!(Cursor);

fn validate_cursor(cursor: Option<&str>) -> Result<(), RuntimeError> {
    if cursor.is_some_and(|cursor| cursor.is_empty() || cursor.len() > CURSOR_BYTES) {
        return Err(invalid("Attachment artifact inventory cursor is invalid"));
    }
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn decode_cursor(
    owner: &str,
    cursor: Option<&str>,
) -> Result<Option<AttachmentArtifactPhysicalKey>, RuntimeError> {
    validate_cursor(cursor)?;
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| invalid("Attachment artifact inventory cursor is invalid"))?;
    let cursor: Cursor = serde_json::from_slice(&bytes)
        .map_err(|_| invalid("Attachment artifact inventory cursor is invalid"))?;
    if cursor.version != 1 || cursor.owner != owner {
        return Err(invalid(
            "Attachment artifact inventory cursor belongs to another owner",
        ));
    }
    validate_key(&cursor.after)?;
    Ok(Some(cursor.after))
}

#[cfg(not(target_arch = "wasm32"))]
fn encode_cursor(
    owner: &str,
    after: &AttachmentArtifactPhysicalKey,
) -> Result<String, RuntimeError> {
    let bytes = serde_json::to_vec(&Cursor {
        version: 1,
        owner: owner.into(),
        after: after.clone(),
    })
    .map_err(|_| invalid("Attachment artifact inventory cursor could not serialize"))?;
    let cursor = URL_SAFE_NO_PAD.encode(bytes);
    if cursor.len() > CURSOR_BYTES {
        return Err(bound());
    }
    Ok(cursor)
}

fn response_bytes(page: &AttachmentArtifactInventoryPage) -> Result<usize, RuntimeError> {
    #[derive(Serialize)]
    #[serde(tag = "type", rename_all = "camelCase")]
    enum Response<'a> {
        InventoryPage(&'a AttachmentArtifactInventoryPage),
    }
    serde_json::to_vec(&Response::InventoryPage(page))
        .map(|bytes| bytes.len())
        .map_err(|_| invalid("Attachment artifact inventory page could not serialize"))
}

#[cfg(not(target_arch = "wasm32"))]
pub(super) struct PageBuilder<'a> {
    owner: &'a str,
    after: Option<&'a AttachmentArtifactPhysicalKey>,
    page: AttachmentArtifactInventoryPage,
}

#[cfg(not(target_arch = "wasm32"))]
impl<'a> PageBuilder<'a> {
    pub(super) fn new(owner: &'a str, after: Option<&'a AttachmentArtifactPhysicalKey>) -> Self {
        Self {
            owner,
            after,
            page: AttachmentArtifactInventoryPage {
                version: 1,
                family: AttachmentArtifactInventoryFamily::AttachmentArtifacts,
                schema: AttachmentArtifactInventorySchema::SqliteV1,
                entries: Vec::new(),
                continuation: AttachmentArtifactInventoryContinuation::End {},
            },
        }
    }

    /// False leaves this validated key for the next page. No physical row is ever consumed.
    pub(super) fn push(
        &mut self,
        key: AttachmentArtifactPhysicalKey,
    ) -> Result<bool, RuntimeError> {
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
            return Err(invalid("Attachment artifact inventory keys do not advance"));
        }
        if self.page.entries.len() == PAGE_ENTRIES {
            return Ok(false);
        }
        let previous = self.page.continuation.clone();
        self.page.continuation = AttachmentArtifactInventoryContinuation::More {
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

    pub(super) fn finish(
        mut self,
        more: bool,
    ) -> Result<AttachmentArtifactInventoryPage, RuntimeError> {
        if !more {
            self.page.continuation = AttachmentArtifactInventoryContinuation::End {};
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
        "Attachment artifact inventory exceeds its bounded key page",
    )
}
