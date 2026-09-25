mod attachment_move_lifecycle;
#[cfg(test)]
mod attachment_tests;
#[cfg(test)]
pub(crate) use attachment_move_lifecycle::live_artifact_owners;
mod attachment;
pub use attachment::{
    AttachmentDownloadFacade, AttachmentDownloadSink, AttachmentDownloadSinkError,
    AttachmentDownloadSinkPort, AttachmentUploadBinary, AttachmentUploadBinaryOutcome,
    AttachmentUploadFacade, AttachmentUploadSource, AttachmentUploadSourceError,
    AttachmentUploadSourcePort, AttachmentUploadTransferPort,
};
mod account_refresh;
#[cfg(test)]
mod account_refresh_tests;
#[cfg(test)]
mod attachment_move_lifecycle_tests;
#[allow(
    dead_code,
    reason = "Ticket 28 C2 lands the preparation worker before C4 composes its production ports"
)]
mod attachment_move_preparation;
#[cfg(test)]
mod attachment_move_preparation_tests;
#[allow(
    dead_code,
    reason = "the obsolete download-pass enum stays private until the scheduler module is simplified"
)]
mod attachment_move_scheduler;
#[cfg(test)]
mod attachment_move_scheduler_tests;
mod attachment_transcryption;
mod biometric;
mod bootstrap;
mod inactivity;
mod local_access;
mod my_invitations;
mod native_authority;
mod travel_commands;
mod travel_policy;
pub use biometric::{BiometricPort, BiometricPromptResult};
#[cfg(feature = "runtime-protocol-contract-schema")]
pub use native_authority::native_authority_contract_schema;
pub use native_authority::{
    NativeAccountAuthority, NativeAccountProfile, NativeAccountScope, NativeAuthorityFacade,
    NativeAuthorityRequest, NativeAuthorityResponse, NativeAuthoritySnapshot,
    NativeChallengePurpose, NativeImportChallenge, NativeIndependentRevalidationReply,
    NativePolicyVerification, NativeRestrictionAcknowledgement, NativeRestrictionAdoption,
    NativeRestrictionBatch, NativeRestrictionDisposition, NativeRestrictionEvidence,
    NativeRestrictiveContinuity, NativeSourceAttachment, NativeTransferReply, NativeTravelEvidence,
};
mod create;
#[cfg(test)]
mod create_tests;
mod create_vault;
mod create_vault_cleanup;
mod create_vault_executor;
mod create_vault_staging;
#[cfg(test)]
mod create_vault_tests;
mod cross_account_move;
mod dispatch;
#[cfg(test)]
mod dispatch_tests;
mod foreground_attachment_lifecycle;
mod import;
#[allow(
    dead_code,
    reason = "Ticket 56 lands the complete Import executor behind Ticket 57's production gate"
)]
mod import_executor;
#[cfg(test)]
mod import_tests;
mod install;
mod installation_commit;
#[cfg(test)]
mod invitation_tests;
mod invitations;
mod live_sync;
#[cfg(test)]
mod live_sync_tests;
mod lock;
#[cfg(test)]
mod my_invitation_tests;
mod open;
#[cfg(test)]
pub(crate) mod operation_fixtures;
mod outcome;
#[cfg(test)]
mod outcome_tests;
mod private_item_commands;
mod profile_admission;
mod recipient_keys;
mod recovery;
mod rotation;
#[cfg(test)]
mod rotation_start_tests;
mod server_account_deletion;
mod share_management;
#[cfg(test)]
mod share_management_tests;
#[cfg(test)]
mod share_outcome_tests;
mod team_page;
#[cfg(test)]
mod team_page_tests;
mod teardown;
#[cfg(test)]
mod teardown_tests;
mod vault_artifact_retirement;
mod vault_key;
mod vault_members;
mod vault_mutation;
#[cfg(test)]
mod vault_mutation_tests;
mod vault_retirement;
#[cfg(feature = "binding-test-harness")]
mod vault_retirement_binding_fixture;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod vault_retirement_integration_tests;
mod vault_visibility;

use crate::AccountUnlockCapabilities;
#[doc(hidden)]
pub use attachment_move_lifecycle::{AttachmentMoveAccountLease, AttachmentMoveAccountLeasePort};
use attachment_move_lifecycle::{AttachmentMoveLifecycle, LifecyclePass};
#[cfg(test)]
use attachment_move_scheduler::AttachmentMovePreparationDriver;
#[doc(hidden)]
pub use attachment_move_scheduler::{
    AttachmentMoveDownload, AttachmentMoveDownloadRequest, AttachmentMovePreparationFacade,
    AttachmentMoveTransferError, AttachmentMoveTransferPort, AttachmentMoveUpload,
    AttachmentMoveUploadGrant,
};
use attachment_move_scheduler::{
    AttachmentMovePreparationScheduler, PreparationCandidate, SchedulerPass,
};
use dispatch::DispatchLeases;
use lock::AccessRetirement;
pub use teardown::{TeardownHostCleanup, TeardownHostCleanupRequest, TeardownHostCleanupResponse};

#[cfg(any(test, feature = "binding-test-harness"))]
use crate::replica::PlanResult;
use crate::{
    auth_http::{AuthClientConfig, AuthHttpClient},
    authentication::{authenticate, AuthenticationInput, VerifiedAuthentication},
    authentication_installation::{
        prepare_authenticated_installation, prepare_quick_unlock, unwrap_master_unlock_key,
        AuthenticationInstallationEvidence, Clock, InstallationEntropy, PreparedQuickUnlock,
        SystemClock, SystemInstallationEntropy,
    },
    device_timer::{DeviceTimer, SystemDeviceTimer},
    http_transport::{HttpTransport, SerializedHttpExecutor},
    platform_storage::{
        DeviceCatalogAccount, DeviceCatalogDocument, DeviceKeyDocument,
        PendingAccountInstallIntent, PlatformStorage, SerializedPlatformStorageExecutor,
    },
    replica::{
        AuthorityVaultRole, AuthorityVaultType, GuardedCommitPlan, InMemoryReplica, OperationKind,
        OperationOutcomeResult, OperationRecord, PlanMutation, RecomputedPlanResult, Replica,
        ReplicaItemRecord, ReplicaPersistence, ReplicaSnapshot, SerializedReplicaExecutor,
        SerializedReplicaPersistence,
    },
    AccountAccessState, AccountDisplayIdentity, AccountId, AccountStatus, AccountWaitingReason,
    ItemProjection, ItemProjectionStatus, ItemsProjection, ObservationRequest, ObservationSink,
    PendingShareResult, PendingShareResultsProjection, PreparedVaultImage, RequestCancellation,
    RuntimeError, RuntimeErrorCode, RuntimeProjection, RuntimeRequest, RuntimeResponse,
    RuntimeStatusProjection, TeardownPhase, TeardownScope, TeardownStatus, VaultImageIngressFacade,
    VaultImageSourceGrant, VaultProjection, VaultProjectionRole, VaultProjectionType,
    WritableVaultCatalogProjection, WritableVaultProjection,
};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    thread::ThreadId,
};
use zeroize::{Zeroize, Zeroizing};

#[derive(serde::Deserialize, Zeroize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecryptedShareCapability {
    token: String,
    share_key: String,
}

thread_local! {
    static ACTIVE_RUNTIME_DELIVERIES: RefCell<HashMap<usize, usize>> = RefCell::new(HashMap::new());
}

struct ActiveRuntimeDelivery {
    runtime_identity: usize,
}

impl ActiveRuntimeDelivery {
    fn enter(runtime_identity: usize) -> Self {
        ACTIVE_RUNTIME_DELIVERIES.with(|deliveries| {
            *deliveries.borrow_mut().entry(runtime_identity).or_insert(0) += 1;
        });
        Self { runtime_identity }
    }

    fn is_active(runtime_identity: usize) -> bool {
        ACTIVE_RUNTIME_DELIVERIES.with(|deliveries| {
            deliveries
                .borrow()
                .get(&runtime_identity)
                .is_some_and(|depth| *depth > 0)
        })
    }
}

impl Drop for ActiveRuntimeDelivery {
    fn drop(&mut self) {
        ACTIVE_RUNTIME_DELIVERIES.with(|deliveries| {
            let mut deliveries = deliveries.borrow_mut();
            let depth = deliveries
                .get_mut(&self.runtime_identity)
                .expect("active Runtime delivery depth must exist");
            *depth -= 1;
            if *depth == 0 {
                deliveries.remove(&self.runtime_identity);
            }
        });
    }
}

#[derive(Clone, PartialEq, Eq)]
struct DeliveryGeneration {
    incarnation: crate::protocol::Incarnation,
    epoch: u64,
}

#[derive(Clone)]
struct AccountPresentation {
    identity: AccountDisplayIdentity,
    native_only: bool,
    // Display-only copy of durable Account metadata; never consulted for authority or admission.
    verified_travel_mode: Option<crate::platform_storage::VerifiedTravelModePolicy>,
}

#[cfg(test)]
impl From<AccountDisplayIdentity> for AccountPresentation {
    fn from(identity: AccountDisplayIdentity) -> Self {
        Self {
            identity,
            native_only: false,
            verified_travel_mode: None,
        }
    }
}

struct LiveMasterUnlockKey(Zeroizing<[u8; 32]>, Option<String>);

#[derive(Clone, Copy)]
struct RecoveryAccountStatus {
    replica_revision: u64,
}

impl LiveMasterUnlockKey {
    #[cfg(any(test, feature = "binding-test-harness"))]
    fn new(value: Zeroizing<[u8; 32]>) -> Self {
        Self(value, None)
    }

    fn with_private_key(value: Zeroizing<[u8; 32]>, encrypted_private_key: Option<String>) -> Self {
        Self(value, encrypted_private_key)
    }

    fn copy_material(&self) -> vault_key::VaultKeyMaterial {
        vault_key::VaultKeyMaterial {
            master_unlock_key: self.copy_bytes(),
            encrypted_private_key: self.1.clone(),
        }
    }

    fn copy_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(*self.0)
    }
}

impl Drop for LiveMasterUnlockKey {
    fn drop(&mut self) {
        self.0.zeroize();
        #[cfg(test)]
        if self.0.iter().all(|byte| *byte == 0) {
            LIVE_MASTER_UNLOCK_KEY_DROPS_AFTER_ZEROIZE.with(|drops| drops.set(drops.get() + 1));
        }
    }
}

#[cfg(test)]
thread_local! {
    static LIVE_MASTER_UNLOCK_KEY_DROPS_AFTER_ZEROIZE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn take_zeroized_live_master_unlock_key_drops() -> usize {
    LIVE_MASTER_UNLOCK_KEY_DROPS_AFTER_ZEROIZE.with(|drops| drops.replace(0))
}

struct DeliveryToken {
    state: Mutex<DeliveryTokenState>,
    finished: Condvar,
    finished_async: tokio::sync::Notify,
}

struct DeliveryTokenState {
    invalidated: bool,
    admission_paused: bool,
    active: HashMap<ThreadId, usize>,
}

impl DeliveryToken {
    fn new() -> Self {
        Self {
            state: Mutex::new(DeliveryTokenState {
                invalidated: false,
                admission_paused: false,
                active: HashMap::new(),
            }),
            finished: Condvar::new(),
            finished_async: tokio::sync::Notify::new(),
        }
    }

    fn begin(self: &Arc<Self>) -> Option<DeliveryLease> {
        let thread = std::thread::current().id();
        let mut state = self.state.lock().expect("delivery token lock poisoned");
        if state.invalidated || state.admission_paused {
            return None;
        }
        *state.active.entry(thread).or_insert(0) += 1;
        Some(DeliveryLease {
            token: Arc::clone(self),
            thread,
        })
    }

    fn pause_admission(&self, paused: bool) {
        let mut state = self.state.lock().expect("delivery token lock poisoned");
        if !state.invalidated {
            state.admission_paused = paused;
        }
    }

    fn invalidate(&self) {
        self.state
            .lock()
            .expect("delivery token lock poisoned")
            .invalidated = true;
    }

    fn wait_for_other_threads(&self) {
        let current = std::thread::current().id();
        let mut state = self.state.lock().expect("delivery token lock poisoned");
        while state
            .active
            .iter()
            .any(|(thread, depth)| *thread != current && *depth > 0)
        {
            state = self
                .finished
                .wait(state)
                .expect("delivery token lock poisoned while invalidating");
        }
    }

    async fn wait_for_other_threads_async(&self) {
        // Keep the reentrant caller's thread identity even if the suspended future moves threads.
        let current = std::thread::current().id();
        loop {
            let notified = self.finished_async.notified();
            tokio::pin!(notified);
            // Register before reading active leases so their final drop cannot lose our wakeup.
            notified.as_mut().enable();
            let has_other_threads = self
                .state
                .lock()
                .expect("delivery token lock poisoned")
                .active
                .iter()
                .any(|(thread, depth)| *thread != current && *depth > 0);
            if !has_other_threads {
                return;
            }
            notified.await;
        }
    }
}

struct DeliveryLease {
    token: Arc<DeliveryToken>,
    thread: ThreadId,
}

impl Drop for DeliveryLease {
    fn drop(&mut self) {
        let mut state = self
            .token
            .state
            .lock()
            .expect("delivery token lock poisoned");
        let depth = state
            .active
            .get_mut(&self.thread)
            .expect("delivery lease depth must exist");
        *depth -= 1;
        if *depth == 0 {
            state.active.remove(&self.thread);
        }
        drop(state);
        self.token.finished.notify_all();
        self.token.finished_async.notify_waiters();
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct DeliveryRevision {
    // A newer dependency capture must precede comparison of the source's own revision.
    dependency_revision: Option<u64>,
    projection_revision: u64,
}

struct ProjectedDelivery {
    projection: RuntimeProjection,
    generation: Option<DeliveryGeneration>,
    dependency_revision: Option<u64>,
    tokens: Vec<Arc<DeliveryToken>>,
}

struct QueuedDelivery {
    generation: Option<DeliveryGeneration>,
    projection: RuntimeProjection,
    dependency_revision: Option<u64>,
    tokens: Vec<Arc<DeliveryToken>>,
    foreground_attachment: Option<foreground_attachment_lifecycle::ForegroundAttachmentPublication>,
}

struct Subscription {
    request: ObservationRequest,
    sink: Arc<dyn ObservationSink>,
    vault_export: Mutex<Option<vault_export::VaultExportLifetime>>,
    delivery: Mutex<DeliveryState>,
    delivery_finished: Condvar,
    runtime_identity: usize,
}

#[derive(Default)]
struct DeliveryState {
    closed: bool,
    delivering_thread: Option<ThreadId>,
    foreground_delivery: bool,
    last_queued: Option<(
        Option<DeliveryGeneration>,
        DeliveryRevision,
        Vec<Arc<DeliveryToken>>,
    )>,
    queue: VecDeque<QueuedDelivery>,
}

struct DeliveryGuard<'a> {
    subscription: &'a Subscription,
    armed: bool,
}

impl DeliveryGuard<'_> {
    fn finish(&mut self, delivery: &mut DeliveryState) {
        delivery.delivering_thread = None;
        delivery.foreground_delivery = false;
        self.subscription.delivery_finished.notify_all();
        self.armed = false;
    }
}

impl Drop for DeliveryGuard<'_> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut delivery = self
            .subscription
            .delivery
            .lock()
            .expect("observation delivery lock poisoned");
        delivery.delivering_thread = None;
        delivery.foreground_delivery = false;
        self.subscription.delivery_finished.notify_all();
    }
}

