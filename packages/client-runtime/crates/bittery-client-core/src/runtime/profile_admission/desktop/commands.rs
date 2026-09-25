//! Closed compatibility reader for legacy Desktop Item commands.
//!
//! This module owns source decoding and exact HTTP reconstruction. Durable Replica metadata keeps
//! only typed lineage and envelope references; the immutable Operation request remains the sole
//! owner of ciphertext bytes.

use crate::{
    http_transport::{HttpHeader, HttpMethod},
    replica::{
        create_item_fingerprint, encode_component, item_operation_fingerprint, source_timestamp,
        AuthorityItemCategory, AuthorityItemRecord, AuthorityVaultRole, BootstrapAuthoritySnapshot,
        CrossAccountMoveBindingStatus, CrossAccountMoveDestinationBinding,
        CrossAccountMoveEndpoint, CrossAccountMoveEntry, CrossAccountMoveIdentity,
        CrossAccountMoveItemOperation, CrossAccountMoveStep, ImmutableHttpRequest,
        ImmutableRequestPayload, LegacyCrossAccountMoveAdmission, LegacyItemCategory,
        LegacyItemCommandKind, LegacyItemCommandStatus, LegacyItemCommandV1,
        LegacyOperationAdmission, LegacyOperationDisposition, LegacySourceUnavailableMove,
        LegacyWorkflowDisposition, OperationKind, OperationRecord, ReplicaItemRecord, ReplicaState,
        ResourceRef, WorkflowAcceptedPayload, LEGACY_OPERATION_ADMISSION_VERSION,
    },
    AccountId, RuntimeError, RuntimeErrorCode, SecretString,
};
use serde::{de::MapAccess, Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::runtime::profile_admission) struct SourceCommand {
    account_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    account_email: Option<String>,
    id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    operation_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    attempt_id: Option<String>,
    #[serde(rename = "type")]
    kind: LegacyItemCommandKind,
    entity_id: String,
    vault_id: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    target_vault_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    target_account_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    target_item_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    category: Option<LegacyItemCategory>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    encrypted_payload: Option<SourceEncryptedPayload>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    favorite: Option<bool>,
    base_version: i32,
    timestamp: u64,
    retry_count: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    status: Option<LegacyItemCommandStatus>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    last_error: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    next_attempt_at: Option<u64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    conflict_copy_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    projection_claim_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    projection_claim_expires_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceEncryptedPayload {
    encrypted_data: String,
    encryption_iv: String,
    encryption_algorithm: String,
    encryption_version: i32,
    encrypted_by_user_id: String,
}

crate::wire::map_only_serde!(SourceCommand, SourceEncryptedPayload);

#[derive(Debug, PartialEq, Eq)]
pub(super) struct CompatibleRequest {
    pub(super) method: &'static str,
    pub(super) path: String,
    pub(super) operation_id: String,
    pub(super) if_match: Option<String>,
    pub(super) body: Vec<u8>,
}

pub(super) struct AccountIdentity<'a> {
    pub(super) account_id: &'a str,
    pub(super) email: &'a str,
    pub(super) user_id: &'a str,
}

pub(in crate::runtime::profile_admission) struct DecodedCreate {
    command: SourceCommand,
    request: CompatibleRequest,
}

pub(in crate::runtime::profile_admission) struct DecodedExisting {
    command: SourceCommand,
    request: CompatibleRequest,
}

pub(in crate::runtime::profile_admission) enum DecodedCommand {
    Create(DecodedCreate),
    Existing(DecodedExisting),
    CrossAccount(SourceCommand),
}

pub(in crate::runtime::profile_admission) struct CommandScope<'a> {
    pub metadata: &'a crate::platform_storage::AccountMetadataDocument,
    pub authority: BootstrapAuthoritySnapshot,
}

pub(in crate::runtime::profile_admission) enum BoundCommand {
    Operation {
        operation: Box<OperationRecord>,
        overlay: Option<ReplicaItemRecord>,
    },
    Workflow {
        record: Box<CrossAccountMoveEntry>,
        overlay: Option<ReplicaItemRecord>,
    },
}

impl CommandScope<'_> {
    fn require_visible(
        &self,
        vault_id: &str,
    ) -> Result<&crate::replica::AuthorityVaultRecord, RuntimeError> {
        self.authority
            .visible_vaults
            .iter()
            .find(|vault| vault.id == vault_id)
            .ok_or_else(|| invalid("Legacy Item command targets a missing cached Vault"))
    }

    fn require_writable(&self, vault_id: &str) -> Result<(), RuntimeError> {
        let vault = self.require_visible(vault_id)?;
        if vault.role == AuthorityVaultRole::ReadOnly {
            return Err(invalid(
                "Legacy Item command targets a read-only cached Vault",
            ));
        }
        Ok(())
    }
}

