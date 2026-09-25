use crate::{
    protocol::Incarnation, replica::BootstrapGenerationId, AccountId, RequestCancellation,
    RuntimeError, RuntimeErrorCode,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum ForegroundAttachmentTarget {
    VaultExport {
        vault_ids: Vec<String>,
    },
    VaultImage {
        vault_id: String,
        operation_id: String,
    },
    Item {
        vault_id: String,
        item_id: String,
    },
    Attachment {
        vault_id: String,
        attachment_id: String,
    },
    Move {
        source_vault_id: String,
        destination_vault_id: String,
        item_id: String,
    },
}
impl ForegroundAttachmentTarget {
    fn touches(&self, vault_id: &str) -> bool {
        match self {
            Self::VaultExport { vault_ids } => vault_ids.iter().any(|id| id == vault_id),
            Self::VaultImage {
                vault_id: target, ..
            }
            | Self::Item {
                vault_id: target, ..
            }
            | Self::Attachment {
                vault_id: target, ..
            } => target == vault_id,
            Self::Move {
                source_vault_id,
                destination_vault_id,
                ..
            } => source_vault_id == vault_id || destination_vault_id == vault_id,
        }
    }
}
type ScopeKey = (AccountId, Incarnation, Option<ForegroundAttachmentTarget>);
// Native callbacks may cross Runtime threads; the WASM Runtime and its host ports stay on
// their owning Worker. Keep the same registration/notification owner on both platforms.
#[cfg(not(target_arch = "wasm32"))]
type RetirementCallback = Arc<dyn Fn() + Send + Sync>;
#[cfg(target_arch = "wasm32")]
type RetirementCallback = Arc<dyn Fn()>;
#[cfg(test)]
type PublicationAdmissionHook = Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>;
#[cfg(test)]
type FinalizationAdmissionHook = Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>;

#[derive(Default)]
pub(super) struct ForegroundAttachmentRegistry {
    state: Arc<Mutex<RegistryState>>,
    vault_retirement_changed: tokio::sync::Notify,
    #[cfg(test)]
    before_publication_admission: PublicationAdmissionHook,
    #[cfg(test)]
    before_finalization_admission: FinalizationAdmissionHook,
}

#[derive(Default)]
struct RegistryState {
    scopes: HashMap<ScopeKey, Arc<ForegroundAttachmentScope>>,
    invitation_leases: HashMap<String, InvitationContinuationLease>,
    account_fences: HashMap<AccountId, usize>,
    global_fences: usize,
    vault_fences: HashMap<(AccountId, Incarnation, String), VaultRetirementState>,
    policy_verification_pending: HashMap<(AccountId, Incarnation), PolicyVerificationEntry>,
    next_policy_verification_id: u64,
    next_vault_retirement_id: u64,
}

const MAX_INVITATION_LEASES_PER_ACCOUNT: usize = 16;
const INVITATION_LEASE_MS: u64 = 10 * 60 * 1_000;

#[derive(Clone)]
pub(super) struct InvitationLeaseBinding {
    pub(super) account_id: AccountId,
    pub(super) incarnation: Incarnation,
    pub(super) lock_epoch: u64,
    pub(super) team_id: String,
    pub(super) invitation_id: String,
    pub(super) email: String,
    pub(super) role: crate::server_contract::TeamRole,
    pub(super) recipient_user_id: String,
    pub(super) public_key: String,
}

struct InvitationContinuationLease {
    binding: InvitationLeaseBinding,
    deadline_ms: u64,
    reserved_by: Option<RequestCancellation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ServerVerificationStatus {
    pub(super) revision: u64,
    pub(super) pending: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ServerVerificationToken {
    pub(super) account_id: AccountId,
    pub(super) incarnation: Incarnation,
    revision: u64,
}

#[derive(Default)]
struct PolicyVerificationEntry {
    server: Option<ServerVerificationStatus>,
    native: HashMap<String, (NativeVerificationToken, bool)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct NativeVerificationToken {
    pub(super) account_id: AccountId,
    pub(super) incarnation: Incarnation,
    pub(super) channel: String,
    pub(super) source: super::native_authority::NativeAccountScope,
    pub(super) revision: u64,
}

impl PolicyVerificationEntry {
    fn pending(&self) -> bool {
        self.server.is_some_and(|episode| episode.pending)
            || self.native.values().any(|(_, pending)| *pending)
    }
}

impl RegistryState {
    fn is_retiring(&self, account_id: &AccountId) -> bool {
        self.global_fences > 0 || self.account_fences.get(account_id).copied().unwrap_or(0) > 0
    }
}

#[derive(Default)]
struct ForegroundAttachmentScope {
    // Existing Account/Device lifecycle drains the explicit Move writer; selective Vault erasure
    // may cancel it before its keys disappear. Other foreground work remains cancellable by both.
    move_preparation: bool,
    state: Mutex<ScopeState>,
    drained: tokio::sync::Notify,
}

#[derive(Default)]
struct ScopeState {
    next_id: u64,
    active: HashMap<u64, ForegroundRegistration>,
    publications: usize,
    publication_fenced: bool,
}

struct ForegroundRegistration {
    cancellation: RequestCancellation,
    retirement: Option<RetirementCallback>,
}

pub(super) struct ForegroundAttachmentGuard {
    registry: Arc<Mutex<RegistryState>>,
    key: ScopeKey,
    scope: Arc<ForegroundAttachmentScope>,
    id: u64,
}

pub(super) struct ForegroundAttachmentPublication {
    registry: Arc<Mutex<RegistryState>>,
    key: ScopeKey,
    scope: Arc<ForegroundAttachmentScope>,
    #[cfg(test)]
    before_admission: PublicationAdmissionHook,
}

pub(super) struct AccountForegroundRetirement<'a> {
    registry: &'a ForegroundAttachmentRegistry,
    account_id: AccountId,
    scopes: Vec<Arc<ForegroundAttachmentScope>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum VaultRetirementProof {
    CompleteBootstrap(BootstrapGenerationId),
    /// Only the original pre-journal storage duty may consume this transient evidence.
    /// It never supplies current policy, readmission or a failed GET's fallback.
    VerifiedTravelPolicy {
        policy: Arc<crate::platform_storage::VerifiedTravelModePolicy>,
    },
    VerifiedNativeRestriction {
        batch: Arc<super::native_authority::NativeRestrictionBatch>,
    },
    DurableJournal {
        revision: u64,
    },
}

#[derive(Clone, Debug)]
pub(super) struct VaultRetirementBatch {
    pub(super) account_id: AccountId,
    pub(super) incarnation: Incarnation,
    pub(super) vault_ids: Vec<String>,
    pub(super) proof: VaultRetirementProof,
    pub(super) retry_not_before_ms: u64,
}

#[derive(Clone)]
enum VaultRetirementState {
    Retiring {
        identity: u64,
        proof: VaultRetirementProof,
        retry_not_before_ms: u64,
    },
    Retired {
        identity: u64,
        proof: VaultRetirementProof,
        retry_not_before_ms: u64,
    },
}
impl VaultRetirementState {
    fn identity(&self) -> u64 {
        match self {
            Self::Retiring { identity, .. } | Self::Retired { identity, .. } => *identity,
        }
    }

    fn proof(&self) -> &VaultRetirementProof {
        match self {
            Self::Retiring { proof, .. } | Self::Retired { proof, .. } => proof,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct VaultRetirementScopes {
    account_id: AccountId,
    incarnation: Incarnation,
    scopes: Vec<(String, u64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum VaultRetirementScopeState {
    Waiting,
    JournalOwned,
}

pub(super) struct VaultForegroundRetirement {
    pub(super) batch: VaultRetirementBatch,
    scopes: Vec<Arc<ForegroundAttachmentScope>>,
}

pub(super) struct DeviceForegroundRetirement<'a> {
    registry: &'a ForegroundAttachmentRegistry,
    scopes: Vec<Arc<ForegroundAttachmentScope>>,
}

impl ForegroundAttachmentRegistry {
    pub(super) fn require_invitation_lease_capacity(
        &self,
        account_id: &AccountId,
        now_ms: u64,
    ) -> Result<(), RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground registry lock poisoned");
        expire_invitation_leases(&mut registry, now_ms);
        if registry.is_retiring(account_id)
            || registry
                .invitation_leases
                .values()
                .filter(|lease| &lease.binding.account_id == account_id)
                .count()
                >= MAX_INVITATION_LEASES_PER_ACCOUNT
        {
            return Err(invitation_lease_refused(
                "Invitation continuation limit reached",
            ));
        }
        Ok(())
    }

    pub(super) fn issue_invitation_lease(
        &self,
        binding: InvitationLeaseBinding,
        now_ms: u64,
    ) -> Result<String, RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground registry lock poisoned");
        expire_invitation_leases(&mut registry, now_ms);
        if registry.is_retiring(&binding.account_id) {
            return Err(cancelled());
        }
        if registry.invitation_leases.values().any(|lease| {
            lease.binding.account_id == binding.account_id
                && lease.binding.invitation_id == binding.invitation_id
        }) {
            return Err(invitation_lease_refused(
                "Invitation already has a continuation",
            ));
        }
        if registry
            .invitation_leases
            .values()
            .filter(|lease| lease.binding.account_id == binding.account_id)
            .count()
            >= MAX_INVITATION_LEASES_PER_ACCOUNT
        {
            return Err(invitation_lease_refused(
                "Invitation continuation limit reached",
            ));
        }
        let deadline_ms = now_ms.checked_add(INVITATION_LEASE_MS).ok_or_else(|| {
            invitation_lease_refused("Invitation continuation deadline overflowed")
        })?;
        let mut id = bittery_crypto_core::generate_uuid();
        while registry.invitation_leases.contains_key(&id) {
            id = bittery_crypto_core::generate_uuid();
        }
        registry.invitation_leases.insert(
            id.clone(),
            InvitationContinuationLease {
                binding,
                deadline_ms,
                reserved_by: None,
            },
        );
        Ok(id)
    }

    pub(super) fn reserve_invitation_lease(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        lock_epoch: u64,
        id: &str,
        now_ms: u64,
        cancellation: RequestCancellation,
    ) -> Result<InvitationLeaseBinding, RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground registry lock poisoned");
        expire_invitation_leases(&mut registry, now_ms);
        if registry.is_retiring(account_id) {
            return Err(cancelled());
        }
        let lease = registry
            .invitation_leases
            .get_mut(id)
            .ok_or_else(|| invitation_lease_refused("Invitation continuation is unavailable"))?;
        if &lease.binding.account_id != account_id
            || &lease.binding.incarnation != incarnation
            || lease.binding.lock_epoch != lock_epoch
            || lease.reserved_by.is_some()
        {
            return Err(invitation_lease_refused(
                "Invitation continuation is unavailable",
            ));
        }
        lease.reserved_by = Some(cancellation);
        Ok(lease.binding.clone())
    }

    pub(super) fn invitation_lease_reserved(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        lock_epoch: u64,
        id: &str,
        now_ms: u64,
    ) -> Result<(), RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground registry lock poisoned");
        expire_invitation_leases(&mut registry, now_ms);
        if registry.is_retiring(account_id)
            || !registry.invitation_leases.get(id).is_some_and(|lease| {
                &lease.binding.account_id == account_id
                    && &lease.binding.incarnation == incarnation
                    && lease.binding.lock_epoch == lock_epoch
                    && lease.reserved_by.is_some()
            })
        {
            return Err(cancelled());
        }
        Ok(())
    }

    pub(super) fn finish_invitation_lease(&self, id: &str, restore: bool, now_ms: u64) {
        let mut registry = self
            .state
            .lock()
            .expect("foreground registry lock poisoned");
        expire_invitation_leases(&mut registry, now_ms);
        if restore {
            if let Some(lease) = registry.invitation_leases.get_mut(id) {
                lease.reserved_by = None;
            }
        } else {
            registry.invitation_leases.remove(id);
        }
    }

    pub(super) fn release_invitation_lease(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        lock_epoch: u64,
        id: &str,
    ) {
        let mut registry = self
            .state
            .lock()
            .expect("foreground registry lock poisoned");
        if registry.invitation_leases.get(id).is_some_and(|lease| {
            &lease.binding.account_id == account_id
                && &lease.binding.incarnation == incarnation
                && lease.binding.lock_epoch == lock_epoch
        }) {
            if let Some(lease) = registry.invitation_leases.remove(id) {
                if let Some(cancellation) = lease.reserved_by {
                    cancellation.cancel();
                }
            }
        }
    }

    pub(super) fn policy_verification_pending(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> bool {
        self.state
            .lock()
            .expect("foreground Attachment registry lock poisoned")
            .policy_verification_pending
            .get(&(account.clone(), incarnation.clone()))
            .is_some_and(PolicyVerificationEntry::pending)
    }

    /// Restored durable true has no attributed live reason. Existing live entries, including
    /// a resolved episode whose false acknowledgement was lost, must not acquire a new reason.
    pub(super) fn restore_policy_verification_pending(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<(), RuntimeError> {
        let mut state = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let key = (account.clone(), incarnation.clone());
        if !state.policy_verification_pending.contains_key(&key) {
            let revision = state
                .next_policy_verification_id
                .checked_add(1)
                .ok_or_else(cancelled)?;
            state.next_policy_verification_id = revision;
            state.policy_verification_pending.insert(
                key,
                PolicyVerificationEntry {
                    server: Some(ServerVerificationStatus {
                        revision,
                        pending: true,
                    }),
                    native: HashMap::new(),
                },
            );
        }
        Ok(())
    }

    pub(super) fn ensure_server_policy_verification(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<ServerVerificationToken, RuntimeError> {
        self.begin_server_policy_verification(account, incarnation, false)
    }

    pub(super) fn invalidate_server_policy_verification(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> Result<ServerVerificationToken, RuntimeError> {
        self.begin_server_policy_verification(account, incarnation, true)
    }

    fn begin_server_policy_verification(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        invalidation: bool,
    ) -> Result<ServerVerificationToken, RuntimeError> {
        let mut state = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let key = (account.clone(), incarnation.clone());
        if !invalidation {
            if let Some(episode) = state
                .policy_verification_pending
                .get(&key)
                .and_then(|entry| entry.server)
                .filter(|episode| episode.pending)
            {
                return Ok(ServerVerificationToken {
                    account_id: account.clone(),
                    incarnation: incarnation.clone(),
                    revision: episode.revision,
                });
            }
        }
        let revision = state
            .next_policy_verification_id
            .checked_add(1)
            .ok_or_else(cancelled)?;
        state.next_policy_verification_id = revision;
        state
            .policy_verification_pending
            .entry(key)
            .or_default()
            .server = Some(ServerVerificationStatus {
            revision,
            pending: true,
        });
        Ok(ServerVerificationToken {
            account_id: account.clone(),
            incarnation: incarnation.clone(),
            revision,
        })
    }

    pub(super) fn capture_server_policy_verification(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> Option<ServerVerificationToken> {
        self.server_policy_verification_status(account, incarnation)
            .filter(|episode| episode.pending)
            .map(|episode| ServerVerificationToken {
                account_id: account.clone(),
                incarnation: incarnation.clone(),
                revision: episode.revision,
            })
    }

    pub(super) fn server_policy_verification_status(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> Option<ServerVerificationStatus> {
        self.state
            .lock()
            .expect("foreground Attachment registry lock poisoned")
            .policy_verification_pending
            .get(&(account.clone(), incarnation.clone()))
            .and_then(|entry| entry.server)
    }

    pub(super) fn has_policy_verification_entry(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> bool {
        self.state
            .lock()
            .expect("foreground Attachment registry lock poisoned")
            .policy_verification_pending
            .contains_key(&(account.clone(), incarnation.clone()))
    }

    /// Removing one exact Server reason never resolves a successor. The caller
    /// owns durable aggregate reconciliation before restoring plaintext admission.
    pub(super) fn resolve_server_policy_verification(
        &self,
        token: &ServerVerificationToken,
    ) -> bool {
        let mut state = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let Some(episode) = state
            .policy_verification_pending
            .get_mut(&(token.account_id.clone(), token.incarnation.clone()))
            .and_then(|entry| entry.server.as_mut())
        else {
            return false;
        };
        if episode.revision != token.revision {
            return false;
        }
        let was_pending = episode.pending;
        episode.pending = false;
        was_pending
    }

    pub(super) fn is_only_server_policy_verification(
        &self,
        token: &ServerVerificationToken,
    ) -> bool {
        let state = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        state
            .policy_verification_pending
            .get(&(token.account_id.clone(), token.incarnation.clone()))
            .is_some_and(|entry| {
                entry.server
                    == Some(ServerVerificationStatus {
                        revision: token.revision,
                        pending: true,
                    })
                    && !entry.native.values().any(|(_, pending)| *pending)
            })
    }

    /// Caller holds native state then publication. Each admitted channel contributes at most
    /// one reason to this Account; only its exact source episode can resolve that reason.
    pub(super) fn receive_native_policy_verification(
        &self,
        token: NativeVerificationToken,
        source_pending: bool,
    ) -> Result<bool, RuntimeError> {
        let mut state = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let entry = state
            .policy_verification_pending
            .entry((token.account_id.clone(), token.incarnation.clone()))
            .or_default();
        let previous_pending = entry
            .native
            .get(&token.channel)
            .is_some_and(|(_, pending)| *pending);
        if let Some((previous, _)) = entry.native.get(&token.channel) {
            if previous.source != token.source {
                // Conserve the predecessor's admission reason until the channel's ordinary
                // hard authority-loss path fences this Account. The caller cannot skip that
                // path merely because verification remembers another source incarnation.
                return Ok(true);
            }
            if previous.revision > token.revision {
                return Err(cancelled());
            }
            if previous == &token {
                return Ok(false);
            }
        }
        entry.native.insert(
            token.channel.clone(),
            (token, source_pending || previous_pending),
        );
        Ok(false)
    }

    pub(super) fn native_policy_verification_pending(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        channel: &str,
    ) -> bool {
        self.state
            .lock()
            .expect("foreground Attachment registry lock poisoned")
            .policy_verification_pending
            .get(&(account.clone(), incarnation.clone()))
            .and_then(|entry| entry.native.get(channel))
            .is_some_and(|(_, pending)| *pending)
    }

    pub(super) fn resolve_native_policy_verification(&self, token: &NativeVerificationToken) {
        let mut state = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        if let Some((current, pending)) = state
            .policy_verification_pending
            .get_mut(&(token.account_id.clone(), token.incarnation.clone()))
            .and_then(|entry| entry.native.get_mut(&token.channel))
        {
            if current == token {
                *pending = false;
            }
        }
    }

    pub(super) fn retire_native_account_policy_verification(
        &self,
        channel: &str,
        account: &AccountId,
        incarnation: &Incarnation,
    ) {
        let mut state = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        if let Some(entry) = state
            .policy_verification_pending
            .get_mut(&(account.clone(), incarnation.clone()))
        {
            entry.native.remove(channel);
        }
    }

    /// Transport loss removes only this transient source attribution. The entry remains so
    /// an outstanding durable true is reconciled rather than reinterpreted as restart evidence.
    pub(super) fn retire_native_policy_verification(
        &self,
        channel: &str,
    ) -> Vec<(AccountId, Incarnation)> {
        let mut state = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        state
            .policy_verification_pending
            .iter_mut()
            .filter_map(|(scope, entry)| entry.native.remove(channel).map(|_| scope.clone()))
            .collect()
    }

    #[cfg(test)]
    pub(super) fn set_policy_verification_pending(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        pending: bool,
    ) {
        if pending {
            self.ensure_server_policy_verification(account, incarnation)
                .unwrap();
        } else if let Some(token) = self.capture_server_policy_verification(account, incarnation) {
            self.resolve_server_policy_verification(&token);
        }
    }

    /// Background admission must also observe the fence while lifecycle is draining current work,
    /// before the later Account access/teardown state has been published.
    pub(super) fn is_retiring(&self, account_id: &AccountId) -> bool {
        let registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        registry.is_retiring(account_id)
    }

    pub(super) fn register(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        cancellation: RequestCancellation,
    ) -> Result<ForegroundAttachmentGuard, RuntimeError> {
        self.register_untargeted(account_id, incarnation, cancellation, None)
    }

    /// A cleanup request may outlive its caller, but must still drain with this registration
    /// when Account or Device retirement cancels its foreground loan.
    pub(super) fn register_with_retirement(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        cancellation: RequestCancellation,
        retirement: RetirementCallback,
    ) -> Result<ForegroundAttachmentGuard, RuntimeError> {
        self.register_untargeted(account_id, incarnation, cancellation, Some(retirement))
    }

    fn register_untargeted(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        cancellation: RequestCancellation,
        retirement: Option<RetirementCallback>,
    ) -> Result<ForegroundAttachmentGuard, RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        if registry.is_retiring(account_id) {
            return Err(cancelled());
        }
        self.register_scope(
            account_id,
            incarnation.clone(),
            None,
            cancellation,
            retirement,
            &mut registry,
        )
    }

    fn register_scope(
        &self,
        account_id: &AccountId,
        incarnation: Incarnation,
        target: Option<ForegroundAttachmentTarget>,
        cancellation: RequestCancellation,
        retirement: Option<RetirementCallback>,
        registry: &mut RegistryState,
    ) -> Result<ForegroundAttachmentGuard, RuntimeError> {
        let key = (account_id.clone(), incarnation, target);
        let scope = registry
            .scopes
            .entry(key.clone())
            .or_insert_with(|| {
                Arc::new(ForegroundAttachmentScope {
                    move_preparation: matches!(
                        &key.2,
                        Some(ForegroundAttachmentTarget::Move { .. })
                    ),
                    ..ForegroundAttachmentScope::default()
                })
            })
            .clone();
        let mut state = scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned");
        let id = state.next_id;
        state.next_id = state.next_id.checked_add(1).ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "foreground Attachment registration identity exhausted",
            )
        })?;
        state.active.insert(
            id,
            ForegroundRegistration {
                cancellation,
                retirement,
            },
        );
        drop(state);
        Ok(ForegroundAttachmentGuard {
            registry: Arc::clone(&self.state),
            key,
            scope,
            id,
        })
    }

    pub(super) fn register_target(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        target: ForegroundAttachmentTarget,
        cancellation: RequestCancellation,
    ) -> Result<ForegroundAttachmentGuard, RuntimeError> {
        self.register_target_inner(account_id, incarnation, target, cancellation, None)
    }

    /// The callback belongs to this same registration and is installed before retirement can see it.
    pub(super) fn register_target_with_retirement(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        target: ForegroundAttachmentTarget,
        cancellation: RequestCancellation,
        retirement: RetirementCallback,
    ) -> Result<ForegroundAttachmentGuard, RuntimeError> {
        self.register_target_inner(
            account_id,
            incarnation,
            target,
            cancellation,
            Some(retirement),
        )
    }

    fn register_target_inner(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        target: ForegroundAttachmentTarget,
        cancellation: RequestCancellation,
        retirement: Option<RetirementCallback>,
    ) -> Result<ForegroundAttachmentGuard, RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        if registry.is_retiring(account_id)
            || registry
                .policy_verification_pending
                .get(&(account_id.clone(), incarnation.clone()))
                .is_some_and(PolicyVerificationEntry::pending)
            || registry
                .vault_fences
                .keys()
                .any(|(account, generation, vault)| {
                    account == account_id && generation == incarnation && target.touches(vault)
                })
        {
            return Err(cancelled());
        }
        self.register_scope(
            account_id,
            incarnation.clone(),
            Some(target),
            cancellation,
            retirement,
            &mut registry,
        )
    }

    pub(super) fn begin_vault_retirement(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        vault_ids: &[String],
        proof: VaultRetirementProof,
    ) -> Result<VaultForegroundRetirement, RuntimeError> {
        if vault_ids.iter().any(String::is_empty)
            || vault_ids.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return Err(cancelled());
        }
        let scopes = {
            let mut registry = self
                .state
                .lock()
                .expect("foreground Attachment registry lock poisoned");
            // An unfinished proof cannot be replaced by another caller's staging generation.
            if vault_ids.iter().any(|vault| matches!(
                registry.vault_fences.get(&(account_id.clone(), incarnation.clone(), vault.clone())),
                Some(VaultRetirementState::Retiring { proof: existing, .. }) if existing != &proof
            )) { return Err(cancelled()); }
            let missing = vault_ids
                .iter()
                .filter(|vault| {
                    !registry.vault_fences.contains_key(&(
                        account_id.clone(),
                        incarnation.clone(),
                        (*vault).clone(),
                    ))
                })
                .count();
            let reserved = registry
                .next_vault_retirement_id
                .checked_add(u64::try_from(missing).map_err(|_| cancelled())?)
                .ok_or_else(cancelled)?;
            // Reserve the complete batch before changing any entry; overflow cannot partially
            // fence a selection. Existing exclusion lifetimes survive every proof transition.
            let mut identity = registry.next_vault_retirement_id;
            registry.next_vault_retirement_id = reserved;
            for vault in vault_ids {
                let key = (account_id.clone(), incarnation.clone(), vault.clone());
                if let Some(state) = registry.vault_fences.get_mut(&key) {
                    if matches!(state, VaultRetirementState::Retired { proof: previous, .. } if previous != &proof)
                    {
                        *state = VaultRetirementState::Retiring {
                            identity: state.identity(),
                            proof: proof.clone(),
                            retry_not_before_ms: 0,
                        };
                    }
                } else {
                    identity += 1; // Entire allocation was checked before the first mutation.
                    registry.vault_fences.insert(
                        key,
                        VaultRetirementState::Retiring {
                            identity,
                            proof: proof.clone(),
                            retry_not_before_ms: 0,
                        },
                    );
                }
            }
            let scopes = registry
                .scopes
                .iter()
                .filter(|((account, generation, target), _)| {
                    account == account_id
                        && generation == incarnation
                        && target.as_ref().is_some_and(|target| {
                            vault_ids.iter().any(|vault| target.touches(vault))
                        })
                })
                .map(|(_, scope)| Arc::clone(scope))
                .collect::<Vec<_>>();
            fence_scopes(&scopes);
            scopes
        };
        cancel_scopes(&scopes, true);
        Ok(VaultForegroundRetirement {
            batch: VaultRetirementBatch {
                account_id: account_id.clone(),
                incarnation: incarnation.clone(),
                vault_ids: vault_ids.to_vec(),
                proof,
                retry_not_before_ms: 0,
            },
            scopes,
        })
    }

    pub(super) fn is_vault_fenced(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        vault: &str,
    ) -> bool {
        self.state
            .lock()
            .expect("foreground Attachment registry lock poisoned")
            .vault_fences
            .contains_key(&(account.clone(), incarnation.clone(), vault.to_owned()))
    }

    pub(super) fn has_pending_vault_retirement(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> bool {
        self.state
            .lock()
            .expect("foreground Attachment registry lock poisoned")
            .vault_fences
            .iter()
            .any(|((candidate, generation, _), state)| {
                candidate == account
                    && generation == incarnation
                    && matches!(state, VaultRetirementState::Retiring { .. })
            })
    }

    /// Capture existing exact exclusion lifetimes; absent/mixed-new scopes are not adopted.
    pub(super) fn capture_existing_vault_retirement_scopes(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        sorted_ids: &[String],
    ) -> Option<VaultRetirementScopes> {
        if sorted_ids.is_empty()
            || sorted_ids.iter().any(String::is_empty)
            || sorted_ids.windows(2).any(|pair| pair[0] >= pair[1])
        {
            return None;
        }
        let registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let scopes = sorted_ids
            .iter()
            .map(|id| {
                registry
                    .vault_fences
                    .get(&(account.clone(), incarnation.clone(), id.clone()))
                    .map(|state| (id.clone(), state.identity()))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(VaultRetirementScopes {
            account_id: account.clone(),
            incarnation: incarnation.clone(),
            scopes,
        })
    }

    /// A previous lifetime cannot be replaced by fresh same-ID authority. Caller keeps
    /// publication held through any synchronous native acknowledgement after this query.
    pub(super) fn vault_retirement_scope_state(
        &self,
        captured: &VaultRetirementScopes,
    ) -> Result<VaultRetirementScopeState, RuntimeError> {
        let registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let mut journal_owned = true;
        for (id, identity) in &captured.scopes {
            let current = registry
                .vault_fences
                .get(&(
                    captured.account_id.clone(),
                    captured.incarnation.clone(),
                    id.clone(),
                ))
                .ok_or_else(cancelled)?;
            if current.identity() != *identity {
                return Err(cancelled());
            }
            journal_owned &= matches!(current.proof(), VaultRetirementProof::DurableJournal { .. });
        }
        Ok(if journal_owned {
            VaultRetirementScopeState::JournalOwned
        } else {
            VaultRetirementScopeState::Waiting
        })
    }

    /// No Account execution or native/publication lock is held while awaiting the existing duty.
    pub(super) async fn wait_for_vault_retirement_journal(
        &self,
        captured: &VaultRetirementScopes,
    ) -> Result<(), RuntimeError> {
        loop {
            let changed = self.vault_retirement_changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.vault_retirement_scope_state(captured)?
                == VaultRetirementScopeState::JournalOwned
            {
                return Ok(());
            }
            changed.await;
        }
    }

    pub(super) fn fenced_vault_ids(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> Vec<String> {
        let mut ids = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned")
            .vault_fences
            .keys()
            .filter(|(candidate, generation, _)| candidate == account && generation == incarnation)
            .map(|(_, _, vault)| vault.clone())
            .collect::<Vec<_>>();
        ids.sort();
        ids
    }

    pub(super) fn pending_vault_retirements(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
    ) -> Vec<VaultRetirementBatch> {
        self.vault_retirement_batches(account, incarnation, None)
    }

    pub(super) fn pending_vault_readmissions(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        visible_vault_ids: &[String],
    ) -> Vec<VaultRetirementBatch> {
        self.vault_retirement_batches(account, incarnation, Some(visible_vault_ids))
    }

    fn vault_retirement_batches(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        readmit_visible: Option<&[String]>,
    ) -> Vec<VaultRetirementBatch> {
        let registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let mut grouped: HashMap<(VaultRetirementProof, u64), Vec<String>> = HashMap::new();
        for ((candidate, generation, vault), state) in &registry.vault_fences {
            if candidate != account || generation != incarnation {
                continue;
            }
            let selected = match (state, readmit_visible) {
                (
                    VaultRetirementState::Retiring {
                        proof,
                        retry_not_before_ms,
                        ..
                    },
                    None,
                ) => Some((proof, retry_not_before_ms)),
                (
                    VaultRetirementState::Retired {
                        proof,
                        retry_not_before_ms,
                        ..
                    },
                    Some(visible),
                ) if visible.contains(vault) => Some((proof, retry_not_before_ms)),
                _ => None,
            };
            if let Some((proof, deadline)) = selected {
                grouped
                    .entry((proof.clone(), *deadline))
                    .or_default()
                    .push(vault.clone());
            }
        }
        let mut batches = grouped
            .into_iter()
            .map(|((proof, retry_not_before_ms), mut vault_ids)| {
                vault_ids.sort();
                VaultRetirementBatch {
                    account_id: account.clone(),
                    incarnation: incarnation.clone(),
                    vault_ids,
                    proof,
                    retry_not_before_ms,
                }
            })
            .collect::<Vec<_>>();
        batches.sort_by(|left, right| left.vault_ids.cmp(&right.vault_ids));
        batches
    }

    /// Validate the captured duty before any policy proof write or physical purge. The caller
    /// holds Account execution; completed or readmitted captures cannot start another cleanup.
    pub(super) fn require_current_vault_retirement(
        &self,
        retirement: &VaultForegroundRetirement,
    ) -> Result<(), RuntimeError> {
        let registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        require_captured_retirement(&registry, &retirement.batch)?;
        if retirement.batch.vault_ids.iter().all(|vault| {
            matches!(
                registry.vault_fences.get(&(
                    retirement.batch.account_id.clone(),
                    retirement.batch.incarnation.clone(),
                    vault.clone()
                )),
                Some(VaultRetirementState::Retiring { .. })
            )
        }) {
            Ok(())
        } else {
            Err(cancelled())
        }
    }

    pub(super) fn record_vault_retirement_journal(
        &self,
        retirement: &mut VaultForegroundRetirement,
        revision: u64,
    ) -> Result<(), RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        require_captured_retirement(&registry, &retirement.batch)?;
        if retirement.batch.vault_ids.iter().any(|vault| {
            !matches!(
                registry.vault_fences.get(&(
                    retirement.batch.account_id.clone(),
                    retirement.batch.incarnation.clone(),
                    vault.clone()
                )),
                Some(VaultRetirementState::Retiring { .. })
            )
        }) {
            return Err(cancelled());
        }
        let proof = VaultRetirementProof::DurableJournal { revision };
        for vault in &retirement.batch.vault_ids {
            let state = registry
                .vault_fences
                .get_mut(&(
                    retirement.batch.account_id.clone(),
                    retirement.batch.incarnation.clone(),
                    vault.clone(),
                ))
                .expect("captured retirement checked");
            *state = VaultRetirementState::Retiring {
                identity: state.identity(),
                proof: proof.clone(),
                retry_not_before_ms: retirement.batch.retry_not_before_ms,
            };
        }
        retirement.batch.proof = proof;
        drop(registry);
        self.vault_retirement_changed.notify_waiters();
        Ok(())
    }

    pub(super) fn defer_vault_retirement(
        &self,
        retirement: &VaultForegroundRetirement,
        not_before_ms: u64,
    ) -> Result<(), RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        require_captured_retirement(&registry, &retirement.batch)?;
        if retirement.batch.vault_ids.iter().any(|vault| {
            !matches!(
                registry.vault_fences.get(&(
                    retirement.batch.account_id.clone(),
                    retirement.batch.incarnation.clone(),
                    vault.clone()
                )),
                Some(VaultRetirementState::Retiring { .. })
            )
        }) {
            return Err(cancelled());
        }
        for vault in &retirement.batch.vault_ids {
            if let Some(VaultRetirementState::Retiring {
                retry_not_before_ms,
                ..
            }) = registry.vault_fences.get_mut(&(
                retirement.batch.account_id.clone(),
                retirement.batch.incarnation.clone(),
                vault.clone(),
            )) {
                *retry_not_before_ms = not_before_ms;
            }
        }
        Ok(())
    }

    pub(super) fn acknowledge_vault_retirement(
        &self,
        retirement: &VaultForegroundRetirement,
    ) -> Result<(), RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        require_captured_retirement(&registry, &retirement.batch)?;
        if registry.scopes.iter().any(|(key, scope)| {
            scope_touches_batch(key, &retirement.batch)
                && !scope
                    .state
                    .lock()
                    .expect("foreground Attachment scope lock poisoned")
                    .active
                    .is_empty()
        }) {
            return Err(cancelled());
        }
        for vault in &retirement.batch.vault_ids {
            let state = registry
                .vault_fences
                .get_mut(&(
                    retirement.batch.account_id.clone(),
                    retirement.batch.incarnation.clone(),
                    vault.clone(),
                ))
                .expect("captured retirement checked");
            *state = VaultRetirementState::Retired {
                identity: state.identity(),
                proof: retirement.batch.proof.clone(),
                retry_not_before_ms: 0,
            };
        }
        Ok(())
    }

    pub(super) fn defer_vault_readmission(
        &self,
        batch: &VaultRetirementBatch,
        deadline: u64,
    ) -> Result<(), RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        require_captured_readmission(&registry, batch)?;
        for vault in &batch.vault_ids {
            if let Some(VaultRetirementState::Retired {
                retry_not_before_ms,
                ..
            }) = registry.vault_fences.get_mut(&(
                batch.account_id.clone(),
                batch.incarnation.clone(),
                vault.clone(),
            )) {
                *retry_not_before_ms = deadline;
            }
        }
        Ok(())
    }

    pub(super) fn complete_vault_readmission(
        &self,
        batch: &VaultRetirementBatch,
    ) -> Result<(), RuntimeError> {
        self.readmit_vaults(
            &batch.account_id,
            &batch.incarnation,
            &batch.vault_ids,
            Some(batch),
        )
    }

    #[cfg(test)]
    pub(super) fn readmit_verified_vaults(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        vault_ids: &[String],
    ) -> Result<(), RuntimeError> {
        self.readmit_vaults(account, incarnation, vault_ids, None)
    }

    fn readmit_vaults(
        &self,
        account: &AccountId,
        incarnation: &Incarnation,
        vault_ids: &[String],
        captured: Option<&VaultRetirementBatch>,
    ) -> Result<(), RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        if let Some(batch) = captured {
            require_captured_readmission(&registry, batch)?;
        }
        if registry.is_retiring(account)
            || vault_ids.iter().any(|vault| {
                matches!(
                    registry.vault_fences.get(&(
                        account.clone(),
                        incarnation.clone(),
                        vault.clone()
                    )),
                    Some(VaultRetirementState::Retiring { .. })
                )
            })
        {
            return Err(cancelled());
        }
        let retired: HashSet<_> = vault_ids
            .iter()
            .filter(|vault| {
                registry.vault_fences.contains_key(&(
                    account.clone(),
                    incarnation.clone(),
                    (*vault).clone(),
                ))
            })
            .cloned()
            .collect();
        let touches = |key: &ScopeKey| {
            &key.0 == account
                && &key.1 == incarnation
                && key
                    .2
                    .as_ref()
                    .is_some_and(|target| retired.iter().any(|vault| target.touches(vault)))
        };
        if registry.scopes.iter().any(|(key, scope)| {
            touches(key)
                && !scope
                    .state
                    .lock()
                    .expect("foreground Attachment scope lock poisoned")
                    .active
                    .is_empty()
        }) {
            return Err(cancelled());
        }
        let retired_scopes: HashSet<_> = registry
            .scopes
            .iter()
            .filter(|(key, _)| touches(key))
            .map(|(key, _)| key.clone())
            .collect();
        registry
            .scopes
            .retain(|key, _| !retired_scopes.contains(key));
        for vault in vault_ids {
            registry
                .vault_fences
                .remove(&(account.clone(), incarnation.clone(), vault.clone()));
        }
        drop(registry);
        self.vault_retirement_changed.notify_waiters();
        Ok(())
    }

    pub(super) fn forget_account_vault_retirements(
        &self,
        account_id: &AccountId,
    ) -> Result<(), RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        if !registry.is_retiring(account_id)
            || registry.scopes.iter().any(|((account, _, _), scope)| {
                account == account_id
                    && !scope
                        .state
                        .lock()
                        .expect("foreground Attachment scope lock poisoned")
                        .active
                        .is_empty()
            })
        {
            return Err(cancelled());
        }
        registry
            .vault_fences
            .retain(|(account, _, _), _| account != account_id);
        registry
            .policy_verification_pending
            .retain(|(account, _), _| account != account_id);
        drop(registry);
        self.vault_retirement_changed.notify_waiters();
        Ok(())
    }

    pub(super) fn begin_account_retirement(
        &self,
        account_id: &AccountId,
    ) -> AccountForegroundRetirement<'_> {
        let scopes = {
            let mut registry = self
                .state
                .lock()
                .expect("foreground Attachment registry lock poisoned");
            *registry
                .account_fences
                .entry(account_id.clone())
                .or_default() += 1;
            registry.invitation_leases.retain(|_, lease| {
                if &lease.binding.account_id != account_id {
                    return true;
                }
                if let Some(cancellation) = &lease.reserved_by {
                    cancellation.cancel();
                }
                false
            });
            let scopes = registry
                .scopes
                .iter()
                .filter(|((candidate, _, _), _)| candidate == account_id)
                .map(|(_, scope)| Arc::clone(scope))
                .collect::<Vec<_>>();
            fence_scopes(&scopes);
            scopes
        };
        cancel_scopes(&scopes, false);
        AccountForegroundRetirement {
            registry: self,
            account_id: account_id.clone(),
            scopes,
        }
    }

    pub(super) fn begin_accounts_retirement(
        &self,
        account_ids: &[AccountId],
    ) -> Vec<AccountForegroundRetirement<'_>> {
        account_ids
            .iter()
            .map(|account_id| self.begin_account_retirement(account_id))
            .collect()
    }

    pub(super) fn begin_device_retirement(&self) -> DeviceForegroundRetirement<'_> {
        let scopes = {
            let mut registry = self
                .state
                .lock()
                .expect("foreground Attachment registry lock poisoned");
            registry.global_fences += 1;
            for lease in registry.invitation_leases.values() {
                if let Some(cancellation) = &lease.reserved_by {
                    cancellation.cancel();
                }
            }
            registry.invitation_leases.clear();
            let scopes = registry.scopes.values().cloned().collect::<Vec<_>>();
            fence_scopes(&scopes);
            scopes
        };
        cancel_scopes(&scopes, false);
        DeviceForegroundRetirement {
            registry: self,
            scopes,
        }
    }

    pub(super) async fn fence_all_and_drain(&self) {
        let scopes = {
            let mut registry = self
                .state
                .lock()
                .expect("foreground Attachment registry lock poisoned");
            registry.global_fences = registry.global_fences.saturating_add(1);
            for lease in registry.invitation_leases.values() {
                if let Some(cancellation) = &lease.reserved_by {
                    cancellation.cancel();
                }
            }
            registry.invitation_leases.clear();
            let scopes = registry.scopes.values().cloned().collect::<Vec<_>>();
            fence_scopes(&scopes);
            scopes
        };
        cancel_scopes(&scopes, false);
        drain_scopes(&scopes).await;
    }

    pub(super) fn publication(
        &self,
        guard: &ForegroundAttachmentGuard,
    ) -> ForegroundAttachmentPublication {
        let _registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let mut state = guard
            .scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned");
        state.publications += 1;
        ForegroundAttachmentPublication {
            registry: Arc::clone(&self.state),
            key: guard.key.clone(),
            scope: Arc::clone(&guard.scope),
            #[cfg(test)]
            before_admission: Arc::clone(&self.before_publication_admission),
        }
    }

    #[cfg(test)]
    pub(super) fn before_finalization_admission(&self) {
        if let Some(hook) = self
            .before_finalization_admission
            .lock()
            .expect("foreground Attachment finalization hook lock poisoned")
            .clone()
        {
            hook();
        }
    }

    /// Atomically admits an irreversible foreground sink finalization against Account and Device
    /// lifecycle intent. The request's existing guard remains active across the admitted callback,
    /// so a lifecycle that loses this race drains it before retiring keys or authority.
    pub(super) fn admit_finalization(
        &self,
        guard: &ForegroundAttachmentGuard,
        cancellation: &RequestCancellation,
    ) -> bool {
        let registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let state = guard
            .scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned");
        registry.global_fences == 0
            && !registry
                .policy_verification_pending
                .get(&(guard.key.0.clone(), guard.key.1.clone()))
                .is_some_and(PolicyVerificationEntry::pending)
            && !state.publication_fenced
            && !cancellation.is_cancelled()
    }

    #[cfg(test)]
    pub(super) fn set_before_publication_admission_hook(
        &self,
        hook: Option<Arc<dyn Fn() + Send + Sync>>,
    ) {
        *self
            .before_publication_admission
            .lock()
            .expect("foreground Attachment publication hook lock poisoned") = hook;
    }

    #[cfg(test)]
    pub(super) fn set_before_finalization_admission_hook(
        &self,
        hook: Option<Arc<dyn Fn() + Send + Sync>>,
    ) {
        *self
            .before_finalization_admission
            .lock()
            .expect("foreground Attachment finalization hook lock poisoned") = hook;
    }
}