impl Subscription {
    fn forget_refused_delivery(&self, refused: QueuedDelivery) {
        let refused_revision = DeliveryRevision {
            dependency_revision: refused.dependency_revision,
            projection_revision: refused.projection.revision(),
        };
        let mut delivery = self
            .delivery
            .lock()
            .expect("observation delivery lock poisoned");
        if delivery
            .last_queued
            .as_ref()
            .is_some_and(|(generation, revision, tokens)| {
                generation == &refused.generation
                    && *revision == refused_revision
                    && tokens.len() == refused.tokens.len()
                    && tokens
                        .iter()
                        .zip(&refused.tokens)
                        .all(|(left, right)| Arc::ptr_eq(left, right))
            })
        {
            delivery.last_queued = None;
        }
        drop(delivery);
        if matches!(&refused.projection, RuntimeProjection::VaultExport(_)) {
            if let Some(runtime) = self.restore_export_delivery(refused) {
                // A resume may already have published while this exact frame was in flight.
                runtime.publish_vault_export_snapshot(self);
            }
        }
    }

    fn new(
        request: ObservationRequest,
        sink: Arc<dyn ObservationSink>,
        runtime_identity: usize,
    ) -> Self {
        Self {
            request,
            sink,
            vault_export: Mutex::new(None),
            delivery: Mutex::new(DeliveryState::default()),
            delivery_finished: Condvar::new(),
            runtime_identity,
        }
    }

    fn publish(&self, projected: ProjectedDelivery) {
        self.publish_with_foreground_attachment(projected, None);
    }

    fn publish_with_foreground_attachment(
        &self,
        projected: ProjectedDelivery,
        foreground_attachment: Option<
            foreground_attachment_lifecycle::ForegroundAttachmentPublication,
        >,
    ) {
        let revision = DeliveryRevision {
            dependency_revision: projected.dependency_revision,
            projection_revision: projected.projection.revision(),
        };
        let current_thread = std::thread::current().id();
        {
            let mut delivery = self
                .delivery
                .lock()
                .expect("observation delivery lock poisoned");
            if delivery.closed {
                return;
            }
            if delivery
                .last_queued
                .as_ref()
                .is_some_and(|(generation, last, tokens)| {
                    generation == &projected.generation
                        && revision <= *last
                        && tokens.len() == projected.tokens.len()
                        && tokens
                            .iter()
                            .zip(&projected.tokens)
                            .all(|(left, right)| Arc::ptr_eq(left, right))
                })
            {
                return;
            }
            delivery.last_queued = Some((
                projected.generation.clone(),
                revision,
                projected.tokens.clone(),
            ));
            delivery.queue.push_back(QueuedDelivery {
                generation: projected.generation,
                projection: projected.projection,
                dependency_revision: projected.dependency_revision,
                tokens: projected.tokens,
                foreground_attachment,
            });
            if delivery.delivering_thread.is_some() {
                return;
            }
            delivery.delivering_thread = Some(current_thread);
        }

        let mut delivery_guard = DeliveryGuard {
            subscription: self,
            armed: true,
        };
        loop {
            let next = {
                let mut delivery = self
                    .delivery
                    .lock()
                    .expect("observation delivery lock poisoned");
                if delivery.closed {
                    delivery.queue.clear();
                    delivery_guard.finish(&mut delivery);
                    return;
                }
                let Some(next) = delivery.queue.pop_front() else {
                    delivery_guard.finish(&mut delivery);
                    return;
                };
                // Lifecycle may close a foreground subscription as soon as callback begin wins;
                // unlike ordinary deliveries, it must not wait for that copied host payload.
                delivery.foreground_delivery = next.foreground_attachment.is_some();
                next
            };
            // Test gates precede every admission loan so lifecycle can complete while a test
            // holds the boundary. Production admission below contains no await or host callback.
            #[cfg(test)]
            if let Some(publication) = &next.foreground_attachment {
                publication.before_admission();
            }
            let Some(leases) = next
                .tokens
                .iter()
                .map(|token| token.begin())
                .collect::<Option<Vec<_>>>()
            else {
                self.forget_refused_delivery(next);
                continue;
            };
            let _leases = if let Some(publication) = &next.foreground_attachment {
                if !publication.begin() {
                    self.forget_refused_delivery(next);
                    continue;
                }
                // Every Account represented in this projection has admitted delivery. The
                // foreground callback then owns copied data; lifecycle never drains host code.
                drop(leases);
                Vec::new()
            } else {
                leases
            };
            let _active_delivery = ActiveRuntimeDelivery::enter(self.runtime_identity);
            self.sink.publish(next.projection);
            self.mark_export_snapshot_delivered();
        }
    }

    fn close(&self) {
        self.close_with_foreground_ownership(false);
    }

    fn close_for_lifecycle(&self) {
        self.close_with_foreground_ownership(true);
    }

    fn close_with_foreground_ownership(&self, foreground_owns_payload: bool) {
        let current_thread = std::thread::current().id();
        let mut delivery = self
            .delivery
            .lock()
            .expect("observation delivery lock poisoned");
        delivery.closed = true;
        delivery.queue.clear();
        while delivery
            .delivering_thread
            .is_some_and(|owner| owner != current_thread)
            && !(foreground_owns_payload && delivery.foreground_delivery)
        {
            delivery = self
                .delivery_finished
                .wait(delivery)
                .expect("observation delivery lock poisoned while closing");
        }
    }
}

pub(in crate::runtime) struct PreparedForegroundAttachmentPublications {
    deliveries: Vec<(Arc<Subscription>, ProjectedDelivery)>,
}

impl PreparedForegroundAttachmentPublications {
    pub(in crate::runtime) fn publish(
        self,
        admission: foreground_attachment_lifecycle::ForegroundAttachmentPublication,
    ) {
        for (subscription, projection) in self.deliveries {
            subscription.publish_with_foreground_attachment(projection, Some(admission.clone()));
        }
    }
}

type ItemMutationLocks = HashMap<(AccountId, String), Arc<tokio::sync::Mutex<()>>>;

pub struct Runtime {
    replica: Arc<Replica>,
    platform_storage: Arc<PlatformStorage>,
    http_transport: Arc<HttpTransport>,
    auth_client_config: Option<AuthClientConfig>,
    #[cfg(test)]
    test_persistence: Option<Arc<InMemoryReplica>>,
    observers: Mutex<HashMap<u64, Arc<Subscription>>>,
    next_observer_id: AtomicU64,
    device_revision: AtomicU64,
    closed: AtomicBool,
    storage_recovery: recovery::StorageRecovery,
    ready: AtomicBool,
    close_complete: AtomicBool,
    close_state_cleaned: AtomicBool,
    close_finished: tokio::sync::Notify,
    catalog_transition: tokio::sync::Mutex<()>,
    profile_admission: Mutex<crate::profile_admission::ProfileAdmissionStartup>,
    profile_admission_cleanup_status: Mutex<Option<crate::protocol::ProfileAdmissionCleanupStatus>>,
    publication: Mutex<()>,
    unlocked_items: Mutex<HashMap<AccountId, Vec<ItemProjection>>>,
    live_master_unlock_keys:
        Arc<Mutex<HashMap<(AccountId, crate::protocol::Incarnation), LiveMasterUnlockKey>>>,
    account_access: Mutex<HashMap<AccountId, AccountAccessState>>,
    account_display_identities: Mutex<HashMap<AccountId, AccountPresentation>>,
    recovery_accounts: Mutex<HashMap<AccountId, RecoveryAccountStatus>>,
    account_lock_epochs: Mutex<HashMap<AccountId, u64>>,
    lock_epoch_pending: Mutex<HashMap<AccountId, u64>>,
    account_access_retirement_intents: Mutex<HashMap<AccountId, Arc<Mutex<usize>>>>,
    #[cfg(test)]
    before_plaintext_commit: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    waiting_reasons: Mutex<HashMap<AccountId, AccountWaitingReason>>,
    delivery_tokens: Mutex<HashMap<AccountId, (DeliveryGeneration, Arc<DeliveryToken>)>>,
    account_execution_locks: Mutex<HashMap<AccountId, Arc<tokio::sync::Mutex<()>>>>,
    account_lifecycle_locks: Mutex<HashMap<AccountId, Arc<tokio::sync::Mutex<()>>>>,
    item_mutation_locks: Mutex<ItemMutationLocks>,
    foreground_attachments: foreground_attachment_lifecycle::ForegroundAttachmentRegistry,
    attachment_download: Mutex<Option<AttachmentDownloadFacade>>,
    attachment_upload: Mutex<Option<AttachmentUploadFacade>>,
    vault_image_ingress: Mutex<Option<VaultImageIngressFacade>>,
    pending_vault_image_acceptance_cleanup: Mutex<HashSet<(AccountId, String)>>,
    create_vault_cleanup_port: Mutex<Option<Arc<dyn create_vault_cleanup::CreateVaultCleanupPort>>>,
    create_vault_cleanup_retry_deadlines: Mutex<HashMap<(AccountId, String), u64>>,
    #[cfg(feature = "binding-test-harness")]
    create_vault_binding_pause_checkpoint: Mutex<Option<crate::replica::CreateVaultCheckpoint>>,
    biometric: biometric::BiometricState,
    native_authority: native_authority::NativeAuthorityState,
    inactivity: inactivity::InactivityState,
    account_refresh_active: AtomicBool,
    clock: Arc<dyn Clock>,
    device_timer: Arc<dyn DeviceTimer>,
    /// Wakes the dispatcher when something that can change eligibility happened: work was
    /// accepted, a Session arrived, or the Runtime is closing.
    dispatch_wake: tokio::sync::Notify,
    live_sync_wake: tokio::sync::Notify,
    live_sync_active: AtomicBool,
    dispatch_leases: Arc<DispatchLeases>,
    attachment_move_scheduler: Mutex<Option<Arc<AttachmentMovePreparationScheduler>>>,
    attachment_move_lifecycle: Mutex<Option<Arc<AttachmentMoveLifecycle>>>,
    attachment_move_lifecycle_active: AtomicBool,
    attachment_move_account_cursor: AtomicU64,
    teardown_admission: tokio::sync::RwLock<()>,
    teardown_host_cleanup: Mutex<Arc<dyn TeardownHostCleanup>>,
    pending_teardown: Mutex<teardown::PendingTeardown>,
}

struct AttachmentMoveLifecycleLease {
    runtime: Arc<Runtime>,
}

impl AttachmentMoveLifecycleLease {
    fn acquire(runtime: &Arc<Runtime>) -> Result<Self, RuntimeError> {
        runtime
            .attachment_move_lifecycle_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "Attachment Move preparation lifecycle is already running",
                )
            })?;
        Ok(Self {
            runtime: Arc::clone(runtime),
        })
    }
}

impl Drop for AttachmentMoveLifecycleLease {
    fn drop(&mut self) {
        self.runtime
            .attachment_move_lifecycle_active
            .store(false, Ordering::SeqCst);
    }
}