impl DecodedCommand {
    pub(in crate::runtime::profile_admission) fn bind_scoped(
        self,
        admission_id: &str,
        source_queue_index: u64,
        source: &CommandScope<'_>,
        accounts: &BTreeMap<String, CommandScope<'_>>,
    ) -> Result<BoundCommand, RuntimeError> {
        if let Self::CrossAccount(command) = self {
            let disposition = match command.status {
                Some(LegacyItemCommandStatus::Failed) => LegacyWorkflowDisposition::LegacyFailed,
                Some(LegacyItemCommandStatus::Conflicted) => {
                    LegacyWorkflowDisposition::LegacyConflicted
                }
                _ => LegacyWorkflowDisposition::Normal,
            };
            let held = disposition != LegacyWorkflowDisposition::Normal;
            let destination = accounts
                .get(
                    command
                        .target_account_id
                        .as_deref()
                        .expect("decoded target Account"),
                )
                .ok_or_else(|| invalid("Legacy Move destination Account is missing"))?;
            if held {
                source.require_visible(&command.vault_id)?;
            } else {
                source.require_writable(&command.vault_id)?;
            }
            let target_vault = command
                .target_vault_id
                .as_deref()
                .expect("decoded target Vault");
            if held {
                destination.require_visible(target_vault)?;
            } else {
                destination.require_writable(target_vault)?;
            }
            let Some(base) = source
                .authority
                .visible_items
                .iter()
                .find(|item| item.id == command.entity_id)
            else {
                return bind_source_unavailable(
                    command,
                    admission_id,
                    source_queue_index,
                    source,
                    destination,
                    disposition,
                );
            };
            if base.vault_id != command.vault_id
                || base.version != command.base_version
                || base.deleted_at.is_some()
                || !base.attachments.is_empty()
                || Some(&base.category)
                    != command.category.map(AuthorityItemCategory::from).as_ref()
            {
                return Err(invalid(
                    "Legacy Move source baseline does not match its command",
                ));
            }
            let payload = command
                .encrypted_payload
                .as_ref()
                .expect("decoded target payload");
            let mut target = base.clone();
            target.id = command.target_item_id.clone().expect("decoded target Item");
            target.vault_id = target_vault.to_owned();
            target.encrypted_data = payload.encrypted_data.clone();
            target.encryption_iv = payload.encryption_iv.clone();
            target.encryption_algorithm = payload.encryption_algorithm.clone();
            target.encryption_version = 1;
            target.version = 1;
            target.encrypted_by_user_id = destination.metadata.user_id.clone();
            target.last_modified_by = destination.metadata.user_id.clone();
            target.favorite = false;
            target.deleted_at = None;
            target.attachments.clear();
            if destination
                .authority
                .visible_items
                .iter()
                .find(|item| item.id == target.id)
                .is_some_and(|item| !same_target_content(item, &target))
            {
                return Err(invalid(
                    "Legacy Move cached target differs from accepted content",
                ));
            }
            let admission = LegacyCrossAccountMoveAdmission {
                version: LEGACY_OPERATION_ADMISSION_VERSION,
                admission_id: admission_id.to_owned(),
                source_queue_index,
                source_command: command.into_evidence_with(|payload| {
                    WorkflowAcceptedPayload::Target {
                        encryption_version: payload.encryption_version,
                        encrypted_by_user_id: payload.encrypted_by_user_id,
                    }
                }),
                disposition,
            };
            let record = admission.bind(
                CrossAccountMoveIdentity {
                    server_url: source.metadata.normalized_server_url.clone(),
                    user_id: source.metadata.user_id.clone(),
                },
                CrossAccountMoveIdentity {
                    server_url: destination.metadata.normalized_server_url.clone(),
                    user_id: destination.metadata.user_id.clone(),
                },
                CrossAccountMoveDestinationBinding {
                    account_id: destination.metadata.account_id.clone(),
                    incarnation: destination.metadata.incarnation.clone(),
                    binding_revision: 0,
                    status: CrossAccountMoveBindingStatus::Active,
                },
                base.clone(),
                target,
            )?;
            let overlay = (!held).then(|| record.source_overlay(&source.metadata.account_id));
            Ok(BoundCommand::Workflow {
                record: Box::new(record.into()),
                overlay,
            })
        } else {
            let (operation, overlay) = self.bind(
                admission_id,
                source_queue_index,
                &source.authority.visible_items,
            )?;
            for vault_id in operation.accepted_vault_ids()? {
                if operation.is_legacy_held() {
                    source.require_visible(&vault_id)?;
                } else {
                    source.require_writable(&vault_id)?;
                }
            }
            Ok(BoundCommand::Operation {
                operation: Box::new(operation),
                overlay,
            })
        }
    }

    pub(in crate::runtime::profile_admission) fn bind(
        self,
        admission_id: &str,
        source_queue_index: u64,
        authority: &[AuthorityItemRecord],
    ) -> Result<(OperationRecord, Option<ReplicaItemRecord>), RuntimeError> {
        match self {
            Self::CrossAccount(_) => Err(invalid("Legacy Move requires both Account scopes")),
            Self::Create(create) => {
                if authority
                    .iter()
                    .any(|item| item.id == create.command.entity_id)
                {
                    return Err(invalid(
                        "Legacy Create conflicts with cached Item authority",
                    ));
                }
                create.bind(admission_id, source_queue_index)
            }
            Self::Existing(existing) => existing.bind(admission_id, source_queue_index, authority),
        }
    }
}