impl ForegroundAttachmentPublication {
    #[cfg(test)]
    pub(super) fn before_admission(&self) {
        let hook = self
            .before_admission
            .lock()
            .expect("foreground Attachment publication hook lock poisoned")
            .clone();
        if let Some(hook) = hook {
            hook();
        }
    }

    /// Linearizes callback begin against lifecycle intent. Once admitted, the callback owns only
    /// copied projection and observer data, so lifecycle neither waits for it nor holds this lock
    /// while host code runs.
    pub(super) fn begin(&self) -> bool {
        let registry = self
            .registry
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let state = self
            .scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned");
        !registry
            .policy_verification_pending
            .get(&(self.key.0.clone(), self.key.1.clone()))
            .is_some_and(PolicyVerificationEntry::pending)
            && !state.publication_fenced
    }

    /// Admit only a closed control result that carries no Vault plaintext or authority.
    /// A pending policy verification must not erase the outcome of an already sent
    /// mutation, while Account/Device retirement still fences its publication.
    pub(super) fn begin_control_result(&self) -> bool {
        let registry = self
            .registry
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let state = self
            .scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned");
        !registry.is_retiring(&self.key.0) && !state.publication_fenced
    }
}

impl Clone for ForegroundAttachmentPublication {
    fn clone(&self) -> Self {
        let _registry = self
            .registry
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        self.scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned")
            .publications += 1;
        Self {
            registry: Arc::clone(&self.registry),
            key: self.key.clone(),
            scope: Arc::clone(&self.scope),
            #[cfg(test)]
            before_admission: Arc::clone(&self.before_admission),
        }
    }
}

