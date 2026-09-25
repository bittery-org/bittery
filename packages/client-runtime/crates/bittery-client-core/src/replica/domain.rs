#[path = "cross_account_move_entry.rs"]
mod cross_account_move_entry;
pub(crate) use cross_account_move_entry::*;
#[path = "cross_account_move.rs"]
mod cross_account_move;
#[path = "legacy_cross_account_admission.rs"]
mod legacy_cross_account_admission;
pub(crate) use legacy_cross_account_admission::*;
#[path = "legacy_admission.rs"]
mod legacy_admission;
#[path = "rotation_start.rs"]
mod rotation_start;
pub(crate) use rotation_start::*;
#[path = "vault_retirement.rs"]
mod vault_retirement;
use crate::http_transport::{HttpHeader, HttpMethod};
use crate::wire::decimal_u64;
use crate::{protocol::Incarnation, AccountId, RuntimeError, RuntimeErrorCode};
pub(crate) use cross_account_move::*;
#[allow(
    unused_imports,
    reason = "legacy admission types are consumed by the next queued-Create slice"
)]
pub(crate) use legacy_admission::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
pub(super) use vault_retirement::validate_retired_vault_ids;

#[cfg(test)]
#[path = "vault_retirement_tests.rs"]
mod vault_retirement_tests;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GuardedCommitPlan {
    pub account_id: AccountId,
    pub expected_incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    pub expected_replica_revision: u64,
    #[serde(with = "decimal_u64")]
    pub expected_lock_epoch: u64,
    pub mutations: Vec<PlanMutation>,
}

impl GuardedCommitPlan {
    pub(crate) fn new(
        account_id: AccountId,
        expected_incarnation: Incarnation,
        expected_replica_revision: u64,
        expected_lock_epoch: u64,
        mutations: Vec<PlanMutation>,
    ) -> Self {
        Self {
            account_id,
            expected_incarnation,
            expected_replica_revision,
            expected_lock_epoch,
            mutations,
        }
    }
}

/// One exact foreground Attachment authority commit.
///
/// Unlike Operation reconciliation, a stale fetched Item is not a successful no-op: the caller
/// must retry from fresh authority and may not publish the requested Attachment effect.
pub(crate) struct ForegroundAttachmentCommitPlan {
    pub(crate) guard: GuardedCommitPlan,
    pub(crate) attachment_id: String,
    pub(crate) attachment_present: bool,
    pub(crate) item: AuthorityItemRecord,
}

impl ForegroundAttachmentCommitPlan {
    pub(crate) fn new(
        account_id: AccountId,
        expected_incarnation: Incarnation,
        expected_replica_revision: u64,
        expected_lock_epoch: u64,
        attachment_id: String,
        attachment_present: bool,
        item: AuthorityItemRecord,
    ) -> Self {
        Self {
            guard: GuardedCommitPlan::new(
                account_id,
                expected_incarnation,
                expected_replica_revision,
                expected_lock_epoch,
                Vec::new(),
            ),
            attachment_id,
            attachment_present,
            item,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PlanMutation {
    RetireVaults {
        vault_ids: Vec<String>,
    },
    CompleteVaultRetirements {
        vault_ids: Vec<String>,
    },
    PutOptimisticItem(ReplicaItemRecord),
    AcceptOperation(OperationRecord),
    /// Shares the start Operation's atomic commit and freezes its proved preparation generation.
    BindRotationStart {
        start_operation_id: String,
        intent: RotationIntent,
        authority_generation_id: String,
        team_role: crate::server_contract::TeamRole,
    },
    /// The start answer, compact receipt, and full non-secret plan journal move together.
    ReconcileRotationStart {
        outcome: ObservedOutcome,
        intent: RotationIntent,
        validated_plans: Vec<RotationPlanRecord>,
    },
    BindRotationManifest {
        start_operation_id: String,
        members: Vec<RotationMemberRecord>,
    },
    AcknowledgeRotationAttempt {
        start_operation_id: String,
    },
    ConsumeRotationAttempt {
        start_operation_id: String,
        attempt_id: String,
    },
    AcceptRotationFinalize {
        start_operation_id: String,
        attempt_id: String,
        operation: OperationRecord,
    },
    ReconcileRotationFinalize {
        start_operation_id: String,
        outcome: ObservedOutcome,
    },
    CompleteRotationRefresh {
        start_operation_id: String,
        finalize_operation_id: String,
    },
    AdmitCrossAccountMove {
        record: Box<CrossAccountMoveRecord>,
        source_overlay: Option<ReplicaItemRecord>,
    },
    AdmitLegacySourceUnavailableMove {
        record: Box<LegacySourceUnavailableMove>,
    },
    AdvanceCrossAccountMove {
        operation_id: String,
        #[serde(with = "decimal_u64")]
        expected_binding_revision: u64,
        next: Box<CrossAccountMoveRecord>,
        source_authority: CrossAccountMoveSourceAuthority,
    },
    RetireCrossAccountMoveDestination {
        operation_id: String,
        #[serde(with = "decimal_u64")]
        expected_binding_revision: u64,
        target_account_id: AccountId,
        target_incarnation: Incarnation,
    },
    ReauthorizeCrossAccountMoveDestination {
        operation_id: String,
        #[serde(with = "decimal_u64")]
        expected_binding_revision: u64,
        destination_account_id: AccountId,
        destination_incarnation: Incarnation,
        verified_attachments: Vec<AuthorityAttachmentRecord>,
    },
    ReauthorizeLegacyCrossAccountMoveFromTrashedCache {
        operation_id: String,
        #[serde(with = "decimal_u64")]
        expected_binding_revision: u64,
        destination_account_id: AccountId,
        destination_incarnation: Incarnation,
        verified_source: Box<AuthorityItemRecord>,
    },
    ReauthorizeAndCompleteLegacyCrossAccountMove {
        operation_id: String,
        #[serde(with = "decimal_u64")]
        expected_binding_revision: u64,
        destination_account_id: AccountId,
        destination_incarnation: Incarnation,
        verified_outcomes: Box<LegacyCrossAccountCompletionProof>,
    },
    PutProtectedShareCapability(ProtectedShareCapabilityRecord),
    RemoveAllProtectedShareCapabilities,
    AcceptAttachmentMovePreparation(AttachmentMovePreparationRecord),
    RescheduleAttachmentMovePreparation(AttachmentMovePreparationRecord),
    CheckpointAttachmentMove {
        operation_id: String,
        expected_intent_fingerprint: Sha256Fingerprint,
        expected: AttachmentMoveProgress,
        next: AttachmentMoveProgress,
    },
    ResetAttachmentMoveUpload {
        operation_id: String,
        expected_intent_fingerprint: Sha256Fingerprint,
        attachment_id: String,
    },
    FreezeAttachmentMoveRejection {
        operation_id: String,
        expected_intent_fingerprint: Sha256Fingerprint,
    },
    PromoteAttachmentMovePreparation {
        operation_id: String,
        expected_intent_fingerprint: Sha256Fingerprint,
    },
    /// Returns a promoted Move to preparation after a nonterminal staging-incomplete response.
    ReactivateAttachmentMovePreparation {
        operation_id: String,
        expected_request_fingerprint: Sha256Fingerprint,
    },
    /// Records one dispatch attempt's diagnostic count and next eligible time.
    ///
    /// The whole record travels so the Replica can prove the immutable half did not move. No
    /// mutation exists that can change an accepted Operation's identity, bytes, or fingerprint.
    RescheduleOperation(OperationRecord),
    /// Advances only the closed create-Vault checkpoint while preserving its immutable intent.
    CheckpointCreateVault(OperationRecord),
    /// Enriches only accepted local image evidence after protected publication, retaining raw
    /// cleanup until the physical deletion finalizer has acknowledged it.
    ProtectVaultImage {
        operation_id: String,
        witness: crate::vault_image::protected::ProtectedImageWitness,
    },
    CompleteVaultImageRawCleanup {
        operation_id: String,
        witness: crate::vault_image::protected::ProtectedImageWitness,
    },
    RemoveOperation {
        operation_id: String,
    },
    /// Completes one applied create in the single transaction the outcome slice owes.
    ///
    /// Authority, receipt, Operation removal, and overlay removal are one mutation because they
    /// are one fact: the Server decided, and this Device now agrees. The optional Cursor remains
    /// for compatible stored plans; Bootstrap page progress uses `AdvanceSyncPageCursor`.
    ReconcileAppliedCreate {
        outcome: ObservedOutcome,
        /// Boxed only because an authoritative Item dwarfs every other mutation's payload.
        item: Box<AuthorityItemRecord>,
        cursor: Option<CursorAdvance>,
    },
    /// Reconciles an Item mutation against the authority fetched after its retained outcome.
    ///
    /// `None` is current authoritative absence for any applied Item kind, including Create.
    /// Present Create authority still uses `ReconcileAppliedCreate`. The receipt,
    /// authority replacement/removal, Operation removal, and overlay removal are one fact and
    /// therefore one mutation. Bootstrap page progress is a separate guarded mutation.
    ReconcileItemMutation {
        outcome: ObservedOutcome,
        item: Option<Box<AuthorityItemRecord>>,
        cursor: Option<CursorAdvance>,
    },
    /// Publishes a foreground Attachment mutation only with the freshly fetched owning Item.
    CommitAttachmentAuthority {
        attachment_id: String,
        attachment_present: bool,
        item: Box<AuthorityItemRecord>,
    },
    /// Retains one terminal rejection: retry stops, the receipt says why, the ciphertext stays.
    RetainRejection {
        outcome: ObservedOutcome,
        cursor: Option<CursorAdvance>,
    },
    /// Ends a CreateShare and either retains its once-only applied delivery or destroys the
    /// capability after a terminal rejection, in the same transaction as its receipt.
    ReconcileShareOutcome {
        outcome: ObservedOutcome,
        cursor: Option<CursorAdvance>,
    },
    ReconcileCreateVault {
        outcome: ObservedOutcome,
        vault: Option<AuthorityVaultRecord>,
    },
    /// Retain the confirmed action and require current Server authority before changing metadata.
    ReconcileVaultMutation {
        outcome: ObservedOutcome,
    },
    /// Records an exact historical result without installing or deleting current authority.
    ReconcileRetainedResult {
        outcome: ObservedOutcome,
    },
    /// Installs one complete authoritative Import batch, its compact receipt, and removes the
    /// accepted request/progress effect in one guarded Replica commit.
    ReconcileImportItems {
        outcome: ObservedOutcome,
        items: Vec<AuthorityItemRecord>,
    },
    CompleteCreateVaultCleanup {
        operation_id: String,
        local_artifact_done: bool,
        remote_staging_done: bool,
    },
    /// Advances one complete Sync page after all of its event effects succeeded locally.
    ///
    /// Operation identities are retained so a stale recomputation cannot move the page watermark
    /// past accepted work that appeared after event processing but before this commit.
    AdvanceSyncPageCursor {
        operation_ids: Vec<String>,
        cursor: CursorAdvance,
    },
    AcknowledgeShareResult {
        operation_id: String,
    },
    /// Fails the Account module after a fatal invariant violation.
    ///
    /// The Replica keeps every durable row. Failing is how the Runtime refuses to guess, not a
    /// way to delete work or to reverse a Server effect.
    FailAccount {
        code: RuntimeErrorCode,
    },
}

/// One exact guarded Sync page Cursor step and the Cursor it must start from.
///
/// Bootstrap owns one terminal step after every event in the page succeeds. When the Replica has
/// moved on, the step is simply not taken: a Cursor that no longer matches exactly is never
/// advanced past unread work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CursorAdvance {
    pub expected: SyncCursor,
    pub next: SyncCursor,
}

/// The closed set of terminal rejections the Server can answer for an Item Operation.
///
/// It mirrors the Server's one shared set exactly, so a fact keeps one name on both sides of the
/// seam. Which subset any one kind can actually produce is a property of that kind, not of this
/// type.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationRejectionCode {
    InvalidCiphertext,
    VaultAccessDenied,
    VaultReadOnly,
    ItemIdConflict,
    ItemNotFound,
    ItemVersionConflict,
    ItemTrashed,
    ItemNotTrashed,
    SourceVaultMismatch,
    TargetVaultAccessDenied,
    TargetVaultReadOnly,
    AttachmentStateConflict,
    ShareEntitlementDenied,
    ShareLimitReached,
}

/// What the Server decided about one Operation. Transport status is deliberately absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum OperationOutcomeResult {
    /// Transient exact Server result. This full list is never retained in a receipt.
    RotationStartApplied {
        plans: Vec<RotationPlanRecord>,
    },
    RotationStartAppliedReceipt {
        plan_set_fingerprint: Sha256Fingerprint,
        plan_count: u16,
    },
    RotationStartRejected {
        code: RotationStartRejectionCode,
    },
    RotationFinalizeApplied {
        personal_team_id: String,
        #[serde(default)]
        rotations: Vec<RotationResultRecord>,
    },
    RotationFinalizeRejected {
        code: RotationFinalizeRejectionCode,
        details: Option<RotationStaleDetails>,
    },
    Applied {
        entity_id: String,
        version: i32,
    },
    ShareApplied {
        share_link_id: String,
        base_share_url: String,
        expires_at: String,
    },
    VaultApplied {
        vault_id: String,
    },
    VaultRejected {
        code: CreateVaultOperationRejectionCode,
    },
    VaultMutationRejected {
        code: VaultMutationOperationRejectionCode,
    },
    ImportApplied {
        vault_id: String,
        imported_count: u16,
    },
    ImportRejected {
        code: ImportItemsOperationRejectionCode,
    },
    Rejected {
        code: OperationRejectionCode,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CreateVaultOperationRejectionCode {
    VaultIdConflict,
    TeamMembershipRequired,
    VaultSharingEntitlementDenied,
    SharedVaultLimitReached,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum VaultMutationOperationRejectionCode {
    VaultAccessDenied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImportItemsOperationRejectionCode {
    InvalidCiphertext,
    VaultAccessDenied,
    VaultReadOnly,
    ItemIdConflict,
}

/// One observed semantic outcome, carrying the fingerprint it was answered for.
///
/// The fingerprint travels with the outcome because identity alone proves nothing: the same
/// Operation ID answered for other request bytes is identity reuse, and only a comparison
/// against the accepted fingerprint can see it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ObservedOutcome {
    pub operation_id: String,
    pub request_fingerprint: Sha256Fingerprint,
    pub result: OperationOutcomeResult,
}

/// The compact Account-lifetime local receipt of one completed Operation.
///
/// It keeps identity, fingerprint, terminal result, entity version, and the revision that
/// completed it, and never the request ciphertext. It is what stops a completed Operation ID
/// from being reused, and it is distinct from the Server's own retained outcome.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationReceiptRecord {
    pub operation_id: String,
    pub kind: OperationKind,
    pub target: ResourceRef,
    pub request_fingerprint: Sha256Fingerprint,
    pub result: OperationOutcomeResult,
    #[serde(with = "decimal_u64")]
    pub completed_at_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_vault_cleanup: Option<CreateVaultCleanupObligation>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "legacy_admission::present"
    )]
    pub legacy_lineage: Option<LegacyOperationReceiptLineage>,
}

/// The closed durable address of the resource an Operation owns.
///
/// Vault work is never disguised as Item work, and adding another non-Item Operation requires an
/// explicit new variant rather than a sentinel `item_id`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum ResourceRef {
    Item { item_id: String, vault_id: String },
    Vault { vault_id: String },
    ImportBatch { vault_id: String },
    Team { team_id: String },
}

impl ResourceRef {
    pub(crate) fn item_id(&self) -> Option<&str> {
        match self {
            Self::Item { item_id, .. } => Some(item_id),
            Self::Vault { .. } | Self::ImportBatch { .. } | Self::Team { .. } => None,
        }
    }

    pub(crate) fn vault_id_opt(&self) -> Option<&str> {
        match self {
            Self::Item { vault_id, .. }
            | Self::Vault { vault_id }
            | Self::ImportBatch { vault_id } => Some(vault_id),
            Self::Team { .. } => None,
        }
    }

    pub(crate) fn vault_id(&self) -> &str {
        self.vault_id_opt()
            .expect("Vault-only Operation path received a Team target")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateVaultCleanupObligation {
    pub image: CreateVaultImageRecord,
    pub local_artifact_pending: bool,
    pub remote_staging_pending: bool,
}

/// The closed set of durable mutations this Runtime accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationKind {
    CreateVault,
    UpdateVault,
    DeleteVault,
    CreateItem,
    UpdateItem,
    SetItemFavorite,
    TrashItem,
    RestoreItem,
    MoveItem,
    PermanentlyDeleteItem,
    CreateShare,
    ImportItems,
    CreateVaultMemberRemovalRotationPlans,
    FinalizeVaultMemberRemovalRotationPlans,
    CreateTeamLeaveRotationPlans,
    FinalizeTeamLeaveRotationPlans,
    CreateTeamMemberRemovalRotationPlans,
    FinalizeTeamMemberRemovalRotationPlans,
}

impl OperationKind {
    pub(crate) fn is_rotation(self) -> bool {
        matches!(
            self,
            Self::CreateVaultMemberRemovalRotationPlans
                | Self::FinalizeVaultMemberRemovalRotationPlans
                | Self::CreateTeamLeaveRotationPlans
                | Self::FinalizeTeamLeaveRotationPlans
                | Self::CreateTeamMemberRemovalRotationPlans
                | Self::FinalizeTeamMemberRemovalRotationPlans
        )
    }
}

/// The exact bytes an accepted Operation will send, forever.
///
/// Authorization is deliberately absent. A credential belongs to the Session that is current when
/// the Operation is dispatched, not to work that may outlive several Sessions, so dispatch attaches
/// it. Everything here is fixed at acceptance and is replayed byte for byte after any restart.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImmutableHttpRequest {
    pub method: HttpMethod,
    pub path: String,
    pub headers: Vec<HttpHeader>,
    pub body: Vec<u8>,
}

/// Diagnostic scheduling for an accepted Operation.
///
/// There is deliberately no attempt limit and no discarded state: a transport count never owns
/// accepted work. Only an authoritative semantic outcome ends an Operation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationSchedulingState {
    #[serde(with = "decimal_u64")]
    pub attempt_count: u64,
    /// Earliest Device time at which the next attempt may start. Zero means "eligible now".
    #[serde(with = "decimal_u64")]
    pub not_before_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationRecord {
    pub operation_id: String,
    pub kind: OperationKind,
    pub target: ResourceRef,
    pub request: ImmutableHttpRequest,
    /// Covers the request, never the Operation ID. A Server outcome that carries this Operation ID
    /// with another fingerprint is therefore a detectable identity reuse, not a replay.
    pub request_fingerprint: Sha256Fingerprint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_item_category: Option<AuthorityItemCategory>,
    /// Opaque restart material retained by a prepared or stale-authority Attachment Move request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_move_recovery: Option<AttachmentMoveRecovery>,
    /// Durable intent and checkpoints. Presence is the `PendingVaultCreation` optimistic effect;
    /// it never publishes Vault or key authority by itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_vault: Option<CreateVaultOperationRecord>,
    /// Image replacement shares the existing immutable image artifact and staging checkpoints.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_vault: Option<Box<UpdateVaultImageOperationRecord>>,
    pub scheduling: OperationSchedulingState,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "legacy_admission::present"
    )]
    pub legacy_admission: Option<Box<LegacyOperationAdmission>>,
}

impl OperationRecord {
    pub(crate) fn is_legacy_held(&self) -> bool {
        self.legacy_admission
            .as_ref()
            .is_some_and(|admission| admission.disposition != LegacyOperationDisposition::Normal)
    }

    pub(crate) fn vault_image(&self) -> Option<&CreateVaultImageRecord> {
        self.create_vault
            .as_ref()
            .and_then(|intent| intent.image.as_ref())
            .or_else(|| self.update_vault.as_ref().map(|intent| &intent.image))
    }

    pub(crate) fn vault_image_checkpoint(&self) -> Option<CreateVaultCheckpoint> {
        self.create_vault
            .as_ref()
            .map(|intent| intent.checkpoint)
            .or_else(|| self.update_vault.as_ref().map(|intent| intent.checkpoint))
    }

    pub(crate) fn set_vault_image_checkpoint(&mut self, checkpoint: CreateVaultCheckpoint) {
        if let Some(intent) = &mut self.create_vault {
            intent.checkpoint = checkpoint;
        }
        if let Some(intent) = &mut self.update_vault {
            intent.checkpoint = checkpoint;
        }
    }

    pub(crate) fn item_id(&self) -> &str {
        self.target
            .item_id()
            .expect("Item-only Operation path received a non-Item target")
    }

    pub(crate) fn vault_id(&self) -> &str {
        self.target.vault_id()
    }
}

impl OperationReceiptRecord {
    #[cfg(test)]
    pub(crate) fn item_id(&self) -> &str {
        self.target
            .item_id()
            .expect("Item-only receipt path received a non-Item target")
    }