impl Runtime {
    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "WASM is single-threaded, while Arc keeps the Runtime lifetime identical across bindings"
        )
    )]
    pub fn new() -> Arc<Self> {
        let in_memory = Arc::new(InMemoryReplica::default());
        let persistence: Arc<dyn ReplicaPersistence> = in_memory.clone();
        Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::unavailable()),
            Arc::new(HttpTransport::unavailable()),
            None,
            None,
            true,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            #[cfg(test)]
            Some(in_memory),
        )
    }

    #[doc(hidden)]
    #[inline]
    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "the serialized Web executor and Runtime share one single-threaded Worker"
        )
    )]
    pub fn with_serialized_replica_executor(
        executor: Arc<dyn SerializedReplicaExecutor>,
    ) -> Arc<Self> {
        let persistence: Arc<dyn ReplicaPersistence> =
            Arc::new(SerializedReplicaPersistence::new(executor));
        Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::unavailable()),
            Arc::new(HttpTransport::unavailable()),
            None,
            None,
            true,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            #[cfg(test)]
            None,
        )
    }

    #[doc(hidden)]
    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "the serialized Web executors and Runtime share one single-threaded Worker"
        )
    )]
    pub fn with_serialized_executors(
        replica: Arc<dyn SerializedReplicaExecutor>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        http: Arc<dyn SerializedHttpExecutor>,
    ) -> Arc<Self> {
        Self::with_serialized_executors_and_optional_auth_config(replica, platform, http, None)
    }

    /// Keeps authentication identity on the Runtime instance. Production bindings deliberately
    /// pass a configuration only when their host-specific wiring slice lands.
    fn with_serialized_executors_and_optional_auth_config(
        replica: Arc<dyn SerializedReplicaExecutor>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        http: Arc<dyn SerializedHttpExecutor>,
        auth_config: Option<AuthClientConfig>,
    ) -> Arc<Self> {
        let persistence: Arc<dyn ReplicaPersistence> =
            Arc::new(SerializedReplicaPersistence::new(replica));
        let platform_storage = PlatformStorage::for_platform(
            platform,
            auth_config
                .as_ref()
                .map_or(crate::ClientPlatform::Web, |config| config.platform),
        );
        Self::with_persistence(
            persistence,
            Arc::new(platform_storage),
            Arc::new(HttpTransport::new(http)),
            auth_config,
            None,
            false,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            #[cfg(test)]
            None,
        )
    }

    /// Builds a Runtime whose wall clock and delay are the test's, so dispatch scheduling can be
    /// asserted exactly instead of waited on.
    #[cfg(test)]
    pub(crate) fn with_test_dispatch_environment(
        replica: Arc<dyn SerializedReplicaExecutor>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        http: Arc<dyn SerializedHttpExecutor>,
        auth_config: AuthClientConfig,
        clock: Arc<dyn Clock>,
        device_timer: Arc<dyn DeviceTimer>,
    ) -> Arc<Self> {
        Self::with_persistence(
            Arc::new(SerializedReplicaPersistence::new(replica)),
            Arc::new(PlatformStorage::for_platform(
                platform,
                auth_config.platform,
            )),
            Arc::new(HttpTransport::new(http)),
            Some(auth_config),
            None,
            true,
            clock,
            device_timer,
            None,
        )
    }

    #[cfg(test)]
    pub(crate) fn with_test_preparation_environment(
        persistence: Arc<InMemoryReplica>,
        driver: Arc<dyn AttachmentMovePreparationDriver>,
        clock: Arc<dyn Clock>,
        device_timer: Arc<dyn DeviceTimer>,
    ) -> Arc<Self> {
        Self::with_test_preparation_lifecycle_environment(
            persistence,
            driver,
            Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
            Arc::new(attachment_move_lifecycle::TestArtifactStore),
            clock,
            device_timer,
        )
    }

    #[cfg(test)]
    pub(crate) fn with_test_preparation_lifecycle_environment(
        persistence: Arc<InMemoryReplica>,
        driver: Arc<dyn AttachmentMovePreparationDriver>,
        lease_port: Arc<dyn AttachmentMoveAccountLeasePort>,
        artifacts: Arc<dyn crate::attachment_artifact_store::AttachmentArtifactStore>,
        clock: Arc<dyn Clock>,
        device_timer: Arc<dyn DeviceTimer>,
    ) -> Arc<Self> {
        let replica_persistence: Arc<dyn ReplicaPersistence> = persistence.clone();
        let runtime = Self::with_persistence(
            replica_persistence,
            Arc::new(PlatformStorage::unavailable()),
            Arc::new(HttpTransport::unavailable()),
            None,
            None,
            true,
            clock,
            device_timer,
            Some(persistence),
        );
        *runtime
            .attachment_move_scheduler
            .lock()
            .expect("Attachment Move scheduler lock poisoned") = Some(Arc::new(
            AttachmentMovePreparationScheduler::new_for_test(driver),
        ));
        *runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") = Some(Arc::new(
            AttachmentMoveLifecycle::new(lease_port, artifacts),
        ));
        runtime
    }

    #[cfg(test)]
    pub(crate) fn with_test_teardown_environment(
        persistence: Arc<dyn ReplicaPersistence>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        artifacts: Arc<dyn crate::attachment_artifact_store::AttachmentArtifactStore>,
        cleanup: Arc<dyn TeardownHostCleanup>,
    ) -> Arc<Self> {
        let runtime = Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::new(platform)),
            Arc::new(HttpTransport::unavailable()),
            Some(
                AuthClientConfig::new("test-client".into(), crate::ClientPlatform::Web, "1".into())
                    .expect("test auth config is valid"),
            ),
            None,
            true,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            None,
        );
        *runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                artifacts,
            )));
        runtime.install_teardown_host_cleanup(cleanup);
        runtime
    }

    #[cfg(test)]
    pub(crate) fn restart_test_teardown_environment(
        persistence: Arc<dyn ReplicaPersistence>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        artifacts: Arc<dyn crate::attachment_artifact_store::AttachmentArtifactStore>,
        cleanup: Arc<dyn TeardownHostCleanup>,
    ) -> Arc<Self> {
        let runtime = Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::new(platform)),
            Arc::new(HttpTransport::unavailable()),
            None,
            None,
            false,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            None,
        );
        *runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                artifacts,
            )));
        runtime.install_teardown_host_cleanup(cleanup);
        runtime
    }

    #[doc(hidden)]
    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "the configured Web executors and Runtime share one single-threaded Worker"
        )
    )]
    pub fn with_configured_serialized_executors(
        replica: Arc<dyn SerializedReplicaExecutor>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        http: Arc<dyn SerializedHttpExecutor>,
        auth_config: AuthClientConfig,
    ) -> Arc<Self> {
        Self::with_serialized_executors_and_optional_auth_config(
            replica,
            platform,
            http,
            Some(auth_config),
        )
    }

    #[doc(hidden)]
    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "the configured Web preparation ports and Runtime share one single-threaded Worker"
        )
    )]
    pub fn with_configured_serialized_executors_and_attachment_move_preparation(
        replica: Arc<dyn SerializedReplicaExecutor>,
        platform: Arc<dyn SerializedPlatformStorageExecutor>,
        http: Arc<dyn SerializedHttpExecutor>,
        auth_config: AuthClientConfig,
        preparation: AttachmentMovePreparationFacade,
        lease_port: Arc<dyn AttachmentMoveAccountLeasePort>,
    ) -> Arc<Self> {
        let persistence: Arc<dyn ReplicaPersistence> =
            Arc::new(SerializedReplicaPersistence::new(replica));
        Self::with_persistence(
            persistence,
            Arc::new(PlatformStorage::for_platform(
                platform,
                auth_config.platform,
            )),
            Arc::new(HttpTransport::new(http)),
            Some(auth_config),
            Some((preparation, lease_port)),
            false,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            #[cfg(test)]
            None,
        )
    }

    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "the Web Runtime is confined to one Worker, while Arc preserves shared binding ownership"
        )
    )]
    #[allow(
        clippy::too_many_arguments,
        reason = "one private constructor owns every Runtime port, including the Device clock and timer"
    )]
    fn with_persistence(
        persistence: Arc<dyn ReplicaPersistence>,
        platform_storage: Arc<PlatformStorage>,
        http_transport: Arc<HttpTransport>,
        auth_client_config: Option<AuthClientConfig>,
        attachment_move_preparation: Option<(
            AttachmentMovePreparationFacade,
            Arc<dyn AttachmentMoveAccountLeasePort>,
        )>,
        ready: bool,
        clock: Arc<dyn Clock>,
        device_timer: Arc<dyn DeviceTimer>,
        #[cfg(test)] test_persistence: Option<Arc<InMemoryReplica>>,
    ) -> Arc<Self> {
        let replica = Arc::new(Replica::new(persistence));
        let live_master_unlock_keys = Arc::new(Mutex::new(HashMap::new()));
        let runtime = Arc::new(Self {
            replica,
            platform_storage,
            http_transport,
            auth_client_config,
            #[cfg(test)]
            test_persistence,
            observers: Mutex::new(HashMap::new()),
            next_observer_id: AtomicU64::new(1),
            device_revision: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            storage_recovery: recovery::StorageRecovery::default(),
            ready: AtomicBool::new(ready),
            close_complete: AtomicBool::new(false),
            close_state_cleaned: AtomicBool::new(false),
            close_finished: tokio::sync::Notify::new(),
            catalog_transition: tokio::sync::Mutex::new(()),
            profile_admission: Mutex::new(Default::default()),
            profile_admission_cleanup_status: Mutex::new(None),
            publication: Mutex::new(()),
            unlocked_items: Mutex::new(HashMap::new()),
            live_master_unlock_keys,
            account_access: Mutex::new(HashMap::new()),
            account_display_identities: Mutex::new(HashMap::new()),
            recovery_accounts: Mutex::new(HashMap::new()),
            account_lock_epochs: Mutex::new(HashMap::new()),
            lock_epoch_pending: Mutex::new(HashMap::new()),
            account_access_retirement_intents: Mutex::new(HashMap::new()),
            #[cfg(test)]
            before_plaintext_commit: Mutex::new(None),
            waiting_reasons: Mutex::new(HashMap::new()),
            delivery_tokens: Mutex::new(HashMap::new()),
            account_execution_locks: Mutex::new(HashMap::new()),
            account_lifecycle_locks: Mutex::new(HashMap::new()),
            item_mutation_locks: Mutex::new(HashMap::new()),
            foreground_attachments:
                foreground_attachment_lifecycle::ForegroundAttachmentRegistry::default(),
            attachment_download: Mutex::new(None),
            attachment_upload: Mutex::new(None),
            vault_image_ingress: Mutex::new(None),
            pending_vault_image_acceptance_cleanup: Mutex::new(HashSet::new()),
            create_vault_cleanup_port: Mutex::new(None),
            create_vault_cleanup_retry_deadlines: Mutex::new(HashMap::new()),
            #[cfg(feature = "binding-test-harness")]
            create_vault_binding_pause_checkpoint: Mutex::new(None),
            clock,
            device_timer,
            dispatch_wake: tokio::sync::Notify::new(),
            live_sync_wake: tokio::sync::Notify::new(),
            live_sync_active: AtomicBool::new(false),
            dispatch_leases: Arc::new(DispatchLeases::default()),
            attachment_move_scheduler: Mutex::new(None),
            biometric: biometric::BiometricState::default(),
            native_authority: native_authority::NativeAuthorityState::default(),
            inactivity: inactivity::InactivityState::default(),
            account_refresh_active: AtomicBool::new(false),
            attachment_move_lifecycle: Mutex::new(None),
            attachment_move_lifecycle_active: AtomicBool::new(false),
            attachment_move_account_cursor: AtomicU64::new(0),
            teardown_admission: tokio::sync::RwLock::new(()),
            teardown_host_cleanup: Mutex::new(Arc::new(teardown::UnavailableTeardownHostCleanup)),
            pending_teardown: Mutex::new(teardown::PendingTeardown::default()),
        });
        if let Some((facade, lease_port)) = attachment_move_preparation {
            runtime.install_attachment_move_preparation_with_lease(facade, lease_port);
        }
        runtime
    }

    #[cfg(test)]
    fn install_attachment_move_preparation(
        self: &Arc<Self>,
        facade: AttachmentMovePreparationFacade,
    ) {
        self.install_attachment_move_preparation_with_lease(
            facade,
            Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
        );
    }

    fn install_attachment_move_preparation_with_lease(
        self: &Arc<Self>,
        facade: AttachmentMovePreparationFacade,
        lease_port: Arc<dyn AttachmentMoveAccountLeasePort>,
    ) {
        let lifecycle = Arc::new(AttachmentMoveLifecycle::new(lease_port, facade.artifacts()));
        let scheduler = Arc::new(AttachmentMovePreparationScheduler::new(
            Arc::clone(&self.replica),
            Arc::clone(&self.live_master_unlock_keys),
            facade,
            Arc::downgrade(self),
        ));
        *self
            .attachment_move_scheduler
            .lock()
            .expect("Attachment Move scheduler lock poisoned") = Some(scheduler);
        *self
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") = Some(lifecycle);
    }

    /// Installs the host-owned ciphertext-spool cleanup primitive. Runtime policy remains in Rust.
    #[doc(hidden)]
    pub fn install_teardown_host_cleanup(&self, cleanup: Arc<dyn TeardownHostCleanup>) {
        *self
            .teardown_host_cleanup
            .lock()
            .expect("teardown host cleanup lock poisoned") = cleanup;
    }

    #[doc(hidden)]
    pub fn install_attachment_download(&self, facade: AttachmentDownloadFacade) {
        *self
            .attachment_download
            .lock()
            .expect("Attachment Download facade lock poisoned") = Some(facade);
    }

    #[doc(hidden)]
    pub fn install_attachment_upload(&self, facade: AttachmentUploadFacade) {
        *self
            .attachment_upload
            .lock()
            .expect("Attachment Upload facade lock poisoned") = Some(facade);
    }

    #[doc(hidden)]
    pub fn install_vault_image_ingress(&self, facade: VaultImageIngressFacade) {
        *self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned") = Some(facade);
    }

    #[cfg(test)]
    pub(crate) fn install_create_vault_cleanup_port(
        &self,
        port: Arc<dyn create_vault_cleanup::CreateVaultCleanupPort>,
    ) {
        *self
            .create_vault_cleanup_port
            .lock()
            .expect("create-Vault cleanup port lock poisoned") = Some(port);
    }

    #[doc(hidden)]
    pub async fn prepare_vault_image(
        &self,
        grant: VaultImageSourceGrant,
        cancellation: RequestCancellation,
    ) -> Result<PreparedVaultImage, RuntimeError> {
        self.ensure_open()?;
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "Vault image ingress is unavailable",
                )
            })?;
        facade.prepare(grant, &cancellation).await
    }

    #[doc(hidden)]
    pub async fn begin_vault_image_acceptance(
        &self,
        account_id: &AccountId,
        operation_id: &str,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "Vault image ingress is unavailable",
                )
            })?;
        facade.begin_acceptance(account_id, operation_id).await
    }

    #[doc(hidden)]
    pub async fn end_vault_image_acceptance(
        &self,
        account_id: &AccountId,
        operation_id: &str,
    ) -> Result<(), RuntimeError> {
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "Vault image ingress is unavailable",
                )
            })?;
        facade.end_acceptance(account_id, operation_id).await
    }

    async fn finish_vault_image_acceptance_cleanup(
        &self,
        account_id: &AccountId,
        operation_id: &str,
    ) {
        let identity = (account_id.clone(), operation_id.to_owned());
        if self
            .end_vault_image_acceptance(account_id, operation_id)
            .await
            .is_ok()
        {
            self.pending_vault_image_acceptance_cleanup
                .lock()
                .expect("Vault image acceptance cleanup lock poisoned")
                .remove(&identity);
        } else {
            self.pending_vault_image_acceptance_cleanup
                .lock()
                .expect("Vault image acceptance cleanup lock poisoned")
                .insert(identity);
        }
    }

    async fn sweep_vault_images_for_snapshot(
        &self,
        snapshot: &crate::replica::ReplicaSnapshot,
    ) -> Result<(), RuntimeError> {
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone();
        let Some(facade) = facade else { return Ok(()) };
        for operation in snapshot
            .operations
            .iter()
            .filter(|operation| operation.vault_image().is_some())
        {
            // Acceptance release belongs to this Runtime's source grant. A restored durable
            // Operation has no handshake in the new owner, even though its image stays live.
            let pending = self
                .pending_vault_image_acceptance_cleanup
                .lock()
                .expect("Vault image acceptance cleanup lock poisoned")
                .contains(&(snapshot.account_id.clone(), operation.operation_id.clone()));
            if pending {
                self.finish_vault_image_acceptance_cleanup(
                    &snapshot.account_id,
                    &operation.operation_id,
                )
                .await;
            }
        }
        let referenced_operations = snapshot
            .operations
            .iter()
            .map(|operation| operation.operation_id.clone())
            .collect();
        facade
            .sweep_account(&snapshot.account_id, &referenced_operations)
            .await
    }

    async fn retire_vault_image_account(&self, account_id: &AccountId) {
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone();
        let Some(facade) = facade else { return };
        let mut failures = 0_u32;
        while facade.retire_account(account_id).await.is_err() {
            self.device_timer.sleep_ms(10_u64 << failures.min(7)).await;
            failures = failures.saturating_add(1);
        }
    }

    async fn complete_vault_image_account_retirement(&self, account_id: &AccountId) {
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone();
        let Some(facade) = facade else { return };
        let mut failures = 0_u32;
        while facade
            .complete_account_retirement(account_id)
            .await
            .is_err()
        {
            self.device_timer.sleep_ms(10_u64 << failures.min(7)).await;
            failures = failures.saturating_add(1);
        }
    }

    async fn retire_all_vault_images(&self) {
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone();
        let Some(facade) = facade else { return };
        let mut failures = 0_u32;
        while facade.retire_runtime().await.is_err() {
            self.device_timer.sleep_ms(10_u64 << failures.min(7)).await;
            failures = failures.saturating_add(1);
        }
    }

    /// Runs the one core-owned preparation scheduler until the Runtime closes.
    ///
    /// Hosts drive this future beside ordinary dispatch after `open`. Restart and unlock state are
    /// read from durable Replica truth on every pass; no accepted preparation lives in this future.
    #[doc(hidden)]
    pub async fn run_attachment_move_preparation(self: Arc<Self>) -> Result<(), RuntimeError> {
        let _lifecycle_lease = AttachmentMoveLifecycleLease::acquire(&self)?;
        let Some(scheduler) = self
            .attachment_move_scheduler
            .lock()
            .expect("Attachment Move scheduler lock poisoned")
            .as_ref()
            .cloned()
        else {
            return Ok(());
        };
        let lifecycle = self
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned")
            .as_ref()
            .cloned()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationUnavailable,
                    "Attachment Move preparation has no exclusive Account lease port",
                )
            })?;
        loop {
            if self.is_closed() {
                return Ok(());
            }
            let mut wake = std::pin::pin!(self.dispatch_wake.notified());
            wake.as_mut().enable();
            if !self.ready.load(Ordering::SeqCst) {
                tokio::select! {
                    () = wake => {}
                    () = self.device_timer.sleep_ms(1) => {}
                }
                continue;
            }
            let now_ms = self.clock.now_ms()?;
            let unlocked_accounts: HashSet<_> = self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .iter()
                .filter(|(account_id, access)| {
                    **access == AccountAccessState::Unlocked
                        && !self.account_access_retirement_is_pending(account_id)
                })
                .map(|(account_id, _)| account_id.clone())
                .collect();
            let snapshots: Vec<_> = self
                .replica
                .snapshots()
                .into_iter()
                .filter(|snapshot| snapshot.failure.is_none())
                .collect();
            let mut candidates: Vec<_> = snapshots
                .iter()
                .flat_map(|snapshot| {
                    snapshot
                        .attachment_move_preparations
                        .iter()
                        .map(move |preparation| PreparationCandidate {
                            account_id: snapshot.account_id.clone(),
                            operation_id: preparation.operation_id.clone(),
                            not_before_ms: preparation.scheduling.not_before_ms,
                        })
                })
                .collect();
            candidates.sort_by(|left, right| {
                left.account_id
                    .as_str()
                    .cmp(right.account_id.as_str())
                    .then_with(|| left.operation_id.cmp(&right.operation_id))
            });
            let mut scheduled_accounts = HashSet::new();
            let mut attempts: Vec<(&ReplicaSnapshot, Option<String>)> = candidates
                .iter()
                .filter(|candidate| {
                    unlocked_accounts.contains(&candidate.account_id)
                        && candidate.not_before_ms <= now_ms
                        && scheduled_accounts.insert(candidate.account_id.clone())
                })
                .filter_map(|candidate| {
                    snapshots
                        .iter()
                        .find(|snapshot| snapshot.account_id == candidate.account_id)
                        .map(|snapshot| (snapshot, Some(candidate.operation_id.clone())))
                })
                .collect();
            attempts.extend(snapshots.iter().filter_map(|snapshot| {
                (unlocked_accounts.contains(&snapshot.account_id)
                    && !scheduled_accounts.contains(&snapshot.account_id)
                    && !lifecycle.has_swept(&snapshot.account_id, &snapshot.incarnation))
                .then_some((snapshot, None))
            }));
            if !attempts.is_empty() {
                let cursor = self
                    .attachment_move_account_cursor
                    .fetch_add(1, Ordering::SeqCst) as usize
                    % attempts.len();
                attempts.rotate_left(cursor);
            }
            let attempted_accounts = !attempts.is_empty();

            let mut pass = None;
            for (snapshot, operation_id) in attempts {
                match lifecycle
                    .run_account(&self, &scheduler, snapshot, operation_id, now_ms)
                    .await?
                {
                    LifecyclePass::LeaseUnavailable => continue,
                    acquired => {
                        pass = Some(acquired);
                        break;
                    }
                }
            }
            let pass = if let Some(pass) = pass {
                pass
            } else if !attempted_accounts {
                let earliest = candidates
                    .iter()
                    .filter(|candidate| unlocked_accounts.contains(&candidate.account_id))
                    .map(|candidate| candidate.not_before_ms)
                    .min();
                match earliest {
                    Some(deadline) => {
                        let milliseconds = deadline.saturating_sub(now_ms).max(1);
                        tokio::select! {
                            () = wake => {}
                            () = self.device_timer.sleep_ms(milliseconds) => {}
                        }
                    }
                    None => wake.await,
                }
                continue;
            } else {
                // Cross-process lease contention is a resource wait, not a transport attempt.
                // A wake remains immediate, while the timer avoids a denied Account hot loop.
                tokio::select! {
                    () = wake => {}
                    () = self.device_timer.sleep_ms(250) => {}
                }
                continue;
            };
            if self.is_closed() {
                return Ok(());
            }
            match pass {
                LifecyclePass::Swept | LifecyclePass::GenerationRetired => continue,
                LifecyclePass::LeaseUnavailable => {
                    unreachable!("unavailable leases are tried fairly")
                }
                LifecyclePass::Driven(SchedulerPass::DispatchReady) => {
                    self.wake_dispatch();
                }
                LifecyclePass::Driven(SchedulerPass::Progressed) => continue,
                LifecyclePass::Driven(SchedulerPass::Parked) => wake.await,
                LifecyclePass::Driven(SchedulerPass::WaitFor { milliseconds }) => {
                    tokio::select! {
                        () = wake => {}
                        () = self.device_timer.sleep_ms(milliseconds) => {}
                    }
                }
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn replica(&self) -> Arc<Replica> {
        Arc::clone(&self.replica)
    }

    #[cfg(test)]
    pub(crate) fn lock_epoch(&self, account_id: &AccountId) -> Option<u64> {
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .get(account_id)
            .copied()
    }

    #[cfg(test)]
    pub(crate) fn lock_epoch_is_pending(&self, account_id: &AccountId) -> bool {
        self.lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .contains_key(account_id)
    }

    #[cfg(test)]
    pub(crate) fn account_access_state(
        &self,
        account_id: &AccountId,
    ) -> Option<AccountAccessState> {
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(account_id)
            .copied()
    }

    #[cfg(test)]
    pub(crate) fn has_live_master_unlock_key(
        &self,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) -> bool {
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .contains_key(&(account_id.clone(), incarnation.clone()))
    }

    pub fn request(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> impl std::future::Future<Output = Result<RuntimeResponse, RuntimeError>> + '_ {
        // Hosts compose many requests in one async task. Keep the dispatcher's largest command
        // future out of every caller's frame while preserving caller-owned polling and cancellation.
        Box::pin(self.request_with_hooks(request, cancellation, || {}, || {}))
    }

    #[cfg(test)]
    pub(crate) async fn request_with_acceptance_hook(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.request_with_hooks(request, cancellation, || {}, accepted)
            .await
    }

    async fn request_with_hooks(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
        before_acceptance: impl FnOnce(),
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        if let RuntimeRequest::QuickUnlockAccounts {
            account_ids,
            master_password,
        } = request
        {
            // Each target polls the single-Account ceremony. Keep batch orchestration
            // outside the ordinary dispatcher's frame.
            return self
                .quick_unlock_accounts(account_ids, Zeroizing::new(master_password), cancellation)
                .await;
        }
        if let RuntimeRequest::QuickUnlock {
            account_id,
            master_password,
        } = request
        {
            // A single-Account ceremony must not poll inside the large ordinary dispatcher.
            return Box::pin(self.quick_unlock_account(
                account_id,
                master_password,
                cancellation,
                None,
                before_acceptance,
                accepted,
            ))
            .await;
        }
        if matches!(&request, RuntimeRequest::SignIn { .. }) {
            // Installation polls outside the large ordinary dispatcher.
            return Box::pin(self.sign_in(request, cancellation, before_acceptance, accepted))
                .await;
        }
        self.request_in_local_scope(request, cancellation, before_acceptance, accepted)
            .await
    }

    async fn request_in_local_scope(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
        _before_acceptance: impl FnOnce(),
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        if matches!(
            &request,
            RuntimeRequest::RebootstrapAccountRecovery { .. }
                | RuntimeRequest::InspectRecovery { .. }
                | RuntimeRequest::ExportAccountRecovery { .. }
                | RuntimeRequest::RepairAccountRecovery { .. }
        ) {
            return self.request_storage_recovery(request, cancellation).await;
        }
        if matches!(
            &request,
            RuntimeRequest::LocalSecuritySettings { .. }
                | RuntimeRequest::SetInactivityTimeout { .. }
                | RuntimeRequest::RecordActivity { .. }
        ) {
            return self.request_local_security(request, cancellation).await;
        }
        if matches!(
            &request,
            RuntimeRequest::BiometricAvailability { .. }
                | RuntimeRequest::SetBiometricEnabled { .. }
                | RuntimeRequest::BiometricUnlock { .. }
                | RuntimeRequest::BiometricUnlockAccounts { .. }
                | RuntimeRequest::SetMasterPasswordReentryPeriod { .. }
        ) {
            return self.request_biometric(request, cancellation).await;
        }
        match &request {
            RuntimeRequest::AbortProfileAdmission { admission_id } => {
                return self
                    .abort_profile_admission(admission_id, &cancellation)
                    .await;
            }
            RuntimeRequest::InspectProfileAdmission {} => {
                return self.inspect_profile_admission().await;
            }
            RuntimeRequest::RemoveAccount { account_id } => {
                return self.remove_account(account_id.clone()).await;
            }
            RuntimeRequest::Wipe => {
                return self.wipe_device().await;
            }
            RuntimeRequest::Lock { account_id } => {
                return self
                    .retire_account_access(account_id, AccessRetirement::Lock)
                    .await
                    .map(|access| RuntimeResponse::AccessChanged {
                        account_id: account_id.clone(),
                        access,
                    });
            }
            RuntimeRequest::SignOut { account_id } => {
                return self
                    .retire_account_access(account_id, AccessRetirement::SignOut)
                    .await
                    .map(|access| RuntimeResponse::AccessChanged {
                        account_id: account_id.clone(),
                        access,
                    });
            }
            _ => {}
        }
        if matches!(
            &request,
            RuntimeRequest::ListItemShareLinks { .. }
                | RuntimeRequest::ListShareAccessLogs { .. }
                | RuntimeRequest::RevokeShareLink { .. }
        ) {
            let teardown_admission = self.teardown_admission.read().await;
            self.reject_request_during_pending_teardown(&request)?;
            return self
                .manage_share(request, cancellation, teardown_admission)
                .await;
        }
        if let RuntimeRequest::RenameAttachment {
            account_id,
            attachment_id,
            name,
        } = &request
        {
            let teardown_admission = self.teardown_admission.read().await;
            self.reject_request_during_pending_teardown(&RuntimeRequest::RenameAttachment {
                account_id: account_id.clone(),
                attachment_id: attachment_id.clone(),
                name: name.clone(),
            })?;
            return self
                .rename_attachment(
                    account_id.clone(),
                    attachment_id.clone(),
                    name.clone(),
                    cancellation,
                    teardown_admission,
                )
                .await;
        }
        if let RuntimeRequest::DeleteAttachment {
            account_id,
            attachment_id,
        } = &request
        {
            let teardown_admission = self.teardown_admission.read().await;
            self.reject_request_during_pending_teardown(&RuntimeRequest::DeleteAttachment {
                account_id: account_id.clone(),
                attachment_id: attachment_id.clone(),
            })?;
            return self
                .delete_attachment(
                    account_id.clone(),
                    attachment_id.clone(),
                    cancellation,
                    teardown_admission,
                )
                .await;
        }
        if let RuntimeRequest::DownloadAttachment {
            account_id,
            attachment_id,
            sink_capability_id,
        } = &request
        {
            let prepared = self.prepare_attachment_download(
                account_id.clone(),
                attachment_id.clone(),
                sink_capability_id.clone(),
                cancellation.clone(),
            )?;
            return self.download_attachment(prepared, cancellation).await;
        }
        if let RuntimeRequest::UploadAttachment {
            account_id,
            item_id,
            name,
            content_type,
            file_size,
            source_capability_id,
        } = &request
        {
            let prepared = self
                .prepare_attachment_upload(
                    attachment::UploadAttachmentRequest {
                        account_id: account_id.clone(),
                        item_id: item_id.clone(),
                        name: name.clone(),
                        content_type: content_type.clone(),
                        file_size: *file_size,
                        source_capability_id: source_capability_id.clone(),
                    },
                    cancellation.clone(),
                )
                .await?;
            return self.upload_attachment(prepared, cancellation).await;
        }
        let _admission = self.teardown_admission.read().await;
        self.reject_request_during_pending_teardown(&request)?;
        match request {
            request @ (RuntimeRequest::PrepareRotation { .. }
            | RuntimeRequest::CompleteRotation { .. }
            | RuntimeRequest::InspectRotation { .. }
            | RuntimeRequest::ListTeamLeaveAttempts { .. }
            | RuntimeRequest::AcknowledgeTeamLeaveAttempt { .. }) => {
                Box::pin(self.request_rotation(request, cancellation)).await
            }
            request @ (RuntimeRequest::ListMyTeamInvitations { .. }
            | RuntimeRequest::AcceptMyTeamInvitation { .. }
            | RuntimeRequest::DeclineMyTeamInvitation { .. }) => {
                self.request_my_team_invitation(request, cancellation).await
            }
            request @ (RuntimeRequest::ReadInvitationComposer { .. }
            | RuntimeRequest::CreateTeamInvitation { .. }
            | RuntimeRequest::ProvisionTeamInvitation { .. }
            | RuntimeRequest::ReleaseInvitationContinuation { .. }
            | RuntimeRequest::CancelTeamInvitation { .. }
            | RuntimeRequest::ResendTeamInvitation { .. }) => {
                self.request_team_invitation(request, cancellation).await
            }
            request @ (RuntimeRequest::ListAvailableVaultMembers { .. }
            | RuntimeRequest::ListVaultMembers { .. }
            | RuntimeRequest::AddVaultMember { .. }) => {
                self.request_vault_membership(request, cancellation).await
            }
            RuntimeRequest::ReadTeamPage { account_id } => {
                self.read_team_page(account_id, cancellation).await
            }
            request @ (RuntimeRequest::RecipientKeyScope { .. }
            | RuntimeRequest::OwnKeyFingerprint { .. }
            | RuntimeRequest::VerifyRecipientKey { .. }
            | RuntimeRequest::VerifiedRecipientKey { .. }) => {
                self.request_recipient_key(request, cancellation).await
            }
            RuntimeRequest::RebootstrapAccountRecovery { .. }
            | RuntimeRequest::InspectRecovery { .. }
            | RuntimeRequest::ExportAccountRecovery { .. }
            | RuntimeRequest::RepairAccountRecovery { .. } => Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "Recovery executor is not installed",
            )),
            RuntimeRequest::SignIn { .. } => {
                unreachable!("Sign-in is handled before ordinary admission")
            }
            RuntimeRequest::LocalSecuritySettings { .. }
            | RuntimeRequest::SetInactivityTimeout { .. }
            | RuntimeRequest::RecordActivity { .. } => {
                unreachable!("Local security is handled before ordinary admission")
            }
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id,
                hidden_vault_ids,
            } => {
                self.change_travel_mode_selection(
                    account_id,
                    hidden_vault_ids,
                    travel_commands::TravelSelectionAction::Save,
                    cancellation,
                )
                .await
            }
            RuntimeRequest::EnableTravelMode {
                account_id,
                hidden_vault_ids,
            } => {
                self.change_travel_mode_selection(
                    account_id,
                    hidden_vault_ids,
                    travel_commands::TravelSelectionAction::Enable,
                    cancellation,
                )
                .await
            }
            RuntimeRequest::DisableTravelMode {
                account_id,
                master_password,
            } => {
                self.disable_travel_mode(account_id, master_password, cancellation)
                    .await
            }
            RuntimeRequest::RefreshTravelMode { account_id } => {
                self.refresh_travel_mode(account_id, cancellation).await
            }
            RuntimeRequest::DeviceSetup { account_id } => {
                self.device_setup(account_id, cancellation).await
            }
            RuntimeRequest::QuickUnlockAccounts { .. }
            | RuntimeRequest::BiometricAvailability { .. }
            | RuntimeRequest::SetBiometricEnabled { .. }
            | RuntimeRequest::BiometricUnlock { .. }
            | RuntimeRequest::BiometricUnlockAccounts { .. }
            | RuntimeRequest::SetMasterPasswordReentryPeriod { .. } => {
                unreachable!("Local biometric commands are handled before ordinary admission")
            }
            RuntimeRequest::QuickUnlock { .. } => {
                unreachable!("Quick Unlock is handled before ordinary admission")
            }
            // Retiring access is the one request a caller cannot take back. Cancellation is
            // never consulted, and the accepted Operations this Account already owes stay
            // durable: signing out is not a cancellation of committed Server work.
            RuntimeRequest::Lock { .. } | RuntimeRequest::SignOut { .. } => {
                unreachable!("Account lifecycle requests are handled before ordinary admission")
            }
            RuntimeRequest::DeleteServerAccount {
                account_id,
                confirm_email,
                request_id,
            } => {
                self.delete_server_account(account_id, confirm_email, request_id, cancellation)
                    .await
            }
            RuntimeRequest::DeleteVault {
                account_id,
                vault_id,
            } => {
                self.accept_vault_deletion(account_id, vault_id, cancellation, accepted)
                    .await
            }
            RuntimeRequest::UpdateVault {
                account_id,
                vault_id,
                name,
                icon,
                image,
            } => {
                self.accept_vault_update(
                    account_id,
                    vault_id,
                    name,
                    icon,
                    image,
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::CreateVault {
                account_id,
                name,
                vault_type,
                icon,
                image_source,
            } => {
                self.accept_create_vault(
                    account_id,
                    name,
                    vault_type,
                    icon,
                    image_source,
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::CreateItem {
                account_id,
                vault_id,
                draft,
            } => {
                self.accept_create_login_item(account_id, vault_id, draft, cancellation, accepted)
                    .await
            }
            RuntimeRequest::ImportItems {
                account_id,
                vault_id,
                items,
            } => {
                self.accept_import_items(account_id, vault_id, items, cancellation, accepted)
                    .await
            }
            RuntimeRequest::UpdateItem {
                account_id,
                item_id,
                guard,
                draft,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::Update {
                        draft: Box::new(draft),
                        guard,
                    },
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::RemovePasskey {
                account_id,
                item_id,
                guard,
                rp_id,
                credential_id,
                public_key_fingerprint,
            } => {
                self.accept_remove_passkey(
                    account_id,
                    item_id,
                    guard,
                    private_item_commands::PasskeyRemovalSelection {
                        rp_id,
                        credential_id,
                        public_key_fingerprint,
                    },
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::DuplicateItem {
                account_id,
                source_item_id,
                source_guard,
                title,
            } => {
                self.accept_duplicate_item(
                    account_id,
                    source_item_id,
                    source_guard,
                    title,
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::SetItemFavorite {
                account_id,
                item_id,
                favorite,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::SetFavorite(favorite),
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::TrashItem {
                account_id,
                item_id,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::Trash,
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::RestoreItem {
                account_id,
                item_id,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::Restore,
                    cancellation,
                    accepted,
                )
                .await
            }
            request @ (RuntimeRequest::PrepareCrossAccountMoveResume { .. }
            | RuntimeRequest::ResumeCrossAccountMove { .. }) => {
                self.request_cross_account_move_resume(request, cancellation, accepted)
                    .await
            }
            RuntimeRequest::MoveItem {
                account_id,
                item_id,
                target_vault_id,
                target_account_id,
            } => {
                if let Some(target_account_id) = target_account_id.filter(|id| id != &account_id) {
                    return self
                        .accept_cross_account_move(
                            account_id,
                            item_id,
                            target_account_id,
                            target_vault_id,
                            cancellation,
                            accepted,
                        )
                        .await;
                }
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::Move { target_vault_id },
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::PermanentlyDeleteItem {
                account_id,
                item_id,
            } => {
                self.accept_existing_item_operation(
                    account_id,
                    item_id,
                    create::ExistingItemIntent::PermanentlyDelete,
                    cancellation,
                    accepted,
                )
                .await
            }
            RuntimeRequest::CreateShare {
                account_id,
                item_id,
                draft,
            } => {
                self.accept_create_share(account_id, item_id, draft, cancellation, accepted)
                    .await
            }
            RuntimeRequest::AcknowledgeShareResult {
                account_id,
                operation_id,
            } => {
                let _ = accepted;
                self.acknowledge_share_result(account_id, operation_id, cancellation)
                    .await
            }
            RuntimeRequest::ListItemShareLinks { .. }
            | RuntimeRequest::ListShareAccessLogs { .. }
            | RuntimeRequest::RevokeShareLink { .. } => {
                unreachable!("Share management is handled before ordinary admission")
            }
            RuntimeRequest::RenameAttachment { .. } => unreachable!(
                "Rename is handled before ordinary admission so callback delivery can release it"
            ),
            RuntimeRequest::DeleteAttachment { .. } => unreachable!(
                "Delete is handled before ordinary admission so callback delivery can release it"
            ),
            RuntimeRequest::DownloadAttachment { .. } => unreachable!(
                "Download is handled before ordinary admission so sink cleanup can release it"
            ),
            RuntimeRequest::UploadAttachment { .. } => unreachable!(
                "Upload is handled before ordinary admission so source cleanup can release it"
            ),
            // Teardown returns before ordinary admission. A Runtime bug must not abort the host,
            // so this reports an error rather than panicking on the request path.
            RuntimeRequest::AbortProfileAdmission { .. }
            | RuntimeRequest::InspectProfileAdmission {}
            | RuntimeRequest::RemoveAccount { .. }
            | RuntimeRequest::Wipe => Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "teardown requests are handled before ordinary admission",
            )),
        }
    }

    #[cfg(test)]
    pub(crate) async fn execute_plan(
        &self,
        plan: GuardedCommitPlan,
    ) -> Result<PlanResult, RuntimeError> {
        self.ensure_open()?;
        let result = self.replica.execute(plan).await?;
        if matches!(result, PlanResult::Applied { .. }) {
            self.device_revision.fetch_add(1, Ordering::SeqCst);
            self.publish_all();
        }
        Ok(result)
    }

    #[cfg(test)]
    pub(crate) fn fail_account(
        &self,
        account_id: &AccountId,
        code: RuntimeErrorCode,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        self.test_persistence
            .as_ref()
            .expect("test Account failure requires in-memory persistence")
            .fail(account_id, code)?;
        self.replica.cache(
            self.test_persistence
                .as_ref()
                .expect("test Account failure requires in-memory persistence")
                .snapshot(account_id)
                .expect("failed Account must have a snapshot"),
        );
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all();
        Ok(())
    }

    #[cfg_attr(
        target_arch = "wasm32",
        allow(
            clippy::arc_with_non_send_sync,
            reason = "WASM is single-threaded, while observation ownership still shares the Runtime"
        )
    )]
    pub fn observe(
        self: &Arc<Self>,
        request: ObservationRequest,
        sink: Arc<dyn ObservationSink>,
    ) -> Result<Arc<ObservationHandle>, RuntimeError> {
        let native = self.native_observation_guard();
        let publication = self.publication.lock().expect("publication lock poisoned");
        self.ensure_open()?;
        if self.observation_teardown_is_pending(&request) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountMissing,
                "Account teardown is pending",
            ));
        }
        let id = self.next_observer_id.fetch_add(1, Ordering::SeqCst);
        let subscription = Arc::new(Subscription::new(request, sink, self.identity()));
        self.observers
            .lock()
            .expect("observer lock poisoned")
            .insert(id, Arc::clone(&subscription));
        let (initial, _foreground_publication) = match self
            .projection_locked(&subscription.request, &native)
            .and_then(|initial| self.install_vault_export_lifetime(&subscription, initial))
        {
            Ok(initial) => initial,
            Err(error)
                if error.code == RuntimeErrorCode::AuthorityMissing
                    && matches!(&subscription.request, ObservationRequest::Items { account_id }
                        if self.replica.snapshot(account_id).is_some_and(|snapshot|
                            self.travel_policy_verification_pending(&snapshot))
                            && self.account_access.lock().expect("Account access lock poisoned")
                                .get(account_id) == Some(&AccountAccessState::Unlocked)) =>
            {
                // Keep only this ordinary subscription while its current policy is unknown.
                // The projection path above refused before constructing Item plaintext; the
                // existing publication owner supplies its first frame after verification.
                (None, None)
            }
            Err(error) => {
                self.observers
                    .lock()
                    .expect("observer lock poisoned")
                    .remove(&id);
                subscription.close();
                return Err(error);
            }
        };
        drop(publication);
        drop(native);
        // A panicking initial host callback must still release a registered Export loan.
        let handle = Arc::new(ObservationHandle {
            id,
            runtime: Arc::downgrade(self),
            subscription: Arc::clone(&subscription),
            closed: AtomicBool::new(false),
        });
        // The existing admission hook also exposes capture-before-initial-queue races for Export.
        #[cfg(test)]
        if let Some(publication) = &_foreground_publication {
            publication.before_admission();
        }
        if let Some(initial) = initial {
            subscription.publish(initial);
        } else if matches!(subscription.request, ObservationRequest::VaultExport { .. }) {
            self.publish_vault_export_snapshot(&subscription);
        }
        Ok(handle)
    }

    pub(crate) fn publish_all(&self) {
        self.live_sync_wake.notify_waiters();
        let subscriptions: Vec<_> = self
            .observers
            .lock()
            .expect("observer lock poisoned")
            .values()
            .cloned()
            .collect();
        for subscription in subscriptions {
            if matches!(
                &subscription.request,
                ObservationRequest::VaultExport { .. }
            ) {
                self.publish_vault_export_snapshot(&subscription);
                continue;
            }
            if let Ok(projection) = self.projection(&subscription.request) {
                subscription.publish(projection);
            }
        }
    }

    fn prepare_all_for_foreground_attachment(&self) -> PreparedForegroundAttachmentPublications {
        let subscriptions: Vec<_> = self
            .observers
            .lock()
            .expect("observer lock poisoned")
            .values()
            .cloned()
            .collect();
        let deliveries = subscriptions
            .into_iter()
            .filter_map(|subscription| {
                if matches!(
                    &subscription.request,
                    ObservationRequest::VaultExport { .. }
                ) {
                    return None;
                }
                self.projection(&subscription.request)
                    .ok()
                    .map(|projection| (subscription, projection))
            })
            .collect();
        PreparedForegroundAttachmentPublications { deliveries }
    }

    fn publish_all_unless_closed(&self) {
        if !self.is_closed() {
            self.publish_all();
        }
    }

    pub async fn close(&self) {
        self.close_with_recovery().await;
    }

    async fn close_normal_owner(&self) {
        let already_closed = self.closed.swap(true, Ordering::SeqCst);
        self.biometric.retire_all();
        self.native_authority.retire_all();
        if already_closed {
            self.wake_dispatch();
            let reentrant_delivery = ActiveRuntimeDelivery::is_active(self.identity());
            loop {
                let finished = self.close_finished.notified();
                if self.close_complete.load(Ordering::SeqCst)
                    || (reentrant_delivery && self.close_state_cleaned.load(Ordering::SeqCst))
                {
                    return;
                }
                finished.await;
            }
        } else {
            self.wake_dispatch();
            self.foreground_attachments.fence_all_and_drain().await;
            self.retire_all_attachment_downloads().await;
            self.retire_all_attachment_uploads().await;
            self.retire_all_vault_images().await;
            let _catalog_guard = self.catalog_transition.lock().await;
            self.close_profile_admission_source().await;
            let mut execution_locks: Vec<_> = self
                .account_execution_locks
                .lock()
                .expect("Account execution lock map poisoned")
                .iter()
                .map(|(account_id, lock)| (account_id.clone(), Arc::clone(lock)))
                .collect();
            execution_locks.sort_by(|a, b| a.0.as_str().cmp(b.0.as_str()));
            let mut execution_guards = Vec::with_capacity(execution_locks.len());
            for (_, lock) in &execution_locks {
                execution_guards.push(lock.lock().await);
            }
            let pending = self
                .lock_epoch_pending
                .lock()
                .expect("pending lock epoch lock poisoned")
                .clone();
            let durable_advances: Vec<_> = self
                .replica
                .snapshots()
                .into_iter()
                .filter_map(|snapshot| {
                    if snapshot.lock_epoch == u64::MAX {
                        return None;
                    }
                    let desired = pending
                        .get(&snapshot.account_id)
                        .copied()
                        .or_else(|| snapshot.lock_epoch.checked_add(1))?;
                    Some((snapshot, desired))
                })
                .collect();
            let _publication = self.publication.lock().expect("publication lock poisoned");
            let invalidated_deliveries: Vec<_> = execution_locks
                .iter()
                .filter_map(|(account_id, _)| self.invalidate_delivery(account_id))
                .collect();
            let subscriptions: Vec<_> = self
                .observers
                .lock()
                .expect("observer lock poisoned")
                .values()
                .cloned()
                .collect();
            self.unlocked_items
                .lock()
                .expect("unlocked projection lock poisoned")
                .clear();
            self.live_master_unlock_keys
                .lock()
                .expect("live master unlock key lock poisoned")
                .clear();
            self.recovery_accounts
                .lock()
                .expect("recovery Account lock poisoned")
                .clear();
            self.account_access
                .lock()
                .expect("Account access lock poisoned")
                .clear();
            self.account_display_identities
                .lock()
                .expect("Account display identity lock poisoned")
                .clear();
            *self
                .account_lock_epochs
                .lock()
                .expect("Account lock epoch lock poisoned") = durable_advances
                .iter()
                .map(|(snapshot, epoch)| (snapshot.account_id.clone(), *epoch))
                .collect();
            drop(_publication);
            drop(execution_guards);
            drop(_catalog_guard);
            self.close_state_cleaned.store(true, Ordering::SeqCst);
            self.close_finished.notify_waiters();
            for token in invalidated_deliveries {
                token.wait_for_other_threads();
            }
            for subscription in subscriptions {
                subscription.close_for_lifecycle();
            }
            self.observers
                .lock()
                .expect("observer lock poisoned")
                .clear();
            for (snapshot, desired_epoch) in durable_advances {
                let _ = self
                    .replica
                    .advance_lock_epoch(
                        &snapshot.account_id,
                        &snapshot.user_id,
                        &snapshot.incarnation,
                        desired_epoch,
                    )
                    .await;
            }
            self.close_complete.store(true, Ordering::SeqCst);
            self.close_finished.notify_waiters();
        }
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn account_execution_lock(
        &self,
        account_id: &AccountId,
    ) -> Result<Arc<tokio::sync::Mutex<()>>, RuntimeError> {
        self.ensure_open()?;
        self.account_execution_lock_internal(account_id)
    }

    /// Startup uses the same execution fence while public work is still refused.
    fn account_execution_lock_internal(
        &self,
        account_id: &AccountId,
    ) -> Result<Arc<tokio::sync::Mutex<()>>, RuntimeError> {
        let mut locks = self
            .account_execution_locks
            .lock()
            .expect("Account execution lock map poisoned");
        self.ensure_not_closed()?;
        Ok(locks
            .entry(account_id.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone())
    }

    fn account_lifecycle_lock(
        &self,
        account_id: &AccountId,
    ) -> Result<Arc<tokio::sync::Mutex<()>>, RuntimeError> {
        self.ensure_not_closed()?;
        Ok(self
            .account_lifecycle_locks
            .lock()
            .expect("Account lifecycle lock map poisoned")
            .entry(account_id.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone())
    }

    fn item_mutation_lock(
        &self,
        account_id: &AccountId,
        item_id: &str,
    ) -> Arc<tokio::sync::Mutex<()>> {
        self.item_mutation_locks
            .lock()
            .expect("Item mutation lock map poisoned")
            .entry((account_id.clone(), item_id.to_owned()))
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn generation_is_preparation_eligible(&self, snapshot: &ReplicaSnapshot) -> bool {
        self.generation_has_current_unlocked_authority(snapshot)
            && !self.travel_policy_verification_pending(snapshot)
    }

    fn generation_has_current_unlocked_authority(&self, snapshot: &ReplicaSnapshot) -> bool {
        !self.is_closed()
            && self.ready.load(Ordering::SeqCst)
            && !self.account_teardown_is_pending(&snapshot.account_id)
            && !self.account_access_retirement_is_pending(&snapshot.account_id)
            && snapshot.failure.is_none()
            && self
                .account_access
                .lock()
                .expect("Account access lock poisoned")
                .get(&snapshot.account_id)
                == Some(&AccountAccessState::Unlocked)
            && self
                .replica
                .snapshot(&snapshot.account_id)
                .is_some_and(|current| {
                    current.failure.is_none()
                        && current.incarnation == snapshot.incarnation
                        && current.lock_epoch == snapshot.lock_epoch
                })
    }

    /// Publication is held and the caller has committed metadata for this exact Account scope.
    fn update_travel_policy_presentation(
        &self,
        expected: &ReplicaSnapshot,
        policy: &crate::platform_storage::VerifiedTravelModePolicy,
    ) {
        if let Some(presentation) = self
            .account_display_identities
            .lock()
            .expect("Account display identity lock poisoned")
            .get_mut(&expected.account_id)
        {
            presentation.verified_travel_mode = Some(policy.clone());
        }
    }

    /// Publication is held. Existing admitted callbacks remain live; only new leases pause.
    pub(super) fn pause_travel_plaintext_delivery(&self, account_id: &AccountId, paused: bool) {
        if let Some((_, token)) = self
            .delivery_tokens
            .lock()
            .expect("delivery token map poisoned")
            .get(account_id)
        {
            token.pause_admission(paused);
        }
    }

    fn invalidate_delivery(&self, account_id: &AccountId) -> Option<Arc<DeliveryToken>> {
        let token = self
            .delivery_tokens
            .lock()
            .expect("delivery token map poisoned")
            .remove(account_id)
            .map(|(_, token)| token);
        if let Some(token) = &token {
            token.invalidate();
        }
        token
    }

    pub(crate) fn copy_live_master_unlock_key(
        &self,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) -> Option<Zeroizing<[u8; 32]>> {
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .get(&(account_id.clone(), incarnation.clone()))
            .map(LiveMasterUnlockKey::copy_bytes)
    }

    fn copy_live_vault_key_material(
        &self,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) -> Option<vault_key::VaultKeyMaterial> {
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .get(&(account_id.clone(), incarnation.clone()))
            .map(LiveMasterUnlockKey::copy_material)
    }

    /// Puts the fixture master unlock key in memory, the way a real Sign-in or unlock leaves one.
    ///
    /// This is the only seam that publishes `TEST_MASTER_UNLOCK_KEY`, and it is compiled out of
    /// every non-test build together with the fixture module that owns the constant.
    #[cfg(test)]
    pub(crate) fn seed_live_master_unlock_key(
        &self,
        account_id: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) {
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .insert(
                (account_id.clone(), incarnation.clone()),
                LiveMasterUnlockKey::new(Zeroizing::new(
                    crate::test_fixtures::TEST_MASTER_UNLOCK_KEY,
                )),
            );
    }

    #[cfg(test)]
    pub(crate) fn seed_unlocked_preparation_account(&self, account_id: &AccountId) {
        let snapshot = self
            .replica
            .snapshot(account_id)
            .expect("preparation Account is loaded");
        self.seed_live_master_unlock_key(account_id, &snapshot.incarnation);
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::Unlocked);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), snapshot.lock_epoch);
        self.wake_dispatch();
    }

    /// Seeds only the authority that C's joined generated-Upload browser proof needs. The real
    /// authentication ceremony and restart/unlock acceptance remain exclusively Ticket 28 D.
    #[cfg(feature = "binding-test-harness")]
    #[doc(hidden)]
    pub async fn seed_attachment_upload_binding_test_authority(
        &self,
        server_url: String,
        mode: String,
    ) -> Result<String, RuntimeError> {
        self.seed_attachment_upload_binding_test_account(server_url, mode, false)
            .await
    }

    /// Exercises the ordinary startup sweep with installed test authority and no accepted work.
    #[cfg(feature = "binding-test-harness")]
    #[doc(hidden)]
    pub async fn seed_attachment_sweep_binding_test_authority(
        &self,
        server_url: String,
    ) -> Result<(), RuntimeError> {
        self.seed_attachment_upload_binding_test_authority(server_url, "writable".into())
            .await?;
        self.wake_dispatch();
        Ok(())
    }

    #[cfg(feature = "binding-test-harness")]
    async fn seed_attachment_upload_binding_test_account(
        &self,
        server_url: String,
        mode: String,
        second_account: bool,
    ) -> Result<String, RuntimeError> {
        use crate::{
            platform_storage::{AccountMetadataDocument, CurrentSessionDocument},
            replica::{AuthorityItemCategory, AuthorityItemRecord},
            test_fixtures::{
                personal_vault, TEST_MASTER_UNLOCK_KEY, TEST_VAULT_ID, TEST_VAULT_KEY,
            },
        };
        use bittery_crypto_core::{encrypt_with_aad, AadContext};

        if !matches!(mode.as_str(), "writable" | "read-only" | "optimistic") {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "binding Upload seed mode is invalid",
            ));
        }
        let account_id = AccountId::from(if second_account {
            "account-2"
        } else {
            "account-1"
        });
        let incarnation = crate::Incarnation::from(if second_account {
            "joined-import-second-incarnation"
        } else {
            "joined-upload-incarnation"
        });
        let user_id = if second_account { "user-2" } else { "user-1" }.to_owned();
        let item_id = "item-existing";
        let draft = crate::LoginItemData {
            title: "Joined Upload Item".into(),
            url: None,
            urls: Vec::new(),
            username: None,
            password: None,
            password_history: Vec::new(),
            passkeys: Vec::new(),
            notes: None,
            note: None,
            custom_fields: Vec::new(),
            tags: Vec::new(),
            totp_secret: None,
            totp_issuer: None,
            totp_account_name: None,
            totp_algorithm: None,
            totp_digits: None,
            totp_period: None,
        };
        let encrypted = encrypt_with_aad(
            &serde_json::to_string(&draft).map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "binding Upload seed could not serialize its Item",
                )
            })?,
            &TEST_VAULT_KEY,
            &AadContext {
                vault_id: TEST_VAULT_ID.into(),
                entity_id: item_id.into(),
                entity_type: "item".into(),
                version: 1,
                user_id: user_id.clone(),
            },
        )
        .map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "binding Upload seed could not encrypt its Item",
            )
        })?;
        let item = AuthorityItemRecord {
            id: item_id.into(),
            vault_id: TEST_VAULT_ID.into(),
            category: AuthorityItemCategory::Login,
            favorite: false,
            encrypted_data: encrypted.ciphertext.clone(),
            encryption_iv: encrypted.iv.clone(),
            encryption_algorithm: encrypted.algorithm.clone(),
            version: 1,
            encryption_version: 1,
            encrypted_by_user_id: user_id.clone(),
            last_modified_by: user_id.clone(),
            created_at: "2026-08-30T00:00:00Z".into(),
            updated_at: "2026-08-30T00:00:00Z".into(),
            deleted_at: None,
            attachments: Vec::new(),
        };
        let mut vault = personal_vault(TEST_VAULT_ID, &user_id);
        if mode == "read-only" {
            vault.role = AuthorityVaultRole::ReadOnly;
        }
        let mut snapshot = self
            .replica
            .seed_attachment_upload_authority(
                account_id.clone(),
                user_id.clone(),
                incarnation.clone(),
                vault,
                item,
            )
            .await?;
        if mode == "optimistic" {
            let optimistic = self
                .replica
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    snapshot.incarnation.clone(),
                    snapshot.revision,
                    snapshot.lock_epoch,
                    vec![PlanMutation::AcceptOperation(
                        crate::test_fixtures::test_operation("binding-upload-optimistic", item_id),
                    )],
                ))
                .await?;
            if !matches!(optimistic, PlanResult::Applied { .. }) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "binding Upload seed could not retain optimistic authority",
                ));
            }
            snapshot = self.replica.load(&account_id).await?.ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "binding Upload seed lost optimistic authority",
                )
            })?;
        }
        self.platform_storage
            .store_account_metadata(&AccountMetadataDocument::new(
                account_id.clone(),
                incarnation.clone(),
                user_id.clone(),
                if second_account {
                    "joined-second@example.test"
                } else {
                    "joined@example.test"
                }
                .into(),
                "Joined Upload".into(),
                server_url,
                None,
                None,
                "A3".into(),
                1_777_500_000_000,
                1_777_500_000_000,
                false,
                true,
                bittery_crypto_core::current_kdf_profile(),
                None,
            )?)
            .await?;
        self.platform_storage
            .store_current_session(&CurrentSessionDocument::new(
                account_id.clone(),
                incarnation.clone(),
                if second_account {
                    "joined-second-session-token"
                } else {
                    "joined-session-token"
                }
                .into(),
                Some("joined-session".into()),
                4_102_444_800_000,
                Some(4_102_444_800_000),
                Vec::new(),
                "joined-encrypted-private-key".into(),
            )?)
            .await?;
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .insert(
                (account_id.clone(), incarnation.clone()),
                LiveMasterUnlockKey::new(Zeroizing::new(TEST_MASTER_UNLOCK_KEY)),
            );
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::Unlocked);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id.clone(), snapshot.lock_epoch);
        self.decrypt_visible_items(&account_id)?;
        if second_account {
            self.note_session_available(&account_id);
        }
        serde_json::to_string(&serde_json::json!({
            "id": item_id,
            "vaultId": TEST_VAULT_ID,
            "category": "login",
            "favorite": false,
            "encryptedData": encrypted.ciphertext,
            "encryptionIv": encrypted.iv,
            "encryptionAlgorithm": encrypted.algorithm,
            "encryptionVersion": 1,
            "version": 1,
            "encryptedByUserId": user_id,
            "lastModifiedBy": user_id,
            "createdAt": "2026-08-30T00:00:00Z",
            "updatedAt": "2026-08-30T00:00:00Z",
            "deletedAt": null,
        }))
        .map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "binding Upload seed could not serialize authority",
            )
        })
    }

    /// Restores the smallest authenticated authority needed by the joined create-Vault browser
    /// matrix. Unlike the Upload seed, a restart keeps the persisted Replica byte-for-byte so the
    /// generated Core must resume the accepted Operation and its staging checkpoint.
    #[cfg(feature = "binding-test-harness")]
    #[doc(hidden)]
    pub async fn seed_create_vault_binding_test_authority(
        &self,
        server_url: String,
        pause_checkpoint: Option<String>,
        second_account: bool,
    ) -> Result<(), RuntimeError> {
        use crate::{
            platform_storage::{AccountMetadataDocument, CurrentSessionDocument},
            test_fixtures::TEST_MASTER_UNLOCK_KEY,
        };

        let server_url_for_second_account = server_url.clone();
        let pause_checkpoint = match pause_checkpoint.as_deref() {
            None => None,
            Some("artifactReady") => Some(crate::replica::CreateVaultCheckpoint::ArtifactReady),
            Some("remoteUploadConfirmed") => {
                Some(crate::replica::CreateVaultCheckpoint::RemoteUploadConfirmed)
            }
            Some("finalRequestFrozen") => {
                Some(crate::replica::CreateVaultCheckpoint::FinalRequestFrozen)
            }
            Some(_) => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "binding create-Vault pause checkpoint is invalid",
                ));
            }
        };
        *self
            .create_vault_binding_pause_checkpoint
            .lock()
            .expect("binding create-Vault pause lock poisoned") = pause_checkpoint;
        let account_id = AccountId::from("account-1");
        let snapshot = match self.replica.load(&account_id).await? {
            Some(snapshot) => snapshot,
            None => {
                self.seed_attachment_upload_binding_test_authority(
                    server_url.clone(),
                    "writable".into(),
                )
                .await?;
                self.replica.snapshot(&account_id).ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "binding create-Vault seed lost its Account",
                    )
                })?
            }
        };
        self.platform_storage
            .store_account_metadata(&AccountMetadataDocument::new(
                account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.user_id.clone(),
                "joined@example.test".into(),
                "Joined Create Vault".into(),
                server_url,
                None,
                None,
                "A3".into(),
                1_777_500_000_000,
                1_777_500_000_000,
                false,
                true,
                bittery_crypto_core::current_kdf_profile(),
                None,
            )?)
            .await?;
        self.platform_storage
            .store_current_session(&CurrentSessionDocument::new(
                account_id.clone(),
                snapshot.incarnation.clone(),
                "joined-session-token".into(),
                Some("joined-session".into()),
                4_102_444_800_000,
                Some(4_102_444_800_000),
                Vec::new(),
                "joined-encrypted-private-key".into(),
            )?)
            .await?;
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .insert(
                (account_id.clone(), snapshot.incarnation.clone()),
                LiveMasterUnlockKey::new(Zeroizing::new(TEST_MASTER_UNLOCK_KEY)),
            );
        self.account_access
            .lock()
            .expect("Account access lock poisoned")
            .insert(account_id.clone(), AccountAccessState::Unlocked);
        self.account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .insert(account_id, snapshot.lock_epoch);
        self.note_session_available(&AccountId::from("account-1"));
        if second_account {
            self.seed_attachment_upload_binding_test_account(
                server_url_for_second_account,
                "writable".into(),
                true,
            )
            .await?;
        }
        // The joined fixture represents installed Accounts. Persist their catalog identities and
        // use the same Device-key initialization owner before exercising locked recovery/restart.
        let _catalog = self.catalog_transition.lock().await;
        let catalog = self
            .platform_storage
            .load_device_catalog()
            .await?
            .unwrap_or(DeviceCatalogDocument::new(Vec::new())?);
        let mut catalog_accounts = catalog.accounts.clone();
        for id in [Some("account-1"), second_account.then_some("account-2")]
            .into_iter()
            .flatten()
        {
            let account = AccountId::from(id);
            let snapshot = self.require_snapshot(&account)?;
            let metadata = self
                .platform_storage
                .load_account_metadata(&account, &snapshot.incarnation)
                .await?
                .ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "joined fixture Account metadata is missing",
                    )
                })?;
            self.account_display_identities
                .lock()
                .expect("Account display identity lock poisoned")
                .insert(account.clone(), account_presentation(&metadata));
            catalog_accounts.retain(|entry| entry.account_id != account);
            catalog_accounts.push(DeviceCatalogAccount {
                account_id: account,
                active_incarnation: Some(snapshot.incarnation),
                pending_retirement: None,
                pending_install: None,
            });
        }
        self.platform_storage
            .store_device_catalog(&catalog.with_accounts(catalog_accounts)?)
            .await?;
        self.ensure_image_device_key_under_catalog(&SystemInstallationEntropy)
            .await?;
        Ok(())
    }

    fn clear_live_master_unlock_keys_for_account(&self, account_id: &AccountId) {
        self.live_master_unlock_keys
            .lock()
            .expect("live master unlock key lock poisoned")
            .retain(|(installed_account_id, _), _| installed_account_id != account_id);
    }

    fn identity(&self) -> usize {
        std::ptr::from_ref(self).addr()
    }

    fn projection(&self, request: &ObservationRequest) -> Result<ProjectedDelivery, RuntimeError> {
        let native = self.native_observation_guard();
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.projection_locked(request, &native)
    }

    fn projection_locked(
        &self,
        request: &ObservationRequest,
        native: &native_authority::NativeObservationGuard<'_>,
    ) -> Result<ProjectedDelivery, RuntimeError> {
        match request {
            ObservationRequest::VaultExport {
                account_id,
                vault_ids,
            } => {
                let mut delivery = self.projection_locked(
                    &ObservationRequest::Items {
                        account_id: account_id.clone(),
                    },
                    native,
                )?;
                let RuntimeProjection::Items(mut items) = delivery.projection else {
                    unreachable!("Items observation returned another projection");
                };
                items
                    .items
                    .retain(|item| item.deleted_at.is_none() && vault_ids.contains(&item.vault_id));
                items
                    .vaults
                    .retain(|vault| vault_ids.contains(&vault.vault_id));
                let snapshot = self.require_snapshot(account_id)?;
                let private_items = self.private_vault_export_items(&snapshot, &items)?;
                delivery.projection =
                    RuntimeProjection::VaultExport(crate::VaultExportProjection {
                        account_id: items.account_id,
                        replica_revision: items.replica_revision,
                        items: private_items,
                        vaults: items.vaults,
                    });
                Ok(delivery)
            }
            ObservationRequest::TravelMode { account_id } => {
                let snapshot = self.require_snapshot(account_id)?;
                let policy = self
                    .account_display_identities
                    .lock()
                    .expect("Account display identity lock poisoned")
                    .get(account_id)
                    .and_then(|presentation| presentation.verified_travel_mode.clone());
                Ok(ProjectedDelivery {
                    dependency_revision: None,
                    projection: RuntimeProjection::TravelMode(crate::TravelModeProjection {
                        account_id: account_id.clone(),
                        revision: self.device_revision.load(Ordering::SeqCst),
                        enforcement: self.travel_enforcement(&snapshot, policy.as_ref()),
                        last_verified_policy: policy
                            .as_ref()
                            .map(travel_commands::policy_projection),
                    }),
                    generation: None,
                    tokens: vec![],
                })
            }
            ObservationRequest::WritableVaultCatalog => {
                let access = self
                    .account_access
                    .lock()
                    .expect("Account access lock poisoned")
                    .clone();
                let mut vaults = Vec::new();
                let mut tokens = Vec::new();
                let mut snapshots = self.replica.snapshots();
                snapshots
                    .sort_by(|left, right| left.account_id.as_str().cmp(right.account_id.as_str()));
                for snapshot in snapshots {
                    if access.get(&snapshot.account_id) != Some(&AccountAccessState::Unlocked)
                        || self.account_teardown_is_pending(&snapshot.account_id)
                        || self.travel_policy_verification_pending(&snapshot)
                    {
                        continue;
                    }
                    tokens.push(self.delivery_token(
                        &snapshot,
                        &DeliveryGeneration {
                            incarnation: snapshot.incarnation.clone(),
                            epoch: snapshot.lock_epoch,
                        },
                    ));
                    vaults.extend(visible_vaults(&snapshot).into_iter().filter_map(|vault| {
                        (vault.role != VaultProjectionRole::ReadOnly
                            && !self.vault_is_fenced(&snapshot, &vault.vault_id))
                        .then_some(WritableVaultProjection {
                            account_id: snapshot.account_id.clone(),
                            vault_id: vault.vault_id,
                            name: vault.name,
                            vault_type: vault.vault_type,
                            icon: vault.icon,
                            image_url: vault.image_url,
                            role: vault.role,
                        })
                    }));
                }
                vaults.sort_by(|left, right| {
                    left.account_id
                        .as_str()
                        .cmp(right.account_id.as_str())
                        .then_with(|| left.vault_id.cmp(&right.vault_id))
                });
                Ok(ProjectedDelivery {
                    dependency_revision: None,
                    projection: RuntimeProjection::WritableVaultCatalog(
                        WritableVaultCatalogProjection {
                            revision: self.device_revision.load(Ordering::SeqCst),
                            vaults,
                        },
                    ),
                    generation: None,
                    tokens,
                })
            }
            ObservationRequest::Operations { account_id } => {
                let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
                    RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
                })?;
                let mut operations = snapshot
                    .operations
                    .iter()
                    .map(|operation| {
                        use crate::replica::LegacyOperationDisposition;
                        let resolution = match operation
                            .legacy_admission
                            .as_ref()
                            .map(|admission| admission.disposition)
                        {
                            Some(LegacyOperationDisposition::LegacyFailed) => {
                                crate::OperationResolution::LegacyFailed
                            }
                            Some(LegacyOperationDisposition::LegacyConflicted) => {
                                crate::OperationResolution::LegacyConflicted
                            }
                            None | Some(LegacyOperationDisposition::Normal) => {
                                crate::OperationResolution::Pending
                            }
                        };
                        crate::OperationProjection {
                            operation_id: operation.operation_id.clone(),
                            kind: operation.kind.into(),
                            attempt_count: Some(operation.scheduling.attempt_count.to_string()),
                            next_attempt_at_ms: (resolution == crate::OperationResolution::Pending)
                                .then(|| operation.scheduling.not_before_ms.to_string()),
                            resolution,
                            imported_count: None,
                            rejection_code: None,
                            cross_account_move: None,
                        }
                    })
                    .collect::<Vec<_>>();
                operations.extend(snapshot.receipts.iter().map(|receipt| {
                    use crate::replica::OperationOutcomeResult;
                    let (resolution, imported_count, rejection_code) = match &receipt.result {
                        OperationOutcomeResult::ImportApplied { imported_count, .. } => (
                            crate::OperationResolution::Applied,
                            Some(*imported_count),
                            None,
                        ),
                        OperationOutcomeResult::Rejected { code } => (
                            crate::OperationResolution::Rejected,
                            None,
                            serde_json::to_value(code)
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_owned)),
                        ),
                        OperationOutcomeResult::VaultRejected { code } => (
                            crate::OperationResolution::Rejected,
                            None,
                            serde_json::to_value(code)
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_owned)),
                        ),
                        OperationOutcomeResult::VaultMutationRejected { code } => (
                            crate::OperationResolution::Rejected,
                            None,
                            serde_json::to_value(code)
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_owned)),
                        ),
                        OperationOutcomeResult::ImportRejected { code } => (
                            crate::OperationResolution::Rejected,
                            None,
                            serde_json::to_value(code)
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_owned)),
                        ),
                        OperationOutcomeResult::RotationStartRejected { code } => (
                            crate::OperationResolution::Rejected,
                            None,
                            serde_json::to_value(code)
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_owned)),
                        ),
                        OperationOutcomeResult::RotationFinalizeRejected { code, .. } => (
                            crate::OperationResolution::Rejected,
                            None,
                            serde_json::to_value(code)
                                .ok()
                                .and_then(|v| v.as_str().map(str::to_owned)),
                        ),
                        OperationOutcomeResult::Applied { .. }
                        | OperationOutcomeResult::RotationStartApplied { .. }
                        | OperationOutcomeResult::RotationStartAppliedReceipt { .. }
                        | OperationOutcomeResult::RotationFinalizeApplied { .. }
                        | OperationOutcomeResult::ShareApplied { .. }
                        | OperationOutcomeResult::VaultApplied { .. } => {
                            (crate::OperationResolution::Applied, None, None)
                        }
                    };
                    crate::OperationProjection {
                        operation_id: receipt.operation_id.clone(),
                        kind: receipt.kind.into(),
                        attempt_count: None,
                        next_attempt_at_ms: None,
                        resolution,
                        imported_count,
                        rejection_code,
                        cross_account_move: None,
                    }
                }));
                operations.extend(self.cross_account_move_projections(&snapshot));
                operations.sort_by(|left, right| left.operation_id.cmp(&right.operation_id));
                Ok(ProjectedDelivery {
                    // Destination availability is captured under the same publication lock.
                    dependency_revision: Some(self.device_revision.load(Ordering::SeqCst)),
                    projection: RuntimeProjection::Operations(crate::OperationsProjection {
                        account_id: account_id.clone(),
                        replica_revision: snapshot.revision,
                        operations,
                    }),
                    generation: None,
                    tokens: vec![],
                })
            }
            ObservationRequest::Items { account_id } => {
                let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
                    RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
                })?;
                if self.travel_policy_verification_pending(&snapshot) {
                    return Err(travel_policy::pending_policy());
                }
                if self
                    .account_access
                    .lock()
                    .expect("Account access lock poisoned")
                    .get(account_id)
                    != Some(&AccountAccessState::Unlocked)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "the selected Account is signed out or locked",
                    ));
                }
                let epoch = *self
                    .account_lock_epochs
                    .lock()
                    .expect("Account lock epoch lock poisoned")
                    .get(account_id)
                    .unwrap_or(&0);
                let generation = DeliveryGeneration {
                    incarnation: snapshot.incarnation.clone(),
                    epoch,
                };
                let token = self.delivery_token(&snapshot, &generation);
                let mut items = self
                    .unlocked_items
                    .lock()
                    .expect("unlocked projection lock poisoned")
                    .get(account_id)
                    .cloned()
                    .unwrap_or_default();
                self.filter_vault_item_projections(&snapshot, &mut items)?;
                Ok(ProjectedDelivery {
                    dependency_revision: None,
                    projection: RuntimeProjection::Items(ItemsProjection {
                        account_id: account_id.clone(),
                        replica_revision: snapshot.revision,
                        items,
                        vaults: visible_vaults(&snapshot)
                            .into_iter()
                            .filter(|vault| !self.vault_is_fenced(&snapshot, &vault.vault_id))
                            .collect(),
                    }),
                    generation: Some(generation),
                    tokens: vec![token],
                })
            }
            ObservationRequest::PendingShareResults { account_id } => {
                let snapshot = self.replica.snapshot(account_id).ok_or_else(|| {
                    RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
                })?;
                if self.travel_policy_verification_pending(&snapshot) {
                    return Err(travel_policy::pending_policy());
                }
                if self
                    .account_access
                    .lock()
                    .expect("Account access lock poisoned")
                    .get(account_id)
                    != Some(&AccountAccessState::Unlocked)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "the selected Account is signed out or locked",
                    ));
                }
                let epoch = *self
                    .account_lock_epochs
                    .lock()
                    .expect("Account lock epoch lock poisoned")
                    .get(account_id)
                    .unwrap_or(&0);
                let generation = DeliveryGeneration {
                    incarnation: snapshot.incarnation.clone(),
                    epoch,
                };
                let token = self.delivery_token(&snapshot, &generation);
                let master_unlock_key = self
                    .copy_live_master_unlock_key(account_id, &snapshot.incarnation)
                    .ok_or_else(|| {
                        RuntimeError::new(
                            RuntimeErrorCode::AuthenticationRequired,
                            "the selected Account has no live master unlock key",
                        )
                    })?;
                let mut results = Vec::new();
                for capability in snapshot
                    .share_capabilities
                    .iter()
                    .filter(|capability| capability.result.is_some())
                {
                    let receipt = snapshot
                        .receipts
                        .iter()
                        .find(|receipt| receipt.operation_id == capability.operation_id)
                        .ok_or_else(|| {
                            RuntimeError::new(
                                RuntimeErrorCode::InvariantViolation,
                                "the pending Share result has no Operation receipt",
                            )
                        })?;
                    if self.vault_is_fenced(&snapshot, receipt.vault_id()) {
                        continue;
                    }
                    let context = bittery_crypto_core::ShareCapabilityAadContext::new(
                        account_id.as_str().to_owned(),
                        capability.operation_id.clone(),
                    )
                    .map_err(|_| {
                        RuntimeError::new(
                            RuntimeErrorCode::InvariantViolation,
                            "the pending Share result scope is invalid",
                        )
                    })?;
                    let plaintext = Zeroizing::new(
                        bittery_crypto_core::decrypt_share_capability(
                            &bittery_crypto_core::EncryptedData {
                                ciphertext: capability.ciphertext.clone(),
                                iv: capability.iv.clone(),
                                algorithm: capability.algorithm.clone(),
                            },
                            master_unlock_key.as_slice(),
                            &context,
                        )
                        .map_err(|_| {
                            RuntimeError::new(
                                RuntimeErrorCode::InvariantViolation,
                                "the pending Share capability could not be opened",
                            )
                        })?,
                    );
                    let opened = Zeroizing::new(
                        serde_json::from_str::<DecryptedShareCapability>(&plaintext).map_err(
                            |_| {
                                RuntimeError::new(
                                    RuntimeErrorCode::InvariantViolation,
                                    "the pending Share capability is invalid",
                                )
                            },
                        )?,
                    );
                    let applied = capability
                        .result
                        .as_ref()
                        .expect("filtered pending Share result must exist");
                    match &receipt.result {
                        OperationOutcomeResult::ShareApplied {
                            share_link_id,
                            base_share_url,
                            expires_at,
                        } if receipt.kind == OperationKind::CreateShare
                            && share_link_id == &applied.share_link_id
                            && base_share_url == &applied.base_share_url
                            && expires_at == &applied.expires_at => {}
                        _ => {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::InvariantViolation,
                                "the pending Share result disagrees with its Operation receipt",
                            ));
                        }
                    }
                    let item_id = receipt.target.item_id().ok_or_else(|| {
                        RuntimeError::new(
                            RuntimeErrorCode::InvariantViolation,
                            "the pending Share receipt has a non-Item target",
                        )
                    })?;
                    results.push(PendingShareResult {
                        operation_id: capability.operation_id.clone(),
                        item_id: item_id.to_owned(),
                        share_link_id: applied.share_link_id.clone(),
                        share_url: format!(
                            "{}{}#{}",
                            applied.base_share_url, opened.token, opened.share_key
                        ),
                        expires_at: applied.expires_at.clone(),
                    });
                }
                Ok(ProjectedDelivery {
                    dependency_revision: None,
                    projection: RuntimeProjection::PendingShareResults(
                        PendingShareResultsProjection {
                            account_id: account_id.clone(),
                            replica_revision: snapshot.revision,
                            results,
                        },
                    ),
                    generation: Some(generation),
                    tokens: vec![token],
                })
            }
            ObservationRequest::RuntimeStatus { account_id } => {
                let recovery = self
                    .recovery_accounts
                    .lock()
                    .expect("recovery Account lock poisoned")
                    .clone();
                let snapshots = match account_id {
                    Some(account_id) => self.replica.snapshot(account_id).into_iter().collect(),
                    None => self.replica.snapshots(),
                };
                let mut accounts: Vec<_> = snapshots
                    .into_iter()
                    .map(|value| {
                        let access = self
                            .account_access
                            .lock()
                            .expect("Account access lock poisoned")
                            .get(&value.account_id)
                            .copied()
                            .unwrap_or(AccountAccessState::SignedOut);
                        let presentation = self
                            .account_display_identities
                            .lock()
                            .expect("Account display identity lock poisoned")
                            .get(&value.account_id)
                            .cloned();
                        AccountStatus {
                            unlock_capabilities: native.unlock_capabilities(
                                presentation.as_ref(),
                                &value.user_id,
                                access,
                            ),
                            access,
                            display_identity: presentation
                                .map(|presentation| presentation.identity),
                            waiting_reason: self
                                .waiting_reasons
                                .lock()
                                .expect("waiting reason lock poisoned")
                                .get(&value.account_id)
                                .copied(),
                            account_id: value.account_id,
                            replica_revision: value.revision,
                            failure: value.failure,
                        }
                    })
                    .collect();
                let visible: HashSet<_> = accounts
                    .iter()
                    .map(|status| status.account_id.clone())
                    .collect();
                accounts.extend(
                    recovery
                        .into_iter()
                        .filter(|(recovery_account_id, _)| {
                            account_id
                                .as_ref()
                                .is_none_or(|requested| requested == recovery_account_id)
                                && !visible.contains(recovery_account_id)
                        })
                        .map(|(account_id, recovery)| AccountStatus {
                            account_id,
                            replica_revision: recovery.replica_revision,
                            access: AccountAccessState::SignedOut,
                            unlock_capabilities: AccountUnlockCapabilities::default(),
                            display_identity: None,
                            waiting_reason: None,
                            failure: None,
                        }),
                );
                if let Some(requested) = account_id {
                    if accounts.is_empty() {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AccountMissing,
                            "account is not installed",
                        ));
                    }
                    debug_assert!(accounts
                        .iter()
                        .all(|status| &status.account_id == requested));
                }
                accounts.sort_by(|a, b| a.account_id.as_str().cmp(b.account_id.as_str()));
                let revision = self.device_revision.load(Ordering::SeqCst);
                Ok(ProjectedDelivery {
                    dependency_revision: None,
                    projection: RuntimeProjection::RuntimeStatus(RuntimeStatusProjection {
                        profile_admission_cleanup: self
                            .profile_admission_cleanup_status
                            .lock()
                            .expect("admission cleanup status lock poisoned")
                            .clone(),
                        account_id: account_id.clone(),
                        revision,
                        accounts,
                        closed: self.is_closed(),
                    }),
                    generation: None,
                    tokens: vec![],
                })
            }
        }
    }

    fn update_profile_admission_cleanup_status(&self, catalog: Option<&DeviceCatalogDocument>) {
        let next = catalog.and_then(DeviceCatalogDocument::admission_record)
            .and_then(crate::platform_storage::profile_admission::ProfileAdmissionRecord::pending_cleanup_obligations)
            .map(|pending_obligations| crate::protocol::ProfileAdmissionCleanupStatus::Pending { pending_obligations });
        let changed = {
            let mut status = self
                .profile_admission_cleanup_status
                .lock()
                .expect("admission cleanup status lock poisoned");
            if *status == next {
                false
            } else {
                *status = next;
                true
            }
        };
        if changed {
            self.device_revision.fetch_add(1, Ordering::SeqCst);
            if self.ready.load(Ordering::SeqCst) {
                self.publish_all();
            }
        }
    }

    fn ensure_open(&self) -> Result<(), RuntimeError> {
        self.ensure_not_closed()?;
        if !self.ready.load(Ordering::SeqCst) {
            Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Runtime must finish opening before it accepts work",
            ))
        } else {
            Ok(())
        }
    }

    fn ensure_not_closed(&self) -> Result<(), RuntimeError> {
        if self.is_closed() {
            Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeClosed,
                "Runtime has been closed",
            ))
        } else {
            Ok(())
        }
    }
}

