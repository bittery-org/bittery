use crate::http_transport::{HttpHeader, HttpMethod};
use crate::wire::decimal_u64;
use crate::{protocol::Incarnation, AccountId, RuntimeError, RuntimeErrorCode};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum PlanMutation {
    PutOptimisticItem(ReplicaItemRecord),
    AcceptOperation(OperationRecord),
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
    RemoveOperation {
        operation_id: String,
    },
    /// Completes one applied create in the single transaction the outcome slice owes.
    ///
    /// Authority, receipt, Operation removal, overlay removal, and a matching exact Cursor
    /// advance are one mutation because they are one fact: the Server decided, and this Device
    /// now agrees. There is deliberately no partial form of that.
    ReconcileAppliedCreate {
        outcome: ObservedOutcome,
        /// Boxed only because an authoritative Item dwarfs every other mutation's payload.
        item: Box<AuthorityItemRecord>,
        cursor: Option<CursorAdvance>,
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

/// One Cursor step a reconciliation may take, and the exact Cursor it must start from.
///
/// A Sync event supplies both. When the Replica has moved on, the step is simply not taken: a
/// Cursor that no longer matches exactly is never advanced past unread work.
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
    Applied {
        entity_id: String,
        version: i32,
    },
    ShareApplied {
        share_link_id: String,
        base_share_url: String,
        expires_at: String,
    },
    Rejected {
        code: OperationRejectionCode,
    },
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
    pub item_id: String,
    pub vault_id: String,
    pub request_fingerprint: Sha256Fingerprint,
    pub result: OperationOutcomeResult,
    #[serde(with = "decimal_u64")]
    pub completed_at_revision: u64,
}

/// The closed set of durable mutations this Runtime accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationKind {
    CreateItem,
    UpdateItem,
    SetItemFavorite,
    TrashItem,
    RestoreItem,
    MoveItem,
    PermanentlyDeleteItem,
    CreateShare,
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
    pub item_id: String,
    pub vault_id: String,
    pub request: ImmutableHttpRequest,
    /// Covers the request, never the Operation ID. A Server outcome that carries this Operation ID
    /// with another fingerprint is therefore a detectable identity reuse, not a replay.
    pub request_fingerprint: Sha256Fingerprint,
    /// Opaque restart material retained by a prepared or stale-authority Attachment Move request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_move_recovery: Option<AttachmentMoveRecovery>,
    pub scheduling: OperationSchedulingState,
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

/// One accepted Attachment-bearing Move before its final HTTP request can exist.
///
/// This lives outside `operations`, so the ordinary dispatcher cannot observe incomplete work.
/// Every field is encrypted Server authority or opaque identity; transient credentials are absent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AttachmentMovePreparationRecord {
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
    pub vaults: Vec<AuthorityVaultRecord>,
    pub items: Vec<AuthorityItemRecord>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct PromoteBootstrapPlan {
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
}

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
    pub share_capabilities: Vec<ProtectedShareCapabilityRecord>,
    pub attachment_move_preparations: Vec<AttachmentMovePreparationRecord>,
    pub receipts: Vec<OperationReceiptRecord>,
    pub failure: Option<RuntimeErrorCode>,
    #[serde(skip)]
    pub bootstrap: BootstrapAuthority,
}

pub(super) fn apply_plan(
    current: ReplicaSnapshot,
    plan: GuardedCommitPlan,
) -> Result<ReplicaSnapshot, RuntimeError> {
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
    Ok(next.snapshot())
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
    pub(super) share_capabilities: HashMap<String, ProtectedShareCapabilityRecord>,
    pub(super) attachment_move_preparations: HashMap<String, AttachmentMovePreparationRecord>,
    pub(super) receipts: HashMap<String, OperationReceiptRecord>,
    pub(super) failure: Option<RuntimeErrorCode>,
    pub(super) bootstrap: BootstrapAuthority,
}

