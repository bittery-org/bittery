//! Bounded validation of stored rows for Account recovery. Payloads never become a second Replica.

use super::domain::*;
use super::persistence_contract::{
    composite_record_id, split_composite_record_id, BootstrapMetadataRecord, ReplicaHead,
    ReplicaStore, VaultRetirementMetadataRecord, BOOTSTRAP_METADATA_ID,
    VAULT_RETIREMENTS_METADATA_ID,
};
use crate::recovery::limits::exceeded;
use crate::{RecoveryBound, RuntimeError, RuntimeErrorCode};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const MAX_RECORD_BYTES: usize = 64 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;
const MAX_SUMMARY_BYTES: usize = 16 * 1024 * 1024;
const MAX_ARTIFACTS: usize = 4096;

#[derive(Clone, Debug)]
pub(crate) struct RecoveryRowHash {
    pub store: ReplicaStore,
    pub record_id: String,
    pub payload_sha256: [u8; 32],
    pub accepted: bool,
    /// Per-row validation only; cross-row authority consistency is proved separately.
    pub valid: bool,
}
#[derive(Clone, Debug)]
pub(crate) struct RequiredAttachment {
    pub operation_id: String,
    pub attachment_id: String,
    /// Pending preparation may retain a recoverable provisional generation; otherwise it
    /// still needs its original remote source. An encrypted checkpoint requires these bytes.
    pub artifact: Option<AttachmentMoveArtifactRef>,
}
#[derive(Clone, Debug)]
pub(crate) struct RequiredImage {
    pub operation_id: String,
    pub vault_id: String,
    pub image: CreateVaultImageRecord,
    /// Receipt cleanup tolerates already-deleted bytes after a lost cleanup acknowledgement.
    pub required_bytes: bool,
}
pub(crate) struct CoverageProof {
    pub head: ReplicaHead,
    pub rows: Vec<RecoveryRowHash>,
    pub operation_count: u32,
    pub preparation_count: u32,
    pub receipt_count: u32,
    pub required_attachments: Vec<RequiredAttachment>,
    pub required_images: Vec<RequiredImage>,
    pub authority_valid: bool,
    pub pending_vault_retirements: Vec<String>,
}
impl CoverageProof {
    pub(crate) fn accepted_rows(&self) -> impl Iterator<Item = &RecoveryRowHash> {
        self.rows.iter().filter(|row| row.accepted)
    }
}

#[derive(Clone, Copy)]
enum OverlayFingerprint {
    CrossAccount([u8; 32]),
    Legacy(Sha256Fingerprint),
}

struct WorkIdentity {
    source_evidence_unavailable: bool,
    category: Option<AuthorityItemCategory>,
    kind: Option<OperationKind>,
    active: bool,
    overlay_fingerprint: Option<OverlayFingerprint>,
    target: ResourceRef,
}
struct OverlayIdentity {
    payload_sha256: [u8; 32],
    legacy_fingerprint: Sha256Fingerprint,
    category: AuthorityItemCategory,
    item_id: String,
    vault_id: String,
    operation_id: String,
}