fn reconcile_catalog_account(
    account: &DeviceCatalogAccount,
    snapshot: Option<&crate::replica::ReplicaSnapshot>,
) -> Result<
    (
        Option<crate::protocol::Incarnation>,
        Option<crate::protocol::Incarnation>,
    ),
    RuntimeError,
> {
    if snapshot.is_none() && account.active_incarnation.is_some() {
        return Err(RuntimeError::new(
            RuntimeErrorCode::StorageUnavailable,
            "active Account catalog survives but its durable Replica is missing",
        ));
    }
    let Some(pending) = &account.pending_install else {
        let active = account
            .active_incarnation
            .clone()
            .ok_or_else(|| startup_invariant("catalog Account has no active incarnation"))?;
        if snapshot.is_none_or(|snapshot| snapshot.incarnation != active) {
            return Err(startup_invariant(
                "active catalog incarnation does not match the durable Replica head",
            ));
        }
        return Ok((Some(active), None));
    };

    match snapshot.map(|snapshot| &snapshot.incarnation) {
        Some(head) if head == &pending.incarnation => Ok((
            Some(pending.incarnation.clone()),
            account.active_incarnation.clone(),
        )),
        Some(head) if Some(head) == account.active_incarnation.as_ref() => Ok((
            account.active_incarnation.clone(),
            Some(pending.incarnation.clone()),
        )),
        None if account.active_incarnation.is_none() => {
            Ok((None, Some(pending.incarnation.clone())))
        }
        _ => Err(startup_invariant(
            "pending Account installation cannot be reconciled with the durable Replica head",
        )),
    }
}