/// Preserve the exact accepted command when the captured current cache no longer has its source.
/// Current destination authority is independent of this non-executable historical evidence.
fn bind_source_unavailable(
    command: SourceCommand,
    admission_id: &str,
    source_queue_index: u64,
    source: &CommandScope<'_>,
    destination: &CommandScope<'_>,
    disposition: LegacyWorkflowDisposition,
) -> Result<BoundCommand, RuntimeError> {
    if source.authority.state != ReplicaState::Ready
        || destination.authority.state != ReplicaState::Ready
    {
        return Err(invalid(
            "Legacy missing-source Move requires complete current cache scopes",
        ));
    }
    let target_vault_id = command
        .target_vault_id
        .as_ref()
        .expect("decoded target Vault");
    let target_item_id = command
        .target_item_id
        .as_ref()
        .expect("decoded target Item");
    let payload = command
        .encrypted_payload
        .as_ref()
        .expect("decoded target payload");
    let body = encode(&CreateBody {
        category: command.category.expect("decoded target category"),
        encrypted_data: &payload.encrypted_data,
        encryption_iv: &payload.encryption_iv,
        encryption_algorithm: &payload.encryption_algorithm,
    })?;
    let target_create = CrossAccountMoveItemOperation {
        step: CrossAccountMoveStep::TargetCreate,
        endpoint: CrossAccountMoveEndpoint::Destination,
        operation_id: format!(
            "{}:create-target",
            command.operation_id.as_deref().unwrap_or(&command.id)
        ),
        kind: OperationKind::CreateItem,
        target: ResourceRef::Item {
            item_id: target_item_id.clone(),
            vault_id: target_vault_id.clone(),
        },
        request_fingerprint: create_item_fingerprint(target_vault_id, target_item_id, &body),
        request: ImmutableHttpRequest {
            method: HttpMethod::Put,
            path: format!(
                "/api/v1/vaults/{}/items/{}",
                encode_component(target_vault_id),
                encode_component(target_item_id)
            ),
            headers: vec![HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
            body,
        },
        result: None,
    };
    let admission = LegacyCrossAccountMoveAdmission {
        version: LEGACY_OPERATION_ADMISSION_VERSION,
        admission_id: admission_id.to_owned(),
        source_queue_index,
        source_command: command.into_evidence_with(|payload| WorkflowAcceptedPayload::Target {
            encryption_version: payload.encryption_version,
            encrypted_by_user_id: payload.encrypted_by_user_id,
        }),
        disposition,
    };
    let record = LegacySourceUnavailableMove::bind(
        admission,
        CrossAccountMoveIdentity {
            server_url: source.metadata.normalized_server_url.clone(),
            user_id: source.metadata.user_id.clone(),
        },
        CrossAccountMoveIdentity {
            server_url: destination.metadata.normalized_server_url.clone(),
            user_id: destination.metadata.user_id.clone(),
        },
        CrossAccountMoveDestinationBinding {
            account_id: destination.metadata.account_id.clone(),
            incarnation: destination.metadata.incarnation.clone(),
            binding_revision: 0,
            status: CrossAccountMoveBindingStatus::Active,
        },
        target_create,
    )?;
    Ok(BoundCommand::Workflow {
        record: Box::new(CrossAccountMoveEntry::LegacySourceUnavailable(Box::new(
            record,
        ))),
        overlay: None,
    })
}

fn same_target_content(current: &AuthorityItemRecord, target: &AuthorityItemRecord) -> bool {
    current.id == target.id
        && current.vault_id == target.vault_id
        && current.category == target.category
        && current.encrypted_data == target.encrypted_data
        && current.encryption_iv == target.encryption_iv
        && current.encryption_algorithm == target.encryption_algorithm
        && current.encryption_version == target.encryption_version
        && current.encrypted_by_user_id == target.encrypted_by_user_id
        && current.favorite == target.favorite
        && current.version == target.version
        && current.deleted_at == target.deleted_at
        && current.attachments == target.attachments
}

impl DecodedExisting {
    fn bind(
        self,
        admission_id: &str,
        source_queue_index: u64,
        authority: &[AuthorityItemRecord],
    ) -> Result<(OperationRecord, Option<ReplicaItemRecord>), RuntimeError> {
        let command = self.command;
        let base = authority
            .iter()
            .find(|item| item.id == command.entity_id)
            .ok_or_else(|| invalid("Legacy Item command has no cached base"))?;
        let requires_live = matches!(
            command.kind,
            LegacyItemCommandKind::Update
                | LegacyItemCommandKind::ToggleFavorite
                | LegacyItemCommandKind::Delete
                | LegacyItemCommandKind::Move
        );
        let disposition = command.disposition();
        let base_version_matches = if command.kind == LegacyItemCommandKind::Update
            && disposition != LegacyOperationDisposition::Normal
        {
            base.version >= command.base_version
        } else {
            base.version == command.base_version
        };
        if base.vault_id != command.vault_id
            || !base_version_matches
            || (requires_live && base.deleted_at.is_some())
        {
            return Err(invalid(
                "Legacy Item command does not match its cached base",
            ));
        }
        let account_id = AccountId::from(command.account_id.clone());
        let item_id = command.entity_id.clone();
        let vault_id = if command.kind == LegacyItemCommandKind::Move {
            command
                .target_vault_id
                .clone()
                .expect("decoded Move target")
        } else {
            command.vault_id.clone()
        };
        let mut overlay =
            (disposition == LegacyOperationDisposition::Normal).then(|| ReplicaItemRecord {
                account_id: AccountId::from(command.account_id.clone()),
                item_id: command.entity_id.clone(),
                vault_id: command.vault_id.clone(),
                operation_id: self.request.operation_id.clone(),
                category: base.category.clone(),
                encrypted_data: base.encrypted_data.clone(),
                encryption_iv: base.encryption_iv.clone(),
                encryption_algorithm: base.encryption_algorithm.clone(),
                encryption_version: base.encryption_version,
                encrypted_by_user_id: base.encrypted_by_user_id.clone(),
                favorite: base.favorite,
                version: base.version,
                created_at: base.created_at.clone(),
                updated_at: base.updated_at.clone(),
                deleted_at: base.deleted_at.clone(),
                attachments: base.attachments.clone(),
                permanently_deleted: false,
            });
        let timestamp = source_timestamp(command.timestamp)?;
        let (kind, method, route, content_type) = match command.kind {
            LegacyItemCommandKind::Update | LegacyItemCommandKind::Move => {
                let payload = command
                    .encrypted_payload
                    .as_ref()
                    .expect("decoded Update payload");
                if let Some(overlay) = &mut overlay {
                    overlay.encrypted_data = payload.encrypted_data.clone();
                    overlay.encryption_iv = payload.encryption_iv.clone();
                    overlay.encryption_algorithm = payload.encryption_algorithm.clone();
                    overlay.encryption_version = payload.encryption_version;
                    overlay.encrypted_by_user_id = payload.encrypted_by_user_id.clone();
                    overlay.version = payload.encryption_version;
                    overlay.updated_at = timestamp;
                    overlay.vault_id = vault_id.clone();
                }
                if command.kind == LegacyItemCommandKind::Move {
                    (
                        OperationKind::MoveItem,
                        HttpMethod::Post,
                        "POST /api/v1/items/{itemId}/moves",
                        Some("application/json"),
                    )
                } else {
                    (
                        OperationKind::UpdateItem,
                        HttpMethod::Patch,
                        "PATCH /api/v1/items/{itemId}",
                        Some("application/merge-patch+json"),
                    )
                }
            }
            LegacyItemCommandKind::ToggleFavorite => {
                if let Some(overlay) = &mut overlay {
                    overlay.favorite = command.favorite.unwrap_or(false);
                    overlay.updated_at = timestamp;
                }
                (
                    OperationKind::SetItemFavorite,
                    HttpMethod::Patch,
                    "PATCH /api/v1/items/{itemId}/favorite",
                    Some("application/merge-patch+json"),
                )
            }
            LegacyItemCommandKind::Delete => {
                if let Some(overlay) = &mut overlay {
                    overlay.deleted_at = Some(timestamp.clone());
                    overlay.updated_at = timestamp;
                }
                (
                    OperationKind::TrashItem,
                    HttpMethod::Delete,
                    "DELETE /api/v1/items/{itemId}",
                    None,
                )
            }
            LegacyItemCommandKind::Restore => {
                if let Some(overlay) = &mut overlay {
                    overlay.deleted_at = None;
                    overlay.updated_at = timestamp;
                }
                (
                    OperationKind::RestoreItem,
                    HttpMethod::Post,
                    "POST /api/v1/items/{itemId}/restore",
                    None,
                )
            }
            LegacyItemCommandKind::PermanentDelete => (
                OperationKind::PermanentlyDeleteItem,
                HttpMethod::Delete,
                "DELETE /api/v1/items/{itemId}/permanent",
                None,
            ),
            _ => return Err(invalid("Legacy Item command kind is unsupported")),
        };
        let evidence = LegacyOperationAdmission {
            version: LEGACY_OPERATION_ADMISSION_VERSION,
            admission_id: admission_id.to_owned(),
            source_queue_index,
            source_command: command.into_evidence(),
            disposition,
            overlay_sha256: overlay
                .as_ref()
                .map(LegacyOperationAdmission::overlay_fingerprint)
                .transpose()?,
            captured_failure_code: None,
        };
        let mut headers = content_type
            .map(|value| HttpHeader {
                name: "Content-Type".into(),
                value: value.into(),
            })
            .into_iter()
            .collect::<Vec<_>>();
        headers.push(HttpHeader {
            name: "If-Match".into(),
            value: self.request.if_match.expect("existing Item base version"),
        });
        let scheduling = evidence.initial_scheduling();
        let operation = OperationRecord {
            operation_id: self.request.operation_id,
            kind,
            target: ResourceRef::Item {
                item_id: item_id.clone(),
                vault_id,
            },
            request_fingerprint: item_operation_fingerprint(
                kind,
                route,
                &item_id,
                &self.request.body,
                evidence.source_command.base_version,
            ),
            request: ImmutableHttpRequest {
                method,
                path: self.request.path,
                headers,
                body: self.request.body,
            },
            accepted_item_category: Some(base.category.clone()),
            attachment_move_recovery: None,
            create_vault: None,
            update_vault: None,
            scheduling,
            legacy_admission: Some(Box::new(evidence)),
        };
        operation
            .legacy_admission
            .as_ref()
            .expect("bound admission")
            .validate(&account_id, &operation, overlay.as_ref())?;
        Ok((operation, overlay))
    }
}

impl SourceCommand {
    fn into_evidence(self) -> LegacyItemCommandV1 {
        self.into_evidence_with(|payload| ImmutableRequestPayload {
            encryption_version: payload.encryption_version,
            encrypted_by_user_id: payload.encrypted_by_user_id,
        })
    }

    fn into_evidence_with<Payload>(
        self,
        payload: impl FnOnce(SourceEncryptedPayload) -> Payload,
    ) -> LegacyItemCommandV1<Payload> {
        LegacyItemCommandV1 {
            account_id: AccountId::from(self.account_id),
            account_email: self.account_email,
            id: self.id,
            operation_id: self.operation_id,
            attempt_id: self.attempt_id,
            kind: self.kind,
            entity_id: self.entity_id,
            vault_id: self.vault_id,
            target_vault_id: self.target_vault_id,
            target_account_id: self.target_account_id.map(AccountId::from),
            target_item_id: self.target_item_id,
            category: self.category,
            encrypted_payload: self.encrypted_payload.map(payload),
            favorite: self.favorite,
            base_version: self.base_version,
            timestamp: self.timestamp,
            retry_count: self.retry_count,
            status: self.status,
            last_error: self.last_error,
            next_attempt_at: self.next_attempt_at,
            conflict_copy_id: self.conflict_copy_id,
            projection_claim_id: self.projection_claim_id,
            projection_claim_expires_at: self.projection_claim_expires_at,
        }
    }
}

impl DecodedCreate {
    fn bind(
        self,
        admission_id: &str,
        source_queue_index: u64,
    ) -> Result<(OperationRecord, Option<ReplicaItemRecord>), RuntimeError> {
        let command = self.command;
        let category =
            AuthorityItemCategory::from(command.category.expect("decoded Create category"));
        let disposition = command.disposition();
        let account_id = AccountId::from(command.account_id.clone());
        let item_id = command.entity_id.clone();
        let vault_id = command.vault_id.clone();
        let payload = command
            .encrypted_payload
            .as_ref()
            .expect("decoded Create payload");
        let accepted_at = source_timestamp(command.timestamp)?;
        let overlay =
            (disposition == LegacyOperationDisposition::Normal).then(|| ReplicaItemRecord {
                account_id: AccountId::from(command.account_id.clone()),
                item_id: command.entity_id.clone(),
                vault_id: command.vault_id.clone(),
                operation_id: self.request.operation_id.clone(),
                category: category.clone(),
                encrypted_data: payload.encrypted_data.clone(),
                encryption_iv: payload.encryption_iv.clone(),
                encryption_algorithm: payload.encryption_algorithm.clone(),
                encryption_version: payload.encryption_version,
                encrypted_by_user_id: payload.encrypted_by_user_id.clone(),
                favorite: false,
                version: 1,
                created_at: accepted_at.clone(),
                updated_at: accepted_at,
                deleted_at: None,
                attachments: Vec::new(),
                permanently_deleted: false,
            });
        let evidence = LegacyOperationAdmission {
            version: LEGACY_OPERATION_ADMISSION_VERSION,
            admission_id: admission_id.to_owned(),
            source_queue_index,
            source_command: command.into_evidence(),
            disposition,
            overlay_sha256: None,
            captured_failure_code: None,
        };
        let scheduling = evidence.initial_scheduling();
        let operation = OperationRecord {
            operation_id: self.request.operation_id,
            kind: OperationKind::CreateItem,
            target: ResourceRef::Item {
                item_id: item_id.clone(),
                vault_id: vault_id.clone(),
            },
            request_fingerprint: create_item_fingerprint(&vault_id, &item_id, &self.request.body),
            request: ImmutableHttpRequest {
                method: HttpMethod::Put,
                path: self.request.path,
                headers: vec![HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }],
                body: self.request.body,
            },
            accepted_item_category: Some(category),
            attachment_move_recovery: None,
            create_vault: None,
            update_vault: None,
            scheduling,
            legacy_admission: Some(Box::new(evidence)),
        };
        operation
            .legacy_admission
            .as_ref()
            .expect("bound admission")
            .validate(&account_id, &operation, overlay.as_ref())?;
        Ok((operation, overlay))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody<'a> {
    category: LegacyItemCategory,
    encrypted_data: &'a str,
    // This order is part of the legacy byte contract.
    encryption_iv: &'a str,
    encryption_algorithm: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody<'a> {
    encrypted_data: &'a str,
    encryption_iv: &'a str,
    encryption_algorithm: &'a str,
}

#[derive(Serialize)]
struct FavoriteBody {
    favorite: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MoveBody<'a> {
    mode: &'static str,
    source_vault_id: &'a str,
    target_vault_id: &'a str,
    encrypted_data: &'a str,
    encryption_iv: &'a str,
    encryption_algorithm: &'a str,
}

pub(super) fn compatible_request(
    command: &SourceCommand,
) -> Result<CompatibleRequest, RuntimeError> {
    command.validate_common()?;
    let semantic_id = command.operation_id.as_deref().unwrap_or(&command.id);
    let attempt_id = command.attempt_id.as_deref().unwrap_or(&command.id);
    let if_match = || Some(format!("\"{}\"", command.base_version));
    let request = match command.kind {
        LegacyItemCommandKind::Create => {
            let payload = command.only_payload_and_category()?;
            CompatibleRequest {
                method: "PUT",
                path: format!(
                    "/api/v1/vaults/{}/items/{}",
                    encode_component(&command.vault_id),
                    encode_component(&command.entity_id)
                ),
                operation_id: semantic_id.to_owned(),
                if_match: None,
                body: encode(&CreateBody {
                    category: command.category.expect("validated category"),
                    encrypted_data: &payload.encrypted_data,
                    encryption_iv: &payload.encryption_iv,
                    encryption_algorithm: &payload.encryption_algorithm,
                })?,
            }
        }
        LegacyItemCommandKind::Update => {
            let payload = command.only_payload()?;
            CompatibleRequest {
                method: "PATCH",
                path: format!("/api/v1/items/{}", encode_component(&command.entity_id)),
                operation_id: attempt_id.to_owned(),
                if_match: if_match(),
                body: encode(&UpdateBody {
                    encrypted_data: &payload.encrypted_data,
                    encryption_iv: &payload.encryption_iv,
                    encryption_algorithm: &payload.encryption_algorithm,
                })?,
            }
        }
        LegacyItemCommandKind::ToggleFavorite => {
            command.require_no_payload_fields(false)?;
            CompatibleRequest {
                method: "PATCH",
                path: format!(
                    "/api/v1/items/{}/favorite",
                    encode_component(&command.entity_id)
                ),
                operation_id: attempt_id.to_owned(),
                if_match: if_match(),
                body: encode(&FavoriteBody {
                    favorite: command.favorite.unwrap_or(false),
                })?,
            }
        }
        LegacyItemCommandKind::Delete => {
            command.empty_request("DELETE", "", attempt_id, if_match())?
        }
        LegacyItemCommandKind::PermanentDelete => {
            command.empty_request("DELETE", "/permanent", attempt_id, if_match())?
        }
        LegacyItemCommandKind::Restore => {
            command.empty_request("POST", "/restore", attempt_id, if_match())?
        }
        LegacyItemCommandKind::Move => {
            let payload = command.only_move_payload()?;
            CompatibleRequest {
                method: "POST",
                path: format!(
                    "/api/v1/items/{}/moves",
                    encode_component(&command.entity_id)
                ),
                operation_id: attempt_id.to_owned(),
                if_match: if_match(),
                body: encode(&MoveBody {
                    mode: "prepared",
                    source_vault_id: &command.vault_id,
                    target_vault_id: command
                        .target_vault_id
                        .as_deref()
                        .expect("validated target"),
                    encrypted_data: &payload.encrypted_data,
                    encryption_iv: &payload.encryption_iv,
                    encryption_algorithm: &payload.encryption_algorithm,
                })?,
            }
        }
        LegacyItemCommandKind::CrossAccountMove => {
            return Err(invalid(
                "Legacy cross-Account Item command needs workflow admission",
            ));
        }
    };
    Ok(request)
}

pub(super) fn decode(
    sync: &mut BTreeMap<String, SecretString>,
    accounts: &[AccountIdentity<'_>],
) -> Result<BTreeMap<String, Vec<DecodedCommand>>, RuntimeError> {
    let Some(raw) = sync.remove("bittery_pending_mutation_queues_v3") else {
        return Ok(BTreeMap::new());
    };
    let QueueDocument(queues): QueueDocument = serde_json::from_str(&raw)
        .map_err(|_| invalid("Legacy Desktop Item command queues are malformed"))?;
    let accounts = accounts
        .iter()
        .map(|account| (account.account_id, account))
        .collect::<BTreeMap<_, _>>();
    let mut decoded = BTreeMap::new();
    for (account_id, queue) in queues {
        let account = accounts
            .get(account_id.as_str())
            .ok_or_else(|| invalid("Legacy Item command belongs to an unknown Account"))?;
        let mut identities = HashSet::new();
        let mut item_ids = HashSet::new();
        let mut accepted = Vec::with_capacity(queue.len());
        for command in queue {
            command.validate_common()?;
            if command.kind == LegacyItemCommandKind::CrossAccountMove {
                let held = command.disposition() != LegacyOperationDisposition::Normal;
                let destination = command
                    .target_account_id
                    .as_deref()
                    .and_then(|id| accounts.get(id));
                let payload = command.encrypted_payload.as_ref();
                let semantic = command.operation_id.as_deref().unwrap_or(&command.id);
                let ids = [command.id.as_str(), semantic]
                    .into_iter()
                    .collect::<HashSet<_>>();
                if command.account_id != account_id
                    || command
                        .account_email
                        .as_deref()
                        .is_some_and(|email| email != account.email)
                    || destination.is_none_or(|destination| {
                        !payload.is_some_and(|payload| {
                            payload.encryption_version == 1
                                && payload.encrypted_by_user_id == destination.user_id
                        })
                    })
                    || command.target_account_id.as_deref() == Some(account_id.as_str())
                    || command
                        .target_item_id
                        .as_deref()
                        .is_none_or(|id| id == command.entity_id)
                    || command.target_vault_id.is_none()
                    || command.category.is_none()
                    || command.favorite.is_some()
                    || command.base_version <= 0
                    || command.base_version.checked_add(2).is_none()
                    || (!held && !LegacyItemCommandStatus::is_normal(command.status))
                    || (!held && command.conflict_copy_id.is_some())
                    || ids.into_iter().any(|id| !identities.insert(id.to_owned()))
                    || (!held && !item_ids.insert(command.entity_id.clone()))
                {
                    return Err(invalid(
                        "Legacy Move requires unsupported or inconsistent source evidence",
                    ));
                }
                accepted.push(DecodedCommand::CrossAccount(command));
                continue;
            }
            let request = compatible_request(&command)?;
            let semantic_id = command.operation_id.as_deref().unwrap_or(&command.id);
            let command_identities = [
                command.id.as_str(),
                semantic_id,
                request.operation_id.as_str(),
            ]
            .into_iter()
            .collect::<HashSet<_>>();
            let payload = command.encrypted_payload.as_ref();
            let held = matches!(
                command.kind,
                LegacyItemCommandKind::Create
                    | LegacyItemCommandKind::Update
                    | LegacyItemCommandKind::ToggleFavorite
                    | LegacyItemCommandKind::Delete
                    | LegacyItemCommandKind::Restore
                    | LegacyItemCommandKind::PermanentDelete
                    | LegacyItemCommandKind::Move
            ) && matches!(
                command.status,
                Some(LegacyItemCommandStatus::Failed | LegacyItemCommandStatus::Conflicted)
            );
            if command.account_id != account_id
                || command
                    .account_email
                    .as_deref()
                    .is_some_and(|email| email != account.email)
                || payload.is_some_and(|payload| payload.encrypted_by_user_id != account.user_id)
                || (!held && !LegacyItemCommandStatus::is_normal(command.status))
                || (!held && command.conflict_copy_id.is_some())
                || command_identities
                    .into_iter()
                    .any(|identity| !identities.insert(identity.to_owned()))
                || (!held && !item_ids.insert(command.entity_id.clone()))
            {
                return Err(invalid(
                    "Legacy Item command needs unsupported admission behavior",
                ));
            }
            let decoded = match command.kind {
                LegacyItemCommandKind::Create
                    if command.base_version == 0
                        && payload.is_some_and(|payload| payload.encryption_version == 1) =>
                {
                    DecodedCommand::Create(DecodedCreate { command, request })
                }
                LegacyItemCommandKind::Update | LegacyItemCommandKind::Move
                    if command.base_version > 0
                        && command.base_version.checked_add(1).is_some_and(|version| {
                            payload.is_some_and(|payload| version == payload.encryption_version)
                        }) =>
                {
                    DecodedCommand::Existing(DecodedExisting { command, request })
                }
                LegacyItemCommandKind::ToggleFavorite
                | LegacyItemCommandKind::Delete
                | LegacyItemCommandKind::Restore
                | LegacyItemCommandKind::PermanentDelete
                    if command.base_version > 0 =>
                {
                    DecodedCommand::Existing(DecodedExisting { command, request })
                }
                _ => {
                    return Err(invalid(
                        "Legacy Item command needs unsupported admission behavior",
                    ));
                }
            };
            accepted.push(decoded);
        }
        decoded.insert(account_id, accepted);
    }
    Ok(decoded)
}

struct QueueDocument(BTreeMap<String, Vec<SourceCommand>>);

impl<'de> Deserialize<'de> for QueueDocument {
    fn deserialize<D: serde::Deserializer<'de>>(decoder: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = QueueDocument;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("an Account command queue object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut queues = BTreeMap::new();
                while let Some((account_id, queue)) =
                    map.next_entry::<String, Vec<SourceCommand>>()?
                {
                    if queues.insert(account_id, queue).is_some() {
                        return Err(serde::de::Error::custom("duplicate Account command queue"));
                    }
                }
                Ok(QueueDocument(queues))
            }
        }
        decoder.deserialize_map(Visitor)
    }
}