impl Drop for ForegroundAttachmentPublication {
    fn drop(&mut self) {
        let mut registry = self
            .registry
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let mut state = self
            .scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned");
        state.publications = state
            .publications
            .checked_sub(1)
            .expect("foreground Attachment publication was registered");
        let idle = state.active.is_empty() && state.publications == 0;
        drop(state);
        remove_idle_scope(&mut registry, &self.key, &self.scope, idle);
    }
}

#[allow(
    dead_code,
    reason = "ticket 86 capability seam; durable Vault retirement consumes it after the 70/71 integration gate"
)]
impl VaultForegroundRetirement {
    /// Caller has released native authority and publication before invoking foreign cleanup.
    pub(super) fn notify_retirement(&self) {
        notify_retirement(&self.scopes);
    }
    pub(super) async fn drain(&self) {
        drain_scopes(&self.scopes).await;
    }
}

impl AccountForegroundRetirement<'_> {
    /// First-fence handoff: no native, publication or registry lock may be held here.
    pub(super) fn notify_retirement(&self) {
        notify_retirement(&self.scopes);
    }

    pub(super) async fn drain(&self) {
        drain_scopes(&self.scopes).await;
    }
}

impl DeviceForegroundRetirement<'_> {
    pub(super) async fn drain(&self) {
        drain_scopes(&self.scopes).await;
    }
}