fn stage_catalog_install(
    catalog: &DeviceCatalogDocument,
    account_id: AccountId,
    incarnation: crate::protocol::Incarnation,
    expected_active_incarnation: Option<crate::protocol::Incarnation>,
) -> Result<DeviceCatalogDocument, RuntimeError> {
    let mut accounts = catalog.accounts.clone();
    let pending = PendingAccountInstallIntent {
        incarnation,
        expected_active_incarnation: expected_active_incarnation.clone(),
    };
    match accounts
        .iter_mut()
        .find(|account| account.account_id == account_id)
    {
        Some(account) => {
            if account.active_incarnation != expected_active_incarnation
                || account.pending_install.is_some()
            {
                return Err(startup_invariant(
                    "catalog Account changed while staging installation",
                ));
            }
            if let Some(expected) = &expected_active_incarnation {
                let retirement = account.pending_retirement.as_ref().ok_or_else(|| {
                    startup_invariant("Account replacement requires its retirement intent")
                })?;
                if &retirement.incarnation != expected
                    || retirement.purpose
                        != crate::platform_storage::AccountRetirementPurpose::Replace
                {
                    return Err(startup_invariant(
                        "Account replacement has another retirement intent",
                    ));
                }
            }
            // One catalog write consumes Replace into the next durable lifecycle state.
            account.pending_retirement = None;
            account.pending_install = Some(pending);
        }
        None => accounts.push(DeviceCatalogAccount {
            account_id,
            active_incarnation: None,
            pending_retirement: None,
            pending_install: Some(pending),
        }),
    }
    catalog.with_accounts(accounts)
}

