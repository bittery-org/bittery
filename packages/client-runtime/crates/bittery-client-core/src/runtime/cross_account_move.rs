//! One source-owned Move, driven by the existing Operation dispatcher across two Account scopes.
#[path = "cross_account_move_attachment_crypto.rs"]
mod attachment_crypto;
#[path = "cross_account_move_dispatch.rs"]
mod dispatch;
use super::outcome::{CompletionResult, OutcomeResolutionAuthBudget, SemanticAnswer};
use super::vault_key::unwrap_vault_key;
use super::*;
use crate::auth_http::CurrentAuthority;
use crate::http_transport::{HttpHeader, HttpMethod};
use crate::platform_storage::CurrentSessionDocument;
use crate::replica::{
    AuthorityItemRecord, AuthorityVaultRecord, AuthorityVaultRole, CrossAccountMoveBindingStatus,
    CrossAccountMoveBlockedReason, CrossAccountMoveChild, CrossAccountMoveDestinationBinding,
    CrossAccountMoveDisposition, CrossAccountMoveEndpoint, CrossAccountMoveIdentity,
    CrossAccountMoveItemOperation, CrossAccountMoveRecord, CrossAccountMoveSourceAuthority,
    CrossAccountMoveStage, CrossAccountMoveStep, CrossAccountMoveWaitingReason,
    ImmutableHttpRequest, ObservedOutcome, OperationKind, OperationOutcomeResult,
    OperationRejectionCode, OperationSchedulingState, PlanResult, ReplicaItemRecord, ReplicaState,
    ResourceRef,
};
use bittery_crypto_core::{decrypt_with_aad, encrypt_with_aad, AadContext, EncryptedData};

fn move_error(message: &'static str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::AccessDenied, message)
}

impl Runtime {
    fn require_cross_move_participants(
        &self,
        record: &CrossAccountMoveRecord,
        source: &ReplicaSnapshot,
        target: &ReplicaSnapshot,
    ) -> Result<(), RuntimeError> {
        if source.user_id != record.source_identity.user_id
            || target.user_id != record.destination_identity.user_id
        {
            return Err(move_error("Move requires its original Account identities"));
        }
        if record.is_legacy_held() {
            self.require_cross_move_read_scope(source, &record.source.vault_id)?;
            self.require_cross_move_read_scope(target, &record.target.vault_id)?;
        } else {
            self.require_cross_move_scope(source, &record.source.vault_id)?;
            self.require_cross_move_scope(target, &record.target.vault_id)?;
        }
        Ok(())
    }

    /// Ordinary execution must retain its exact binding. Explicit Resume separately verifies
    /// a candidate through the participant check while the original binding is still retired.
    fn require_bound_cross_move_scope(
        &self,
        record: &CrossAccountMoveRecord,
        source: &ReplicaSnapshot,
        target: &ReplicaSnapshot,
    ) -> Result<(), RuntimeError> {
        if record.destination_binding.status != CrossAccountMoveBindingStatus::Active
            || target.account_id != record.destination_binding.account_id
            || target.incarnation != record.destination_binding.incarnation
        {
            return Err(move_error("Move destination binding is no longer current"));
        }
        self.require_cross_move_participants(record, source, target)
    }

    fn require_cross_move_scope(
        &self,
        snapshot: &ReplicaSnapshot,
        vault_id: &str,
    ) -> Result<AuthorityVaultRecord, RuntimeError> {
        let vault = self.require_cross_move_read_scope(snapshot, vault_id)?;
        if vault.role == AuthorityVaultRole::ReadOnly {
            return Err(move_error("Move requires current writable Vault authority"));
        }
        Ok(vault)
    }