impl Drop for DeviceForegroundRetirement<'_> {
    fn drop(&mut self) {
        let mut registry = self
            .registry
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        registry.global_fences = registry
            .global_fences
            .checked_sub(1)
            .expect("foreground Attachment Device retirement was registered");
        let drained: HashSet<_> = self.scopes.iter().map(Arc::as_ptr).collect();
        registry
            .scopes
            .retain(|_, scope| !drained.contains(&Arc::as_ptr(scope)));
    }
}

impl Drop for AccountForegroundRetirement<'_> {
    fn drop(&mut self) {
        let mut registry = self
            .registry
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let remaining = registry
            .account_fences
            .get_mut(&self.account_id)
            .expect("foreground Attachment Account retirement was registered");
        *remaining -= 1;
        if *remaining == 0 {
            registry.account_fences.remove(&self.account_id);
            let drained: HashSet<_> = self.scopes.iter().map(Arc::as_ptr).collect();
            registry.scopes.retain(|(account_id, _, _), scope| {
                account_id != &self.account_id || !drained.contains(&Arc::as_ptr(scope))
            });
        }
    }
}

impl Drop for ForegroundAttachmentGuard {
    fn drop(&mut self) {
        let mut registry = self
            .registry
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let mut state = self
            .scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned");
        let removed = state.active.remove(&self.id).is_some();
        let empty = removed && state.active.is_empty();
        drop(state);
        let idle = empty && state_publications(&self.scope) == 0;
        remove_idle_scope(&mut registry, &self.key, &self.scope, idle);
        drop(registry);
        if empty {
            self.scope.drained.notify_waiters();
        }
    }
}