fn promote_catalog_install(
    staged: &DeviceCatalogDocument,
    account_id: &AccountId,
    incarnation: &crate::protocol::Incarnation,
) -> Result<DeviceCatalogDocument, RuntimeError> {
    let mut accounts = staged.accounts.clone();
    let account = accounts
        .iter_mut()
        .find(|account| &account.account_id == account_id)
        .ok_or_else(|| startup_invariant("staged catalog Account disappeared"))?;
    if account
        .pending_install
        .as_ref()
        .is_none_or(|pending| &pending.incarnation != incarnation)
    {
        return Err(startup_invariant(
            "staged catalog Account has another pending incarnation",
        ));
    }
    account.active_incarnation = Some(incarnation.clone());
    account.pending_install = None;
    staged.with_accounts(accounts)
}

fn durable_installation_is_unchanged(
    durable: Option<&crate::replica::ReplicaSnapshot>,
    previous: Option<&crate::replica::ReplicaSnapshot>,
) -> bool {
    durable == previous
}

fn account_presentation(
    metadata: &crate::platform_storage::AccountMetadataDocument,
) -> AccountPresentation {
    AccountPresentation {
        identity: AccountDisplayIdentity {
            email: metadata.email.clone(),
            name: metadata.name.clone(),
            team_name: metadata.team_name.clone(),
            team_avatar_url: metadata.team_avatar_url.clone(),
            server_url: metadata.normalized_server_url.clone(),
            secret_key_hint: metadata.secret_key_hint.clone(),
        },
        native_only: metadata.native_only,
        verified_travel_mode: metadata.verified_travel_mode.clone(),
    }
}