/// Each payload is decoded once, validated, and dropped. Only bounded identities, hashes,
/// Bootstrap control records and artifact requirements survive to the cross-row check.
/// An accepted-row error poisons the proof; malformed derived rows can only authorize an
/// explicit derived-authority rebuild after the independent accepted-work proof succeeds.
pub(crate) struct RecoveryCoverage {
    head: ReplicaHead,
    rows: Vec<RecoveryRowHash>,
    keys: HashSet<(ReplicaStore, String)>,
    work: HashMap<String, WorkIdentity>,
    child_operation_ids: HashSet<String>,
    receipts: HashMap<String, OperationReceiptRecord>,
    rotation_attempts: HashMap<String, RotationAttemptRecord>,
    overlays: Vec<OverlayIdentity>,
    capabilities: HashMap<String, Option<ShareAppliedResultRecord>>,
    bootstrap: BootstrapAuthority,
    saw_metadata: bool,
    authority_generations: HashSet<BootstrapGenerationId>,
    authority_vault_ids: HashSet<String>,
    required_attachments: Vec<RequiredAttachment>,
    required_images: Vec<RequiredImage>,
    preparation_count: u32,
    summary_bytes: usize,
    authority_valid: bool,
    failed: bool,
}
impl RecoveryCoverage {
    pub(crate) fn new(head: ReplicaHead) -> Result<Self, RuntimeError> {
        if head.account_id.as_str().is_empty()
            || head.user_id.is_empty()
            || head.incarnation.as_str().is_empty()
        {
            return Err(invalid("Recovery head identity is incomplete"));
        }
        let mut value = Self {
            head,
            rows: Vec::new(),
            keys: HashSet::new(),
            work: HashMap::new(),
            child_operation_ids: HashSet::new(),
            receipts: HashMap::new(),
            rotation_attempts: HashMap::new(),
            overlays: Vec::new(),
            capabilities: HashMap::new(),
            bootstrap: BootstrapAuthority::default(),
            saw_metadata: false,
            authority_generations: HashSet::new(),
            authority_vault_ids: HashSet::new(),
            required_attachments: Vec::new(),
            required_images: Vec::new(),
            preparation_count: 0,
            summary_bytes: 0,
            authority_valid: true,
            failed: false,
        };
        value.reserve_summary(
            value.head.account_id.as_str().len()
                + value.head.user_id.len()
                + value.head.incarnation.as_str().len(),
        )?;
        Ok(value)
    }
    pub(crate) fn push_row(
        &mut self,
        store: ReplicaStore,
        record_id: &str,
        payload_json: &str,
    ) -> Result<(), RuntimeError> {
        if self.failed {
            return Err(invalid("Recovery accepted-work coverage is unavailable"));
        }
        let result = self.push(store, record_id, payload_json);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn push(
        &mut self,
        store: ReplicaStore,
        record_id: &str,
        payload: &str,
    ) -> Result<(), RuntimeError> {
        if payload.len() > MAX_RECORD_BYTES {
            return Err(exceeded(RecoveryBound::RecordBytes));
        }
        if self.rows.len() >= MAX_ROWS {
            return Err(exceeded(RecoveryBound::RecordCount));
        }
        self.reserve_summary(record_id.len().saturating_mul(2).saturating_add(256))?;
        if !self.keys.insert((store, record_id.to_owned())) {
            return Err(invalid("Recovery row identity is duplicated"));
        }
        let accepted = matches!(
            store,
            ReplicaStore::Operations
                | ReplicaStore::CrossAccountMoves
                | ReplicaStore::OptimisticItems
                | ReplicaStore::AttachmentMovePreparations
                | ReplicaStore::OperationReceipts
                | ReplicaStore::RotationAttempts
                | ReplicaStore::ShareCapabilities
        ) || (store == ReplicaStore::ReplicaMetadata
            && record_id == VAULT_RETIREMENTS_METADATA_ID);
        let row_index = self.rows.len();
        self.rows.push(RecoveryRowHash {
            store,
            record_id: record_id.to_owned(),
            payload_sha256: Sha256::digest(payload.as_bytes()).into(),
            accepted,
            valid: true,
        });
        if accepted {
            self.accepted_row(store, record_id, payload)
        } else {
            match self.authority_row(store, record_id, payload) {
                Err(error) if error.code == RuntimeErrorCode::SizeRejected => return Err(error),
                Err(_) => {
                    self.rows[row_index].valid = false;
                    self.authority_valid = false;
                }
                Ok(()) => {}
            }
            Ok(())
        }
    }
    fn accepted_row(
        &mut self,
        store: ReplicaStore,
        record_id: &str,
        payload: &str,
    ) -> Result<(), RuntimeError> {
        match store {
            ReplicaStore::ReplicaMetadata => {
                let journal: VaultRetirementMetadataRecord = decode(payload)?;
                journal.validate()?;
                self.reserve_summary(payload.len())?;
                self.bootstrap.pending_vault_retirements = journal.vault_ids;
            }
            ReplicaStore::Operations => {
                let operation: OperationRecord = decode(payload)?;
                if operation.operation_id != record_id {
                    return Err(invalid("Operation row identity changed"));
                }
                verify_item_request(&operation)?;
                let mut account = self.validation_account();
                account.operations.insert(record_id.to_owned(), operation);
                account.validate_durable_work()?;
                let operation = account
                    .operations
                    .remove(record_id)
                    .expect("inserted operation");
                if let Some(recovery) = &operation.attachment_move_recovery {
                    let preparation = match recovery {
                        AttachmentMoveRecovery::Prepared { preparation }
                        | AttachmentMoveRecovery::RejectStaleAuthority { preparation } => {
                            preparation
                        }
                    };
                    self.attachments(preparation)?;
                }
                if let Some(image) = operation.vault_image() {
                    self.image(record_id, operation.vault_id(), image, true)?;
                }
                let overlay_fingerprint = operation
                    .legacy_admission
                    .as_ref()
                    .map(|admission| {
                        admission.expected_overlay_fingerprint(&self.head.account_id, &operation)
                    })
                    .transpose()?
                    .flatten()
                    .map(OverlayFingerprint::Legacy);
                let active = !operation.is_legacy_held();
                self.work_identity(
                    record_id,
                    operation.kind,
                    operation.target,
                    operation.accepted_item_category,
                    overlay_fingerprint,
                    active,
                )?;
            }
            ReplicaStore::CrossAccountMoves => {
                let entry: CrossAccountMoveEntry = decode(payload)?;
                if entry.operation_id() != record_id {
                    return Err(invalid("Cross-Account Move row identity changed"));
                }
                entry.validate(&self.head.account_id, &self.head.user_id)?;
                let captured = entry.captured();
                if let Some(record) =
                    captured.filter(|record| record.stage != CrossAccountMoveStage::Completed)
                {
                    for checkpoint in &record.attachments {
                        let artifact = match &checkpoint.progress {
                            CrossAccountMoveAttachmentProgress::Pending => None,
                            CrossAccountMoveAttachmentProgress::Encrypted { artifact, .. } => {
                                Some(artifact.clone())
                            }
                        };
                        self.attachment(
                            &record.operation_id,
                            &checkpoint.target_attachment_id,
                            artifact,
                        )?;
                    }
                }
                for operation_id in entry.reserved_child_operation_ids() {
                    self.reserve_summary(operation_id.len())?;
                    if !self.child_operation_ids.insert(operation_id) {
                        return Err(invalid(
                            "Cross-Account Move child identity overlaps another workflow",
                        ));
                    }
                }
                self.reserve_summary(
                    record_id.len() + entry.source_item_id().len() + entry.source_vault_id().len(),
                )?;
                let overlay_fingerprint = match captured {
                    Some(record)
                        if !record.is_legacy_held()
                            && record.stage != CrossAccountMoveStage::Completed =>
                    {
                        Some(OverlayFingerprint::CrossAccount(
                            Sha256::digest(
                                serde_json::to_vec(&record.source_overlay(&self.head.account_id))
                                    .map_err(|_| {
                                    invalid("Cross-Account Move overlay cannot be encoded")
                                })?,
                            )
                            .into(),
                        ))
                    }
                    _ => None,
                };
                if self
                    .work
                    .insert(
                        record_id.to_owned(),
                        WorkIdentity {
                            source_evidence_unavailable: entry.source_unavailable().is_some(),
                            kind: None,
                            active: entry.owns_source_item(),
                            overlay_fingerprint,
                            target: ResourceRef::Item {
                                item_id: entry.source_item_id().into(),
                                vault_id: entry.source_vault_id().into(),
                            },
                            category: captured.map(|record| record.source.category.clone()),
                        },
                    )
                    .is_some()
                {
                    return Err(invalid(
                        "Cross-Account Move semantic identity overlaps accepted work",
                    ));
                }
            }
            ReplicaStore::AttachmentMovePreparations => {
                let preparation: AttachmentMovePreparationRecord = decode(payload)?;
                if preparation.operation_id != record_id {
                    return Err(invalid("Preparation row identity changed"));
                }
                let mut account = self.validation_account();
                account
                    .attachment_move_preparations
                    .insert(record_id.to_owned(), preparation);
                account.validate_durable_work()?;
                let preparation = account
                    .attachment_move_preparations
                    .remove(record_id)
                    .expect("inserted preparation");
                self.attachments(&preparation)?;
                self.work_identity(
                    record_id,
                    OperationKind::MoveItem,
                    ResourceRef::Item {
                        item_id: preparation.item_id,
                        vault_id: preparation.target_vault_id,
                    },
                    preparation.accepted_item_category,
                    None,
                    true,
                )?;
                self.preparation_count += 1;
            }
            ReplicaStore::OperationReceipts => {
                let receipt: OperationReceiptRecord = decode(payload)?;
                if receipt.operation_id != record_id {
                    return Err(invalid("Receipt row identity changed"));
                }
                validate_operation_receipt(&receipt, &self.head.user_id)?;
                if receipt.completed_at_revision == 0
                    || receipt.completed_at_revision > self.head.replica_revision
                {
                    return Err(invalid("Receipt completion revision is inconsistent"));
                }
                if let Some(cleanup) = &receipt.create_vault_cleanup {
                    if cleanup.local_artifact_pending {
                        self.image(record_id, receipt.vault_id(), &cleanup.image, false)?;
                    }
                }
                self.reserve_summary(payload.len())?; // Receipts contain no immutable request/ciphertext body.
                self.receipts.insert(record_id.to_owned(), receipt);
            }
            ReplicaStore::RotationAttempts => {
                let attempt: RotationAttemptRecord = decode(payload)?;
                if attempt.account_id != self.head.account_id
                    || attempt.start_operation_id != record_id
                {
                    return Err(invalid("Rotation attempt row identity changed"));
                }
                self.reserve_summary(payload.len())?;
                if self
                    .rotation_attempts
                    .insert(record_id.to_owned(), attempt)
                    .is_some()
                {
                    return Err(invalid("Rotation attempt row is duplicated"));
                }
            }
            ReplicaStore::ShareCapabilities => {
                let capability: ProtectedShareCapabilityRecord = decode(payload)?;
                if capability.operation_id != record_id {
                    return Err(invalid("Share capability row identity changed"));
                }
                validate_share_capability_fields(&capability, &self.head.account_id)?;
                let size = capability.result.as_ref().map_or(0, |result| {
                    result.share_link_id.len()
                        + result.base_share_url.len()
                        + result.expires_at.len()
                });
                self.reserve_summary(size + record_id.len())?;
                self.capabilities
                    .insert(record_id.to_owned(), capability.result);
            }
            ReplicaStore::OptimisticItems => {
                // Preserve the encrypted effect. The row remains opaque to crypto here; legacy
                // admission and cross-Account witnesses bind it to accepted work at finish.
                let item: ReplicaItemRecord = decode(payload)?;
                if item.account_id != self.head.account_id
                    || item.item_id != record_id
                    || item.encrypted_data.is_empty()
                    || item.encryption_iv.is_empty()
                {
                    return Err(invalid(
                        "Optimistic Item row identity or ciphertext is invalid",
                    ));
                }
                self.reserve_summary(
                    item.item_id.len() + item.vault_id.len() + item.operation_id.len() + 32,
                )?;
                self.overlays.push(OverlayIdentity {
                    legacy_fingerprint: LegacyOperationAdmission::overlay_fingerprint(&item)?,
                    payload_sha256: Sha256::digest(
                        serde_json::to_vec(&item)
                            .map_err(|_| invalid("Optimistic Item cannot be encoded"))?,
                    )
                    .into(),
                    category: item.category,
                    item_id: item.item_id,
                    vault_id: item.vault_id,
                    operation_id: item.operation_id,
                });
            }
            _ => unreachable!("accepted stores are closed above"),
        }
        Ok(())
    }
    fn authority_row(
        &mut self,
        store: ReplicaStore,
        record_id: &str,
        payload: &str,
    ) -> Result<(), RuntimeError> {
        match store {
            ReplicaStore::ReplicaMetadata => {
                if record_id != BOOTSTRAP_METADATA_ID || self.saw_metadata {
                    return Err(invalid("Bootstrap metadata identity is invalid"));
                }
                let metadata: BootstrapMetadataRecord = decode(payload)?;
                self.reserve_summary(payload.len())?;
                self.bootstrap.policy_verification_pending = metadata.policy_verification_pending;
                self.bootstrap.state = metadata.state;
                self.bootstrap.active_generation = metadata.active_generation;
                self.bootstrap.active_cursor = metadata.active_cursor;
                self.bootstrap.staging_generation = metadata.staging_generation;
                self.saw_metadata = true;
            }
            ReplicaStore::BootstrapGenerations => {
                let generation: BootstrapGenerationRecord = decode(payload)?;
                if generation.generation_id.0 != record_id {
                    return Err(invalid("Bootstrap generation key changed"));
                }
                self.reserve_summary(payload.len())?;
                self.bootstrap
                    .generations
                    .insert(generation.generation_id.clone(), generation);
            }
            ReplicaStore::BootstrapPages => {
                let page: BootstrapPageReceipt = decode(payload)?;
                if composite_record_id(&page.generation_id.0, &page.page_identity.record_id())
                    != record_id
                {
                    return Err(invalid("Bootstrap page key changed"));
                }
                self.reserve_summary(payload.len())?;
                self.bootstrap
                    .pages
                    .insert((page.generation_id.clone(), page.page_identity), page);
            }
            ReplicaStore::AuthorityVaults => {
                let (generation, id) = split_composite_record_id(record_id)?;
                let vault: AuthorityVaultRecord = decode(payload)?;
                if vault.id != id {
                    return Err(invalid("Authority Vault key changed"));
                }
                validate_authority_page(std::slice::from_ref(&vault), &[])?;
                self.reserve_summary(generation.len() + vault.id.len())?;
                self.authority_vault_ids.insert(vault.id);
                self.authority_generations
                    .insert(BootstrapGenerationId(generation));
            }
            ReplicaStore::AuthorityItems => {
                let (generation, id) = split_composite_record_id(record_id)?;
                let item: AuthorityItemRecord = decode(payload)?;
                if item.id != id {
                    return Err(invalid("Authority Item key changed"));
                }
                validate_authority_page(&[], std::slice::from_ref(&item))?;
                self.reserve_summary(generation.len() + item.vault_id.len())?;
                self.authority_vault_ids.insert(item.vault_id);
                self.authority_generations
                    .insert(BootstrapGenerationId(generation));
            }
            _ => unreachable!("derived stores are closed above"),
        }
        Ok(())
    }
    fn reserve_summary(&mut self, bytes: usize) -> Result<(), RuntimeError> {
        self.summary_bytes = self
            .summary_bytes
            .checked_add(bytes)
            .ok_or_else(|| exceeded(RecoveryBound::SummaryBytes))?;
        if self.summary_bytes > MAX_SUMMARY_BYTES {
            return Err(exceeded(RecoveryBound::SummaryBytes));
        }
        Ok(())
    }
    fn work_identity(
        &mut self,
        operation_id: &str,
        kind: OperationKind,
        target: ResourceRef,
        category: Option<AuthorityItemCategory>,
        overlay_fingerprint: Option<OverlayFingerprint>,
        active: bool,
    ) -> Result<(), RuntimeError> {
        self.reserve_summary(
            operation_id.len()
                + target.item_id().map_or(0, str::len)
                + target.vault_id_opt().map_or(0, str::len)
                + match &target {
                    ResourceRef::Team { team_id } => team_id.len(),
                    _ => 0,
                }
                + if overlay_fingerprint.is_some() { 32 } else { 0 },
        )?;
        if self
            .work
            .insert(
                operation_id.to_owned(),
                WorkIdentity {
                    source_evidence_unavailable: false,
                    kind: Some(kind),
                    active,
                    overlay_fingerprint,
                    target,
                    category,
                },
            )
            .is_some()
        {
            return Err(invalid("Accepted work identity is duplicated"));
        }
        Ok(())
    }
    fn attachments(
        &mut self,
        preparation: &AttachmentMovePreparationRecord,
    ) -> Result<(), RuntimeError> {
        for progress in &preparation.progress {
            let (attachment_id, artifact) = match progress {
                AttachmentMoveProgress::Pending { attachment_id, .. } => (attachment_id, None),
                AttachmentMoveProgress::Encrypted {
                    attachment_id,
                    artifact,
                    ..
                } => (attachment_id, Some(artifact.clone())),
            };
            self.attachment(&preparation.operation_id, attachment_id, artifact)?;
        }
        Ok(())
    }
    fn attachment(
        &mut self,
        operation_id: &str,
        attachment_id: &str,
        artifact: Option<AttachmentMoveArtifactRef>,
    ) -> Result<(), RuntimeError> {
        self.artifact_count()?;
        self.reserve_summary(
            operation_id.len()
                + attachment_id.len()
                + artifact.as_ref().map_or(0, |value| {
                    value.artifact_id.len() + value.ciphertext_sha256.len()
                })
                + 128,
        )?;
        self.required_attachments.push(RequiredAttachment {
            operation_id: operation_id.to_owned(),
            attachment_id: attachment_id.to_owned(),
            artifact,
        });
        Ok(())
    }
    fn image(
        &mut self,
        operation_id: &str,
        vault_id: &str,
        image: &CreateVaultImageRecord,
        required_bytes: bool,
    ) -> Result<(), RuntimeError> {
        self.artifact_count()?;
        self.reserve_summary(
            operation_id.len()
                + vault_id.len()
                + image.content_type.len()
                + image.sha256.len()
                + image.object_key.len()
                + image.protected_witness.as_ref().map_or(0, |witness| {
                    witness.publication_id.len() + witness.ciphertext_sha256.len() + 64
                })
                + 128,
        )?;
        self.required_images.push(RequiredImage {
            operation_id: operation_id.into(),
            vault_id: vault_id.into(),
            image: image.clone(),
            required_bytes,
        });
        Ok(())
    }
    fn artifact_count(&self) -> Result<(), RuntimeError> {
        if self.required_attachments.len() + self.required_images.len() >= MAX_ARTIFACTS {
            return Err(exceeded(RecoveryBound::ArtifactCount));
        }
        Ok(())
    }
    fn validation_account(&self) -> AccountReplica {
        AccountReplica {
            account_id: self.head.account_id.clone(),
            user_id: self.head.user_id.clone(),
            incarnation: self.head.incarnation.clone(),
            revision: self.head.replica_revision,
            lock_epoch: self.head.lock_epoch,
            items: HashMap::new(),
            operations: HashMap::new(),
            cross_account_moves: HashMap::new(),
            share_capabilities: HashMap::new(),
            attachment_move_preparations: HashMap::new(),
            receipts: HashMap::new(),
            rotation_attempts: HashMap::new(),
            failure: self.head.failure,
            bootstrap: BootstrapAuthority::default(),
        }
    }
    pub(crate) fn finish(self) -> Result<CoverageProof, RuntimeError> {
        if self.summary_bytes > MAX_SUMMARY_BYTES {
            return Err(exceeded(RecoveryBound::SummaryBytes));
        }
        if self.failed {
            return Err(invalid("Accepted-work coverage is unavailable"));
        }
        let mut rotation_account = self.validation_account();
        rotation_account.receipts = self.receipts.clone();
        rotation_account.rotation_attempts = self.rotation_attempts.clone();
        rotation_account.validate_rotation_attempts()?;
        if self
            .child_operation_ids
            .iter()
            .any(|id| self.work.contains_key(id) || self.receipts.contains_key(id))
        {
            return Err(invalid(
                "Cross-Account Move child identity overlaps accepted semantic work",
            ));
        }
        let mut active_items = HashSet::new();
        for (id, work) in &self.work {
            if self.receipts.contains_key(id)
                || (work.active
                    && work
                        .target
                        .item_id()
                        .is_some_and(|item| !active_items.insert(item)))
            {
                return Err(invalid(
                    "Accepted Operation identity overlaps another active or completed Operation",
                ));
            }
        }
        let overlay_operations: HashSet<_> = self
            .overlays
            .iter()
            .map(|overlay| overlay.operation_id.as_str())
            .collect();
        for (operation_id, work) in &self.work {
            if work.active
                && !work.source_evidence_unavailable
                && work.kind != Some(OperationKind::CreateShare)
                && work.target.item_id().is_some()
                && work.category.is_none()
                && !overlay_operations.contains(operation_id.as_str())
            {
                return Err(invalid(
                    "Accepted Item work is missing its optimistic effect",
                ));
            }
        }
        for work in self
            .work
            .values()
            .filter(|work| work.source_evidence_unavailable && work.active)
        {
            if self
                .overlays
                .iter()
                .any(|overlay| work.target.item_id() == Some(overlay.item_id.as_str()))
            {
                return Err(invalid(
                    "Unavailable source evidence cannot coexist with any source overlay",
                ));
            }
        }
        for overlay in &self.overlays {
            if self.work.get(&overlay.operation_id).is_some_and(|work| {
                work.source_evidence_unavailable
                    || (!work.active && work.overlay_fingerprint.is_none())
            }) {
                return Err(invalid(
                    "Inactive accepted work cannot own an optimistic Item",
                ));
            }
            match self
                .work
                .get(&overlay.operation_id)
                .and_then(|work| work.overlay_fingerprint)
            {
                Some(OverlayFingerprint::CrossAccount(expected))
                    if expected != overlay.payload_sha256 =>
                {
                    return Err(invalid(
                        "Cross-Account Move source overlay differs from accepted baseline",
                    ));
                }
                Some(OverlayFingerprint::Legacy(expected))
                    if expected != overlay.legacy_fingerprint =>
                {
                    return Err(invalid(
                        "Legacy Item overlay differs from admitted accepted work",
                    ));
                }
                _ => {}
            }
            if self
                .work
                .get(&overlay.operation_id)
                .and_then(|work| work.category.as_ref())
                .is_some_and(|category| category != &overlay.category)
            {
                return Err(invalid(
                    "Recovery category witness differs from its overlay",
                ));
            }
            let target = self
                .work
                .get(&overlay.operation_id)
                .filter(|work| work.active || work.overlay_fingerprint.is_some())
                .map(|work| &work.target)
                .or_else(|| {
                    self.receipts
                        .get(&overlay.operation_id)
                        .map(|receipt| &receipt.target)
                });
            if !target.is_some_and(|target| {
                target.item_id() == Some(overlay.item_id.as_str())
                    && target.vault_id_opt() == Some(overlay.vault_id.as_str())
            }) {
                return Err(invalid(
                    "Optimistic Item is not bound to retained accepted work",
                ));
            }
        }
        for (operation_id, result) in &self.capabilities {
            let valid = share_capability_binding_matches(
                result.as_ref(),
                self.work.get(operation_id).and_then(|work| work.kind),
                self.receipts.get(operation_id),
            );
            if !valid {
                return Err(invalid(
                    "Protected Share capability has no matching Operation or receipt",
                ));
            }
        }
        let authority_valid = self.authority_valid
            && self
                .bootstrap
                .pending_vault_retirements
                .iter()
                .all(|id| !self.authority_vault_ids.contains(id))
            && (self.saw_metadata || !self.bootstrap.has_control_state())
            && self.bootstrap.validate().is_ok()
            && self
                .bootstrap
                .pages
                .keys()
                .all(|(generation, _)| self.bootstrap.generations.contains_key(generation))
            && self
                .authority_generations
                .iter()
                .all(|generation| self.bootstrap.generations.contains_key(generation));
        Ok(CoverageProof {
            head: self.head,
            rows: self.rows,
            operation_count: (self.work.len() as u32) - self.preparation_count,
            preparation_count: self.preparation_count,
            receipt_count: self.receipts.len() as u32,
            required_attachments: self.required_attachments,
            required_images: self.required_images,
            authority_valid,
            pending_vault_retirements: self.bootstrap.pending_vault_retirements,
        })
    }
}
fn decode<T: DeserializeOwned>(payload: &str) -> Result<T, RuntimeError> {
    serde_json::from_str(payload)
        .map_err(|_| invalid("Recovery row does not match its closed durable schema"))
}
fn invalid(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

#[cfg(test)]
pub(crate) use tests::corpus_loaded_rows;

#[cfg(test)]
#[path = "recovery_legacy_workflow_tests.rs"]
mod legacy_workflow_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_transport::{HttpHeader, HttpMethod};
    use crate::replica::{
        import_items_fingerprint, ImmutableHttpRequest, OperationRecord, OperationSchedulingState,
        ResourceRef,
    };

    fn head() -> ReplicaHead {
        ReplicaHead {
            account_id: "account".into(),
            user_id: "user".into(),
            incarnation: "incarnation".into(),
            replica_revision: 5,
            lock_epoch: 2,
            failure: None,
        }
    }
    fn import() -> OperationRecord {
        let body = br#"{"items":[{"itemId":"item","category":"login","favorite":true,"encryptedData":"ciphertext","encryptionIv":"iv","encryptionAlgorithm":"AES-GCM"}]}"#.to_vec();
        OperationRecord {
            operation_id: "operation".into(),
            kind: OperationKind::ImportItems,
            target: ResourceRef::ImportBatch {
                vault_id: "vault".into(),
            },
            request_fingerprint: import_items_fingerprint("vault", &body),
            request: ImmutableHttpRequest {
                method: HttpMethod::Post,
                path: "/api/v1/vaults/vault/item-imports".into(),
                headers: vec![HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }],
                body,
            },
            accepted_item_category: None,
            attachment_move_recovery: None,
            update_vault: None,
            create_vault: None,
            scheduling: OperationSchedulingState::default(),
            legacy_admission: None,
        }
    }