impl SourceCommand {
    fn disposition(&self) -> LegacyOperationDisposition {
        match self.status {
            Some(LegacyItemCommandStatus::Failed) => LegacyOperationDisposition::LegacyFailed,
            Some(LegacyItemCommandStatus::Conflicted) => {
                LegacyOperationDisposition::LegacyConflicted
            }
            _ => LegacyOperationDisposition::Normal,
        }
    }

    fn validate_common(&self) -> Result<(), RuntimeError> {
        for value in [
            Some(self.account_id.as_str()),
            Some(self.id.as_str()),
            self.operation_id.as_deref(),
            self.attempt_id.as_deref(),
            Some(self.entity_id.as_str()),
            Some(self.vault_id.as_str()),
            self.account_email.as_deref(),
            self.target_vault_id.as_deref(),
            self.target_account_id.as_deref(),
            self.target_item_id.as_deref(),
            self.conflict_copy_id.as_deref(),
            self.projection_claim_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty() {
                return Err(invalid(
                    "Legacy Item command contains an empty identity or value",
                ));
            }
        }
        if self.base_version < 0
            || self.timestamp > MAX_SAFE_INTEGER
            || self.retry_count > MAX_SAFE_INTEGER
            || self
                .next_attempt_at
                .is_some_and(|value| value > MAX_SAFE_INTEGER)
            || self
                .projection_claim_expires_at
                .is_some_and(|value| value > MAX_SAFE_INTEGER)
        {
            return Err(invalid("Legacy Item command numeric value is out of range"));
        }
        if let Some(payload) = &self.encrypted_payload {
            if payload.encryption_version <= 0
                || payload.encrypted_data.is_empty()
                || payload.encryption_iv.is_empty()
                || payload.encryption_algorithm.is_empty()
                || payload.encrypted_by_user_id.is_empty()
            {
                return Err(invalid("Legacy Item command encrypted payload is invalid"));
            }
        }
        Ok(())
    }

