use crate::{
    protocol::Incarnation, AccountId, RequestCancellation, RuntimeError, RuntimeErrorCode,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

type ScopeKey = (AccountId, Option<Incarnation>);
#[cfg(test)]
type PublicationAdmissionHook = Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>;
#[cfg(test)]
type FinalizationAdmissionHook = Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>;

#[derive(Default)]
pub(super) struct ForegroundAttachmentRegistry {
    state: Arc<Mutex<RegistryState>>,
    #[cfg(test)]
    before_publication_admission: PublicationAdmissionHook,
    #[cfg(test)]
    before_finalization_admission: FinalizationAdmissionHook,
}

#[derive(Default)]
struct RegistryState {
    scopes: HashMap<ScopeKey, Arc<ForegroundAttachmentScope>>,
    account_fences: HashMap<AccountId, usize>,
    global_fences: usize,
}

#[derive(Default)]
struct ForegroundAttachmentScope {
    state: Mutex<ScopeState>,
    drained: tokio::sync::Notify,
}

#[derive(Default)]
struct ScopeState {
    next_id: u64,
    active: HashMap<u64, RequestCancellation>,
    publications: usize,
    publication_fenced: bool,
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

pub(super) struct DeviceForegroundRetirement<'a> {
    registry: &'a ForegroundAttachmentRegistry,
    scopes: Vec<Arc<ForegroundAttachmentScope>>,
}

impl ForegroundAttachmentRegistry {
    pub(super) fn register(
        &self,
        account_id: &AccountId,
        incarnation: &Incarnation,
        cancellation: RequestCancellation,
    ) -> Result<ForegroundAttachmentGuard, RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        if registry.global_fences > 0
            || registry
                .account_fences
                .get(account_id)
                .copied()
                .unwrap_or(0)
                > 0
        {
            return Err(cancelled());
        }
        self.register_scope(
            account_id,
            Some(incarnation.clone()),
            cancellation,
            &mut registry,
        )
    }

    /// Tracks a claimed foreground capability for an Account that currently has no Replica
    /// incarnation. The host capability still carries the Runtime incarnation; this unresolved
    /// Core scope exists only so Account and Device lifecycle can cancel and drain its begin.
    pub(super) fn register_unresolved(
        &self,
        account_id: &AccountId,
        cancellation: RequestCancellation,
    ) -> Result<ForegroundAttachmentGuard, RuntimeError> {
        let mut registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        if registry.global_fences > 0
            || registry
                .account_fences
                .get(account_id)
                .copied()
                .unwrap_or(0)
                > 0
        {
            return Err(cancelled());
        }
        self.register_scope(account_id, None, cancellation, &mut registry)
    }

    fn register_scope(
        &self,
        account_id: &AccountId,
        incarnation: Option<Incarnation>,
        cancellation: RequestCancellation,
        registry: &mut RegistryState,
    ) -> Result<ForegroundAttachmentGuard, RuntimeError> {
        let key = (account_id.clone(), incarnation);
        let scope = registry.scopes.entry(key.clone()).or_default().clone();
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
        state.active.insert(id, cancellation);
        drop(state);
        Ok(ForegroundAttachmentGuard {
            registry: Arc::clone(&self.state),
            key,
            scope,
            id,
        })
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
            let scopes = registry
                .scopes
                .iter()
                .filter(|((candidate, _), _)| candidate == account_id)
                .map(|(_, scope)| Arc::clone(scope))
                .collect::<Vec<_>>();
            fence_scopes(&scopes);
            scopes
        };
        cancel_scopes(&scopes);
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
            let scopes = registry.scopes.values().cloned().collect::<Vec<_>>();
            fence_scopes(&scopes);
            scopes
        };
        cancel_scopes(&scopes);
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
            let scopes = registry.scopes.values().cloned().collect::<Vec<_>>();
            fence_scopes(&scopes);
            scopes
        };
        cancel_scopes(&scopes);
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

    /// Atomically admits an irreversible foreground sink finalization against Account and Device
    /// lifecycle intent. The request's existing guard remains active across the admitted callback,
    /// so a lifecycle that loses this race drains it before retiring keys or authority.
    pub(super) fn admit_finalization(
        &self,
        guard: &ForegroundAttachmentGuard,
        cancellation: &RequestCancellation,
    ) -> bool {
        #[cfg(test)]
        if let Some(hook) = self
            .before_finalization_admission
            .lock()
            .expect("foreground Attachment finalization hook lock poisoned")
            .clone()
        {
            hook();
        }
        let registry = self
            .state
            .lock()
            .expect("foreground Attachment registry lock poisoned");
        let state = guard
            .scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned");
        registry.global_fences == 0 && !state.publication_fenced && !cancellation.is_cancelled()
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
    /// Linearizes callback begin against lifecycle intent. Once admitted, the callback owns only
    /// copied projection and observer data, so lifecycle neither waits for it nor holds this lock
    /// while host code runs.
    pub(super) fn begin(&self) -> bool {
        #[cfg(test)]
        if let Some(hook) = self
            .before_admission
            .lock()
            .expect("foreground Attachment publication hook lock poisoned")
            .clone()
        {
            hook();
        }
        let state = self
            .scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned");
        !state.publication_fenced
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

impl AccountForegroundRetirement<'_> {
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
            registry.scopes.retain(|(account_id, _), scope| {
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

#[cfg(test)]
impl ForegroundAttachmentRegistry {
    pub(super) fn scope_count(&self) -> usize {
        self.state
            .lock()
            .expect("foreground Attachment registry lock poisoned")
            .scopes
            .len()
    }
}

fn cancel_scopes(scopes: &[Arc<ForegroundAttachmentScope>]) {
    let cancellations = scopes
        .iter()
        .flat_map(|scope| {
            scope
                .state
                .lock()
                .expect("foreground Attachment scope lock poisoned")
                .active
                .values()
                .cloned()
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

async fn drain_scopes(scopes: &[Arc<ForegroundAttachmentScope>]) {
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

fn cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "foreground Attachment work was cancelled by Account lifecycle",
    )
}
