//! Typed legacy evidence attached to ordinary Replica Operations.
//!
//! Ciphertext remains owned by `OperationRecord.request` and its optimistic overlay. These records
//! preserve source lineage and envelope metadata without creating another payload owner.

use super::{
    create_item_fingerprint, item_operation_fingerprint, AuthorityItemCategory, OperationKind,
    OperationRecord, OperationSchedulingState, ReplicaItemRecord, ResourceRef, Sha256Fingerprint,
};
use crate::{
    http_transport::{HttpHeader, HttpMethod},
    wire::{decimal_u64, optional_decimal_u64},
    AccountId, RuntimeError, RuntimeErrorCode,
};
use serde::{Deserialize, Serialize};

pub(crate) const LEGACY_OPERATION_ADMISSION_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyOperationAdmission {
    pub version: u32,
    pub admission_id: String,
    #[serde(with = "decimal_u64")]
    pub source_queue_index: u64,
    pub source_command: LegacyItemCommandV1,
    pub disposition: LegacyOperationDisposition,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub overlay_sha256: Option<Sha256Fingerprint>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub captured_failure_code: Option<LegacyCreateFailureCode>,
}

/// Local cache evidence, distinct from a proven Server outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LegacyCreateFailureCode {
    InvalidCiphertext,
    VaultAccessDenied,
    VaultReadOnly,
    ItemIdConflict,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LegacyOperationDisposition {
    Normal,
    LegacyFailed,
    LegacyConflicted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[serde(bound(
    serialize = "Payload: Serialize",
    deserialize = "Payload: Deserialize<'de>"
))]
pub(crate) struct LegacyItemCommandV1<Payload = ImmutableRequestPayload> {
    pub account_id: AccountId,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub account_email: Option<String>,
    pub id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub operation_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub attempt_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: LegacyItemCommandKind,
    pub entity_id: String,
    pub vault_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub target_vault_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub target_account_id: Option<AccountId>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub target_item_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub category: Option<LegacyItemCategory>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub encrypted_payload: Option<Payload>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub favorite: Option<bool>,
    pub base_version: i32,
    #[serde(with = "decimal_u64")]
    pub timestamp: u64,
    #[serde(with = "decimal_u64")]
    pub retry_count: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub status: Option<LegacyItemCommandStatus>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub last_error: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "optional_decimal_u64::serialize",
        deserialize_with = "present_decimal_u64"
    )]
    pub next_attempt_at: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub conflict_copy_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub projection_claim_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "optional_decimal_u64::serialize",
        deserialize_with = "present_decimal_u64"
    )]
    pub projection_claim_expires_at: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LegacyItemCommandKind {
    Create,
    Update,
    Delete,
    PermanentDelete,
    Restore,
    Move,
    CrossAccountMove,
    ToggleFavorite,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LegacyItemCommandStatus {
    Staged,
    Applying,
    Pending,
    Retrying,
    Conflicted,
    Failed,
}

impl LegacyItemCommandStatus {
    pub(crate) fn is_normal(status: Option<Self>) -> bool {
        matches!(
            status,
            None | Some(Self::Staged | Self::Applying | Self::Pending | Self::Retrying)
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum LegacyItemCategory {
    #[serde(rename = "login")]
    Login,
    #[serde(rename = "secure-note")]
    SecureNote,
    #[serde(rename = "credit-card")]
    CreditCard,
    #[serde(rename = "identity")]
    Identity,
    #[serde(rename = "totp")]
    Totp,
}

impl From<LegacyItemCategory> for AuthorityItemCategory {
    fn from(value: LegacyItemCategory) -> Self {
        match value {
            LegacyItemCategory::Login => Self::Login,
            LegacyItemCategory::SecureNote => Self::SecureNote,
            LegacyItemCategory::CreditCard => Self::CreditCard,
            LegacyItemCategory::Identity => Self::Identity,
            LegacyItemCategory::Totp => Self::Totp,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImmutableRequestPayload {
    pub encryption_version: i32,
    pub encrypted_by_user_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyOperationReceiptLineage {
    pub version: u32,
    pub admission_id: String,
    #[serde(with = "decimal_u64")]
    pub source_queue_index: u64,
    pub source_command_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub source_operation_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub source_attempt_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub source_status: Option<LegacyItemCommandStatus>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub conflict_copy_id: Option<String>,
}

impl From<&LegacyOperationAdmission> for LegacyOperationReceiptLineage {
    fn from(value: &LegacyOperationAdmission) -> Self {
        Self {
            version: value.version,
            admission_id: value.admission_id.clone(),
            source_queue_index: value.source_queue_index,
            source_command_id: value.source_command.id.clone(),
            source_operation_id: value.source_command.operation_id.clone(),
            source_attempt_id: value.source_command.attempt_id.clone(),
            source_status: value.source_command.status,
            conflict_copy_id: value.source_command.conflict_copy_id.clone(),
        }
    }
}

impl LegacyOperationReceiptLineage {
    pub(crate) fn validate(&self) -> Result<(), RuntimeError> {
        if self.version != LEGACY_OPERATION_ADMISSION_VERSION
            || self.admission_id.is_empty()
            || self.source_command_id.is_empty()
            || self
                .source_operation_id
                .as_ref()
                .is_some_and(String::is_empty)
            || self
                .source_attempt_id
                .as_ref()
                .is_some_and(String::is_empty)
            || self.conflict_copy_id.as_ref().is_some_and(String::is_empty)
        {
            return Err(invalid("Legacy Operation receipt lineage is malformed"));
        }
        Ok(())
    }
}

impl LegacyOperationAdmission {
    /// Only the captured retry deadline schedules work; departed projection claims are history.
    pub(crate) fn initial_scheduling(&self) -> OperationSchedulingState {
        OperationSchedulingState {
            attempt_count: self.source_command.retry_count,
            not_before_ms: self.source_command.next_attempt_at.unwrap_or(0),
        }
    }

    pub(crate) fn validate(
        &self,
        account_id: &AccountId,
        operation: &OperationRecord,
        overlay: Option<&ReplicaItemRecord>,
    ) -> Result<(), RuntimeError> {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        let command = &self.source_command;
        if self.version != LEGACY_OPERATION_ADMISSION_VERSION
            || self.admission_id.is_empty()
            || command.account_id.as_str().is_empty()
            || &command.account_id != account_id
            || command.id.is_empty()
            || command.entity_id.is_empty()
            || command.vault_id.is_empty()
            || command.operation_id.as_ref().is_some_and(String::is_empty)
            || command.attempt_id.as_ref().is_some_and(String::is_empty)
            || command.account_email.as_ref().is_some_and(String::is_empty)
            || command
                .target_vault_id
                .as_ref()
                .is_some_and(String::is_empty)
            || command
                .target_account_id
                .as_ref()
                .is_some_and(|value| value.as_str().is_empty())
            || command
                .target_item_id
                .as_ref()
                .is_some_and(String::is_empty)
            || command
                .conflict_copy_id
                .as_ref()
                .is_some_and(String::is_empty)
            || command
                .projection_claim_id
                .as_ref()
                .is_some_and(String::is_empty)
            || command.base_version < 0
            || command.timestamp > MAX_SAFE_INTEGER
            || command.retry_count > MAX_SAFE_INTEGER
            || command
                .next_attempt_at
                .is_some_and(|value| value > MAX_SAFE_INTEGER)
            || command
                .projection_claim_expires_at
                .is_some_and(|value| value > MAX_SAFE_INTEGER)
            || command.encrypted_payload.as_ref().is_some_and(|payload| {
                payload.encryption_version <= 0 || payload.encrypted_by_user_id.is_empty()
            })
        {
            return Err(invalid("Legacy Operation admission evidence is malformed"));
        }
        let disposition_matches = match self.disposition {
            LegacyOperationDisposition::Normal => {
                LegacyItemCommandStatus::is_normal(command.status)
            }
            LegacyOperationDisposition::LegacyFailed => {
                command.status == Some(LegacyItemCommandStatus::Failed)
            }
            LegacyOperationDisposition::LegacyConflicted => {
                command.status == Some(LegacyItemCommandStatus::Conflicted)
            }
        };
        if !disposition_matches
            || (self.disposition != LegacyOperationDisposition::Normal
                && (!matches!(
                    command.kind,
                    LegacyItemCommandKind::Create
                        | LegacyItemCommandKind::Update
                        | LegacyItemCommandKind::ToggleFavorite
                        | LegacyItemCommandKind::Delete
                        | LegacyItemCommandKind::Restore
                        | LegacyItemCommandKind::PermanentDelete
                        | LegacyItemCommandKind::Move
                ) || (overlay.is_some() && self.captured_failure_code.is_none())))
            || (self.captured_failure_code.is_some()
                && (self.disposition != LegacyOperationDisposition::LegacyFailed
                    || command.kind != LegacyItemCommandKind::Create))
        {
            return Err(invalid(
                "Legacy Operation admission disposition is not supported",
            ));
        }
        match command.kind {
            LegacyItemCommandKind::Create => self.validate_create(operation, overlay),
            LegacyItemCommandKind::Update | LegacyItemCommandKind::Move => {
                self.validate_encrypted_mutation(operation, overlay)
            }
            LegacyItemCommandKind::ToggleFavorite
            | LegacyItemCommandKind::Delete
            | LegacyItemCommandKind::Restore
            | LegacyItemCommandKind::PermanentDelete => self.validate_metadata(operation, overlay),
            _ => Err(invalid("Legacy Operation kind is not supported")),
        }
    }

    fn validate_create(
        &self,
        operation: &OperationRecord,
        overlay: Option<&ReplicaItemRecord>,
    ) -> Result<(), RuntimeError> {
        let command = &self.source_command;
        let (Some(category), Some(payload)) = (command.category, &command.encrypted_payload) else {
            return Err(invalid("Legacy Create admission is incomplete"));
        };
        if self.overlay_sha256.is_some()
            || command.kind != LegacyItemCommandKind::Create
            || command.base_version != 0
            || payload.encryption_version != 1
            || command.target_vault_id.is_some()
            || command.target_account_id.is_some()
            || command.target_item_id.is_some()
            || command.favorite.is_some()
            || (self.disposition == LegacyOperationDisposition::Normal
                && command.conflict_copy_id.is_some())
        {
            return Err(invalid("Legacy Create admission fields are inconsistent"));
        }
        let expected_operation_id = command.operation_id.as_deref().unwrap_or(&command.id);
        let authority_category = AuthorityItemCategory::from(category);
        let body: CreateBody = serde_json::from_slice(&operation.request.body)
            .map_err(|_| invalid("Legacy Create request body is malformed"))?;
        let expected_body = serde_json::to_vec(&body)
            .map_err(|_| invalid("Legacy Create request body cannot be encoded"))?;
        let expected_path = format!(
            "/api/v1/vaults/{}/items/{}",
            encode_component(&command.vault_id),
            encode_component(&command.entity_id)
        );
        if operation.operation_id != expected_operation_id
            || operation.kind != OperationKind::CreateItem
            || operation.target
                != (ResourceRef::Item {
                    item_id: command.entity_id.clone(),
                    vault_id: command.vault_id.clone(),
                })
            || operation.request.method != HttpMethod::Put
            || operation.request.path != expected_path
            || operation.request.headers
                != [HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }]
            || operation.request.body != expected_body
            || operation.request_fingerprint
                != create_item_fingerprint(
                    &command.vault_id,
                    &command.entity_id,
                    &operation.request.body,
                )
            || operation.accepted_item_category.as_ref() != Some(&authority_category)
            || operation.attachment_move_recovery.is_some()
            || operation.create_vault.is_some()
            || operation.update_vault.is_some()
            || body.category != category
            || body.encrypted_data.is_empty()
            || body.encryption_iv.is_empty()
            || body.encryption_algorithm.is_empty()
        {
            return Err(invalid(
                "Legacy Create Operation changed from its admitted source command",
            ));
        }
        if let Some(overlay) = overlay {
            if overlay != &self.create_overlay(operation)? {
                return Err(invalid(
                    "Legacy Create overlay changed from its admitted source command",
                ));
            }
        }
        Ok(())
    }

    /// Create reconstructs a transient row when admitted with an overlay; mutations use their witness.
    pub(crate) fn expected_overlay_fingerprint(
        &self,
        account_id: &AccountId,
        operation: &OperationRecord,
    ) -> Result<Option<Sha256Fingerprint>, RuntimeError> {
        self.validate(account_id, operation, None)?;
        if self.disposition != LegacyOperationDisposition::Normal
            && self.captured_failure_code.is_none()
        {
            return Ok(None);
        }
        match self.source_command.kind {
            LegacyItemCommandKind::Create => {
                Self::overlay_fingerprint(&self.create_overlay(operation)?).map(Some)
            }
            LegacyItemCommandKind::Update
            | LegacyItemCommandKind::Move
            | LegacyItemCommandKind::ToggleFavorite
            | LegacyItemCommandKind::Delete
            | LegacyItemCommandKind::Restore
            | LegacyItemCommandKind::PermanentDelete => self
                .overlay_sha256
                .ok_or_else(|| invalid("Legacy Item overlay witness is missing"))
                .map(Some),
            _ => Err(invalid("Legacy Operation kind is not supported")),
        }
    }

    pub(crate) fn create_overlay(
        &self,
        operation: &OperationRecord,
    ) -> Result<ReplicaItemRecord, RuntimeError> {
        let command = &self.source_command;
        let body: CreateBody = serde_json::from_slice(&operation.request.body)
            .map_err(|_| invalid("Legacy Create request body is malformed"))?;
        let payload = command
            .encrypted_payload
            .as_ref()
            .ok_or_else(|| invalid("Legacy Create payload is missing"))?;
        let timestamp = source_timestamp(command.timestamp)?;
        Ok(ReplicaItemRecord {
            account_id: command.account_id.clone(),
            item_id: command.entity_id.clone(),
            vault_id: command.vault_id.clone(),
            operation_id: command
                .operation_id
                .as_deref()
                .unwrap_or(&command.id)
                .to_owned(),
            category: AuthorityItemCategory::from(body.category),
            encrypted_data: body.encrypted_data,
            encryption_iv: body.encryption_iv,
            encryption_algorithm: body.encryption_algorithm,
            encryption_version: payload.encryption_version,
            encrypted_by_user_id: payload.encrypted_by_user_id.clone(),
            favorite: false,
            version: 1,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            deleted_at: None,
            attachments: Vec::new(),
            permanently_deleted: false,
        })
    }

    pub(crate) fn overlay_fingerprint(
        overlay: &ReplicaItemRecord,
    ) -> Result<Sha256Fingerprint, RuntimeError> {
        use sha2::{Digest, Sha256};
        let mut digest = Sha256::new();
        digest.update(b"bittery.legacy-item-overlay.v1\0");
        digest.update(
            serde_json::to_vec(overlay)
                .map_err(|_| invalid("Legacy Update overlay cannot be encoded"))?,
        );
        Ok(Sha256Fingerprint(digest.finalize().into()))
    }

    fn validate_metadata(
        &self,
        operation: &OperationRecord,
        overlay: Option<&ReplicaItemRecord>,
    ) -> Result<(), RuntimeError> {
        let command = &self.source_command;
        let digest = if self.disposition == LegacyOperationDisposition::Normal {
            Some(
                self.overlay_sha256
                    .ok_or_else(|| invalid("Legacy Item overlay witness is missing"))?,
            )
        } else {
            if self.overlay_sha256.is_some() || overlay.is_some() {
                return Err(invalid(
                    "Held metadata command cannot own an overlay or witness",
                ));
            }
            None
        };
        if command.base_version <= 0
            || command.category.is_some()
            || command.encrypted_payload.is_some()
            || command.target_vault_id.is_some()
            || command.target_account_id.is_some()
            || command.target_item_id.is_some()
            || (self.disposition == LegacyOperationDisposition::Normal
                && command.conflict_copy_id.is_some())
            || (command.kind != LegacyItemCommandKind::ToggleFavorite && command.favorite.is_some())
        {
            return Err(invalid("Legacy metadata command fields are inconsistent"));
        }
        let kind = match command.kind {
            LegacyItemCommandKind::ToggleFavorite => OperationKind::SetItemFavorite,
            LegacyItemCommandKind::Delete => OperationKind::TrashItem,
            LegacyItemCommandKind::Restore => OperationKind::RestoreItem,
            LegacyItemCommandKind::PermanentDelete => OperationKind::PermanentlyDeleteItem,
            _ => return Err(invalid("Legacy metadata command kind is unsupported")),
        };
        let body = if kind == OperationKind::SetItemFavorite {
            serde_json::to_vec(&FavoriteBody {
                favorite: command.favorite.unwrap_or(false),
            })
            .map_err(|_| invalid("Legacy Favorite request cannot be encoded"))?
        } else {
            Vec::new()
        };
        let expected_id = command.attempt_id.as_deref().unwrap_or(&command.id);
        if operation.kind != kind
            || operation.operation_id != expected_id
            || operation.target
                != (ResourceRef::Item {
                    item_id: command.entity_id.clone(),
                    vault_id: command.vault_id.clone(),
                })
            || operation.request.body != body
            || !operation.request.headers.iter().any(|header| {
                header.name == "If-Match" && header.value == format!("\"{}\"", command.base_version)
            })
            || operation.accepted_item_category.is_none()
            || operation.attachment_move_recovery.is_some()
            || operation.create_vault.is_some()
            || operation.update_vault.is_some()
        {
            return Err(invalid(
                "Legacy metadata request changed from its admitted source command",
            ));
        }
        super::verify_item_request(operation)?;
        if let Some(overlay) = overlay {
            let timestamp = source_timestamp(command.timestamp)?;
            let projection_matches = match command.kind {
                LegacyItemCommandKind::ToggleFavorite => {
                    overlay.favorite == command.favorite.unwrap_or(false)
                        && overlay.deleted_at.is_none()
                }
                LegacyItemCommandKind::Delete => {
                    overlay.deleted_at.as_deref() == Some(timestamp.as_str())
                }
                LegacyItemCommandKind::Restore => overlay.deleted_at.is_none(),
                LegacyItemCommandKind::PermanentDelete => true,
                _ => false,
            };
            if Some(Self::overlay_fingerprint(overlay)?) != digest
                || !projection_matches
                || overlay.account_id != command.account_id
                || overlay.item_id != command.entity_id
                || overlay.vault_id != command.vault_id
                || overlay.operation_id != expected_id
                || Some(&overlay.category) != operation.accepted_item_category.as_ref()
                || overlay.version != command.base_version
                || overlay.permanently_deleted
                || (kind != OperationKind::PermanentlyDeleteItem && overlay.updated_at != timestamp)
            {
                return Err(invalid(
                    "Legacy metadata overlay changed from its admitted source command",
                ));
            }
        }
        Ok(())
    }

    fn validate_encrypted_mutation(
        &self,
        operation: &OperationRecord,
        overlay: Option<&ReplicaItemRecord>,
    ) -> Result<(), RuntimeError> {
        let command = &self.source_command;
        let is_move = command.kind == LegacyItemCommandKind::Move;
        let target_vault = if is_move {
            command
                .target_vault_id
                .as_deref()
                .ok_or_else(|| invalid("Legacy Move target is missing"))?
        } else {
            command.vault_id.as_str()
        };
        let (kind, method, suffix, route, content_type) = if is_move {
            (
                OperationKind::MoveItem,
                HttpMethod::Post,
                "/moves",
                "POST /api/v1/items/{itemId}/moves",
                "application/json",
            )
        } else {
            (
                OperationKind::UpdateItem,
                HttpMethod::Patch,
                "",
                "PATCH /api/v1/items/{itemId}",
                "application/merge-patch+json",
            )
        };
        let payload = command
            .encrypted_payload
            .as_ref()
            .ok_or_else(|| invalid("Legacy encrypted Item payload is missing"))?;
        let digest = if self.disposition == LegacyOperationDisposition::Normal {
            Some(
                self.overlay_sha256
                    .ok_or_else(|| invalid("Legacy encrypted Item overlay witness is missing"))?,
            )
        } else {
            if self.overlay_sha256.is_some() || overlay.is_some() {
                return Err(invalid(
                    "Held encrypted Item command cannot own an overlay or witness",
                ));
            }
            None
        };
        let version = command
            .base_version
            .checked_add(1)
            .filter(|_| command.base_version > 0)
            .ok_or_else(|| invalid("Legacy encrypted Item base version is invalid"))?;
        if command.category.is_some()
            || command.favorite.is_some()
            || (!is_move && command.target_vault_id.is_some())
            || command.target_account_id.is_some()
            || command.target_item_id.is_some()
            || (self.disposition == LegacyOperationDisposition::Normal
                && command.conflict_copy_id.is_some())
            || payload.encryption_version != version
        {
            return Err(invalid(
                "Legacy encrypted Item admission fields are inconsistent",
            ));
        }
        let (body, expected_body) = if is_move {
            let body: MoveBody = serde_json::from_slice(&operation.request.body)
                .map_err(|_| invalid("Legacy Move request body is malformed"))?;
            if body.mode != "prepared"
                || body.source_vault_id != command.vault_id
                || body.target_vault_id != target_vault
            {
                return Err(invalid("Legacy Move request Vault scope changed"));
            }
            let encoded = serde_json::to_vec(&body)
                .map_err(|_| invalid("Legacy Move request cannot be encoded"))?;
            (
                UpdateBody {
                    encrypted_data: body.encrypted_data,
                    encryption_iv: body.encryption_iv,
                    encryption_algorithm: body.encryption_algorithm,
                },
                encoded,
            )
        } else {
            let body: UpdateBody = serde_json::from_slice(&operation.request.body)
                .map_err(|_| invalid("Legacy Update request body is malformed"))?;
            let encoded = serde_json::to_vec(&body)
                .map_err(|_| invalid("Legacy Update request cannot be encoded"))?;
            (body, encoded)
        };
        let expected_id = command.attempt_id.as_deref().unwrap_or(&command.id);
        if operation.operation_id != expected_id
            || operation.kind != kind
            || operation.target
                != (ResourceRef::Item {
                    item_id: command.entity_id.clone(),
                    vault_id: target_vault.to_owned(),
                })
            || operation.request.method != method
            || operation.request.path
                != format!(
                    "/api/v1/items/{}{suffix}",
                    encode_component(&command.entity_id)
                )
            || operation.request.headers
                != [
                    HttpHeader {
                        name: "Content-Type".into(),
                        value: content_type.into(),
                    },
                    HttpHeader {
                        name: "If-Match".into(),
                        value: format!("\"{}\"", command.base_version),
                    },
                ]
            || operation.request.body != expected_body
            || operation.request_fingerprint
                != item_operation_fingerprint(
                    kind,
                    route,
                    &command.entity_id,
                    &operation.request.body,
                    command.base_version,
                )
            || operation.accepted_item_category.is_none()
            || operation.attachment_move_recovery.is_some()
            || operation.create_vault.is_some()
            || operation.update_vault.is_some()
            || body.encrypted_data.is_empty()
            || body.encryption_iv.is_empty()
            || body.encryption_algorithm.is_empty()
        {
            return Err(invalid(
                "Legacy encrypted Item request changed from its admitted source command",
            ));
        }
        if let Some(overlay) = overlay {
            if Some(Self::overlay_fingerprint(overlay)?) != digest
                || overlay.account_id != command.account_id
                || overlay.item_id != command.entity_id
                || overlay.vault_id != target_vault
                || overlay.operation_id != expected_id
                || Some(&overlay.category) != operation.accepted_item_category.as_ref()
                || overlay.encrypted_data != body.encrypted_data
                || overlay.encryption_iv != body.encryption_iv
                || overlay.encryption_algorithm != body.encryption_algorithm
                || overlay.encryption_version != version
                || overlay.version != version
                || overlay.encrypted_by_user_id != payload.encrypted_by_user_id
                || overlay.updated_at != source_timestamp(command.timestamp)?
                || overlay.permanently_deleted
            {
                return Err(invalid(
                    "Legacy encrypted Item overlay changed from its admitted source command",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveBody {
    mode: String,
    source_vault_id: String,
    target_vault_id: String,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
}
crate::wire::map_only_serde!(MoveBody);

#[derive(Serialize)]
struct FavoriteBody {
    favorite: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateBody {
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
}
crate::wire::map_only_serde!(UpdateBody);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateBody {
    category: LegacyItemCategory,
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
}

crate::wire::map_only_serde!(CreateBody);

crate::wire::map_only_serde!(
    LegacyOperationAdmission,
    ImmutableRequestPayload,
    LegacyOperationReceiptLineage,
);

impl<Payload: Serialize> Serialize for LegacyItemCommandV1<Payload> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        LegacyItemCommandV1::serialize(self, serializer)
    }
}

impl<'de, Payload: Deserialize<'de>> Deserialize<'de> for LegacyItemCommandV1<Payload> {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct ObjectVisitor<Payload>(std::marker::PhantomData<Payload>);
        impl<'de, Payload: Deserialize<'de>> serde::de::Visitor<'de> for ObjectVisitor<Payload> {
            type Value = LegacyItemCommandV1<Payload>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a legacy command object")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                map: A,
            ) -> Result<Self::Value, A::Error> {
                LegacyItemCommandV1::deserialize(serde::de::value::MapAccessDeserializer::new(map))
            }
        }
        decoder.deserialize_map(ObjectVisitor(std::marker::PhantomData))
    }
}

pub(super) fn present<'de, D, T>(decoder: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(decoder).map(Some)
}

fn present_decimal_u64<'de, D>(decoder: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    decimal_u64::deserialize(decoder).map(Some)
}

pub(crate) fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").expect("writing to String cannot fail");
        }
    }
    encoded
}

pub(crate) fn source_timestamp(timestamp_ms: u64) -> Result<String, RuntimeError> {
    let nanoseconds = i128::from(timestamp_ms) * 1_000_000;
    time::OffsetDateTime::from_unix_timestamp_nanos(nanoseconds)
        .ok()
        .and_then(|instant| {
            instant
                .format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .ok_or_else(|| invalid("Legacy Item command timestamp is outside the supported range"))
}

fn invalid(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        protocol::Incarnation,
        replica::{
            persistence_contract::{reconstruct_snapshot, snapshot_rows, ReplicaHead},
            AuthorityItemRecord, GuardedCommitPlan, ImmutableHttpRequest, InMemoryReplica,
            ObservedOutcome, OperationOutcomeResult, OperationSchedulingState, PlanMutation,
            ReplicaSnapshot,
        },
        test_fixtures::personal_vault,
    };

    #[test]
    fn admission_evidence_is_map_only_and_preserves_optional_source_identity() {
        let value = serde_json::json!({
            "version": 1, "admissionId": "admission", "sourceQueueIndex": "0",
            "sourceCommand": {
                "accountId": "account", "id": "source-command", "operationId": "semantic",
                "attemptId": "attempt", "type": "create", "entityId": "item",
                "vaultId": "vault", "category": "login",
                "encryptedPayload": {"encryptionVersion": 1, "encryptedByUserId": "user"},
                "baseVersion": 0, "timestamp": "1", "retryCount": "0"
            },
            "disposition": "normal"
        });
        let decoded: LegacyOperationAdmission = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(decoded.version, LEGACY_OPERATION_ADMISSION_VERSION);
        assert_eq!(serde_json::to_value(&decoded).unwrap(), value);
        assert!(serde_json::from_value::<LegacyOperationAdmission>(serde_json::json!([])).is_err());
        let mut invalid = value;
        invalid["sourceCommand"]["encryptedPayload"] = serde_json::json!([]);
        assert!(serde_json::from_value::<LegacyOperationAdmission>(invalid).is_err());
    }

    fn accepted_create() -> (OperationRecord, ReplicaItemRecord) {
        let body = br#"{"category":"login","encryptedData":"ciphertext","encryptionIv":"iv","encryptionAlgorithm":"AES-GCM-AAD-V1"}"#.to_vec();
        let command = LegacyItemCommandV1 {
            account_id: "account".into(),
            account_email: Some("person@example.test".into()),
            id: "source-command".into(),
            operation_id: Some("semantic-operation".into()),
            attempt_id: Some("attempt-operation".into()),
            kind: LegacyItemCommandKind::Create,
            entity_id: "item:queued".into(),
            vault_id: "vault:source".into(),
            target_vault_id: None,
            target_account_id: None,
            target_item_id: None,
            category: Some(LegacyItemCategory::Login),
            encrypted_payload: Some(ImmutableRequestPayload {
                encryption_version: 1,
                encrypted_by_user_id: "user".into(),
            }),
            favorite: None,
            base_version: 0,
            timestamp: 0,
            retry_count: 0,
            status: Some(LegacyItemCommandStatus::Pending),
            last_error: None,
            next_attempt_at: None,
            conflict_copy_id: None,
            projection_claim_id: None,
            projection_claim_expires_at: None,
        };
        let operation = OperationRecord {
            operation_id: "semantic-operation".into(),
            kind: OperationKind::CreateItem,
            target: ResourceRef::Item {
                item_id: "item:queued".into(),
                vault_id: "vault:source".into(),
            },
            request: ImmutableHttpRequest {
                method: HttpMethod::Put,
                path: "/api/v1/vaults/vault%3Asource/items/item%3Aqueued".into(),
                headers: vec![HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }],
                body: body.clone(),
            },
            request_fingerprint: create_item_fingerprint("vault:source", "item:queued", &body),
            accepted_item_category: Some(AuthorityItemCategory::Login),
            attachment_move_recovery: None,
            create_vault: None,
            update_vault: None,
            scheduling: OperationSchedulingState::default(),
            legacy_admission: Some(Box::new(LegacyOperationAdmission {
                version: LEGACY_OPERATION_ADMISSION_VERSION,
                admission_id: "admission".into(),
                source_queue_index: 0,
                source_command: command,
                disposition: LegacyOperationDisposition::Normal,
                overlay_sha256: None,
                captured_failure_code: None,
            })),
        };
        let overlay = ReplicaItemRecord {
            account_id: "account".into(),
            item_id: "item:queued".into(),
            vault_id: "vault:source".into(),
            operation_id: "semantic-operation".into(),
            category: AuthorityItemCategory::Login,
            encrypted_data: "ciphertext".into(),
            encryption_iv: "iv".into(),
            encryption_algorithm: "AES-GCM-AAD-V1".into(),
            encryption_version: 1,
            encrypted_by_user_id: "user".into(),
            favorite: false,
            version: 1,
            created_at: "1970-01-01T00:00:00Z".into(),
            updated_at: "1970-01-01T00:00:00Z".into(),
            deleted_at: None,
            attachments: Vec::new(),
            permanently_deleted: false,
        };
        (operation, overlay)
    }

    fn accepted_update() -> (OperationRecord, ReplicaItemRecord) {
        let (mut operation, mut overlay) = accepted_create();
        operation.operation_id = "attempt-operation".into();
        operation.kind = OperationKind::UpdateItem;
        operation.request.method = HttpMethod::Patch;
        operation.request.path = "/api/v1/items/item%3Aqueued".into();
        operation.request.body = br#"{"encryptedData":"ciphertext","encryptionIv":"iv","encryptionAlgorithm":"AES-GCM-AAD-V1"}"#.to_vec();
        operation.request.headers = vec![
            HttpHeader {
                name: "Content-Type".into(),
                value: "application/merge-patch+json".into(),
            },
            HttpHeader {
                name: "If-Match".into(),
                value: "\"6\"".into(),
            },
        ];
        operation.request_fingerprint = item_operation_fingerprint(
            OperationKind::UpdateItem,
            "PATCH /api/v1/items/{itemId}",
            "item:queued",
            &operation.request.body,
            6,
        );
        overlay.operation_id = operation.operation_id.clone();
        overlay.version = 7;
        overlay.encryption_version = 7;
        overlay.favorite = true;
        overlay.attachments = vec![serde_json::from_value(serde_json::json!({
            "id":"attachment", "itemId":"item:queued", "vaultId":"vault:source",
            "storageKey":"opaque", "encryptedName":"name", "encryptionIv":"iv",
            "encryptionAlgorithm":"AES-GCM-AAD-V1", "encryptedAttachmentKey":"wrapped-key",
            "attachmentKeyIv":"key-iv", "attachmentKeyAlgorithm":"AES-GCM-AAD-V1",
            "encryptedContentType":"type", "encryptedContentTypeIv":"type-iv", "envelopeVersion":1,
            "fileSize":10, "uploadedBy":"user", "createdAt":"1970-01-01T00:00:00Z"
 })).unwrap()];
        let admission = operation.legacy_admission.as_mut().unwrap();
        admission.source_command.kind = LegacyItemCommandKind::Update;
        admission.source_command.category = None;
        admission.source_command.base_version = 6;
        admission
            .source_command
            .encrypted_payload
            .as_mut()
            .unwrap()
            .encryption_version = 7;
        admission.overlay_sha256 =
            Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap());
        (operation, overlay)
    }

    fn accepted_metadata(kind: LegacyItemCommandKind) -> (OperationRecord, ReplicaItemRecord) {
        let (mut operation, mut overlay) = accepted_update();
        let (operation_kind, method, suffix, route) = match kind {
            LegacyItemCommandKind::ToggleFavorite => (
                OperationKind::SetItemFavorite,
                HttpMethod::Patch,
                "/favorite",
                "PATCH /api/v1/items/{itemId}/favorite",
            ),
            LegacyItemCommandKind::Delete => (
                OperationKind::TrashItem,
                HttpMethod::Delete,
                "",
                "DELETE /api/v1/items/{itemId}",
            ),
            LegacyItemCommandKind::Restore => (
                OperationKind::RestoreItem,
                HttpMethod::Post,
                "/restore",
                "POST /api/v1/items/{itemId}/restore",
            ),
            LegacyItemCommandKind::PermanentDelete => (
                OperationKind::PermanentlyDeleteItem,
                HttpMethod::Delete,
                "/permanent",
                "DELETE /api/v1/items/{itemId}/permanent",
            ),
            _ => unreachable!(),
        };
        operation.kind = operation_kind;
        operation.request.method = method;
        operation.request.path = format!("/api/v1/items/item%3Aqueued{suffix}");
        operation.request.body = if kind == LegacyItemCommandKind::ToggleFavorite {
            br#"{"favorite":false}"#.to_vec()
        } else {
            Vec::new()
        };
        if kind != LegacyItemCommandKind::ToggleFavorite {
            operation.request.headers.remove(0);
        }
        operation.request_fingerprint = item_operation_fingerprint(
            operation_kind,
            route,
            "item:queued",
            &operation.request.body,
            6,
        );
        overlay.version = 6;
        overlay.encryption_version = 3;
        overlay.encrypted_by_user_id = "earlier-writer".into();
        match kind {
            LegacyItemCommandKind::ToggleFavorite => overlay.favorite = false,
            LegacyItemCommandKind::Delete => overlay.deleted_at = Some(overlay.updated_at.clone()),
            LegacyItemCommandKind::Restore => overlay.deleted_at = None,
            LegacyItemCommandKind::PermanentDelete => {
                overlay.updated_at = "2026-09-20T00:00:00Z".into()
            }
            _ => unreachable!(),
        }
        let admission = operation.legacy_admission.as_mut().unwrap();
        admission.source_command.kind = kind;
        admission.source_command.encrypted_payload = None;
        admission.overlay_sha256 =
            Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap());
        (operation, overlay)
    }

    fn accepted_move(attachments: bool) -> (OperationRecord, ReplicaItemRecord) {
        let (mut operation, mut overlay) = accepted_update();
        overlay.vault_id = "vault:target".into();
        if !attachments {
            overlay.attachments.clear();
        }
        operation.kind = OperationKind::MoveItem;
        operation.target = ResourceRef::Item {
            item_id: overlay.item_id.clone(),
            vault_id: overlay.vault_id.clone(),
        };
        operation.request.method = HttpMethod::Post;
        operation.request.path = "/api/v1/items/item%3Aqueued/moves".into();
        operation.request.headers[0].value = "application/json".into();
        operation.request.body = serde_json::to_vec(&MoveBody {
            mode: "prepared".into(),
            source_vault_id: "vault:source".into(),
            target_vault_id: "vault:target".into(),
            encrypted_data: overlay.encrypted_data.clone(),
            encryption_iv: overlay.encryption_iv.clone(),
            encryption_algorithm: overlay.encryption_algorithm.clone(),
        })
        .unwrap();
        operation.request_fingerprint = item_operation_fingerprint(
            OperationKind::MoveItem,
            "POST /api/v1/items/{itemId}/moves",
            "item:queued",
            &operation.request.body,
            6,
        );
        let evidence = operation.legacy_admission.as_mut().unwrap();
        evidence.source_command.kind = LegacyItemCommandKind::Move;
        evidence.source_command.target_vault_id = Some("vault:target".into());
        evidence.overlay_sha256 =
            Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap());
        (operation, overlay)
    }

    #[test]
    fn admitted_move_retires_either_vault_and_preserves_original_attachment_scope() {
        for retired_vault in ["vault:source", "vault:target"] {
            let (operation, overlay) = accepted_move(true);
            assert_eq!(
                operation.accepted_vault_ids().unwrap(),
                vec!["vault:source", "vault:target"]
            );
            assert_eq!(overlay.attachments[0].vault_id, "vault:source");
            operation
                .legacy_admission
                .as_ref()
                .unwrap()
                .validate(&overlay.account_id, &operation, Some(&overlay))
                .unwrap();
            super::super::verify_item_request(&operation).unwrap();
            let state = InMemoryReplica::default();
            state
                .install("account".into(), "user".into(), "incarnation".into())
                .unwrap();
            state
                .seed_ready_authority(
                    &"account".into(),
                    vec![
                        personal_vault("vault:source", "user"),
                        personal_vault("vault:target", "user"),
                    ],
                    Vec::new(),
                )
                .unwrap();
            state
                .execute(guard(
                    &state.snapshot(&"account".into()).unwrap(),
                    vec![
                        PlanMutation::AcceptOperation(operation.clone()),
                        PlanMutation::PutOptimisticItem(overlay.clone()),
                    ],
                ))
                .unwrap();
            let admitted = reload(state.snapshot(&"account".into()).unwrap());
            assert_eq!(admitted.items, vec![overlay]);
            state
                .execute(guard(
                    &state.snapshot(&"account".into()).unwrap(),
                    vec![PlanMutation::RetireVaults {
                        vault_ids: vec![retired_vault.into()],
                    }],
                ))
                .unwrap();
            let retired = reload(state.snapshot(&"account".into()).unwrap());
            assert!(retired.items.is_empty());
            assert_eq!(retired.operations, vec![operation]);
        }
    }

    #[test]
    fn admitted_move_reconciles_typed_attachment_conflict_without_rewriting_request() {
        let (operation, overlay) = accepted_move(true);
        let mut base = AuthorityItemRecord {
            id: overlay.item_id.clone(),
            vault_id: "vault:source".into(),
            category: overlay.category.clone(),
            favorite: overlay.favorite,
            encrypted_data: "base-ciphertext".into(),
            encryption_iv: "base-iv".into(),
            encryption_algorithm: overlay.encryption_algorithm.clone(),
            version: 6,
            encryption_version: 3,
            encrypted_by_user_id: "earlier-writer".into(),
            last_modified_by: "earlier-writer".into(),
            created_at: overlay.created_at.clone(),
            updated_at: overlay.created_at.clone(),
            deleted_at: None,
            attachments: overlay.attachments.clone(),
        };
        let state = InMemoryReplica::default();
        state
            .install("account".into(), "user".into(), "incarnation".into())
            .unwrap();
        state
            .seed_ready_authority(
                &"account".into(),
                vec![
                    personal_vault("vault:source", "user"),
                    personal_vault("vault:target", "user"),
                ],
                vec![base.clone()],
            )
            .unwrap();
        state
            .execute(guard(
                &state.snapshot(&"account".into()).unwrap(),
                vec![
                    PlanMutation::AcceptOperation(operation.clone()),
                    PlanMutation::PutOptimisticItem(overlay),
                ],
            ))
            .unwrap();
        base.version = 8; // The reconciliation owner uses current authority, independently of the old admitted base.
        state
            .execute(guard(
                &state.snapshot(&"account".into()).unwrap(),
                vec![PlanMutation::ReconcileItemMutation {
                    outcome: ObservedOutcome {
                        operation_id: operation.operation_id.clone(),
                        request_fingerprint: operation.request_fingerprint,
                        result: OperationOutcomeResult::Rejected {
                            code: crate::replica::OperationRejectionCode::AttachmentStateConflict,
                        },
                    },
                    item: Some(Box::new(base.clone())),
                    cursor: None,
                }],
            ))
            .unwrap();
        let completed = reload(state.snapshot(&"account".into()).unwrap());
        assert!(completed.operations.is_empty());
        assert!(completed.items.is_empty());
        assert_eq!(completed.bootstrap.snapshot().visible_items, vec![base]);
        assert_eq!(
            completed.receipts[0].request_fingerprint,
            operation.request_fingerprint
        );
        assert_eq!(
            completed.receipts[0]
                .legacy_lineage
                .as_ref()
                .unwrap()
                .source_attempt_id
                .as_deref(),
            Some("attempt-operation")
        );
    }

    fn accepted_cases() -> Vec<(OperationRecord, ReplicaItemRecord)> {
        let mut cases = vec![accepted_create(), accepted_update()];
        cases.extend(
            [
                LegacyItemCommandKind::ToggleFavorite,
                LegacyItemCommandKind::Delete,
                LegacyItemCommandKind::Restore,
                LegacyItemCommandKind::PermanentDelete,
            ]
            .map(accepted_metadata),
        );
        cases.push(accepted_move(false));
        cases
    }

    #[test]
    fn metadata_witnesses_survive_retirement_and_reject_any_changed_overlay() {
        for (operation, overlay) in accepted_cases().into_iter().skip(2).take(4) {
            let evidence = operation.legacy_admission.as_ref().unwrap();
            evidence
                .validate(&overlay.account_id, &operation, Some(&overlay))
                .unwrap();
            assert_eq!(
                evidence
                    .expected_overlay_fingerprint(&overlay.account_id, &operation)
                    .unwrap(),
                Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap())
            );
            for field in [
                "encryptedData",
                "encryptionVersion",
                "encryptedByUserId",
                "version",
                "favorite",
                "deletedAt",
                "updatedAt",
                "permanentlyDeleted",
                "attachments",
            ] {
                let mut changed = serde_json::to_value(&overlay).unwrap();
                changed[field] = match field {
                    "encryptionVersion" | "version" => serde_json::json!(99),
                    "favorite" => serde_json::json!(!overlay.favorite),
                    "permanentlyDeleted" => serde_json::json!(true),
                    "attachments" => serde_json::json!([]),
                    _ => serde_json::json!("changed"),
                };
                let changed: ReplicaItemRecord = serde_json::from_value(changed).unwrap();
                assert!(
                    evidence
                        .validate(&overlay.account_id, &operation, Some(&changed))
                        .is_err(),
                    "{field}"
                );
            }
            let state = InMemoryReplica::default();
            state
                .install("account".into(), "user".into(), "incarnation".into())
                .unwrap();
            state
                .seed_ready_personal_vault(
                    &"account".into(),
                    personal_vault("vault:source", "user"),
                )
                .unwrap();
            state
                .execute(guard(
                    &state.snapshot(&"account".into()).unwrap(),
                    vec![
                        PlanMutation::AcceptOperation(operation),
                        PlanMutation::PutOptimisticItem(overlay),
                    ],
                ))
                .unwrap();
            state
                .execute(guard(
                    &state.snapshot(&"account".into()).unwrap(),
                    vec![PlanMutation::RetireVaults {
                        vault_ids: vec!["vault:source".into()],
                    }],
                ))
                .unwrap();
            let retired = reload(state.snapshot(&"account".into()).unwrap());
            assert!(retired.items.is_empty());
            assert_eq!(retired.operations.len(), 1);
            let mut changed = retired.operations[0].clone();
            changed.request.body.push(b' ');
            assert!(changed
                .legacy_admission
                .as_ref()
                .unwrap()
                .validate(&retired.account_id, &changed, None)
                .is_err());
        }
    }

    #[test]
    fn live_restore_and_permanent_delete_reconcile_typed_not_trashed_rejections() {
        for kind in [
            LegacyItemCommandKind::Restore,
            LegacyItemCommandKind::PermanentDelete,
        ] {
            let (operation, overlay) = accepted_metadata(kind);
            let state = InMemoryReplica::default();
            state
                .install("account".into(), "user".into(), "incarnation".into())
                .unwrap();
            state
                .seed_ready_personal_vault(
                    &"account".into(),
                    personal_vault("vault:source", "user"),
                )
                .unwrap();
            state
                .execute(guard(
                    &state.snapshot(&"account".into()).unwrap(),
                    vec![
                        PlanMutation::AcceptOperation(operation.clone()),
                        PlanMutation::PutOptimisticItem(overlay.clone()),
                    ],
                ))
                .unwrap();
            let authority = AuthorityItemRecord {
                id: overlay.item_id.clone(),
                vault_id: overlay.vault_id.clone(),
                category: overlay.category,
                favorite: overlay.favorite,
                encrypted_data: overlay.encrypted_data,
                encryption_iv: overlay.encryption_iv,
                encryption_algorithm: overlay.encryption_algorithm,
                version: 6,
                encryption_version: 3,
                encrypted_by_user_id: overlay.encrypted_by_user_id,
                last_modified_by: "earlier-writer".into(),
                created_at: overlay.created_at,
                updated_at: overlay.updated_at,
                deleted_at: None,
                attachments: overlay.attachments,
            };
            state
                .execute(guard(
                    &state.snapshot(&"account".into()).unwrap(),
                    vec![PlanMutation::ReconcileItemMutation {
                        outcome: ObservedOutcome {
                            operation_id: operation.operation_id.clone(),
                            request_fingerprint: operation.request_fingerprint,
                            result: OperationOutcomeResult::Rejected {
                                code: crate::replica::OperationRejectionCode::ItemNotTrashed,
                            },
                        },
                        item: Some(Box::new(authority.clone())),
                        cursor: None,
                    }],
                ))
                .unwrap();
            let completed = reload(state.snapshot(&"account".into()).unwrap());
            assert!(completed.operations.is_empty());
            assert!(completed.items.is_empty());
            assert_eq!(
                completed.bootstrap.snapshot().visible_items,
                vec![authority]
            );
            assert_eq!(completed.receipts[0].operation_id, "attempt-operation");
            assert_eq!(
                completed.receipts[0]
                    .legacy_lineage
                    .as_ref()
                    .unwrap()
                    .source_operation_id
                    .as_deref(),
                Some("semantic-operation")
            );
        }
    }

    #[test]
    fn update_witness_binds_all_inherited_fields() {
        let (operation, overlay) = accepted_update();
        let admission = operation.legacy_admission.as_ref().unwrap();
        admission
            .validate(&overlay.account_id, &operation, Some(&overlay))
            .unwrap();
        super::super::verify_item_request(&operation).unwrap();
        let mut variants = Vec::new();
        let mut changed = overlay.clone();
        changed.favorite = false;
        variants.push(changed);
        let mut changed = overlay.clone();
        changed.created_at = "different".into();
        variants.push(changed);
        let mut changed = overlay.clone();
        changed.deleted_at = Some("deleted".into());
        variants.push(changed);
        let mut changed = overlay.clone();
        changed.category = AuthorityItemCategory::Identity;
        variants.push(changed);
        let mut changed = overlay.clone();
        changed.account_id = "different".into();
        variants.push(changed);
        let mut changed = overlay.clone();
        changed.attachments[0].encrypted_name = "changed-name".into();
        variants.push(changed);
        let mut changed = overlay.clone();
        changed.attachments.clear();
        variants.push(changed);
        for changed in variants {
            assert!(admission
                .validate(&overlay.account_id, &operation, Some(&changed))
                .is_err());
        }
        let mut encoded = serde_json::to_value(admission).unwrap();
        encoded["overlaySha256"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<LegacyOperationAdmission>(encoded).is_err());
        let mut missing = (**admission).clone();
        missing.overlay_sha256 = None;
        assert!(missing
            .validate(&overlay.account_id, &operation, Some(&overlay))
            .is_err());
    }

    #[test]
    fn admitted_create_and_update_retire_overlays_without_losing_request_validation() {
        for (operation, overlay) in [accepted_create(), accepted_update()] {
            let state = InMemoryReplica::default();
            state
                .install(
                    "account".into(),
                    "user".into(),
                    Incarnation::from("incarnation"),
                )
                .unwrap();
            state
                .seed_ready_personal_vault(
                    &"account".into(),
                    personal_vault("vault:source", "user"),
                )
                .unwrap();
            state
                .execute(guard(
                    &state.snapshot(&"account".into()).unwrap(),
                    vec![
                        PlanMutation::AcceptOperation(operation.clone()),
                        PlanMutation::PutOptimisticItem(overlay),
                    ],
                ))
                .unwrap();
            state
                .execute(guard(
                    &state.snapshot(&"account".into()).unwrap(),
                    vec![PlanMutation::RetireVaults {
                        vault_ids: vec!["vault:source".into()],
                    }],
                ))
                .unwrap();
            let retired = reload(state.snapshot(&"account".into()).unwrap());
            assert!(retired.items.is_empty());
            assert_eq!(retired.operations.len(), 1);
            for field in [
                "path",
                "header",
                "encryptedData",
                "encryptionIv",
                "encryptionAlgorithm",
            ] {
                let mut changed = retired.operations[0].clone();
                match field {
                    "path" => changed.request.path.push_str("changed"),
                    "header" => changed.request.headers[0].value.push_str("changed"),
                    _ => {
                        let mut body: serde_json::Value =
                            serde_json::from_slice(&changed.request.body).unwrap();
                        body[field] = serde_json::json!("");
                        // Preserve canonical legacy property ordering and fingerprint to test the semantic fence.
                        changed.request.body = if changed.kind == OperationKind::CreateItem {
                            serde_json::to_vec(&serde_json::from_value::<CreateBody>(body).unwrap())
                                .unwrap()
                        } else {
                            serde_json::to_vec(&serde_json::from_value::<UpdateBody>(body).unwrap())
                                .unwrap()
                        };
                        changed.request_fingerprint = if changed.kind == OperationKind::CreateItem {
                            create_item_fingerprint(
                                "vault:source",
                                "item:queued",
                                &changed.request.body,
                            )
                        } else {
                            item_operation_fingerprint(
                                OperationKind::UpdateItem,
                                "PATCH /api/v1/items/{itemId}",
                                "item:queued",
                                &changed.request.body,
                                6,
                            )
                        };
                    }
                }
                assert!(
                    changed
                        .legacy_admission
                        .as_ref()
                        .unwrap()
                        .validate(&retired.account_id, &changed, None)
                        .is_err(),
                    "{field}"
                );
            }
        }
    }

    fn guard(snapshot: &ReplicaSnapshot, mutations: Vec<PlanMutation>) -> GuardedCommitPlan {
        GuardedCommitPlan::new(
            snapshot.account_id.clone(),
            snapshot.incarnation.clone(),
            snapshot.revision,
            snapshot.lock_epoch,
            mutations,
        )
    }

    fn reload(snapshot: ReplicaSnapshot) -> ReplicaSnapshot {
        let head = ReplicaHead {
            account_id: snapshot.account_id.clone(),
            user_id: snapshot.user_id.clone(),
            incarnation: snapshot.incarnation.clone(),
            replica_revision: snapshot.revision,
            lock_epoch: snapshot.lock_epoch,
            failure: snapshot.failure,
        };
        let rows = snapshot_rows(snapshot).unwrap();
        reconstruct_snapshot(&"account".into(), Some(head), rows)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn captured_failed_create_binds_only_the_canonical_overlay() {
        let (operation, overlay) = accepted_create();
        let mut value = serde_json::to_value(operation).unwrap();
        value["legacyAdmission"]["sourceCommand"]["status"] = "failed".into();
        value["legacyAdmission"]["disposition"] = "legacyFailed".into();
        value["legacyAdmission"]["capturedFailureCode"] = "item_id_conflict".into();
        let operation: OperationRecord = serde_json::from_value(value.clone()).unwrap();
        let evidence = operation.legacy_admission.as_ref().unwrap();
        evidence
            .validate(&overlay.account_id, &operation, Some(&overlay))
            .unwrap();
        evidence
            .validate(&overlay.account_id, &operation, None)
            .unwrap();
        assert!(operation.is_legacy_held());
        assert_eq!(
            evidence
                .expected_overlay_fingerprint(&overlay.account_id, &operation)
                .unwrap(),
            Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap())
        );
        let mut changed = overlay.clone();
        changed.favorite = true;
        assert!(evidence
            .validate(&overlay.account_id, &operation, Some(&changed))
            .is_err());
        for code in [
            serde_json::Value::Null,
            "item_not_found".into(),
            serde_json::json!({}),
        ] {
            let mut invalid = value.clone();
            invalid["legacyAdmission"]["capturedFailureCode"] = code;
            assert!(serde_json::from_value::<OperationRecord>(invalid).is_err());
        }
        for (status, disposition) in [("pending", "normal"), ("conflicted", "legacyConflicted")] {
            let mut invalid = value.clone();
            invalid["legacyAdmission"]["sourceCommand"]["status"] = status.into();
            invalid["legacyAdmission"]["disposition"] = disposition.into();
            let changed: OperationRecord = serde_json::from_value(invalid).unwrap();
            assert!(changed
                .legacy_admission
                .as_ref()
                .unwrap()
                .validate(&overlay.account_id, &changed, None)
                .is_err());
        }
    }

    #[test]
    fn captured_failure_evidence_is_immutable_through_retry_and_retirement() {
        let (mut operation, overlay) = accepted_create();
        let evidence = operation.legacy_admission.as_mut().unwrap();
        evidence.disposition = LegacyOperationDisposition::LegacyFailed;
        evidence.source_command.status = Some(LegacyItemCommandStatus::Failed);
        evidence.captured_failure_code = Some(LegacyCreateFailureCode::ItemIdConflict);
        let state = InMemoryReplica::default();
        state
            .install("account".into(), "user".into(), "incarnation".into())
            .unwrap();
        state
            .seed_ready_authority(
                &"account".into(),
                vec![personal_vault("vault:source", "user")],
                Vec::new(),
            )
            .unwrap();
        state
            .execute(guard(
                &state.snapshot(&"account".into()).unwrap(),
                vec![
                    PlanMutation::AcceptOperation(operation.clone()),
                    PlanMutation::PutOptimisticItem(overlay.clone()),
                ],
            ))
            .unwrap();
        let admitted = reload(state.snapshot(&"account".into()).unwrap());
        assert_eq!(admitted.items, vec![overlay]);
        let mut retry = operation.clone();
        retry.scheduling.attempt_count = 7;
        retry.scheduling.not_before_ms = 999;
        state
            .execute(guard(
                &admitted,
                vec![PlanMutation::RescheduleOperation(retry.clone())],
            ))
            .unwrap();
        let saved = reload(state.snapshot(&"account".into()).unwrap());
        assert_eq!(
            saved.operations[0].legacy_admission,
            operation.legacy_admission
        );
        for replacement in [None, Some(LegacyCreateFailureCode::VaultReadOnly)] {
            let mut changed = retry.clone();
            changed
                .legacy_admission
                .as_mut()
                .unwrap()
                .captured_failure_code = replacement;
            assert!(state
                .execute(guard(
                    &saved,
                    vec![PlanMutation::RescheduleOperation(changed)]
                ))
                .is_err());
            assert_eq!(state.snapshot(&"account".into()).unwrap(), saved);
        }
        state
            .execute(guard(
                &saved,
                vec![PlanMutation::RetireVaults {
                    vault_ids: vec!["vault:source".into()],
                }],
            ))
            .unwrap();
        let retired = reload(state.snapshot(&"account".into()).unwrap());
        assert!(retired.items.is_empty());
        assert_eq!(retired.operations, vec![retry]);
    }

    #[test]
    fn held_update_retains_original_attempt_without_overlay_or_witness() {
        for (status, disposition) in [
            (
                LegacyItemCommandStatus::Failed,
                LegacyOperationDisposition::LegacyFailed,
            ),
            (
                LegacyItemCommandStatus::Conflicted,
                LegacyOperationDisposition::LegacyConflicted,
            ),
        ] {
            let (mut operation, overlay) = accepted_update();
            let admission = operation.legacy_admission.as_mut().unwrap();
            admission.disposition = disposition;
            admission.source_command.status = Some(status);
            admission.source_command.conflict_copy_id = Some("independent-copy".into());
            admission.source_command.retry_count = 5;
            admission.source_command.next_attempt_at = Some(9000);
            admission.source_command.projection_claim_id = Some("retired-claim".into());
            admission.source_command.projection_claim_expires_at = Some(12000);
            admission.overlay_sha256 = None;
            operation.scheduling = admission.initial_scheduling();
            let evidence = operation.legacy_admission.as_ref().unwrap();
            evidence
                .validate(&overlay.account_id, &operation, None)
                .unwrap();
            assert!(operation.is_legacy_held());
            assert_eq!(
                evidence
                    .expected_overlay_fingerprint(&overlay.account_id, &operation)
                    .unwrap(),
                None
            );
            assert!(evidence
                .validate(&overlay.account_id, &operation, Some(&overlay))
                .is_err());
            let mut changed = operation.clone();
            changed.legacy_admission.as_mut().unwrap().overlay_sha256 =
                Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap());
            assert!(changed
                .legacy_admission
                .as_ref()
                .unwrap()
                .validate(&overlay.account_id, &changed, None)
                .is_err());
        }
    }

    #[test]
    fn held_update_retry_retirement_and_receipt_preserve_current_attempt_lineage() {
        for (status, disposition) in [
            (
                LegacyItemCommandStatus::Failed,
                LegacyOperationDisposition::LegacyFailed,
            ),
            (
                LegacyItemCommandStatus::Conflicted,
                LegacyOperationDisposition::LegacyConflicted,
            ),
        ] {
            for rejected in [false, true] {
                let (mut operation, overlay) = accepted_update();
                let evidence = operation.legacy_admission.as_mut().unwrap();
                evidence.disposition = disposition;
                evidence.source_command.status = Some(status);
                evidence.source_command.conflict_copy_id = Some("retained-copy".into());
                evidence.overlay_sha256 = None;
                let base = AuthorityItemRecord {
                    id: overlay.item_id.clone(),
                    vault_id: overlay.vault_id.clone(),
                    category: overlay.category.clone(),
                    favorite: overlay.favorite,
                    encrypted_data: "confirmed-ciphertext".into(),
                    encryption_iv: "confirmed-iv".into(),
                    encryption_algorithm: overlay.encryption_algorithm.clone(),
                    version: 6,
                    encryption_version: 3,
                    encrypted_by_user_id: "earlier-writer".into(),
                    last_modified_by: "earlier-writer".into(),
                    created_at: overlay.created_at.clone(),
                    updated_at: overlay.updated_at.clone(),
                    deleted_at: None,
                    attachments: overlay.attachments.clone(),
                };
                let state = InMemoryReplica::default();
                state
                    .install("account".into(), "user".into(), "incarnation".into())
                    .unwrap();
                state
                    .seed_ready_authority(
                        &"account".into(),
                        vec![personal_vault("vault:source", "user")],
                        vec![base.clone()],
                    )
                    .unwrap();
                state
                    .execute(guard(
                        &state.snapshot(&"account".into()).unwrap(),
                        vec![PlanMutation::AcceptOperation(operation.clone())],
                    ))
                    .unwrap();
                let admitted = reload(state.snapshot(&"account".into()).unwrap());
                assert!(admitted.items.is_empty());
                assert!(!admitted.item_has_optimistic_owner(&base.id));
                assert_eq!(admitted.bootstrap.snapshot().visible_items, vec![base]);
                let mut retry = operation.clone();
                retry.scheduling.attempt_count = 6;
                retry.scheduling.not_before_ms = 42000;
                state
                    .execute(guard(
                        &admitted,
                        vec![PlanMutation::RescheduleOperation(retry.clone())],
                    ))
                    .unwrap();
                let saved = reload(state.snapshot(&"account".into()).unwrap());
                assert_eq!(saved.operations, vec![retry.clone()]);
                let mut changed = retry.clone();
                changed
                    .legacy_admission
                    .as_mut()
                    .unwrap()
                    .source_queue_index += 1;
                assert!(state
                    .execute(guard(
                        &saved,
                        vec![PlanMutation::RescheduleOperation(changed)]
                    ))
                    .is_err());
                assert_eq!(state.snapshot(&"account".into()).unwrap(), saved);
                state
                    .execute(guard(
                        &saved,
                        vec![PlanMutation::RetireVaults {
                            vault_ids: vec!["vault:source".into()],
                        }],
                    ))
                    .unwrap();
                let retired = reload(state.snapshot(&"account".into()).unwrap());
                assert_eq!(retired.operations, vec![retry]);
                assert!(retired.items.is_empty());
                assert!(retired.bootstrap.snapshot().visible_items.is_empty());
                let mut malformed = operation.clone();
                malformed.request.body = br#"{"encryptedData":"","encryptionIv":"iv","encryptionAlgorithm":"AES-GCM-AAD-V1"}"#.to_vec();
                malformed.request_fingerprint = item_operation_fingerprint(
                    OperationKind::UpdateItem,
                    "PATCH /api/v1/items/{itemId}",
                    malformed.item_id(),
                    &malformed.request.body,
                    6,
                );
                assert!(malformed
                    .legacy_admission
                    .as_ref()
                    .unwrap()
                    .validate(&"account".into(), &malformed, None)
                    .is_err());
                let outcome = ObservedOutcome {
                    operation_id: operation.operation_id.clone(),
                    request_fingerprint: operation.request_fingerprint,
                    result: if rejected {
                        OperationOutcomeResult::Rejected {
                            code: crate::replica::OperationRejectionCode::ItemVersionConflict,
                        }
                    } else {
                        OperationOutcomeResult::Applied {
                            entity_id: operation.item_id().to_owned(),
                            version: 7,
                        }
                    },
                };
                state
                    .execute(guard(
                        &retired,
                        vec![PlanMutation::ReconcileRetainedResult { outcome }],
                    ))
                    .unwrap();
                let completed = reload(state.snapshot(&"account".into()).unwrap());
                assert!(completed.operations.is_empty());
                assert!(completed.items.is_empty());
                assert!(completed.bootstrap.snapshot().visible_items.is_empty());
                let receipt = &completed.receipts[0];
                assert_eq!(receipt.operation_id, "attempt-operation");
                let lineage = receipt.legacy_lineage.as_ref().unwrap();
                assert_eq!(lineage.source_status, Some(status));
                assert_eq!(lineage.source_command_id, "source-command");
                assert_eq!(
                    lineage.source_operation_id.as_deref(),
                    Some("semantic-operation")
                );
                assert_eq!(
                    lineage.source_attempt_id.as_deref(),
                    Some("attempt-operation")
                );
                assert_eq!(lineage.conflict_copy_id.as_deref(), Some("retained-copy"));
            }
        }
    }

    #[test]
    fn held_metadata_and_move_preserve_requests_through_retry_retirement_and_receipt() {
        for kind in [
            LegacyItemCommandKind::ToggleFavorite,
            LegacyItemCommandKind::Delete,
            LegacyItemCommandKind::Restore,
            LegacyItemCommandKind::PermanentDelete,
            LegacyItemCommandKind::Move,
        ] {
            for (status, disposition) in [
                (
                    LegacyItemCommandStatus::Failed,
                    LegacyOperationDisposition::LegacyFailed,
                ),
                (
                    LegacyItemCommandStatus::Conflicted,
                    LegacyOperationDisposition::LegacyConflicted,
                ),
            ] {
                let retired_vaults = if kind == LegacyItemCommandKind::Move {
                    vec!["vault:source", "vault:target"]
                } else {
                    vec!["vault:source"]
                };
                for retired_vault in retired_vaults {
                    for rejected in [false, true] {
                        let (mut operation, overlay) = if kind == LegacyItemCommandKind::Move {
                            accepted_move(true)
                        } else {
                            accepted_metadata(kind)
                        };
                        let evidence = operation.legacy_admission.as_mut().unwrap();
                        evidence.disposition = disposition;
                        evidence.source_command.status = Some(status);
                        evidence.source_command.retry_count = 5;
                        evidence.source_command.next_attempt_at = Some(9000);
                        evidence.source_command.projection_claim_id = Some("retired-claim".into());
                        evidence.source_command.projection_claim_expires_at = Some(8000);
                        evidence.source_command.conflict_copy_id = Some("historical-copy".into());
                        evidence.overlay_sha256 = None;
                        operation.scheduling.attempt_count = 5;
                        operation.scheduling.not_before_ms = 9000;
                        let state = InMemoryReplica::default();
                        state
                            .install("account".into(), "user".into(), "incarnation".into())
                            .unwrap();
                        state
                            .seed_ready_authority(
                                &"account".into(),
                                vec![
                                    personal_vault("vault:source", "user"),
                                    personal_vault("vault:target", "user"),
                                ],
                                Vec::new(),
                            )
                            .unwrap();
                        state
                            .execute(guard(
                                &state.snapshot(&"account".into()).unwrap(),
                                vec![PlanMutation::AcceptOperation(operation.clone())],
                            ))
                            .unwrap();
                        let admitted = reload(state.snapshot(&"account".into()).unwrap());
                        assert_eq!(admitted.operations, vec![operation.clone()]);
                        assert!(!admitted.item_has_optimistic_owner(operation.item_id()));
                        assert!(admitted.items.is_empty());
                        let evidence = operation.legacy_admission.as_ref().unwrap();
                        assert_eq!(
                            evidence
                                .expected_overlay_fingerprint(&admitted.account_id, &operation)
                                .unwrap(),
                            None
                        );
                        assert!(state
                            .execute(guard(
                                &admitted,
                                vec![PlanMutation::PutOptimisticItem(overlay.clone())]
                            ))
                            .is_err());
                        let mut forged = operation.clone();
                        forged.legacy_admission.as_mut().unwrap().overlay_sha256 =
                            Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap());
                        assert!(forged
                            .legacy_admission
                            .as_ref()
                            .unwrap()
                            .validate(&admitted.account_id, &forged, None)
                            .is_err());
                        let mut retry = operation.clone();
                        retry.scheduling.attempt_count = 6;
                        retry.scheduling.not_before_ms = 42000;
                        state
                            .execute(guard(
                                &admitted,
                                vec![PlanMutation::RescheduleOperation(retry.clone())],
                            ))
                            .unwrap();
                        let saved = reload(state.snapshot(&"account".into()).unwrap());
                        let mut changed = retry.clone();
                        changed
                            .legacy_admission
                            .as_mut()
                            .unwrap()
                            .source_queue_index += 1;
                        assert!(state
                            .execute(guard(
                                &saved,
                                vec![PlanMutation::RescheduleOperation(changed)]
                            ))
                            .is_err());
                        assert_eq!(state.snapshot(&"account".into()).unwrap(), saved);
                        state
                            .execute(guard(
                                &saved,
                                vec![PlanMutation::RetireVaults {
                                    vault_ids: vec![retired_vault.into()],
                                }],
                            ))
                            .unwrap();
                        let retired = reload(state.snapshot(&"account".into()).unwrap());
                        assert_eq!(retired.operations, vec![retry]);
                        assert!(retired.items.is_empty());
                        let mut malformed = operation.clone();
                        malformed.request.path.push_str("changed");
                        assert!(malformed
                            .legacy_admission
                            .as_ref()
                            .unwrap()
                            .validate(&retired.account_id, &malformed, None)
                            .is_err());
                        let authority = retired.bootstrap.snapshot();
                        let outcome = ObservedOutcome {
                            operation_id: operation.operation_id.clone(),
                            request_fingerprint: operation.request_fingerprint,
                            result: if rejected {
                                OperationOutcomeResult::Rejected {
                                    code:
                                        crate::replica::OperationRejectionCode::ItemVersionConflict,
                                }
                            } else {
                                OperationOutcomeResult::Applied {
                                    entity_id: operation.item_id().to_owned(),
                                    version: 7,
                                }
                            },
                        };
                        state
                            .execute(guard(
                                &retired,
                                vec![PlanMutation::ReconcileRetainedResult { outcome }],
                            ))
                            .unwrap();
                        let completed = reload(state.snapshot(&"account".into()).unwrap());
                        assert!(completed.operations.is_empty());
                        assert!(completed.items.is_empty());
                        let completed_authority = completed.bootstrap.snapshot();
                        assert_eq!(completed_authority.visible_vaults, authority.visible_vaults);
                        assert_eq!(completed_authority.visible_items, authority.visible_items);
                        let receipt = &completed.receipts[0];
                        assert_eq!(receipt.operation_id, "attempt-operation");
                        assert_eq!(receipt.kind, operation.kind);
                        let lineage = receipt.legacy_lineage.as_ref().unwrap();
                        assert_eq!(lineage.source_status, Some(status));
                        assert_eq!(
                            lineage.source_operation_id.as_deref(),
                            Some("semantic-operation")
                        );
                        assert_eq!(
                            lineage.source_attempt_id.as_deref(),
                            Some("attempt-operation")
                        );
                        assert_eq!(lineage.conflict_copy_id.as_deref(), Some("historical-copy"));
                    }
                }
            }
        }
    }

    #[test]
    fn held_create_requires_matching_status_exact_request_and_no_overlay() {
        for (status, disposition) in [
            (
                LegacyItemCommandStatus::Failed,
                LegacyOperationDisposition::LegacyFailed,
            ),
            (
                LegacyItemCommandStatus::Conflicted,
                LegacyOperationDisposition::LegacyConflicted,
            ),
        ] {
            let (mut operation, overlay) = accepted_create();
            let admission = operation.legacy_admission.as_mut().unwrap();
            admission.source_command.status = Some(status);
            admission.source_command.conflict_copy_id = Some("retained-copy".into());
            admission.disposition = disposition;
            let evidence = operation.legacy_admission.as_ref().unwrap();
            evidence
                .validate(&overlay.account_id, &operation, None)
                .unwrap();
            assert!(operation.is_legacy_held());
            assert_eq!(
                evidence
                    .expected_overlay_fingerprint(&overlay.account_id, &operation)
                    .unwrap(),
                None
            );
            assert!(evidence
                .validate(&overlay.account_id, &operation, Some(&overlay))
                .is_err());
            for field in [
                "status",
                "disposition",
                "witness",
                "empty-ciphertext",
                "path",
            ] {
                let mut changed = operation.clone();
                match field {
                    "status" => {
                        changed
                            .legacy_admission
                            .as_mut()
                            .unwrap()
                            .source_command
                            .status = Some(LegacyItemCommandStatus::Pending)
                    }
                    "disposition" => {
                        changed.legacy_admission.as_mut().unwrap().disposition =
                            LegacyOperationDisposition::Normal
                    }
                    "witness" => {
                        changed.legacy_admission.as_mut().unwrap().overlay_sha256 =
                            Some(Sha256Fingerprint([1; 32]))
                    }
                    "empty-ciphertext" => {
                        changed.request.body = br#"{"category":"login","encryptedData":"","encryptionIv":"iv","encryptionAlgorithm":"AES-GCM-AAD-V1"}"#.to_vec();
                        changed.request_fingerprint = create_item_fingerprint(
                            changed.vault_id(),
                            changed.item_id(),
                            &changed.request.body,
                        );
                    }
                    "path" => changed.request.path.push_str("/changed"),
                    _ => unreachable!(),
                }
                assert!(
                    changed
                        .legacy_admission
                        .as_ref()
                        .unwrap()
                        .validate(&overlay.account_id, &changed, None)
                        .is_err(),
                    "{field}"
                );
            }
        }
    }

    #[test]
    fn held_create_completion_preserves_a_new_active_overlay_and_compact_lineage() {
        for status in [
            LegacyItemCommandStatus::Failed,
            LegacyItemCommandStatus::Conflicted,
        ] {
            for held_first in [false, true] {
                for rejected in [false, true] {
                    let (mut held, _) = accepted_create();
                    let evidence = held.legacy_admission.as_mut().unwrap();
                    evidence.source_command.status = Some(status);
                    evidence.source_command.conflict_copy_id = Some("historical-copy".into());
                    evidence.disposition = if status == LegacyItemCommandStatus::Failed {
                        LegacyOperationDisposition::LegacyFailed
                    } else {
                        LegacyOperationDisposition::LegacyConflicted
                    };
                    let (mut active, mut overlay) = accepted_create();
                    active.operation_id = "new-active-create".into();
                    let evidence = active.legacy_admission.as_mut().unwrap();
                    evidence.source_queue_index = 1;
                    evidence.source_command.id = "new-source-command".into();
                    evidence.source_command.operation_id = Some(active.operation_id.clone());
                    evidence.source_command.attempt_id = None;
                    overlay.operation_id = active.operation_id.clone();
                    let state = InMemoryReplica::default();
                    state
                        .install("account".into(), "user".into(), "incarnation".into())
                        .unwrap();
                    state
                        .seed_ready_authority(
                            &"account".into(),
                            vec![personal_vault("vault:source", "user")],
                            Vec::new(),
                        )
                        .unwrap();
                    let operations = if held_first {
                        [held.clone(), active.clone()]
                    } else {
                        [active.clone(), held.clone()]
                    };
                    for operation in operations {
                        state
                            .execute(guard(
                                &state.snapshot(&"account".into()).unwrap(),
                                vec![PlanMutation::AcceptOperation(operation)],
                            ))
                            .unwrap();
                    }
                    state
                        .execute(guard(
                            &state.snapshot(&"account".into()).unwrap(),
                            vec![PlanMutation::PutOptimisticItem(overlay.clone())],
                        ))
                        .unwrap();
                    let admitted = reload(state.snapshot(&"account".into()).unwrap());
                    assert_eq!(admitted.operations.len(), 2);
                    assert_eq!(admitted.items, vec![overlay.clone()]);
                    assert!(admitted.item_has_optimistic_owner(&overlay.item_id));
                    let result = if rejected {
                        OperationOutcomeResult::Rejected {
                            code: crate::replica::OperationRejectionCode::ItemIdConflict,
                        }
                    } else {
                        OperationOutcomeResult::Applied {
                            entity_id: overlay.item_id.clone(),
                            version: 1,
                        }
                    };
                    let outcome = ObservedOutcome {
                        operation_id: held.operation_id.clone(),
                        request_fingerprint: held.request_fingerprint,
                        result,
                    };
                    let reconciliation = if rejected {
                        PlanMutation::RetainRejection {
                            outcome,
                            cursor: None,
                        }
                    } else {
                        PlanMutation::ReconcileAppliedCreate {
                            outcome,
                            item: Box::new(AuthorityItemRecord {
                                id: overlay.item_id.clone(),
                                vault_id: overlay.vault_id.clone(),
                                category: overlay.category.clone(),
                                favorite: overlay.favorite,
                                encrypted_data: overlay.encrypted_data.clone(),
                                encryption_iv: overlay.encryption_iv.clone(),
                                encryption_algorithm: overlay.encryption_algorithm.clone(),
                                version: 1,
                                encryption_version: 1,
                                encrypted_by_user_id: "user".into(),
                                last_modified_by: "user".into(),
                                created_at: overlay.created_at.clone(),
                                updated_at: overlay.updated_at.clone(),
                                deleted_at: None,
                                attachments: Vec::new(),
                            }),
                            cursor: None,
                        }
                    };
                    state
                        .execute(guard(
                            &state.snapshot(&"account".into()).unwrap(),
                            vec![reconciliation],
                        ))
                        .unwrap();
                    let completed = reload(state.snapshot(&"account".into()).unwrap());
                    assert_eq!(completed.operations, vec![active]);
                    assert_eq!(completed.items, vec![overlay]);
                    let lineage = completed.receipts[0].legacy_lineage.as_ref().unwrap();
                    assert_eq!(lineage.source_status, Some(status));
                    assert_eq!(lineage.conflict_copy_id.as_deref(), Some("historical-copy"));
                    assert_eq!(
                        lineage.source_operation_id.as_deref(),
                        Some("semantic-operation")
                    );
                    assert_eq!(
                        lineage.source_attempt_id.as_deref(),
                        Some("attempt-operation")
                    );
                }
            }
        }
    }

    #[test]
    fn create_admission_requires_the_initial_ciphertext_version() {
        let (mut operation, mut overlay) = accepted_create();
        operation
            .legacy_admission
            .as_mut()
            .unwrap()
            .source_command
            .encrypted_payload
            .as_mut()
            .unwrap()
            .encryption_version = 2;
        overlay.encryption_version = 2;
        assert!(operation
            .legacy_admission
            .as_deref()
            .unwrap()
            .validate(&overlay.account_id, &operation, Some(&overlay))
            .is_err());
    }

    #[test]
    fn retry_preserves_admission_and_completion_compacts_exact_lineage() {
        for status in [
            None,
            Some(LegacyItemCommandStatus::Staged),
            Some(LegacyItemCommandStatus::Applying),
            Some(LegacyItemCommandStatus::Pending),
            Some(LegacyItemCommandStatus::Retrying),
        ] {
            for (mut operation, overlay) in accepted_cases() {
                let evidence = operation.legacy_admission.as_mut().unwrap();
                evidence.source_command.status = status;
                evidence.source_command.retry_count = 5;
                evidence.source_command.next_attempt_at = Some(42_000);
                evidence.source_command.last_error = Some("".into());
                evidence.source_command.projection_claim_id = Some("departed-projector".into());
                evidence.source_command.projection_claim_expires_at = Some(9_007_199_254_740_991);
                operation.scheduling = evidence.initial_scheduling();
                let state = InMemoryReplica::default();
                state
                    .install(
                        "account".into(),
                        "user".into(),
                        Incarnation::from("incarnation"),
                    )
                    .unwrap();
                state
                    .seed_ready_authority(
                        &AccountId::from("account"),
                        vec![
                            personal_vault("vault:source", "user"),
                            personal_vault("vault:target", "user"),
                        ],
                        Vec::new(),
                    )
                    .unwrap();
                let initial = state.snapshot(&"account".into()).unwrap();
                state
                    .execute(guard(
                        &initial,
                        vec![
                            PlanMutation::AcceptOperation(operation.clone()),
                            PlanMutation::PutOptimisticItem(overlay),
                        ],
                    ))
                    .unwrap();
                let accepted = reload(state.snapshot(&"account".into()).unwrap());
                let mut retry = accepted.operations[0].clone();
                retry.scheduling.attempt_count += 1;
                retry.scheduling.not_before_ms += 1_000;
                state
                    .execute(guard(
                        &state.snapshot(&"account".into()).unwrap(),
                        vec![PlanMutation::RescheduleOperation(retry.clone())],
                    ))
                    .unwrap();
                let retried = reload(state.snapshot(&"account".into()).unwrap());
                assert_eq!(
                    retried.operations[0].legacy_admission,
                    operation.legacy_admission
                );

                let mut changed = retried.operations[0].clone();
                changed.legacy_admission.as_mut().unwrap().admission_id = "changed".into();
                assert!(state
                    .execute(guard(
                        &state.snapshot(&"account".into()).unwrap(),
                        vec![PlanMutation::RescheduleOperation(changed)],
                    ))
                    .is_err());

                let mut changed_witness = retried.operations[0].clone();
                changed_witness
                    .legacy_admission
                    .as_mut()
                    .unwrap()
                    .overlay_sha256 = Some(Sha256Fingerprint([9; 32]));
                assert!(state
                    .execute(guard(
                        &state.snapshot(&"account".into()).unwrap(),
                        vec![PlanMutation::RescheduleOperation(changed_witness)]
                    ))
                    .is_err());
                let current = state.snapshot(&"account".into()).unwrap();
                let version = if operation.kind == OperationKind::CreateItem {
                    1
                } else {
                    7
                };
                let reconciliation = PlanMutation::ReconcileAppliedCreate {
                    outcome: ObservedOutcome {
                        operation_id: retry.operation_id.clone(),
                        request_fingerprint: retry.request_fingerprint,
                        result: OperationOutcomeResult::Applied {
                            entity_id: "item:queued".into(),
                            version,
                        },
                    },
                    item: Box::new(AuthorityItemRecord {
                        id: "item:queued".into(),
                        vault_id: operation.vault_id().to_owned(),
                        category: AuthorityItemCategory::Login,
                        favorite: false,
                        encrypted_data: "ciphertext".into(),
                        encryption_iv: "iv".into(),
                        encryption_algorithm: "AES-GCM-AAD-V1".into(),
                        version,
                        encryption_version: version,
                        encrypted_by_user_id: "user".into(),
                        last_modified_by: "user".into(),
                        created_at: "1970-01-01T00:00:00Z".into(),
                        updated_at: "1970-01-01T00:00:00Z".into(),
                        deleted_at: None,
                        attachments: Vec::new(),
                    }),
                    cursor: None,
                };
                let reconciliation = match reconciliation {
                    PlanMutation::ReconcileAppliedCreate {
                        outcome,
                        item,
                        cursor,
                    } if operation.kind != OperationKind::CreateItem => {
                        PlanMutation::ReconcileItemMutation {
                            outcome,
                            item: (operation.kind != OperationKind::PermanentlyDeleteItem)
                                .then_some(item),
                            cursor,
                        }
                    }
                    other => other,
                };
                state
                    .execute(guard(&current, vec![reconciliation]))
                    .unwrap();
                let completed = reload(state.snapshot(&"account".into()).unwrap());
                assert!(completed.operations.is_empty());
                assert!(completed.items.is_empty());
                let lineage = completed.receipts[0].legacy_lineage.as_ref().unwrap();
                assert_eq!(lineage.admission_id, "admission");
                assert_eq!(lineage.source_status, status);
                assert_eq!(lineage.source_command_id, "source-command");
                assert_eq!(
                    lineage.source_operation_id.as_deref(),
                    Some("semantic-operation")
                );
                assert_eq!(
                    lineage.source_attempt_id.as_deref(),
                    Some("attempt-operation")
                );
            }
        }
    }
}