    fn only_payload_and_category(&self) -> Result<&SourceEncryptedPayload, RuntimeError> {
        if self.category.is_none()
            || self.favorite.is_some()
            || self.target_vault_id.is_some()
            || self.target_account_id.is_some()
            || self.target_item_id.is_some()
        {
            return Err(invalid(
                "Legacy Create Item command fields are inconsistent",
            ));
        }
        self.encrypted_payload
            .as_ref()
            .ok_or_else(|| invalid("Legacy Create Item command has no encrypted payload"))
    }

    fn only_payload(&self) -> Result<&SourceEncryptedPayload, RuntimeError> {
        if self.category.is_some()
            || self.favorite.is_some()
            || self.target_vault_id.is_some()
            || self.target_account_id.is_some()
            || self.target_item_id.is_some()
        {
            return Err(invalid(
                "Legacy Update Item command fields are inconsistent",
            ));
        }
        self.encrypted_payload
            .as_ref()
            .ok_or_else(|| invalid("Legacy Update Item command has no encrypted payload"))
    }

    fn only_move_payload(&self) -> Result<&SourceEncryptedPayload, RuntimeError> {
        if self.category.is_some()
            || self.favorite.is_some()
            || self.target_vault_id.is_none()
            || self.target_account_id.is_some()
            || self.target_item_id.is_some()
        {
            return Err(invalid("Legacy Move Item command fields are inconsistent"));
        }
        self.encrypted_payload
            .as_ref()
            .ok_or_else(|| invalid("Legacy Move Item command has no encrypted payload"))
    }