    fn require_cross_move_read_scope(
        &self,
        snapshot: &ReplicaSnapshot,
        vault_id: &str,
    ) -> Result<AuthorityVaultRecord, RuntimeError> {
        if snapshot.failure.is_some()
            || snapshot.bootstrap.state != ReplicaState::Ready
            || !self.completion_scope_is_current(snapshot)
            || self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&snapshot.account_id)
                .copied()
                != Some(AccountAccessState::Unlocked)
        {
            return Err(move_error("Move requires both current unlocked Accounts"));
        }
        self.require_vault_accepting_work(snapshot, vault_id)?;
        snapshot
            .bootstrap
            .snapshot()
            .visible_vaults
            .into_iter()
            .find(|vault| vault.id == vault_id)
            .ok_or_else(|| move_error("Move requires current readable Vault authority"))
    }

    pub(super) async fn accept_cross_account_move(
        &self,
        account_id: AccountId,
        item_id: String,
        target_account_id: AccountId,
        target_vault_id: String,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled() || account_id == target_account_id {
            return Err(move_error("Move admission is no longer available"));
        }
        let item_lock = self.item_mutation_lock(&account_id, &item_id);
        let _item_guard = item_lock.lock().await;
        let mut accounts = [account_id.clone(), target_account_id.clone()];
        accounts.sort();
        let first = self.account_execution_lock(&accounts[0])?;
        let second = self.account_execution_lock(&accounts[1])?;
        let _first = first.lock().await;
        let _second = second.lock().await;
        let source = self.require_snapshot(&account_id)?;
        let destination = self.require_snapshot(&target_account_id)?;
        if source.item_has_optimistic_owner(&item_id) {
            return Err(move_error(
                "Another accepted operation owns the source Item",
            ));
        }
        let item = source
            .bootstrap
            .snapshot()
            .visible_items
            .into_iter()
            .find(|item| item.id == item_id)
            .ok_or_else(|| move_error("Move requires a current source Item"))?;
        if item.deleted_at.is_some() || item.version <= 0 || item.version.checked_add(2).is_none() {
            return Err(move_error("The source Item cannot be moved"));
        }
        if !item.attachments.is_empty() {
            let has_facade = self
                .attachment_move_scheduler
                .lock()
                .expect("Attachment Move scheduler lock poisoned")
                .as_ref()
                .is_some_and(|scheduler| scheduler.facade().is_some());
            let has_lease_port = self
                .attachment_move_lifecycle
                .lock()
                .expect("Attachment Move lifecycle lock poisoned")
                .is_some();
            if !has_facade || !has_lease_port {
                return Err(move_error(
                    "Cross-Account Attachment preparation is unavailable",
                ));
            }
        }
        let source_vault = self.require_cross_move_scope(&source, &item.vault_id)?;
        let target_vault = self.require_cross_move_scope(&destination, &target_vault_id)?;
        let source_metadata = self
            .platform_storage
            .load_account_metadata(&account_id, &source.incarnation)
            .await?
            .ok_or_else(|| move_error("Source Account identity is unavailable"))?;
        let target_metadata = self
            .platform_storage
            .load_account_metadata(&target_account_id, &destination.incarnation)
            .await?
            .ok_or_else(|| move_error("Destination Account identity is unavailable"))?;
        self.require_cross_move_scope(&source, &item.vault_id)?;
        self.require_cross_move_scope(&destination, &target_vault_id)?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Move cancelled before acceptance",
            ));
        }
        let source_material = self
            .copy_live_vault_key_material(&account_id, &source.incarnation)
            .ok_or_else(|| move_error("Source keys are unavailable"))?;
        let target_material = self
            .copy_live_vault_key_material(&target_account_id, &destination.incarnation)
            .ok_or_else(|| move_error("Destination keys are unavailable"))?;
        let source_key = Zeroizing::new(unwrap_vault_key(
            &source_vault,
            &source.user_id,
            &source_material,
        )?);
        let target_key = Zeroizing::new(unwrap_vault_key(
            &target_vault,
            &destination.user_id,
            &target_material,
        )?);
        let plaintext = Zeroizing::new(
            decrypt_with_aad(
                &EncryptedData {
                    ciphertext: item.encrypted_data.clone(),
                    iv: item.encryption_iv.clone(),
                    algorithm: item.encryption_algorithm.clone(),
                },
                &source_key,
                &AadContext {
                    vault_id: item.vault_id.clone(),
                    entity_id: item.id.clone(),
                    entity_type: "item".into(),
                    version: item.encryption_version as u64,
                    user_id: item.encrypted_by_user_id.clone(),
                },
            )
            .map_err(|_| move_error("The source Item could not be opened"))?,
        );
        super::bootstrap::decode_item_plaintext(&plaintext, &item.category)?;
        let target_item_id = bittery_crypto_core::generate_uuid();
        let encrypted = encrypt_with_aad(
            &plaintext,
            &target_key,
            &AadContext {
                vault_id: target_vault_id.clone(),
                entity_id: target_item_id.clone(),
                entity_type: "item".into(),
                version: 1,
                user_id: destination.user_id.clone(),
            },
        )
        .map_err(|_| move_error("The target Item could not be encrypted"))?;
        drop(plaintext);
        let attachments = item
            .attachments
            .iter()
            .map(|attachment| {
                attachment_crypto::prepare_checkpoint(
                    attachment,
                    &target_vault_id,
                    &destination.user_id,
                    &source_key,
                    &target_key,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        drop(source_key);
        drop(target_key);
        drop(source_material);
        drop(target_material);
        let operation_id = bittery_crypto_core::generate_uuid();
        let mut target = item.clone();
        target.id = target_item_id;
        target.vault_id = target_vault_id;
        target.encrypted_data = encrypted.ciphertext;
        target.encryption_iv = encrypted.iv;
        target.encryption_algorithm = encrypted.algorithm;
        target.version = 1;
        target.encryption_version = 1;
        target.encrypted_by_user_id = destination.user_id.clone();
        target.last_modified_by = destination.user_id.clone();
        target.favorite = false;
        target.deleted_at = None;
        target.attachments.clear();
        let child = target_create_child(&target)?;
        let record = CrossAccountMoveRecord {
            operation_id: operation_id.clone(),
            source_identity: CrossAccountMoveIdentity {
                server_url: source_metadata.normalized_server_url,
                user_id: source.user_id.clone(),
            },
            destination_identity: CrossAccountMoveIdentity {
                server_url: target_metadata.normalized_server_url,
                user_id: destination.user_id.clone(),
            },
            source: item.clone(),
            target,
            destination_binding: CrossAccountMoveDestinationBinding {
                account_id: target_account_id,
                incarnation: destination.incarnation.clone(),
                binding_revision: 0,
                status: CrossAccountMoveBindingStatus::Active,
            },
            attachments,
            children: vec![child],
            stage: CrossAccountMoveStage::TargetCreate,
            disposition: CrossAccountMoveDisposition::Ready,
            scheduling: OperationSchedulingState::default(),
            legacy_admission: None,
        };
        let overlay = ReplicaItemRecord {
            account_id: account_id.clone(),
            item_id: item.id,
            vault_id: item.vault_id,
            operation_id: operation_id.clone(),
            category: item.category,
            encrypted_data: item.encrypted_data,
            encryption_iv: item.encryption_iv,
            encryption_algorithm: item.encryption_algorithm,
            encryption_version: item.encryption_version,
            encrypted_by_user_id: item.encrypted_by_user_id,
            favorite: item.favorite,
            version: item.version,
            created_at: item.created_at,
            updated_at: item.updated_at,
            deleted_at: item.deleted_at,
            attachments: item.attachments,
            permanently_deleted: false,
        };
        let result = self
            .replica
            .execute_exact(GuardedCommitPlan::new(
                account_id.clone(),
                source.incarnation,
                source.revision,
                source.lock_epoch,
                vec![PlanMutation::AdmitCrossAccountMove {
                    record: Box::new(record),
                    source_overlay: Some(overlay),
                }],
            ))
            .await?;
        let PlanResult::Applied { replica_revision } = result else {
            return Err(move_error("Move authority changed during acceptance"));
        };
        accepted();
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        let _ = self.decrypt_visible_items(&account_id);
        self.wake_dispatch();
        self.publish_all_unless_closed();
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Move cancelled after acceptance",
            ));
        }
        Ok(RuntimeResponse::Accepted {
            operation_id,
            item_id,
            replica_revision,
        })
    }

    pub(super) fn cross_account_move_projections(
        &self,
        snapshot: &ReplicaSnapshot,
    ) -> Vec<crate::OperationProjection> {
        snapshot
            .cross_account_moves
            .iter()
            .map(|entry| {
                let Some(record) = entry.captured() else {
                    return unavailable_source_move_projection(entry);
                };
                use crate::{
                    CrossAccountMoveDisposition as Disposition, CrossAccountMovePhase as Phase,
                };
                let phase = match record.stage {
                    CrossAccountMoveStage::TargetCreate => Phase::TargetCreate,
                    CrossAccountMoveStage::Attachments { next_index } => {
                        Phase::Attachments { next_index }
                    }
                    CrossAccountMoveStage::SourceTrash => Phase::SourceTrash,
                    CrossAccountMoveStage::SourceDelete => Phase::SourceDelete,
                    CrossAccountMoveStage::Completed => Phase::Completed,
                    CrossAccountMoveStage::Rejected => Phase::Rejected,
                };
                let held = record.is_legacy_held()
                    && !matches!(
                        record.stage,
                        CrossAccountMoveStage::Completed | CrossAccountMoveStage::Rejected
                    );
                let mut disposition = match &record.disposition {
                    CrossAccountMoveDisposition::Ready => Disposition::Ready,
                    CrossAccountMoveDisposition::Waiting { reason } => Disposition::Waiting {
                        reason: match reason {
                            CrossAccountMoveWaitingReason::AccountLocked => {
                                crate::CrossAccountMoveWaitingReason::AccountLocked
                            }
                            CrossAccountMoveWaitingReason::Offline => {
                                crate::CrossAccountMoveWaitingReason::Offline
                            }
                            CrossAccountMoveWaitingReason::PolicyVerificationPending => {
                                crate::CrossAccountMoveWaitingReason::PolicyVerificationPending
                            }
                            CrossAccountMoveWaitingReason::AttachmentAccessDenied => {
                                crate::CrossAccountMoveWaitingReason::AttachmentAccessDenied
                            }
                            CrossAccountMoveWaitingReason::AttachmentQuotaExceeded => {
                                crate::CrossAccountMoveWaitingReason::AttachmentQuotaExceeded
                            }
                            CrossAccountMoveWaitingReason::AttachmentSizeRejected => {
                                crate::CrossAccountMoveWaitingReason::AttachmentSizeRejected
                            }
                        },
                    },
                    CrossAccountMoveDisposition::Blocked { reason } => Disposition::Blocked {
                        reason: match reason {
                            CrossAccountMoveBlockedReason::DestinationRetired => {
                                crate::CrossAccountMoveBlockedReason::DestinationRetired
                            }
                            CrossAccountMoveBlockedReason::SourceChanged => {
                                crate::CrossAccountMoveBlockedReason::SourceChanged
                            }
                            CrossAccountMoveBlockedReason::TargetChanged => {
                                crate::CrossAccountMoveBlockedReason::TargetChanged
                            }
                            CrossAccountMoveBlockedReason::MissingProof => {
                                crate::CrossAccountMoveBlockedReason::MissingProof
                            }
                            CrossAccountMoveBlockedReason::MissingArtifact => {
                                crate::CrossAccountMoveBlockedReason::MissingArtifact
                            }
                        },
                    },
                    CrossAccountMoveDisposition::Rejected { code } => Disposition::Rejected {
                        code: rejection_name(code),
                    },
                };
                if held {
                    disposition = Disposition::LegacyHeld;
                }
                if matches!(
                    disposition,
                    Disposition::Ready | Disposition::Waiting { .. }
                ) && !matches!(
                    record.stage,
                    CrossAccountMoveStage::Completed | CrossAccountMoveStage::Rejected
                ) {
                    let target = self
                        .replica
                        .snapshot(&record.destination_binding.account_id);
                    let pending_policy = self.travel_policy_verification_pending(snapshot)
                        || target
                            .as_ref()
                            .is_some_and(|target| self.travel_policy_verification_pending(target));
                    let account_locked = {
                        let access = self
                            .account_access
                            .lock()
                            .expect("Account access lock poisoned");
                        let locked = |account_id| {
                            matches!(
                                access.get(account_id),
                                Some(AccountAccessState::Locked | AccountAccessState::SignedOut)
                            )
                        };
                        locked(&snapshot.account_id)
                            || target
                                .as_ref()
                                .is_some_and(|target| locked(&target.account_id))
                    };
                    // A transient availability change is projected from the existing Account owners.
                    // It must not rewrite the accepted destination binding or any child request.
                    if pending_policy {
                        disposition = Disposition::Waiting {
                            reason: crate::CrossAccountMoveWaitingReason::PolicyVerificationPending,
                        };
                    } else if account_locked {
                        disposition = Disposition::Waiting {
                            reason: crate::CrossAccountMoveWaitingReason::AccountLocked,
                        };
                    } else if target.as_ref().is_none_or(|target| {
                        self.require_bound_cross_move_scope(record, snapshot, target)
                            .is_err()
                    }) {
                        disposition = Disposition::Waiting {
                            reason: crate::CrossAccountMoveWaitingReason::AccessUnavailable,
                        };
                    }
                }
                crate::OperationProjection {
                    operation_id: record.operation_id.clone(),
                    kind: crate::OperationProjectionKind::MoveItem,
                    attempt_count: Some(record.scheduling.attempt_count.to_string()),
                    next_attempt_at_ms: (!held)
                        .then(|| record.scheduling.not_before_ms.to_string()),
                    resolution: match record.stage {
                        CrossAccountMoveStage::Completed => crate::OperationResolution::Applied,
                        CrossAccountMoveStage::Rejected => crate::OperationResolution::Rejected,
                        _ => match record
                            .legacy_admission
                            .as_ref()
                            .map(|admission| admission.disposition)
                        {
                            Some(crate::replica::LegacyWorkflowDisposition::LegacyFailed) => {
                                crate::OperationResolution::LegacyFailed
                            }
                            Some(crate::replica::LegacyWorkflowDisposition::LegacyConflicted) => {
                                crate::OperationResolution::LegacyConflicted
                            }
                            _ => crate::OperationResolution::Pending,
                        },
                    },
                    imported_count: None,
                    rejection_code: match &record.disposition {
                        CrossAccountMoveDisposition::Rejected { code } => {
                            Some(rejection_name(code))
                        }
                        _ => None,
                    },
                    cross_account_move: Some(crate::CrossAccountMoveProjection {
                        phase,
                        destination_server_url: record.destination_identity.server_url.clone(),
                        destination_user_id: record.destination_identity.user_id.clone(),
                        destination_vault_id: record.target.vault_id.clone(),
                        source_visible: record.stage != CrossAccountMoveStage::Completed
                            && !self.travel_policy_verification_pending(snapshot)
                            && !self.vault_is_fenced(snapshot, &record.source.vault_id)
                            && self
                                .account_access
                                .lock()
                                .expect("Account access lock poisoned")
                                .get(&snapshot.account_id)
                                .copied()
                                == Some(AccountAccessState::Unlocked),
                        disposition,
                    }),
                }
            })
            .collect()
    }
}

