//! Exact encrypted Import wire shape shared by acceptance and persisted-request validation.
//!
//! Declaration order is the frozen JSON field order. Sharing this shape does not share either
//! caller's validation policy: Runtime still checks acceptance and Replica still checks trust.
use serde::{Deserialize, Serialize};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportRequestItem {
    pub item_id: String,
    pub category: crate::server_contract::ItemCategory,
    pub favorite: bool,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImportRequestBody {
    pub items: Vec<ImportRequestItem>,
}
