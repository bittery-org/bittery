//! Restrictive native continuity belongs to the existing authority channel and grant.
use super::*;
use crate::replica::Sha256Fingerprint;
use std::collections::VecDeque;

use super::super::foreground_attachment_lifecycle::{
    VaultForegroundRetirement, VaultRetirementProof, VaultRetirementScopeState,
    VaultRetirementScopes,
};

type NativeRestrictionRetirements = Vec<NativeRestrictionAdoptionWork>;
type NativeTravelRetirement = (VaultForegroundRetirement, Option<Arc<DeliveryToken>>);

pub(super) enum NativeRestrictionAdoptionWork {
    New {
        expected: Box<ReplicaSnapshot>,
        retirement: VaultForegroundRetirement,
        token: Option<Arc<DeliveryToken>>,
    },
    Existing(NativeRestrictionWait),
}

pub(super) struct NativeRestrictionWait {
    destination: NativeAccountScope,
    batch: Arc<NativeRestrictionBatch>,
    scopes: VaultRetirementScopes,
    cancellation: RequestCancellation,
}

pub(super) const MAX_CHANNELS: usize = 16;
const MAX_OUTSTANDING: usize = 16;
const MAX_OWNER_OUTSTANDING: usize = 64;
const MAX_GRANT_EXCLUSIONS: usize = 1_600;
const MAX_OWNER_EXCLUSIONS: usize = 6_400;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestrictiveContinuity {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub from_generation: u64,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub through_generation: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeRestrictionEvidence {
    VerifiedPolicy { policy: NativeTravelEvidence },
    ExistingRetirement,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestrictionBatch {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub batch_id: u64,
    pub previous_digest: [u8; 32],
    pub content_digest: [u8; 32],
    pub chain_digest: [u8; 32],
    pub source: NativeAccountScope,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub from_key_generation: u64,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub to_key_generation: u64,
    pub evidence: NativeRestrictionEvidence,
    pub vault_ids: Vec<String>,
}

impl NativeRestrictionBatch {
    fn content_digest(&self) -> Result<[u8; 32], RuntimeError> {
        // Struct/tuple encoding is deterministic; the collection is validated sorted and unique.
        let content = serde_json::to_vec(&(
            "bittery/native-restriction/content/1",
            self.batch_id.to_string(),
            &self.source,
            self.from_key_generation.to_string(),
            self.to_key_generation.to_string(),
            &self.evidence,
            &self.vault_ids,
        ))
        .map_err(|_| native_retired())?;
        Ok(Sha256Fingerprint::of_bytes(&content).0)
    }

    fn chain_digest(&self) -> [u8; 32] {
        let mut content = b"bittery/native-restriction/chain/1".to_vec();
        content.extend_from_slice(&self.previous_digest);
        content.extend_from_slice(&self.batch_id.to_be_bytes());
        content.extend_from_slice(&self.content_digest);
        Sha256Fingerprint::of_bytes(&content).0
    }

    fn validate(&self) -> Result<(), RuntimeError> {
        crate::platform_storage::validate_travel_hidden_vault_ids(&self.vault_ids)?;
        if self.batch_id == 0
            || self.vault_ids.is_empty()
            || self.vault_ids.windows(2).any(|ids| ids[0] >= ids[1])
            || self.from_key_generation > self.to_key_generation
            || self.to_key_generation == u64::MAX
            || self.content_digest != self.content_digest()?
            || self.chain_digest != self.chain_digest()
        {
            return Err(native_retired());
        }
        if let NativeRestrictionEvidence::VerifiedPolicy { policy } = &self.evidence {
            crate::platform_storage::validate_travel_hidden_vault_ids(&policy.hidden_vault_ids)?;
            if !policy.enabled
                || policy.server_enabled_at_ms.is_none()
                || policy.server_updated_at_ms.is_none()
                || self
                    .vault_ids
                    .iter()
                    .any(|id| !policy.hidden_vault_ids.contains(id))
            {
                return Err(native_retired());
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(super) struct SourceRestrictions {
    next_id: u64,
    recipient: Option<(String, String, String)>,
    frontier: (u64, [u8; 32]),
    last_digest: [u8; 32],
    pending: VecDeque<NativeRestrictionBatch>,
}

impl SourceRestrictions {
    pub(super) fn new(owner: &str, channel: &str, transport: &str) -> Self {
        let encoded = serde_json::to_vec(&(
            "bittery/native-restriction/channel/1",
            owner,
            channel,
            transport,
        ))
        .expect("native channel identity serializes");
        let digest = Sha256Fingerprint::of_bytes(&encoded).0;
        Self {
            next_id: 1,
            recipient: None,
            frontier: (0, digest),
            last_digest: digest,
            pending: VecDeque::new(),
        }
    }

    fn append(
        &mut self,
        source: NativeAccountScope,
        from_key_generation: u64,
        to_key_generation: u64,
        evidence: NativeRestrictionEvidence,
        vault_ids: Vec<String>,
    ) -> Result<(), RuntimeError> {
        if self.pending.len() >= MAX_OUTSTANDING {
            return Err(native_retired());
        }
        let mut batch = NativeRestrictionBatch {
            batch_id: self.next_id,
            previous_digest: self.last_digest,
            content_digest: [0; 32],
            chain_digest: [0; 32],
            source,
            from_key_generation,
            to_key_generation,
            evidence,
            vault_ids,
        };
        batch.content_digest = batch.content_digest()?;
        batch.chain_digest = batch.chain_digest();
        batch.validate()?;
        self.next_id = self.next_id.checked_add(1).ok_or_else(native_retired)?;
        self.last_digest = batch.chain_digest;
        self.pending.push_back(batch);
        Ok(())
    }

    fn acknowledge(&mut self, batch_id: u64, chain_digest: [u8; 32]) -> Result<(), RuntimeError> {
        if batch_id < self.frontier.0 {
            return Ok(());
        }
        if batch_id == self.frontier.0 {
            return if chain_digest == self.frontier.1 {
                Ok(())
            } else {
                Err(native_retired())
            };
        }
        let batch = self
            .pending
            .iter()
            .find(|batch| batch.batch_id == batch_id)
            .ok_or_else(native_retired)?;
        if batch.chain_digest != chain_digest {
            return Err(native_retired());
        }
        self.frontier = (batch_id, chain_digest);
        while self
            .pending
            .front()
            .is_some_and(|batch| batch.batch_id <= batch_id)
        {
            self.pending.pop_front();
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct GrantRestrictions {
    pub(super) source_generation: u64,
    pub(super) excluded_vaults: HashSet<String>,
}

impl GrantRestrictions {
    pub(super) fn new(
        challenge: &NativeImportChallenge,
        policy: &crate::platform_storage::VerifiedTravelModePolicy,
    ) -> Self {
        Self {
            source_generation: challenge.source_key_generation,
            excluded_vaults: if policy.enabled {
                policy.hidden_vault_ids.iter().cloned().collect()
            } else {
                HashSet::new()
            },
        }
    }

    pub(super) fn authorizes(
        &self,
        account: &NativeAccountAuthority,
        binding: &NativeImportChallenge,
    ) -> bool {
        if !account.unlocked || account.scope != binding.source {
            return false;
        }
        if self.source_generation == binding.source_key_generation
            && account.authorizes_existing(binding)
        {
            return true;
        }
        account
            .restrictive_continuity
            .as_ref()
            .is_some_and(|continuity| {
                continuity.from_generation <= binding.source_key_generation
                    && continuity.through_generation == account.key_generation
                    && self.source_generation == account.key_generation
            })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum NativeRestrictionDisposition {
    JournalOwned {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        incarnation: Incarnation,
    },
    NoTargetAtCapture,
    TargetRemoved {
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        account_id: AccountId,
        #[cfg_attr(
            feature = "runtime-protocol-contract-schema",
            schemars(with = "String")
        )]
        incarnation: Incarnation,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestrictionAdoption {
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub batch_id: u64,
    pub content_digest: [u8; 32],
    pub chain_digest: [u8; 32],
    pub disposition: NativeRestrictionDisposition,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(
    feature = "runtime-protocol-contract-schema",
    derive(schemars::JsonSchema)
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeRestrictionAcknowledgement {
    pub source_owner: String,
    pub source_channel: String,
    pub source_transport: String,
    pub destination_owner: String,
    pub destination_channel: String,
    pub destination_transport: String,
    #[cfg_attr(
        feature = "runtime-protocol-contract-schema",
        schemars(schema_with = "crate::wire::decimal_u64::json_schema")
    )]
    #[serde(with = "crate::wire::decimal_u64")]
    pub frontier: u64,
    pub chain_digest: [u8; 32],
    pub adoptions: Vec<NativeRestrictionAdoption>,
}

#[derive(Clone)]
pub(super) struct DestinationRestrictions {
    // Only attachment/fresh explicit import captures these lifetimes, never batch replay.
    targets: HashMap<(String, String), CapturedNativeTarget>,
    cancellation: RequestCancellation,
    frontier: (u64, [u8; 32]),
    replay: VecDeque<NativeRestrictionAdoption>,
    pending: VecDeque<PendingAdoption>,
    pub(super) independent_exclusions: HashMap<AccountId, (Incarnation, HashSet<String>)>,
}

#[derive(Clone)]
enum CapturedNativeTarget {
    Current(NativeAccountScope),
    Removed(NativeAccountScope),
}

impl CapturedNativeTarget {
    fn scope(&self) -> &NativeAccountScope {
        match self {
            Self::Current(scope) | Self::Removed(scope) => scope,
        }
    }

    fn current(&self) -> Option<&NativeAccountScope> {
        match self {
            Self::Current(scope) => Some(scope),
            Self::Removed(_) => None,
        }
    }

    fn removal_disposition(&self) -> Option<NativeRestrictionDisposition> {
        match self {
            Self::Current(_) => None,
            Self::Removed(scope) => Some(NativeRestrictionDisposition::TargetRemoved {
                account_id: scope.account_id.clone(),
                incarnation: scope.incarnation.clone(),
            }),
        }
    }
}

#[derive(Clone)]
struct PendingAdoption {
    batch: Arc<NativeRestrictionBatch>,
    destination: Option<NativeAccountScope>,
    disposition: Option<NativeRestrictionDisposition>,
    retirement_scopes: Option<VaultRetirementScopes>,
}

impl DestinationRestrictions {
    pub(super) fn new(
        source: &NativeAuthoritySnapshot,
        local: impl IntoIterator<Item = NativeAccountScope>,
    ) -> Result<Self, RuntimeError> {
        let mut targets = HashMap::new();
        for scope in local {
            let key = (scope.server_url.clone(), scope.user_id.clone());
            if targets
                .insert(key, CapturedNativeTarget::Current(scope))
                .is_some()
            {
                return Err(native_retired());
            }
        }
        let origin =
            SourceRestrictions::new(&source.owner_id, &source.channel_id, &source.transport_id);
        Ok(Self {
            targets,
            cancellation: RequestCancellation::new(),
            frontier: origin.frontier,
            replay: VecDeque::new(),
            pending: VecDeque::new(),
            independent_exclusions: HashMap::new(),
        })
    }

    pub(super) fn independent_revalidation_target(
        &self,
        source: &NativeAccountScope,
    ) -> Option<&NativeAccountScope> {
        self.targets
            .get(&(source.server_url.clone(), source.user_id.clone()))
            .and_then(CapturedNativeTarget::current)
    }

    pub(super) fn has_adopted_frontier(&self, frontier: (u64, [u8; 32])) -> bool {
        self.frontier == frontier && self.pending.is_empty()
    }

    pub(super) fn require_known_replays(
        &self,
        source: &NativeAuthoritySnapshot,
    ) -> Result<(), RuntimeError> {
        // The source cannot legitimately retain an acknowledged batch older than this bounded
        // ring. Refuse unknown stale content without replacing the current channel authority.
        if source.restrictions.iter().any(|batch| {
            batch.batch_id <= self.frontier.0
                && !self.replay.iter().any(|old| old.batch_id == batch.batch_id)
        }) {
            return Err(native_retired());
        }
        Ok(())
    }

    fn receive(
        &mut self,
        batch: &NativeRestrictionBatch,
    ) -> Result<Option<PendingAdoption>, RuntimeError> {
        batch.validate()?;
        if batch.batch_id <= self.frontier.0 {
            let old = self
                .replay
                .iter()
                .find(|old| old.batch_id == batch.batch_id)
                .ok_or_else(native_retired)?;
            return if old.content_digest == batch.content_digest
                && old.chain_digest == batch.chain_digest
            {
                Ok(None)
            } else {
                Err(native_retired())
            };
        }
        if let Some(old) = self
            .pending
            .iter()
            .find(|old| old.batch.batch_id == batch.batch_id)
        {
            return if old.batch.as_ref() == batch {
                Ok(None)
            } else {
                Err(native_retired())
            };
        }
        let (last_id, last_digest) = self.pending.back().map_or(self.frontier, |last| {
            (last.batch.batch_id, last.batch.chain_digest)
        });
        if self.pending.len() >= MAX_OUTSTANDING
            || last_id.checked_add(1) != Some(batch.batch_id)
            || last_digest != batch.previous_digest
        {
            return Err(native_retired());
        }
        let target = self.targets.get(&(
            batch.source.server_url.clone(),
            batch.source.user_id.clone(),
        ));
        let removed = target.and_then(CapturedNativeTarget::removal_disposition);
        let pending = PendingAdoption {
            batch: Arc::new(batch.clone()),
            destination: target.map(|target| target.scope().clone()),
            disposition: None,
            retirement_scopes: None,
        };
        self.pending.push_back(pending.clone());
        if let Some(removed) = removed {
            self.adopted(batch, removed)?;
            Ok(None)
        } else {
            Ok(Some(pending))
        }
    }

    fn adopted(
        &mut self,
        batch: &NativeRestrictionBatch,
        disposition: NativeRestrictionDisposition,
    ) -> Result<(), RuntimeError> {
        let pending = self
            .pending
            .iter_mut()
            .find(|old| old.batch.batch_id == batch.batch_id)
            .ok_or_else(native_retired)?;
        if pending.batch.as_ref() != batch {
            return Err(native_retired());
        }
        if pending
            .disposition
            .as_ref()
            .is_some_and(|old| old != &disposition)
        {
            return Err(native_retired());
        }
        pending.disposition = Some(disposition);
        self.advance_completed_frontier();
        Ok(())
    }

    fn advance_completed_frontier(&mut self) {
        while self
            .pending
            .front()
            .is_some_and(|pending| pending.disposition.is_some())
        {
            let pending = self.pending.pop_front().expect("completed front exists");
            self.frontier = (pending.batch.batch_id, pending.batch.chain_digest);
            self.replay.push_back(NativeRestrictionAdoption {
                batch_id: pending.batch.batch_id,
                content_digest: pending.batch.content_digest,
                chain_digest: pending.batch.chain_digest,
                disposition: pending.disposition.expect("completed adoption"),
            });
            if self.replay.len() > MAX_OUTSTANDING {
                self.replay.pop_front();
            }
        }
    }

    /// The existing complete Account teardown proves every captured generation is gone. Catalog
    /// serialization still excludes a successor installation; incomplete teardown never calls this.
    fn complete_target_removal(&mut self, account: &AccountId) {
        for target in self.targets.values_mut() {
            if &target.scope().account_id == account {
                *target = CapturedNativeTarget::Removed(target.scope().clone());
            }
        }
        for pending in &mut self.pending {
            if pending.disposition.is_some() {
                continue;
            }
            if let Some(scope) = pending
                .destination
                .as_ref()
                .filter(|scope| &scope.account_id == account)
            {
                pending.disposition = Some(NativeRestrictionDisposition::TargetRemoved {
                    account_id: scope.account_id.clone(),
                    incarnation: scope.incarnation.clone(),
                });
            }
        }
        self.advance_completed_frontier();
        self.independent_exclusions.remove(account);
    }

    pub(super) fn cancel_adoption_waiters(&self) {
        self.cancellation.cancel();
    }

    pub(super) fn bind_import(&mut self, binding: &NativeImportChallenge) {
        self.targets.insert(
            (
                binding.source.server_url.clone(),
                binding.source.user_id.clone(),
            ),
            CapturedNativeTarget::Current(binding.destination.clone()),
        );
    }
}

impl Runtime {
    pub(in crate::runtime) fn complete_native_account_teardown(
        &self,
        account: &AccountId,
    ) -> Result<(), RuntimeError> {
        let mut state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let _publication = self.publication.lock().expect("publication lock poisoned");
        for channel in state.channels.values_mut() {
            if let Channel::Desktop { restrictions, .. } = channel {
                restrictions.complete_target_removal(account);
            }
        }
        // The successful teardown still owns its drained Account fence and catalog guard.
        // Record the bounded terminal disposition before scope removal can wake old waiters.
        self.foreground_attachments
            .forget_account_vault_retirements(account)
    }
}

#[derive(Clone)]
pub(super) struct SourceKeyAuthority {
    pub(super) incarnation: Incarnation,
    pub(super) generation: u64,
    pub(super) continuity: Option<NativeRestrictiveContinuity>,
    pub(super) excluded_vaults: HashSet<String>,
}

pub(super) fn source_restrictions<'a>(
    state: &'a AuthorityState,
    channel: &str,
) -> Result<&'a SourceRestrictions, RuntimeError> {
    match state.channels.get(channel) {
        Some(Channel::Source { restrictions, .. }) => Ok(restrictions),
        _ => Err(native_retired()),
    }
}

impl SourceRestrictions {
    pub(super) fn last_frontier(&self) -> (u64, [u8; 32]) {
        (self.next_id - 1, self.last_digest)
    }
    pub(super) fn pending_snapshot(&self) -> Vec<NativeRestrictionBatch> {
        self.pending.iter().cloned().collect()
    }
}

pub(super) fn validate_restrictions_snapshot(
    source: &NativeAuthoritySnapshot,
) -> Result<(), RuntimeError> {
    if source.restrictions.len() > MAX_OUTSTANDING {
        return Err(native_retired());
    }
    let mut previous: Option<&NativeRestrictionBatch> = None;
    for batch in &source.restrictions {
        batch.validate()?;
        if let Some(old) = previous {
            if old.batch_id.checked_add(1) != Some(batch.batch_id)
                || old.chain_digest != batch.previous_digest
            {
                return Err(native_retired());
            }
        }
        previous = Some(batch);
    }
    if let Some(last) = previous {
        if last.batch_id != source.restriction_frontier
            || last.chain_digest != source.restriction_chain_digest
        {
            return Err(native_retired());
        }
    }
    for account in &source.accounts {
        if let Some(continuity) = &account.restrictive_continuity {
            if !account.unlocked
                || continuity.from_generation > continuity.through_generation
                || continuity.through_generation != account.key_generation
                || account.key_generation == u64::MAX
            {
                return Err(native_retired());
            }
        }
    }
    Ok(())
}

pub(super) fn require_grant_channel(
    state: &AuthorityState,
    grant: &BorrowedGrant,
) -> Result<(), RuntimeError> {
    let binding = &grant.binding;
    match state.channels.get(&binding.destination_channel) {
        Some(Channel::Desktop {
            source,
            transport_id,
            ..
        }) if source.owner_id == binding.source_owner
            && source.channel_id == binding.source_channel
            && source.transport_id == binding.source_transport
            && source.extension_id == binding.extension_id
            && transport_id == &binding.destination_transport
            && source
                .accounts
                .iter()
                .any(|account| grant.restrictions.authorizes(account, binding)) =>
        {
            Ok(())
        }
        _ => Err(native_retired()),
    }
}

impl NativeAuthorityFacade {
    pub(super) fn register_source_channel(
        &self,
        channel: &str,
        extension_id: String,
        transport_id: String,
    ) -> Result<(), RuntimeError> {
        let mut state = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let publication = self
            .runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        self.runtime.ensure_open()?;
        if state.channels.len() >= MAX_CHANNELS {
            return Err(native_retired());
        }
        let mut restrictions =
            SourceRestrictions::new(&self.runtime.native_authority.owner, channel, &transport_id);
        // Existing enforced fences are sufficient revocation evidence. Presentation metadata is not.
        for snapshot in self.runtime.replica.snapshots() {
            let ids = self
                .runtime
                .foreground_attachments
                .fenced_vault_ids(&snapshot.account_id, &snapshot.incarnation);
            if ids.is_empty() {
                continue;
            }
            let scope = self.runtime.native_account_scope(&snapshot.account_id)?;
            let generation =
                source_key_generation(&state, &snapshot.account_id, &snapshot.incarnation);
            for ids in ids.chunks(100) {
                restrictions.append(
                    scope.clone(),
                    generation,
                    generation,
                    NativeRestrictionEvidence::ExistingRetirement,
                    ids.to_vec(),
                )?;
            }
        }
        let outstanding: usize = state
            .channels
            .values()
            .filter_map(|channel| match channel {
                Channel::Source { restrictions, .. } => Some(restrictions.pending.len()),
                _ => None,
            })
            .sum();
        if outstanding + restrictions.pending.len() > MAX_OWNER_OUTSTANDING {
            return Err(native_retired());
        }
        state.channels.insert(
            channel.into(),
            Channel::Source {
                extension_id,
                transport_id,
                sequence: 0,
                restrictions,
            },
        );
        drop(publication);
        drop(state);
        Ok(())
    }
}

impl Runtime {
    /// Install one policy-owned retirement through the same combined first-fence boundary.
    pub(in crate::runtime) fn begin_native_travel_retirement_publication(
        &self,
        expected: &ReplicaSnapshot,
        vault_ids: &[String],
        policy: Arc<crate::platform_storage::VerifiedTravelModePolicy>,
    ) -> Result<NativeTravelRetirement, RuntimeError> {
        let groups = vec![(
            vault_ids.to_vec(),
            VaultRetirementProof::VerifiedTravelPolicy {
                policy: Arc::clone(&policy),
            },
        )];
        let mut retirements =
            self.begin_native_travel_retirement_groups(expected, groups, policy)?;
        Ok(retirements
            .pop()
            .expect("one policy retirement was captured"))
    }

    /// The caller already selected this exact complete stage for promotion. Preserve its omitted
    /// scope proof and the policy's present scopes while classifying both at the first fence.
    pub(in crate::runtime) fn begin_native_travel_stage_retirement_publication(
        &self,
        expected: &ReplicaSnapshot,
        stage: &crate::replica::BootstrapGenerationId,
        policy: Arc<crate::platform_storage::VerifiedTravelModePolicy>,
    ) -> Result<Vec<NativeTravelRetirement>, RuntimeError> {
        if expected.bootstrap.staging_generation.as_ref() != Some(stage)
            || !expected
                .bootstrap
                .generations
                .get(stage)
                .is_some_and(|value| value.final_page_staged)
        {
            return Err(native_retired());
        }
        let (omitted, present): (Vec<_>, Vec<_>) =
            policy.hidden_vault_ids.iter().cloned().partition(|id| {
                !expected
                    .bootstrap
                    .vaults
                    .contains_key(&(stage.clone(), id.clone()))
            });
        let mut groups = Vec::new();
        if !omitted.is_empty() {
            groups.push((
                omitted,
                VaultRetirementProof::CompleteBootstrap(stage.clone()),
            ));
        }
        if !present.is_empty() {
            groups.push((
                present,
                VaultRetirementProof::VerifiedTravelPolicy {
                    policy: Arc::clone(&policy),
                },
            ));
        }
        self.begin_native_travel_retirement_groups(expected, groups, policy)
    }

    /// Existing proof owners share one native/publication boundary. Every acquired handoff is
    /// notified after both guards leave, including a failure after an earlier group's first fence.
    fn begin_native_travel_retirement_groups(
        &self,
        expected: &ReplicaSnapshot,
        groups: Vec<(Vec<String>, VaultRetirementProof)>,
        policy: Arc<crate::platform_storage::VerifiedTravelModePolicy>,
    ) -> Result<Vec<NativeTravelRetirement>, RuntimeError> {
        let mut state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let publication = self.publication.lock().expect("publication lock poisoned");
        let current = self.require_snapshot(&expected.account_id)?;
        if current.incarnation != expected.incarnation
            || current.revision != expected.revision
            || current.lock_epoch != expected.lock_epoch
        {
            return Err(native_retired());
        }
        let scope = if state
            .channels
            .values()
            .any(|channel| matches!(channel, Channel::Source { .. }))
        {
            Some(self.native_account_scope(&current.account_id)?)
        } else {
            None
        };
        let from = source_key_generation(&state, &current.account_id, &current.incarnation);
        let to = from
            .checked_add(1)
            .filter(|value| *value != u64::MAX)
            .ok_or_else(native_retired)?;
        let mut selected: Vec<_> = groups
            .iter()
            .flat_map(|(ids, _)| ids.iter().cloned())
            .collect();
        selected.sort();
        selected.dedup();
        crate::platform_storage::validate_travel_hidden_vault_ids(&selected)?;
        if selected.is_empty() {
            return Err(native_retired());
        }
        let mut retirements = Vec::new();
        let mut capture_error = None;
        for (mut ids, proof) in groups {
            ids.sort();
            ids.dedup();
            match self.begin_vault_retirement_under_publication(&publication, &current, &ids, proof)
            {
                Ok(publication) => {
                    retirements.push((publication.retirement, publication.token));
                    if capture_error.is_none() {
                        capture_error = publication.projection_error;
                    }
                }
                Err(error) => {
                    if capture_error.is_none() {
                        capture_error = Some(error);
                    }
                    break;
                }
            }
        }
        if retirements.is_empty() {
            return Err(capture_error.unwrap_or_else(native_retired));
        }
        let mut ids: Vec<_> = retirements
            .iter()
            .flat_map(|(retirement, _)| retirement.batch.vault_ids.iter().cloned())
            .collect();
        ids.sort();
        ids.dedup();
        let mut exclusions = state
            .source_key_generations
            .get(&current.account_id)
            .filter(|authority| authority.incarnation == current.incarnation)
            .map(|authority| authority.excluded_vaults.clone())
            .unwrap_or_default();
        exclusions.extend(ids.iter().cloned());
        let previous_continuity = state
            .source_key_generations
            .get(&current.account_id)
            .filter(|authority| authority.incarnation == current.incarnation)
            .and_then(|authority| authority.continuity.as_ref())
            .map(|continuity| continuity.from_generation)
            .unwrap_or(from);
        let owner_exclusions: usize = state
            .source_key_generations
            .iter()
            .filter(|(account, _)| *account != &current.account_id)
            .map(|(_, authority)| authority.excluded_vaults.len())
            .sum();
        let bounded = scope.is_some()
            && exclusions.len() <= MAX_GRANT_EXCLUSIONS
            && owner_exclusions + exclusions.len() <= MAX_OWNER_EXCLUSIONS;
        state.source_key_generations.insert(
            current.account_id.clone(),
            SourceKeyAuthority {
                incarnation: current.incarnation.clone(),
                generation: to,
                continuity: bounded.then_some(NativeRestrictiveContinuity {
                    from_generation: previous_continuity,
                    through_generation: to,
                }),
                excluded_vaults: if bounded { exclusions } else { HashSet::new() },
            },
        );
        let evidence = NativeRestrictionEvidence::VerifiedPolicy {
            policy: NativeTravelEvidence {
                enabled: policy.enabled,
                hidden_vault_ids: policy.hidden_vault_ids.clone(),
                server_enabled_at_ms: policy.server_enabled_at_ms,
                server_updated_at_ms: policy.server_updated_at_ms,
                verified_at_ms: policy.verified_at_ms,
            },
        };
        let mut outstanding: usize = state
            .channels
            .values()
            .filter_map(|channel| match channel {
                Channel::Source { restrictions, .. } => Some(restrictions.pending.len()),
                _ => None,
            })
            .sum();
        let mut retired = Vec::new();
        for (channel_id, channel) in &mut state.channels {
            if let Channel::Source { restrictions, .. } = channel {
                if !bounded
                    || outstanding >= MAX_OWNER_OUTSTANDING
                    || restrictions
                        .append(
                            scope
                                .as_ref()
                                .expect("source scope captured for attached channel")
                                .clone(),
                            from,
                            to,
                            evidence.clone(),
                            ids.clone(),
                        )
                        .is_err()
                {
                    retired.push(channel_id.clone());
                } else {
                    outstanding += 1;
                }
            }
        }
        for channel in retired {
            let scopes = retire_channel_in_state(self, &mut state, &channel);
            debug_assert!(
                scopes.is_empty(),
                "source retirement cannot own destination grants"
            );
        }
        for ceremony in state.ceremonies.values() {
            if ceremony.direction == NativeCeremonyDirection::Source
                && ceremony.scope().account_id == current.account_id
            {
                ceremony.cancellation.cancel();
            }
        }
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(publication);
        drop(state);
        for (retirement, _) in &retirements {
            retirement.notify_retirement();
        }
        self.wake_dispatch();
        if let Some(error) = capture_error {
            for (_, token) in &retirements {
                if let Some(token) = token {
                    token.wait_for_other_threads();
                }
            }
            return Err(error);
        }
        Ok(retirements)
    }

    /// Maintenance of a previously classified restriction does not widen its continuing grant.
    /// All other generation changes retain the existing hard-retirement behavior.
    pub(in crate::runtime) fn advance_native_retirement_authority(
        &self,
        expected: &ReplicaSnapshot,
        vault_ids: &[String],
    ) -> Result<u64, RuntimeError> {
        let mut state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let publication = self.publication.lock().expect("publication lock poisoned");
        self.ensure_not_closed()?;
        let current = self.require_snapshot(&expected.account_id)?;
        if current.incarnation != expected.incarnation
            || current.user_id != expected.user_id
            || current.lock_epoch != expected.lock_epoch
        {
            return Err(native_retired());
        }
        let previous = state
            .source_key_generations
            .get(&expected.account_id)
            .filter(|authority| authority.incarnation == expected.incarnation)
            .cloned();
        let generation = previous
            .as_ref()
            .map_or(0, |authority| authority.generation)
            .checked_add(1)
            .filter(|value| *value != u64::MAX)
            .ok_or_else(native_retired)?;
        let continuity = previous
            .as_ref()
            .filter(|authority| {
                !vault_ids.is_empty()
                    && vault_ids
                        .iter()
                        .all(|id| authority.excluded_vaults.contains(id))
            })
            .and_then(|authority| authority.continuity.as_ref())
            .map(|continuity| NativeRestrictiveContinuity {
                from_generation: continuity.from_generation,
                through_generation: generation,
            });
        let exclusions = if continuity.is_some() {
            previous
                .map(|authority| authority.excluded_vaults)
                .unwrap_or_default()
        } else {
            HashSet::new()
        };
        state.source_key_generations.insert(
            expected.account_id.clone(),
            SourceKeyAuthority {
                incarnation: expected.incarnation.clone(),
                generation,
                continuity,
                excluded_vaults: exclusions,
            },
        );
        for ceremony in state.ceremonies.values() {
            if ceremony.direction == NativeCeremonyDirection::Source
                && ceremony.scope().account_id == current.account_id
            {
                ceremony.cancellation.cancel();
            }
        }
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(publication);
        drop(state);
        self.wake_dispatch();
        Ok(generation)
    }

    /// Read only the existing channel/grant exclusion owner for this exact local lifetime.
    pub(in crate::runtime) fn native_excluded_vault_ids(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<Vec<String>, RuntimeError> {
        let state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let current = self.require_snapshot(&expected.account_id)?;
        if current.incarnation != expected.incarnation || current.lock_epoch != expected.lock_epoch
        {
            return Err(native_retired());
        }
        let mut ids = HashSet::new();
        if let Some(grant) = state
            .grants
            .get(&current.account_id)
            .filter(|grant| grant.binding.destination.incarnation == current.incarnation)
        {
            ids.extend(grant.restrictions.excluded_vaults.iter().cloned());
        }
        for channel in state.channels.values() {
            if let Channel::Desktop { restrictions, .. } = channel {
                if let Some((incarnation, excluded)) = restrictions
                    .independent_exclusions
                    .get(&current.account_id)
                    .filter(|(incarnation, _)| incarnation == &current.incarnation)
                {
                    let _ = incarnation;
                    ids.extend(excluded.iter().cloned());
                }
            }
        }
        let mut ids: Vec<_> = ids.into_iter().collect();
        ids.sort();
        Ok(ids)
    }
}

impl NativeAuthorityFacade {
    pub(super) fn receive_native_restrictions(
        &self,
        channel: &str,
        source: &NativeAuthoritySnapshot,
    ) -> Result<NativeRestrictionRetirements, (RuntimeError, NativeRestrictionRetirements)> {
        use super::super::foreground_attachment_lifecycle::VaultRetirementProof;
        // Every affected Vault is fenced before the first await, including independent local access.
        let mut retirements = Vec::new();
        let admission = (|| {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let publication = self
                .runtime
                .publication
                .lock()
                .expect("publication lock poisoned");
            self.runtime.ensure_open()?;
            let Some(Channel::Desktop {
                source: current,
                restrictions,
                ..
            }) = state.channels.get_mut(channel)
            else {
                return Err(native_retired());
            };
            if current != source {
                return Err(native_retired());
            }
            let mut candidate = restrictions.clone();
            for batch in &source.restrictions {
                candidate.receive(batch)?;
            }
            let received = candidate
                .pending
                .back()
                .map_or(candidate.frontier, |pending| {
                    (pending.batch.batch_id, pending.batch.chain_digest)
                });
            if received != (source.restriction_frontier, source.restriction_chain_digest) {
                return Err(native_retired());
            }
            let owner_pending: usize = state
                .channels
                .iter()
                .filter(|(id, _)| id.as_str() != channel)
                .map(|(_, value)| match value {
                    Channel::Desktop { restrictions, .. } => restrictions.pending.len(),
                    Channel::Source { restrictions, .. } => restrictions.pending.len(),
                })
                .sum();
            if owner_pending + candidate.pending.len() > MAX_OWNER_OUTSTANDING {
                return Err(native_retired());
            }
            let pending: Vec<_> = candidate
                .pending
                .iter()
                .filter(|pending| pending.disposition.is_none())
                .cloned()
                .collect();
            let Some(Channel::Desktop { restrictions, .. }) = state.channels.get_mut(channel)
            else {
                return Err(native_retired());
            };
            *restrictions = candidate;
            for pending in pending {
                let Some(captured) = &pending.destination else {
                    if let Some(Channel::Desktop { restrictions, .. }) =
                        state.channels.get_mut(channel)
                    {
                        restrictions.adopted(
                            &pending.batch,
                            NativeRestrictionDisposition::NoTargetAtCapture,
                        )?;
                    }
                    continue;
                };
                let Some(current) = self
                    .runtime
                    .replica
                    .snapshot(&captured.account_id)
                    .filter(|current| current.incarnation == captured.incarnation)
                else {
                    // Neither physical absence, incomplete teardown nor a successor incarnation
                    // proves this target removed. Only completed catalog cleanup changes its capture.
                    return Err(native_retired());
                };
                if current.user_id != captured.user_id {
                    return Err(native_retired());
                }
                let owner_count: usize = state
                    .grants
                    .values()
                    .map(|grant| grant.restrictions.excluded_vaults.len())
                    .sum::<usize>()
                    + state
                        .channels
                        .values()
                        .filter_map(|channel| match channel {
                            Channel::Desktop { restrictions, .. } => Some(
                                restrictions
                                    .independent_exclusions
                                    .values()
                                    .map(|(_, ids)| ids.len())
                                    .sum::<usize>(),
                            ),
                            _ => None,
                        })
                        .sum::<usize>();
                let borrowed = state.grants.get(&current.account_id).is_some_and(|grant| {
                    grant.binding.destination_channel == channel
                        && grant.binding.destination.incarnation == current.incarnation
                        && grant.binding.source == pending.batch.source
                });
                let existing_ids = if borrowed {
                    state
                        .grants
                        .get(&current.account_id)
                        .expect("grant checked")
                        .restrictions
                        .excluded_vaults
                        .clone()
                } else {
                    match state.channels.get(channel) {
                        Some(Channel::Desktop { restrictions, .. }) => restrictions
                            .independent_exclusions
                            .get(&current.account_id)
                            .filter(|(incarnation, _)| incarnation == &current.incarnation)
                            .map(|(_, ids)| ids.clone())
                            .unwrap_or_default(),
                        _ => return Err(native_retired()),
                    }
                };
                let mut next_ids = existing_ids.clone();
                next_ids.extend(pending.batch.vault_ids.iter().cloned());
                if next_ids.len() > MAX_GRANT_EXCLUSIONS
                    || owner_count - existing_ids.len() + next_ids.len() > MAX_OWNER_EXCLUSIONS
                {
                    return Err(native_retired());
                }
                // Existing lifetimes stay owned by their original proof. Fence only the
                // selected IDs not already represented in this same registry.
                if let Some(scopes) = &pending.retirement_scopes {
                    self.runtime
                        .foreground_attachments
                        .vault_retirement_scope_state(scopes)?;
                }
                let fenced = self
                    .runtime
                    .foreground_attachments
                    .fenced_vault_ids(&current.account_id, &current.incarnation);
                let missing: Vec<_> = pending
                    .batch
                    .vault_ids
                    .iter()
                    .filter(|id| fenced.binary_search(id).is_err())
                    .cloned()
                    .collect();
                let has_new_journal = !missing.is_empty();
                if has_new_journal {
                    let publication = self.runtime.begin_vault_retirement_under_publication(
                        &publication,
                        &current,
                        &missing,
                        VaultRetirementProof::VerifiedNativeRestriction {
                            batch: Arc::clone(&pending.batch),
                        },
                    )?;
                    // Retain the handoff before subsequent fallible capture checks. Partial
                    // failure still notifies this first fence after both locks have dropped.
                    retirements.push(NativeRestrictionAdoptionWork::New {
                        expected: Box::new(current.clone()),
                        retirement: publication.retirement,
                        token: publication.token,
                    });
                    if let Some(error) = publication.projection_error {
                        return Err(error);
                    }
                }
                let scopes = pending
                    .retirement_scopes
                    .clone()
                    .or_else(|| {
                        self.runtime
                            .foreground_attachments
                            .capture_existing_vault_retirement_scopes(
                                &current.account_id,
                                &current.incarnation,
                                &pending.batch.vault_ids,
                            )
                    })
                    .ok_or_else(native_retired)?;
                let journal_owned = self
                    .runtime
                    .foreground_attachments
                    .vault_retirement_scope_state(&scopes)?
                    == VaultRetirementScopeState::JournalOwned;
                if borrowed {
                    state
                        .grants
                        .get_mut(&current.account_id)
                        .expect("grant checked")
                        .restrictions
                        .excluded_vaults = next_ids;
                } else if let Some(Channel::Desktop { restrictions, .. }) =
                    state.channels.get_mut(channel)
                {
                    restrictions.independent_exclusions.insert(
                        current.account_id.clone(),
                        (current.incarnation.clone(), next_ids),
                    );
                }
                if let Some(Channel::Desktop { restrictions, .. }) = state.channels.get_mut(channel)
                {
                    restrictions
                        .pending
                        .iter_mut()
                        .find(|entry| entry.batch == pending.batch)
                        .ok_or_else(native_retired)?
                        .retirement_scopes = Some(scopes.clone());
                    if journal_owned {
                        restrictions.adopted(
                            &pending.batch,
                            NativeRestrictionDisposition::JournalOwned {
                                account_id: current.account_id.clone(),
                                incarnation: current.incarnation.clone(),
                            },
                        )?;
                    } else if !has_new_journal {
                        retirements.push(NativeRestrictionAdoptionWork::Existing(
                            NativeRestrictionWait {
                                destination: captured.clone(),
                                batch: Arc::clone(&pending.batch),
                                scopes,
                                cancellation: restrictions.cancellation.clone(),
                            },
                        ));
                    }
                }
            }
            // The complete retained prefix has been observed and its local selective fences are
            // installed. Only an explicitly classified, nonexpanding generation may continue.
            for grant in state
                .grants
                .values_mut()
                .filter(|grant| grant.binding.destination_channel == channel)
            {
                if let Some(account) = source
                    .accounts
                    .iter()
                    .find(|account| account.scope == grant.binding.source)
                {
                    if account
                        .restrictive_continuity
                        .as_ref()
                        .is_some_and(|continuity| {
                            continuity.from_generation <= grant.restrictions.source_generation
                                && continuity.through_generation == account.key_generation
                        })
                    {
                        grant.restrictions.source_generation = account.key_generation;
                    }
                }
            }
            drop(publication);
            drop(state);
            Ok::<(), RuntimeError>(())
        })();
        for work in &retirements {
            if let NativeRestrictionAdoptionWork::New { retirement, .. } = work {
                retirement.notify_retirement();
            }
        }
        self.runtime.wake_dispatch();
        if let Err(error) = admission {
            return Err((error, retirements));
        }
        Ok(retirements)
    }

    pub(super) async fn adopt_native_restrictions(
        &self,
        channel: &str,
        retirements: NativeRestrictionRetirements,
    ) -> Result<(), RuntimeError> {
        let mut adoptions: Vec<_> = retirements
            .into_iter()
            .map(|work| {
                Some(Box::pin(async move {
                    match work {
                        NativeRestrictionAdoptionWork::Existing(wait) => {
                            self.runtime
                                .wait_for_existing_native_retirement(channel, wait)
                                .await
                        }
                        NativeRestrictionAdoptionWork::New {
                            expected,
                            mut retirement,
                            token,
                        } => {
                            let VaultRetirementProof::VerifiedNativeRestriction { batch } =
                                &retirement.batch.proof
                            else {
                                return Err(native_retired());
                            };
                            let batch = Arc::clone(batch);
                            let Some((wait, journal_scopes)) =
                                self.runtime.capture_native_restriction_wait(
                                    channel,
                                    &batch,
                                    &retirement.batch.vault_ids,
                                )?
                            else {
                                return Ok(());
                            };
                            if let Some(token) = token {
                                token.wait_for_other_threads_async().await;
                            }
                            {
                                let execution =
                                    self.runtime.account_execution_lock(&expected.account_id)?;
                                let _execution = execution.lock().await;
                                // A joined retry may have adopted only this new subset already.
                                if self
                                    .runtime
                                    .foreground_attachments
                                    .vault_retirement_scope_state(&journal_scopes)?
                                    != VaultRetirementScopeState::JournalOwned
                                {
                                    self.runtime
                                        .adopt_vault_retirement_journal(&expected, &mut retirement)
                                        .await?;
                                }
                            }
                            // Never hold Account execution while an older independent proof
                            // still needs it. The immutable batch is acknowledged only as a whole.
                            self.runtime
                                .wait_for_existing_native_retirement(channel, wait)
                                .await
                        }
                    }
                }))
            })
            .collect();
        let mut failure = None;
        std::future::poll_fn(|context| {
            let mut pending = false;
            for adoption in &mut adoptions {
                let Some(future) = adoption.as_mut() else {
                    continue;
                };
                match std::future::Future::poll(future.as_mut(), context) {
                    std::task::Poll::Ready(result) => {
                        if let Err(error) = result {
                            if failure.is_none() {
                                failure = Some(error);
                            }
                        }
                        *adoption = None;
                    }
                    std::task::Poll::Pending => pending = true,
                }
            }
            if pending {
                std::task::Poll::Pending
            } else {
                std::task::Poll::Ready(())
            }
        })
        .await;
        if let Some(error) = failure {
            return Err(error);
        }

        self.runtime.wake_dispatch();
        Ok(())
    }

    pub fn restriction_acknowledgement(
        &self,
        channel: &str,
    ) -> Result<NativeRestrictionAcknowledgement, RuntimeError> {
        self.runtime.ensure_open()?;
        let state = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let Some(Channel::Desktop {
            source,
            transport_id,
            restrictions,
        }) = state.channels.get(channel)
        else {
            return Err(native_retired());
        };
        Ok(NativeRestrictionAcknowledgement {
            source_owner: source.owner_id.clone(),
            source_channel: source.channel_id.clone(),
            source_transport: source.transport_id.clone(),
            destination_owner: self.runtime.native_authority.owner.clone(),
            destination_channel: channel.into(),
            destination_transport: transport_id.clone(),
            frontier: restrictions.frontier.0,
            chain_digest: restrictions.frontier.1,
            adoptions: restrictions.replay.iter().cloned().collect(),
        })
    }

    pub fn acknowledge_restrictions(
        &self,
        acknowledgement: NativeRestrictionAcknowledgement,
    ) -> Result<(), RuntimeError> {
        self.runtime.ensure_open()?;
        if acknowledgement.source_owner != self.runtime.native_authority.owner
            || acknowledgement.adoptions.len() > MAX_OUTSTANDING
        {
            return Err(native_retired());
        }
        for identifier in [
            &acknowledgement.destination_owner,
            &acknowledgement.destination_channel,
            &acknowledgement.destination_transport,
        ] {
            require_identifier(identifier)?;
        }
        let mut state = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let Some(Channel::Source {
            transport_id,
            restrictions,
            ..
        }) = state.channels.get_mut(&acknowledgement.source_channel)
        else {
            return Err(native_retired());
        };
        if transport_id != &acknowledgement.source_transport {
            return Err(native_retired());
        }
        let recipient = (
            acknowledgement.destination_owner.clone(),
            acknowledgement.destination_channel.clone(),
            acknowledgement.destination_transport.clone(),
        );
        if restrictions
            .recipient
            .as_ref()
            .is_some_and(|current| current != &recipient)
        {
            return Err(native_retired());
        }
        // Authenticate every newly acknowledged batch, not merely the highest digest.
        for pending in restrictions
            .pending
            .iter()
            .filter(|batch| batch.batch_id <= acknowledgement.frontier)
        {
            let adoption = acknowledgement
                .adoptions
                .iter()
                .find(|adoption| adoption.batch_id == pending.batch_id)
                .ok_or_else(native_retired)?;
            if adoption.content_digest != pending.content_digest
                || adoption.chain_digest != pending.chain_digest
            {
                return Err(native_retired());
            }
        }
        restrictions.acknowledge(acknowledgement.frontier, acknowledgement.chain_digest)?;
        restrictions.recipient = Some(recipient);
        Ok(())
    }
}

impl Runtime {
    pub(in crate::runtime) fn native_restriction_journal_adopted(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        batch: &NativeRestrictionBatch,
    ) {
        let mut state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let _publication = self.publication.lock().expect("publication lock poisoned");
        for channel in state.channels.values_mut() {
            if let Channel::Desktop { restrictions, .. } = channel {
                let matches = restrictions.pending.iter().any(|pending| {
                    pending.batch.as_ref() == batch
                        && pending.destination.as_ref().is_some_and(|scope| {
                            &scope.account_id == account && &scope.incarnation == incarnation
                        })
                        && pending.retirement_scopes.as_ref().is_some_and(|scopes| {
                            self.foreground_attachments
                                .vault_retirement_scope_state(scopes)
                                == Ok(VaultRetirementScopeState::JournalOwned)
                        })
                });
                if matches {
                    // Journal ownership is irreversible; a retired channel simply has no live ACK.
                    let _ = restrictions.adopted(
                        batch,
                        NativeRestrictionDisposition::JournalOwned {
                            account_id: account.clone(),
                            incarnation: incarnation.clone(),
                        },
                    );
                }
            }
        }
    }
}

impl Runtime {
    fn acknowledge_existing_native_retirement(
        &self,
        channel: &str,
        destination: &NativeAccountScope,
        batch: &NativeRestrictionBatch,
        scopes: &VaultRetirementScopes,
        journal_result: Result<(), RuntimeError>,
    ) -> Result<(), RuntimeError> {
        let mut state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.ensure_open()?;
        let Some(Channel::Desktop { restrictions, .. }) = state.channels.get_mut(channel) else {
            return Err(native_retired());
        };
        let disposition = NativeRestrictionDisposition::JournalOwned {
            account_id: destination.account_id.clone(),
            incarnation: destination.incarnation.clone(),
        };
        let removed = NativeRestrictionDisposition::TargetRemoved {
            account_id: destination.account_id.clone(),
            incarnation: destination.incarnation.clone(),
        };
        // Another joined waiter, journal owner or completed exact teardown may have adopted it.
        if restrictions.replay.iter().any(|old| {
            old.batch_id == batch.batch_id
                && old.content_digest == batch.content_digest
                && old.chain_digest == batch.chain_digest
                && (old.disposition == disposition || old.disposition == removed)
        }) {
            return Ok(());
        }
        let pending = restrictions
            .pending
            .iter()
            .find(|entry| entry.batch.as_ref() == batch)
            .ok_or_else(native_retired)?;
        if pending.destination.as_ref() != Some(destination)
            || pending.retirement_scopes.as_ref() != Some(scopes)
        {
            return Err(native_retired());
        }
        if pending.disposition.as_ref() == Some(&removed) {
            // A preceding Account's hole can keep this completed removal outside the replay ring.
            return Ok(());
        }
        journal_result?;
        let current = self.native_account_scope(&destination.account_id)?;
        // Account Lock may retire borrowed credentials; the same incarnation's observed cleanup
        // duty remains valid. Remove/re-add, another User or Server cannot inherit this capture.
        if current.incarnation != destination.incarnation
            || current.user_id != destination.user_id
            || current.server_url != destination.server_url
        {
            return Err(native_retired());
        }
        if self
            .foreground_attachments
            .vault_retirement_scope_state(scopes)?
            != VaultRetirementScopeState::JournalOwned
        {
            return Err(native_retired());
        }
        restrictions.adopted(batch, disposition)
    }
}

impl Runtime {
    fn capture_native_restriction_wait(
        &self,
        channel: &str,
        batch: &Arc<NativeRestrictionBatch>,
        journal_ids: &[String],
    ) -> Result<Option<(NativeRestrictionWait, VaultRetirementScopes)>, RuntimeError> {
        let state = self
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.ensure_open()?;
        let Some(Channel::Desktop { restrictions, .. }) = state.channels.get(channel) else {
            return Err(native_retired());
        };
        if restrictions.replay.iter().any(|old| {
            old.batch_id == batch.batch_id
                && old.content_digest == batch.content_digest
                && old.chain_digest == batch.chain_digest
                && matches!(
                    old.disposition,
                    NativeRestrictionDisposition::JournalOwned { .. }
                )
        }) {
            return Ok(None);
        }
        let pending = restrictions
            .pending
            .iter()
            .find(|entry| entry.batch == *batch)
            .ok_or_else(native_retired)?;
        let destination = pending.destination.clone().ok_or_else(native_retired)?;
        let scopes = pending
            .retirement_scopes
            .clone()
            .ok_or_else(native_retired)?;
        self.foreground_attachments
            .vault_retirement_scope_state(&scopes)?;
        let journal_scopes = self
            .foreground_attachments
            .capture_existing_vault_retirement_scopes(
                &destination.account_id,
                &destination.incarnation,
                journal_ids,
            )
            .ok_or_else(native_retired)?;
        Ok(Some((
            NativeRestrictionWait {
                destination,
                batch: Arc::clone(batch),
                scopes,
                cancellation: restrictions.cancellation.clone(),
            },
            journal_scopes,
        )))
    }

    async fn wait_for_existing_native_retirement(
        &self,
        channel: &str,
        wait: NativeRestrictionWait,
    ) -> Result<(), RuntimeError> {
        let journal_result = tokio::select! {
            result = self.foreground_attachments.wait_for_vault_retirement_journal(&wait.scopes) => result,
            () = wait.cancellation.cancelled() => return Err(native_retired()),
        };
        self.acknowledge_existing_native_retirement(
            channel,
            &wait.destination,
            &wait.batch,
            &wait.scopes,
            journal_result,
        )
    }
}

pub(super) fn new_grant_restrictions(
    state: &AuthorityState,
    binding: &NativeImportChallenge,
    policy: &crate::platform_storage::VerifiedTravelModePolicy,
    session: &CurrentSessionDocument,
) -> Result<GrantRestrictions, RuntimeError> {
    let mut next = GrantRestrictions::new(binding, policy);
    let Some(Channel::Desktop { restrictions, .. }) =
        state.channels.get(&binding.destination_channel)
    else {
        return Err(native_retired());
    };
    if let Some((_, prior)) = restrictions
        .independent_exclusions
        .get(&binding.destination.account_id)
        .filter(|(incarnation, _)| incarnation == &binding.destination.incarnation)
    {
        next.excluded_vaults.extend(
            prior
                .iter()
                .filter(|id| !session.vault_keys.iter().any(|key| &key.vault_id == *id))
                .cloned(),
        );
    }
    let owner_count: usize = state
        .grants
        .iter()
        .filter(|(account, _)| *account != &binding.destination.account_id)
        .map(|(_, grant)| grant.restrictions.excluded_vaults.len())
        .sum::<usize>()
        + state
            .channels
            .iter()
            .map(|(channel, value)| match value {
                Channel::Desktop { restrictions, .. } => restrictions
                    .independent_exclusions
                    .iter()
                    .filter(|(account, _)| {
                        channel != &binding.destination_channel
                            || *account != &binding.destination.account_id
                    })
                    .map(|(_, (_, ids))| ids.len())
                    .sum::<usize>(),
                _ => 0,
            })
            .sum::<usize>();
    if next.excluded_vaults.len() > MAX_GRANT_EXCLUSIONS
        || owner_count + next.excluded_vaults.len() > MAX_OWNER_EXCLUSIONS
    {
        return Err(native_retired());
    }
    Ok(next)
}

pub(super) fn fresh_source_restrictions_adopted(
    state: &AuthorityState,
    channel: &str,
    source_scope: &NativeAccountScope,
) -> bool {
    let Some(Channel::Desktop {
        source,
        restrictions,
        ..
    }) = state.channels.get(channel)
    else {
        return false;
    };
    !restrictions
        .pending
        .iter()
        .any(|pending| &pending.batch.source == source_scope && pending.disposition.is_none())
        && source
            .restrictions
            .iter()
            .filter(|batch| &batch.source == source_scope)
            .all(|batch| {
                restrictions.replay.iter().any(|adoption| {
                    adoption.batch_id == batch.batch_id
                        && adoption.content_digest == batch.content_digest
                        && adoption.chain_digest == batch.chain_digest
                })
            })
}

impl NativeAuthorityFacade {
    /// Caller holds native state then publication. Source capture and the shared admission
    /// reason become visible together; no borrowed credential or foreground loan is retired.
    pub(super) fn receive_native_policy_verification(
        &self,
        state: &AuthorityState,
        channel: &str,
        source: &NativeAuthoritySnapshot,
    ) -> Result<Vec<NativeAccountScope>, RuntimeError> {
        let Some(Channel::Desktop { restrictions, .. }) = state.channels.get(channel) else {
            return Err(native_retired());
        };
        let mut replaced = Vec::new();
        for account in source.accounts.iter().filter(|account| account.unlocked) {
            let Some(status) = &account.policy_verification else {
                continue;
            };
            let Some(target) = restrictions
                .targets
                .get(&(
                    account.scope.server_url.clone(),
                    account.scope.user_id.clone(),
                ))
                .and_then(CapturedNativeTarget::current)
            else {
                continue;
            };
            let Some(current) =
                self.runtime
                    .replica
                    .snapshot(&target.account_id)
                    .filter(|current| {
                        current.incarnation == target.incarnation
                            && current.user_id == target.user_id
                    })
            else {
                continue;
            };
            if current.bootstrap.policy_verification_pending {
                self.runtime
                    .foreground_attachments
                    .restore_policy_verification_pending(
                        &current.account_id,
                        &current.incarnation,
                    )?;
            }
            let revision = match status {
                NativePolicyVerification::Pending { revision }
                | NativePolicyVerification::Verified { revision, .. } => *revision,
            };
            let source_replaced = self
                .runtime
                .foreground_attachments
                .receive_native_policy_verification(
                    super::super::foreground_attachment_lifecycle::NativeVerificationToken {
                        account_id: current.account_id.clone(),
                        incarnation: current.incarnation.clone(),
                        channel: channel.into(),
                        source: account.scope.clone(),
                        revision,
                    },
                    matches!(status, NativePolicyVerification::Pending { .. }),
                )?;
            if source_replaced {
                replaced.push(self.runtime.native_account_scope(&current.account_id)?);
            }
            if self.runtime.travel_policy_verification_pending(&current) {
                self.runtime
                    .pause_travel_plaintext_delivery(&current.account_id, true);
            }
        }
        Ok(replaced)
    }

    /// Account execution is the only durable marker writer. The source's verified episode can
    /// remove its own reason only after this channel has adopted its required restriction prefix.
    pub(super) async fn persist_native_policy_verification(
        &self,
        channel: &str,
        source: &NativeAuthoritySnapshot,
        resolve: bool,
    ) -> Result<(), RuntimeError> {
        let (targets, cancellation): (Vec<_>, _) = {
            let state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let Some(Channel::Desktop {
                source: current,
                restrictions,
                ..
            }) = state.channels.get(channel)
            else {
                return Err(native_retired());
            };
            if current != source {
                return Err(native_retired());
            }
            (
                restrictions
                    .targets
                    .values()
                    .filter_map(CapturedNativeTarget::current)
                    .cloned()
                    .collect(),
                restrictions.cancellation.clone(),
            )
        };
        let mut tasks: Vec<_> = targets
            .into_iter()
            .map(|target| {
                Some(Box::pin(self.persist_native_policy_target(
                    channel,
                    source,
                    target,
                    &cancellation,
                    resolve,
                )))
            })
            .collect();
        let mut failure = None;
        std::future::poll_fn(|context| {
            let mut pending = false;
            for task in &mut tasks {
                let Some(future) = task.as_mut() else {
                    continue;
                };
                match std::future::Future::poll(future.as_mut(), context) {
                    std::task::Poll::Ready(result) => {
                        if let Err(error) = result {
                            failure.get_or_insert(error);
                        }
                        *task = None;
                    }
                    std::task::Poll::Pending => pending = true,
                }
            }
            if pending {
                std::task::Poll::Pending
            } else {
                std::task::Poll::Ready(())
            }
        })
        .await;
        self.runtime.live_sync_wake.notify_waiters();
        self.runtime.publish_all_unless_closed();
        failure.map_or(Ok(()), Err)
    }
    async fn persist_native_policy_target(
        &self,
        channel: &str,
        source: &NativeAuthoritySnapshot,
        target: NativeAccountScope,
        cancellation: &RequestCancellation,
        resolve: bool,
    ) -> Result<(), RuntimeError> {
        let Some(current) = self
            .runtime
            .replica
            .snapshot(&target.account_id)
            .filter(|current| {
                current.incarnation == target.incarnation && current.user_id == target.user_id
            })
        else {
            return Ok(());
        };
        if !self
            .runtime
            .foreground_attachments
            .native_policy_verification_pending(&target.account_id, &target.incarnation, channel)
            && current.bootstrap.policy_verification_pending
                == self
                    .runtime
                    .foreground_attachments
                    .policy_verification_pending(&target.account_id, &target.incarnation)
        {
            return Ok(());
        }
        let execution = self.runtime.account_execution_lock(&target.account_id)?;
        let _execution = tokio::select! {
            guard = execution.lock() => guard,
            () = cancellation.cancelled() => return Err(native_retired()),
        };
        let expected = {
            let state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let _publication = self
                .runtime
                .publication
                .lock()
                .expect("publication lock poisoned");
            let Some(Channel::Desktop {
                source: current_source,
                restrictions,
                ..
            }) = state.channels.get(channel)
            else {
                return Err(native_retired());
            };
            if current_source != source {
                return Err(native_retired());
            }
            let expected = self.runtime.require_snapshot(&current.account_id)?;
            if expected.incarnation != target.incarnation || expected.user_id != target.user_id {
                return Ok(());
            }
            if resolve {
                match source
                    .accounts
                    .iter()
                    .find(|account| same_identity(&account.scope, &target))
                {
                    Some(account) if account.unlocked => {
                        if let Some(NativePolicyVerification::Verified {
                            revision,
                            restriction_frontier,
                        }) = account.policy_verification
                        {
                            if restrictions.frontier.0 < restriction_frontier {
                                return Err(native_retired());
                            }
                            self.runtime.foreground_attachments.resolve_native_policy_verification(
                                &super::super::foreground_attachment_lifecycle::NativeVerificationToken {
                                    account_id: target.account_id.clone(), incarnation: target.incarnation.clone(),
                                    channel: channel.into(), source: account.scope.clone(), revision,
                                },
                            );
                        }
                    }
                    _ => self
                        .runtime
                        .foreground_attachments
                        .retire_native_account_policy_verification(
                            channel,
                            &target.account_id,
                            &target.incarnation,
                        ),
                }
            }
            expected
        };
        tokio::select! {
            result = self.runtime.persist_travel_policy_pending_fenced(&expected) => { result?; },
            () = cancellation.cancelled() => return Err(native_retired()),
        }
        Ok(())
    }
}

impl NativeAuthorityFacade {
    /// The existing hard retirement has fenced this channel's grants. Only its native reason
    /// is removed; any independent Server episode still contributes to the same durable bit.
    pub(super) async fn retire_native_policy_verification(
        &self,
        channel: &str,
    ) -> Result<(), RuntimeError> {
        let targets = {
            let _publication = self
                .runtime
                .publication
                .lock()
                .expect("publication lock poisoned");
            self.runtime
                .foreground_attachments
                .retire_native_policy_verification(channel)
        };
        self.runtime.live_sync_wake.notify_waiters();
        let mut failure = None;
        for (account, incarnation) in targets {
            if self
                .runtime
                .replica
                .snapshot(&account)
                .is_none_or(|snapshot| snapshot.incarnation != incarnation)
            {
                continue;
            }
            // Even an uncommitted Pending marker paused delivery. Reconcile that gate when
            // the native reason retires, including when the durable bit was already false.
            let result = async {
                let execution = self.runtime.account_execution_lock(&account)?;
                let _execution = execution.lock().await;
                let current = self.runtime.require_snapshot(&account)?;
                if current.incarnation == incarnation {
                    self.runtime
                        .persist_travel_policy_pending_fenced(&current)
                        .await?;
                }
                Ok::<(), RuntimeError>(())
            }
            .await;
            if let Err(error) = result {
                failure.get_or_insert(error);
            }
        }
        self.runtime.publish_all_unless_closed();
        failure.map_or(Ok(()), Err)
    }
}

impl NativeAuthorityFacade {
    pub(super) fn replace_retired_native_policy_scopes(
        &self,
        channel: &str,
        source: &NativeAuthoritySnapshot,
        retired: &[NativeAccountScope],
    ) -> Result<(), RuntimeError> {
        if retired.is_empty() {
            return Ok(());
        }
        let state = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let _publication = self
            .runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        if !matches!(state.channels.get(channel), Some(Channel::Desktop { source: current, .. }) if current == source)
        {
            return Err(native_retired());
        }
        for scope in retired {
            self.runtime
                .foreground_attachments
                .retire_native_account_policy_verification(
                    channel,
                    &scope.account_id,
                    &scope.incarnation,
                );
        }
        // Only after the old authorization is fenced may its successor acquire a separate
        // native reason. Server reasons and already observed selective duties remain intact.
        if !self
            .receive_native_policy_verification(&state, channel, source)?
            .is_empty()
        {
            return Err(native_retired());
        }
        Ok(())
    }
}