    fn require_no_payload_fields(&self, allow_favorite: bool) -> Result<(), RuntimeError> {
        if self.category.is_some()
            || self.encrypted_payload.is_some()
            || (!allow_favorite
                && self.favorite.is_some()
                && self.kind != LegacyItemCommandKind::ToggleFavorite)
            || self.target_vault_id.is_some()
            || self.target_account_id.is_some()
            || self.target_item_id.is_some()
        {
            return Err(invalid(
                "Legacy Item command fields are inconsistent with its kind",
            ));
        }
        Ok(())
    }

    fn empty_request(
        &self,
        method: &'static str,
        suffix: &str,
        operation_id: &str,
        if_match: Option<String>,
    ) -> Result<CompatibleRequest, RuntimeError> {
        self.require_no_payload_fields(false)?;
        if self.favorite.is_some() {
            return Err(invalid(
                "Legacy Item command fields are inconsistent with its kind",
            ));
        }
        Ok(CompatibleRequest {
            method,
            path: format!(
                "/api/v1/items/{}{suffix}",
                encode_component(&self.entity_id)
            ),
            operation_id: operation_id.to_owned(),
            if_match,
            body: Vec::new(),
        })
    }
}

fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, RuntimeError> {
    serde_json::to_vec(value)
        .map_err(|_| invalid("Legacy Item command request is not serializable"))
}