fn rejection_name(code: &OperationRejectionCode) -> String {
    serde_json::to_value(code)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown".into())
}

fn target_create_child(
    target: &AuthorityItemRecord,
) -> Result<CrossAccountMoveChild, RuntimeError> {
    let body = serde_json::to_vec(&crate::server_contract::CreateItemBody {
        category: match target.category {
            crate::replica::AuthorityItemCategory::Login => {
                crate::server_contract::ItemCategory::Login
            }
            crate::replica::AuthorityItemCategory::SecureNote => {
                crate::server_contract::ItemCategory::SecureNote
            }
            crate::replica::AuthorityItemCategory::CreditCard => {
                crate::server_contract::ItemCategory::CreditCard
            }
            crate::replica::AuthorityItemCategory::Identity => {
                crate::server_contract::ItemCategory::Identity
            }
            crate::replica::AuthorityItemCategory::Totp => {
                crate::server_contract::ItemCategory::Totp
            }
        },
        encrypted_data: target.encrypted_data.clone(),
        encryption_iv: target.encryption_iv.clone(),
        encryption_algorithm: target.encryption_algorithm.clone(),
    })
    .map_err(|_| move_error("Target request could not be encoded"))?;
    Ok(CrossAccountMoveChild::ItemOperation(
        CrossAccountMoveItemOperation {
            step: CrossAccountMoveStep::TargetCreate,
            endpoint: CrossAccountMoveEndpoint::Destination,
            operation_id: bittery_crypto_core::generate_uuid(),
            kind: OperationKind::CreateItem,
            target: ResourceRef::Item {
                item_id: target.id.clone(),
                vault_id: target.vault_id.clone(),
            },
            request_fingerprint: create::create_item_fingerprint(
                &target.vault_id,
                &target.id,
                &body,
            ),
            request: ImmutableHttpRequest {
                method: HttpMethod::Put,
                path: create::create_item_path(&target.vault_id, &target.id),
                headers: vec![HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }],
                body,
            },
            result: None,
        },
    ))
}