    pub(crate) fn vault_id(&self) -> &str {
        self.target.vault_id()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateVaultOperationRecord {
    pub account_id: AccountId,
    pub name: String,
    pub vault_type: crate::CreateVaultType,
    pub icon: String,
    pub encrypted_vault_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<CreateVaultImageRecord>,
    pub checkpoint: CreateVaultCheckpoint,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateVaultImageOperationRecord {
    pub account_id: AccountId,
    pub name: Option<String>,
    pub icon: crate::VaultIconPatch,
    pub image: CreateVaultImageRecord,
    pub checkpoint: CreateVaultCheckpoint,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateVaultImageRecord {
    pub byte_length: u64,
    pub content_type: String,
    pub sha256: String,
    pub object_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protected_witness: Option<crate::vault_image::protected::ProtectedImageWitness>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub raw_cleanup_pending: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalCreateVaultBody<'a> {
    name: &'a str,
    vault_type: &'a str,
    encrypted_vault_key: &'a str,
    icon: &'a str,
    image_key: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CreateVaultCheckpoint {
    ArtifactReady,
    RemoteUploadConfirmed,
    FinalRequestFrozen,
}

fn create_vault_fingerprint(path: &str, body: &[u8]) -> Sha256Fingerprint {
    use sha2::{Digest, Sha256};

    let mut digest = Sha256::new();
    for value in [
        b"bittery.operation.v1".as_slice(),
        b"create_vault",
        path.as_bytes(),
        body,
    ] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value);
    }
    Sha256Fingerprint(digest.finalize().into())
}

/// The most Items one Import batch may ever carry.
///
/// The Replica cannot depend on the Runtime, so the bound the trust boundary enforces is the one
/// the Runtime accepts against, the executor fetches against, and the outcome reader validates
/// against. One owner is what keeps "at most 200" from drifting into four different numbers.
pub(crate) const MAX_IMPORT_ITEMS: usize = 200;

/// The one canonical Import route.
///
/// The Runtime freezes its bytes against it, the Replica re-derives them from the persisted
/// record, and the shared conformance histories build them the same way. One owner is what makes
/// "the same accepted batch" mean the same thing on every side of the trust boundary.
pub(crate) fn import_items_path(vault_id: &str) -> String {
    format!("/api/v1/vaults/{vault_id}/item-imports")
}

/// Binds one Import batch's identity to its route and its exact bytes.
pub(crate) fn import_items_fingerprint(vault_id: &str, body: &[u8]) -> Sha256Fingerprint {
    use sha2::{Digest, Sha256};

    let path = import_items_path(vault_id);
    let mut digest = Sha256::new();
    for value in [
        b"bittery.operation.v1".as_slice(),
        b"import_items",
        path.as_bytes(),
        body,
    ] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value);
    }
    Sha256Fingerprint(digest.finalize().into())
}

pub(crate) struct CanonicalCreateVaultRequest {
    pub path: String,
    pub body: Vec<u8>,
    pub fingerprint: Sha256Fingerprint,
}

pub(crate) fn canonical_create_vault_request(
    vault_id: &str,
    intent: &CreateVaultOperationRecord,
) -> Result<CanonicalCreateVaultRequest, RuntimeError> {
    let path = format!("/api/v1/vaults/{vault_id}");
    let vault_type = match intent.vault_type {
        crate::CreateVaultType::Personal => "personal",
        crate::CreateVaultType::Shared => "team",
    };
    let body = serde_json::to_vec(&CanonicalCreateVaultBody {
        name: &intent.name,
        vault_type,
        encrypted_vault_key: &intent.encrypted_vault_key,
        icon: &intent.icon,
        image_key: intent.image.as_ref().map(|image| image.object_key.as_str()),
    })
    .map_err(|_| replica_invariant("canonical create-Vault body could not be serialized"))?;
    let fingerprint = create_vault_fingerprint(&path, &body);
    Ok(CanonicalCreateVaultRequest {
        path,
        body,
        fingerprint,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProtectedShareCapabilityRecord {
    pub account_id: AccountId,
    pub operation_id: String,
    pub ciphertext: String,
    pub iv: String,
    pub algorithm: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<ShareAppliedResultRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShareAppliedResultRecord {
    pub share_link_id: String,
    pub base_share_url: String,
    pub expires_at: String,
}

pub(super) fn share_capability_binding_matches(
    result: Option<&ShareAppliedResultRecord>,
    operation_kind: Option<OperationKind>,
    receipt: Option<&OperationReceiptRecord>,
) -> bool {
    match result {
        None => operation_kind == Some(OperationKind::CreateShare),
        Some(result) => {
            !result.share_link_id.is_empty()
                && !result.base_share_url.is_empty()
                && !result.expires_at.is_empty()
                && receipt.is_some_and(|receipt| {
                    receipt.kind == OperationKind::CreateShare
                        && matches!(&receipt.result, OperationOutcomeResult::ShareApplied {
                    share_link_id, base_share_url, expires_at,
                } if share_link_id == &result.share_link_id
                    && base_share_url == &result.base_share_url
                    && expires_at == &result.expires_at)
                })
        }
    }
}

pub(super) fn validate_share_capability_fields(
    capability: &ProtectedShareCapabilityRecord,
    account_id: &AccountId,
) -> Result<(), RuntimeError> {
    if capability.account_id != *account_id
        || capability.operation_id.is_empty()
        || capability.ciphertext.is_empty()
        || capability.iv.is_empty()
        || capability.algorithm != "AES-GCM-AAD-V1"
    {
        return Err(replica_invariant(
            "protected Share capability payload is invalid",
        ));
    }
    Ok(())
}

/// One accepted Attachment-bearing Move before its final HTTP request can exist.
///
/// This lives outside `operations`, so the ordinary dispatcher cannot observe incomplete work.
/// Every field is encrypted Server authority or opaque identity; transient credentials are absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachmentMovePreparationRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_item_category: Option<AuthorityItemCategory>,
    pub account_id: AccountId,
    pub operation_id: String,
    pub item_id: String,
    pub source_vault_id: String,
    pub target_vault_id: String,
    pub expected_item_version: i32,
    pub target_encrypted_data: String,
    pub target_encryption_algorithm: String,
    pub target_encryption_iv: String,
    pub source_attachments: Vec<AuthorityAttachmentRecord>,
    pub progress: Vec<AttachmentMoveProgress>,
    pub intent_fingerprint: Sha256Fingerprint,
    pub scheduling: OperationSchedulingState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AttachmentMoveRecovery {
    Prepared {
        preparation: Box<AttachmentMovePreparationRecord>,
    },
    RejectStaleAuthority {
        preparation: Box<AttachmentMovePreparationRecord>,
    },
}

impl AttachmentMoveRecovery {
    fn preparation(&self) -> &AttachmentMovePreparationRecord {
        match self {
            Self::Prepared { preparation } | Self::RejectStaleAuthority { preparation } => {
                preparation
            }
        }
    }

    fn preparation_mut(&mut self) -> &mut AttachmentMovePreparationRecord {
        match self {
            Self::Prepared { preparation } | Self::RejectStaleAuthority { preparation } => {
                preparation
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum AttachmentMoveProgress {
    Pending {
        attachment_id: String,
        expected_envelope_version: i32,
    },
    Encrypted {
        attachment_id: String,
        expected_envelope_version: i32,
        artifact: AttachmentMoveArtifactRef,
        payload: Box<PreparedMoveAttachment>,
        upload: AttachmentMoveUploadState,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachmentMoveArtifactRef {
    pub artifact_id: String,
    pub ciphertext_sha256: String,
    #[serde(with = "decimal_u64")]
    pub byte_length: u64,
}

pub(crate) fn attachment_move_artifact_ref(
    account_id: &AccountId,
    operation_id: &str,
    attachment_id: &str,
    ciphertext_sha256: &str,
    byte_length: u64,
) -> Result<AttachmentMoveArtifactRef, RuntimeError> {
    use sha2::{Digest, Sha256};
    if operation_id.is_empty()
        || attachment_id.is_empty()
        || byte_length == 0
        || !valid_ciphertext_digest(ciphertext_sha256)
    {
        return Err(replica_invariant(
            "Attachment Move artifact identity is invalid",
        ));
    }
    let mut hasher = Sha256::new();
    let byte_length_bytes = byte_length.to_be_bytes();
    for part in [
        b"bittery.attachment-move-artifact.v1".as_slice(),
        account_id.as_str().as_bytes(),
        operation_id.as_bytes(),
        attachment_id.as_bytes(),
        ciphertext_sha256.as_bytes(),
        &byte_length_bytes,
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    Ok(AttachmentMoveArtifactRef {
        artifact_id: format!("{:x}", hasher.finalize()),
        ciphertext_sha256: ciphertext_sha256.to_owned(),
        byte_length,
    })
}

impl AttachmentMoveProgress {
    pub(crate) fn attachment_id(&self) -> &str {
        match self {
            Self::Pending { attachment_id, .. } | Self::Encrypted { attachment_id, .. } => {
                attachment_id
            }
        }
    }

    pub(crate) fn expected_envelope_version(&self) -> i32 {
        match self {
            Self::Pending {
                expected_envelope_version,
                ..
            }
            | Self::Encrypted {
                expected_envelope_version,
                ..
            } => *expected_envelope_version,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AttachmentMoveUploadState {
    NeedsUpload,
    Uploaded,
}

/// The target-scoped encrypted metadata that becomes part of the final Move body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PreparedMoveAttachment {
    pub encrypted_name: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
    pub encrypted_attachment_key: String,
    pub attachment_key_iv: String,
    pub attachment_key_algorithm: String,
    pub encrypted_content_type: String,
    pub encrypted_content_type_iv: String,
}

/// One encrypted optimistic Item overlay, keyed by the Item and the Operation that owes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplicaItemRecord {
    pub account_id: AccountId,
    pub item_id: String,
    pub vault_id: String,
    pub operation_id: String,
    pub category: AuthorityItemCategory,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
    pub encryption_version: i32,
    pub encrypted_by_user_id: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default = "initial_item_version")]
    pub version: i32,
    /// When this Device accepted the create, in the same RFC 3339 spelling the Server uses.
    ///
    /// It is this Device's own truth until authority replaces it, and it is durable because a
    /// list that sorts by time must not reshuffle across a restart. `default` keeps an overlay
    /// written before this field existed loadable rather than bricking the Account.
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub attachments: Vec<AuthorityAttachmentRecord>,
    #[serde(default)]
    pub permanently_deleted: bool,
}

fn initial_item_version() -> i32 {
    1
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    dead_code,
    reason = "the closed Replica state schema is implemented in slices"
)]
pub(crate) enum ReplicaState {
    #[default]
    Cold,
    Bootstrapping,
    Ready,
    RefreshRequired,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) enum SyncCursor {
    #[default]
    Cold,
    CapturedEmpty,
    CapturedValue {
        id: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) enum BootstrapPageCursor {
    #[default]
    VaultsInitial,
    VaultsAfter {
        cursor: String,
    },
    ItemsInitial,
    ItemsAfter {
        cursor: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum BootstrapPhase {
    Vaults,
    Items,
}

impl BootstrapPageCursor {
    pub(crate) fn phase(&self) -> BootstrapPhase {
        match self {
            Self::VaultsInitial | Self::VaultsAfter { .. } => BootstrapPhase::Vaults,
            Self::ItemsInitial | Self::ItemsAfter { .. } => BootstrapPhase::Items,
        }
    }

    pub(crate) fn cursor(&self) -> Option<&str> {
        match self {
            Self::VaultsInitial | Self::ItemsInitial => None,
            Self::VaultsAfter { cursor } | Self::ItemsAfter { cursor } => Some(cursor),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) enum BootstrapContinuation {
    Final,
    More { next_cursor: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct BootstrapGenerationId(pub(crate) String);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct BootstrapPageIdentity {
    pub(crate) phase: BootstrapPhase,
    #[serde(with = "decimal_u64")]
    pub(crate) ordinal: u64,
}

impl BootstrapPageIdentity {
    pub(crate) fn vaults(ordinal: u64) -> Self {
        Self {
            phase: BootstrapPhase::Vaults,
            ordinal,
        }
    }

    pub(crate) fn items(ordinal: u64) -> Self {
        Self {
            phase: BootstrapPhase::Items,
            ordinal,
        }
    }

    pub(crate) fn record_id(self) -> String {
        let phase = match self.phase {
            BootstrapPhase::Vaults => "vaults",
            BootstrapPhase::Items => "items",
        };
        format!("{phase}:{}", self.ordinal)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct Sha256Fingerprint(pub(crate) [u8; 32]);

impl Sha256Fingerprint {
    pub(crate) fn of_bytes(bytes: &[u8]) -> Self {
        use sha2::{Digest, Sha256};
        Self(Sha256::digest(bytes).into())
    }

    fn to_hex(self) -> String {
        self.0.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn from_hex(value: &str) -> Result<Self, String> {
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("expected a 32-byte hex SHA-256 fingerprint".into());
        }
        let mut bytes = [0u8; 32];
        for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
            bytes[index] = u8::from_str_radix(
                std::str::from_utf8(chunk).expect("hex digits are valid UTF-8"),
                16,
            )
            .map_err(|_| "expected a 32-byte hex SHA-256 fingerprint".to_owned())?;
        }
        Ok(Self(bytes))
    }
}

impl Serialize for Sha256Fingerprint {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Sha256Fingerprint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::from_hex(&value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    dead_code,
    reason = "the authority schema mirrors every current Server value"
)]
pub(crate) enum AuthorityVaultType {
    Personal,
    Team,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    dead_code,
    reason = "the authority schema mirrors every current Server value"
)]
pub(crate) enum AuthorityVaultRole {
    Owner,
    Admin,
    Member,
    ReadOnly,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    dead_code,
    reason = "the authority schema mirrors every current Server value"
)]
pub(crate) enum AuthorityItemCategory {
    Login,
    SecureNote,
    CreditCard,
    Identity,
    Totp,
}

impl From<crate::server_contract::ItemCategory> for AuthorityItemCategory {
    fn from(category: crate::server_contract::ItemCategory) -> Self {
        use crate::server_contract::ItemCategory;
        match category {
            ItemCategory::Login => Self::Login,
            ItemCategory::SecureNote => Self::SecureNote,
            ItemCategory::CreditCard => Self::CreditCard,
            ItemCategory::Identity => Self::Identity,
            ItemCategory::Totp => Self::Totp,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct AuthorityVaultRecord {
    pub id: String,
    pub name: String,
    pub vault_type: AuthorityVaultType,
    pub icon: Option<String>,
    pub image_url: Option<String>,
    pub encrypted_vault_key: String,
    pub role: AuthorityVaultRole,
    /// Missing in old Server responses and old Replica rows; never infer it from a wrapper.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_version: Option<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct AuthorityAttachmentRecord {
    pub id: String,
    pub item_id: String,
    pub vault_id: String,
    pub storage_key: String,
    pub encrypted_name: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
    pub encrypted_attachment_key: String,
    pub attachment_key_iv: String,
    pub attachment_key_algorithm: String,
    pub encrypted_content_type: String,
    pub encrypted_content_type_iv: String,
    pub envelope_version: i32,
    pub file_size: i32,
    pub uploaded_by: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct AuthorityItemRecord {
    pub id: String,
    pub vault_id: String,
    pub category: AuthorityItemCategory,
    pub favorite: bool,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
    pub version: i32,
    pub encryption_version: i32,
    pub encrypted_by_user_id: String,
    pub last_modified_by: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub attachments: Vec<AuthorityAttachmentRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct BootstrapGuard {
    pub account_id: AccountId,
    pub user_id: String,
    pub incarnation: Incarnation,
    pub expected_replica_revision: u64,
    pub expected_lock_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct BeginBootstrapPlan {
    pub guard: BootstrapGuard,
    pub generation_id: BootstrapGenerationId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct MarkRefreshRequiredPlan {
    pub guard: BootstrapGuard,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct StageBootstrapPagePlan {
    pub guard: BootstrapGuard,
    pub generation_id: BootstrapGenerationId,
    pub page_identity: BootstrapPageIdentity,
    pub request_cursor: BootstrapPageCursor,
    pub raw_response_fingerprint: Sha256Fingerprint,
    pub pinned_watermark: SyncCursor,
    pub continuation: BootstrapContinuation,
    /// Authenticated page-level capability marker; absent on old Servers and synthetic sources.
    pub vault_key_version_included: bool,
    pub vaults: Vec<AuthorityVaultRecord>,
    pub items: Vec<AuthorityItemRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct PromoteBootstrapPlan {
    /// Key-only Vault identities absent from this complete staged authority.
    pub additional_retired_vault_ids: Vec<String>,
    pub guard: BootstrapGuard,
    pub generation_id: BootstrapGenerationId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct AbandonBootstrapPlan {
    pub guard: BootstrapGuard,
    pub generation_id: BootstrapGenerationId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct CleanupBootstrapGenerationPlan {
    pub guard: BootstrapGuard,
    pub generation_id: BootstrapGenerationId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) enum StageBootstrapPageResult {
    Applied,
    Replayed,
    ReplayMismatch,
    Stale { actual_revision: u64 },
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) enum CleanupBootstrapGenerationResult {
    Applied,
    Protected,
    Stale { actual_revision: u64 },
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct BootstrapGenerationRecord {
    pub generation_id: BootstrapGenerationId,
    pub fallback_state: ReplicaState,
    pub pinned_watermark: SyncCursor,
    pub next_page_identity: BootstrapPageIdentity,
    pub next_page_cursor: BootstrapPageCursor,
    pub final_page_staged: bool,
    /// Aggregate proof for every Vault page in this generation, persisted with staged pages.
    /// Old rows default to false and cannot satisfy Rotation preflight.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub vault_key_version_proved: bool,
    #[serde(
        default,
        deserialize_with = "present_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub legacy_admission: Option<LegacyAdmissionOrigin>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyItemCacheBaseline {
    /// Exact source spelling retained as evidence.
    pub server_url: String,
    /// Core's validated comparison identity for the source spelling.
    pub normalized_server_url: String,
    pub cursor: SyncCursor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyItemCacheMetadata {
    pub last_full_sync_at: u64,
    pub item_count: u64,
    pub cache_version: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_baseline: Option<LegacyItemCacheBaseline>,
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn present_optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum LegacyCheckpointEvidence {
    Missing {},
    CapturedEmpty {},
    CapturedValue { id: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum LegacyAdmissionRefreshReason {
    CapturedFailedCreate,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(remote = "Self")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LegacyAdmissionOrigin {
    pub manifest_entries_sha256: String,
    pub account_id: AccountId,
    pub user_id: String,
    pub incarnation: Incarnation,
    pub normalized_server_url: String,
    #[serde(deserialize_with = "required_nullable")]
    pub source_active_generation: Option<String>,
    pub state_key: String,
    pub items_key_prefix: String,
    pub vaults_key_prefix: String,
    pub items_primed: bool,
    pub vaults_primed: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub metadata: Option<LegacyItemCacheMetadata>,
    pub source_id: String,
    pub sync_baseline: LegacyCheckpointEvidence,
    pub last_sync_cursor: LegacyCheckpointEvidence,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "legacy_admission::present"
    )]
    pub refresh_reason: Option<LegacyAdmissionRefreshReason>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LegacyAdmissionBootstrap {
    pub origin: LegacyAdmissionOrigin,
    pub cursor: SyncCursor,
    pub vaults: Vec<AuthorityVaultRecord>,
    pub items: Vec<AuthorityItemRecord>,
}

crate::wire::map_only_serde!(
    LegacyItemCacheBaseline,
    LegacyItemCacheMetadata,
    LegacyCheckpointEvidence,
    LegacyAdmissionOrigin,
);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct BootstrapPageReceipt {
    pub generation_id: BootstrapGenerationId,
    pub page_identity: BootstrapPageIdentity,
    pub request_cursor: BootstrapPageCursor,
    pub raw_response_fingerprint: Sha256Fingerprint,
    pub pinned_watermark: SyncCursor,
    pub continuation: BootstrapContinuation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct BootstrapAuthoritySnapshot {
    pub state: ReplicaState,
    pub active_generation: Option<BootstrapGenerationId>,
    pub active_cursor: SyncCursor,
    pub staging_generation: Option<BootstrapGenerationId>,
    pub visible_vaults: Vec<AuthorityVaultRecord>,
    pub visible_items: Vec<AuthorityItemRecord>,
    pub generation_ids: Vec<BootstrapGenerationId>,
    pub generation_records: Vec<BootstrapGenerationRecord>,
    pub page_receipts: Vec<BootstrapPageReceipt>,
    pub staged_vault_count: usize,
    pub staged_item_count: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct BootstrapAuthority {
    pub(crate) policy_verification_pending: bool,
    pub(crate) pending_vault_retirements: Vec<String>,
    pub(crate) state: ReplicaState,
    pub(crate) active_generation: Option<BootstrapGenerationId>,
    pub(crate) active_cursor: SyncCursor,
    pub(crate) staging_generation: Option<BootstrapGenerationId>,
    pub(crate) generations: HashMap<BootstrapGenerationId, BootstrapGenerationRecord>,
    pub(crate) pages: HashMap<(BootstrapGenerationId, BootstrapPageIdentity), BootstrapPageReceipt>,
    pub(crate) vaults: HashMap<(BootstrapGenerationId, String), AuthorityVaultRecord>,
    pub(crate) items: HashMap<(BootstrapGenerationId, String), AuthorityItemRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[cfg_attr(feature = "persistence-contract-schema", derive(schemars::JsonSchema))]
pub(crate) enum PlanResult {
    Applied {
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "persistence-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        replica_revision: u64,
    },
    Stale {
        #[serde(with = "decimal_u64")]
        #[cfg_attr(
            feature = "persistence-contract-schema",
            schemars(schema_with = "decimal_u64::json_schema")
        )]
        actual_revision: u64,
    },
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ForegroundAttachmentCommitResult {
    Applied { replica_revision: u64 },
    StaleReplica { actual_revision: u64 },
    StaleAuthority { current_item_version: i32 },
    Missing,
}

pub(crate) enum RecomputedPlanResult {
    Applied { snapshot: ReplicaSnapshot },
    Fenced { snapshot: ReplicaSnapshot },
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReplicaSnapshot {
    pub account_id: AccountId,
    pub user_id: String,
    pub incarnation: Incarnation,
    #[serde(with = "decimal_u64")]
    pub revision: u64,
    #[serde(with = "decimal_u64")]
    pub lock_epoch: u64,
    pub items: Vec<ReplicaItemRecord>,
    pub operations: Vec<OperationRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cross_account_moves: Vec<CrossAccountMoveEntry>,
    pub share_capabilities: Vec<ProtectedShareCapabilityRecord>,
    pub attachment_move_preparations: Vec<AttachmentMovePreparationRecord>,
    pub receipts: Vec<OperationReceiptRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rotation_attempts: Vec<RotationAttemptRecord>,
    pub failure: Option<RuntimeErrorCode>,
    #[serde(skip)]
    pub bootstrap: BootstrapAuthority,
}

pub(super) fn apply_plan(
    current: ReplicaSnapshot,
    plan: GuardedCommitPlan,
) -> Result<ReplicaSnapshot, RuntimeError> {
    let validates_retirement = plan
        .mutations
        .iter()
        .any(|mutation| matches!(mutation, PlanMutation::RetireVaults { .. }));
    let mut next = AccountReplica::from_snapshot(current);
    for mutation in plan.mutations {
        next.apply(mutation)?;
    }
    next.revision = next.revision.checked_add(1).ok_or_else(|| {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Replica revision overflowed",
        )
    })?;
    if validates_retirement || !next.cross_account_moves.is_empty() {
        next.validate_durable_work()?;
    }
    Ok(next.snapshot())
}

impl ReplicaSnapshot {
    /// Pending deletion is derived from accepted work, never a second host or in-memory list.
    pub(crate) fn require_vault_accepting_work(&self, vault_id: &str) -> Result<(), RuntimeError> {
        if self
            .rotation_attempts
            .iter()
            .any(|attempt| attempt.fences_vault(vault_id))
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccessDenied,
                "Vault Key rotation awaits current authority",
            ));
        }
        if self
            .bootstrap
            .pending_vault_retirements
            .iter()
            .any(|pending| pending == vault_id)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccessDenied,
                "Vault authority retirement is pending",
            ));
        }
        if self.operations.iter().any(|operation| {
            operation.kind == OperationKind::DeleteVault && operation.vault_id() == vault_id
        }) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccessDenied,
                "Vault deletion is pending",
            ));
        }
        Ok(())
    }

    pub(crate) fn item_has_optimistic_owner(&self, item_id: &str) -> bool {
        self.operations.iter().any(|operation| {
            !operation.is_legacy_held() && operation.target.item_id() == Some(item_id)
        }) || self
            .attachment_move_preparations
            .iter()
            .any(|preparation| preparation.item_id == item_id)
            || self
                .cross_account_moves
                .iter()
                .any(|record| record.owns_source_item() && record.source_item_id() == item_id)
            || self.items.iter().any(|overlay| {
                overlay.item_id == item_id
                    && !self.operations.iter().any(|operation| {
                        operation.operation_id == overlay.operation_id && operation.is_legacy_held()
                    })
            })
    }
}

#[derive(Clone)]
pub(super) struct AccountReplica {
    pub(super) account_id: AccountId,
    pub(super) user_id: String,
    pub(super) incarnation: Incarnation,
    pub(super) revision: u64,
    pub(super) lock_epoch: u64,
    pub(super) items: HashMap<String, ReplicaItemRecord>,
    pub(super) operations: HashMap<String, OperationRecord>,
    pub(super) cross_account_moves: HashMap<String, CrossAccountMoveEntry>,
    pub(super) share_capabilities: HashMap<String, ProtectedShareCapabilityRecord>,
    pub(super) attachment_move_preparations: HashMap<String, AttachmentMovePreparationRecord>,
    pub(super) receipts: HashMap<String, OperationReceiptRecord>,
    pub(super) rotation_attempts: HashMap<String, RotationAttemptRecord>,
    pub(super) failure: Option<RuntimeErrorCode>,
    pub(super) bootstrap: BootstrapAuthority,
}

impl AccountReplica {
    fn transition_image_protection(
        &mut self,
        operation_id: String,
        witness: crate::vault_image::protected::ProtectedImageWitness,
        cleanup_complete: bool,
    ) -> Result<(), RuntimeError> {
        let mut operation = self.operations.get(&operation_id).cloned().ok_or_else(|| {
            replica_invariant("Cannot protect an unknown accepted image Operation")
        })?;
        let image = operation
            .create_vault
            .as_mut()
            .and_then(|intent| intent.image.as_mut())
            .or_else(|| {
                operation
                    .update_vault
                    .as_mut()
                    .map(|intent| &mut intent.image)
            })
            .ok_or_else(|| replica_invariant("Operation has no accepted image"))?;
        crate::vault_image::protected::validate_witness(&witness, image.byte_length)?;
        match &image.protected_witness {
            Some(existing) if existing != &witness => {
                return Err(replica_invariant(
                    "Accepted protected image witness is immutable",
                ));
            }
            None if cleanup_complete => {
                return Err(replica_invariant(
                    "Raw cleanup cannot complete before protection",
                ));
            }
            None => {
                image.protected_witness = Some(witness);
                image.raw_cleanup_pending = true;
            }
            Some(_) if cleanup_complete => image.raw_cleanup_pending = false,
            Some(_) => {} // A replay cannot resurrect an already acknowledged cleanup duty.
        }
        check_immutable_request(&operation)?;
        validate_create_vault_operation_context(&operation, &self.account_id, &self.user_id)?;
        self.operations.insert(operation_id, operation);
        Ok(())
    }

    pub(super) fn from_snapshot(snapshot: ReplicaSnapshot) -> Self {
        Self {
            account_id: snapshot.account_id,
            user_id: snapshot.user_id,
            incarnation: snapshot.incarnation,
            revision: snapshot.revision,
            lock_epoch: snapshot.lock_epoch,
            items: snapshot
                .items
                .into_iter()
                .map(|item| (item.item_id.clone(), item))
                .collect(),
            operations: snapshot
                .operations
                .into_iter()
                .map(|operation| (operation.operation_id.clone(), operation))
                .collect(),
            cross_account_moves: snapshot
                .cross_account_moves
                .into_iter()
                .map(|record| (record.operation_id().to_owned(), record))
                .collect(),
            share_capabilities: snapshot
                .share_capabilities
                .into_iter()
                .map(|capability| (capability.operation_id.clone(), capability))
                .collect(),
            attachment_move_preparations: snapshot
                .attachment_move_preparations
                .into_iter()
                .map(|preparation| (preparation.operation_id.clone(), preparation))
                .collect(),
            receipts: snapshot
                .receipts
                .into_iter()
                .map(|receipt| (receipt.operation_id.clone(), receipt))
                .collect(),
            rotation_attempts: snapshot
                .rotation_attempts
                .into_iter()
                .map(|attempt| (attempt.start_operation_id.clone(), attempt))
                .collect(),
            failure: snapshot.failure,
            bootstrap: snapshot.bootstrap,
        }
    }

    pub(super) fn validate_durable_work(&self) -> Result<(), RuntimeError> {
        for item in self.items.values() {
            if let Some(record) = self.cross_account_moves.get(&item.operation_id) {
                record.validate_source_overlay(&self.account_id, item)?;
            }
            let witness = self
                .operations
                .get(&item.operation_id)
                .and_then(|operation| operation.accepted_item_category.as_ref())
                .or_else(|| {
                    self.attachment_move_preparations
                        .get(&item.operation_id)
                        .and_then(|preparation| preparation.accepted_item_category.as_ref())
                })
                .or_else(|| {
                    self.cross_account_moves
                        .get(&item.operation_id)
                        .and_then(CrossAccountMoveEntry::captured)
                        .map(|record| &record.source.category)
                });
            vault_retirement::validate_category(witness, &item.category)?;
        }
        let mut operation_ids = HashSet::new();
        let mut item_ids = HashSet::new();
        for operation in self.operations.values() {
            check_immutable_request(operation)?;
            validate_create_vault_operation_context(operation, &self.account_id, &self.user_id)?;
            if let Some(admission) = &operation.legacy_admission {
                let overlay = self
                    .items
                    .values()
                    .find(|item| item.operation_id == operation.operation_id);
                admission.validate(&self.account_id, operation, overlay)?;
            }
            if let Some(recovery) = &operation.attachment_move_recovery {
                let preparation = recovery.preparation();
                self.check_attachment_move_preparation(preparation, false)?;
                let reconstructed = match recovery {
                    AttachmentMoveRecovery::Prepared { .. } => {
                        prepared_move_operation(preparation)?
                    }
                    AttachmentMoveRecovery::RejectStaleAuthority { .. } => {
                        rejection_operation(preparation)?
                    }
                };
                if reconstructed != *operation {
                    return Err(replica_invariant(
                        "Attachment Move recovery does not match its immutable request",
                    ));
                }
            }
            if !operation_ids.insert(operation.operation_id.clone())
                || (!operation.is_legacy_held()
                    && operation
                        .target
                        .item_id()
                        .is_some_and(|item_id| !item_ids.insert(item_id.to_owned())))
                || self.receipts.contains_key(&operation.operation_id)
            {
                return Err(replica_invariant(
                    "Replica active Operation identity is inconsistent",
                ));
            }
        }
        for capability in self.share_capabilities.values() {
            let matching_operation = self.operations.get(&capability.operation_id);
            let matching_receipt = self.receipts.get(&capability.operation_id);
            validate_share_capability_fields(capability, &self.account_id)?;
            if !share_capability_binding_matches(
                capability.result.as_ref(),
                matching_operation
                    .filter(|operation| operation.operation_id == capability.operation_id)
                    .map(|operation| operation.kind),
                matching_receipt,
            ) {
                return Err(replica_invariant(
                    "protected Share capability is not bound to one active CreateShare Operation",
                ));
            }
        }
        for preparation in self.attachment_move_preparations.values() {
            self.check_attachment_move_preparation(preparation, false)?;
            if !operation_ids.insert(preparation.operation_id.clone())
                || !item_ids.insert(preparation.item_id.clone())
                || self.receipts.contains_key(&preparation.operation_id)
            {
                return Err(replica_invariant(
                    "Replica Attachment Move identity is inconsistent",
                ));
            }
        }
        for record in self.cross_account_moves.values() {
            if record.source_unavailable().is_some()
                && record.owns_source_item()
                && self.items.contains_key(record.source_item_id())
            {
                return Err(replica_invariant(
                    "Unavailable source evidence cannot coexist with a source overlay",
                ));
            }
            record.validate(&self.account_id, &self.user_id)?;
            for child_id in record.reserved_child_operation_ids() {
                if !operation_ids.insert(child_id.clone()) || self.receipts.contains_key(&child_id)
                {
                    return Err(replica_invariant(
                        "Cross-Account Move child identity conflicts with accepted work",
                    ));
                }
            }
            if !operation_ids.insert(record.operation_id().to_owned())
                || self.receipts.contains_key(record.operation_id())
                || (record.owns_source_item()
                    && !item_ids.insert(record.source_item_id().to_owned()))
            {
                return Err(replica_invariant(
                    "Cross-Account Move identity conflicts with accepted work",
                ));
            }
        }
        for receipt in self.receipts.values() {
            validate_operation_receipt(receipt, &self.user_id)?;
            if receipt.completed_at_revision == 0 || receipt.completed_at_revision > self.revision {
                return Err(replica_invariant(
                    "Operation receipt completion revision is inconsistent",
                ));
            }
        }
        self.validate_rotation_attempts()?;
        Ok(())
    }

    #[allow(dead_code, reason = "the persistence wire invokes this model next")]
    pub(super) fn begin_bootstrap(
        &mut self,
        plan: BeginBootstrapPlan,
    ) -> Result<PlanResult, RuntimeError> {
        if let Some(result) = self.guard_result(&plan.guard) {
            return Ok(result);
        }
        self.bootstrap.validate()?;
        validate_identifier(&plan.generation_id.0, "Bootstrap generation")?;
        if self.bootstrap.staging_generation.is_some() {
            return Err(replica_invariant(
                "a Bootstrap generation is already staging",
            ));
        }
        if self.bootstrap.generations.contains_key(&plan.generation_id)
            || self
                .bootstrap
                .pages
                .keys()
                .any(|(generation_id, _)| generation_id == &plan.generation_id)
            || self
                .bootstrap
                .vaults
                .keys()
                .any(|(generation_id, _)| generation_id == &plan.generation_id)
            || self
                .bootstrap
                .items
                .keys()
                .any(|(generation_id, _)| generation_id == &plan.generation_id)
        {
            return Err(replica_invariant(
                "Bootstrap generation identity was reused",
            ));
        }
        let fallback_state = self.bootstrap.state;
        if fallback_state == ReplicaState::Bootstrapping {
            return Err(replica_invariant("Bootstrap fallback state is invalid"));
        }
        let next_revision = increment_revision(self.revision)?;
        let mut next = self.bootstrap.clone();
        next.generations.insert(
            plan.generation_id.clone(),
            BootstrapGenerationRecord {
                generation_id: plan.generation_id.clone(),
                fallback_state,
                pinned_watermark: SyncCursor::Cold,
                next_page_identity: BootstrapPageIdentity::vaults(0),
                next_page_cursor: BootstrapPageCursor::VaultsInitial,
                final_page_staged: false,
                vault_key_version_proved: true,
                legacy_admission: None,
            },
        );
        next.state = ReplicaState::Bootstrapping;
        next.staging_generation = Some(plan.generation_id);
        next.validate()?;
        self.bootstrap = next;
        self.revision = next_revision;
        Ok(PlanResult::Applied {
            replica_revision: self.revision,
        })
    }

    pub(super) fn set_policy_verification_pending(
        &mut self,
        guard: BootstrapGuard,
        pending: bool,
    ) -> Result<PlanResult, RuntimeError> {
        if let Some(result) = self.guard_result(&guard) {
            return Ok(result);
        }
        self.bootstrap.validate()?;
        if self.bootstrap.policy_verification_pending != pending {
            self.revision = increment_revision(self.revision)?;
            self.bootstrap.policy_verification_pending = pending;
        }
        Ok(PlanResult::Applied {
            replica_revision: self.revision,
        })
    }

    pub(super) fn mark_refresh_required(
        &mut self,
        plan: MarkRefreshRequiredPlan,
    ) -> Result<PlanResult, RuntimeError> {
        if let Some(result) = self.guard_result(&plan.guard) {
            return Ok(result);
        }
        self.bootstrap.validate()?;
        match self.bootstrap.state {
            ReplicaState::RefreshRequired => {
                return Ok(PlanResult::Applied {
                    replica_revision: self.revision,
                });
            }
            ReplicaState::Ready => {}
            ReplicaState::Cold | ReplicaState::Bootstrapping => {
                return Err(replica_invariant(
                    "refresh is only valid from a ready Replica",
                ));
            }
        }
        let next_revision = increment_revision(self.revision)?;
        let mut next = self.bootstrap.clone();
        next.state = ReplicaState::RefreshRequired;
        next.validate()?;
        self.bootstrap = next;
        self.revision = next_revision;
        Ok(PlanResult::Applied {
            replica_revision: self.revision,
        })
    }

    #[allow(dead_code, reason = "the persistence wire invokes this model next")]
    pub(super) fn stage_bootstrap_page(
        &mut self,
        plan: StageBootstrapPagePlan,
    ) -> Result<StageBootstrapPageResult, RuntimeError> {
        if let Some(result) = self.stage_guard_result(&plan.guard) {
            return Ok(result);
        }
        self.bootstrap.validate()?;
        if self.bootstrap.state != ReplicaState::Bootstrapping
            || self.bootstrap.staging_generation.as_ref() != Some(&plan.generation_id)
        {
            return Ok(StageBootstrapPageResult::Stale {
                actual_revision: self.revision,
            });
        }
        let receipt_key = (plan.generation_id.clone(), plan.page_identity);
        if let Some(receipt) = self.bootstrap.pages.get(&receipt_key) {
            return Ok(
                if receipt.request_cursor == plan.request_cursor
                    && receipt.raw_response_fingerprint == plan.raw_response_fingerprint
                {
                    StageBootstrapPageResult::Replayed
                } else {
                    StageBootstrapPageResult::ReplayMismatch
                },
            );
        }
        let generation = self
            .bootstrap
            .generations
            .get(&plan.generation_id)
            .ok_or_else(|| replica_invariant("staging Bootstrap generation is missing"))?;
        if generation.final_page_staged
            || generation.next_page_identity != plan.page_identity
            || generation.next_page_cursor != plan.request_cursor
            || plan.page_identity.phase != plan.request_cursor.phase()
        {
            return Err(replica_invariant(
                "Bootstrap page does not match the expected page position",
            ));
        }
        validate_captured_cursor(&plan.pinned_watermark)?;
        if generation.pinned_watermark != SyncCursor::Cold
            && generation.pinned_watermark != plan.pinned_watermark
        {
            return Err(replica_invariant(
                "Bootstrap watermark changed between pages",
            ));
        }
        validate_continuation(&plan.continuation)?;
        match plan.request_cursor.phase() {
            BootstrapPhase::Vaults if !plan.items.is_empty() => {
                return Err(replica_invariant("Vault Bootstrap page carried Items"));
            }
            BootstrapPhase::Items if !plan.vaults.is_empty() => {
                return Err(replica_invariant("Item Bootstrap page carried Vaults"));
            }
            _ => {}
        }
        if plan.request_cursor.phase() == BootstrapPhase::Items && plan.vault_key_version_included {
            return Err(replica_invariant(
                "Item Bootstrap page cannot prove Vault key versions",
            ));
        }
        validate_authority_page(&plan.vaults, &plan.items)?;
        for item in &plan.items {
            if self
                .bootstrap
                .items
                .contains_key(&(plan.generation_id.clone(), item.id.clone()))
            {
                return Err(replica_invariant(
                    "Bootstrap Item appeared in more than one page",
                ));
            }
        }

        let next_ordinal = plan
            .page_identity
            .ordinal
            .checked_add(1)
            .ok_or_else(|| replica_invariant("Bootstrap page identity overflowed"))?;
        let mut next = self.bootstrap.clone();
        for vault in &plan.vaults {
            next.vaults.insert(
                (plan.generation_id.clone(), vault.id.clone()),
                vault.clone(),
            );
        }
        for item in &plan.items {
            next.items
                .insert((plan.generation_id.clone(), item.id.clone()), item.clone());
        }
        next.pages.insert(
            receipt_key,
            BootstrapPageReceipt {
                generation_id: plan.generation_id.clone(),
                page_identity: plan.page_identity,
                request_cursor: plan.request_cursor.clone(),
                raw_response_fingerprint: plan.raw_response_fingerprint,
                pinned_watermark: plan.pinned_watermark.clone(),
                continuation: plan.continuation.clone(),
            },
        );
        let generation = next
            .generations
            .get_mut(&plan.generation_id)
            .expect("staging generation was checked above");
        generation.pinned_watermark = plan.pinned_watermark;
        if plan.request_cursor.phase() == BootstrapPhase::Vaults {
            generation.vault_key_version_proved &= plan.vault_key_version_included
                && plan.vaults.iter().all(|vault| vault.key_version.is_some());
        }
        match plan.continuation {
            BootstrapContinuation::Final
                if plan.request_cursor.phase() == BootstrapPhase::Vaults =>
            {
                generation.next_page_cursor = BootstrapPageCursor::ItemsInitial;
                generation.next_page_identity = BootstrapPageIdentity::items(0);
            }
            BootstrapContinuation::Final => {
                generation.final_page_staged = true;
                generation.next_page_identity = BootstrapPageIdentity::items(next_ordinal);
            }
            BootstrapContinuation::More { next_cursor } => {
                generation.next_page_identity = match plan.request_cursor.phase() {
                    BootstrapPhase::Vaults => BootstrapPageIdentity::vaults(next_ordinal),
                    BootstrapPhase::Items => BootstrapPageIdentity::items(next_ordinal),
                };
                generation.next_page_cursor = match plan.request_cursor.phase() {
                    BootstrapPhase::Vaults => BootstrapPageCursor::VaultsAfter {
                        cursor: next_cursor,
                    },
                    BootstrapPhase::Items => BootstrapPageCursor::ItemsAfter {
                        cursor: next_cursor,
                    },
                };
            }
        }
        next.validate()?;
        self.bootstrap = next;
        Ok(StageBootstrapPageResult::Applied)
    }

    #[allow(dead_code, reason = "the persistence wire invokes this model next")]
    pub(super) fn promote_bootstrap(
        &mut self,
        plan: PromoteBootstrapPlan,
    ) -> Result<PlanResult, RuntimeError> {
        if let Some(result) = self.guard_result(&plan.guard) {
            return Ok(result);
        }
        self.bootstrap.validate()?;
        if self.bootstrap.staging_generation.as_ref() != Some(&plan.generation_id) {
            return Ok(PlanResult::Stale {
                actual_revision: self.revision,
            });
        }
        let generation = self
            .bootstrap
            .generations
            .get(&plan.generation_id)
            .ok_or_else(|| replica_invariant("staging Bootstrap generation is missing"))?;
        if !generation.final_page_staged {
            return Err(replica_invariant(
                "cannot promote an incomplete Bootstrap generation",
            ));
        }
        validate_captured_cursor(&generation.pinned_watermark)?;
        let pinned_watermark = generation.pinned_watermark.clone();
        let next_revision = increment_revision(self.revision)?;
        let visible: HashSet<_> = self
            .bootstrap
            .vaults
            .iter()
            .filter(|((generation, _), _)| generation == &plan.generation_id)
            .map(|((_, id), _)| id.clone())
            .collect();
        validate_retired_vault_ids(&plan.additional_retired_vault_ids)?;
        if plan
            .additional_retired_vault_ids
            .iter()
            .any(|id| visible.contains(id))
        {
            return Err(replica_invariant(
                "additional Vault retirement must be absent from complete authority",
            ));
        }
        let mut retired: Vec<_> = self
            .bootstrap
            .vaults
            .keys()
            .map(|(_, id)| id.clone())
            .filter(|id| !visible.contains(id))
            .collect();
        retired.extend(plan.additional_retired_vault_ids);
        retired.sort();
        retired.dedup();
        let mut next = self.clone();
        next.bootstrap.active_generation = Some(plan.generation_id);
        next.bootstrap.active_cursor = pinned_watermark;
        next.bootstrap.staging_generation = None;
        next.bootstrap.state = ReplicaState::Ready;
        next.retire_vault_authority(&retired)?;
        next.bootstrap.validate()?;
        let fresh_items: Vec<_> = next
            .bootstrap
            .items
            .iter()
            .filter(|((generation, _), _)| {
                Some(generation) == next.bootstrap.active_generation.as_ref()
            })
            .map(|((_, id), item)| (id.clone(), item.version))
            .collect();
        for (item_id, version) in fresh_items {
            next.reconcile_rejected_move_source(&item_id, version);
        }
        next.revision = next_revision;
        next.validate_durable_work()?;
        *self = next;
        Ok(PlanResult::Applied {
            replica_revision: self.revision,
        })
    }

    #[allow(dead_code, reason = "the persistence wire invokes this model next")]
    pub(super) fn abandon_bootstrap(
        &mut self,
        plan: AbandonBootstrapPlan,
    ) -> Result<PlanResult, RuntimeError> {
        if let Some(result) = self.guard_result(&plan.guard) {
            return Ok(result);
        }
        self.bootstrap.validate()?;
        if self.bootstrap.staging_generation.as_ref() != Some(&plan.generation_id) {
            return Ok(PlanResult::Stale {
                actual_revision: self.revision,
            });
        }
        let fallback_state = self
            .bootstrap
            .generations
            .get(&plan.generation_id)
            .ok_or_else(|| replica_invariant("staging Bootstrap generation is missing"))?
            .fallback_state;
        let next_revision = increment_revision(self.revision)?;
        let mut next = self.bootstrap.clone();
        next.staging_generation = None;
        next.state = fallback_state;
        next.validate()?;
        self.bootstrap = next;
        self.revision = next_revision;
        Ok(PlanResult::Applied {
            replica_revision: self.revision,
        })
    }

    #[allow(dead_code, reason = "the persistence wire invokes this model next")]
    pub(super) fn cleanup_bootstrap_generation(
        &mut self,
        plan: CleanupBootstrapGenerationPlan,
    ) -> Result<CleanupBootstrapGenerationResult, RuntimeError> {
        if self.account_id != plan.guard.account_id {
            return Ok(CleanupBootstrapGenerationResult::Missing);
        }
        if !self.matches_guard(&plan.guard) {
            return Ok(CleanupBootstrapGenerationResult::Stale {
                actual_revision: self.revision,
            });
        }
        self.bootstrap.validate()?;
        if self.bootstrap.active_generation.as_ref() == Some(&plan.generation_id)
            || self.bootstrap.staging_generation.as_ref() == Some(&plan.generation_id)
        {
            return Ok(CleanupBootstrapGenerationResult::Protected);
        }
        let mut next = self.bootstrap.clone();
        next.generations.remove(&plan.generation_id);
        next.pages
            .retain(|(generation_id, _), _| generation_id != &plan.generation_id);
        next.vaults
            .retain(|(generation_id, _), _| generation_id != &plan.generation_id);
        next.items
            .retain(|(generation_id, _), _| generation_id != &plan.generation_id);
        next.validate()?;
        self.bootstrap = next;
        Ok(CleanupBootstrapGenerationResult::Applied)
    }

    pub(super) fn apply_authoritative_item(
        &mut self,
        expected_cursor: &SyncCursor,
        next_cursor: SyncCursor,
        item: AuthorityItemRecord,
    ) -> Result<PlanResult, RuntimeError> {
        if self.bootstrap.state != ReplicaState::Ready
            || self.bootstrap.active_cursor != *expected_cursor
        {
            return Ok(PlanResult::Stale {
                actual_revision: self.revision,
            });
        }
        let generation_id =
            self.bootstrap.active_generation.clone().ok_or_else(|| {
                replica_invariant("ready Replica has no active Bootstrap generation")
            })?;
        validate_captured_cursor(&next_cursor)?;
        validate_authority_page(&[], std::slice::from_ref(&item))?;
        if let Some(existing) = self
            .bootstrap
            .items
            .get(&(generation_id.clone(), item.id.clone()))
        {
            if existing.version > item.version {
                return Err(replica_invariant(
                    "a stale Server version cannot overwrite newer ciphertext",
                ));
            }
        }
        let next_revision = increment_revision(self.revision)?;
        let (item_id, version) = (item.id.clone(), item.version);
        self.bootstrap
            .items
            .insert((generation_id, item.id.clone()), item);
        self.bootstrap.active_cursor = next_cursor;
        self.bootstrap.validate()?;
        self.reconcile_rejected_move_source(&item_id, version);
        self.revision = next_revision;
        Ok(PlanResult::Applied {
            replica_revision: self.revision,
        })
    }

    /// A Sync response may only change the authority revision it was requested against.
    /// In particular, delayed absence cannot delete authority another executor just installed.
    pub(super) fn apply_sync_item_authority(
        &mut self,
        guard: &BootstrapGuard,
        expected_cursor: &SyncCursor,
        item_id: &str,
        item: Option<AuthorityItemRecord>,
    ) -> Result<PlanResult, RuntimeError> {
        if let Some(result) = self.guard_result(guard) {
            return Ok(result);
        }
        if self.bootstrap.state != ReplicaState::Ready
            || self.bootstrap.active_cursor != *expected_cursor
        {
            return Ok(PlanResult::Stale {
                actual_revision: self.revision,
            });
        }
        if let Some(item) = item {
            if item.id != item_id {
                return Err(replica_invariant("Sync authority answered another Item"));
            }
            return self.apply_authoritative_item(expected_cursor, expected_cursor.clone(), item);
        }
        let next_revision = increment_revision(self.revision)?;
        self.remove_authoritative_item(item_id)?;
        self.revision = next_revision;
        Ok(PlanResult::Applied {
            replica_revision: self.revision,
        })
    }

    #[allow(dead_code, reason = "the persistence wire invokes this model next")]
    fn matches_guard(&self, guard: &BootstrapGuard) -> bool {
        self.account_id == guard.account_id
            && self.user_id == guard.user_id
            && self.incarnation == guard.incarnation
            && self.revision == guard.expected_replica_revision
            && self.lock_epoch == guard.expected_lock_epoch
    }

    #[allow(dead_code, reason = "the persistence wire invokes this model next")]
    fn guard_result(&self, guard: &BootstrapGuard) -> Option<PlanResult> {
        if self.account_id != guard.account_id {
            Some(PlanResult::Missing)
        } else if !self.matches_guard(guard) {
            Some(PlanResult::Stale {
                actual_revision: self.revision,
            })
        } else {
            None
        }
    }

    #[allow(dead_code, reason = "the persistence wire invokes this model next")]
    fn stage_guard_result(&self, guard: &BootstrapGuard) -> Option<StageBootstrapPageResult> {
        if self.account_id != guard.account_id {
            Some(StageBootstrapPageResult::Missing)
        } else if !self.matches_guard(guard) {
            Some(StageBootstrapPageResult::Stale {
                actual_revision: self.revision,
            })
        } else {
            None
        }
    }

    fn apply(&mut self, mutation: PlanMutation) -> Result<(), RuntimeError> {
        // A failed Account module accepts nothing further. Failing is how the Runtime refuses to
        // guess; letting durable work continue afterwards would be the guess.
        if self.failure.is_some() && !matches!(mutation, PlanMutation::FailAccount { .. }) {
            return Err(replica_invariant("the Account module has failed"));
        }
        match mutation {
            PlanMutation::AdmitCrossAccountMove {
                record,
                source_overlay,
            } => self.admit_cross_account_move(*record, source_overlay)?,
            PlanMutation::AdmitLegacySourceUnavailableMove { record } => {
                self.admit_legacy_source_unavailable_move(*record)?
            }
            PlanMutation::AdvanceCrossAccountMove {
                operation_id,
                expected_binding_revision,
                next,
                source_authority,
            } => self.advance_cross_account_move(
                operation_id,
                expected_binding_revision,
                *next,
                source_authority,
            )?,
            PlanMutation::RetireCrossAccountMoveDestination {
                operation_id,
                expected_binding_revision,
                target_account_id,
                target_incarnation,
            } => self.retire_cross_account_move_destination(
                &operation_id,
                expected_binding_revision,
                &target_account_id,
                &target_incarnation,
            )?,
            PlanMutation::ReauthorizeCrossAccountMoveDestination {
                operation_id,
                expected_binding_revision,
                destination_account_id,
                destination_incarnation,
                verified_attachments,
            } => self.reauthorize_cross_account_move_destination(
                &operation_id,
                expected_binding_revision,
                destination_account_id,
                destination_incarnation,
                verified_attachments,
            )?,
            PlanMutation::ReauthorizeLegacyCrossAccountMoveFromTrashedCache {
                operation_id,
                expected_binding_revision,
                destination_account_id,
                destination_incarnation,
                verified_source,
            } => self.reauthorize_legacy_cross_account_move_from_trashed_cache(
                &operation_id,
                expected_binding_revision,
                destination_account_id,
                destination_incarnation,
                verified_source,
            )?,
            PlanMutation::ReauthorizeAndCompleteLegacyCrossAccountMove {
                operation_id,
                expected_binding_revision,
                destination_account_id,
                destination_incarnation,
                verified_outcomes,
            } => self.reauthorize_and_complete_legacy_cross_account_move(
                &operation_id,
                expected_binding_revision,
                destination_account_id,
                destination_incarnation,
                verified_outcomes,
            )?,
            PlanMutation::RetireVaults { vault_ids } => self.retire_vault_authority(&vault_ids)?,
            PlanMutation::CompleteVaultRetirements { vault_ids } => {
                validate_retired_vault_ids(&vault_ids)?;
                if vault_ids
                    .iter()
                    .any(|id| !self.bootstrap.pending_vault_retirements.contains(id))
                {
                    return Err(replica_invariant("Vault cleanup completion is not pending"));
                }
                self.bootstrap
                    .pending_vault_retirements
                    .retain(|id| !vault_ids.contains(id));
            }
            PlanMutation::PutOptimisticItem(item) => {
                self.check_item_scope(&item)?;
                self.check_overlay(&item)?;
                self.items.insert(item.item_id.clone(), item);
            }
            PlanMutation::AcceptOperation(operation) => {
                if operation.touches_vaults(&self.bootstrap.pending_vault_retirements)? {
                    return Err(replica_invariant(
                        "cannot accept work for retired Vault authority",
                    ));
                }
                if self.operations.contains_key(&operation.operation_id)
                    || self
                        .cross_account_moves
                        .contains_key(&operation.operation_id)
                    || self
                        .attachment_move_preparations
                        .contains_key(&operation.operation_id)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "operation identity was reused",
                    ));
                }
                // The compact receipt outlives the Operation precisely so a completed identity
                // can never be accepted a second time.
                if self.receipts.contains_key(&operation.operation_id) {
                    return Err(replica_invariant("completed Operation identity was reused"));
                }
                check_immutable_request(&operation)?;
                validate_create_vault_operation_context(
                    &operation,
                    &self.account_id,
                    &self.user_id,
                )?;
                if let Some(item_id) = operation
                    .target
                    .item_id()
                    .filter(|_| !operation.is_legacy_held())
                {
                    if self
                        .operations
                        .values()
                        .filter(|active| !active.is_legacy_held())
                        .filter_map(|active| active.target.item_id())
                        .any(|active| active == item_id)
                        || self.cross_account_moves.values().any(|record| {
                            record.owns_source_item() && record.source_item_id() == item_id
                        })
                        || self
                            .attachment_move_preparations
                            .values()
                            .any(|active| active.item_id == item_id)
                    {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::InvariantViolation,
                            "another active Operation already owns this Item",
                        ));
                    }
                }
                self.operations
                    .insert(operation.operation_id.clone(), operation);
            }
            PlanMutation::BindRotationStart {
                start_operation_id,
                intent,
                authority_generation_id,
                team_role,
            } => self.bind_rotation_start(
                &start_operation_id,
                intent,
                authority_generation_id,
                team_role,
            )?,
            PlanMutation::ReconcileRotationStart {
                outcome,
                intent,
                validated_plans,
            } => self.reconcile_rotation_start(outcome, intent, validated_plans)?,
            PlanMutation::BindRotationManifest {
                start_operation_id,
                members,
            } => {
                self.bind_rotation_manifest(&start_operation_id, members)?;
            }
            PlanMutation::AcknowledgeRotationAttempt { start_operation_id } => {
                self.acknowledge_rotation_attempt(&start_operation_id)?;
            }
            PlanMutation::ConsumeRotationAttempt {
                start_operation_id,
                attempt_id,
            } => {
                self.consume_rotation_attempt(&start_operation_id, attempt_id)?;
            }
            PlanMutation::AcceptRotationFinalize {
                start_operation_id,
                attempt_id,
                operation,
            } => {
                self.accept_rotation_finalize(&start_operation_id, &attempt_id, operation)?;
            }
            PlanMutation::ReconcileRotationFinalize {
                start_operation_id,
                outcome,
            } => {
                self.reconcile_rotation_finalize(&start_operation_id, outcome)?;
            }
            PlanMutation::CompleteRotationRefresh {
                start_operation_id,
                finalize_operation_id,
            } => {
                self.complete_rotation_refresh(&start_operation_id, &finalize_operation_id)?;
            }
            PlanMutation::PutProtectedShareCapability(capability) => {
                let operation = self.operations.get(&capability.operation_id);
                if capability.account_id != self.account_id
                    || capability.operation_id.is_empty()
                    || capability.ciphertext.is_empty()
                    || capability.iv.is_empty()
                    || capability.algorithm != "AES-GCM-AAD-V1"
                    || self
                        .share_capabilities
                        .contains_key(&capability.operation_id)
                    || !operation.is_some_and(|operation| {
                        operation.kind == OperationKind::CreateShare
                            && operation.operation_id == capability.operation_id
                    })
                {
                    return Err(replica_invariant(
                        "protected Share capability is invalid or reused",
                    ));
                }
                self.share_capabilities
                    .insert(capability.operation_id.clone(), capability);
            }
            PlanMutation::RemoveAllProtectedShareCapabilities => {
                self.share_capabilities.clear();
            }
            PlanMutation::AcceptAttachmentMovePreparation(preparation) => {
                if self
                    .bootstrap
                    .pending_vault_retirements
                    .contains(&preparation.source_vault_id)
                    || self
                        .bootstrap
                        .pending_vault_retirements
                        .contains(&preparation.target_vault_id)
                {
                    return Err(replica_invariant(
                        "cannot accept Move work for retired Vault authority",
                    ));
                }
                self.check_attachment_move_preparation(&preparation, true)?;
                if self.operations.contains_key(&preparation.operation_id)
                    || self
                        .attachment_move_preparations
                        .contains_key(&preparation.operation_id)
                    || self.receipts.contains_key(&preparation.operation_id)
                {
                    return Err(replica_invariant(
                        "Attachment Move operation identity was reused",
                    ));
                }
                if self
                    .operations
                    .values()
                    .filter(|active| !active.is_legacy_held())
                    .filter_map(|active| active.target.item_id())
                    .any(|active| active == preparation.item_id)
                    || self
                        .attachment_move_preparations
                        .values()
                        .any(|active| active.item_id == preparation.item_id)
                {
                    return Err(replica_invariant(
                        "another active Operation already owns this Item",
                    ));
                }
                self.attachment_move_preparations
                    .insert(preparation.operation_id.clone(), preparation);
            }
            PlanMutation::RescheduleAttachmentMovePreparation(preparation) => {
                let existing = self
                    .attachment_move_preparations
                    .get(&preparation.operation_id)
                    .ok_or_else(|| {
                        replica_invariant("cannot reschedule an unknown Attachment Move")
                    })?;
                let mut expected = existing.clone();
                expected.scheduling = preparation.scheduling;
                if expected != preparation
                    || preparation.scheduling.attempt_count < existing.scheduling.attempt_count
                {
                    return Err(replica_invariant(
                        "rescheduling cannot change accepted Attachment Move intent or progress",
                    ));
                }
                self.attachment_move_preparations
                    .insert(preparation.operation_id.clone(), preparation);
            }
            PlanMutation::CheckpointAttachmentMove {
                operation_id,
                expected_intent_fingerprint,
                expected,
                next,
            } => {
                let preparation = self
                    .attachment_move_preparation_mut(&operation_id, expected_intent_fingerprint)?;
                validate_checkpoint_transition(&expected, &next)?;
                if let AttachmentMoveProgress::Encrypted {
                    attachment_id,
                    artifact,
                    ..
                } = &next
                {
                    validate_artifact_ref(
                        artifact,
                        &preparation.account_id,
                        &operation_id,
                        attachment_id,
                    )?;
                }
                let progress = preparation
                    .progress
                    .iter_mut()
                    .find(|progress| progress.attachment_id() == expected.attachment_id())
                    .ok_or_else(|| replica_invariant("Attachment Move checkpoint is foreign"))?;
                if progress != &expected {
                    return Err(replica_invariant(
                        "Attachment Move checkpoint does not match durable progress",
                    ));
                }
                *progress = next;
            }
            PlanMutation::ResetAttachmentMoveUpload {
                operation_id,
                expected_intent_fingerprint,
                attachment_id,
            } => {
                let preparation = self
                    .attachment_move_preparation_mut(&operation_id, expected_intent_fingerprint)?;
                let progress = preparation
                    .progress
                    .iter_mut()
                    .find(|progress| progress.attachment_id() == attachment_id)
                    .ok_or_else(|| replica_invariant("Attachment Move reset is foreign"))?;
                if let AttachmentMoveProgress::Encrypted { upload, .. } = progress {
                    *upload = AttachmentMoveUploadState::NeedsUpload;
                }
            }
            PlanMutation::FreezeAttachmentMoveRejection {
                operation_id,
                expected_intent_fingerprint,
            } => {
                let preparation = self
                    .take_attachment_move_preparation(&operation_id, expected_intent_fingerprint)?;
                let operation = rejection_operation(&preparation)?;
                self.operations.insert(operation_id, operation);
            }
            PlanMutation::PromoteAttachmentMovePreparation {
                operation_id,
                expected_intent_fingerprint,
            } => {
                let preparation = self
                    .take_attachment_move_preparation(&operation_id, expected_intent_fingerprint)?;
                let operation = prepared_move_operation(&preparation)?;
                self.operations.insert(operation_id, operation);
            }
            PlanMutation::ReactivateAttachmentMovePreparation {
                operation_id,
                expected_request_fingerprint,
            } => {
                let operation = self.operations.get(&operation_id).ok_or_else(|| {
                    replica_invariant("cannot reactivate an unknown Attachment Move")
                })?;
                if operation.request_fingerprint != expected_request_fingerprint {
                    return Err(replica_invariant(
                        "Attachment Move reactivation fingerprint changed",
                    ));
                }
                let preparation = operation
                    .attachment_move_recovery
                    .as_ref()
                    .ok_or_else(|| replica_invariant("Operation has no Attachment Move recovery"))?
                    .preparation()
                    .clone();
                self.check_attachment_move_preparation(&preparation, false)?;
                self.operations.remove(&operation_id);
                self.attachment_move_preparations
                    .insert(operation_id, preparation);
            }
            PlanMutation::RescheduleOperation(mut operation) => {
                let existing = self
                    .operations
                    .get(&operation.operation_id)
                    .ok_or_else(|| replica_invariant("cannot reschedule an unknown Operation"))?;
                if existing.kind != operation.kind
                    || existing.target != operation.target
                    || existing.request != operation.request
                    || existing.request_fingerprint != operation.request_fingerprint
                    || existing.accepted_item_category != operation.accepted_item_category
                    || existing.attachment_move_recovery != operation.attachment_move_recovery
                    || existing.create_vault != operation.create_vault
                    || existing.update_vault != operation.update_vault
                    || existing.legacy_admission != operation.legacy_admission
                {
                    return Err(replica_invariant(
                        "rescheduling cannot change accepted Operation bytes",
                    ));
                }
                if let Some(recovery) = &mut operation.attachment_move_recovery {
                    recovery.preparation_mut().scheduling = operation.scheduling;
                }
                self.operations
                    .insert(operation.operation_id.clone(), operation);
            }
            PlanMutation::ProtectVaultImage {
                operation_id,
                witness,
            } => self.transition_image_protection(operation_id, witness, false)?,
            PlanMutation::CompleteVaultImageRawCleanup {
                operation_id,
                witness,
            } => self.transition_image_protection(operation_id, witness, true)?,
            PlanMutation::CheckpointCreateVault(operation) => {
                let existing = self
                    .operations
                    .get(&operation.operation_id)
                    .ok_or_else(|| {
                        replica_invariant("cannot checkpoint an unknown create-Vault Operation")
                    })?;
                validate_create_vault_transition(existing, &operation)?;
                validate_create_vault_operation_context(
                    &operation,
                    &self.account_id,
                    &self.user_id,
                )?;
                self.operations
                    .insert(operation.operation_id.clone(), operation);
            }
            PlanMutation::RemoveOperation { operation_id } => {
                if self
                    .operations
                    .get(&operation_id)
                    .is_some_and(|operation| operation.kind.is_rotation())
                {
                    return Err(replica_invariant(
                        "Rotation work requires its atomic reconciliation",
                    ));
                }
                if self.operations.remove(&operation_id).is_none() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "cannot remove an unknown operation",
                    ));
                }
            }
            PlanMutation::ReconcileAppliedCreate {
                outcome,
                item,
                cursor,
            } => {
                let operation = self.operation_for(&outcome)?;
                if operation.kind != OperationKind::CreateItem
                    || operation.target.item_id().is_none()
                {
                    return Err(replica_invariant(
                        "an applied create reconciliation needs a create-Item Operation",
                    ));
                }
                let OperationOutcomeResult::Applied { entity_id, version } = &outcome.result else {
                    return Err(replica_invariant(
                        "an applied reconciliation needs an applied outcome",
                    ));
                };
                // A retained action fixes the receipt's version, while current authenticated
                // authority may already include a later edit of the same Item.
                if entity_id != operation.item_id()
                    || item.id != operation.item_id()
                    || item.version < *version
                {
                    return Err(replica_invariant(
                        "the authoritative Item does not match the Operation outcome",
                    ));
                }
                self.retain_receipt(&operation, &outcome)?;
                self.write_authoritative_item(*item)?;
                self.operations.remove(&operation.operation_id);
                self.items
                    .retain(|_, overlay| overlay.operation_id != operation.operation_id);
                self.advance_matching_cursor(cursor)?;
            }
            PlanMutation::ReconcileItemMutation {
                outcome,
                item,
                cursor,
            } => {
                let operation = self.operation_for(&outcome)?;
                let applied_create_absence = operation.kind == OperationKind::CreateItem
                    && item.is_none()
                    && matches!(outcome.result, OperationOutcomeResult::Applied { .. });
                if (!matches!(
                    operation.kind,
                    OperationKind::UpdateItem
                        | OperationKind::SetItemFavorite
                        | OperationKind::TrashItem
                        | OperationKind::RestoreItem
                        | OperationKind::MoveItem
                        | OperationKind::PermanentlyDeleteItem
                ) && !applied_create_absence)
                    || operation.target.item_id().is_none()
                {
                    return Err(replica_invariant(
                        "Item reconciliation needs an ordinary mutation or applied Create absence",
                    ));
                }
                match (&outcome.result, item.as_deref()) {
                    (OperationOutcomeResult::Applied { entity_id, version }, Some(authority))
                        if operation.kind != OperationKind::PermanentlyDeleteItem
                            && entity_id == operation.item_id()
                            && authority.id == operation.item_id()
                            && authority.version >= *version => {}
                    (OperationOutcomeResult::Applied { entity_id, .. }, None)
                        if entity_id == operation.item_id() => {}
                    (OperationOutcomeResult::Rejected { .. }, Some(authority))
                        if authority.id == operation.item_id() => {}
                    (OperationOutcomeResult::Rejected { .. }, None) => {}
                    _ => {
                        return Err(replica_invariant(
                            "the authoritative Item does not match the mutation outcome",
                        ));
                    }
                }
                self.retain_receipt(&operation, &outcome)?;
                match item {
                    Some(item) => self.write_authoritative_item(*item)?,
                    None => self.remove_authoritative_item(operation.item_id())?,
                }
                self.operations.remove(&operation.operation_id);
                self.items
                    .retain(|_, overlay| overlay.operation_id != operation.operation_id);
                self.advance_matching_cursor(cursor)?;
            }
            PlanMutation::CommitAttachmentAuthority {
                attachment_id,
                attachment_present,
                item,
            } => {
                let present = item.attachments.iter().any(|attachment| {
                    attachment.id == attachment_id && attachment.item_id == item.id
                });
                if present != attachment_present {
                    return Err(replica_invariant(
                        "the authoritative Item does not prove the required Attachment presence",
                    ));
                }
                self.write_authoritative_item(*item)?;
            }
            PlanMutation::RetainRejection { outcome, cursor } => {
                let operation = self.operation_for(&outcome)?;
                if !matches!(outcome.result, OperationOutcomeResult::Rejected { .. }) {
                    return Err(replica_invariant(
                        "a retained rejection needs a rejected outcome",
                    ));
                }
                self.retain_receipt(&operation, &outcome)?;
                // Retry stops here. The encrypted optimistic Item stays exactly as the user
                // created it: a rejection is not permission to destroy their ciphertext.
                self.operations.remove(&operation.operation_id);
                self.advance_matching_cursor(cursor)?;
            }
            PlanMutation::ReconcileShareOutcome { outcome, cursor } => {
                let operation = self.operation_for(&outcome)?;
                if operation.kind != OperationKind::CreateShare {
                    return Err(replica_invariant(
                        "a Share reconciliation needs a CreateShare Operation",
                    ));
                }
                if self
                    .share_capabilities
                    .get(&operation.operation_id)
                    .is_some_and(|capability| {
                        capability.account_id != self.account_id || capability.result.is_some()
                    })
                {
                    return Err(replica_invariant(
                        "CreateShare capability is not pending this outcome",
                    ));
                }
                let applied = match &outcome.result {
                    OperationOutcomeResult::ShareApplied {
                        share_link_id,
                        base_share_url,
                        expires_at,
                    } if !share_link_id.is_empty()
                        && !base_share_url.is_empty()
                        && !expires_at.is_empty() =>
                    {
                        Some(ShareAppliedResultRecord {
                            share_link_id: share_link_id.clone(),
                            base_share_url: base_share_url.clone(),
                            expires_at: expires_at.clone(),
                        })
                    }
                    OperationOutcomeResult::Rejected { .. } => None,
                    _ => {
                        return Err(replica_invariant(
                            "a Share reconciliation needs a Share outcome",
                        ));
                    }
                };
                self.retain_receipt(&operation, &outcome)?;
                self.operations.remove(&operation.operation_id);
                match (
                    self.share_capabilities.get_mut(&operation.operation_id),
                    applied,
                ) {
                    (Some(capability), Some(result)) => capability.result = Some(result),
                    (Some(_), None) => {
                        self.share_capabilities.remove(&operation.operation_id);
                    }
                    // SignOut deliberately destroys this Device's capability without cancelling
                    // accepted work. The authoritative outcome still receipts and terminates the
                    // Operation; an applied result simply has no plaintext delivery to publish.
                    (None, _) => {}
                }
                self.advance_matching_cursor(cursor)?;
            }
            PlanMutation::ReconcileRetainedResult { outcome } => {
                let operation = self.operation_for(&outcome)?;
                if operation.kind.is_rotation() {
                    return Err(replica_invariant(
                        "Rotation work requires its atomic reconciliation",
                    ));
                }
                let refresh = match (&operation.kind, &outcome.result) {
                    (
                        OperationKind::CreateItem
                        | OperationKind::UpdateItem
                        | OperationKind::SetItemFavorite
                        | OperationKind::TrashItem
                        | OperationKind::RestoreItem
                        | OperationKind::MoveItem
                        | OperationKind::PermanentlyDeleteItem,
                        OperationOutcomeResult::Applied { entity_id, .. },
                    ) if operation.target.item_id() == Some(entity_id.as_str()) => true,
                    (
                        OperationKind::UpdateItem
                        | OperationKind::SetItemFavorite
                        | OperationKind::TrashItem
                        | OperationKind::RestoreItem
                        | OperationKind::MoveItem
                        | OperationKind::PermanentlyDeleteItem,
                        OperationOutcomeResult::Rejected { .. },
                    ) => true,
                    (
                        OperationKind::CreateVault,
                        OperationOutcomeResult::VaultApplied { vault_id },
                    ) if vault_id == operation.vault_id() => true,
                    (OperationKind::CreateVault, OperationOutcomeResult::VaultRejected { .. }) => {
                        false
                    }
                    (
                        OperationKind::ImportItems,
                        OperationOutcomeResult::ImportApplied {
                            vault_id,
                            imported_count,
                        },
                    ) if vault_id == operation.vault_id() => {
                        let body: crate::wire::import::ImportRequestBody =
                            serde_json::from_slice(&operation.request.body).map_err(|_| {
                                replica_invariant("retained Import request is malformed")
                            })?;
                        if body.items.len() != usize::from(*imported_count) {
                            return Err(replica_invariant(
                                "retained Import result changed the accepted batch count",
                            ));
                        }
                        true
                    }
                    (OperationKind::ImportItems, OperationOutcomeResult::ImportRejected { .. }) => {
                        false
                    }
                    _ => {
                        return Err(replica_invariant(
                            "retained result does not match accepted work",
                        ));
                    }
                };
                if operation.kind == OperationKind::CreateVault
                    && operation.vault_image_checkpoint()
                        != Some(CreateVaultCheckpoint::FinalRequestFrozen)
                {
                    return Err(replica_invariant(
                        "create-Vault cannot reconcile before final request freeze",
                    ));
                }
                self.retain_receipt(&operation, &outcome)?;
                if let Some(image) = operation.vault_image().cloned() {
                    let receipt = self
                        .receipts
                        .get_mut(&operation.operation_id)
                        .ok_or_else(|| replica_invariant("retained Vault receipt missing"))?;
                    receipt.create_vault_cleanup = Some(CreateVaultCleanupObligation {
                        image,
                        local_artifact_pending: true,
                        remote_staging_pending: matches!(
                            outcome.result,
                            OperationOutcomeResult::VaultRejected { .. }
                        ),
                    });
                    validate_operation_receipt(receipt, &self.user_id)?;
                }
                self.operations.remove(&operation.operation_id);
                self.items
                    .retain(|_, overlay| overlay.operation_id != operation.operation_id);
                if refresh {
                    self.bootstrap.abandon_staging_authority()?;
                    self.bootstrap.state = if self.bootstrap.active_generation.is_some() {
                        ReplicaState::RefreshRequired
                    } else {
                        ReplicaState::Cold
                    };
                }
                self.bootstrap.validate()?;
            }
            PlanMutation::ReconcileVaultMutation { outcome } => {
                let operation = self.operation_for(&outcome)?;
                if !matches!(
                    operation.kind,
                    OperationKind::UpdateVault | OperationKind::DeleteVault
                ) || !matches!(operation.target, ResourceRef::Vault { .. })
                    || !matches!(
                        self.bootstrap.state,
                        ReplicaState::Ready | ReplicaState::RefreshRequired
                    )
                    || !match &outcome.result {
                        OperationOutcomeResult::VaultApplied { vault_id } => {
                            vault_id == operation.vault_id()
                        }
                        OperationOutcomeResult::VaultMutationRejected { .. } => true,
                        _ => false,
                    }
                {
                    return Err(replica_invariant(
                        "Vault mutation completion is not current or matching",
                    ));
                }
                self.retain_receipt(&operation, &outcome)?;
                if let Some(image) = operation.vault_image().cloned() {
                    if operation.vault_image_checkpoint()
                        != Some(CreateVaultCheckpoint::FinalRequestFrozen)
                    {
                        return Err(replica_invariant(
                            "Vault image update completed before final request freeze",
                        ));
                    }
                    let receipt = self
                        .receipts
                        .get_mut(&operation.operation_id)
                        .ok_or_else(|| replica_invariant("Vault update receipt missing"))?;
                    receipt.create_vault_cleanup = Some(CreateVaultCleanupObligation {
                        image,
                        local_artifact_pending: true,
                        remote_staging_pending: matches!(
                            outcome.result,
                            OperationOutcomeResult::VaultMutationRejected { .. }
                        ),
                    });
                    validate_operation_receipt(receipt, &self.user_id)?;
                }
                self.operations.remove(&operation.operation_id);
                self.bootstrap.state = ReplicaState::RefreshRequired;
                self.bootstrap.validate()?;
            }
            PlanMutation::ReconcileCreateVault { outcome, vault } => {
                let operation = self.operation_for(&outcome)?;
                if operation.kind != OperationKind::CreateVault {
                    return Err(replica_invariant(
                        "a Vault reconciliation needs a create-Vault Operation",
                    ));
                }
                let intent = operation
                    .create_vault
                    .as_ref()
                    .ok_or_else(|| replica_invariant("create-Vault intent is missing"))?;
                if intent.checkpoint != CreateVaultCheckpoint::FinalRequestFrozen {
                    return Err(replica_invariant(
                        "create-Vault cannot reconcile before its final request is frozen",
                    ));
                }
                match (&outcome.result, vault) {
                    (OperationOutcomeResult::VaultApplied { vault_id }, Some(authority))
                        if vault_id == operation.vault_id()
                            && authority.id == operation.vault_id()
                            && authority.name == intent.name
                            && authority.encrypted_vault_key == intent.encrypted_vault_key
                            && authority.role == AuthorityVaultRole::Owner
                            && authority.icon.as_deref() == Some(intent.icon.as_str())
                            && authority.vault_type
                                == match intent.vault_type {
                                    crate::CreateVaultType::Personal => {
                                        AuthorityVaultType::Personal
                                    }
                                    crate::CreateVaultType::Shared => AuthorityVaultType::Team,
                                }
                            && authority.image_url.is_some() == intent.image.is_some() =>
                    {
                        self.write_authoritative_vault(authority)?;
                    }
                    (OperationOutcomeResult::VaultRejected { .. }, None) => {}
                    _ => {
                        return Err(replica_invariant(
                            "authoritative Vault does not match the create-Vault outcome",
                        ));
                    }
                }
                self.retain_receipt(&operation, &outcome)?;
                if let Some(image) = intent.image.clone() {
                    let receipt =
                        self.receipts
                            .get_mut(&operation.operation_id)
                            .ok_or_else(|| {
                                replica_invariant("create-Vault reconciliation kept no receipt")
                            })?;
                    receipt.create_vault_cleanup = Some(CreateVaultCleanupObligation {
                        image,
                        local_artifact_pending: true,
                        remote_staging_pending: matches!(
                            outcome.result,
                            OperationOutcomeResult::VaultRejected { .. }
                        ),
                    });
                    validate_operation_receipt(receipt, &self.user_id)?;
                }
                self.operations.remove(&operation.operation_id);
            }
            PlanMutation::ReconcileImportItems { outcome, items } => {
                let operation = self.operation_for(&outcome)?;
                if operation.kind != OperationKind::ImportItems
                    || !matches!(operation.target, ResourceRef::ImportBatch { .. })
                {
                    return Err(replica_invariant(
                        "an Import reconciliation needs an import-Items Operation",
                    ));
                }
                match &outcome.result {
                    OperationOutcomeResult::ImportApplied {
                        vault_id,
                        imported_count,
                    } if vault_id == operation.vault_id()
                        && usize::from(*imported_count) == items.len() =>
                    {
                        let mut seen = std::collections::HashSet::new();
                        for item in &items {
                            if item.vault_id != *vault_id
                                || item.version != 1
                                || item.encryption_version != 1
                                || !seen.insert(item.id.clone())
                            {
                                return Err(replica_invariant(
                                    "authoritative Import Item does not match the batch outcome",
                                ));
                            }
                        }
                        for item in items {
                            self.write_authoritative_item(item)?;
                        }
                    }
                    OperationOutcomeResult::ImportRejected { .. } if items.is_empty() => {}
                    _ => {
                        return Err(replica_invariant(
                            "authoritative Import batch does not match its outcome",
                        ));
                    }
                }
                self.retain_receipt(&operation, &outcome)?;
                self.operations.remove(&operation.operation_id);
            }
            PlanMutation::CompleteCreateVaultCleanup {
                operation_id,
                local_artifact_done,
                remote_staging_done,
            } => {
                let receipt = self
                    .receipts
                    .get_mut(&operation_id)
                    .ok_or_else(|| replica_invariant("create-Vault cleanup receipt is missing"))?;
                let cleanup = receipt.create_vault_cleanup.as_mut().ok_or_else(|| {
                    replica_invariant("create-Vault cleanup obligation is missing")
                })?;
                let valid_transition = matches!(
                    (
                        cleanup.local_artifact_pending,
                        cleanup.remote_staging_pending,
                        local_artifact_done,
                        remote_staging_done,
                    ),
                    (true, false, true, false)
                        | (true, true, true, false)
                        | (false, true, false, true)
                );
                if !valid_transition {
                    return Err(replica_invariant(
                        "create-Vault cleanup transition is invalid",
                    ));
                }
                if local_artifact_done {
                    cleanup.local_artifact_pending = false;
                }
                if remote_staging_done {
                    cleanup.remote_staging_pending = false;
                }
                if !cleanup.local_artifact_pending && !cleanup.remote_staging_pending {
                    receipt.create_vault_cleanup = None;
                } else {
                    validate_operation_receipt(receipt, &self.user_id)?;
                }
            }
            PlanMutation::AdvanceSyncPageCursor {
                operation_ids,
                cursor,
            } => {
                for operation_id in &operation_ids {
                    validate_identifier(operation_id, "Sync page Operation event")?;
                    if self.operations.contains_key(operation_id)
                        || self.attachment_move_preparations.contains_key(operation_id)
                    {
                        return Err(replica_invariant(
                            "Sync page Cursor cannot pass active accepted work",
                        ));
                    }
                }
                if self.bootstrap.active_cursor != cursor.expected || cursor.next == cursor.expected
                {
                    return Err(replica_invariant("Sync page Cursor advance is not exact"));
                }
                self.advance_matching_cursor(Some(cursor))?;
            }
            PlanMutation::AcknowledgeShareResult { operation_id } => {
                let capability = self
                    .share_capabilities
                    .get(&operation_id)
                    .ok_or_else(|| replica_invariant("pending Share result is missing"))?;
                if capability.result.is_none()
                    || !self.receipts.get(&operation_id).is_some_and(|receipt| {
                        receipt.kind == OperationKind::CreateShare
                            && matches!(receipt.result, OperationOutcomeResult::ShareApplied { .. })
                    })
                {
                    return Err(replica_invariant(
                        "Share result acknowledgement has no applied delivery",
                    ));
                }
                self.share_capabilities.remove(&operation_id);
            }
            PlanMutation::FailAccount { code } => {
                self.failure = Some(code);
            }
        }
        Ok(())
    }

    fn check_attachment_move_preparation(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        require_current_authority: bool,
    ) -> Result<(), RuntimeError> {
        if preparation.account_id != self.account_id
            || preparation.operation_id.is_empty()
            || preparation.item_id.is_empty()
            || preparation.source_vault_id.is_empty()
            || preparation.target_vault_id.is_empty()
            || preparation.source_vault_id == preparation.target_vault_id
            || preparation.expected_item_version <= 0
            || preparation.target_encrypted_data.is_empty()
            || preparation.target_encryption_iv.is_empty()
        {
            return Err(replica_invariant(
                "Attachment Move preparation intent is invalid",
            ));
        }
        if preparation.source_attachments.is_empty()
            || preparation.source_attachments.len() != preparation.progress.len()
        {
            return Err(replica_invariant(
                "Attachment Move preparation is not a complete Attachment set",
            ));
        }
        let mut identities = HashSet::new();
        let mut previous_id: Option<&str> = None;
        for (index, source) in preparation.source_attachments.iter().enumerate() {
            if source.item_id != preparation.item_id
                || source.vault_id != preparation.source_vault_id
                || source.envelope_version <= 0
                || previous_id.is_some_and(|previous| previous >= source.id.as_str())
                || !identities.insert(source.id.clone())
            {
                return Err(replica_invariant(
                    "Attachment Move preparation contains foreign or duplicate authority",
                ));
            }
            previous_id = Some(&source.id);
            let matching = &preparation.progress[index];
            if matching.attachment_id() != source.id
                || matching.expected_envelope_version() != source.envelope_version
                || matches!(matching, AttachmentMoveProgress::Encrypted {
                    artifact,
                    payload,
                    ..
                } if validate_artifact_ref(
                    artifact,
                    &preparation.account_id,
                    &preparation.operation_id,
                    &source.id,
                ).is_err()
                    || !valid_prepared_attachment(payload))
            {
                return Err(replica_invariant(
                    "Attachment Move progress does not match source authority",
                ));
            }
        }
        if !require_current_authority {
            return if attachment_move_intent_fingerprint(preparation)?
                == preparation.intent_fingerprint
            {
                Ok(())
            } else {
                Err(replica_invariant(
                    "Attachment Move intent fingerprint does not match its durable authority",
                ))
            };
        }
        let generation = self
            .bootstrap
            .active_generation
            .as_ref()
            .ok_or_else(|| replica_invariant("Attachment Move acceptance has no authority"))?;
        let authority = self
            .bootstrap
            .items
            .get(&(generation.clone(), preparation.item_id.clone()))
            .ok_or_else(|| replica_invariant("Attachment Move Item authority is missing"))?;
        let mut authoritative_attachments = authority.attachments.clone();
        authoritative_attachments.sort_by(|left, right| left.id.cmp(&right.id));
        if authority.vault_id != preparation.source_vault_id
            || authority.version != preparation.expected_item_version
            || authoritative_attachments != preparation.source_attachments
        {
            return Err(replica_invariant(
                "Attachment Move intent does not match current Item authority",
            ));
        }
        if attachment_move_intent_fingerprint(preparation)? != preparation.intent_fingerprint {
            return Err(replica_invariant(
                "Attachment Move intent fingerprint does not match its durable authority",
            ));
        }
        Ok(())
    }

    fn attachment_move_preparation_mut(
        &mut self,
        operation_id: &str,
        expected_intent_fingerprint: Sha256Fingerprint,
    ) -> Result<&mut AttachmentMovePreparationRecord, RuntimeError> {
        let preparation = self
            .attachment_move_preparations
            .get_mut(operation_id)
            .ok_or_else(|| replica_invariant("Attachment Move preparation is missing"))?;
        if preparation.intent_fingerprint != expected_intent_fingerprint {
            return Err(replica_invariant("Attachment Move intent changed"));
        }
        Ok(preparation)
    }

    fn take_attachment_move_preparation(
        &mut self,
        operation_id: &str,
        expected_intent_fingerprint: Sha256Fingerprint,
    ) -> Result<AttachmentMovePreparationRecord, RuntimeError> {
        let preparation = self
            .attachment_move_preparations
            .get(operation_id)
            .ok_or_else(|| replica_invariant("Attachment Move preparation is missing"))?;
        if preparation.intent_fingerprint != expected_intent_fingerprint {
            return Err(replica_invariant("Attachment Move intent changed"));
        }
        self.attachment_move_preparations
            .remove(operation_id)
            .ok_or_else(|| replica_invariant("Attachment Move preparation disappeared"))
    }

    /// Answers the accepted Operation this outcome belongs to, or refuses to guess.
    ///
    /// A result carrying a known Operation ID with another fingerprint is identity reuse. It is
    /// neither a retry nor a replay, and no local state may move because of it.
    fn operation_for(&self, outcome: &ObservedOutcome) -> Result<OperationRecord, RuntimeError> {
        let operation = self
            .operations
            .get(&outcome.operation_id)
            .ok_or_else(|| replica_invariant("cannot complete an unknown Operation"))?;
        if operation.request_fingerprint != outcome.request_fingerprint {
            return Err(replica_invariant(
                "an Operation outcome carries another request fingerprint",
            ));
        }
        Ok(operation.clone())
    }

    /// Inserts the compact receipt, and proves a recorded outcome never changes.
    fn retain_receipt(
        &mut self,
        operation: &OperationRecord,
        outcome: &ObservedOutcome,
    ) -> Result<(), RuntimeError> {
        let receipt = OperationReceiptRecord {
            operation_id: operation.operation_id.clone(),
            kind: operation.kind,
            target: operation.target.clone(),
            request_fingerprint: operation.request_fingerprint,
            result: outcome.result.clone(),
            completed_at_revision: increment_revision(self.revision)?,
            create_vault_cleanup: None,
            legacy_lineage: operation
                .legacy_admission
                .as_deref()
                .map(LegacyOperationReceiptLineage::from),
        };
        validate_operation_receipt(&receipt, &self.user_id)?;
        if let Some(existing) = self.receipts.get(&operation.operation_id) {
            if existing.request_fingerprint != receipt.request_fingerprint
                || existing.result != receipt.result
                || existing.target != receipt.target
                || existing.legacy_lineage != receipt.legacy_lineage
            {
                return Err(replica_invariant(
                    "a matching semantic outcome is immutable",
                ));
            }
            return Ok(());
        }
        self.receipts.insert(receipt.operation_id.clone(), receipt);
        Ok(())
    }

    /// Writes the authoritative encrypted Item into the active generation.
    ///
    /// A Server version this Device has already passed is not written: stale Server versions
    /// cannot overwrite newer ciphertext, and refusing the write is not a reason to leave the
    /// Operation owed forever.
    fn write_authoritative_item(&mut self, item: AuthorityItemRecord) -> Result<(), RuntimeError> {
        if self
            .bootstrap
            .pending_vault_retirements
            .contains(&item.vault_id)
        {
            return Err(replica_invariant(
                "pending Vault retirement cannot regain authority",
            ));
        }
        if self.bootstrap.state != ReplicaState::Ready {
            return Err(replica_invariant(
                "authority can only be written to a ready Replica",
            ));
        }
        let generation_id =
            self.bootstrap.active_generation.clone().ok_or_else(|| {
                replica_invariant("ready Replica has no active Bootstrap generation")
            })?;
        validate_authority_page(&[], std::slice::from_ref(&item))?;
        let key = (generation_id, item.id.clone());
        if self
            .bootstrap
            .items
            .get(&key)
            .is_some_and(|existing| existing.version > item.version)
        {
            return Ok(());
        }
        let version = item.version;
        self.bootstrap.items.insert(key.clone(), item);
        self.bootstrap.validate()?;
        self.reconcile_rejected_move_source(&key.1, version);
        Ok(())
    }

    fn write_authoritative_vault(
        &mut self,
        vault: AuthorityVaultRecord,
    ) -> Result<(), RuntimeError> {
        if self.bootstrap.state != ReplicaState::Ready {
            return Err(replica_invariant(
                "Vault authority can only be written to a ready Replica",
            ));
        }
        let generation_id =
            self.bootstrap.active_generation.clone().ok_or_else(|| {
                replica_invariant("ready Replica has no active Bootstrap generation")
            })?;
        validate_authority_page(std::slice::from_ref(&vault), &[])?;
        self.bootstrap
            .vaults
            .insert((generation_id, vault.id.clone()), vault);
        self.bootstrap.validate()
    }

    fn remove_authoritative_item(&mut self, item_id: &str) -> Result<(), RuntimeError> {
        if self.bootstrap.state != ReplicaState::Ready {
            return Err(replica_invariant(
                "authority can only be removed from a ready Replica",
            ));
        }
        let generation =
            self.bootstrap.active_generation.clone().ok_or_else(|| {
                replica_invariant("ready Replica has no active Bootstrap generation")
            })?;
        self.bootstrap
            .items
            .remove(&(generation, item_id.to_owned()));
        self.bootstrap.validate()
    }

    /// Applies optional guarded Sync page progress only from its exact expected Cursor.
    fn advance_matching_cursor(
        &mut self,
        cursor: Option<CursorAdvance>,
    ) -> Result<(), RuntimeError> {
        let Some(cursor) = cursor else {
            return Ok(());
        };
        if self.bootstrap.active_cursor != cursor.expected || cursor.next == cursor.expected {
            return Ok(());
        }
        validate_captured_cursor(&cursor.next)?;
        self.bootstrap.active_cursor = cursor.next;
        self.bootstrap.validate()
    }

    fn check_item_scope(&self, item: &ReplicaItemRecord) -> Result<(), RuntimeError> {
        if item.account_id == self.account_id {
            Ok(())
        } else {
            Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "item Account scope does not match the guarded plan",
            ))
        }
    }

    /// Rewinds the revision counter after a fixture replays Bootstrap prehistory.
    ///
    /// Only a test fixture may call this. Nothing observed the intermediate revisions, so no guard
    /// can be invalidated by rewinding them.
    #[cfg(test)]
    pub(super) fn reset_revision_for_seeding(&mut self, revision: u64) {
        self.revision = revision;
    }

    /// An overlay is the visible half of one accepted Operation, so it cannot outlive or precede it.
    fn check_overlay(&self, item: &ReplicaItemRecord) -> Result<(), RuntimeError> {
        if self
            .operations
            .get(&item.operation_id)
            .is_some_and(|operation| {
                operation.is_legacy_held()
                    && operation
                        .legacy_admission
                        .as_ref()
                        .is_none_or(|admission| admission.captured_failure_code.is_none())
            })
        {
            return Err(replica_invariant(
                "Held Operation without captured failure cannot own an optimistic overlay",
            ));
        }
        if self
            .cross_account_moves
            .get(&item.operation_id)
            .is_some_and(|entry| entry.source_unavailable().is_some())
        {
            return Err(replica_invariant(
                "Unavailable source evidence cannot own an Item overlay",
            ));
        }
        let witness = self
            .operations
            .get(&item.operation_id)
            .and_then(|operation| operation.accepted_item_category.as_ref())
            .or_else(|| {
                self.attachment_move_preparations
                    .get(&item.operation_id)
                    .and_then(|preparation| preparation.accepted_item_category.as_ref())
            })
            .or_else(|| {
                self.cross_account_moves
                    .get(&item.operation_id)
                    .and_then(CrossAccountMoveEntry::captured)
                    .map(|record| &record.source.category)
            });
        vault_retirement::validate_category(witness, &item.category)?;
        let identity = self
            .operations
            .get(&item.operation_id)
            .and_then(|operation| {
                operation
                    .target
                    .item_id()
                    .map(|item_id| (item_id, operation.vault_id()))
            })
            .or_else(|| {
                self.attachment_move_preparations
                    .get(&item.operation_id)
                    .map(|preparation| {
                        (
                            preparation.item_id.as_str(),
                            preparation.target_vault_id.as_str(),
                        )
                    })
            })
            .or_else(|| {
                self.cross_account_moves
                    .get(&item.operation_id)
                    .and_then(CrossAccountMoveEntry::captured)
                    .filter(|record| record.stage != CrossAccountMoveStage::Completed)
                    .map(|record| (record.source.id.as_str(), record.source.vault_id.as_str()))
            })
            .or_else(|| {
                self.receipts.get(&item.operation_id).and_then(|receipt| {
                    receipt
                        .target
                        .item_id()
                        .map(|item_id| (item_id, receipt.vault_id()))
                })
            });
        let Some((operation_item_id, operation_vault_id)) = identity else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "optimistic overlay has no accepted Operation",
            ));
        };
        if operation_item_id != item.item_id || operation_vault_id != item.vault_id {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "optimistic overlay does not match its Operation",
            ));
        }
        if item.encrypted_data.is_empty() || item.encryption_iv.is_empty() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "optimistic overlay carries no ciphertext",
            ));
        }
        Ok(())
    }

    pub(super) fn snapshot(&self) -> ReplicaSnapshot {
        let mut items: Vec<_> = self.items.values().cloned().collect();
        items.sort_by(|a, b| a.item_id.cmp(&b.item_id));
        let mut operations: Vec<_> = self.operations.values().cloned().collect();
        operations.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
        let mut cross_account_moves: Vec<_> = self.cross_account_moves.values().cloned().collect();
        cross_account_moves.sort_by(|a, b| a.operation_id().cmp(b.operation_id()));
        let mut share_capabilities: Vec<_> = self.share_capabilities.values().cloned().collect();
        share_capabilities.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
        let mut attachment_move_preparations: Vec<_> = self
            .attachment_move_preparations
            .values()
            .cloned()
            .collect();
        attachment_move_preparations.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
        let mut receipts: Vec<_> = self.receipts.values().cloned().collect();
        receipts.sort_by(|a, b| a.operation_id.cmp(&b.operation_id));
        let mut rotation_attempts: Vec<_> = self.rotation_attempts.values().cloned().collect();
        rotation_attempts.sort_by(|a, b| a.start_operation_id.cmp(&b.start_operation_id));
        ReplicaSnapshot {
            account_id: self.account_id.clone(),
            user_id: self.user_id.clone(),
            incarnation: self.incarnation.clone(),
            revision: self.revision,
            lock_epoch: self.lock_epoch,
            items,
            operations,
            cross_account_moves,
            share_capabilities,
            attachment_move_preparations,
            receipts,
            rotation_attempts,
            failure: self.failure,
            bootstrap: self.bootstrap.clone(),
        }
    }
}

fn validate_checkpoint_transition(
    expected: &AttachmentMoveProgress,
    next: &AttachmentMoveProgress,
) -> Result<(), RuntimeError> {
    if expected.attachment_id() != next.attachment_id()
        || expected.expected_envelope_version() != next.expected_envelope_version()
    {
        return Err(replica_invariant(
            "Attachment Move checkpoint changed Attachment authority",
        ));
    }
    let valid = match (expected, next) {
        (
            AttachmentMoveProgress::Pending { .. },
            AttachmentMoveProgress::Encrypted {
                upload,
                artifact,
                payload,
                ..
            },
        ) => {
            *upload == AttachmentMoveUploadState::NeedsUpload
                && artifact.byte_length > 0
                && valid_ciphertext_digest(&artifact.ciphertext_sha256)
                && valid_ciphertext_digest(&artifact.artifact_id)
                && valid_prepared_attachment(payload)
        }
        (
            AttachmentMoveProgress::Encrypted {
                artifact: old_artifact,
                payload: old_payload,
                upload: AttachmentMoveUploadState::NeedsUpload,
                ..
            },
            AttachmentMoveProgress::Encrypted {
                artifact: new_artifact,
                payload: new_payload,
                upload: AttachmentMoveUploadState::Uploaded,
                ..
            },
        ) => old_artifact == new_artifact && old_payload == new_payload,
        _ => expected == next,
    };
    if !valid {
        return Err(replica_invariant(
            "Attachment Move checkpoint is not a valid next state",
        ));
    }
    Ok(())
}

fn valid_ciphertext_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_artifact_ref(
    artifact: &AttachmentMoveArtifactRef,
    account_id: &AccountId,
    operation_id: &str,
    attachment_id: &str,
) -> Result<(), RuntimeError> {
    let expected = attachment_move_artifact_ref(
        account_id,
        operation_id,
        attachment_id,
        &artifact.ciphertext_sha256,
        artifact.byte_length,
    )?;
    if expected == *artifact {
        Ok(())
    } else {
        Err(replica_invariant(
            "Attachment Move artifact reference is not canonical for its owner",
        ))
    }
}

fn valid_prepared_attachment(value: &PreparedMoveAttachment) -> bool {
    !value.encrypted_name.is_empty()
        && !value.encryption_iv.is_empty()
        && !value.encryption_algorithm.is_empty()
        && !value.encrypted_attachment_key.is_empty()
        && !value.attachment_key_iv.is_empty()
        && !value.attachment_key_algorithm.is_empty()
        && !value.encrypted_content_type.is_empty()
        && !value.encrypted_content_type_iv.is_empty()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentMoveIntentFingerprint<'a> {
    account_id: &'a AccountId,
    operation_id: &'a str,
    item_id: &'a str,
    source_vault_id: &'a str,
    target_vault_id: &'a str,
    expected_item_version: i32,
    target_encrypted_data: &'a str,
    target_encryption_algorithm: &'a str,
    target_encryption_iv: &'a str,
    source_attachments: &'a [AuthorityAttachmentRecord],
}

pub(crate) fn attachment_move_intent_fingerprint(
    preparation: &AttachmentMovePreparationRecord,
) -> Result<Sha256Fingerprint, RuntimeError> {
    use sha2::{Digest, Sha256};
    let bytes = serde_json::to_vec(&AttachmentMoveIntentFingerprint {
        account_id: &preparation.account_id,
        operation_id: &preparation.operation_id,
        item_id: &preparation.item_id,
        source_vault_id: &preparation.source_vault_id,
        target_vault_id: &preparation.target_vault_id,
        expected_item_version: preparation.expected_item_version,
        target_encrypted_data: &preparation.target_encrypted_data,
        target_encryption_algorithm: &preparation.target_encryption_algorithm,
        target_encryption_iv: &preparation.target_encryption_iv,
        source_attachments: &preparation.source_attachments,
    })
    .map_err(|_| replica_invariant("Attachment Move intent could not be serialized"))?;
    let mut hasher = Sha256::new();
    hasher.update(b"bittery.attachment-move-intent.v1");
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
    Ok(Sha256Fingerprint(hasher.finalize().into()))
}

fn rejection_operation(
    preparation: &AttachmentMovePreparationRecord,
) -> Result<OperationRecord, RuntimeError> {
    use crate::server_contract::{MoveAttachmentIntentBody, MoveItemBody};
    let attachments = preparation
        .source_attachments
        .iter()
        .map(|attachment| MoveAttachmentIntentBody {
            attachment_id: attachment.id.clone(),
            expected_envelope_version: attachment.envelope_version,
        })
        .collect();
    let body = serde_json::to_vec(&MoveItemBody::RejectStaleAuthority {
        attachments,
        source_vault_id: preparation.source_vault_id.clone(),
        target_vault_id: preparation.target_vault_id.clone(),
    })
    .map_err(|_| replica_invariant("Attachment Move rejection could not be frozen"))?;
    let mut operation = move_operation(preparation, body)?;
    operation.attachment_move_recovery = Some(AttachmentMoveRecovery::RejectStaleAuthority {
        preparation: Box::new(preparation.clone()),
    });
    Ok(operation)
}

fn prepared_move_operation(
    preparation: &AttachmentMovePreparationRecord,
) -> Result<OperationRecord, RuntimeError> {
    use crate::server_contract::{MoveAttachmentBody, MoveItemBody};
    let mut attachments = Vec::with_capacity(preparation.progress.len());
    for progress in &preparation.progress {
        let AttachmentMoveProgress::Encrypted {
            attachment_id,
            expected_envelope_version,
            payload,
            upload: AttachmentMoveUploadState::Uploaded,
            ..
        } = progress
        else {
            return Err(replica_invariant(
                "Attachment Move cannot promote before every upload is complete",
            ));
        };
        attachments.push(MoveAttachmentBody {
            attachment_id: attachment_id.clone(),
            attachment_key_algorithm: payload.attachment_key_algorithm.clone(),
            attachment_key_iv: payload.attachment_key_iv.clone(),
            encrypted_attachment_key: payload.encrypted_attachment_key.clone(),
            encrypted_content_type: payload.encrypted_content_type.clone(),
            encrypted_content_type_iv: payload.encrypted_content_type_iv.clone(),
            encrypted_name: payload.encrypted_name.clone(),
            encryption_algorithm: payload.encryption_algorithm.clone(),
            encryption_iv: payload.encryption_iv.clone(),
            expected_envelope_version: *expected_envelope_version,
        });
    }
    let body = serde_json::to_vec(&MoveItemBody::Prepared {
        attachments: Some(attachments),
        encrypted_data: preparation.target_encrypted_data.clone(),
        encryption_algorithm: preparation.target_encryption_algorithm.clone(),
        encryption_iv: preparation.target_encryption_iv.clone(),
        source_vault_id: preparation.source_vault_id.clone(),
        target_vault_id: preparation.target_vault_id.clone(),
    })
    .map_err(|_| replica_invariant("Attachment Move request could not be frozen"))?;
    let mut operation = move_operation(preparation, body)?;
    operation.attachment_move_recovery = Some(AttachmentMoveRecovery::Prepared {
        preparation: Box::new(preparation.clone()),
    });
    Ok(operation)
}

fn move_operation(
    preparation: &AttachmentMovePreparationRecord,
    body: Vec<u8>,
) -> Result<OperationRecord, RuntimeError> {
    let request_fingerprint = item_operation_fingerprint(
        OperationKind::MoveItem,
        "POST /api/v1/items/{itemId}/moves",
        &preparation.item_id,
        &body,
        preparation.expected_item_version,
    );
    let operation = OperationRecord {
        operation_id: preparation.operation_id.clone(),
        kind: OperationKind::MoveItem,
        target: ResourceRef::Item {
            item_id: preparation.item_id.clone(),
            vault_id: preparation.target_vault_id.clone(),
        },
        request: ImmutableHttpRequest {
            method: HttpMethod::Post,
            path: format!("/api/v1/items/{}/moves", preparation.item_id),
            headers: vec![
                HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                },
                HttpHeader {
                    name: "If-Match".into(),
                    value: format!("\"{}\"", preparation.expected_item_version),
                },
            ],
            body,
        },
        request_fingerprint,
        accepted_item_category: preparation.accepted_item_category.clone(),
        attachment_move_recovery: None,
        update_vault: None,
        create_vault: None,
        scheduling: preparation.scheduling,
        legacy_admission: None,
    };
    check_immutable_request(&operation)?;
    Ok(operation)
}

/// Covers the route identity and the exact body bytes, and deliberately not the Operation ID.
///
/// Fingerprint and identity have to be able to disagree: slice C reads the same ID arriving with
/// another fingerprint as identity reuse, which is only detectable while the two are independent.
pub(crate) fn create_item_fingerprint(
    vault_id: &str,
    item_id: &str,
    body: &[u8],
) -> Sha256Fingerprint {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [
        b"bittery.operation.v1".as_slice(),
        b"create_item".as_slice(),
        b"PUT /api/v1/vaults/{vaultId}/items/{itemId}".as_slice(),
        vault_id.as_bytes(),
        item_id.as_bytes(),
        body,
        // The Server hashes normalized concurrency preconditions here. A create has none.
        b"" as &[u8],
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    Sha256Fingerprint(hasher.finalize().into())
}

pub(crate) fn share_operation_fingerprint(item_id: &str, body: &[u8]) -> Sha256Fingerprint {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [
        b"bittery.operation.v1".as_slice(),
        b"create_share".as_slice(),
        b"POST /api/v1/items/{itemId}/share-links".as_slice(),
        item_id.as_bytes(),
        body,
        b"" as &[u8],
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    Sha256Fingerprint(hasher.finalize().into())
}

pub(crate) fn item_operation_fingerprint(
    kind: OperationKind,
    route: &str,
    item_id: &str,
    body: &[u8],
    expected_version: i32,
) -> Sha256Fingerprint {
    use sha2::{Digest, Sha256};
    let kind = match kind {
        OperationKind::CreateVault => "create_vault",
        OperationKind::UpdateVault => "update_vault",
        OperationKind::DeleteVault => "delete_vault",
        OperationKind::CreateItem => "create_item",
        OperationKind::UpdateItem => "update_item",
        OperationKind::SetItemFavorite => "set_item_favorite",
        OperationKind::TrashItem => "trash_item",
        OperationKind::RestoreItem => "restore_item",
        OperationKind::MoveItem => "move_item",
        OperationKind::PermanentlyDeleteItem => "permanently_delete_item",
        OperationKind::CreateShare => "create_share",
        OperationKind::ImportItems => "import_items",
        OperationKind::CreateVaultMemberRemovalRotationPlans => {
            "create_vault_member_removal_rotation_plans"
        }
        OperationKind::FinalizeVaultMemberRemovalRotationPlans => {
            "finalize_vault_member_removal_rotation_plans"
        }
        OperationKind::CreateTeamLeaveRotationPlans => "create_team_leave_rotation_plans",
        OperationKind::FinalizeTeamLeaveRotationPlans => "finalize_team_leave_rotation_plans",
        OperationKind::CreateTeamMemberRemovalRotationPlans => {
            "create_team_member_removal_rotation_plans"
        }
        OperationKind::FinalizeTeamMemberRemovalRotationPlans => {
            "finalize_team_member_removal_rotation_plans"
        }
    };
    let expected_version = expected_version.to_string();
    let mut hasher = Sha256::new();
    for part in [
        b"bittery.operation.v1".as_slice(),
        kind.as_bytes(),
        route.as_bytes(),
        item_id.as_bytes(),
        body,
        expected_version.as_bytes(),
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    Sha256Fingerprint(hasher.finalize().into())
}

/// Durable request bytes never carry a credential, and a durable route is never ambiguous.
fn check_immutable_request(operation: &OperationRecord) -> Result<(), RuntimeError> {
    vault_retirement::validate_operation_category(operation)?;
    if operation.operation_id.is_empty()
        || operation.target.vault_id_opt().is_some_and(str::is_empty)
        || matches!(&operation.target, ResourceRef::Team { team_id } if team_id.is_empty())
        || operation.target.item_id().is_some_and(str::is_empty)
    {
        return Err(replica_invariant("Operation identity is empty"));
    }
    if !operation.request.path.starts_with('/') {
        return Err(replica_invariant("Operation route path is not absolute"));
    }
    let unfinished_vault = operation
        .vault_image_checkpoint()
        .is_some_and(|checkpoint| checkpoint != CreateVaultCheckpoint::FinalRequestFrozen);
    if operation.request.body.is_empty()
        && !unfinished_vault
        && !matches!(
            operation.kind,
            OperationKind::TrashItem
                | OperationKind::RestoreItem
                | OperationKind::PermanentlyDeleteItem
                | OperationKind::CreateVaultMemberRemovalRotationPlans
                | OperationKind::CreateTeamLeaveRotationPlans
                | OperationKind::CreateTeamMemberRemovalRotationPlans
        )
    {
        return Err(replica_invariant("Operation request body is empty"));
    }
    if operation.update_vault.is_some() && operation.kind != OperationKind::UpdateVault {
        return Err(replica_invariant(
            "non-update Operation carries a Vault replacement intent",
        ));
    }
    match (&operation.kind, &operation.create_vault) {
        (OperationKind::CreateTeamLeaveRotationPlans, None)
            if matches!(operation.target, ResourceRef::Team { .. }) =>
        {
            validate_team_leave_rotation_start(operation)?;
        }
        (OperationKind::CreateTeamLeaveRotationPlans, _) => {
            return Err(replica_invariant(
                "Team-leave Rotation start target or intent is invalid",
            ));
        }
        (OperationKind::FinalizeTeamLeaveRotationPlans, None)
            if matches!(operation.target, ResourceRef::Team { .. }) =>
        {
            validate_team_leave_rotation_finalize(operation)?;
        }
        (OperationKind::FinalizeTeamLeaveRotationPlans, _) => {
            return Err(replica_invariant(
                "Team-leave Rotation finalize target is invalid",
            ));
        }
        (OperationKind::DeleteVault, None)
            if matches!(operation.target, ResourceRef::Vault { .. }) =>
        {
            if operation.request.method != HttpMethod::Post
                || operation.request.path
                    != format!("/api/v1/vaults/{}/deletions", operation.vault_id())
                || operation.request.headers
                    != [HttpHeader {
                        name: "Content-Type".into(),
                        value: "application/json".into(),
                    }]
                || operation.request.body != b"{}"
                || operation.request_fingerprint != vault_deletion_fingerprint(operation.vault_id())
            {
                return Err(replica_invariant(
                    "Vault deletion request changed or is invalid",
                ));
            }
        }
        (OperationKind::DeleteVault, _) => {
            return Err(replica_invariant(
                "Vault deletion target or intent is invalid",
            ));
        }
        (OperationKind::UpdateVault, None)
            if matches!(operation.target, ResourceRef::Vault { .. }) =>
        {
            validate_vault_update_operation(operation)?;
        }
        (OperationKind::UpdateVault, _) => {
            return Err(replica_invariant(
                "Vault update target or intent is invalid",
            ));
        }
        (OperationKind::CreateVault, Some(record))
            if matches!(operation.target, ResourceRef::Vault { .. })
                && !record.name.is_empty()
                && !record.icon.is_empty()
                && !record.encrypted_vault_key.is_empty() => {}
        (OperationKind::CreateVault, _) => {
            return Err(replica_invariant("create-Vault durable intent is invalid"));
        }
        (OperationKind::ImportItems, None)
            if matches!(operation.target, ResourceRef::ImportBatch { .. }) =>
        {
            validate_import_operation(operation)?;
        }
        // Closes the kind. Without this arm an Import record naming an Item target would reach
        // the permissive Item arm below and skip every Import validation.
        (OperationKind::ImportItems, _) => {
            return Err(replica_invariant("Import durable intent is invalid"));
        }
        (_, Some(_)) => {
            return Err(replica_invariant(
                "non-Vault Operation carries Vault intent",
            ));
        }
        (_, None) if matches!(operation.target, ResourceRef::Item { .. }) => {}
        (_, None) => {
            return Err(replica_invariant(
                "Item Operation carries a non-Item resource target",
            ));
        }
    }
    for header in &operation.request.headers {
        if header.name.eq_ignore_ascii_case("authorization")
            || header.name.eq_ignore_ascii_case("cookie")
        {
            return Err(replica_invariant(
                "Operation request bytes cannot carry a credential",
            ));
        }
    }
    Ok(())
}

fn validate_team_leave_rotation_start(operation: &OperationRecord) -> Result<(), RuntimeError> {
    let ResourceRef::Team { team_id } = &operation.target else {
        return Err(replica_invariant(
            "Team-leave Rotation start has no Team target",
        ));
    };
    let path = format!(
        "/api/v1/teams/{}/leave-rotation-plans",
        encode_component(team_id)
    );
    let fingerprint = rotation_start_fingerprint(
        b"create_team_leave_rotation_plans",
        b"POST /api/v1/teams/{teamId}/leave-rotation-plans",
        &[team_id],
    );
    if operation.request.method != HttpMethod::Post
        || operation.request.path != path
        || !operation.request.headers.is_empty()
        || !operation.request.body.is_empty()
        || operation.request_fingerprint != fingerprint
        || operation.accepted_item_category.is_some()
        || operation.attachment_move_recovery.is_some()
        || operation.update_vault.is_some()
    {
        return Err(replica_invariant(
            "Team-leave Rotation start request changed",
        ));
    }
    Ok(())
}

fn validate_team_leave_rotation_finalize(operation: &OperationRecord) -> Result<(), RuntimeError> {
    let ResourceRef::Team { team_id } = &operation.target else {
        return Err(replica_invariant(
            "Team-leave Rotation finalize has no Team target",
        ));
    };
    #[derive(Serialize, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct FinalizePlanSet {
        #[serde(rename = "planIds")]
        plan_ids: Vec<String>,
    }
    let request: FinalizePlanSet = serde_json::from_slice(&operation.request.body)
        .map_err(|_| replica_invariant("Team-leave Rotation finalize body is invalid"))?;
    let mut seen = HashSet::new();
    if request.plan_ids.len() > 21_000
        || request
            .plan_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 128 || !seen.insert(id))
    {
        return Err(replica_invariant(
            "Team-leave Rotation finalize plan list is invalid",
        ));
    }
    let body = serde_json::to_vec(&request)
        .map_err(|_| replica_invariant("Team-leave Rotation finalize body is invalid"))?;
    let fingerprint = rotation_request_fingerprint(
        b"finalize_team_leave_rotation_plans",
        b"POST /api/v1/teams/{teamId}/leave-rotation-plans/finalize",
        &[team_id],
        &body,
    );
    if operation.request.method != HttpMethod::Post
        || operation.request.path
            != format!(
                "/api/v1/teams/{}/leave-rotation-plans/finalize",
                encode_component(team_id)
            )
        || operation.request.headers
            != [HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }]
        || operation.request.body != body
        || operation.request_fingerprint != fingerprint
        || operation.accepted_item_category.is_some()
        || operation.attachment_move_recovery.is_some()
        || operation.update_vault.is_some()
    {
        return Err(replica_invariant(
            "Team-leave Rotation finalize request changed",
        ));
    }
    Ok(())
}

fn rotation_start_fingerprint(
    kind: &[u8],
    route: &[u8],
    path_values: &[&str],
) -> Sha256Fingerprint {
    rotation_request_fingerprint(kind, route, path_values, b"")
}

fn rotation_request_fingerprint(
    kind: &[u8],
    route: &[u8],
    path_values: &[&str],
    body: &[u8],
) -> Sha256Fingerprint {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [b"bittery.operation.v1".as_slice(), kind, route]
        .into_iter()
        .chain(path_values.iter().map(|value| value.as_bytes()))
        .chain([body, b"".as_slice()])
    {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    Sha256Fingerprint(hasher.finalize().into())
}

pub(crate) fn vault_update_fingerprint(vault_id: &str, body: &[u8]) -> Sha256Fingerprint {
    vault_mutation_fingerprint(
        b"update_vault",
        b"POST /api/v1/vaults/{vaultId}/metadata-updates",
        vault_id,
        body,
    )
}

pub(crate) fn vault_deletion_fingerprint(vault_id: &str) -> Sha256Fingerprint {
    vault_mutation_fingerprint(
        b"delete_vault",
        b"POST /api/v1/vaults/{vaultId}/deletions",
        vault_id,
        b"{}",
    )
}

fn vault_mutation_fingerprint(
    kind: &[u8],
    route: &[u8],
    vault_id: &str,
    body: &[u8],
) -> Sha256Fingerprint {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [
        b"bittery.operation.v1".as_slice(),
        kind,
        route,
        vault_id.as_bytes(),
        body,
        b"",
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    Sha256Fingerprint(hasher.finalize().into())
}

pub(crate) fn vault_update_fields(
    name: Option<&str>,
    icon: &crate::VaultIconPatch,
) -> serde_json::Map<String, serde_json::Value> {
    let mut fields = serde_json::Map::new();
    if let Some(name) = name {
        fields.insert("name".into(), name.into());
    }
    match icon {
        crate::VaultIconPatch::Unchanged => {}
        crate::VaultIconPatch::Clear => {
            fields.insert("icon".into(), serde_json::Value::Null);
        }
        crate::VaultIconPatch::Set { value } => {
            fields.insert("icon".into(), value.clone().into());
        }
    }
    fields
}

pub(crate) fn canonical_vault_image_update_request(
    vault_id: &str,
    intent: &UpdateVaultImageOperationRecord,
) -> Result<(ImmutableHttpRequest, Sha256Fingerprint), RuntimeError> {
    let mut fields = vault_update_fields(intent.name.as_deref(), &intent.icon);
    validate_vault_update_fields(&fields).map_err(replica_invariant)?;
    fields.insert("imageKey".into(), intent.image.object_key.clone().into());
    let body = serde_json::to_vec(&fields)
        .map_err(|_| replica_invariant("Vault update cannot be encoded"))?;
    let fingerprint = vault_update_fingerprint(vault_id, &body);
    Ok((
        ImmutableHttpRequest {
            method: HttpMethod::Post,
            path: format!("/api/v1/vaults/{vault_id}/metadata-updates"),
            headers: vec![HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
            body,
        },
        fingerprint,
    ))
}

pub(crate) fn validate_vault_update_fields(
    fields: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), &'static str> {
    for (key, value) in fields {
        let valid = match key.as_str() {
            "name" => value.as_str().is_some_and(|name| {
                name == name.trim()
                    && (2..=CREATE_VAULT_NAME_MAX_CHARS).contains(&name.chars().count())
            }),
            "icon" => {
                value.is_null()
                    || value
                        .as_str()
                        .is_some_and(|icon| icon.chars().count() <= CREATE_VAULT_ICON_MAX_CHARS)
            }
            "imageKey" => value.is_null(),
            _ => false,
        };
        if !valid {
            return Err("Vault metadata is outside the shared bounds");
        }
    }
    Ok(())
}

fn validate_vault_update_operation(operation: &OperationRecord) -> Result<(), RuntimeError> {
    if let Some(intent) = &operation.update_vault {
        let (request, fingerprint) =
            canonical_vault_image_update_request(operation.vault_id(), intent)?;
        let expected_body: &[u8] = if intent.checkpoint == CreateVaultCheckpoint::FinalRequestFrozen
        {
            &request.body
        } else {
            &[]
        };
        if operation.request.method != request.method
            || operation.request.path != request.path
            || operation.request.headers != request.headers
            || operation.request.body != expected_body
            || operation.request_fingerprint != fingerprint
        {
            return Err(replica_invariant(
                "Vault image update changed its accepted request",
            ));
        }
        return Ok(());
    }
    // The generated Server body closes unknown and duplicate fields. The value pass below
    // additionally preserves omission/null distinctions and enforces Core admission bounds.
    let _: crate::server_contract::VaultMetadataUpdateBody =
        serde_json::from_slice(&operation.request.body)
            .map_err(|_| replica_invariant("Vault update body violates the Server contract"))?;
    let body: serde_json::Value = serde_json::from_slice(&operation.request.body)
        .map_err(|_| replica_invariant("Vault update body is malformed"))?;
    let Some(fields) = body.as_object() else {
        return Err(replica_invariant("Vault update body must be an object"));
    };
    validate_vault_update_fields(fields).map_err(replica_invariant)?;
    if operation.request.method != HttpMethod::Post
        || operation.request.path
            != format!("/api/v1/vaults/{}/metadata-updates", operation.vault_id())
        || operation.request.headers
            != [HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }]
        || vault_update_fingerprint(operation.vault_id(), &operation.request.body)
            != operation.request_fingerprint
    {
        return Err(replica_invariant(
            "Vault update request changed or is invalid",
        ));
    }
    Ok(())
}

fn validate_import_operation(operation: &OperationRecord) -> Result<(), RuntimeError> {
    let path = import_items_path(operation.vault_id());
    if operation.request.method != HttpMethod::Post
        || operation.request.path != path
        || operation.request.headers
            != [HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }]
    {
        return Err(replica_invariant("Import request route or headers changed"));
    }
    let body: crate::wire::import::ImportRequestBody =
        serde_json::from_slice(&operation.request.body)
            .map_err(|_| replica_invariant("Import request body is malformed"))?;
    if body.items.len() > MAX_IMPORT_ITEMS {
        return Err(replica_invariant("Import request exceeds its Item bound"));
    }
    let mut ids = std::collections::HashSet::new();
    for item in body.items {
        if item.item_id.is_empty()
            || !ids.insert(item.item_id)
            || item.encrypted_data.is_empty()
            || item.encryption_iv.is_empty()
            || item.encryption_algorithm.is_empty()
        {
            return Err(replica_invariant("Import request Item is invalid"));
        }
    }
    if import_items_fingerprint(operation.vault_id(), &operation.request.body)
        != operation.request_fingerprint
    {
        return Err(replica_invariant("Import request fingerprint changed"));
    }
    Ok(())
}

pub(super) fn validate_operation_receipt(
    receipt: &OperationReceiptRecord,
    user_id: &str,
) -> Result<(), RuntimeError> {
    if matches!(receipt.target, ResourceRef::Team { .. })
        && !matches!(
            receipt.kind,
            OperationKind::CreateTeamLeaveRotationPlans
                | OperationKind::FinalizeTeamLeaveRotationPlans
        )
    {
        return Err(replica_invariant(
            "Operation receipt kind cannot have a Team target",
        ));
    }
    let item_target = match &receipt.target {
        ResourceRef::Item { item_id, vault_id } if !item_id.is_empty() && !vault_id.is_empty() => {
            Some(item_id.as_str())
        }
        ResourceRef::Vault { vault_id } | ResourceRef::ImportBatch { vault_id }
            if !vault_id.is_empty() =>
        {
            None
        }
        ResourceRef::Team { team_id } if !team_id.is_empty() => None,
        _ => return Err(replica_invariant("Operation receipt target is empty")),
    };
    if receipt.operation_id.is_empty() {
        return Err(replica_invariant("Operation receipt identity is empty"));
    }
    if let Some(lineage) = &receipt.legacy_lineage {
        lineage.validate()?;
        let expected_operation_id = match receipt.kind {
            OperationKind::CreateItem => lineage.source_operation_id.as_deref(),
            OperationKind::UpdateItem
            | OperationKind::SetItemFavorite
            | OperationKind::TrashItem
            | OperationKind::RestoreItem
            | OperationKind::MoveItem
            | OperationKind::PermanentlyDeleteItem => lineage.source_attempt_id.as_deref(),
            _ => return Err(replica_invariant("Legacy receipt kind is unsupported")),
        }
        .unwrap_or(&lineage.source_command_id);
        if receipt.operation_id != expected_operation_id
            || !(LegacyItemCommandStatus::is_normal(lineage.source_status)
                || matches!(
                    lineage.source_status,
                    Some(LegacyItemCommandStatus::Failed | LegacyItemCommandStatus::Conflicted)
                ))
        {
            return Err(replica_invariant(
                "Legacy Operation receipt lineage changed identity",
            ));
        }
    }

    let result_matches = match (receipt.kind, item_target, &receipt.result) {
        (
            OperationKind::FinalizeTeamLeaveRotationPlans,
            None,
            OperationOutcomeResult::RotationFinalizeApplied {
                personal_team_id, ..
            },
        ) => {
            matches!(receipt.target, ResourceRef::Team { .. })
                && !personal_team_id.is_empty()
                && personal_team_id.len() <= 128
        }
        (
            OperationKind::FinalizeTeamLeaveRotationPlans,
            None,
            OperationOutcomeResult::RotationFinalizeRejected { code, details },
        ) => {
            matches!(receipt.target, ResourceRef::Team { .. })
                && (details.is_none()
                    || (*code == RotationFinalizeRejectionCode::RotationPlanStale
                        && details
                            .as_ref()
                            .is_some_and(|detail| !detail.plan_id.is_empty())))
        }
        (
            OperationKind::CreateTeamLeaveRotationPlans,
            None,
            OperationOutcomeResult::RotationStartAppliedReceipt {
                plan_set_fingerprint: _,
                plan_count: _,
            },
        ) => matches!(receipt.target, ResourceRef::Team { .. }),
        (
            OperationKind::CreateTeamLeaveRotationPlans,
            None,
            OperationOutcomeResult::RotationStartRejected { code },
        ) => {
            matches!(receipt.target, ResourceRef::Team { .. })
                && matches!(
                    code,
                    RotationStartRejectionCode::TeamMemberNotFound
                        | RotationStartRejectionCode::PersonalTeamDepartureForbidden
                        | RotationStartRejectionCode::TeamOwnerLeaveForbidden
                )
        }
        (
            OperationKind::CreateVault | OperationKind::UpdateVault | OperationKind::DeleteVault,
            None,
            OperationOutcomeResult::VaultApplied { vault_id },
        ) => vault_id == receipt.vault_id() && matches!(receipt.target, ResourceRef::Vault { .. }),
        (OperationKind::CreateVault, None, OperationOutcomeResult::VaultRejected { .. }) => true,
        (
            OperationKind::UpdateVault | OperationKind::DeleteVault,
            None,
            OperationOutcomeResult::VaultMutationRejected { .. },
        ) => matches!(receipt.target, ResourceRef::Vault { .. }),
        (
            OperationKind::ImportItems,
            None,
            OperationOutcomeResult::ImportApplied {
                vault_id,
                imported_count,
            },
        ) => vault_id == receipt.vault_id() && usize::from(*imported_count) <= MAX_IMPORT_ITEMS,
        (OperationKind::ImportItems, None, OperationOutcomeResult::ImportRejected { .. }) => true,
        (
            OperationKind::CreateShare,
            Some(_),
            OperationOutcomeResult::ShareApplied {
                share_link_id,
                base_share_url,
                expires_at,
            },
        ) => !share_link_id.is_empty() && !base_share_url.is_empty() && !expires_at.is_empty(),
        (OperationKind::CreateShare, Some(_), OperationOutcomeResult::Rejected { code }) => {
            matches!(
                code,
                OperationRejectionCode::ItemNotFound
                    | OperationRejectionCode::VaultReadOnly
                    | OperationRejectionCode::ShareEntitlementDenied
                    | OperationRejectionCode::ShareLimitReached
            )
        }
        (
            OperationKind::CreateItem,
            Some(item_id),
            OperationOutcomeResult::Applied { entity_id, version },
        ) => entity_id == item_id && *version >= 1,
        (OperationKind::CreateItem, Some(_), OperationOutcomeResult::Rejected { code }) => {
            receipt_rejection_allowed(OperationKind::CreateItem, *code)
        }
        (
            OperationKind::UpdateItem
            | OperationKind::SetItemFavorite
            | OperationKind::TrashItem
            | OperationKind::RestoreItem
            | OperationKind::MoveItem
            | OperationKind::PermanentlyDeleteItem,
            Some(item_id),
            OperationOutcomeResult::Applied { entity_id, version },
        ) => entity_id == item_id && *version >= 1,
        (kind, Some(_), OperationOutcomeResult::Rejected { code }) => {
            receipt_rejection_allowed(kind, *code)
        }
        _ => false,
    };
    if !result_matches {
        return Err(replica_invariant(
            "Operation receipt kind, target, and result are inconsistent",
        ));
    }

    if let Some(cleanup) = &receipt.create_vault_cleanup {
        let valid_state = match &receipt.result {
            OperationOutcomeResult::VaultApplied { .. } => {
                cleanup.local_artifact_pending && !cleanup.remote_staging_pending
            }
            OperationOutcomeResult::VaultRejected { .. }
            | OperationOutcomeResult::VaultMutationRejected { .. } => {
                cleanup.remote_staging_pending
            }
            _ => false,
        };
        if !matches!(
            receipt.kind,
            OperationKind::CreateVault | OperationKind::UpdateVault
        ) || !valid_state
            || validate_create_vault_image(
                &cleanup.image,
                user_id,
                receipt.vault_id(),
                &receipt.operation_id,
            )
            .is_err()
        {
            return Err(replica_invariant(
                "create-Vault cleanup is not bound to its receipt",
            ));
        }
    }
    Ok(())
}

fn validate_create_vault_operation_context(
    operation: &OperationRecord,
    account_id: &AccountId,
    user_id: &str,
) -> Result<(), RuntimeError> {
    if let Some(intent) = &operation.update_vault {
        if intent.account_id != *account_id {
            return Err(replica_invariant(
                "Vault replacement belongs to another Account",
            ));
        }
        validate_create_vault_image(
            &intent.image,
            user_id,
            operation.vault_id(),
            &operation.operation_id,
        )?;
    }
    let Some(intent) = &operation.create_vault else {
        return Ok(());
    };
    if intent.account_id != *account_id {
        return Err(replica_invariant(
            "create-Vault durable intent belongs to another Account",
        ));
    }
    validate_create_vault_intent(
        intent,
        account_id,
        &operation.operation_id,
        operation.vault_id(),
    )?;
    if let Some(image) = &intent.image {
        validate_create_vault_image(
            image,
            user_id,
            operation.vault_id(),
            &operation.operation_id,
        )?;
    }
    let canonical = canonical_create_vault_request(operation.vault_id(), intent)?;
    if operation.request.method != HttpMethod::Put
        || operation.request.path != canonical.path
        || operation.request.headers
            != vec![HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }]
        || operation.request_fingerprint != canonical.fingerprint
    {
        return Err(replica_invariant(
            "create-Vault request identity is not canonical",
        ));
    }
    match (intent.image.is_some(), intent.checkpoint) {
        (false, CreateVaultCheckpoint::FinalRequestFrozen) => {
            if operation.request.body != canonical.body {
                return Err(replica_invariant(
                    "final create-Vault request body is not canonical",
                ));
            }
        }
        (
            true,
            CreateVaultCheckpoint::ArtifactReady | CreateVaultCheckpoint::RemoteUploadConfirmed,
        ) => {
            if !operation.request.body.is_empty() {
                return Err(replica_invariant(
                    "unfinished create-Vault request already carries final bytes",
                ));
            }
        }
        (true, CreateVaultCheckpoint::FinalRequestFrozen) => {
            if operation.request.body != canonical.body {
                return Err(replica_invariant(
                    "final create-Vault request body is not canonical",
                ));
            }
        }
        (false, _) => {
            return Err(replica_invariant(
                "image-free create-Vault intent has an image-staging checkpoint",
            ));
        }
    }
    Ok(())
}

/// Reapplies the complete immutable acceptance policy anywhere durable create-Vault work enters
/// Domain: initial acceptance, guarded checkpoints, serialized reconstruction, and SQLite load.
const CREATE_VAULT_NAME_MAX_CHARS: usize = 200;
const CREATE_VAULT_ICON_MAX_CHARS: usize = 128;
const CREATE_VAULT_ENCRYPTED_KEY_MAX_BYTES: usize = 64 * 1024;

pub(crate) fn validate_create_vault_text_fields(
    name: &str,
    icon: &str,
) -> Result<(), &'static str> {
    let name_chars = name.chars().count();
    if name != name.trim() || !(2..=CREATE_VAULT_NAME_MAX_CHARS).contains(&name_chars) {
        return Err("Vault name is outside the shared bound");
    }
    let icon_chars = icon.chars().count();
    if icon != icon.trim() || !(1..=CREATE_VAULT_ICON_MAX_CHARS).contains(&icon_chars) {
        return Err("Vault icon is outside the shared bound");
    }
    Ok(())
}

fn validate_create_vault_intent(
    intent: &CreateVaultOperationRecord,
    account_id: &AccountId,
    operation_id: &str,
    vault_id: &str,
) -> Result<(), RuntimeError> {
    for (value, label) in [
        (account_id.as_str(), "Account"),
        (operation_id, "Operation"),
        (vault_id, "Vault"),
    ] {
        crate::vault_image::validate_identity(value, label)
            .map_err(|_| replica_invariant(format!("create-Vault {label} identity is invalid")))?;
    }
    validate_create_vault_text_fields(&intent.name, &intent.icon).map_err(|message| {
        replica_invariant(format!("create-Vault intent is invalid: {message}"))
    })?;
    if intent.encrypted_vault_key.trim().is_empty()
        || intent.encrypted_vault_key.len() > CREATE_VAULT_ENCRYPTED_KEY_MAX_BYTES
    {
        return Err(replica_invariant(
            "create-Vault wrapped key is outside the Server bound",
        ));
    }
    Ok(())
}

fn validate_create_vault_image(
    image: &CreateVaultImageRecord,
    user_id: &str,
    vault_id: &str,
    operation_id: &str,
) -> Result<(), RuntimeError> {
    let valid_sha = image.sha256.len() == 64
        && image
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    let expected_key = format!(
        "vaults/{user_id}/{vault_id}/create/{operation_id}-{}",
        image.sha256
    );
    if !(1..=crate::vault_image::VAULT_IMAGE_MAX_BYTES).contains(&image.byte_length)
        || !matches!(
            image.content_type.as_str(),
            "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif"
        )
        || !valid_sha
        || image.object_key != expected_key
    {
        return Err(replica_invariant(
            "create-Vault image is not canonical for its owner",
        ));
    }
    if image.raw_cleanup_pending && image.protected_witness.is_none() {
        return Err(replica_invariant(
            "Raw image cleanup has no protected replacement witness",
        ));
    }
    if let Some(witness) = &image.protected_witness {
        crate::vault_image::protected::validate_witness(witness, image.byte_length)?;
    }

    Ok(())
}

fn receipt_rejection_allowed(kind: OperationKind, code: OperationRejectionCode) -> bool {
    use OperationKind::{
        MoveItem, PermanentlyDeleteItem, RestoreItem, SetItemFavorite, TrashItem, UpdateItem,
    };
    use OperationRejectionCode::{
        AttachmentStateConflict, InvalidCiphertext, ItemIdConflict, ItemNotFound, ItemNotTrashed,
        ItemTrashed, ItemVersionConflict, SourceVaultMismatch, TargetVaultAccessDenied,
        TargetVaultReadOnly, VaultAccessDenied, VaultReadOnly,
    };
    match kind {
        OperationKind::CreateItem => matches!(
            code,
            InvalidCiphertext | VaultAccessDenied | VaultReadOnly | ItemIdConflict
        ),
        UpdateItem => matches!(
            code,
            InvalidCiphertext
                | VaultAccessDenied
                | VaultReadOnly
                | ItemNotFound
                | ItemVersionConflict
        ),
        SetItemFavorite => matches!(
            code,
            VaultAccessDenied | VaultReadOnly | ItemNotFound | ItemVersionConflict
        ),
        TrashItem => matches!(
            code,
            InvalidCiphertext
                | VaultAccessDenied
                | VaultReadOnly
                | ItemNotFound
                | ItemVersionConflict
        ),
        RestoreItem | PermanentlyDeleteItem => matches!(
            code,
            InvalidCiphertext
                | VaultAccessDenied
                | VaultReadOnly
                | ItemNotFound
                | ItemNotTrashed
                | ItemVersionConflict
        ),
        MoveItem => matches!(
            code,
            InvalidCiphertext
                | VaultAccessDenied
                | VaultReadOnly
                | ItemNotFound
                | SourceVaultMismatch
                | ItemTrashed
                | TargetVaultAccessDenied
                | TargetVaultReadOnly
                | ItemVersionConflict
                | AttachmentStateConflict
        ),
        _ => false,
    }
}

fn validate_create_vault_transition(
    existing: &OperationRecord,
    next: &OperationRecord,
) -> Result<(), RuntimeError> {
    let (Some(prior), Some(next_checkpoint)) = (
        existing.vault_image_checkpoint(),
        next.vault_image_checkpoint(),
    ) else {
        return Err(replica_invariant("Vault checkpoint has no durable intent"));
    };
    let mut expected = existing.clone();
    expected.set_vault_image_checkpoint(next_checkpoint);
    expected.request = next.request.clone();
    if !matches!(
        existing.kind,
        OperationKind::CreateVault | OperationKind::UpdateVault
    ) || expected != *next
        || existing.attachment_move_recovery.is_some()
    {
        return Err(replica_invariant(
            "Vault checkpoint changed immutable intent",
        ));
    }
    let allowed = matches!(
        (prior, next_checkpoint),
        (
            CreateVaultCheckpoint::ArtifactReady,
            CreateVaultCheckpoint::RemoteUploadConfirmed
        ) | (
            CreateVaultCheckpoint::RemoteUploadConfirmed,
            CreateVaultCheckpoint::FinalRequestFrozen
        )
    );
    if !allowed {
        return Err(replica_invariant(
            "create-Vault checkpoint transition is invalid",
        ));
    }
    if next_checkpoint == CreateVaultCheckpoint::FinalRequestFrozen {
        if next.request.body.is_empty() {
            return Err(replica_invariant(
                "frozen create-Vault request body is empty",
            ));
        }
    } else if existing.request != next.request
        || existing.request_fingerprint != next.request_fingerprint
    {
        return Err(replica_invariant(
            "pre-freeze create-Vault checkpoint changed request identity",
        ));
    }
    check_immutable_request(next)
}

#[allow(dead_code, reason = "the persistence wire invokes this model next")]
impl BootstrapAuthority {
    pub(crate) fn admit_legacy(plan: LegacyAdmissionBootstrap) -> Result<Self, RuntimeError> {
        validate_legacy_origin(&plan.origin)?;
        let generation_id = legacy_admission_generation_id(&plan.origin.incarnation);
        validate_authority_page(&plan.vaults, &plan.items)?;
        let vault_ids = plan
            .vaults
            .iter()
            .map(|vault| vault.id.as_str())
            .collect::<HashSet<_>>();
        if plan
            .items
            .iter()
            .any(|item| !vault_ids.contains(item.vault_id.as_str()))
        {
            return Err(replica_invariant(
                "legacy admission Item references a missing Vault",
            ));
        }
        let state = if plan.cursor == SyncCursor::Cold {
            ReplicaState::RefreshRequired
        } else {
            validate_captured_cursor(&plan.cursor)?;
            ReplicaState::Ready
        };
        let generation = BootstrapGenerationRecord {
            generation_id: generation_id.clone(),
            fallback_state: state,
            pinned_watermark: plan.cursor.clone(),
            next_page_identity: BootstrapPageIdentity::vaults(0),
            next_page_cursor: BootstrapPageCursor::VaultsInitial,
            final_page_staged: false,
            vault_key_version_proved: false,
            legacy_admission: Some(plan.origin),
        };
        let authority = Self {
            state,
            active_generation: Some(generation_id.clone()),
            active_cursor: plan.cursor,
            generations: HashMap::from([(generation_id.clone(), generation)]),
            vaults: plan
                .vaults
                .into_iter()
                .map(|vault| ((generation_id.clone(), vault.id.clone()), vault))
                .collect(),
            items: plan
                .items
                .into_iter()
                .map(|item| ((generation_id.clone(), item.id.clone()), item))
                .collect(),
            ..Self::default()
        };
        authority.validate()?;
        Ok(authority)
    }

    pub(crate) fn validate_legacy_binding(
        &self,
        account_id: &AccountId,
        user_id: &str,
        incarnation: &Incarnation,
    ) -> Result<(), RuntimeError> {
        for (generation_id, generation) in &self.generations {
            if let Some(origin) = &generation.legacy_admission {
                if &origin.account_id != account_id
                    || origin.user_id != user_id
                    || &origin.incarnation != incarnation
                    || generation_id != &legacy_admission_generation_id(incarnation)
                {
                    return Err(replica_invariant(
                        "legacy admission generation binding is inconsistent",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn has_control_state(&self) -> bool {
        self.policy_verification_pending
            || self.state != ReplicaState::Cold
            || self.active_generation.is_some()
            || self.active_cursor != SyncCursor::Cold
            || self.staging_generation.is_some()
            || !self.generations.is_empty()
            || !self.pages.is_empty()
            || !self.vaults.is_empty()
            || !self.items.is_empty()
    }
    pub(super) fn row_count(&self) -> usize {
        let metadata = usize::from(self.has_control_state())
            + usize::from(!self.pending_vault_retirements.is_empty());
        metadata + self.generations.len() + self.pages.len() + self.vaults.len() + self.items.len()
    }

    pub(crate) fn validate(&self) -> Result<(), RuntimeError> {
        validate_retired_vault_ids(&self.pending_vault_retirements)?;
        if self
            .vaults
            .values()
            .any(|vault| self.pending_vault_retirements.contains(&vault.id))
            || self
                .items
                .values()
                .any(|item| self.pending_vault_retirements.contains(&item.vault_id))
        {
            return Err(replica_invariant(
                "pending Vault retirement retains authority",
            ));
        }
        let active_is_cold = self.active_cursor == SyncCursor::Cold;
        let cold_legacy_head = self.active_generation.as_ref().is_some_and(|active| {
            matches!(
                self.state,
                ReplicaState::RefreshRequired | ReplicaState::Bootstrapping
            ) && self
                .generations
                .get(active)
                .is_some_and(|generation| generation.legacy_admission.is_some())
        });
        if self.active_generation.is_none() != active_is_cold && !cold_legacy_head {
            return Err(replica_invariant(
                "active Bootstrap generation and Cursor disagree",
            ));
        }
        match self.state {
            ReplicaState::Cold => {
                if self.active_generation.is_some() || self.staging_generation.is_some() {
                    return Err(replica_invariant("cold Replica has a Bootstrap generation"));
                }
            }
            ReplicaState::Ready | ReplicaState::RefreshRequired => {
                if self.active_generation.is_none() || self.staging_generation.is_some() {
                    return Err(replica_invariant("ready Replica head is inconsistent"));
                }
            }
            ReplicaState::Bootstrapping => {
                let staging = self.staging_generation.as_ref().ok_or_else(|| {
                    replica_invariant("bootstrapping Replica has no staging generation")
                })?;
                if !self.generations.contains_key(staging) {
                    return Err(replica_invariant("staging Bootstrap generation is missing"));
                }
            }
        }
        if let Some(active) = &self.active_generation {
            let generation = self
                .generations
                .get(active)
                .ok_or_else(|| replica_invariant("active Bootstrap generation is missing"))?;
            // The pinned watermark is where this generation's pages were read, and the page
            // receipts are evidence of exactly that. The active Cursor starts there and only
            // moves forward as changes are applied, so the two are equal at promotion and may
            // legitimately differ afterwards.
            if generation.legacy_admission.is_none() && !generation.final_page_staged {
                return Err(replica_invariant(
                    "active Bootstrap generation is not complete",
                ));
            }
            if let Some(origin) = &generation.legacy_admission {
                validate_legacy_origin(origin)?;
                let admitted_cursor = legacy_origin_cursor(origin)?;
                if receipts_for(self, active)
                    || generation.final_page_staged
                    || generation.next_page_cursor != BootstrapPageCursor::VaultsInitial
                    || generation.next_page_identity != BootstrapPageIdentity::vaults(0)
                    || (self.active_cursor == SyncCursor::Cold
                        && !matches!(
                            self.state,
                            ReplicaState::RefreshRequired | ReplicaState::Bootstrapping
                        ))
                    || generation.pinned_watermark != admitted_cursor
                    || ((admitted_cursor == SyncCursor::Cold)
                        != (self.active_cursor == SyncCursor::Cold))
                {
                    return Err(replica_invariant(
                        "active legacy admission generation is inconsistent",
                    ));
                }
                if self.active_cursor != SyncCursor::Cold {
                    validate_captured_cursor(&self.active_cursor)?;
                }
            } else {
                validate_captured_cursor(&generation.pinned_watermark)?;
                validate_captured_cursor(&self.active_cursor)?;
            }
        }
        for (generation_id, generation) in &self.generations {
            if generation_id != &generation.generation_id
                || generation.fallback_state == ReplicaState::Bootstrapping
            {
                return Err(replica_invariant(
                    "Bootstrap generation control record is inconsistent",
                ));
            }
            let mut receipts: Vec<_> = self
                .pages
                .iter()
                .filter(|((receipt_generation, _), _)| receipt_generation == generation_id)
                .map(|(_, receipt)| receipt)
                .collect();
            receipts.sort_by_key(|receipt| {
                (
                    match receipt.page_identity.phase {
                        BootstrapPhase::Vaults => 0,
                        BootstrapPhase::Items => 1,
                    },
                    receipt.page_identity.ordinal,
                )
            });
            if let Some(origin) = &generation.legacy_admission {
                validate_legacy_origin(origin)?;
                if !receipts.is_empty()
                    || generation.final_page_staged
                    || generation.next_page_cursor != BootstrapPageCursor::VaultsInitial
                    || generation.next_page_identity != BootstrapPageIdentity::vaults(0)
                    || generation.pinned_watermark != legacy_origin_cursor(origin)?
                {
                    return Err(replica_invariant(
                        "legacy admission generation control is inconsistent",
                    ));
                }
                continue;
            }
            let mut expected_cursor = BootstrapPageCursor::VaultsInitial;
            let mut expected_identity = BootstrapPageIdentity::vaults(0);
            let mut terminal = false;
            for receipt in &receipts {
                if receipt.generation_id != *generation_id
                    || receipt.page_identity != expected_identity
                    || receipt.request_cursor != expected_cursor
                    || receipt.page_identity.phase != receipt.request_cursor.phase()
                    || receipt.pinned_watermark != generation.pinned_watermark
                    || terminal
                {
                    return Err(replica_invariant(
                        "Bootstrap page receipt chain is inconsistent",
                    ));
                }
                validate_captured_cursor(&receipt.pinned_watermark)?;
                match (&receipt.request_cursor.phase(), &receipt.continuation) {
                    (BootstrapPhase::Vaults, BootstrapContinuation::Final) => {
                        expected_cursor = BootstrapPageCursor::ItemsInitial;
                        expected_identity = BootstrapPageIdentity::items(0);
                    }
                    (BootstrapPhase::Items, BootstrapContinuation::Final) => {
                        terminal = true;
                        expected_identity = BootstrapPageIdentity::items(
                            receipt
                                .page_identity
                                .ordinal
                                .checked_add(1)
                                .ok_or_else(|| {
                                    replica_invariant("Bootstrap page identity overflowed")
                                })?,
                        );
                    }
                    (phase, BootstrapContinuation::More { next_cursor }) => {
                        validate_identifier(next_cursor, "next Bootstrap page Cursor")?;
                        expected_cursor = match phase {
                            BootstrapPhase::Vaults => BootstrapPageCursor::VaultsAfter {
                                cursor: next_cursor.clone(),
                            },
                            BootstrapPhase::Items => BootstrapPageCursor::ItemsAfter {
                                cursor: next_cursor.clone(),
                            },
                        };
                        let next_ordinal = receipt
                            .page_identity
                            .ordinal
                            .checked_add(1)
                            .ok_or_else(|| {
                                replica_invariant("Bootstrap page identity overflowed")
                            })?;
                        expected_identity = match phase {
                            BootstrapPhase::Vaults => BootstrapPageIdentity::vaults(next_ordinal),
                            BootstrapPhase::Items => BootstrapPageIdentity::items(next_ordinal),
                        };
                    }
                }
            }
            if receipts.is_empty() {
                if generation.pinned_watermark != SyncCursor::Cold
                    || generation.next_page_cursor != BootstrapPageCursor::VaultsInitial
                    || generation.next_page_identity != BootstrapPageIdentity::vaults(0)
                    || generation.final_page_staged
                {
                    return Err(replica_invariant(
                        "empty Bootstrap generation control record is inconsistent",
                    ));
                }
            } else if generation.pinned_watermark == SyncCursor::Cold
                || generation.final_page_staged != terminal
                || (!terminal && generation.next_page_cursor != expected_cursor)
                || generation.next_page_identity != expected_identity
            {
                return Err(replica_invariant(
                    "Bootstrap generation progress is inconsistent",
                ));
            }
        }
        for ((generation_id, page_identity), receipt) in &self.pages {
            if generation_id != &receipt.generation_id || page_identity != &receipt.page_identity {
                return Err(replica_invariant(
                    "Bootstrap page receipt key is inconsistent",
                ));
            }
        }
        for ((generation_id, record_id), vault) in &self.vaults {
            if !self.generations.contains_key(generation_id) || record_id != &vault.id {
                return Err(replica_invariant("Bootstrap Vault key is inconsistent"));
            }
        }
        for ((generation_id, record_id), item) in &self.items {
            if !self.generations.contains_key(generation_id) || record_id != &item.id {
                return Err(replica_invariant("Bootstrap Item key is inconsistent"));
            }
            validate_authority_page(&[], std::slice::from_ref(item))?;
        }
        Ok(())
    }

    pub(crate) fn snapshot(&self) -> BootstrapAuthoritySnapshot {
        let mut visible_vaults = Vec::new();
        let mut visible_items = Vec::new();
        if let Some(active) = &self.active_generation {
            visible_vaults.extend(
                self.vaults
                    .iter()
                    .filter(|((generation_id, _), _)| generation_id == active)
                    .map(|(_, vault)| vault.clone()),
            );
            visible_items.extend(
                self.items
                    .iter()
                    .filter(|((generation_id, _), _)| generation_id == active)
                    .map(|(_, item)| item.clone()),
            );
        }
        visible_vaults.sort_by(|left, right| left.id.cmp(&right.id));
        visible_items.sort_by(|left, right| left.id.cmp(&right.id));
        let mut generation_ids: Vec<_> = self.generations.keys().cloned().collect();
        generation_ids.sort_by(|left, right| left.0.cmp(&right.0));
        let mut generation_records: Vec<_> = self.generations.values().cloned().collect();
        generation_records.sort_by(|left, right| left.generation_id.0.cmp(&right.generation_id.0));
        let mut page_receipts: Vec<_> = self.pages.values().cloned().collect();
        page_receipts.sort_by(|left, right| {
            (
                &left.generation_id.0,
                match left.page_identity.phase {
                    BootstrapPhase::Vaults => 0,
                    BootstrapPhase::Items => 1,
                },
                left.page_identity.ordinal,
            )
                .cmp(&(
                    &right.generation_id.0,
                    match right.page_identity.phase {
                        BootstrapPhase::Vaults => 0,
                        BootstrapPhase::Items => 1,
                    },
                    right.page_identity.ordinal,
                ))
        });
        let staged_vault_count = self.staging_generation.as_ref().map_or(0, |staging| {
            self.vaults
                .keys()
                .filter(|(generation_id, _)| generation_id == staging)
                .count()
        });
        let staged_item_count = self.staging_generation.as_ref().map_or(0, |staging| {
            self.items
                .keys()
                .filter(|(generation_id, _)| generation_id == staging)
                .count()
        });
        BootstrapAuthoritySnapshot {
            state: self.state,
            active_generation: self.active_generation.clone(),
            active_cursor: self.active_cursor.clone(),
            staging_generation: self.staging_generation.clone(),
            visible_vaults,
            visible_items,
            generation_ids,
            generation_records,
            page_receipts,
            staged_vault_count,
            staged_item_count,
        }
    }
}

#[allow(dead_code, reason = "the persistence wire invokes this model next")]
fn increment_revision(revision: u64) -> Result<u64, RuntimeError> {
    revision
        .checked_add(1)
        .ok_or_else(|| replica_invariant("Replica revision overflowed"))
}

#[allow(dead_code, reason = "the persistence wire invokes this model next")]
fn validate_identifier(value: &str, label: &str) -> Result<(), RuntimeError> {
    if value.is_empty() {
        Err(replica_invariant(format!("{label} must not be empty")))
    } else {
        Ok(())
    }
}

#[allow(dead_code, reason = "the persistence wire invokes this model next")]
fn validate_captured_cursor(cursor: &SyncCursor) -> Result<(), RuntimeError> {
    match cursor {
        SyncCursor::Cold => Err(replica_invariant(
            "a staged Bootstrap page must capture a watermark",
        )),
        SyncCursor::CapturedEmpty => Ok(()),
        SyncCursor::CapturedValue { id } => validate_identifier(id, "captured Cursor"),
    }
}

pub(crate) fn legacy_admission_generation_id(incarnation: &Incarnation) -> BootstrapGenerationId {
    BootstrapGenerationId(format!("legacy-admission:{}", incarnation.as_str()))
}

fn validate_sha256(value: &str, label: &str) -> Result<(), RuntimeError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(replica_invariant(format!("{label} is invalid")));
    }
    Ok(())
}

fn checkpoint_cursor(
    evidence: &LegacyCheckpointEvidence,
) -> Result<Option<SyncCursor>, RuntimeError> {
    match evidence {
        LegacyCheckpointEvidence::Missing {} => Ok(None),
        LegacyCheckpointEvidence::CapturedEmpty {} => Ok(Some(SyncCursor::CapturedEmpty)),
        LegacyCheckpointEvidence::CapturedValue { id } => {
            validate_identifier(id, "legacy Sync Cursor")?;
            Ok(Some(SyncCursor::CapturedValue { id: id.clone() }))
        }
    }
}

fn legacy_origin_cursor(origin: &LegacyAdmissionOrigin) -> Result<SyncCursor, RuntimeError> {
    if origin.refresh_reason.is_some() {
        return Ok(SyncCursor::Cold);
    }
    let Some(metadata) = &origin.metadata else {
        return Ok(SyncCursor::Cold);
    };
    let Some(cache) = &metadata.sync_baseline else {
        return Ok(SyncCursor::Cold);
    };
    if cache.normalized_server_url != origin.normalized_server_url {
        return Ok(SyncCursor::Cold);
    }
    let Some(sync) = checkpoint_cursor(&origin.sync_baseline)? else {
        return Ok(SyncCursor::Cold);
    };
    if sync != cache.cursor {
        return Ok(SyncCursor::Cold);
    }
    if let Some(legacy) = checkpoint_cursor(&origin.last_sync_cursor)? {
        if legacy != sync {
            return Ok(SyncCursor::Cold);
        }
    }
    Ok(sync)
}

fn validate_legacy_origin(origin: &LegacyAdmissionOrigin) -> Result<(), RuntimeError> {
    validate_sha256(
        &origin.manifest_entries_sha256,
        "legacy admission manifest digest",
    )?;
    validate_identifier(origin.account_id.as_str(), "legacy admission Account")?;
    validate_identifier(&origin.user_id, "legacy admission User")?;
    validate_identifier(origin.incarnation.as_str(), "legacy admission incarnation")?;
    for (value, label) in [
        (&origin.normalized_server_url, "legacy admission Server"),
        (&origin.state_key, "legacy ItemCache state key"),
        (&origin.items_key_prefix, "legacy ItemCache items prefix"),
        (&origin.vaults_key_prefix, "legacy ItemCache Vaults prefix"),
        (&origin.source_id, "legacy Sync source"),
    ] {
        validate_identifier(value, label)?;
    }
    if let Some(source_generation) = &origin.source_active_generation {
        validate_identifier(source_generation, "legacy source generation")?;
    }
    let expected_state_key = format!("record:{}:meta:meta", origin.account_id.as_str());
    let (expected_items_prefix, expected_vaults_prefix) = match &origin.source_active_generation {
        Some(generation) => (
            format!(
                "record:item-cache-stage:{}:{generation}:items:",
                origin.account_id.as_str()
            ),
            format!(
                "record:item-cache-stage:{}:{generation}:vaults:",
                origin.account_id.as_str()
            ),
        ),
        None => (
            format!("record:{}:items:", origin.account_id.as_str()),
            format!("record:{}:vaults:", origin.account_id.as_str()),
        ),
    };
    let expected_source_id =
        legacy_sync_source_id(origin.account_id.as_str(), &origin.normalized_server_url);
    if origin.state_key != expected_state_key
        || origin.items_key_prefix != expected_items_prefix
        || origin.vaults_key_prefix != expected_vaults_prefix
        || origin.source_id != expected_source_id
    {
        return Err(replica_invariant(
            "legacy admission source identity is inconsistent",
        ));
    }
    if let Some(metadata) = &origin.metadata {
        const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
        if metadata.last_full_sync_at > MAX_SAFE_INTEGER
            || metadata.item_count > MAX_SAFE_INTEGER
            || metadata.cache_version > MAX_SAFE_INTEGER
        {
            return Err(replica_invariant(
                "legacy ItemCache metadata exceeds the source integer range",
            ));
        }
        if let Some(baseline) = &metadata.sync_baseline {
            validate_identifier(&baseline.server_url, "legacy ItemCache baseline Server")?;
            validate_identifier(
                &baseline.normalized_server_url,
                "legacy ItemCache normalized baseline Server",
            )?;
            if baseline.normalized_server_url != origin.normalized_server_url {
                return Err(replica_invariant(
                    "legacy ItemCache baseline belongs to another Server",
                ));
            }
            if baseline.cursor == SyncCursor::Cold {
                return Err(replica_invariant(
                    "legacy ItemCache baseline Cursor is cold",
                ));
            }
            validate_captured_cursor(&baseline.cursor)?;
        }
    }
    let _ = checkpoint_cursor(&origin.sync_baseline)?;
    let _ = checkpoint_cursor(&origin.last_sync_cursor)?;
    Ok(())
}

pub(crate) fn legacy_sync_source_id(account_id: &str, normalized_server_url: &str) -> String {
    format!(
        "account:{}:server:{}",
        encode_uri_component(account_id),
        encode_uri_component(normalized_server_url)
    )
}

fn encode_uri_component(value: &str) -> String {
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

fn receipts_for(authority: &BootstrapAuthority, generation: &BootstrapGenerationId) -> bool {
    authority
        .pages
        .keys()
        .any(|(receipt_generation, _)| receipt_generation == generation)
}

#[allow(dead_code, reason = "the persistence wire invokes this model next")]
fn validate_continuation(continuation: &BootstrapContinuation) -> Result<(), RuntimeError> {
    match continuation {
        BootstrapContinuation::Final => Ok(()),
        BootstrapContinuation::More { next_cursor } => {
            validate_identifier(next_cursor, "next Bootstrap page Cursor")
        }
    }
}

#[allow(dead_code, reason = "the persistence wire invokes this model next")]
pub(crate) fn validate_authority_page(
    vaults: &[AuthorityVaultRecord],
    items: &[AuthorityItemRecord],
) -> Result<(), RuntimeError> {
    let mut vault_ids = HashSet::new();
    for vault in vaults {
        validate_identifier(&vault.id, "Vault")?;
        if vault.key_version.is_some_and(|version| version <= 0) {
            return Err(replica_invariant("Vault key version must be positive"));
        }
        if !vault_ids.insert(&vault.id) {
            return Err(replica_invariant(
                "Bootstrap page contains a duplicate Vault",
            ));
        }
    }
    let mut item_ids = HashSet::new();
    for item in items {
        validate_identifier(&item.id, "Item")?;
        validate_identifier(&item.vault_id, "Item Vault")?;
        if !item_ids.insert(&item.id) {
            return Err(replica_invariant(
                "Bootstrap page contains a duplicate Item",
            ));
        }
        let mut attachment_ids = HashSet::new();
        for attachment in &item.attachments {
            validate_identifier(&attachment.id, "Attachment")?;
            if attachment.item_id != item.id || attachment.vault_id != item.vault_id {
                return Err(replica_invariant(
                    "Bootstrap Attachment scope does not match its Item",
                ));
            }
            if !attachment_ids.insert(&attachment.id) {
                return Err(replica_invariant(
                    "Bootstrap Item contains a duplicate Attachment",
                ));
            }
        }
    }
    Ok(())
}

#[allow(dead_code, reason = "the persistence wire invokes this model next")]
fn replica_invariant(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

#[cfg(test)]
mod bootstrap_head_invariant_tests {
    use super::*;

    #[test]
    fn vault_authority_keeps_positive_versions_and_old_rows_remain_unknown() {
        let old_row = serde_json::json!({
            "id": "vault-1",
            "name": "Team Vault",
            "vaultType": "team",
            "icon": null,
            "imageUrl": null,
            "encryptedVaultKey": "wrapped",
            "role": "owner"
        });
        let old: AuthorityVaultRecord = serde_json::from_value(old_row.clone()).unwrap();
        assert_eq!(serde_json::to_value(&old).unwrap(), old_row);

        let mut versioned_row = old_row;
        versioned_row["keyVersion"] = 7.into();
        let current: AuthorityVaultRecord = serde_json::from_value(versioned_row.clone()).unwrap();
        assert_eq!(serde_json::to_value(&current).unwrap(), versioned_row);
        assert!(validate_authority_page(&[current], &[]).is_ok());

        versioned_row["keyVersion"] = 0.into();
        let invalid: AuthorityVaultRecord = serde_json::from_value(versioned_row).unwrap();
        assert!(validate_authority_page(&[invalid], &[]).is_err());
    }

    fn legacy_origin(cursor: Option<&str>) -> LegacyAdmissionOrigin {
        let checkpoint = cursor.map_or(LegacyCheckpointEvidence::CapturedEmpty {}, |id| {
            LegacyCheckpointEvidence::CapturedValue { id: id.into() }
        });
        LegacyAdmissionOrigin {
            manifest_entries_sha256: "ab".repeat(32),
            account_id: AccountId::from("account-1"),
            user_id: "user-1".into(),
            incarnation: Incarnation::from("incarnation-1"),
            normalized_server_url: "https://example.test".into(),
            source_active_generation: None,
            state_key: "record:account-1:meta:meta".into(),
            items_key_prefix: "record:account-1:items:".into(),
            vaults_key_prefix: "record:account-1:vaults:".into(),
            items_primed: true,
            vaults_primed: true,
            metadata: Some(LegacyItemCacheMetadata {
                last_full_sync_at: 1,
                item_count: 0,
                cache_version: 1,
                sync_baseline: Some(LegacyItemCacheBaseline {
                    server_url: "https://example.test".into(),
                    normalized_server_url: "https://example.test".into(),
                    cursor: checkpoint_cursor(&checkpoint).unwrap().unwrap(),
                }),
            }),
            source_id: "account:account-1:server:https%3A%2F%2Fexample.test".into(),
            sync_baseline: checkpoint.clone(),
            last_sync_cursor: checkpoint,
            refresh_reason: None,
        }
    }

    fn legacy_replica(cursor: SyncCursor) -> AccountReplica {
        let mut origin = legacy_origin(match &cursor {
            SyncCursor::CapturedValue { id } => Some(id.as_str()),
            SyncCursor::CapturedEmpty | SyncCursor::Cold => None,
        });
        if cursor == SyncCursor::Cold {
            origin.metadata.as_mut().unwrap().sync_baseline = None;
            origin.sync_baseline = LegacyCheckpointEvidence::Missing {};
            origin.last_sync_cursor = LegacyCheckpointEvidence::Missing {};
        }
        let bootstrap = BootstrapAuthority::admit_legacy(LegacyAdmissionBootstrap {
            origin,
            cursor,
            vaults: Vec::new(),
            items: Vec::new(),
        })
        .unwrap();
        AccountReplica {
            account_id: AccountId::from("account-1"),
            user_id: "user-1".into(),
            incarnation: Incarnation::from("incarnation-1"),
            revision: 0,
            lock_epoch: 0,
            items: HashMap::new(),
            operations: HashMap::new(),
            cross_account_moves: HashMap::new(),
            share_capabilities: HashMap::new(),
            attachment_move_preparations: HashMap::new(),
            receipts: HashMap::new(),
            rotation_attempts: HashMap::new(),
            failure: None,
            bootstrap,
        }
    }

    fn guard(replica: &AccountReplica) -> BootstrapGuard {
        BootstrapGuard {
            account_id: replica.account_id.clone(),
            user_id: replica.user_id.clone(),
            incarnation: replica.incarnation.clone(),
            expected_replica_revision: replica.revision,
            expected_lock_epoch: replica.lock_epoch,
        }
    }

    fn cold_origin_with_cache_baseline(
        refresh_reason: Option<LegacyAdmissionRefreshReason>,
    ) -> LegacyAdmissionOrigin {
        let mut origin = legacy_origin(None);
        origin.sync_baseline = LegacyCheckpointEvidence::Missing {};
        origin.last_sync_cursor = LegacyCheckpointEvidence::Missing {};
        origin.refresh_reason = refresh_reason;
        origin
    }

    fn replica_with_legacy_origin(origin: LegacyAdmissionOrigin) -> AccountReplica {
        let mut replica = legacy_replica(SyncCursor::Cold);
        replica.bootstrap = BootstrapAuthority::admit_legacy(LegacyAdmissionBootstrap {
            origin,
            cursor: SyncCursor::Cold,
            vaults: Vec::new(),
            items: Vec::new(),
        })
        .unwrap();
        replica
    }

    fn persisted_replica(
        replica: &AccountReplica,
    ) -> (
        crate::replica::ReplicaHead,
        Vec<crate::replica::StoredReplicaRow>,
    ) {
        let snapshot = replica.snapshot();
        let head = crate::replica::ReplicaHead {
            account_id: snapshot.account_id.clone(),
            user_id: snapshot.user_id.clone(),
            incarnation: snapshot.incarnation.clone(),
            replica_revision: snapshot.revision,
            lock_epoch: snapshot.lock_epoch,
            failure: snapshot.failure,
        };
        let rows = crate::replica::snapshot_rows(snapshot).unwrap();
        (head, rows)
    }

    #[test]
    fn same_scope_cache_baseline_without_corroboration_stays_cold() {
        for (refresh_reason, label) in [
            (None, "missing corroboration"),
            (
                Some(LegacyAdmissionRefreshReason::CapturedFailedCreate),
                "captured failure override",
            ),
        ] {
            let origin = cold_origin_with_cache_baseline(refresh_reason);
            assert_eq!(
                legacy_origin_cursor(&origin).unwrap(),
                SyncCursor::Cold,
                "{label}"
            );
            let replica = replica_with_legacy_origin(origin.clone());
            assert_eq!(replica.bootstrap.state, ReplicaState::RefreshRequired);
            assert_eq!(replica.bootstrap.active_cursor, SyncCursor::Cold);

            let (head, rows) = persisted_replica(&replica);
            let reloaded = crate::replica::reconstruct_snapshot(
                &AccountId::from("account-1"),
                Some(head),
                rows,
            )
            .unwrap()
            .unwrap();
            let reloaded_origin = reloaded
                .bootstrap
                .generations
                .values()
                .next()
                .unwrap()
                .legacy_admission
                .as_ref();
            assert_eq!(reloaded_origin, Some(&origin), "{label}");
        }
    }

    #[test]
    fn reload_rejects_foreign_cache_baseline_scope_while_cold() {
        for (refresh_reason, label) in [
            (None, "missing corroboration"),
            (
                Some(LegacyAdmissionRefreshReason::CapturedFailedCreate),
                "captured failure override",
            ),
        ] {
            let replica =
                replica_with_legacy_origin(cold_origin_with_cache_baseline(refresh_reason));
            let (head, mut rows) = persisted_replica(&replica);
            let generation = rows
                .iter_mut()
                .find(|row| row.store == crate::replica::ReplicaStore::BootstrapGenerations)
                .unwrap();
            let mut payload: serde_json::Value =
                serde_json::from_str(&generation.payload_json).unwrap();
            let baseline = &mut payload["legacyAdmission"]["metadata"]["syncBaseline"];
            baseline["serverUrl"] = "https://other.example.test".into();
            baseline["normalizedServerUrl"] = "https://other.example.test".into();
            generation.payload_json = serde_json::to_string(&payload).unwrap();

            let error = crate::replica::reconstruct_snapshot(
                &AccountId::from("account-1"),
                Some(head),
                rows,
            )
            .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::InvariantViolation, "{label}");
        }
    }

    #[test]
    fn admission_rejects_foreign_cache_baseline_scope_while_cold() {
        for (refresh_reason, label) in [
            (None, "missing corroboration"),
            (
                Some(LegacyAdmissionRefreshReason::CapturedFailedCreate),
                "captured failure override",
            ),
        ] {
            let mut origin = cold_origin_with_cache_baseline(refresh_reason);
            let baseline = origin
                .metadata
                .as_mut()
                .unwrap()
                .sync_baseline
                .as_mut()
                .unwrap();
            baseline.server_url = "https://other.example.test".into();
            baseline.normalized_server_url = "https://other.example.test".into();
            let error = BootstrapAuthority::admit_legacy(LegacyAdmissionBootstrap {
                origin,
                cursor: SyncCursor::Cold,
                vaults: Vec::new(),
                items: Vec::new(),
            })
            .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::InvariantViolation, "{label}");
        }
    }

    #[test]
    fn captured_failed_create_refresh_reason_overrides_retained_markers_on_reload() {
        let mut value = serde_json::to_value(legacy_origin(Some("confirmed"))).unwrap();
        value["refreshReason"] = "capturedFailedCreate".into();
        let origin: LegacyAdmissionOrigin = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(legacy_origin_cursor(&origin).unwrap(), SyncCursor::Cold);
        let plan = LegacyAdmissionBootstrap {
            origin: origin.clone(),
            cursor: SyncCursor::Cold,
            vaults: Vec::new(),
            items: Vec::new(),
        };
        let authority = BootstrapAuthority::admit_legacy(plan.clone()).unwrap();
        assert_eq!(authority.state, ReplicaState::RefreshRequired);
        assert_eq!(authority.active_cursor, SyncCursor::Cold);
        let mut replica = legacy_replica(SyncCursor::Cold);
        replica.bootstrap = authority;
        let snapshot = replica.snapshot();
        let head = crate::replica::ReplicaHead {
            account_id: snapshot.account_id.clone(),
            user_id: snapshot.user_id.clone(),
            incarnation: snapshot.incarnation.clone(),
            replica_revision: snapshot.revision,
            lock_epoch: snapshot.lock_epoch,
            failure: snapshot.failure,
        };
        let rows = crate::replica::snapshot_rows(snapshot).unwrap();
        let reloaded = crate::replica::reconstruct_snapshot(&"account-1".into(), Some(head), rows)
            .unwrap()
            .unwrap()
            .bootstrap;
        reloaded.validate().unwrap();
        assert_eq!(
            reloaded
                .generations
                .values()
                .next()
                .unwrap()
                .legacy_admission
                .as_ref(),
            Some(&origin)
        );
        let mut invalid = plan;
        invalid.cursor = SyncCursor::CapturedValue {
            id: "confirmed".into(),
        };
        assert!(BootstrapAuthority::admit_legacy(invalid).is_err());
        for reason in [
            serde_json::Value::Null,
            "unknown".into(),
            serde_json::json!({}),
        ] {
            value["refreshReason"] = reason;
            assert!(serde_json::from_value::<LegacyAdmissionOrigin>(value.clone()).is_err());
        }
    }

    #[test]
    fn cold_legacy_head_can_stage_abandon_and_promote_an_ordinary_bootstrap() {
        let mut replica = legacy_replica(SyncCursor::Cold);
        let generation_id = BootstrapGenerationId("server-generation".into());
        replica
            .begin_bootstrap(BeginBootstrapPlan {
                guard: guard(&replica),
                generation_id: generation_id.clone(),
            })
            .unwrap();
        replica
            .abandon_bootstrap(AbandonBootstrapPlan {
                guard: guard(&replica),
                generation_id: generation_id.clone(),
            })
            .unwrap();
        assert_eq!(replica.bootstrap.state, ReplicaState::RefreshRequired);
        let generation_id = BootstrapGenerationId("server-generation-2".into());
        replica
            .begin_bootstrap(BeginBootstrapPlan {
                guard: guard(&replica),
                generation_id: generation_id.clone(),
            })
            .unwrap();
        for (identity, request, continuation) in [
            (
                BootstrapPageIdentity::vaults(0),
                BootstrapPageCursor::VaultsInitial,
                BootstrapContinuation::Final,
            ),
            (
                BootstrapPageIdentity::items(0),
                BootstrapPageCursor::ItemsInitial,
                BootstrapContinuation::Final,
            ),
        ] {
            replica
                .stage_bootstrap_page(StageBootstrapPagePlan {
                    guard: guard(&replica),
                    generation_id: generation_id.clone(),
                    page_identity: identity,
                    request_cursor: request,
                    raw_response_fingerprint: Sha256Fingerprint([7; 32]),
                    pinned_watermark: SyncCursor::CapturedEmpty,
                    continuation,
                    vault_key_version_included: false,
                    vaults: Vec::new(),
                    items: Vec::new(),
                })
                .unwrap();
        }
        replica
            .promote_bootstrap(PromoteBootstrapPlan {
                additional_retired_vault_ids: Vec::new(),
                guard: guard(&replica),
                generation_id: generation_id.clone(),
            })
            .unwrap();
        assert_eq!(replica.bootstrap.active_generation, Some(generation_id));
        assert_eq!(replica.bootstrap.state, ReplicaState::Ready);
    }

    #[test]
    fn verified_legacy_head_advances_without_rewriting_imported_baseline() {
        let original = SyncCursor::CapturedValue { id: "evt-1".into() };
        let mut replica = legacy_replica(original.clone());
        replica
            .advance_matching_cursor(Some(CursorAdvance {
                expected: original.clone(),
                next: SyncCursor::CapturedValue { id: "evt-2".into() },
            }))
            .unwrap();
        assert_eq!(
            replica.bootstrap.active_cursor,
            SyncCursor::CapturedValue { id: "evt-2".into() }
        );
        let imported = replica.bootstrap.generations.values().next().unwrap();
        assert_eq!(imported.pinned_watermark, original);
        assert_eq!(
            imported.legacy_admission.as_ref().unwrap(),
            &legacy_origin(Some("evt-1"))
        );
    }

    #[test]
    fn missing_legacy_baseline_cannot_be_forged_into_incremental_readiness() {
        let mut replica = legacy_replica(SyncCursor::Cold);
        replica.bootstrap.active_cursor = SyncCursor::CapturedValue {
            id: "invented-cursor".into(),
        };
        replica.bootstrap.state = ReplicaState::Ready;
        assert!(replica.bootstrap.validate().is_err());
    }

    fn generation_record(id: &str) -> BootstrapGenerationRecord {
        BootstrapGenerationRecord {
            generation_id: BootstrapGenerationId(id.into()),
            fallback_state: ReplicaState::Cold,
            pinned_watermark: SyncCursor::Cold,
            next_page_identity: BootstrapPageIdentity::vaults(0),
            next_page_cursor: BootstrapPageCursor::VaultsInitial,
            final_page_staged: false,
            vault_key_version_proved: false,
            legacy_admission: None,
        }
    }

    #[test]
    fn old_generation_has_no_version_proof_and_new_proof_survives_restart() {
        let old_row = serde_json::to_value(generation_record("generation-1")).unwrap();
        assert!(old_row.get("vaultKeyVersionProved").is_none());
        let old: BootstrapGenerationRecord = serde_json::from_value(old_row.clone()).unwrap();
        assert_eq!(serde_json::to_value(old).unwrap(), old_row);

        let mut new_row = old_row;
        new_row["vaultKeyVersionProved"] = true.into();
        let current: BootstrapGenerationRecord = serde_json::from_value(new_row.clone()).unwrap();
        assert_eq!(serde_json::to_value(current).unwrap(), new_row);
    }

    #[test]
    fn every_vault_page_must_prove_version_capability_including_an_empty_page() {
        for (first_version, second_marker, expected_proof) in [
            (Some(7), true, true),
            (Some(7), false, false),
            (None, true, false),
        ] {
            let mut replica = legacy_replica(SyncCursor::Cold);
            let generation_id = BootstrapGenerationId("versioned-generation".into());
            replica
                .begin_bootstrap(BeginBootstrapPlan {
                    guard: guard(&replica),
                    generation_id: generation_id.clone(),
                })
                .unwrap();
            let vault = AuthorityVaultRecord {
                id: "vault-1".into(),
                name: "Team Vault".into(),
                vault_type: AuthorityVaultType::Team,
                icon: None,
                image_url: None,
                encrypted_vault_key: "wrapped".into(),
                role: AuthorityVaultRole::Owner,
                key_version: first_version,
            };
            replica
                .stage_bootstrap_page(StageBootstrapPagePlan {
                    guard: guard(&replica),
                    generation_id: generation_id.clone(),
                    page_identity: BootstrapPageIdentity::vaults(0),
                    request_cursor: BootstrapPageCursor::VaultsInitial,
                    raw_response_fingerprint: Sha256Fingerprint([1; 32]),
                    pinned_watermark: SyncCursor::CapturedEmpty,
                    continuation: BootstrapContinuation::More {
                        next_cursor: "next".into(),
                    },
                    vault_key_version_included: true,
                    vaults: vec![vault],
                    items: Vec::new(),
                })
                .unwrap();
            replica
                .stage_bootstrap_page(StageBootstrapPagePlan {
                    guard: guard(&replica),
                    generation_id: generation_id.clone(),
                    page_identity: BootstrapPageIdentity::vaults(1),
                    request_cursor: BootstrapPageCursor::VaultsAfter {
                        cursor: "next".into(),
                    },
                    raw_response_fingerprint: Sha256Fingerprint([2; 32]),
                    pinned_watermark: SyncCursor::CapturedEmpty,
                    continuation: BootstrapContinuation::Final,
                    vault_key_version_included: second_marker,
                    vaults: Vec::new(),
                    items: Vec::new(),
                })
                .unwrap();
            assert_eq!(
                replica.bootstrap.generations[&generation_id].vault_key_version_proved,
                expected_proof
            );
        }
    }

    #[test]
    fn cold_ready_and_refresh_required_heads_enforce_active_cursor_pairing() {
        let generation_id = BootstrapGenerationId("active".into());
        let mut authority = BootstrapAuthority {
            active_generation: Some(generation_id.clone()),
            ..BootstrapAuthority::default()
        };
        assert!(authority.validate().is_err());

        authority.state = ReplicaState::Ready;
        authority.active_cursor = SyncCursor::CapturedEmpty;
        authority.generations.insert(
            generation_id.clone(),
            BootstrapGenerationRecord {
                pinned_watermark: SyncCursor::CapturedEmpty,
                next_page_identity: BootstrapPageIdentity::items(1),
                final_page_staged: true,
                ..generation_record("active")
            },
        );
        authority.pages.insert(
            (generation_id.clone(), BootstrapPageIdentity::vaults(0)),
            BootstrapPageReceipt {
                generation_id: generation_id.clone(),
                page_identity: BootstrapPageIdentity::vaults(0),
                request_cursor: BootstrapPageCursor::VaultsInitial,
                raw_response_fingerprint: Sha256Fingerprint([1; 32]),
                pinned_watermark: SyncCursor::CapturedEmpty,
                continuation: BootstrapContinuation::Final,
            },
        );
        authority.pages.insert(
            (generation_id.clone(), BootstrapPageIdentity::items(0)),
            BootstrapPageReceipt {
                generation_id: generation_id.clone(),
                page_identity: BootstrapPageIdentity::items(0),
                request_cursor: BootstrapPageCursor::ItemsInitial,
                raw_response_fingerprint: Sha256Fingerprint([2; 32]),
                pinned_watermark: SyncCursor::CapturedEmpty,
                continuation: BootstrapContinuation::Final,
            },
        );
        assert!(authority.validate().is_ok());

        authority.state = ReplicaState::RefreshRequired;
        assert!(authority.validate().is_ok());

        authority.active_cursor = SyncCursor::Cold;
        assert!(authority.validate().is_err());
    }

    #[test]
    fn bootstrapping_requires_an_existing_staging_generation() {
        let generation_id = BootstrapGenerationId("staging".into());
        let mut authority = BootstrapAuthority {
            state: ReplicaState::Bootstrapping,
            staging_generation: Some(generation_id.clone()),
            ..BootstrapAuthority::default()
        };
        assert!(authority.validate().is_err());
        authority
            .generations
            .insert(generation_id, generation_record("staging"));
        assert!(authority.validate().is_ok());
    }
}

#[cfg(test)]
mod share_capability_invariant_tests {
    use super::*;

    fn operation(kind: OperationKind) -> OperationRecord {
        OperationRecord {
            operation_id: "share-operation".into(),
            kind,
            target: ResourceRef::Item {
                item_id: "item-1".into(),
                vault_id: "vault-1".into(),
            },
            request: ImmutableHttpRequest {
                method: HttpMethod::Post,
                path: "/api/v1/items/item-1/share-links".into(),
                headers: Vec::new(),
                body: br#"{"tokenHash":"hash"}"#.to_vec(),
            },
            request_fingerprint: Sha256Fingerprint([1; 32]),
            accepted_item_category: None,
            attachment_move_recovery: None,
            update_vault: None,
            create_vault: None,
            scheduling: OperationSchedulingState::default(),
            legacy_admission: None,
        }
    }

    fn capability() -> ProtectedShareCapabilityRecord {
        ProtectedShareCapabilityRecord {
            account_id: AccountId::from("account-1"),
            operation_id: "share-operation".into(),
            ciphertext: "ciphertext".into(),
            iv: "iv".into(),
            algorithm: "AES-GCM-AAD-V1".into(),
            result: None,
        }
    }

    fn replica(
        operation: Option<OperationRecord>,
        capability: ProtectedShareCapabilityRecord,
    ) -> AccountReplica {
        AccountReplica::from_snapshot(ReplicaSnapshot {
            account_id: AccountId::from("account-1"),
            user_id: "user-1".into(),
            incarnation: Incarnation::from("incarnation-1"),
            revision: 1,
            lock_epoch: 0,
            items: Vec::new(),
            operations: operation.into_iter().collect(),
            cross_account_moves: Vec::new(),
            share_capabilities: vec![capability],
            attachment_move_preparations: Vec::new(),
            receipts: Vec::new(),
            rotation_attempts: Vec::new(),
            failure: None,
            bootstrap: BootstrapAuthority::default(),
        })
    }

    #[test]
    fn restart_rejects_orphan_wrong_kind_wrong_scope_and_invalid_share_capabilities() {
        assert!(replica(None, capability()).validate_durable_work().is_err());
        assert!(
            replica(Some(operation(OperationKind::CreateItem)), capability())
                .validate_durable_work()
                .is_err()
        );

        let mut wrong_account = capability();
        wrong_account.account_id = AccountId::from("account-2");
        assert!(
            replica(Some(operation(OperationKind::CreateShare)), wrong_account)
                .validate_durable_work()
                .is_err()
        );
        for invalid in [
            ProtectedShareCapabilityRecord {
                ciphertext: String::new(),
                ..capability()
            },
            ProtectedShareCapabilityRecord {
                iv: String::new(),
                ..capability()
            },
            ProtectedShareCapabilityRecord {
                algorithm: "AES-GCM-V1".into(),
                ..capability()
            },
        ] {
            assert!(
                replica(Some(operation(OperationKind::CreateShare)), invalid)
                    .validate_durable_work()
                    .is_err()
            );
        }
        assert!(
            replica(Some(operation(OperationKind::CreateShare)), capability())
                .validate_durable_work()
                .is_ok()
        );
    }
}

#[cfg(test)]
mod sync_page_cursor_tests {
    use super::*;
    use crate::{
        replica::InMemoryReplica,
        test_fixtures::{seed_ready_personal_vault, test_operation, test_overlay},
    };

    #[test]
    fn sync_page_cursor_plan_refuses_matching_active_work() {
        let account_id = AccountId::from("account-1");
        let state = InMemoryReplica::default();
        state
            .install(
                account_id.clone(),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .unwrap();
        seed_ready_personal_vault(&state, &account_id).unwrap();
        let before_accept = state.snapshot(&account_id).unwrap();
        state
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                before_accept.incarnation,
                before_accept.revision,
                before_accept.lock_epoch,
                vec![
                    PlanMutation::AcceptOperation(test_operation("operation-1", "item-1")),
                    PlanMutation::PutOptimisticItem(test_overlay(
                        account_id.clone(),
                        "item-1",
                        "operation-1",
                    )),
                ],
            ))
            .unwrap();
        let active = state.snapshot(&account_id).unwrap();

        let result = state.execute(GuardedCommitPlan::new(
            account_id.clone(),
            active.incarnation.clone(),
            active.revision,
            active.lock_epoch,
            vec![PlanMutation::AdvanceSyncPageCursor {
                operation_ids: vec!["operation-1".into()],
                cursor: CursorAdvance {
                    expected: active.bootstrap.active_cursor.clone(),
                    next: SyncCursor::CapturedValue {
                        id: "must-not-pass-active-work".into(),
                    },
                },
            }],
        ));

        assert!(result.is_err());
        assert_eq!(state.snapshot(&account_id).unwrap(), active);
    }
}

#[cfg(test)]
mod attachment_move_reconciliation_tests {
    use super::*;
    use crate::{
        replica::InMemoryReplica,
        runtime::live_artifact_owners,
        test_fixtures::{personal_vault, test_overlay},
    };

    fn source_attachment() -> AuthorityAttachmentRecord {
        AuthorityAttachmentRecord {
            id: "attachment-1".into(),
            item_id: "item-1".into(),
            vault_id: "source-vault".into(),
            storage_key: "source-object".into(),
            encrypted_name: "source-name".into(),
            encryption_iv: "source-name-iv".into(),
            encryption_algorithm: "AES-GCM-AAD-V1".into(),
            encrypted_attachment_key: "source-key".into(),
            attachment_key_iv: "source-key-iv".into(),
            attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
            encrypted_content_type: "source-type".into(),
            encrypted_content_type_iv: "source-type-iv".into(),
            envelope_version: 1,
            file_size: 8,
            uploaded_by: "user-1".into(),
            created_at: "2026-08-28T00:00:00Z".into(),
        }
    }

    fn prepared_move(account_id: &AccountId) -> AttachmentMovePreparationRecord {
        let artifact = attachment_move_artifact_ref(
            account_id,
            "move-operation",
            "attachment-1",
            &"ab".repeat(32),
            8,
        )
        .unwrap();
        let mut preparation = AttachmentMovePreparationRecord {
            accepted_item_category: None,
            account_id: account_id.clone(),
            operation_id: "move-operation".into(),
            item_id: "item-1".into(),
            source_vault_id: "source-vault".into(),
            target_vault_id: "vault-1".into(),
            expected_item_version: 1,
            target_encrypted_data: "sealed-target".into(),
            target_encryption_algorithm: "AES-GCM-AAD-V1".into(),
            target_encryption_iv: "target-iv".into(),
            source_attachments: vec![source_attachment()],
            progress: vec![AttachmentMoveProgress::Encrypted {
                attachment_id: "attachment-1".into(),
                expected_envelope_version: 1,
                artifact,
                payload: Box::new(PreparedMoveAttachment {
                    encrypted_name: "sealed-name".into(),
                    encryption_iv: "name-iv".into(),
                    encryption_algorithm: "AES-GCM-AAD-V1".into(),
                    encrypted_attachment_key: "sealed-key".into(),
                    attachment_key_iv: "key-iv".into(),
                    attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
                    encrypted_content_type: "sealed-type".into(),
                    encrypted_content_type_iv: "type-iv".into(),
                }),
                upload: AttachmentMoveUploadState::Uploaded,
            }],
            intent_fingerprint: Sha256Fingerprint([0; 32]),
            scheduling: OperationSchedulingState::default(),
        };
        preparation.intent_fingerprint = attachment_move_intent_fingerprint(&preparation).unwrap();
        preparation
    }

    fn authority_item(version: i32) -> AuthorityItemRecord {
        AuthorityItemRecord {
            id: "item-1".into(),
            vault_id: "vault-1".into(),
            category: AuthorityItemCategory::Login,
            favorite: false,
            encrypted_data: "authoritative-sealed".into(),
            encryption_iv: "authority-iv".into(),
            encryption_algorithm: "AES-GCM-AAD-V1".into(),
            version,
            encryption_version: version,
            encrypted_by_user_id: "user-1".into(),
            last_modified_by: "user-1".into(),
            created_at: "2026-08-28T00:00:00Z".into(),
            updated_at: "2026-08-28T00:01:00Z".into(),
            deleted_at: None,
            attachments: Vec::new(),
        }
    }

    fn active_preparation() -> (InMemoryReplica, AccountId, AttachmentMovePreparationRecord) {
        let account_id = AccountId::from("account-1");
        let state = InMemoryReplica::default();
        state
            .install(
                account_id.clone(),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .unwrap();
        state
            .seed_ready_authority(
                &account_id,
                vec![
                    personal_vault("source-vault", "user-1"),
                    personal_vault("vault-1", "user-1"),
                ],
                vec![AuthorityItemRecord {
                    id: "item-1".into(),
                    vault_id: "source-vault".into(),
                    attachments: vec![source_attachment()],
                    ..authority_item(1)
                }],
            )
            .unwrap();
        let preparation = prepared_move(&account_id);
        let accepted = state.snapshot(&account_id).unwrap();
        state
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                accepted.incarnation,
                accepted.revision,
                accepted.lock_epoch,
                vec![
                    PlanMutation::AcceptAttachmentMovePreparation(preparation.clone()),
                    PlanMutation::PutOptimisticItem(test_overlay(
                        account_id.clone(),
                        "item-1",
                        "move-operation",
                    )),
                ],
            ))
            .unwrap();
        AccountReplica::from_snapshot(state.snapshot(&account_id).unwrap())
            .validate_durable_work()
            .unwrap();
        (state, account_id, preparation)
    }

    fn unrelated_vault_operation(account_id: &AccountId) -> OperationRecord {
        let body = br#"{"name":"New vault","vaultType":"personal","encryptedVaultKey":"wrapped-key","icon":"lock","imageKey":null}"#.to_vec();
        OperationRecord {
            operation_id: "vault-operation".into(),
            kind: OperationKind::CreateVault,
            target: ResourceRef::Vault {
                vault_id: "vault-new".into(),
            },
            request: ImmutableHttpRequest {
                method: HttpMethod::Put,
                path: "/api/v1/vaults/vault-new".into(),
                headers: vec![HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }],
                body: body.clone(),
            },
            request_fingerprint: Sha256Fingerprint([
                0x02, 0x4f, 0xc4, 0x33, 0x2e, 0x9a, 0xce, 0x87, 0x24, 0xbe, 0x1e, 0x09, 0x4b, 0x35,
                0xd3, 0xfb, 0xe3, 0x66, 0x7c, 0xa8, 0x60, 0x6a, 0x0a, 0x58, 0xa0, 0x8e, 0xc6, 0x0e,
                0xcb, 0x1b, 0xb1, 0xbb,
            ]),
            accepted_item_category: None,
            attachment_move_recovery: None,
            update_vault: None,
            create_vault: Some(CreateVaultOperationRecord {
                account_id: account_id.clone(),
                name: "New vault".into(),
                vault_type: crate::CreateVaultType::Personal,
                icon: "lock".into(),
                encrypted_vault_key: "wrapped-key".into(),
                image: None,
                checkpoint: CreateVaultCheckpoint::FinalRequestFrozen,
            }),
            scheduling: OperationSchedulingState::default(),
            legacy_admission: None,
        }
    }

    fn image_vault_operation(
        account_id: &AccountId,
        checkpoint: CreateVaultCheckpoint,
    ) -> OperationRecord {
        let digest = "1234567890abcdef".repeat(4);
        let mut operation = unrelated_vault_operation(account_id);
        operation.operation_id = "operation-image-final".into();
        operation.create_vault.as_mut().unwrap().image = Some(CreateVaultImageRecord {
            protected_witness: None,
            raw_cleanup_pending: false,
            byte_length: 11,
            content_type: "image/png".into(),
            sha256: digest.clone(),
            object_key: format!(
                "vaults/user-final-request/vault-new/create/operation-image-final-{digest}"
            ),
        });
        operation.create_vault.as_mut().unwrap().checkpoint = checkpoint;
        let canonical = canonical_create_vault_request(
            operation.vault_id(),
            operation.create_vault.as_ref().unwrap(),
        )
        .unwrap();
        operation.request.path = canonical.path;
        operation.request.body = canonical.body;
        if checkpoint != CreateVaultCheckpoint::FinalRequestFrozen {
            operation.request.body.clear();
        }
        operation.request_fingerprint = canonical.fingerprint;
        operation
    }

    #[test]
    fn accepted_image_protection_commits_witness_and_cleanup_duty_without_changing_http() {
        let account = AccountId::from("image-protection-upgrade");
        let state = InMemoryReplica::default();
        state
            .install(
                account.clone(),
                "user-final-request".into(),
                Incarnation::from("image-upgrade-incarnation"),
            )
            .unwrap();
        let commit = |mutation| {
            let current = state.snapshot(&account).unwrap();
            state.execute(GuardedCommitPlan::new(
                account.clone(),
                current.incarnation,
                current.revision,
                current.lock_epoch,
                vec![mutation],
            ))
        };
        let operation = image_vault_operation(&account, CreateVaultCheckpoint::FinalRequestFrozen);
        commit(PlanMutation::AcceptOperation(operation.clone())).unwrap();
        let witness = crate::ProtectedImageWitness {
            format_version: 1,
            publication_id: "protected-publication".into(),
            ciphertext_sha256: "e".repeat(64),
            ciphertext_byte_length: 300,
            chunk_count: 1,
        };
        commit(PlanMutation::ProtectVaultImage {
            operation_id: operation.operation_id.clone(),
            witness: witness.clone(),
        })
        .unwrap();
        let protected = state.snapshot(&account).unwrap().operations[0].clone();
        assert_eq!(protected.request, operation.request);
        assert_eq!(protected.request_fingerprint, operation.request_fingerprint);
        assert_eq!(
            protected.vault_image_checkpoint(),
            operation.vault_image_checkpoint()
        );
        assert_eq!(
            protected.vault_image().unwrap().protected_witness.as_ref(),
            Some(&witness)
        );
        assert!(protected.vault_image().unwrap().raw_cleanup_pending);
        let mut wrong = witness.clone();
        wrong.publication_id = "different-publication".into();
        let before = state.snapshot(&account).unwrap();
        assert!(commit(PlanMutation::CompleteVaultImageRawCleanup {
            operation_id: operation.operation_id.clone(),
            witness: wrong.clone()
        })
        .is_err());
        assert!(commit(PlanMutation::ProtectVaultImage {
            operation_id: operation.operation_id.clone(),
            witness: wrong
        })
        .is_err());
        assert_eq!(state.snapshot(&account).unwrap(), before);
        commit(PlanMutation::CompleteVaultImageRawCleanup {
            operation_id: operation.operation_id.clone(),
            witness: witness.clone(),
        })
        .unwrap();
        commit(PlanMutation::ProtectVaultImage {
            operation_id: operation.operation_id.clone(),
            witness: witness.clone(),
        })
        .unwrap();
        let after = state.snapshot(&account).unwrap();
        assert!(
            !after.operations[0]
                .vault_image()
                .unwrap()
                .raw_cleanup_pending
        );
        assert_eq!(after.operations[0].request, operation.request);
        AccountReplica::from_snapshot(after)
            .validate_durable_work()
            .unwrap();
    }

    #[test]
    fn active_attachment_move_preparation_and_create_vault_own_distinct_resources() {
        let (state, account_id, preparation) = active_preparation();
        let before = state.snapshot(&account_id).unwrap();
        let vault_operation = unrelated_vault_operation(&account_id);

        state
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                before.incarnation,
                before.revision,
                before.lock_epoch,
                vec![PlanMutation::AcceptOperation(vault_operation.clone())],
            ))
            .unwrap();

        let after = state.snapshot(&account_id).unwrap();
        assert!(after
            .attachment_move_preparations
            .iter()
            .any(|active| active.operation_id == preparation.operation_id));
        assert!(after
            .operations
            .iter()
            .any(|active| active.operation_id == vault_operation.operation_id));
        AccountReplica::from_snapshot(after)
            .validate_durable_work()
            .unwrap();
    }

    #[test]
    fn final_create_vault_acceptance_rejects_byte_noncanonical_request_without_mutation() {
        let account_id = AccountId::from("account-final-request");
        let state = InMemoryReplica::default();
        state
            .install(
                account_id.clone(),
                "user-final-request".into(),
                Incarnation::from("incarnation-final-request"),
            )
            .unwrap();
        let initial = state.snapshot(&account_id).unwrap();
        let mut operation = unrelated_vault_operation(&account_id);
        operation.request.body = br#"{ "name":"New vault","vaultType":"personal","encryptedVaultKey":"wrapped-key","icon":"lock","imageKey":null }"#.to_vec();
        operation.request_fingerprint = Sha256Fingerprint([
            0x46, 0x5b, 0x86, 0x7e, 0xc8, 0xc1, 0xd9, 0x36, 0xdb, 0xbe, 0xa7, 0x47, 0x89, 0xd5,
            0x58, 0xf8, 0xc3, 0xea, 0x1a, 0x77, 0x1f, 0x20, 0xa4, 0x4d, 0x89, 0x16, 0x05, 0x05,
            0x13, 0x50, 0x76, 0xe4,
        ]);

        let error = state
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                initial.incarnation.clone(),
                initial.revision,
                initial.lock_epoch,
                vec![PlanMutation::AcceptOperation(operation)],
            ))
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert_eq!(state.snapshot(&account_id).unwrap(), initial);
    }

    #[test]
    fn final_create_vault_checkpoint_rejects_every_noncanonical_identity_without_mutation() {
        let account_id = AccountId::from("account-final-request");
        let state = InMemoryReplica::default();
        state
            .install(
                account_id.clone(),
                "user-final-request".into(),
                Incarnation::from("incarnation-final-request"),
            )
            .unwrap();
        let initial = state.snapshot(&account_id).unwrap();
        let artifact = image_vault_operation(&account_id, CreateVaultCheckpoint::ArtifactReady);
        state
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                initial.incarnation,
                initial.revision,
                initial.lock_epoch,
                vec![PlanMutation::AcceptOperation(artifact.clone())],
            ))
            .unwrap();
        let accepted = state.snapshot(&account_id).unwrap();
        let mut remote = artifact;
        remote.create_vault.as_mut().unwrap().checkpoint =
            CreateVaultCheckpoint::RemoteUploadConfirmed;
        state
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                accepted.incarnation.clone(),
                accepted.revision,
                accepted.lock_epoch,
                vec![PlanMutation::CheckpointCreateVault(remote.clone())],
            ))
            .unwrap();
        let confirmed = state.snapshot(&account_id).unwrap();
        let exact = image_vault_operation(&account_id, CreateVaultCheckpoint::FinalRequestFrozen);

        let mut cases = Vec::new();
        let mut wrong_method = exact.clone();
        wrong_method.request.method = HttpMethod::Post;
        cases.push(wrong_method);
        for path in [
            "api/v1/vaults/vault-new",
            "/api/v1/vaults/vault-other",
            "https://example.invalid/api/v1/vaults/vault-new",
        ] {
            let mut operation = exact.clone();
            operation.request.path = path.into();
            cases.push(operation);
        }
        for body in [
            br#"{ \"name\":\"New vault\",\"vaultType\":\"personal\",\"encryptedVaultKey\":\"wrapped-key\",\"icon\":\"lock\",\"imageKey\":\"vaults/user-final-request/vault-new/create/operation-image-final-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef\" }"#.as_slice(),
            br#"{\"vaultType\":\"personal\",\"name\":\"New vault\",\"encryptedVaultKey\":\"wrapped-key\",\"icon\":\"lock\",\"imageKey\":\"vaults/user-final-request/vault-new/create/operation-image-final-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef\"}"#,
            br#"{\"name\":\"New\\u0020vault\",\"vaultType\":\"personal\",\"encryptedVaultKey\":\"wrapped-key\",\"icon\":\"lock\",\"imageKey\":\"vaults/user-final-request/vault-new/create/operation-image-final-1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef\"}"#,
            br#"{\"name\":\"Changed\",\"vaultType\":\"personal\",\"encryptedVaultKey\":\"wrapped-key\",\"icon\":\"lock\",\"imageKey\":null}"#,
        ] {
            let mut operation = exact.clone();
            operation.request.body = body.to_vec();
            cases.push(operation);
        }
        let mut raw_sha = exact.clone();
        raw_sha.request_fingerprint = Sha256Fingerprint::of_bytes(&raw_sha.request.body);
        cases.push(raw_sha);
        let mut wrong_fingerprint = exact.clone();
        wrong_fingerprint.request_fingerprint = Sha256Fingerprint([0x5a; 32]);
        cases.push(wrong_fingerprint);
        for operation in cases {
            let error = state
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    confirmed.incarnation.clone(),
                    confirmed.revision,
                    confirmed.lock_epoch,
                    vec![PlanMutation::CheckpointCreateVault(operation)],
                ))
                .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
            assert_eq!(state.snapshot(&account_id).unwrap(), confirmed);
        }

        state
            .execute(GuardedCommitPlan::new(
                account_id,
                confirmed.incarnation,
                confirmed.revision,
                confirmed.lock_epoch,
                vec![PlanMutation::CheckpointCreateVault(exact)],
            ))
            .unwrap();
    }

    #[test]
    fn item_reconciliation_plans_reject_a_vault_operation_without_panicking_or_mutating() {
        let account_id = AccountId::from("account-vault-plan");
        let state = InMemoryReplica::default();
        state
            .install(
                account_id.clone(),
                "user-vault-plan".into(),
                Incarnation::from("incarnation-vault-plan"),
            )
            .unwrap();
        let operation = unrelated_vault_operation(&account_id);
        let initial = state.snapshot(&account_id).unwrap();
        state
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                initial.incarnation,
                initial.revision,
                initial.lock_epoch,
                vec![PlanMutation::AcceptOperation(operation.clone())],
            ))
            .unwrap();
        let accepted = state.snapshot(&account_id).unwrap();
        let outcome = ObservedOutcome {
            operation_id: operation.operation_id.clone(),
            request_fingerprint: operation.request_fingerprint,
            result: OperationOutcomeResult::Applied {
                entity_id: "item-foreign".into(),
                version: 1,
            },
        };

        for mutation in [
            PlanMutation::ReconcileAppliedCreate {
                outcome: outcome.clone(),
                item: Box::new(AuthorityItemRecord {
                    id: "item-foreign".into(),
                    vault_id: "vault-new".into(),
                    ..authority_item(1)
                }),
                cursor: None,
            },
            PlanMutation::ReconcileItemMutation {
                outcome: outcome.clone(),
                item: None,
                cursor: None,
            },
        ] {
            let error = state
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    accepted.incarnation.clone(),
                    accepted.revision,
                    accepted.lock_epoch,
                    vec![mutation],
                ))
                .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
            assert_eq!(state.snapshot(&account_id).unwrap(), accepted);
        }
    }

    #[test]
    fn create_vault_acceptance_binds_image_to_account_user_vault_operation_and_policy() {
        let account_id = AccountId::from("account-image-context");
        let state = InMemoryReplica::default();
        state
            .install(
                account_id.clone(),
                "user-image-context".into(),
                Incarnation::from("incarnation-image-context"),
            )
            .unwrap();
        let initial = state.snapshot(&account_id).unwrap();
        let digest = "1234567890abcdef".repeat(4);
        let mut valid = unrelated_vault_operation(&account_id);
        valid.operation_id = "operation-image-context".into();
        valid.create_vault.as_mut().unwrap().image = Some(CreateVaultImageRecord {
            protected_witness: None,
            raw_cleanup_pending: false,
            byte_length: 2_097_152,
            content_type: "image/webp".into(),
            sha256: digest.clone(),
            object_key: format!(
                "vaults/user-image-context/vault-new/create/operation-image-context-{digest}"
            ),
        });

        let mut cases = Vec::new();
        let mut foreign_account = valid.clone();
        foreign_account.create_vault.as_mut().unwrap().account_id =
            AccountId::from("account-other");
        cases.push(foreign_account);
        for key in [
            format!("vaults/user-other/vault-new/create/operation-image-context-{digest}"),
            format!(
                "vaults/user-image-context/vault-other/create/operation-image-context-{digest}"
            ),
            format!("vaults/user-image-context/vault-new/create/operation-other-{digest}"),
        ] {
            let mut operation = valid.clone();
            operation
                .create_vault
                .as_mut()
                .unwrap()
                .image
                .as_mut()
                .unwrap()
                .object_key = key;
            cases.push(operation);
        }
        let mut zero = valid.clone();
        zero.create_vault
            .as_mut()
            .unwrap()
            .image
            .as_mut()
            .unwrap()
            .byte_length = 0;
        cases.push(zero);
        let mut mime = valid.clone();
        mime.create_vault
            .as_mut()
            .unwrap()
            .image
            .as_mut()
            .unwrap()
            .content_type = "image/bmp".into();
        cases.push(mime);
        let mut sha = valid.clone();
        sha.create_vault
            .as_mut()
            .unwrap()
            .image
            .as_mut()
            .unwrap()
            .sha256 = "g".repeat(64);
        cases.push(sha);

        for operation in cases {
            let error = state
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    initial.incarnation.clone(),
                    initial.revision,
                    initial.lock_epoch,
                    vec![PlanMutation::AcceptOperation(operation)],
                ))
                .unwrap_err();
            assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
            assert_eq!(state.snapshot(&account_id).unwrap(), initial);
        }

        let canonical =
            canonical_create_vault_request(valid.vault_id(), valid.create_vault.as_ref().unwrap())
                .unwrap();
        valid.request.path = canonical.path;
        valid.request.body = canonical.body;
        valid.request_fingerprint = canonical.fingerprint;
        state
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                initial.incarnation,
                initial.revision,
                initial.lock_epoch,
                vec![PlanMutation::AcceptOperation(valid)],
            ))
            .unwrap();
        AccountReplica::from_snapshot(state.snapshot(&account_id).unwrap())
            .validate_durable_work()
            .unwrap();
    }

    #[test]
    fn accepted_image_protection_witness_rejects_invalid_format_and_bounds() {
        use crate::ProtectedImageWitness;
        let account_id = AccountId::from("protected-image-context");
        let state = InMemoryReplica::default();
        state
            .install(
                account_id.clone(),
                "user-image-context".into(),
                Incarnation::from("protected-image-incarnation"),
            )
            .unwrap();
        let initial = state.snapshot(&account_id).unwrap();
        let mut valid = unrelated_vault_operation(&account_id);
        let digest = "f".repeat(64);
        let witness = ProtectedImageWitness {
            format_version: 1,
            publication_id: "publication-a".into(),
            ciphertext_sha256: "e".repeat(64),
            ciphertext_byte_length: 300_000,
            chunk_count: 2,
        };
        valid.create_vault.as_mut().unwrap().image = Some(CreateVaultImageRecord {
            byte_length: 200_000,
            content_type: "image/png".into(),
            sha256: digest.clone(),
            object_key: format!(
                "vaults/user-image-context/{}/create/{}-{digest}",
                valid.vault_id(),
                valid.operation_id
            ),
            protected_witness: Some(witness.clone()),
            raw_cleanup_pending: false,
        });
        let canonical =
            canonical_create_vault_request(valid.vault_id(), valid.create_vault.as_ref().unwrap())
                .unwrap();
        valid.request.path = canonical.path;
        valid.request.body = canonical.body;
        valid.request_fingerprint = canonical.fingerprint;
        let mut cases = Vec::new();
        let mut changed = witness.clone();
        changed.format_version = 2;
        cases.push(changed);
        let mut changed = witness.clone();
        changed.publication_id.clear();
        cases.push(changed);
        let mut changed = witness.clone();
        changed.publication_id = "p".repeat(129);
        cases.push(changed);
        let mut changed = witness.clone();
        changed.ciphertext_sha256 = "E".repeat(64);
        cases.push(changed);
        let mut changed = witness.clone();
        changed.chunk_count = 1;
        cases.push(changed);
        let mut changed = witness.clone();
        changed.ciphertext_byte_length = 0;
        cases.push(changed);
        let mut changed = witness.clone();
        changed.ciphertext_byte_length = 524_289;
        cases.push(changed);
        for witness in cases {
            let mut operation = valid.clone();
            operation
                .create_vault
                .as_mut()
                .unwrap()
                .image
                .as_mut()
                .unwrap()
                .protected_witness = Some(witness);
            assert!(state
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    initial.incarnation.clone(),
                    initial.revision,
                    initial.lock_epoch,
                    vec![PlanMutation::AcceptOperation(operation)]
                ))
                .is_err());
            assert_eq!(state.snapshot(&account_id).unwrap(), initial);
        }
        let mut orphaned_cleanup = valid.clone();
        let image = orphaned_cleanup
            .create_vault
            .as_mut()
            .unwrap()
            .image
            .as_mut()
            .unwrap();
        image.protected_witness = None;
        image.raw_cleanup_pending = true;
        assert!(state
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                initial.incarnation.clone(),
                initial.revision,
                initial.lock_epoch,
                vec![PlanMutation::AcceptOperation(orphaned_cleanup)]
            ))
            .is_err());
        assert_eq!(state.snapshot(&account_id).unwrap(), initial);
        state
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                initial.incarnation,
                initial.revision,
                initial.lock_epoch,
                vec![PlanMutation::AcceptOperation(valid)],
            ))
            .unwrap();
        AccountReplica::from_snapshot(state.snapshot(&account_id).unwrap())
            .validate_durable_work()
            .unwrap();
    }

    #[test]
    fn sync_page_cursor_cannot_pass_a_real_active_attachment_move_preparation() {
        let (state, account_id, preparation) = active_preparation();
        let active = state.snapshot(&account_id).unwrap();
        let result = state.execute(GuardedCommitPlan::new(
            account_id.clone(),
            active.incarnation.clone(),
            active.revision,
            active.lock_epoch,
            vec![PlanMutation::AdvanceSyncPageCursor {
                operation_ids: vec![preparation.operation_id],
                cursor: CursorAdvance {
                    expected: active.bootstrap.active_cursor.clone(),
                    next: SyncCursor::CapturedValue {
                        id: "must-not-pass-preparation".into(),
                    },
                },
            }],
        ));

        assert!(result.is_err());
        assert_eq!(state.snapshot(&account_id).unwrap(), active);
    }

    #[test]
    fn promoted_move_artifact_becomes_orphanable_only_with_atomic_receipt() {
        for present in [true, false] {
            let (state, account_id, preparation) = active_preparation();
            let staged = state.snapshot(&account_id).unwrap();
            state
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    staged.incarnation,
                    staged.revision,
                    staged.lock_epoch,
                    vec![PlanMutation::PromoteAttachmentMovePreparation {
                        operation_id: "move-operation".into(),
                        expected_intent_fingerprint: preparation.intent_fingerprint,
                    }],
                ))
                .unwrap();
            let current = state.snapshot(&account_id).unwrap();
            AccountReplica::from_snapshot(current.clone())
                .validate_durable_work()
                .unwrap();
            let operation = current.operations[0].clone();
            assert_eq!(operation.kind, OperationKind::MoveItem);
            assert!(matches!(
                operation.attachment_move_recovery,
                Some(AttachmentMoveRecovery::Prepared { .. })
            ));
            assert_eq!(live_artifact_owners(&current).unwrap().len(), 1);

            let outcome = ObservedOutcome {
                operation_id: operation.operation_id.clone(),
                request_fingerprint: operation.request_fingerprint,
                result: OperationOutcomeResult::Applied {
                    entity_id: operation.item_id().to_owned(),
                    version: 2,
                },
            };
            let mismatched = state.execute(GuardedCommitPlan::new(
                account_id.clone(),
                current.incarnation.clone(),
                current.revision,
                current.lock_epoch,
                vec![PlanMutation::ReconcileItemMutation {
                    outcome: outcome.clone(),
                    item: Some(Box::new(authority_item(1))),
                    cursor: None,
                }],
            ));
            assert!(mismatched.is_err());
            assert_eq!(state.snapshot(&account_id).unwrap(), current);

            let reconciliation_item = present.then(|| Box::new(authority_item(3)));
            state.fail_next_commits(1);
            let failed_commit = state.execute(GuardedCommitPlan::new(
                account_id.clone(),
                current.incarnation.clone(),
                current.revision,
                current.lock_epoch,
                vec![PlanMutation::ReconcileItemMutation {
                    outcome: outcome.clone(),
                    item: reconciliation_item.clone(),
                    cursor: None,
                }],
            ));
            assert!(failed_commit.is_err());
            let retained = state.snapshot(&account_id).unwrap();
            assert_eq!(retained, current);
            assert_eq!(live_artifact_owners(&retained).unwrap().len(), 1);
            assert!(retained.receipts.is_empty());

            state
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    current.incarnation.clone(),
                    current.revision,
                    current.lock_epoch,
                    vec![PlanMutation::ReconcileItemMutation {
                        outcome,
                        item: reconciliation_item.clone(),
                        cursor: None,
                    }],
                ))
                .unwrap();
            let completed = state.snapshot(&account_id).unwrap();
            assert!(completed.operations.is_empty());
            assert!(completed.items.is_empty());
            assert_eq!(completed.receipts.len(), 1);
            assert!(live_artifact_owners(&completed).unwrap().is_empty());
        }
    }
}