fn present<'de, D, T>(decoder: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(decoder).map(Some)
}

fn invalid(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::SourceFailure, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        captures: Vec<Capture>,
        source_commands: BTreeMap<String, SourceCommand>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Capture {
        name: String,
        method: String,
        path: String,
        operation_id: String,
        if_match: Option<String>,
        body: String,
    }

    #[test]
    fn legacy_commands_reconstruct_all_production_request_bytes() {
        let fixture: Fixture = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../planning/evolutionary-rust-runtime/desktop-extension/fixtures/legacy-request-serialization.json"
        )))
        .unwrap();
        assert_eq!(fixture.captures.len(), 12);
        for expected in fixture.captures {
            let command = fixture.source_commands.get(&expected.name).unwrap();
            let actual = compatible_request(command).unwrap();
            assert_eq!(actual.method, expected.method, "{} method", expected.name);
            assert_eq!(actual.path, expected.path, "{} path", expected.name);
            assert_eq!(
                actual.operation_id, expected.operation_id,
                "{} Operation ID",
                expected.name
            );
            assert_eq!(
                actual.if_match, expected.if_match,
                "{} If-Match",
                expected.name
            );
            assert_eq!(
                actual.body,
                expected.body.as_bytes(),
                "{} body",
                expected.name
            );
        }
    }

    #[test]
    fn legacy_command_is_object_only_and_rejects_duplicates_and_unknown_fields() {
        let command = r#"{
            "accountId":"account","id":"command","type":"delete","entityId":"item",
            "vaultId":"vault","baseVersion":1,"timestamp":1,"retryCount":0
        }"#;
        assert!(serde_json::from_str::<SourceCommand>(command).is_ok());
        assert!(serde_json::from_str::<SourceCommand>(
            r#"["account","command","delete","item","vault",1,1,0]"#
        )
        .is_err());
        assert!(serde_json::from_str::<SourceCommand>(
            &command.replace("\"retryCount\":0", "\"retryCount\":0,\"retryCount\":1")
        )
        .is_err());
        assert!(serde_json::from_str::<SourceCommand>(
            &command.replace("\"retryCount\":0", "\"retryCount\":0,\"future\":true")
        )
        .is_err());
        assert!(serde_json::from_str::<SourceCommand>(
            &command.replace("\"retryCount\":0", "\"retryCount\":0,\"lastError\":\"\"")
        )
        .is_ok());
        for field in ["operationId", "status", "encryptedPayload", "lastError"] {
            assert!(serde_json::from_str::<SourceCommand>(&command.replace(
                "\"retryCount\":0",
                &format!("\"retryCount\":0,\"{field}\":null")
            ))
            .is_err());
        }
    }

    #[test]
    fn source_categories_keep_the_server_hyphenated_spelling() {
        assert_eq!(
            serde_json::from_str::<LegacyItemCategory>(r#""secure-note""#).unwrap(),
            LegacyItemCategory::SecureNote
        );
        assert_eq!(
            serde_json::from_str::<LegacyItemCategory>(r#""credit-card""#).unwrap(),
            LegacyItemCategory::CreditCard
        );
        assert!(serde_json::from_str::<LegacyItemCategory>(r#""secure_note""#).is_err());
    }
}