    fn legacy_work(update: bool) -> (OperationRecord, ReplicaItemRecord) {
        let operation_id = if update {
            "wire-attempt"
        } else {
            "semantic-id"
        };
        let mut overlay =
            crate::test_fixtures::test_overlay("account".into(), "item", operation_id);
        overlay.vault_id = "vault".into();
        overlay.encrypted_data = "ciphertext".into();
        overlay.encryption_iv = "iv".into();
        overlay.encryption_algorithm = "AES-GCM".into();
        overlay.encrypted_by_user_id = "user".into();
        overlay.created_at = source_timestamp(0).unwrap();
        overlay.updated_at = source_timestamp(0).unwrap();
        if update {
            overlay.version = 7;
            overlay.encryption_version = 7;
            overlay.favorite = true;
        }
        let body = if update {
            br#"{"encryptedData":"ciphertext","encryptionIv":"iv","encryptionAlgorithm":"AES-GCM"}"#
                .to_vec()
        } else {
            br#"{"category":"login","encryptedData":"ciphertext","encryptionIv":"iv","encryptionAlgorithm":"AES-GCM"}"#.to_vec()
        };
        let kind = if update {
            OperationKind::UpdateItem
        } else {
            OperationKind::CreateItem
        };
        let mut operation = OperationRecord {
            operation_id: operation_id.into(),
            kind,
            target: ResourceRef::Item { item_id: "item".into(), vault_id: "vault".into() },
            request_fingerprint: if update {
                item_operation_fingerprint(kind, "PATCH /api/v1/items/{itemId}", "item", &body, 6)
            } else {
                create_item_fingerprint("vault", "item", &body)
            },
            request: ImmutableHttpRequest {
                method: if update { HttpMethod::Patch } else { HttpMethod::Put },
                path: if update { "/api/v1/items/item" } else { "/api/v1/vaults/vault/items/item" }.into(),
                headers: vec![HttpHeader {
                    name: "Content-Type".into(),
                    value: if update { "application/merge-patch+json" } else { "application/json" }.into(),
                }],
                body,
            },
            accepted_item_category: Some(AuthorityItemCategory::Login),
            attachment_move_recovery: None,
            update_vault: None,
            create_vault: None,
            scheduling: OperationSchedulingState::default(),
            legacy_admission: Some(Box::new(serde_json::from_value(serde_json::json!({
                "version": 1,
                "admissionId": "admission",
                "sourceQueueIndex": "0",
                "disposition": "normal",
                "sourceCommand": {
                    "accountId": "account", "id": "source-command", "operationId": "semantic-id",
                    "attemptId": "wire-attempt", "type": if update { "update" } else { "create" },
                    "entityId": "item", "vaultId": "vault", "category": "login",
                    "encryptedPayload": { "encryptionVersion": if update { 7 } else { 1 }, "encryptedByUserId": "user" },
                    "baseVersion": if update { 6 } else { 0 }, "timestamp": "0", "retryCount": "0"
                }
            })).unwrap())),
        };
        if update {
            operation.request.headers.push(HttpHeader {
                name: "If-Match".into(),
                value: "\"6\"".into(),
            });
            operation
                .legacy_admission
                .as_mut()
                .unwrap()
                .source_command
                .category = None;
            operation.legacy_admission.as_mut().unwrap().overlay_sha256 =
                Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap());
        }
        operation
            .legacy_admission
            .as_ref()
            .unwrap()
            .validate(&head().account_id, &operation, Some(&overlay))
            .unwrap();
        (operation, overlay)
    }

    fn legacy_coverage(
        operation: &OperationRecord,
        overlay: Option<&ReplicaItemRecord>,
        overlay_first: bool,
    ) -> RecoveryCoverage {
        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        let operation_row = (
            ReplicaStore::Operations,
            operation.operation_id.clone(),
            serde_json::to_string(operation).unwrap(),
        );
        let mut rows = vec![operation_row];
        if let Some(overlay) = overlay {
            rows.push((
                ReplicaStore::OptimisticItems,
                overlay.item_id.clone(),
                serde_json::to_string(overlay).unwrap(),
            ));
        }
        if overlay_first {
            rows.reverse();
        }
        for (store, id, payload) in rows {
            coverage.push_row(store, &id, &payload).unwrap();
        }
        coverage
    }

    fn legacy_move() -> (OperationRecord, ReplicaItemRecord) {
        let (mut operation, mut overlay) = legacy_work(true);
        operation.kind = OperationKind::MoveItem;
        operation.target = ResourceRef::Item {
            item_id: "item".into(),
            vault_id: "target-vault".into(),
        };
        operation.request.method = HttpMethod::Post;
        operation.request.path = "/api/v1/items/item/moves".into();
        operation.request.headers[0].value = "application/json".into();
        operation.request.body = br#"{"mode":"prepared","sourceVaultId":"vault","targetVaultId":"target-vault","encryptedData":"ciphertext","encryptionIv":"iv","encryptionAlgorithm":"AES-GCM"}"#.to_vec();
        operation.request_fingerprint = item_operation_fingerprint(
            OperationKind::MoveItem,
            "POST /api/v1/items/{itemId}/moves",
            "item",
            &operation.request.body,
            6,
        );
        overlay.vault_id = "target-vault".into();
        let admission = operation.legacy_admission.as_mut().unwrap();
        admission.source_command.kind = LegacyItemCommandKind::Move;
        admission.source_command.target_vault_id = Some("target-vault".into());
        admission.overlay_sha256 =
            Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap());
        operation
            .legacy_admission
            .as_ref()
            .unwrap()
            .validate(&head().account_id, &operation, Some(&overlay))
            .unwrap();
        (operation, overlay)
    }

    fn legacy_ordinary(kind: LegacyItemCommandKind) -> (OperationRecord, ReplicaItemRecord) {
        match kind {
            LegacyItemCommandKind::Create => return legacy_work(false),
            LegacyItemCommandKind::Update => return legacy_work(true),
            LegacyItemCommandKind::Move => return legacy_move(),
            _ => {}
        }
        let (mut operation, mut overlay) = legacy_work(true);
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
        operation.request.path = format!("/api/v1/items/item{suffix}");
        operation.request.body = if kind == LegacyItemCommandKind::ToggleFavorite {
            br#"{"favorite":true}"#.to_vec()
        } else {
            operation.request.headers.remove(0);
            Vec::new()
        };
        operation.request_fingerprint =
            item_operation_fingerprint(operation_kind, route, "item", &operation.request.body, 6);
        overlay.version = 6;
        overlay.encryption_version = 3;
        overlay.encrypted_by_user_id = "earlier-writer".into();
        if kind == LegacyItemCommandKind::Delete {
            overlay.deleted_at = Some(overlay.updated_at.clone());
        }
        let evidence = operation.legacy_admission.as_mut().unwrap();
        evidence.source_command.kind = kind;
        evidence.source_command.encrypted_payload = None;
        evidence.source_command.favorite =
            (kind == LegacyItemCommandKind::ToggleFavorite).then_some(true);
        evidence.overlay_sha256 =
            Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap());
        operation
            .legacy_admission
            .as_ref()
            .unwrap()
            .validate(&head().account_id, &operation, Some(&overlay))
            .unwrap();
        (operation, overlay)
    }

    #[test]
    fn recovery_coverage_binds_legacy_move_overlay_in_either_row_order() {
        let (operation, overlay) = legacy_move();
        assert_eq!(
            operation.accepted_vault_ids().unwrap(),
            vec!["vault".to_owned(), "target-vault".to_owned()]
        );
        for overlay_first in [false, true] {
            let proof = legacy_coverage(&operation, Some(&overlay), overlay_first)
                .finish()
                .unwrap();
            assert_eq!(proof.operation_count, 1);
            assert_eq!(proof.accepted_rows().count(), 2);
            assert!(proof.required_attachments.is_empty());
            let mut changed = overlay.clone();
            changed.favorite = !changed.favorite;
            assert!(legacy_coverage(&operation, Some(&changed), overlay_first)
                .finish()
                .is_err());
        }
    }

    #[test]
    fn recovery_coverage_preserves_legacy_move_after_either_vault_retires() {
        use crate::replica::persistence_contract::{reconstruct_snapshot, snapshot_rows};
        use crate::replica::{GuardedCommitPlan, InMemoryReplica, PlanMutation};
        use crate::test_fixtures::personal_vault;

        for status in [
            None,
            Some(LegacyItemCommandStatus::Failed),
            Some(LegacyItemCommandStatus::Conflicted),
        ] {
            for retired_vault in ["vault", "target-vault"] {
                let (mut operation, overlay) = legacy_move();
                if let Some(status) = status {
                    let evidence = operation.legacy_admission.as_mut().unwrap();
                    evidence.source_command.status = Some(status);
                    evidence.disposition = if status == LegacyItemCommandStatus::Failed {
                        LegacyOperationDisposition::LegacyFailed
                    } else {
                        LegacyOperationDisposition::LegacyConflicted
                    };
                    evidence.overlay_sha256 = None;
                }
                let state = InMemoryReplica::default();
                let account_id = head().account_id;
                state
                    .install(account_id.clone(), "user".into(), "incarnation".into())
                    .unwrap();
                state
                    .seed_ready_authority(
                        &account_id,
                        vec![
                            personal_vault("vault", "user"),
                            personal_vault("target-vault", "user"),
                        ],
                        Vec::new(),
                    )
                    .unwrap();
                let mut acceptance = vec![PlanMutation::AcceptOperation(operation.clone())];
                if status.is_none() {
                    acceptance.push(PlanMutation::PutOptimisticItem(overlay));
                }
                for mutations in [
                    acceptance,
                    vec![PlanMutation::RetireVaults {
                        vault_ids: vec![retired_vault.into()],
                    }],
                ] {
                    let snapshot = state.snapshot(&account_id).unwrap();
                    state
                        .execute(GuardedCommitPlan::new(
                            account_id.clone(),
                            snapshot.incarnation,
                            snapshot.revision,
                            snapshot.lock_epoch,
                            mutations,
                        ))
                        .unwrap();
                }
                let snapshot = state.snapshot(&account_id).unwrap();
                assert!(snapshot.items.is_empty());
                assert_eq!(snapshot.operations, vec![operation.clone()]);
                let stored_head = ReplicaHead {
                    account_id: account_id.clone(),
                    user_id: snapshot.user_id.clone(),
                    incarnation: snapshot.incarnation.clone(),
                    replica_revision: snapshot.revision,
                    lock_epoch: snapshot.lock_epoch,
                    failure: snapshot.failure,
                };
                let rows = snapshot_rows(snapshot).unwrap();
                for reverse in [false, true] {
                    let mut recovery_rows = rows.clone();
                    if reverse {
                        recovery_rows.reverse();
                    }
                    let mut coverage = RecoveryCoverage::new(stored_head.clone()).unwrap();
                    for row in &recovery_rows {
                        coverage
                            .push_row(row.store, &row.key.record_id, &row.payload_json)
                            .unwrap();
                    }
                    let proof = coverage.finish().unwrap();
                    assert_eq!(proof.operation_count, 1);
                    assert_eq!(proof.receipt_count, 0);
                    assert!(proof.authority_valid);
                    assert!(proof.required_attachments.is_empty());
                }
                let reopened = reconstruct_snapshot(&account_id, Some(stored_head), rows)
                    .unwrap()
                    .unwrap();
                assert_eq!(reopened.operations, vec![operation]);
                assert!(reopened.items.is_empty());
            }
        }
    }

    #[test]
    fn recovery_coverage_refuses_legacy_create_overlay_changed_from_request() {
        let (operation, mut overlay) = legacy_work(false);
        overlay.encrypted_data.push_str("-changed");
        assert!(legacy_coverage(&operation, Some(&overlay), false)
            .finish()
            .is_err());
    }

    #[test]
    fn recovery_coverage_refuses_legacy_update_overlay_changed_from_witness() {
        let (operation, mut overlay) = legacy_work(true);
        overlay.favorite = !overlay.favorite;
        assert!(legacy_coverage(&operation, Some(&overlay), true)
            .finish()
            .is_err());
    }

    #[test]
    fn recovery_coverage_preserves_ordinary_holds_without_claiming_active_item_ownership() {
        for kind in [
            LegacyItemCommandKind::Create,
            LegacyItemCommandKind::Update,
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
                let (mut held, held_overlay) = legacy_ordinary(kind);
                let evidence = held.legacy_admission.as_mut().unwrap();
                evidence.source_command.status = Some(status);
                evidence.disposition = disposition;
                evidence.overlay_sha256 = None;
                let (mut active, mut overlay) = legacy_work(true);
                active.operation_id = "new-operation".into();
                let admission = active.legacy_admission.as_mut().unwrap();
                admission.source_queue_index = 1;
                admission.source_command.operation_id = Some("new-semantic-operation".into());
                admission.source_command.id = "new-command".into();
                admission.source_command.attempt_id = Some(active.operation_id.clone());
                overlay.operation_id = active.operation_id.clone();
                admission.overlay_sha256 =
                    Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap());
                active
                    .legacy_admission
                    .as_ref()
                    .unwrap()
                    .validate(&head().account_id, &active, Some(&overlay))
                    .unwrap();
                let held_row = serde_json::to_string(&held).unwrap();
                for held_first in [false, true] {
                    let isolated = legacy_coverage(&held, None, held_first).finish().unwrap();
                    assert_eq!(isolated.operation_count, 1);
                    assert_eq!(isolated.receipt_count, 0);
                    assert_eq!(isolated.accepted_rows().count(), 1);
                    assert_eq!(
                        isolated.rows[0].payload_sha256,
                        <[u8; 32]>::from(Sha256::digest(held_row.as_bytes()))
                    );
                    let mut coverage = RecoveryCoverage::new(head()).unwrap();
                    let mut rows = vec![
                        (
                            ReplicaStore::Operations,
                            held.operation_id.clone(),
                            held_row.clone(),
                        ),
                        (
                            ReplicaStore::Operations,
                            active.operation_id.clone(),
                            serde_json::to_string(&active).unwrap(),
                        ),
                        (
                            ReplicaStore::OptimisticItems,
                            overlay.item_id.clone(),
                            serde_json::to_string(&overlay).unwrap(),
                        ),
                    ];
                    if !held_first {
                        rows.reverse();
                    }
                    for (store, id, payload) in rows {
                        coverage.push_row(store, &id, &payload).unwrap();
                    }
                    let proof = coverage.finish().unwrap();
                    assert_eq!(proof.operation_count, 2);
                    assert_eq!(proof.accepted_rows().count(), 3);
                }
                // Source failure alone is not evidence that a local Item projection ever existed.
                let mut unexpected_overlay = RecoveryCoverage::new(head()).unwrap();
                unexpected_overlay
                    .push_row(ReplicaStore::Operations, &held.operation_id, &held_row)
                    .unwrap();
                unexpected_overlay
                    .push_row(
                        ReplicaStore::OptimisticItems,
                        &held_overlay.item_id,
                        &serde_json::to_string(&held_overlay).unwrap(),
                    )
                    .unwrap();
                assert!(unexpected_overlay.finish().is_err());
                if kind != LegacyItemCommandKind::Create {
                    let mut forged = held.clone();
                    forged.legacy_admission.as_mut().unwrap().overlay_sha256 =
                        Some(LegacyOperationAdmission::overlay_fingerprint(&held_overlay).unwrap());
                    assert!(RecoveryCoverage::new(head())
                        .unwrap()
                        .push_row(
                            ReplicaStore::Operations,
                            &forged.operation_id,
                            &serde_json::to_string(&forged).unwrap(),
                        )
                        .is_err());
                }
            }
        }
    }

    #[test]
    fn recovery_keeps_stopped_update_beside_newer_confirmed_authority_in_either_row_order() {
        use crate::replica::persistence_contract::{reconstruct_snapshot, snapshot_rows};
        use crate::replica::{GuardedCommitPlan, InMemoryReplica, PlanMutation};
        use crate::test_fixtures::personal_vault;

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
            for newer_owner in [false, true] {
                let (mut held, old_projection) = legacy_work(true);
                let evidence = held.legacy_admission.as_mut().unwrap();
                evidence.source_command.status = Some(status);
                evidence.source_command.retry_count = 3;
                evidence.source_command.next_attempt_at = Some(42000);
                evidence.source_command.projection_claim_id = Some("departed-projector".into());
                evidence.source_command.conflict_copy_id = Some("independent-copy".into());
                evidence.disposition = disposition;
                evidence.overlay_sha256 = None;
                held.scheduling = evidence.initial_scheduling();
                let authority = AuthorityItemRecord {
                    id: old_projection.item_id.clone(),
                    vault_id: old_projection.vault_id.clone(),
                    category: old_projection.category.clone(),
                    favorite: false,
                    encrypted_data: "newer-confirmed-ciphertext".into(),
                    encryption_iv: "newer-confirmed-iv".into(),
                    encryption_algorithm: old_projection.encryption_algorithm.clone(),
                    version: 9,
                    encryption_version: 4,
                    encrypted_by_user_id: "confirmed-writer".into(),
                    last_modified_by: "latest-metadata-writer".into(),
                    created_at: old_projection.created_at.clone(),
                    updated_at: source_timestamp(2000).unwrap(),
                    deleted_at: None,
                    attachments: Vec::new(),
                };
                let state = InMemoryReplica::default();
                let account_id = head().account_id;
                state
                    .install(account_id.clone(), "user".into(), "incarnation".into())
                    .unwrap();
                state
                    .seed_ready_authority(
                        &account_id,
                        vec![personal_vault("vault", "user")],
                        vec![authority.clone()],
                    )
                    .unwrap();
                let mut mutations = vec![PlanMutation::AcceptOperation(held.clone())];
                if newer_owner {
                    let (mut active, mut overlay) = legacy_work(true);
                    active.operation_id = "new-wire-attempt".into();
                    active.request.headers[1].value = "\"9\"".into();
                    active.request_fingerprint = item_operation_fingerprint(
                        OperationKind::UpdateItem,
                        "PATCH /api/v1/items/{itemId}",
                        "item",
                        &active.request.body,
                        9,
                    );
                    overlay.operation_id = active.operation_id.clone();
                    overlay.version = 10;
                    overlay.encryption_version = 10;
                    overlay.favorite = authority.favorite;
                    overlay.updated_at = source_timestamp(3000).unwrap();
                    let evidence = active.legacy_admission.as_mut().unwrap();
                    evidence.source_queue_index = 1;
                    evidence.source_command.id = "new-source-command".into();
                    evidence.source_command.operation_id = Some("new-semantic-operation".into());
                    evidence.source_command.attempt_id = Some(active.operation_id.clone());
                    evidence.source_command.base_version = 9;
                    evidence.source_command.timestamp = 3000;
                    evidence
                        .source_command
                        .encrypted_payload
                        .as_mut()
                        .unwrap()
                        .encryption_version = 10;
                    evidence.overlay_sha256 =
                        Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap());
                    mutations.extend([
                        PlanMutation::AcceptOperation(active),
                        PlanMutation::PutOptimisticItem(overlay),
                    ]);
                }
                let initial = state.snapshot(&account_id).unwrap();
                state
                    .execute(GuardedCommitPlan::new(
                        account_id.clone(),
                        initial.incarnation,
                        initial.revision,
                        initial.lock_epoch,
                        mutations,
                    ))
                    .unwrap();
                let snapshot = state.snapshot(&account_id).unwrap();
                assert_eq!(
                    snapshot.bootstrap.snapshot().visible_items,
                    vec![authority.clone()]
                );
                assert_eq!(snapshot.item_has_optimistic_owner("item"), newer_owner);
                let stored_head = ReplicaHead {
                    account_id: account_id.clone(),
                    user_id: snapshot.user_id.clone(),
                    incarnation: snapshot.incarnation.clone(),
                    replica_revision: snapshot.revision,
                    lock_epoch: snapshot.lock_epoch,
                    failure: snapshot.failure,
                };
                let rows = snapshot_rows(snapshot.clone()).unwrap();
                for reverse in [false, true] {
                    let mut ordered = rows.clone();
                    if reverse {
                        ordered.reverse();
                    }
                    let mut coverage = RecoveryCoverage::new(stored_head.clone()).unwrap();
                    for row in &ordered {
                        coverage
                            .push_row(row.store, &row.key.record_id, &row.payload_json)
                            .unwrap();
                    }
                    let proof = coverage.finish().unwrap();
                    assert!(proof.authority_valid);
                    assert_eq!(proof.operation_count, if newer_owner { 2 } else { 1 });
                    assert_eq!(
                        proof.accepted_rows().count(),
                        if newer_owner { 3 } else { 1 }
                    );
                    assert_eq!(proof.receipt_count, 0);
                    let held_row = proof
                        .accepted_rows()
                        .find(|row| {
                            row.store == ReplicaStore::Operations
                                && row.record_id == held.operation_id
                        })
                        .unwrap();
                    assert_eq!(
                        held_row.payload_sha256,
                        <[u8; 32]>::from(Sha256::digest(serde_json::to_vec(&held).unwrap()))
                    );
                    let reopened =
                        reconstruct_snapshot(&account_id, Some(stored_head.clone()), ordered)
                            .unwrap()
                            .unwrap();
                    assert_eq!(reopened.operations, snapshot.operations);
                    assert_eq!(reopened.items, snapshot.items);
                    assert_eq!(
                        reopened.bootstrap.snapshot().visible_items,
                        vec![authority.clone()]
                    );
                    assert_eq!(reopened.item_has_optimistic_owner("item"), newer_owner);
                }
            }
        }
    }

    fn captured_failed_create() -> (OperationRecord, ReplicaItemRecord) {
        let (operation, overlay) = legacy_work(false);
        let mut value = serde_json::to_value(operation).unwrap();
        value["legacyAdmission"]["sourceCommand"]["status"] = "failed".into();
        value["legacyAdmission"]["disposition"] = "legacyFailed".into();
        value["legacyAdmission"]["capturedFailureCode"] = "item_id_conflict".into();
        (
            serde_json::from_value(value)
                .expect("captured failed Create has a closed durable owner"),
            overlay,
        )
    }

    #[test]
    fn recovery_captured_failed_create_keeps_exact_overlay_and_local_code() {
        let (operation, overlay) = captured_failed_create();
        for overlay_first in [false, true] {
            let proof = legacy_coverage(&operation, Some(&overlay), overlay_first)
                .finish()
                .unwrap();
            assert_eq!(proof.operation_count, 1);
            assert_eq!(proof.receipt_count, 0);
            assert_eq!(proof.accepted_rows().count(), 2);
            let payload = serde_json::to_string(&operation).unwrap();
            let operation_hash = proof
                .rows
                .iter()
                .find(|row| row.store == ReplicaStore::Operations)
                .unwrap();
            assert_eq!(
                operation_hash.payload_sha256,
                <[u8; 32]>::from(Sha256::digest(payload.as_bytes()))
            );
            let mut changed = overlay.clone();
            changed.favorite = !changed.favorite;
            assert!(legacy_coverage(&operation, Some(&changed), overlay_first)
                .finish()
                .is_err());
            // The failure code preserves a source fact, not perpetual overlay ownership.
            let absent = legacy_coverage(&operation, None, overlay_first)
                .finish()
                .unwrap();
            assert_eq!(absent.operation_count, 1);
            assert_eq!(absent.accepted_rows().count(), 1);
        }
    }

    #[test]
    fn recovery_captured_failed_create_allows_new_active_overlay() {
        let (held, _) = captured_failed_create();
        let (mut active, mut overlay) = legacy_work(false);
        active.operation_id = "new-active-operation".into();
        let admission = active.legacy_admission.as_mut().unwrap();
        admission.source_queue_index = 1;
        admission.source_command.id = "new-source-command".into();
        admission.source_command.operation_id = Some(active.operation_id.clone());
        overlay.operation_id = active.operation_id.clone();
        for reverse in [false, true] {
            let mut rows = vec![
                (
                    ReplicaStore::Operations,
                    held.operation_id.clone(),
                    serde_json::to_string(&held).unwrap(),
                ),
                (
                    ReplicaStore::Operations,
                    active.operation_id.clone(),
                    serde_json::to_string(&active).unwrap(),
                ),
                (
                    ReplicaStore::OptimisticItems,
                    overlay.item_id.clone(),
                    serde_json::to_string(&overlay).unwrap(),
                ),
            ];
            if reverse {
                rows.reverse();
            }
            let mut coverage = RecoveryCoverage::new(head()).unwrap();
            for (store, id, payload) in rows {
                coverage.push_row(store, &id, &payload).unwrap();
            }
            let proof = coverage.finish().unwrap();
            assert_eq!(proof.operation_count, 2);
            assert_eq!(proof.accepted_rows().count(), 3);
            assert_eq!(proof.receipt_count, 0);
        }
    }

    #[test]
    fn recovery_captured_failed_create_survives_vault_retirement_and_reload() {
        use crate::replica::persistence_contract::{reconstruct_snapshot, snapshot_rows};
        use crate::replica::{GuardedCommitPlan, InMemoryReplica, PlanMutation};
        use crate::test_fixtures::personal_vault;

        let (operation, overlay) = captured_failed_create();
        let state = InMemoryReplica::default();
        let account_id = head().account_id;
        state
            .install(account_id.clone(), "user".into(), "incarnation".into())
            .unwrap();
        state
            .seed_ready_authority(
                &account_id,
                vec![personal_vault("vault", "user")],
                Vec::new(),
            )
            .unwrap();
        for mutations in [
            vec![
                PlanMutation::AcceptOperation(operation.clone()),
                PlanMutation::PutOptimisticItem(overlay),
            ],
            vec![PlanMutation::RetireVaults {
                vault_ids: vec!["vault".into()],
            }],
        ] {
            let snapshot = state.snapshot(&account_id).unwrap();
            state
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    snapshot.incarnation,
                    snapshot.revision,
                    snapshot.lock_epoch,
                    mutations,
                ))
                .unwrap();
        }
        let snapshot = state.snapshot(&account_id).unwrap();
        assert!(snapshot.items.is_empty());
        assert_eq!(snapshot.operations, vec![operation.clone()]);
        let stored_head = ReplicaHead {
            account_id: account_id.clone(),
            user_id: snapshot.user_id.clone(),
            incarnation: snapshot.incarnation.clone(),
            replica_revision: snapshot.revision,
            lock_epoch: snapshot.lock_epoch,
            failure: snapshot.failure,
        };
        let rows = snapshot_rows(snapshot).unwrap();
        let mut coverage = RecoveryCoverage::new(stored_head.clone()).unwrap();
        for row in &rows {
            coverage
                .push_row(row.store, &row.key.record_id, &row.payload_json)
                .unwrap();
        }
        let proof = coverage.finish().unwrap();
        assert!(proof.authority_valid);
        assert_eq!(proof.operation_count, 1);
        let reopened = reconstruct_snapshot(&account_id, Some(stored_head), rows)
            .unwrap()
            .unwrap();
        assert_eq!(reopened.operations, vec![operation]);
        assert!(reopened.items.is_empty());
    }

    #[test]
    fn recovery_coverage_preserves_legacy_overlay_or_legitimate_retirement_in_either_row_order() {
        for update in [false, true] {
            let (operation, overlay) = legacy_work(update);
            for overlay_first in [false, true] {
                let proof = legacy_coverage(&operation, Some(&overlay), overlay_first)
                    .finish()
                    .unwrap();
                assert_eq!(proof.operation_count, 1);
                assert_eq!(proof.accepted_rows().count(), 2);
            }
            let proof = legacy_coverage(&operation, None, false).finish().unwrap();
            assert_eq!(proof.operation_count, 1);
            assert_eq!(proof.accepted_rows().count(), 1);
        }
    }

    #[test]
    fn recovery_coverage_preserves_raw_fingerprint_and_rejects_tampering_with_same_head() {
        let operation = import();
        let json = serde_json::to_string_pretty(&operation).unwrap();
        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        coverage
            .push_row(ReplicaStore::Operations, "operation", &json)
            .unwrap();
        let proof = coverage.finish().unwrap();
        assert_eq!(proof.operation_count, 1);
        assert_eq!(proof.accepted_rows().count(), 1);
        assert_eq!(
            proof.rows[0].payload_sha256,
            <[u8; 32]>::from(Sha256::digest(json.as_bytes()))
        );
        let mut changed = operation;
        changed.request.body.push(b' ');
        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        assert!(coverage
            .push_row(
                ReplicaStore::Operations,
                "operation",
                &serde_json::to_string(&changed).unwrap()
            )
            .is_err());
        assert!(coverage.finish().is_err());
    }
    #[test]
    fn recovery_coverage_keeps_accepted_proof_when_only_derived_authority_is_invalid() {
        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        coverage
            .push_row(
                ReplicaStore::Operations,
                "operation",
                &serde_json::to_string(&import()).unwrap(),
            )
            .unwrap();
        coverage
            .push_row(ReplicaStore::AuthorityItems, "generation/item", "malformed")
            .unwrap();
        let proof = coverage.finish().unwrap();
        assert!(!proof.authority_valid);
        assert_eq!(proof.rows.len(), 2);
        assert_eq!(proof.accepted_rows().count(), 1);
        assert!(proof.rows[0].valid);
        assert!(!proof.rows[1].valid);
        assert_eq!(proof.rows[1].store, ReplicaStore::AuthorityItems);
        assert_eq!(proof.rows[1].record_id, "generation/item");
        assert_eq!(
            proof.rows[1].payload_sha256,
            <[u8; 32]>::from(Sha256::digest(b"malformed"))
        );
    }

    #[test]
    fn recovery_coverage_accepts_largest_legitimate_import_row_without_retaining_its_body() {
        use crate::wire::import::{ImportRequestBody, ImportRequestItem};
        let mut items = (0..15)
            .map(|index| ImportRequestItem {
                item_id: format!("item-{index}"),
                category: crate::server_contract::ItemCategory::Login,
                favorite: true,
                encrypted_data: "z".repeat(1024 * 1024),
                encryption_iv: "AAECAwQFBgcICQoL".into(),
                encryption_algorithm: "AES-GCM".into(),
            })
            .collect::<Vec<_>>();
        let initial = serde_json::to_vec(&ImportRequestBody {
            items: items.clone(),
        })
        .unwrap()
        .len();
        let excess = initial - 15 * 1024 * 1024;
        let last = items.last_mut().unwrap();
        last.encrypted_data
            .truncate(last.encrypted_data.len() - excess);
        assert!(items
            .iter()
            .all(|item| item.encrypted_data.len() <= 1024 * 1024));
        let mut operation = import();
        operation.request.body = serde_json::to_vec(&ImportRequestBody { items }).unwrap();
        assert_eq!(operation.request.body.len(), 15 * 1024 * 1024);
        operation.request_fingerprint = import_items_fingerprint("vault", &operation.request.body);
        let payload = serde_json::to_string(&operation).unwrap();
        drop(operation);
        assert!(payload.len() > 59 * 1024 * 1024 && payload.len() < MAX_RECORD_BYTES);
        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        coverage
            .push_row(ReplicaStore::Operations, "operation", &payload)
            .unwrap();
        assert!(
            coverage.summary_bytes < 4096,
            "accepted body must not accumulate in summaries"
        );
        let proof = coverage.finish().unwrap();
        assert_eq!(proof.operation_count, 1);
        assert_eq!(proof.rows.len(), 1);
    }

    #[test]
    fn recovery_coverage_rejects_duplicate_unknown_and_conflicting_accepted_rows() {
        let payload = serde_json::to_string(&import()).unwrap();
        let mut duplicate = RecoveryCoverage::new(head()).unwrap();
        duplicate
            .push_row(ReplicaStore::Operations, "operation", &payload)
            .unwrap();
        assert!(duplicate
            .push_row(ReplicaStore::Operations, "operation", &payload)
            .is_err());
        assert!(duplicate.finish().is_err());
        let mut unknown = RecoveryCoverage::new(head()).unwrap();
        assert!(unknown
            .push_row(ReplicaStore::Operations, "operation", r#"{"unknown":true}"#)
            .is_err());
        assert!(unknown.finish().is_err());
        let receipt = OperationReceiptRecord {
            operation_id: "operation".into(),
            kind: OperationKind::ImportItems,
            target: ResourceRef::ImportBatch {
                vault_id: "vault".into(),
            },
            request_fingerprint: import().request_fingerprint,
            result: OperationOutcomeResult::ImportApplied {
                vault_id: "vault".into(),
                imported_count: 1,
            },
            completed_at_revision: 4,
            legacy_lineage: None,
            create_vault_cleanup: None,
        };
        let mut conflict = RecoveryCoverage::new(head()).unwrap();
        conflict
            .push_row(ReplicaStore::Operations, "operation", &payload)
            .unwrap();
        conflict
            .push_row(
                ReplicaStore::OperationReceipts,
                "operation",
                &serde_json::to_string(&receipt).unwrap(),
            )
            .unwrap();
        assert!(conflict.finish().is_err());
        let mut later = receipt;
        later.completed_at_revision = 6;
        assert!(RecoveryCoverage::new(head())
            .unwrap()
            .push_row(
                ReplicaStore::OperationReceipts,
                "operation",
                &serde_json::to_string(&later).unwrap()
            )
            .is_err());
    }
    #[test]
    fn recovery_coverage_binds_share_result_to_exact_receipt_without_retaining_ciphertext() {
        let capability = ProtectedShareCapabilityRecord {
            account_id: "account".into(),
            operation_id: "share".into(),
            ciphertext: "protected".repeat(1024),
            iv: "iv".into(),
            algorithm: "AES-GCM-AAD-V1".into(),
            result: Some(ShareAppliedResultRecord {
                share_link_id: "link".into(),
                base_share_url: "https://example.test/s".into(),
                expires_at: "2026-09-09T00:00:00Z".into(),
            }),
        };
        let receipt = OperationReceiptRecord {
            operation_id: "share".into(),
            kind: OperationKind::CreateShare,
            target: ResourceRef::Item {
                item_id: "item".into(),
                vault_id: "vault".into(),
            },
            request_fingerprint: Sha256Fingerprint([1; 32]),
            result: OperationOutcomeResult::ShareApplied {
                share_link_id: "link".into(),
                base_share_url: "https://example.test/s".into(),
                expires_at: "2026-09-09T00:00:00Z".into(),
            },
            completed_at_revision: 4,
            legacy_lineage: None,
            create_vault_cleanup: None,
        };
        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        coverage
            .push_row(
                ReplicaStore::ShareCapabilities,
                "share",
                &serde_json::to_string(&capability).unwrap(),
            )
            .unwrap();
        coverage
            .push_row(
                ReplicaStore::OperationReceipts,
                "share",
                &serde_json::to_string(&receipt).unwrap(),
            )
            .unwrap();
        assert!(coverage.summary_bytes < 2048);
        assert_eq!(coverage.finish().unwrap().accepted_rows().count(), 2);
        let mut wrong = capability;
        wrong.result.as_mut().unwrap().share_link_id = "another".into();
        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        coverage
            .push_row(
                ReplicaStore::OperationReceipts,
                "share",
                &serde_json::to_string(&receipt).unwrap(),
            )
            .unwrap();
        coverage
            .push_row(
                ReplicaStore::ShareCapabilities,
                "share",
                &serde_json::to_string(&wrong).unwrap(),
            )
            .unwrap();
        assert!(coverage.finish().is_err());
    }
    fn image_operation() -> OperationRecord {
        let image_bytes = b"retained image bytes";
        let sha256 = format!("{:x}", Sha256::digest(image_bytes));
        let intent = CreateVaultOperationRecord {
            account_id: "account".into(),
            name: "Vault".into(),
            vault_type: crate::CreateVaultType::Personal,
            icon: "bank".into(),
            encrypted_vault_key: "wrapped".into(),
            image: Some(CreateVaultImageRecord {
                protected_witness: None,
                raw_cleanup_pending: false,
                byte_length: image_bytes.len() as u64,
                content_type: "image/png".into(),
                sha256: sha256.clone(),
                object_key: format!("vaults/user/vault/create/image-{sha256}"),
            }),
            checkpoint: CreateVaultCheckpoint::ArtifactReady,
        };
        let canonical = canonical_create_vault_request("vault", &intent).unwrap();
        OperationRecord {
            operation_id: "image".into(),
            kind: OperationKind::CreateVault,
            target: ResourceRef::Vault {
                vault_id: "vault".into(),
            },
            request: ImmutableHttpRequest {
                method: HttpMethod::Put,
                path: canonical.path,
                headers: vec![HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }],
                body: Vec::new(),
            },
            request_fingerprint: canonical.fingerprint,
            accepted_item_category: None,
            attachment_move_recovery: None,
            update_vault: None,
            create_vault: Some(intent),
            scheduling: OperationSchedulingState::default(),
            legacy_admission: None,
        }
    }
    #[test]
    fn recovery_coverage_distinguishes_required_image_from_idempotent_receipt_cleanup() {
        let operation = image_operation();
        let mut active = RecoveryCoverage::new(head()).unwrap();
        active
            .push_row(
                ReplicaStore::Operations,
                "image",
                &serde_json::to_string(&operation).unwrap(),
            )
            .unwrap();
        let proof = active.finish().unwrap();
        assert_eq!(proof.required_images.len(), 1);
        assert!(proof.required_images[0].required_bytes);
        assert_eq!(
            proof.required_images[0].image.sha256,
            format!("{:x}", Sha256::digest(b"retained image bytes"))
        );
        let receipt = OperationReceiptRecord {
            operation_id: "image".into(),
            kind: OperationKind::CreateVault,
            target: operation.target,
            request_fingerprint: operation.request_fingerprint,
            result: OperationOutcomeResult::VaultApplied {
                vault_id: "vault".into(),
            },
            completed_at_revision: 4,
            legacy_lineage: None,
            create_vault_cleanup: Some(CreateVaultCleanupObligation {
                image: operation.create_vault.unwrap().image.unwrap(),
                local_artifact_pending: true,
                remote_staging_pending: false,
            }),
        };
        let mut cleanup = RecoveryCoverage::new(head()).unwrap();
        cleanup
            .push_row(
                ReplicaStore::OperationReceipts,
                "image",
                &serde_json::to_string(&receipt).unwrap(),
            )
            .unwrap();
        let proof = cleanup.finish().unwrap();
        assert!(!proof.required_images[0].required_bytes);
    }
    #[test]
    fn recovery_coverage_refuses_missing_overlay_and_preserves_rejected_overlay() {
        let mut operation = crate::test_fixtures::test_operation("op", "item");
        operation.request_fingerprint =
            create_item_fingerprint(operation.vault_id(), "item", &operation.request.body);
        let mut missing = RecoveryCoverage::new(head()).unwrap();
        missing
            .push_row(
                ReplicaStore::Operations,
                "op",
                &serde_json::to_string(&operation).unwrap(),
            )
            .unwrap();
        assert!(missing.finish().is_err());
        let overlay = crate::test_fixtures::test_overlay("account".into(), "item", "op");
        let receipt = OperationReceiptRecord {
            operation_id: "op".into(),
            kind: OperationKind::CreateItem,
            target: operation.target,
            request_fingerprint: operation.request_fingerprint,
            result: OperationOutcomeResult::Rejected {
                code: OperationRejectionCode::InvalidCiphertext,
            },
            completed_at_revision: 4,
            legacy_lineage: None,
            create_vault_cleanup: None,
        };
        let mut retained = RecoveryCoverage::new(head()).unwrap();
        retained
            .push_row(
                ReplicaStore::OptimisticItems,
                "item",
                &serde_json::to_string(&overlay).unwrap(),
            )
            .unwrap();
        retained
            .push_row(
                ReplicaStore::OperationReceipts,
                "op",
                &serde_json::to_string(&receipt).unwrap(),
            )
            .unwrap();
        assert_eq!(retained.finish().unwrap().accepted_rows().count(), 2);
    }

    pub(crate) fn corpus_loaded_rows() -> Vec<(
        ReplicaHead,
        Vec<super::super::persistence_contract::StoredReplicaRow>,
    )> {
        use super::super::persistence_contract::ReplicaPersistenceResponse;
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../generated/replica-conformance/history-corpus.json"
        ))
        .unwrap();
        corpus["histories"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|history| history["steps"].as_array().unwrap())
            .flat_map(|step| step["expectedLoadedState"].as_array().unwrap())
            .filter_map(|loaded| {
                match serde_json::from_value(loaded["response"].clone()).unwrap() {
                    ReplicaPersistenceResponse::Loaded {
                        head: Some(head),
                        rows,
                    } => Some((head, rows)),
                    _ => None,
                }
            })
            .collect()
    }

    #[test]
    fn recovery_coverage_validates_existing_corpus_bootstrap_checkpoints_without_retaining_ciphertext(
    ) {
        let mut checkpoints = 0;
        let mut authority_rows = 0;
        for (head, rows) in corpus_loaded_rows() {
            let mut coverage = RecoveryCoverage::new(head).unwrap();
            for row in rows.into_iter().filter(|row| {
                matches!(
                    row.store,
                    ReplicaStore::ReplicaMetadata
                        | ReplicaStore::BootstrapGenerations
                        | ReplicaStore::BootstrapPages
                        | ReplicaStore::AuthorityVaults
                        | ReplicaStore::AuthorityItems
                )
            }) {
                authority_rows += 1;
                coverage
                    .push_row(row.store, &row.key.record_id, &row.payload_json)
                    .unwrap();
            }
            let proof = coverage.finish().unwrap();
            assert!(proof.authority_valid);
            assert!(proof.rows.iter().all(|row| row.valid));
            checkpoints += 1;
        }
        assert!(checkpoints >= 94);
        assert!(authority_rows > 300);
    }

    #[test]
    fn recovery_coverage_retains_each_attachment_checkpoint_and_promoted_recovery_dependency() {
        let mut preparations = 0;
        let mut promoted = 0;
        let mut pending = 0;
        let mut required = 0;
        for (head, rows) in corpus_loaded_rows() {
            for row in &rows {
                let preparation = if row.store == ReplicaStore::AttachmentMovePreparations {
                    preparations += 1;
                    Some(decode::<AttachmentMovePreparationRecord>(&row.payload_json).unwrap())
                } else if row.store == ReplicaStore::Operations {
                    let operation: OperationRecord = decode(&row.payload_json).unwrap();
                    operation.attachment_move_recovery.map(|recovery| {
                        promoted += 1;
                        match recovery {
                            AttachmentMoveRecovery::Prepared { preparation }
                            | AttachmentMoveRecovery::RejectStaleAuthority { preparation } => {
                                *preparation
                            }
                        }
                    })
                } else {
                    None
                };
                let Some(preparation) = preparation else {
                    continue;
                };
                let overlay = rows.iter().find(|candidate| {
                    candidate.store == ReplicaStore::OptimisticItems
                        && decode::<ReplicaItemRecord>(&candidate.payload_json)
                            .unwrap()
                            .operation_id
                            == preparation.operation_id
                });
                let mut coverage = RecoveryCoverage::new(head.clone()).unwrap();
                coverage
                    .push_row(row.store, &row.key.record_id, &row.payload_json)
                    .unwrap();
                if let Some(overlay) = overlay {
                    coverage
                        .push_row(overlay.store, &overlay.key.record_id, &overlay.payload_json)
                        .unwrap();
                } else {
                    assert!(
                        preparation.accepted_item_category.is_some(),
                        "erased overlay must retain category evidence"
                    );
                }
                let proof = coverage.finish().unwrap();
                assert_eq!(proof.required_attachments.len(), preparation.progress.len());
                for (reference, progress) in
                    proof.required_attachments.iter().zip(&preparation.progress)
                {
                    assert_eq!(reference.operation_id, preparation.operation_id);
                    assert_eq!(reference.attachment_id, progress.attachment_id());
                    match progress {
                        AttachmentMoveProgress::Pending { .. } => {
                            pending += 1;
                            assert!(reference.artifact.is_none());
                        }
                        AttachmentMoveProgress::Encrypted { artifact, .. } => {
                            required += 1;
                            assert_eq!(reference.artifact.as_ref(), Some(artifact));
                        }
                    }
                }
                let mut tampered = preparation;
                tampered.target_encrypted_data.push('!');
                let mut rejected = RecoveryCoverage::new(head.clone()).unwrap();
                assert!(rejected
                    .push_row(
                        ReplicaStore::AttachmentMovePreparations,
                        &tampered.operation_id,
                        &serde_json::to_string(&tampered).unwrap()
                    )
                    .is_err());
                assert!(rejected.finish().is_err());
            }
        }
        assert!(preparations >= 5);
        assert!(promoted > 0 && pending > 0 && required > 0);
    }

    #[test]
    fn recovery_coverage_retirement_history_preserves_batch_categories_and_move_dependencies() {
        let mut retired = 0;
        for (head, rows) in corpus_loaded_rows() {
            if !rows.iter().any(|row| {
                row.store == ReplicaStore::Operations && row.key.record_id == "retirement-import"
            }) {
                continue;
            }
            let mut coverage = RecoveryCoverage::new(head).unwrap();
            for row in &rows {
                coverage
                    .push_row(row.store, &row.key.record_id, &row.payload_json)
                    .unwrap();
            }
            let proof = coverage.finish().unwrap();
            assert!(proof.authority_valid);
            let batch: OperationRecord = decode(
                &rows
                    .iter()
                    .find(|row| row.key.record_id == "retirement-import")
                    .unwrap()
                    .payload_json,
            )
            .unwrap();
            let body: crate::wire::import::ImportRequestBody =
                serde_json::from_slice(&batch.request.body).unwrap();
            assert_eq!(body.items.len(), 5);
            assert!(batch.accepted_item_category.is_none());
            if !proof.pending_vault_retirements.is_empty() {
                retired += 1;
                assert!(proof
                    .accepted_rows()
                    .any(|row| row.store == ReplicaStore::ReplicaMetadata
                        && row.record_id == VAULT_RETIREMENTS_METADATA_ID));
                assert_eq!(proof.required_attachments.len(), 1);
                assert_eq!(proof.operation_count, 1);
                assert_eq!(proof.preparation_count, 1);
            }
        }
        assert!(retired > 0);
    }

    #[test]
    fn recovery_coverage_checks_every_item_route_fingerprint_and_exact_headers() {
        let cases = [
            (
                OperationKind::UpdateItem,
                HttpMethod::Patch,
                "",
                "PATCH /api/v1/items/{itemId}",
                Some("application/merge-patch+json"),
            ),
            (
                OperationKind::SetItemFavorite,
                HttpMethod::Patch,
                "/favorite",
                "PATCH /api/v1/items/{itemId}/favorite",
                Some("application/merge-patch+json"),
            ),
            (
                OperationKind::TrashItem,
                HttpMethod::Delete,
                "",
                "DELETE /api/v1/items/{itemId}",
                None,
            ),
            (
                OperationKind::RestoreItem,
                HttpMethod::Post,
                "/restore",
                "POST /api/v1/items/{itemId}/restore",
                None,
            ),
            (
                OperationKind::MoveItem,
                HttpMethod::Post,
                "/moves",
                "POST /api/v1/items/{itemId}/moves",
                Some("application/json"),
            ),
            (
                OperationKind::PermanentlyDeleteItem,
                HttpMethod::Delete,
                "/permanent",
                "DELETE /api/v1/items/{itemId}/permanent",
                None,
            ),
        ];
        for (kind, method, suffix, route, content_type) in cases {
            let body = if content_type.is_some() {
                b"{}".to_vec()
            } else {
                vec![]
            };
            let mut headers = Vec::new();
            if let Some(content_type) = content_type {
                headers.push(HttpHeader {
                    name: "Content-Type".into(),
                    value: content_type.into(),
                });
            }
            headers.push(HttpHeader {
                name: "If-Match".into(),
                value: "\"4\"".into(),
            });
            let operation = OperationRecord {
                operation_id: "operation".into(),
                kind,
                target: ResourceRef::Item {
                    item_id: "item".into(),
                    vault_id: "vault".into(),
                },
                request_fingerprint: item_operation_fingerprint(kind, route, "item", &body, 4),
                request: ImmutableHttpRequest {
                    method,
                    path: format!("/api/v1/items/item{suffix}"),
                    headers,
                    body,
                },
                scheduling: OperationSchedulingState::default(),
                legacy_admission: None,
                accepted_item_category: None,
                attachment_move_recovery: None,
                update_vault: None,
                create_vault: None,
            };
            verify_item_request(&operation).unwrap();
            for mutation in 0..5 {
                let mut changed = operation.clone();
                match mutation {
                    0 => changed.request.path.push('x'),
                    1 => changed.request.body.push(b' '),
                    2 => changed.request.headers.last_mut().unwrap().value = "\"04\"".into(),
                    3 => changed.request.headers.push(HttpHeader {
                        name: "Authorization".into(),
                        value: "must-not-be-recovered".into(),
                    }),
                    _ => changed.request_fingerprint = Sha256Fingerprint([0; 32]),
                }
                assert!(
                    verify_item_request(&changed).is_err(),
                    "{kind:?} mutation {mutation}"
                );
            }
        }
    }

    #[test]
    fn recovery_coverage_refuses_import_overlay_and_poisoned_summary_without_losing_raw_identity() {
        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        let operation = import();
        coverage
            .push_row(
                ReplicaStore::Operations,
                "operation",
                &serde_json::to_string(&operation).unwrap(),
            )
            .unwrap();
        let mut overlay =
            crate::test_fixtures::test_overlay(head().account_id, "item", "operation");
        overlay.operation_id = "operation".into();
        coverage
            .push_row(
                ReplicaStore::OptimisticItems,
                &overlay.item_id,
                &serde_json::to_string(&overlay).unwrap(),
            )
            .unwrap();
        assert!(coverage.finish().is_err()); // Accepted Import deliberately has no optimistic Items.

        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        let oversized_identity = "x".repeat(MAX_SUMMARY_BYTES / 2);
        assert!(coverage
            .push_row(ReplicaStore::AuthorityItems, &oversized_identity, "{}")
            .is_err());
        assert!(coverage.rows.is_empty()); // Refuse before cloning/hashing or accepting a prefix.
        assert!(coverage.finish().is_err());
    }

    #[test]
    fn recovery_coverage_resource_limits_are_typed_before_a_prefix_can_be_accepted() {
        use crate::RecoveryBound;
        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        coverage.summary_bytes = MAX_SUMMARY_BYTES;
        let error = coverage
            .push_row(ReplicaStore::AuthorityItems, "next", "{}")
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::SizeRejected);
        assert_eq!(error.recovery_bound, Some(RecoveryBound::SummaryBytes));
        assert!(coverage.rows.is_empty());

        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        coverage.rows.resize_with(MAX_ROWS, || RecoveryRowHash {
            store: ReplicaStore::AuthorityItems,
            record_id: String::new(),
            payload_sha256: [0; 32],
            accepted: false,
            valid: true,
        });
        let error = coverage
            .push_row(ReplicaStore::AuthorityItems, "next", "{}")
            .unwrap_err();
        assert_eq!(error.recovery_bound, Some(RecoveryBound::RecordCount));
        assert_eq!(coverage.rows.len(), MAX_ROWS);

        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        let oversized = "x".repeat(MAX_RECORD_BYTES + 1);
        let error = coverage
            .push_row(ReplicaStore::AuthorityItems, "next", &oversized)
            .unwrap_err();
        assert_eq!(error.recovery_bound, Some(RecoveryBound::RecordBytes));
        assert!(coverage.rows.is_empty());
        drop(oversized);

        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        coverage
            .required_attachments
            .resize_with(MAX_ARTIFACTS, || RequiredAttachment {
                operation_id: String::new(),
                attachment_id: String::new(),
                artifact: None,
            });
        assert_eq!(
            coverage.artifact_count().unwrap_err().recovery_bound,
            Some(RecoveryBound::ArtifactCount)
        );

        let metadata = corpus_loaded_rows()
            .into_iter()
            .flat_map(|(_, rows)| rows)
            .find(|row| row.store == ReplicaStore::ReplicaMetadata)
            .unwrap();
        let mut coverage = RecoveryCoverage::new(head()).unwrap();
        coverage.summary_bytes = MAX_SUMMARY_BYTES - metadata.key.record_id.len() * 2 - 256;
        let error = coverage
            .push_row(
                metadata.store,
                &metadata.key.record_id,
                &metadata.payload_json,
            )
            .unwrap_err();
        assert_eq!(error.recovery_bound, Some(RecoveryBound::SummaryBytes));
        // Even a bound reached within derived validation refuses; it is not corrupt-row salvage.
        assert!(coverage.finish().is_err());
    }
}
