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
    RemoveOperation { operation_id: String },
}

/// The closed set of durable mutations this Runtime accepts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationKind {
    CreateItem,
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
    pub scheduling: OperationSchedulingState,
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
    Initial,
    After {
        cursor: String,
    },
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
#[serde(transparent)]
#[allow(
    dead_code,
    reason = "the persistence wire consumes this closed model next"
)]
pub(crate) struct BootstrapPageIdentity(#[serde(with = "decimal_u64")] pub(crate) u64);

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
            failure: snapshot.failure,
            bootstrap: snapshot.bootstrap,
        }
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
                next_page_identity: BootstrapPageIdentity(0),
                next_page_cursor: BootstrapPageCursor::Initial,
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

        let next_identity = plan
            .page_identity
            .0
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
        generation.next_page_identity = BootstrapPageIdentity(next_identity);
        match plan.continuation {
            BootstrapContinuation::Final => generation.final_page_staged = true,
            BootstrapContinuation::More { next_cursor } => {
                generation.next_page_cursor = BootstrapPageCursor::After {
                    cursor: next_cursor,
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
        if let Some(active) = &self.bootstrap.active_generation {
            if let Some(generation) = self.bootstrap.generations.get_mut(active) {
                generation.pinned_watermark = self.bootstrap.active_cursor.clone();
            }
        }
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
        match mutation {
            PlanMutation::PutOptimisticItem(item) => {
                self.check_item_scope(&item)?;
                self.check_overlay(&item)?;
                self.items.insert(item.item_id.clone(), item);
            }
            PlanMutation::AcceptOperation(operation) => {
                if self.operations.contains_key(&operation.operation_id) {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "operation identity was reused",
                    ));
                }
                check_immutable_request(&operation)?;
                if self
                    .operations
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
            PlanMutation::RemoveOperation { operation_id } => {
                if self.operations.remove(&operation_id).is_none() {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "cannot remove an unknown operation",
                    ));
                }
            }
        }
        Ok(())
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
        let Some(operation) = self.operations.get(&item.operation_id) else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "optimistic overlay has no accepted Operation",
            ));
        };
        if operation.item_id != item.item_id || operation.vault_id != item.vault_id {
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
        ReplicaSnapshot {
            account_id: self.account_id.clone(),
            user_id: self.user_id.clone(),
            incarnation: self.incarnation.clone(),
            revision: self.revision,
            lock_epoch: self.lock_epoch,
            items,
            operations,
            failure: self.failure,
            bootstrap: self.bootstrap.clone(),
        }
    }
}

/// Durable request bytes never carry a credential, and a durable route is never ambiguous.
fn check_immutable_request(operation: &OperationRecord) -> Result<(), RuntimeError> {
    if operation.operation_id.is_empty() || operation.item_id.is_empty() {
        return Err(replica_invariant("Operation identity is empty"));
    }
    if !operation.request.path.starts_with('/') {
        return Err(replica_invariant("Operation route path is not absolute"));
    }
    if operation.request.body.is_empty() {
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
            if !generation.final_page_staged || generation.pinned_watermark != self.active_cursor {
                return Err(replica_invariant(
                    "active Bootstrap generation is not complete at its active Cursor",
                ));
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
            receipts.sort_by_key(|receipt| receipt.page_identity.0);
            if u64::try_from(receipts.len()).ok() != Some(generation.next_page_identity.0) {
                return Err(replica_invariant(
                    "Bootstrap page receipt sequence has a gap",
                ));
            }
            let mut expected_cursor = BootstrapPageCursor::Initial;
            let mut terminal = false;
            for (expected_identity, receipt) in receipts.iter().enumerate() {
                let expected_identity = u64::try_from(expected_identity)
                    .map_err(|_| replica_invariant("Bootstrap page identity overflowed"))?;
                if receipt.generation_id != *generation_id
                    || receipt.page_identity != BootstrapPageIdentity(expected_identity)
                    || receipt.request_cursor != expected_cursor
                    || receipt.pinned_watermark != generation.pinned_watermark
                    || terminal
                {
                    return Err(replica_invariant(
                        "Bootstrap page receipt chain is inconsistent",
                    ));
                }
                validate_captured_cursor(&receipt.pinned_watermark)?;
                match &receipt.continuation {
                    BootstrapContinuation::Final => terminal = true,
                    BootstrapContinuation::More { next_cursor } => {
                        validate_identifier(next_cursor, "next Bootstrap page Cursor")?;
                        expected_cursor = BootstrapPageCursor::After {
                            cursor: next_cursor.clone(),
                        };
                    }
                }
            }
            if generation.next_page_identity.0 == 0 {
                if generation.pinned_watermark != SyncCursor::Cold
                    || generation.next_page_cursor != BootstrapPageCursor::Initial
                    || generation.final_page_staged
                {
                    return Err(replica_invariant(
                        "empty Bootstrap generation control record is inconsistent",
                    ));
                }
            } else if generation.pinned_watermark == SyncCursor::Cold
                || generation.final_page_staged != terminal
                || (!terminal && generation.next_page_cursor != expected_cursor)
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
            (&left.generation_id.0, left.page_identity.0)
                .cmp(&(&right.generation_id.0, right.page_identity.0))
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
            next_page_identity: BootstrapPageIdentity(0),
            next_page_cursor: BootstrapPageCursor::Initial,
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
                next_page_identity: BootstrapPageIdentity(1),
                final_page_staged: true,
                ..generation_record("active")
            },
        );
        authority.pages.insert(
            (generation_id.clone(), BootstrapPageIdentity(0)),
            BootstrapPageReceipt {
                generation_id: generation_id.clone(),
                page_identity: BootstrapPageIdentity(0),
                request_cursor: BootstrapPageCursor::Initial,
                raw_response_fingerprint: Sha256Fingerprint([1; 32]),
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