/// A parked owner retains provenance and a source reservation, but supplies no source to render.
fn unavailable_source_move_projection(
    entry: &crate::replica::CrossAccountMoveEntry,
) -> crate::OperationProjection {
    let binding = entry.destination_binding();
    let legacy_disposition = entry
        .source_unavailable()
        .map(|record| record.legacy_admission.disposition);
    let held = legacy_disposition.is_some_and(crate::replica::LegacyWorkflowDisposition::is_held);
    crate::OperationProjection {
        operation_id: entry.operation_id().to_owned(),
        kind: crate::OperationProjectionKind::MoveItem,
        attempt_count: Some(entry.scheduling().attempt_count.to_string()),
        next_attempt_at_ms: None,
        resolution: match legacy_disposition {
            Some(crate::replica::LegacyWorkflowDisposition::LegacyFailed) => {
                crate::OperationResolution::LegacyFailed
            }
            Some(crate::replica::LegacyWorkflowDisposition::LegacyConflicted) => {
                crate::OperationResolution::LegacyConflicted
            }
            _ => crate::OperationResolution::Pending,
        },
        imported_count: None,
        rejection_code: None,
        cross_account_move: Some(crate::CrossAccountMoveProjection {
            phase: crate::CrossAccountMovePhase::TargetCreate,
            destination_server_url: entry.destination_identity().server_url.clone(),
            destination_user_id: entry.destination_identity().user_id.clone(),
            destination_vault_id: entry.destination_vault_id().to_owned(),
            source_visible: false,
            disposition: if held {
                crate::CrossAccountMoveDisposition::LegacyHeld
            } else {
                crate::CrossAccountMoveDisposition::Blocked {
                    reason: if binding.status == CrossAccountMoveBindingStatus::Retired {
                        crate::CrossAccountMoveBlockedReason::DestinationRetired
                    } else {
                        crate::CrossAccountMoveBlockedReason::MissingSourceEvidence
                    },
                }
            },
        }),
    }
}