/// Check the same request fingerprints as acceptance without allocating rewritten body bytes.
pub(super) fn verify_item_request(operation: &OperationRecord) -> Result<(), RuntimeError> {
    verify_item_request_path(operation, operation.legacy_admission.is_some())
}

pub(super) fn verify_item_request_path(
    operation: &OperationRecord,
    component_encoded: bool,
) -> Result<(), RuntimeError> {
    use HttpMethod::*;
    let (method, path, content_type, fingerprint) = match operation.kind {
        OperationKind::CreateVault
        | OperationKind::UpdateVault
        | OperationKind::DeleteVault
        | OperationKind::ImportItems
        | OperationKind::CreateVaultMemberRemovalRotationPlans
        | OperationKind::FinalizeVaultMemberRemovalRotationPlans
        | OperationKind::CreateTeamLeaveRotationPlans
        | OperationKind::FinalizeTeamLeaveRotationPlans
        | OperationKind::CreateTeamMemberRemovalRotationPlans
        | OperationKind::FinalizeTeamMemberRemovalRotationPlans => return Ok(()), // Closed non-Item requests have their own strict validators.
        OperationKind::CreateItem => {
            let item_id = operation
                .target
                .item_id()
                .ok_or_else(|| replica_invariant("Create Item target is invalid"))?;
            let path = if component_encoded {
                format!(
                    "/api/v1/vaults/{}/items/{}",
                    encode_component(operation.vault_id()),
                    encode_component(item_id)
                )
            } else {
                format!("/api/v1/vaults/{}/items/{item_id}", operation.vault_id())
            };
            (
                Put,
                path,
                Some("application/json"),
                create_item_fingerprint(operation.vault_id(), item_id, &operation.request.body),
            )
        }
        OperationKind::CreateShare => (
            Post,
            format!(
                "/api/v1/items/{}/share-links",
                operation
                    .target
                    .item_id()
                    .ok_or_else(|| replica_invariant("Share target is invalid"))?
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
                .ok_or_else(|| replica_invariant("Item Operation target is invalid"))?;
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
                .ok_or_else(|| replica_invariant("Item concurrency precondition is missing"))?
                .value
                .as_str();
            let expected = value
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .and_then(|value| value.parse::<i32>().ok())
                .filter(|value| *value > 0)
                .ok_or_else(|| replica_invariant("Item concurrency precondition is invalid"))?;
            if value != format!("\"{expected}\"") {
                return Err(replica_invariant(
                    "Item concurrency precondition is not canonical",
                ));
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
                return Err(replica_invariant("Item request headers changed"));
            }
            (
                method,
                if component_encoded {
                    format!("/api/v1/items/{}{suffix}", encode_component(item))
                } else {
                    format!("/api/v1/items/{item}{suffix}")
                },
                content_type,
                item_operation_fingerprint(kind, route, item, &operation.request.body, expected),
            )
        }
    };
    if operation.request.method != method
        || operation.request.path != path
        || operation.request_fingerprint != fingerprint
    {
        return Err(replica_invariant(
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
        return Err(replica_invariant("Create request headers changed"));
    }
    Ok(())
}