fn state_publications(scope: &ForegroundAttachmentScope) -> usize {
    scope
        .state
        .lock()
        .expect("foreground Attachment scope lock poisoned")
        .publications
}

fn remove_idle_scope(
    registry: &mut RegistryState,
    key: &ScopeKey,
    scope: &Arc<ForegroundAttachmentScope>,
    idle: bool,
) {
    if idle
        && registry.global_fences == 0
        && registry.account_fences.get(&key.0).copied().unwrap_or(0) == 0
        && registry
            .scopes
            .get(key)
            .is_some_and(|candidate| Arc::ptr_eq(candidate, scope))
    {
        registry.scopes.remove(key);
    }
}

fn expire_invitation_leases(registry: &mut RegistryState, now_ms: u64) {
    registry.invitation_leases.retain(|_, lease| {
        if lease.deadline_ms > now_ms {
            return true;
        }
        if let Some(cancellation) = &lease.reserved_by {
            cancellation.cancel();
        }
        false
    });
}

fn invitation_lease_refused(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::AuthenticationUnavailable, message)
}

#[cfg(test)]
impl ForegroundAttachmentRegistry {
    pub(super) fn active_target_count(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        target: ForegroundAttachmentTarget,
    ) -> usize {
        self.state
            .lock()
            .expect("foreground Attachment registry lock poisoned")
            .scopes
            .get(&(account_id.clone(), incarnation.clone(), Some(target)))
            .map_or(0, |scope| {
                scope
                    .state
                    .lock()
                    .expect("foreground Attachment scope lock poisoned")
                    .active
                    .len()
            })
    }