fn source_child(
    record: &CrossAccountMoveRecord,
    delete: bool,
) -> Result<CrossAccountMoveChild, RuntimeError> {
    let step = if delete {
        CrossAccountMoveStep::SourceDelete
    } else {
        CrossAccountMoveStep::SourceTrash
    };
    if let Some(child) = record.legacy_item_child(step)? {
        return Ok(child);
    }
    let (step, kind, route, path, version) = if delete {
        (
            CrossAccountMoveStep::SourceDelete,
            OperationKind::PermanentlyDeleteItem,
            "DELETE /api/v1/items/{itemId}/permanent",
            format!("/api/v1/items/{}/permanent", record.source.id),
            record.source.version + 1,
        )
    } else {
        (
            CrossAccountMoveStep::SourceTrash,
            OperationKind::TrashItem,
            "DELETE /api/v1/items/{itemId}",
            format!("/api/v1/items/{}", record.source.id),
            record.source.version,
        )
    };
    Ok(CrossAccountMoveChild::ItemOperation(
        CrossAccountMoveItemOperation {
            step,
            endpoint: CrossAccountMoveEndpoint::Source,
            operation_id: bittery_crypto_core::generate_uuid(),
            kind,
            target: ResourceRef::Item {
                item_id: record.source.id.clone(),
                vault_id: record.source.vault_id.clone(),
            },
            request_fingerprint: create::item_operation_fingerprint(
                kind,
                route,
                &record.source.id,
                &[],
                version,
            ),
            request: ImmutableHttpRequest {
                method: HttpMethod::Delete,
                path,
                headers: vec![HttpHeader {
                    name: "If-Match".into(),
                    value: format!("\"{version}\""),
                }],
                body: Vec::new(),
            },
            result: None,
        },
    ))
}