fn finish_generation_fence(token: Option<Arc<DeliveryToken>>) {
    if let Some(token) = token {
        token.wait_for_other_threads();
    }
}

/// The Vaults of the active Bootstrap generation, in the order a host can rely on.
///
/// This reads authority the Account already holds, so it needs no key and no decryption: a Vault
/// name has never been ciphertext. Nothing else is copied out of the authority record.
fn visible_vaults(snapshot: &ReplicaSnapshot) -> Vec<VaultProjection> {
    let Some(generation) = snapshot.bootstrap.active_generation.clone() else {
        return Vec::new();
    };
    let mut vaults: Vec<_> = snapshot
        .bootstrap
        .vaults
        .iter()
        .filter(|((vault_generation, _), _)| vault_generation == &generation)
        .map(|(_, vault)| VaultProjection {
            vault_id: vault.id.clone(),
            name: vault.name.clone(),
            vault_type: match vault.vault_type {
                AuthorityVaultType::Personal => VaultProjectionType::Personal,
                AuthorityVaultType::Team => VaultProjectionType::Team,
            },
            icon: vault.icon.clone(),
            image_url: vault.image_url.clone(),
            role: match vault.role {
                AuthorityVaultRole::Owner => VaultProjectionRole::Owner,
                AuthorityVaultRole::Admin => VaultProjectionRole::Admin,
                AuthorityVaultRole::Member => VaultProjectionRole::Member,
                AuthorityVaultRole::ReadOnly => VaultProjectionRole::ReadOnly,
            },
        })
        .collect();
    vaults.sort_by(|left, right| left.vault_id.cmp(&right.vault_id));
    vaults
}

fn startup_invariant(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn quick_unlock_material_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Stored Quick Unlock material is unavailable",
    )
}

pub struct ObservationHandle {
    id: u64,
    runtime: Weak<Runtime>,
    subscription: Arc<Subscription>,
    closed: AtomicBool,
}

impl ObservationHandle {
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(runtime) = self.runtime.upgrade() {
            runtime
                .observers
                .lock()
                .expect("observer lock poisoned")
                .remove(&self.id);
        }
        self.subscription.close();
        self.subscription.close_vault_export();
    }
}

impl Drop for ObservationHandle {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod startup_tests;

mod vault_export;

#[cfg(test)]
mod authenticated_installation_tests;