    pub(super) fn scope_count(&self) -> usize {
        self.state
            .lock()
            .expect("foreground Attachment registry lock poisoned")
            .scopes
            .len()
    }
}

fn cancel_scopes(scopes: &[Arc<ForegroundAttachmentScope>], include_moves: bool) {
    let cancellations = scopes
        .iter()
        .filter(|scope| include_moves || !scope.move_preparation)
        .flat_map(|scope| {
            scope
                .state
                .lock()
                .expect("foreground Attachment scope lock poisoned")
                .active
                .values()
                .map(|registration| registration.cancellation.clone())
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    for cancellation in cancellations {
        cancellation.cancel();
    }
}

fn fence_scopes(scopes: &[Arc<ForegroundAttachmentScope>]) {
    for scope in scopes {
        scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned")
            .publication_fenced = true;
    }
}

fn notify_retirement(scopes: &[Arc<ForegroundAttachmentScope>]) {
    let callbacks: Vec<_> = scopes
        .iter()
        .flat_map(|scope| {
            let mut state = scope
                .state
                .lock()
                .expect("foreground Attachment scope lock poisoned");
            state
                .active
                .values_mut()
                .filter_map(|registration| {
                    registration
                        .cancellation
                        .is_cancelled()
                        .then(|| registration.retirement.take())
                        .flatten()
                })
                .collect::<Vec<_>>()
        })
        .collect();
    // Never call foreign code under registry, scope, native authority or publication locks.
    for callback in callbacks {
        callback();
    }
}

async fn drain_scopes(scopes: &[Arc<ForegroundAttachmentScope>]) {
    notify_retirement(scopes);
    for scope in scopes {
        loop {
            let drained = scope.drained.notified();
            let should_wait = {
                let state = scope
                    .state
                    .lock()
                    .expect("foreground Attachment scope lock poisoned");
                !state.active.is_empty()
            };
            if !should_wait {
                break;
            }
            drained.await;
        }
    }
}

fn scope_touches_batch(key: &ScopeKey, batch: &VaultRetirementBatch) -> bool {
    key.0 == batch.account_id
        && key.1 == batch.incarnation
        && key
            .2
            .as_ref()
            .is_some_and(|target| batch.vault_ids.iter().any(|vault| target.touches(vault)))
}
fn require_captured_readmission(
    registry: &RegistryState,
    batch: &VaultRetirementBatch,
) -> Result<(), RuntimeError> {
    require_captured_retirement(registry, batch)?;
    if batch.vault_ids.iter().all(|vault| {
        matches!(
            registry.vault_fences.get(&(
                batch.account_id.clone(),
                batch.incarnation.clone(),
                vault.clone()
            )),
            Some(VaultRetirementState::Retired { .. })
        )
    }) {
        Ok(())
    } else {
        Err(cancelled())
    }
}

fn require_captured_retirement(
    registry: &RegistryState,
    batch: &VaultRetirementBatch,
) -> Result<(), RuntimeError> {
    if batch.vault_ids.iter().all(|vault| {
        registry
            .vault_fences
            .get(&(
                batch.account_id.clone(),
                batch.incarnation.clone(),
                vault.clone(),
            ))
            .is_some_and(|state| state.proof() == &batch.proof)
    }) {
        Ok(())
    } else {
        Err(cancelled())
    }
}

fn cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "foreground Attachment work was cancelled by Account lifecycle",
    )
}

