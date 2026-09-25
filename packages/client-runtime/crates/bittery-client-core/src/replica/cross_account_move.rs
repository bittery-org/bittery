//! Durable semantic Move evidence. Children are real requests, never independently scheduled work.
use super::*;
#[path = "cross_account_move_attachments.rs"]
mod attachments;
pub(crate) use attachments::attachment_registration_matches;

pub(super) fn validate_cross_account_identity(
    identity: &CrossAccountMoveIdentity,
) -> Result<(), RuntimeError> {
    let url = url::Url::parse(&identity.server_url)
        .map_err(|_| replica_invariant("Cross-Account Move Server identity is invalid"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str().trim_end_matches('/') != identity.server_url
        || identity.user_id.is_empty()
    {
        return Err(replica_invariant(
            "Cross-Account Move identity is not canonical",
        ));
    }
    Ok(())
}

/// Exact original outcomes supplied by explicit remote-completion verification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyCrossAccountCompletionProof {
    pub target_create: ObservedOutcome,
    pub source_trash: ObservedOutcome,
    pub source_delete: ObservedOutcome,
}

crate::wire::map_only_serde!(LegacyCrossAccountCompletionProof);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CrossAccountMoveRecord {
    pub operation_id: String,
    pub source_identity: CrossAccountMoveIdentity,
    pub destination_identity: CrossAccountMoveIdentity,
    pub source: AuthorityItemRecord,
    pub target: AuthorityItemRecord,
    pub destination_binding: CrossAccountMoveDestinationBinding,
    pub attachments: Vec<CrossAccountMoveAttachmentCheckpoint>,
    pub children: Vec<CrossAccountMoveChild>,
    pub stage: CrossAccountMoveStage,
    pub disposition: CrossAccountMoveDisposition,
    pub scheduling: OperationSchedulingState,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "legacy_admission::present"
    )]
    pub legacy_admission: Option<Box<LegacyCrossAccountMoveAdmission>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CrossAccountMoveIdentity {
    pub server_url: String,
    pub user_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CrossAccountMoveDestinationBinding {
    pub account_id: AccountId,
    pub incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    pub binding_revision: u64,
    pub status: CrossAccountMoveBindingStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CrossAccountMoveBindingStatus {
    Active,
    Retired,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CrossAccountMoveStage {
    TargetCreate,
    Attachments { next_index: u32 },
    SourceTrash,
    SourceDelete,
    Completed,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CrossAccountMoveDisposition {
    Ready,
    Waiting {
        reason: CrossAccountMoveWaitingReason,
    },
    Blocked {
        reason: CrossAccountMoveBlockedReason,
    },
    Rejected {
        code: OperationRejectionCode,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CrossAccountMoveWaitingReason {
    AccountLocked,
    Offline,
    PolicyVerificationPending,
    AttachmentAccessDenied,
    AttachmentQuotaExceeded,
    AttachmentSizeRejected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CrossAccountMoveBlockedReason {
    DestinationRetired,
    SourceChanged,
    TargetChanged,
    MissingProof,
    MissingArtifact,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CrossAccountMoveAttachmentCheckpoint {
    pub source_attachment_id: String,
    pub target_attachment_id: String,
    pub target_metadata: PreparedMoveAttachment,
    pub progress: CrossAccountMoveAttachmentProgress,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CrossAccountMoveAttachmentProgress {
    Pending,
    Encrypted {
        artifact: AttachmentMoveArtifactRef,
        grant_request: ImmutableHttpRequest,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum CrossAccountMoveChild {
    ItemOperation(CrossAccountMoveItemOperation),
    AttachmentRegistration(CrossAccountMoveAttachmentRegistration),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CrossAccountMoveItemOperation {
    pub step: CrossAccountMoveStep,
    pub endpoint: CrossAccountMoveEndpoint,
    pub operation_id: String,
    pub kind: OperationKind,
    pub target: ResourceRef,
    pub request: ImmutableHttpRequest,
    pub request_fingerprint: Sha256Fingerprint,
    pub result: Option<ObservedOutcome>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CrossAccountMoveAttachmentRegistration {
    pub source_attachment_id: String,
    pub request: ImmutableHttpRequest,
    pub request_fingerprint: Sha256Fingerprint,
    pub result: Option<CrossAccountMoveAttachmentEvidence>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CrossAccountMoveAttachmentEvidence {
    Acknowledged {
        attachment_id: String,
    },
    VerifiedPresent {
        attachment: Box<AuthorityAttachmentRecord>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CrossAccountMoveStep {
    TargetCreate,
    SourceTrash,
    SourceDelete,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CrossAccountMoveEndpoint {
    Source,
    Destination,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CrossAccountMoveSourceAuthority {
    Unchanged,
    Absent,
}

impl CrossAccountMoveChild {
    pub(crate) fn item(&self) -> Option<&CrossAccountMoveItemOperation> {
        match self {
            Self::ItemOperation(item) => Some(item),
            Self::AttachmentRegistration(_) => None,
        }
    }

    pub(crate) fn item_mut(&mut self) -> Option<&mut CrossAccountMoveItemOperation> {
        match self {
            Self::ItemOperation(item) => Some(item),
            Self::AttachmentRegistration(_) => None,
        }
    }

    pub(crate) fn proved(&self) -> bool {
        match self {
            Self::ItemOperation(item) => item.result.as_ref().is_some_and(|result| {
                matches!(result.result, OperationOutcomeResult::Applied { .. })
            }),
            Self::AttachmentRegistration(registration) => registration.result.is_some(),
        }
    }
}

impl CrossAccountMoveItemOperation {
    /// This temporary adapter represents only this child's actual HTTP request.
    pub(crate) fn to_operation(&self) -> Result<OperationRecord, RuntimeError> {
        let operation = OperationRecord {
            operation_id: self.operation_id.clone(),
            kind: self.kind,
            target: self.target.clone(),
            request: self.request.clone(),
            request_fingerprint: self.request_fingerprint,
            accepted_item_category: None,
            attachment_move_recovery: None,
            create_vault: None,
            update_vault: None,
            scheduling: OperationSchedulingState::default(),
            legacy_admission: None,
        };
        check_immutable_request(&operation)?;
        Ok(operation)
    }
}

pub(crate) fn cross_account_item_matches(
    current: &AuthorityItemRecord,
    expected: &AuthorityItemRecord,
    trashed: bool,
) -> bool {
    cross_account_item_metadata_matches(current, expected, trashed)
        && current.attachments == expected.attachments
}

pub(crate) fn cross_account_item_metadata_matches(
    current: &AuthorityItemRecord,
    expected: &AuthorityItemRecord,
    trashed: bool,
) -> bool {
    current.id == expected.id
        && current.vault_id == expected.vault_id
        && current.category == expected.category
        && current.encrypted_data == expected.encrypted_data
        && current.encryption_iv == expected.encryption_iv
        && current.encryption_algorithm == expected.encryption_algorithm
        && current.encryption_version == expected.encryption_version
        && current.encrypted_by_user_id == expected.encrypted_by_user_id
        && current.favorite == expected.favorite
        && current.version == expected.version + i32::from(trashed)
        && (if trashed {
            current.deleted_at.is_some()
        } else {
            current.deleted_at == expected.deleted_at
        })
}

enum DestinationReauthorization {
    Continue(Vec<AuthorityAttachmentRecord>),
    FromTrashedCache(Box<AuthorityItemRecord>),
    Complete(Box<LegacyCrossAccountCompletionProof>),
}

impl CrossAccountMoveRecord {
    pub(crate) fn is_legacy_held(&self) -> bool {
        self.legacy_admission
            .as_ref()
            .is_some_and(|admission| admission.disposition.is_held())
    }

    /// Supported first authorization shapes within an already-validated durable workflow.
    pub(crate) fn supports_legacy_held_destination_reauthorization(&self) -> bool {
        if !self.is_legacy_held() || !self.attachments.is_empty() {
            return false;
        }
        match self.stage {
            CrossAccountMoveStage::TargetCreate => {
                self.children.len() == 1 && self.children[0].item().is_some()
            }
            CrossAccountMoveStage::SourceTrash => {
                self.child_applied(0)
                    && match self.children.as_slice() {
                        [CrossAccountMoveChild::ItemOperation(_)] => true,
                        [CrossAccountMoveChild::ItemOperation(_), CrossAccountMoveChild::ItemOperation(trash)] => {
                            trash.step == CrossAccountMoveStep::SourceTrash
                                && trash.result.is_none()
                        }
                        _ => false,
                    }
            }
            CrossAccountMoveStage::SourceDelete => {
                self.child_applied(0)
                    && self.child_applied(1)
                    && match self.children.as_slice() {
                        [CrossAccountMoveChild::ItemOperation(_), CrossAccountMoveChild::ItemOperation(_)] => {
                            true
                        }
                        [CrossAccountMoveChild::ItemOperation(_), CrossAccountMoveChild::ItemOperation(_), CrossAccountMoveChild::ItemOperation(delete)] => {
                            delete.step == CrossAccountMoveStep::SourceDelete
                                && delete.result.is_none()
                        }
                        _ => false,
                    }
            }
            _ => false,
        }
    }

    /// Only reachable original held Item prefixes may supply full completion candidates.
    pub(crate) fn supports_legacy_held_destination_completion(&self) -> bool {
        if !self.is_legacy_held() || !self.attachments.is_empty() {
            return false;
        }
        match self.stage {
            CrossAccountMoveStage::TargetCreate => matches!(self.children.as_slice(),
                [CrossAccountMoveChild::ItemOperation(create)] if create.result.is_none()),
            CrossAccountMoveStage::SourceTrash => {
                self.child_applied(0)
                    && match self.children.as_slice() {
                        [CrossAccountMoveChild::ItemOperation(_)] => true,
                        [CrossAccountMoveChild::ItemOperation(_), CrossAccountMoveChild::ItemOperation(trash)] => {
                            trash.step == CrossAccountMoveStep::SourceTrash
                                && trash.result.is_none()
                        }
                        _ => false,
                    }
            }
            CrossAccountMoveStage::SourceDelete => {
                self.child_applied(0)
                    && self.child_applied(1)
                    && match self.children.as_slice() {
                        [CrossAccountMoveChild::ItemOperation(_), CrossAccountMoveChild::ItemOperation(_)] => {
                            true
                        }
                        [CrossAccountMoveChild::ItemOperation(_), CrossAccountMoveChild::ItemOperation(_), CrossAccountMoveChild::ItemOperation(delete)] => {
                            delete.step == CrossAccountMoveStep::SourceDelete
                                && delete.result.as_ref().is_none_or(|outcome| {
                                    matches!(outcome.result, OperationOutcomeResult::Applied { .. })
                                })
                        }
                        _ => false,
                    }
            }
            _ => false,
        }
    }

    /// Derive the closed original request set and retain only matching durable prefix evidence.
    pub(crate) fn legacy_completion_candidates(
        &self,
    ) -> Result<[CrossAccountMoveItemOperation; 3], RuntimeError> {
        if !self.supports_legacy_held_destination_completion() {
            return Err(replica_invariant(
                "Legacy completion has no supported original Item prefix",
            ));
        }
        let derive = |step| match self.legacy_item_child(step)? {
            Some(CrossAccountMoveChild::ItemOperation(child)) => Ok(child),
            _ => Err(replica_invariant(
                "Legacy completion requires its fixed original Item request",
            )),
        };
        let mut candidates = [
            derive(CrossAccountMoveStep::TargetCreate)?,
            derive(CrossAccountMoveStep::SourceTrash)?,
            derive(CrossAccountMoveStep::SourceDelete)?,
        ];
        for (index, candidate) in candidates.iter_mut().enumerate() {
            if let Some(existing) = self.children.get(index) {
                let existing = existing.item().ok_or_else(|| {
                    replica_invariant("Legacy completion cannot invent Attachment history")
                })?;
                candidate.result = existing.result.clone();
                if &*candidate != existing {
                    return Err(replica_invariant(
                        "Legacy completion prefix changed its original identity or bytes",
                    ));
                }
            }
            self.validate_child(index, candidate)?;
        }
        Ok(candidates)
    }

    pub(crate) fn source_overlay(&self, account_id: &AccountId) -> ReplicaItemRecord {
        ReplicaItemRecord {
            account_id: account_id.clone(),
            item_id: self.source.id.clone(),
            vault_id: self.source.vault_id.clone(),
            operation_id: self.operation_id.clone(),
            category: self.source.category.clone(),
            encrypted_data: self.source.encrypted_data.clone(),
            encryption_iv: self.source.encryption_iv.clone(),
            encryption_algorithm: self.source.encryption_algorithm.clone(),
            encryption_version: self.source.encryption_version,
            encrypted_by_user_id: self.source.encrypted_by_user_id.clone(),
            favorite: self.source.favorite,
            version: self.source.version,
            created_at: self.source.created_at.clone(),
            updated_at: self.source.updated_at.clone(),
            deleted_at: self.source.deleted_at.clone(),
            attachments: self.source.attachments.clone(),
            permanently_deleted: false,
        }
    }

    pub(super) fn validate_source_overlay(
        &self,
        account_id: &AccountId,
        overlay: &ReplicaItemRecord,
    ) -> Result<(), RuntimeError> {
        if self.is_legacy_held()
            || self.stage == CrossAccountMoveStage::Completed
            || *overlay != self.source_overlay(account_id)
        {
            return Err(replica_invariant(
                "Cross-Account Move must retain its accepted source overlay",
            ));
        }
        Ok(())
    }

    pub(crate) fn owns_source_item(&self) -> bool {
        !self.is_legacy_held()
            && !matches!(
                self.stage,
                CrossAccountMoveStage::Completed | CrossAccountMoveStage::Rejected
            )
    }

    pub(crate) fn validate(
        &self,
        source_account_id: &AccountId,
        source_user_id: &str,
    ) -> Result<(), RuntimeError> {
        validate_cross_account_identity(&self.source_identity)?;
        validate_cross_account_identity(&self.destination_identity)?;
        if self.operation_id.is_empty()
            || self.source_identity.user_id != source_user_id
            || self.source_identity == self.destination_identity
            || self.destination_binding.account_id == *source_account_id
            || self.destination_binding.account_id.as_str().is_empty()
            || self.destination_binding.incarnation.as_str().is_empty()
            || self.source.id.is_empty()
            || self.source.vault_id.is_empty()
            || self.target.id.is_empty()
            || self.target.vault_id.is_empty()
            || self.source.id == self.target.id
            || self.source.category != self.target.category
            || self.source.version < 1
            || self.source.version.checked_add(2).is_none()
            || self.source.deleted_at.is_some()
            || self.target.version != 1
            || self.target.favorite
            || self.target.deleted_at.is_some()
            || self.target.encrypted_by_user_id != self.destination_identity.user_id
            || self.source.encrypted_data.is_empty()
            || self.source.encryption_iv.is_empty()
            || self.target.encrypted_data.is_empty()
            || self.target.encryption_iv.is_empty()
            || self.target.encryption_version != 1
            || self.source.encryption_version < 1
        {
            return Err(replica_invariant(
                "Cross-Account Move accepted baseline is inconsistent",
            ));
        }
        if let Some(admission) = &self.legacy_admission {
            admission.validate(source_account_id, self)?;
        }
        self.validate_attachments(source_account_id)?;
        let attachment_count = self.attachments.len();
        let mut ids = HashSet::from([self.operation_id.as_str()]);
        if self.children.is_empty() || self.children.len() > attachment_count + 3 {
            return Err(replica_invariant(
                "Cross-Account Move child prefix is invalid",
            ));
        }
        for (index, child) in self.children.iter().enumerate() {
            match child {
                CrossAccountMoveChild::ItemOperation(item) => {
                    if !ids.insert(item.operation_id.as_str()) {
                        return Err(replica_invariant(
                            "Cross-Account Move child identity was reused",
                        ));
                    }
                    let item_index = if index == 0 {
                        0
                    } else if index == attachment_count + 1 {
                        1
                    } else if index == attachment_count + 2 {
                        2
                    } else {
                        return Err(replica_invariant(
                            "Move Item child appeared inside Attachment preparation",
                        ));
                    };
                    self.validate_child(item_index, item)?;
                }
                CrossAccountMoveChild::AttachmentRegistration(registration) => {
                    if index == 0 || index > attachment_count {
                        return Err(replica_invariant(
                            "Move registration appeared outside its fixed prefix",
                        ));
                    }
                    self.validate_registration(index - 1, registration)?;
                }
            }
            if index > 0 && !self.child_applied(index - 1) {
                return Err(replica_invariant(
                    "Cross-Account Move child has no preceding proof",
                ));
            }
        }
        let child_rejected = self
            .children
            .last()
            .and_then(CrossAccountMoveChild::item)
            .is_some_and(|child| {
                matches!(
                    child.result.as_ref().map(|r| &r.result),
                    Some(OperationOutcomeResult::Rejected { .. })
                )
            });
        let all_attachments_proved = self.child_applied(0)
            && (0..attachment_count).all(|index| {
                self.registration(index)
                    .is_some_and(|registration| registration.result.is_some())
            });
        let valid_stage = match self.stage {
            CrossAccountMoveStage::TargetCreate => {
                self.children.len() == 1
                    && self.attachments.iter().all(|checkpoint| {
                        matches!(
                            checkpoint.progress,
                            CrossAccountMoveAttachmentProgress::Pending
                        )
                    })
            }
            CrossAccountMoveStage::Attachments { next_index } => {
                let next_index = next_index as usize;
                next_index < attachment_count
                    && self.child_applied(next_index)
                    && (next_index + 1..=next_index + 2).contains(&self.children.len())
                    && self
                        .attachments
                        .iter()
                        .skip(next_index + 1)
                        .all(|checkpoint| {
                            matches!(
                                checkpoint.progress,
                                CrossAccountMoveAttachmentProgress::Pending
                            )
                        })
            }
            CrossAccountMoveStage::SourceTrash => {
                (attachment_count + 1..=attachment_count + 2).contains(&self.children.len())
                    && all_attachments_proved
            }
            CrossAccountMoveStage::SourceDelete => {
                (attachment_count + 2..=attachment_count + 3).contains(&self.children.len())
                    && self.child_applied(attachment_count + 1)
            }
            CrossAccountMoveStage::Completed => {
                self.children.len() == attachment_count + 3
                    && self.child_applied(attachment_count + 2)
            }
            CrossAccountMoveStage::Rejected => child_rejected,
        };
        if !valid_stage
            || (child_rejected && self.stage != CrossAccountMoveStage::Rejected)
            || (self.stage == CrossAccountMoveStage::Rejected)
                != matches!(
                    self.disposition,
                    CrossAccountMoveDisposition::Rejected { .. }
                )
        {
            return Err(replica_invariant(
                "Cross-Account Move stage has no exact child proof",
            ));
        }
        let terminal = matches!(
            self.stage,
            CrossAccountMoveStage::Completed | CrossAccountMoveStage::Rejected
        );
        if (self.stage == CrossAccountMoveStage::Completed
            && self.disposition != CrossAccountMoveDisposition::Ready)
            || (!terminal
                && self.destination_binding.status == CrossAccountMoveBindingStatus::Retired
                && self.disposition
                    != (CrossAccountMoveDisposition::Blocked {
                        reason: CrossAccountMoveBlockedReason::DestinationRetired,
                    }))
        {
            return Err(replica_invariant(
                "Cross-Account Move disposition contradicts its stage or destination binding",
            ));
        }
        if let CrossAccountMoveDisposition::Rejected { code } = self.disposition {
            if self
                .children
                .last()
                .and_then(CrossAccountMoveChild::item)
                .and_then(|child| child.result.as_ref())
                .map(|result| &result.result)
                != Some(&OperationOutcomeResult::Rejected { code })
            {
                return Err(replica_invariant(
                    "Cross-Account Move rejection differs from its child",
                ));
            }
        }
        Ok(())
    }

    fn child_applied(&self, index: usize) -> bool {
        self.children
            .get(index)
            .is_some_and(CrossAccountMoveChild::proved)
    }

    fn validate_child(
        &self,
        index: usize,
        child: &CrossAccountMoveItemOperation,
    ) -> Result<(), RuntimeError> {
        verify_item_request_path(&child.to_operation()?, self.legacy_admission.is_some())?;
        let (step, endpoint, kind, item, version) = match index {
            0 => (
                CrossAccountMoveStep::TargetCreate,
                CrossAccountMoveEndpoint::Destination,
                OperationKind::CreateItem,
                &self.target,
                1,
            ),
            1 => (
                CrossAccountMoveStep::SourceTrash,
                CrossAccountMoveEndpoint::Source,
                OperationKind::TrashItem,
                &self.source,
                self.source.version.checked_add(1).ok_or_else(|| {
                    replica_invariant("Cross-Account Move source version overflowed")
                })?,
            ),
            2 => (
                CrossAccountMoveStep::SourceDelete,
                CrossAccountMoveEndpoint::Source,
                OperationKind::PermanentlyDeleteItem,
                &self.source,
                self.source.version.checked_add(2).ok_or_else(|| {
                    replica_invariant("Cross-Account Move source version overflowed")
                })?,
            ),
            _ => {
                return Err(replica_invariant(
                    "Cross-Account Move child step is invalid",
                ));
            }
        };
        if child.step != step
            || child.endpoint != endpoint
            || child.kind != kind
            || child.target
                != (ResourceRef::Item {
                    item_id: item.id.clone(),
                    vault_id: item.vault_id.clone(),
                })
        {
            return Err(replica_invariant(
                "Cross-Account Move child address differs from accepted intent",
            ));
        }
        if index == 0 {
            let body: crate::server_contract::CreateItemBody =
                serde_json::from_slice(&child.request.body).map_err(|_| {
                    replica_invariant("Cross-Account Move target request is not a closed Create")
                })?;
            if AuthorityItemCategory::from(body.category) != self.target.category
                || body.encrypted_data != self.target.encrypted_data
                || body.encryption_iv != self.target.encryption_iv
                || body.encryption_algorithm != self.target.encryption_algorithm
            {
                return Err(replica_invariant(
                    "Cross-Account Move target request differs from accepted ciphertext",
                ));
            }
        } else if !child.request.body.is_empty()
            || child.request.headers
                != [HttpHeader {
                    name: "If-Match".into(),
                    value: format!("\"{}\"", version - 1),
                }]
        {
            return Err(replica_invariant(
                "Cross-Account Move source request changed its accepted version",
            ));
        }
        if let Some(result) = &child.result {
            if result.operation_id != child.operation_id
                || result.request_fingerprint != child.request_fingerprint
            {
                return Err(replica_invariant(
                    "Cross-Account Move child result identity differs",
                ));
            }
            match &result.result {
                OperationOutcomeResult::Applied {
                    entity_id,
                    version: actual,
                } if entity_id == &item.id && *actual == version => {}
                OperationOutcomeResult::Rejected { code }
                    if receipt_rejection_allowed(kind, *code) => {}
                _ => {
                    return Err(replica_invariant(
                        "Cross-Account Move child result has no exact semantic proof",
                    ));
                }
            }
        }
        Ok(())
    }
}

impl ReplicaSnapshot {
    pub(crate) fn cross_account_move_has_conflicting_source_owner(
        &self,
        record: &CrossAccountMoveRecord,
    ) -> bool {
        let item_id = &record.source.id;
        self.operations.iter().any(|operation| {
            !operation.is_legacy_held() && operation.target.item_id() == Some(item_id.as_str())
        }) || self
            .attachment_move_preparations
            .iter()
            .any(|preparation| preparation.item_id == *item_id)
            || self.cross_account_moves.iter().any(|other| {
                other.operation_id() != record.operation_id
                    && other.owns_source_item()
                    && other.source_item_id() == item_id.as_str()
            })
            || self.items.iter().any(|overlay| {
                overlay.item_id == *item_id
                    && (record.is_legacy_held()
                        || overlay.operation_id != record.operation_id
                        || *overlay != record.source_overlay(&self.account_id))
            })
    }
}

impl AccountReplica {
    /// Fresh present authority releases a rejected Move's failed overlay. The retained workflow
    /// still proves the rejection; absence or authority older than a proved source step cannot
    /// discard the accepted source ciphertext.
    pub(in crate::replica) fn reconcile_rejected_move_source(
        &mut self,
        item_id: &str,
        version: i32,
    ) {
        let Some(record) = self
            .items
            .get(item_id)
            .and_then(|overlay| self.cross_account_moves.get(&overlay.operation_id))
            .and_then(CrossAccountMoveEntry::captured)
            .filter(|record| record.stage == CrossAccountMoveStage::Rejected)
        else {
            return;
        };
        let proved_version = record
            .children
            .iter()
            .filter_map(CrossAccountMoveChild::item)
            .filter(|child| child.endpoint == CrossAccountMoveEndpoint::Source)
            .filter_map(|child| match &child.result.as_ref()?.result {
                OperationOutcomeResult::Applied { version, .. } => Some(*version),
                _ => None,
            })
            .fold(record.source.version, i32::max);
        if record.source.id == item_id && version >= proved_version {
            self.items.remove(item_id);
        }
    }

    pub(super) fn admit_cross_account_move(
        &mut self,
        record: CrossAccountMoveRecord,
        overlay: Option<ReplicaItemRecord>,
    ) -> Result<(), RuntimeError> {
        record.validate(&self.account_id, &self.user_id)?;
        let initial_scheduling = record
            .legacy_admission
            .as_ref()
            .map(|admission| admission.initial_scheduling())
            .unwrap_or_default();
        if record.stage != CrossAccountMoveStage::TargetCreate
            || record.children[0]
                .item()
                .is_none_or(|item| item.result.is_some())
            || record.destination_binding.status != CrossAccountMoveBindingStatus::Active
            || record.destination_binding.binding_revision != 0
            || record.disposition != CrossAccountMoveDisposition::Ready
            || record.scheduling != initial_scheduling
            || self
                .bootstrap
                .pending_vault_retirements
                .contains(&record.source.vault_id)
            || (!record.is_legacy_held()
                && self.snapshot().item_has_optimistic_owner(&record.source.id))
            || self.operations.contains_key(&record.operation_id)
            || self
                .attachment_move_preparations
                .contains_key(&record.operation_id)
            || self.receipts.contains_key(&record.operation_id)
            || self.cross_account_moves.contains_key(&record.operation_id)
        {
            return Err(replica_invariant(
                "Cross-Account Move admission conflicts with accepted work",
            ));
        }
        if self.bootstrap.state != ReplicaState::Ready
            || !self
                .bootstrap
                .active_generation
                .as_ref()
                .and_then(|generation| {
                    self.bootstrap
                        .items
                        .get(&(generation.clone(), record.source.id.clone()))
                })
                .is_some_and(|item| item == &record.source)
        {
            return Err(replica_invariant(
                "Cross-Account Move admission has no exact current source authority",
            ));
        }
        if record.is_legacy_held() != overlay.is_none() {
            return Err(replica_invariant(
                "Cross-Account Move overlay disagrees with its admission disposition",
            ));
        }
        if let Some(overlay) = &overlay {
            self.check_item_scope(overlay)?;
            record.validate_source_overlay(&self.account_id, overlay)?;
        }
        self.cross_account_moves
            .insert(record.operation_id.clone(), record.into());
        if let Some(overlay) = overlay {
            self.items.insert(overlay.item_id.clone(), overlay);
        }
        Ok(())
    }

    pub(super) fn advance_cross_account_move(
        &mut self,
        operation_id: String,
        revision: u64,
        next: CrossAccountMoveRecord,
        authority: CrossAccountMoveSourceAuthority,
    ) -> Result<(), RuntimeError> {
        let previous = self
            .cross_account_moves
            .get(&operation_id)
            .and_then(CrossAccountMoveEntry::captured)
            .ok_or_else(|| replica_invariant("Cross-Account Move is unknown"))?;
        next.validate(&self.account_id, &self.user_id)?;
        if previous.destination_binding.binding_revision != revision
            || previous.operation_id != next.operation_id
            || previous.source_identity != next.source_identity
            || previous.destination_identity != next.destination_identity
            || previous.source != next.source
            || previous.target != next.target
            || previous.legacy_admission != next.legacy_admission
            || previous.destination_binding != next.destination_binding
            || previous.children.len() > next.children.len()
            || next.children.len() > previous.children.len() + 1
            || previous.stage == CrossAccountMoveStage::Completed
            || previous.stage == CrossAccountMoveStage::Rejected
        {
            return Err(replica_invariant(
                "Cross-Account Move advance changed immutable accepted intent",
            ));
        }
        previous.validate_attachment_advance(&next)?;
        if let Some(appended) = next.children.get(previous.children.len()) {
            let preparation_matches = previous.stage == next.stage
                && match (&previous.stage, appended) {
                    (
                        CrossAccountMoveStage::SourceTrash,
                        CrossAccountMoveChild::ItemOperation(item),
                    ) => item.step == CrossAccountMoveStep::SourceTrash && item.result.is_none(),
                    (
                        CrossAccountMoveStage::SourceDelete,
                        CrossAccountMoveChild::ItemOperation(item),
                    ) => item.step == CrossAccountMoveStep::SourceDelete && item.result.is_none(),
                    (
                        CrossAccountMoveStage::Attachments { next_index },
                        CrossAccountMoveChild::AttachmentRegistration(registration),
                    ) => {
                        previous
                            .attachments
                            .get(*next_index as usize)
                            .is_some_and(|checkpoint| {
                                checkpoint.source_attachment_id == registration.source_attachment_id
                                    && matches!(
                                        checkpoint.progress,
                                        CrossAccountMoveAttachmentProgress::Encrypted { .. }
                                    )
                            })
                            && registration.result.is_none()
                    }
                    _ => false,
                };
            if !preparation_matches {
                return Err(replica_invariant(
                    "Cross-Account Move child must be prepared before observing its result",
                ));
            }
        }
        if next.scheduling.attempt_count < previous.scheduling.attempt_count {
            return Err(replica_invariant(
                "Cross-Account Move attempt count moved backwards",
            ));
        }
        for (old, new) in previous.children.iter().zip(&next.children) {
            let mut expected = old.clone();
            match (&mut expected, new) {
                (
                    CrossAccountMoveChild::ItemOperation(old),
                    CrossAccountMoveChild::ItemOperation(new),
                ) if old.result.is_none() => old.result = new.result.clone(),
                (
                    CrossAccountMoveChild::AttachmentRegistration(old),
                    CrossAccountMoveChild::AttachmentRegistration(new),
                ) if old.result.is_none() => old.result = new.result.clone(),
                _ => {}
            }
            if expected != *new {
                return Err(replica_invariant(
                    "Cross-Account Move child request or retained result changed",
                ));
            }
        }
        let legal_stage = previous.stage == next.stage
            || match (&previous.stage, &next.stage) {
                (CrossAccountMoveStage::TargetCreate, CrossAccountMoveStage::SourceTrash) => {
                    previous.attachments.is_empty()
                }
                (
                    CrossAccountMoveStage::TargetCreate,
                    CrossAccountMoveStage::Attachments { next_index: 0 },
                ) => !previous.attachments.is_empty(),
                (
                    CrossAccountMoveStage::Attachments { next_index: old },
                    CrossAccountMoveStage::Attachments { next_index: new },
                ) => old.checked_add(1) == Some(*new),
                (
                    CrossAccountMoveStage::Attachments { next_index },
                    CrossAccountMoveStage::SourceTrash,
                ) => *next_index as usize + 1 == previous.attachments.len(),
                (CrossAccountMoveStage::SourceTrash, CrossAccountMoveStage::SourceDelete)
                | (CrossAccountMoveStage::SourceDelete, CrossAccountMoveStage::Completed)
                | (_, CrossAccountMoveStage::Rejected) => true,
                _ => false,
            };
        if !legal_stage
            || (previous.destination_binding.status == CrossAccountMoveBindingStatus::Retired
                && (previous.children != next.children
                    || previous.stage != next.stage
                    || previous.attachments != next.attachments))
        {
            return Err(replica_invariant(
                "Cross-Account Move advanced outside its current proven stage or binding",
            ));
        }
        let completed = next.stage == CrossAccountMoveStage::Completed;
        if completed != (authority == CrossAccountMoveSourceAuthority::Absent) {
            return Err(replica_invariant(
                "Cross-Account Move completion needs current source absence",
            ));
        }
        if completed {
            self.complete_cross_account_move_source(&next)?;
        }
        self.cross_account_moves.insert(operation_id, next.into());
        Ok(())
    }

    fn complete_cross_account_move_source(
        &mut self,
        record: &CrossAccountMoveRecord,
    ) -> Result<(), RuntimeError> {
        self.remove_authoritative_item(&record.source.id)?;
        self.items
            .retain(|_, item| item.operation_id != record.operation_id);
        Ok(())
    }

    pub(super) fn retire_cross_account_move_destination(
        &mut self,
        operation_id: &str,
        revision: u64,
        account_id: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<(), RuntimeError> {
        let record = self
            .cross_account_moves
            .get_mut(operation_id)
            .ok_or_else(|| replica_invariant("Cross-Account Move is unknown"))?;
        record.retire_destination(revision, account_id, incarnation)
    }

    pub(super) fn reauthorize_cross_account_move_destination(
        &mut self,
        operation_id: &str,
        revision: u64,
        account_id: AccountId,
        incarnation: Incarnation,
        verified_attachments: Vec<AuthorityAttachmentRecord>,
    ) -> Result<(), RuntimeError> {
        self.apply_destination_reauthorization(
            operation_id,
            revision,
            account_id,
            incarnation,
            DestinationReauthorization::Continue(verified_attachments),
        )
    }

    pub(super) fn reauthorize_and_complete_legacy_cross_account_move(
        &mut self,
        operation_id: &str,
        revision: u64,
        account_id: AccountId,
        incarnation: Incarnation,
        verified_outcomes: Box<LegacyCrossAccountCompletionProof>,
    ) -> Result<(), RuntimeError> {
        self.apply_destination_reauthorization(
            operation_id,
            revision,
            account_id,
            incarnation,
            DestinationReauthorization::Complete(verified_outcomes),
        )
    }

    pub(super) fn reauthorize_legacy_cross_account_move_from_trashed_cache(
        &mut self,
        operation_id: &str,
        revision: u64,
        account_id: AccountId,
        incarnation: Incarnation,
        verified_source: Box<AuthorityItemRecord>,
    ) -> Result<(), RuntimeError> {
        self.apply_destination_reauthorization(
            operation_id,
            revision,
            account_id,
            incarnation,
            DestinationReauthorization::FromTrashedCache(verified_source),
        )
    }

    fn apply_destination_reauthorization(
        &mut self,
        operation_id: &str,
        revision: u64,
        account_id: AccountId,
        incarnation: Incarnation,
        mode: DestinationReauthorization,
    ) -> Result<(), RuntimeError> {
        let record = self
            .cross_account_moves
            .get(operation_id)
            .and_then(CrossAccountMoveEntry::captured)
            .ok_or_else(|| replica_invariant("Cross-Account Move is unknown"))?;
        let was_held = record.is_legacy_held();
        let prior_hold = record
            .legacy_admission
            .as_ref()
            .and_then(|admission| admission.disposition.prior_hold());
        let completing = matches!(&mode, DestinationReauthorization::Complete(_));
        let restores_overlay = was_held && matches!(&mode, DestinationReauthorization::Continue(_));
        let supported = match &mode {
            DestinationReauthorization::Continue(_) => {
                !was_held || record.supports_legacy_held_destination_reauthorization()
            }
            DestinationReauthorization::FromTrashedCache(_) => {
                record.stage == CrossAccountMoveStage::SourceDelete
                    && record.supports_legacy_held_destination_reauthorization()
            }
            DestinationReauthorization::Complete(_) => {
                record.supports_legacy_held_destination_completion()
            }
        };
        let cache_matches = match &mode {
            DestinationReauthorization::Continue(_) => {
                !was_held
                    || (self.bootstrap.state == ReplicaState::Ready
                        && self
                            .bootstrap
                            .active_generation
                            .as_ref()
                            .and_then(|generation| {
                                self.bootstrap
                                    .items
                                    .get(&(generation.clone(), record.source.id.clone()))
                            })
                            .is_some_and(|source| source == &record.source))
            }
            DestinationReauthorization::FromTrashedCache(verified_source) => {
                self.bootstrap.state == ReplicaState::Ready
                    && self.bootstrap.validate().is_ok()
                    && self
                        .bootstrap
                        .active_generation
                        .as_ref()
                        .and_then(|generation| {
                            self.bootstrap
                                .items
                                .get(&(generation.clone(), record.source.id.clone()))
                        })
                        == Some(verified_source.as_ref())
                    && cross_account_item_matches(verified_source, &record.source, true)
            }
            DestinationReauthorization::Complete(_) => {
                self.bootstrap.state == ReplicaState::Ready && self.bootstrap.validate().is_ok()
            }
        };
        if !supported
            || self
                .snapshot()
                .cross_account_move_has_conflicting_source_owner(record)
            || (prior_hold.is_some()
                && matches!(
                    record.stage,
                    CrossAccountMoveStage::Completed | CrossAccountMoveStage::Rejected
                ))
            || !cache_matches
        {
            return Err(replica_invariant(
                "Legacy Move authorization conflicts with its source ownership or accepted stage",
            ));
        }
        let mut record = record.clone();
        let binding = &mut record.destination_binding;
        if binding.binding_revision != revision
            || (prior_hold.is_some() && binding.binding_revision == 0)
            || binding.status != CrossAccountMoveBindingStatus::Retired
            || account_id.as_str().is_empty()
            || incarnation.as_str().is_empty()
            || account_id == self.account_id
        {
            return Err(replica_invariant(
                "Cross-Account Move reauthorization has no exact retired binding",
            ));
        }
        match mode {
            DestinationReauthorization::Continue(verified_attachments) => {
                let mut seen = HashSet::new();
                for attachment in verified_attachments {
                    if !seen.insert(attachment.id.clone()) {
                        return Err(replica_invariant(
                            "Move Resume received duplicate Attachment evidence",
                        ));
                    }
                    let index = record
                        .attachments
                        .iter()
                        .position(|checkpoint| checkpoint.target_attachment_id == attachment.id)
                        .ok_or_else(|| {
                            replica_invariant("Move Resume received an unknown target Attachment")
                        })?;
                    let Some(CrossAccountMoveChild::AttachmentRegistration(registration)) =
                        record.children.get_mut(index + 1)
                    else {
                        return Err(replica_invariant(
                            "Move Resume cannot prepare an undecided registration",
                        ));
                    };
                    if registration.result.is_some() {
                        return Err(replica_invariant(
                            "Move Resume cannot replace retained Attachment evidence",
                        ));
                    }
                    registration.result =
                        Some(CrossAccountMoveAttachmentEvidence::VerifiedPresent {
                            attachment: Box::new(attachment),
                        });
                }
            }
            // Full authority equality was checked before binding or accepted work can change.
            DestinationReauthorization::FromTrashedCache(_) => {}
            DestinationReauthorization::Complete(outcomes) => {
                let mut candidates = record.legacy_completion_candidates()?;
                let outcomes = [
                    outcomes.target_create,
                    outcomes.source_trash,
                    outcomes.source_delete,
                ];
                for (index, (candidate, outcome)) in candidates.iter_mut().zip(outcomes).enumerate()
                {
                    if !matches!(outcome.result, OperationOutcomeResult::Applied { .. })
                        || candidate
                            .result
                            .as_ref()
                            .is_some_and(|retained| retained != &outcome)
                    {
                        return Err(replica_invariant(
                            "Legacy completion cannot replace its original proof",
                        ));
                    }
                    candidate.result = Some(outcome);
                    record.validate_child(index, candidate)?;
                }
                record.children = candidates
                    .into_iter()
                    .map(CrossAccountMoveChild::ItemOperation)
                    .collect();
                record.stage = CrossAccountMoveStage::Completed;
                record.disposition = CrossAccountMoveDisposition::Ready;
            }
        }
        let binding = &mut record.destination_binding;
        binding.binding_revision = increment_revision(binding.binding_revision)?;
        binding.account_id = account_id;
        binding.incarnation = incarnation;
        binding.status = CrossAccountMoveBindingStatus::Active;
        if let Some(prior_hold) = prior_hold {
            record
                .legacy_admission
                .as_mut()
                .expect("prior hold has admission evidence")
                .disposition =
                LegacyWorkflowDisposition::DestinationReauthorized(LegacyWorkflowAuthorization {
                    prior_hold,
                    binding_revision: binding.binding_revision,
                });
        }
        if record.stage != CrossAccountMoveStage::Completed
            && record.stage != CrossAccountMoveStage::Rejected
        {
            record.disposition = CrossAccountMoveDisposition::Ready;
        }
        record.validate(&self.account_id, &self.user_id)?;
        if completing {
            self.complete_cross_account_move_source(&record)?;
        } else if restores_overlay {
            let overlay = record.source_overlay(&self.account_id);
            self.check_item_scope(&overlay)?;
            self.items.insert(overlay.item_id.clone(), overlay);
        }
        self.cross_account_moves
            .insert(operation_id.into(), record.into());
        Ok(())
    }
}
