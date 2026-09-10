//! Bounded validation of stored rows for Account recovery. Payloads never become a second Replica.

use super::domain::*;
use super::persistence_contract::{
    composite_record_id, split_composite_record_id, BootstrapMetadataRecord, ReplicaHead,
    ReplicaStore, BOOTSTRAP_METADATA_ID,
};
use crate::http_transport::{HttpHeader, HttpMethod};
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
}
impl CoverageProof {
    pub(crate) fn accepted_rows(&self) -> impl Iterator<Item = &RecoveryRowHash> {
        self.rows.iter().filter(|row| row.accepted)
    }
}

struct WorkIdentity {
    kind: OperationKind,
    target: ResourceRef,
}
struct OverlayIdentity {
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
    receipts: HashMap<String, OperationReceiptRecord>,
    overlays: Vec<OverlayIdentity>,
    capabilities: HashMap<String, Option<ShareAppliedResultRecord>>,
    bootstrap: BootstrapAuthority,
    saw_metadata: bool,
    authority_generations: HashSet<BootstrapGenerationId>,
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
            receipts: HashMap::new(),
            overlays: Vec::new(),
            capabilities: HashMap::new(),
            bootstrap: BootstrapAuthority::default(),
            saw_metadata: false,
            authority_generations: HashSet::new(),
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
                | ReplicaStore::OptimisticItems
                | ReplicaStore::AttachmentMovePreparations
                | ReplicaStore::OperationReceipts
                | ReplicaStore::ShareCapabilities
        );
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
                if let Some(image) = operation
                    .create_vault
                    .as_ref()
                    .and_then(|intent| intent.image.as_ref())
                {
                    self.image(record_id, operation.vault_id(), image, true)?;
                }
                self.work_identity(record_id, operation.kind, operation.target)?;
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
                )?;
                self.preparation_count += 1;
            }
            ReplicaStore::OperationReceipts => {
                let receipt: OperationReceiptRecord = decode(payload)?;
                if receipt.operation_id != record_id {
                    return Err(invalid("Receipt row identity changed"));
                }
                let mut account = self.validation_account();
                account.receipts.insert(record_id.to_owned(), receipt);
                account.validate_durable_work()?;
                let receipt = account
                    .receipts
                    .remove(record_id)
                    .expect("inserted receipt");
                if let Some(cleanup) = &receipt.create_vault_cleanup {
                    if cleanup.local_artifact_pending {
                        self.image(record_id, receipt.vault_id(), &cleanup.image, false)?;
                    }
                }
                self.reserve_summary(payload.len())?; // Receipts contain no immutable request/ciphertext body.
                self.receipts.insert(record_id.to_owned(), receipt);
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
                // Match the existing Domain overlay contract: preserve the opaque effect exactly;
                // crypto readability and correspondence are not reconstructed from request bytes.
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
                    item.item_id.len() + item.vault_id.len() + item.operation_id.len(),
                )?;
                self.overlays.push(OverlayIdentity {
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
                self.reserve_summary(generation.len())?;
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
                self.reserve_summary(generation.len())?;
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
    ) -> Result<(), RuntimeError> {
        self.reserve_summary(
            operation_id.len() + target.item_id().map_or(0, str::len) + target.vault_id().len(),
        )?;
        if self
            .work
            .insert(operation_id.to_owned(), WorkIdentity { kind, target })
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
            self.artifact_count()?;
            self.reserve_summary(
                preparation.operation_id.len()
                    + attachment_id.len()
                    + artifact.as_ref().map_or(0, |value| {
                        value.artifact_id.len() + value.ciphertext_sha256.len()
                    })
                    + 128,
            )?;
            self.required_attachments.push(RequiredAttachment {
                operation_id: preparation.operation_id.clone(),
                attachment_id: attachment_id.clone(),
                artifact,
            });
        }
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
            share_capabilities: HashMap::new(),
            attachment_move_preparations: HashMap::new(),
            receipts: HashMap::new(),
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
        let mut active_items = HashSet::new();
        for (id, work) in &self.work {
            if self.receipts.contains_key(id)
                || work
                    .target
                    .item_id()
                    .is_some_and(|item| !active_items.insert(item))
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
            if work.kind != OperationKind::CreateShare
                && work.target.item_id().is_some()
                && !overlay_operations.contains(operation_id.as_str())
            {
                return Err(invalid(
                    "Accepted Item work is missing its optimistic effect",
                ));
            }
        }
        for overlay in &self.overlays {
            let target = self
                .work
                .get(&overlay.operation_id)
                .map(|work| &work.target)
                .or_else(|| {
                    self.receipts
                        .get(&overlay.operation_id)
                        .map(|receipt| &receipt.target)
                });
            if !target.is_some_and(|target| {
                target.item_id() == Some(overlay.item_id.as_str())
                    && target.vault_id() == overlay.vault_id
            }) {
                return Err(invalid(
                    "Optimistic Item is not bound to retained accepted work",
                ));
            }
        }
        for (operation_id, result) in &self.capabilities {
            let valid = share_capability_binding_matches(
                result.as_ref(),
                self.work.get(operation_id).map(|work| work.kind),
                self.receipts.get(operation_id),
            );
            if !valid {
                return Err(invalid(
                    "Protected Share capability has no matching Operation or receipt",
                ));
            }
        }
        let authority_valid = self.authority_valid
            && (self.saw_metadata || self.bootstrap == BootstrapAuthority::default())
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

/// Check the same request fingerprints as acceptance without allocating rewritten body bytes.
fn verify_item_request(operation: &OperationRecord) -> Result<(), RuntimeError> {
    use HttpMethod::*;
    let (method, path, content_type, fingerprint) = match operation.kind {
        OperationKind::CreateVault | OperationKind::ImportItems => return Ok(()), // Existing strict domain validators also verify their fingerprints.
        OperationKind::CreateItem => (
            Put,
            format!(
                "/api/v1/vaults/{}/items/{}",
                operation.vault_id(),
                operation
                    .target
                    .item_id()
                    .ok_or_else(|| invalid("Create Item target is invalid"))?
            ),
            Some("application/json"),
            create_item_fingerprint(
                operation.vault_id(),
                operation.target.item_id().unwrap(),
                &operation.request.body,
            ),
        ),
        OperationKind::CreateShare => (
            Post,
            format!(
                "/api/v1/items/{}/share-links",
                operation
                    .target
                    .item_id()
                    .ok_or_else(|| invalid("Share target is invalid"))?
            ),
            Some("application/json"),
            share_operation_fingerprint(
                operation.target.item_id().unwrap(),
                &operation.request.body,
            ),
        ),
        kind => {
            let item = operation
                .target
                .item_id()
                .ok_or_else(|| invalid("Item Operation target is invalid"))?;
            let (method, suffix, route, content_type) = match kind {
                OperationKind::UpdateItem => (
                    Patch,
                    "",
                    "PATCH /api/v1/items/{itemId}",
                    Some("application/merge-patch+json"),
                ),
                OperationKind::SetItemFavorite => (
                    Patch,
                    "/favorite",
                    "PATCH /api/v1/items/{itemId}/favorite",
                    Some("application/merge-patch+json"),
                ),
                OperationKind::TrashItem => (Delete, "", "DELETE /api/v1/items/{itemId}", None),
                OperationKind::RestoreItem => (
                    Post,
                    "/restore",
                    "POST /api/v1/items/{itemId}/restore",
                    None,
                ),
                OperationKind::MoveItem => (
                    Post,
                    "/moves",
                    "POST /api/v1/items/{itemId}/moves",
                    Some("application/json"),
                ),
                OperationKind::PermanentlyDeleteItem => (
                    Delete,
                    "/permanent",
                    "DELETE /api/v1/items/{itemId}/permanent",
                    None,
                ),
                _ => unreachable!(),
            };
            let value = operation
                .request
                .headers
                .iter()
                .find(|header| header.name == "If-Match")
                .ok_or_else(|| invalid("Item concurrency precondition is missing"))?
                .value
                .as_str();
            let expected = value
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .and_then(|value| value.parse::<i32>().ok())
                .filter(|value| *value > 0)
                .ok_or_else(|| invalid("Item concurrency precondition is invalid"))?;
            if value != format!("\"{expected}\"") {
                return Err(invalid("Item concurrency precondition is not canonical"));
            }
            let mut headers = content_type
                .map(|value| HttpHeader {
                    name: "Content-Type".into(),
                    value: value.into(),
                })
                .into_iter()
                .collect::<Vec<_>>();
            headers.push(HttpHeader {
                name: "If-Match".into(),
                value: value.into(),
            });
            if operation.request.headers != headers {
                return Err(invalid("Item request headers changed"));
            }
            (
                method,
                format!("/api/v1/items/{item}{suffix}"),
                content_type,
                item_operation_fingerprint(kind, route, item, &operation.request.body, expected),
            )
        }
    };
    if operation.request.method != method
        || operation.request.path != path
        || operation.request_fingerprint != fingerprint
    {
        return Err(invalid(
            "Operation immutable request fingerprint or route changed",
        ));
    }
    if matches!(
        operation.kind,
        OperationKind::CreateItem | OperationKind::CreateShare
    ) && operation.request.headers
        != content_type
            .map(|value| HttpHeader {
                name: "Content-Type".into(),
                value: value.into(),
            })
            .into_iter()
            .collect::<Vec<_>>()
    {
        return Err(invalid("Create request headers changed"));
    }
    Ok(())
}

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
            attachment_move_recovery: None,
            create_vault: None,
            scheduling: OperationSchedulingState::default(),
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
            attachment_move_recovery: None,
            create_vault: Some(intent),
            scheduling: OperationSchedulingState::default(),
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

    fn corpus_loaded_rows() -> Vec<(
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
        assert_eq!(checkpoints, 94);
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
                let overlay = rows
                    .iter()
                    .find(|candidate| {
                        candidate.store == ReplicaStore::OptimisticItems
                            && decode::<ReplicaItemRecord>(&candidate.payload_json)
                                .unwrap()
                                .operation_id
                                == preparation.operation_id
                    })
                    .unwrap();
                let mut coverage = RecoveryCoverage::new(head.clone()).unwrap();
                coverage
                    .push_row(row.store, &row.key.record_id, &row.payload_json)
                    .unwrap();
                coverage
                    .push_row(overlay.store, &overlay.key.record_id, &overlay.payload_json)
                    .unwrap();
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
        assert_eq!(preparations, 5);
        assert!(promoted > 0 && pending > 0 && required > 0);
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
                attachment_move_recovery: None,
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