#[cfg(test)]
mod selective_tests {
    use super::*;
    #[test]
    fn vault_retirement_of_an_old_incarnation_does_not_fence_replacement() {
        let registry = ForegroundAttachmentRegistry::default();
        let account = AccountId::from("account");
        let old = registry
            .register_target(
                &account,
                &Incarnation::from("old"),
                target("hidden"),
                RequestCancellation::new(),
            )
            .unwrap();
        let _retirement = registry
            .begin_vault_retirement(
                &account,
                &Incarnation::from("old"),
                &["hidden".into()],
                VaultRetirementProof::DurableJournal { revision: 1 },
            )
            .unwrap();
        assert!(
            registry
                .register_target(
                    &account,
                    &Incarnation::from("replacement"),
                    target("hidden"),
                    RequestCancellation::new(),
                )
                .is_ok(),
            "an old Vault fence cannot retire replacement Account authority"
        );
        drop(old);
    }
    fn target(vault: &str) -> ForegroundAttachmentTarget {
        ForegroundAttachmentTarget::Item {
            vault_id: vault.into(),
            item_id: "same-moved-item".into(),
        }
    }
    #[test]
    fn captured_cleanup_completion_stays_retired_and_cannot_acknowledge_a_new_proof() {
        let registry = ForegroundAttachmentRegistry::default();
        let account = AccountId::from("account");
        let incarnation = Incarnation::from("incarnation");
        let ids = vec!["hidden".to_owned()];
        let mut old = registry
            .begin_vault_retirement(
                &account,
                &incarnation,
                &ids,
                VaultRetirementProof::CompleteBootstrap(BootstrapGenerationId("complete".into())),
            )
            .unwrap();
        registry.defer_vault_retirement(&old, 500).unwrap();
        let pending = registry.pending_vault_retirements(&account, &incarnation);
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].retry_not_before_ms, 500);
        registry
            .record_vault_retirement_journal(&mut old, 17)
            .unwrap();
        assert!(registry.has_pending_vault_retirement(&account, &incarnation));
        registry.acknowledge_vault_retirement(&old).unwrap();
        assert!(!registry.has_pending_vault_retirement(&account, &incarnation));
        assert!(registry
            .record_vault_retirement_journal(&mut old, 18)
            .is_err());
        assert!(registry.defer_vault_retirement(&old, 999).is_err());
        assert!(registry.is_vault_fenced(&account, &incarnation, "hidden"));
        registry
            .readmit_verified_vaults(&account, &incarnation, &ids)
            .unwrap();
        let _new = registry
            .begin_vault_retirement(
                &account,
                &incarnation,
                &ids,
                VaultRetirementProof::DurableJournal { revision: 22 },
            )
            .unwrap();
        assert!(registry.acknowledge_vault_retirement(&old).is_err());
        assert!(registry.defer_vault_retirement(&old, 999).is_err());
        assert!(registry
            .record_vault_retirement_journal(&mut old, 23)
            .is_err());
        assert!(registry.has_pending_vault_retirement(&account, &incarnation));
        assert_eq!(
            registry.pending_vault_retirements(&account, &incarnation)[0].proof,
            VaultRetirementProof::DurableJournal { revision: 22 }
        );
    }

    #[test]
    fn fresh_authority_readmission_is_idempotent_for_an_already_live_vault() {
        let registry = ForegroundAttachmentRegistry::default();
        let account = AccountId::from("account-a");
        let cancellation = RequestCancellation::new();
        let _loan = registry
            .register_target(
                &account,
                &Incarnation::from("incarnation"),
                target("visible"),
                cancellation.clone(),
            )
            .unwrap();
        registry
            .readmit_verified_vaults(
                &account,
                &Incarnation::from("incarnation"),
                &["visible".into()],
            )
            .unwrap();
        assert!(!cancellation.is_cancelled());
    }

    #[tokio::test]
    async fn selective_retirement_drains_only_matching_plaintext_and_keeps_a_closed_generation() {
        let registry = ForegroundAttachmentRegistry::default();
        let account = AccountId::from("account-a");
        let incarnation = Incarnation::from("incarnation");
        let cancelled_a = RequestCancellation::new();
        let cancelled_b = RequestCancellation::new();
        let cancelled_other = RequestCancellation::new();
        let a = registry
            .register_target(
                &account,
                &incarnation,
                target("hidden"),
                cancelled_a.clone(),
            )
            .unwrap();
        let b = registry
            .register_target(
                &account,
                &incarnation,
                target("visible"),
                cancelled_b.clone(),
            )
            .unwrap();
        let other = registry
            .register_target(
                &AccountId::from("account-b"),
                &incarnation,
                target("hidden"),
                cancelled_other.clone(),
            )
            .unwrap();
        let publication = registry.publication(&a);
        let retirement = registry
            .begin_vault_retirement(
                &account,
                &incarnation,
                &["hidden".into()],
                VaultRetirementProof::DurableJournal { revision: 1 },
            )
            .unwrap();
        assert!(cancelled_a.is_cancelled());
        assert!(!cancelled_b.is_cancelled());
        assert!(!cancelled_other.is_cancelled());
        assert!(!publication.begin());
        assert!(!registry.admit_finalization(&a, &cancelled_a));
        assert!(registry.admit_finalization(&b, &cancelled_b));
        assert!(registry
            .register_target(
                &account,
                &incarnation,
                target("hidden"),
                RequestCancellation::new()
            )
            .is_err());
        assert!(registry
            .readmit_verified_vaults(&account, &incarnation, &["hidden".into()])
            .is_err());
        {
            let wait = retirement.drain();
            tokio::pin!(wait);
            assert!(
                std::future::Future::poll(
                    wait.as_mut(),
                    &mut std::task::Context::from_waker(std::task::Waker::noop())
                )
                .is_pending(),
                "the selected plaintext loan must drain"
            );
            drop(a);
            wait.await;
        }
        assert!(
            !cancelled_b.is_cancelled(),
            "another Vault's held plaintext does not block acknowledgement"
        );
        registry.acknowledge_vault_retirement(&retirement).unwrap();
        drop(retirement);
        assert!(registry
            .register_target(
                &account,
                &incarnation,
                target("hidden"),
                RequestCancellation::new()
            )
            .is_err());
        registry
            .readmit_verified_vaults(&account, &incarnation, &["hidden".into()])
            .unwrap();
        let fresh = registry
            .register_target(
                &account,
                &incarnation,
                target("hidden"),
                RequestCancellation::new(),
            )
            .unwrap();
        assert!(
            !publication.begin(),
            "re-admission never revives a prior publication witness"
        );
        drop((fresh, publication, b, other));
    }
}