impl AccountReplica {
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
            failure: snapshot.failure,
            bootstrap: snapshot.bootstrap,
        }
    }

    pub(super) fn validate_durable_work(&self) -> Result<(), RuntimeError> {
        let mut operation_ids = HashSet::new();
        let mut item_ids = HashSet::new();
        for operation in self.operations.values() {
            check_immutable_request(operation)?;
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
                || !item_ids.insert(operation.item_id.clone())
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
            let accepted = capability.result.is_none()
                && matching_operation.is_some_and(|operation| {
                    operation.kind == OperationKind::CreateShare
                        && operation.operation_id == capability.operation_id
                });
            let pending = capability.result.as_ref().is_some_and(|result| {
                !result.share_link_id.is_empty()
                    && !result.base_share_url.is_empty()
                    && !result.expires_at.is_empty()
                    && matching_receipt.is_some_and(|receipt| {
                        receipt.kind == OperationKind::CreateShare
                            && matches!(
                                &receipt.result,
                                OperationOutcomeResult::ShareApplied {
                                    share_link_id,
                                    base_share_url,
                                    expires_at,
                                } if share_link_id == &result.share_link_id
                                    && base_share_url == &result.base_share_url
                                    && expires_at == &result.expires_at
                            )
                    })
            });
            if capability.account_id != self.account_id
                || capability.operation_id.is_empty()
                || capability.ciphertext.is_empty()
                || capability.iv.is_empty()
                || capability.algorithm != "AES-GCM-AAD-V1"
                || (!accepted && !pending)
            {
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
        let mut next = self.bootstrap.clone();
        next.active_generation = Some(plan.generation_id);
        next.active_cursor = pinned_watermark;
        next.staging_generation = None;
        next.state = ReplicaState::Ready;
        next.validate()?;
        self.bootstrap = next;
        self.revision = next_revision;
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
        self.bootstrap
            .items
            .insert((generation_id, item.id.clone()), item);
        self.bootstrap.active_cursor = next_cursor;
        self.bootstrap.validate()?;
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
            PlanMutation::PutOptimisticItem(item) => {
                self.check_item_scope(&item)?;
                self.check_overlay(&item)?;
                self.items.insert(item.item_id.clone(), item);
            }
            PlanMutation::AcceptOperation(operation) => {
                if self.operations.contains_key(&operation.operation_id)
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
                if self
                    .operations
                    .values()
                    .any(|active| active.item_id == operation.item_id)
                    || self
                        .attachment_move_preparations
                        .values()
                        .any(|active| active.item_id == operation.item_id)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "another active Operation already owns this Item",
                    ));
                }
                self.operations
                    .insert(operation.operation_id.clone(), operation);
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
                    .any(|active| active.item_id == preparation.item_id)
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
                    || existing.item_id != operation.item_id
                    || existing.vault_id != operation.vault_id
                    || existing.request != operation.request
                    || existing.request_fingerprint != operation.request_fingerprint
                    || existing.attachment_move_recovery != operation.attachment_move_recovery
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
            PlanMutation::RemoveOperation { operation_id } => {
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
                let OperationOutcomeResult::Applied { entity_id, version } = &outcome.result else {
                    return Err(replica_invariant(
                        "an applied reconciliation needs an applied outcome",
                    ));
                };
                // The outcome, the fetched Item, and the accepted Operation must describe one
                // entity at one version. Anything else is not this Operation's authority.
                if entity_id != &operation.item_id
                    || item.id != operation.item_id
                    || item.vault_id != operation.vault_id
                    || item.version != *version
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
                        ))
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
            item_id: operation.item_id.clone(),
            vault_id: operation.vault_id.clone(),
            request_fingerprint: operation.request_fingerprint,
            result: outcome.result.clone(),
            completed_at_revision: increment_revision(self.revision)?,
        };
        if let Some(existing) = self.receipts.get(&operation.operation_id) {
            if existing.request_fingerprint != receipt.request_fingerprint
                || existing.result != receipt.result
                || existing.item_id != receipt.item_id
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
        self.bootstrap.items.insert(key, item);
        self.bootstrap.validate()
    }

    /// Takes the Cursor step a Sync event supplied, and only from the exact Cursor it names.
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
        let identity = self
            .operations
            .get(&item.operation_id)
            .map(|operation| (&operation.item_id, &operation.vault_id))
            .or_else(|| {
                self.attachment_move_preparations
                    .get(&item.operation_id)
                    .map(|preparation| (&preparation.item_id, &preparation.target_vault_id))
            })
            .or_else(|| {
                self.receipts
                    .get(&item.operation_id)
                    .map(|receipt| (&receipt.item_id, &receipt.vault_id))
            });
        let Some((operation_item_id, operation_vault_id)) = identity else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "optimistic overlay has no accepted Operation",
            ));
        };
        if operation_item_id != &item.item_id || operation_vault_id != &item.vault_id {
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
        ReplicaSnapshot {
            account_id: self.account_id.clone(),
            user_id: self.user_id.clone(),
            incarnation: self.incarnation.clone(),
            revision: self.revision,
            lock_epoch: self.lock_epoch,
            items,
            operations,
            share_capabilities,
            attachment_move_preparations,
            receipts,
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
        item_id: preparation.item_id.clone(),
        vault_id: preparation.target_vault_id.clone(),
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
        attachment_move_recovery: None,
        scheduling: preparation.scheduling,
    };
    check_immutable_request(&operation)?;
    Ok(operation)
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
        OperationKind::CreateItem => "create_item",
        OperationKind::UpdateItem => "update_item",
        OperationKind::SetItemFavorite => "set_item_favorite",
        OperationKind::TrashItem => "trash_item",
        OperationKind::RestoreItem => "restore_item",
        OperationKind::MoveItem => "move_item",
        OperationKind::PermanentlyDeleteItem => "permanently_delete_item",
        OperationKind::CreateShare => "create_share",
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
    if operation.operation_id.is_empty() || operation.item_id.is_empty() {
        return Err(replica_invariant("Operation identity is empty"));
    }
    if !operation.request.path.starts_with('/') {
        return Err(replica_invariant("Operation route path is not absolute"));
    }
    if operation.request.body.is_empty()
        && !matches!(
            operation.kind,
            OperationKind::TrashItem
                | OperationKind::RestoreItem
                | OperationKind::PermanentlyDeleteItem
        )
    {
        return Err(replica_invariant("Operation request body is empty"));
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

#[allow(dead_code, reason = "the persistence wire invokes this model next")]
impl BootstrapAuthority {
    pub(super) fn row_count(&self) -> usize {
        let metadata = usize::from(self != &Self::default());
        metadata + self.generations.len() + self.pages.len() + self.vaults.len() + self.items.len()
    }

    pub(crate) fn validate(&self) -> Result<(), RuntimeError> {
        let active_is_cold = self.active_cursor == SyncCursor::Cold;
        if self.active_generation.is_none() != active_is_cold {
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
            if !generation.final_page_staged {
                return Err(replica_invariant(
                    "active Bootstrap generation is not complete",
                ));
            }
            validate_captured_cursor(&generation.pinned_watermark)?;
            validate_captured_cursor(&self.active_cursor)?;
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
fn validate_authority_page(
    vaults: &[AuthorityVaultRecord],
    items: &[AuthorityItemRecord],
) -> Result<(), RuntimeError> {
    let mut vault_ids = HashSet::new();
    for vault in vaults {
        validate_identifier(&vault.id, "Vault")?;
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

    fn generation_record(id: &str) -> BootstrapGenerationRecord {
        BootstrapGenerationRecord {
            generation_id: BootstrapGenerationId(id.into()),
            fallback_state: ReplicaState::Cold,
            pinned_watermark: SyncCursor::Cold,
            next_page_identity: BootstrapPageIdentity::vaults(0),
            next_page_cursor: BootstrapPageCursor::VaultsInitial,
            final_page_staged: false,
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
            item_id: "item-1".into(),
            vault_id: "vault-1".into(),
            request: ImmutableHttpRequest {
                method: HttpMethod::Post,
                path: "/api/v1/items/item-1/share-links".into(),
                headers: Vec::new(),
                body: br#"{"tokenHash":"hash"}"#.to_vec(),
            },
            request_fingerprint: Sha256Fingerprint([1; 32]),
            attachment_move_recovery: None,
            scheduling: OperationSchedulingState::default(),
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
            share_capabilities: vec![capability],
            attachment_move_preparations: Vec::new(),
            receipts: Vec::new(),
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
