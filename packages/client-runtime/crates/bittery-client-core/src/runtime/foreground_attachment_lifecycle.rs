use crate::{
    protocol::Incarnation, AccountId, RequestCancellation, RuntimeError, RuntimeErrorCode,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

type ScopeKey = (AccountId, Incarnation);
#[cfg(test)]
type PublicationAdmissionHook = Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>;

#[derive(Default)]
pub(super) struct ForegroundAttachmentRegistry {
    state: Mutex<RegistryState>,
    #[cfg(test)]
    before_publication_admission: PublicationAdmissionHook,
}

#[derive(Default)]
struct RegistryState {
    scopes: HashMap<ScopeKey, Arc<ForegroundAttachmentScope>>,
    account_fences: HashMap<AccountId, usize>,
    globally_fenced: bool,
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
    publication_fenced: bool,
}

pub(super) struct ForegroundAttachmentGuard {
    scope: Arc<ForegroundAttachmentScope>,
    id: u64,
}

#[derive(Clone)]
pub(super) struct ForegroundAttachmentPublication {
    scope: Arc<ForegroundAttachmentScope>,
    #[cfg(test)]
    before_admission: PublicationAdmissionHook,
}

pub(super) struct AccountForegroundRetirement<'a> {
    registry: &'a ForegroundAttachmentRegistry,
    account_id: AccountId,
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
        if registry.globally_fenced
            || registry
                .account_fences
                .get(account_id)
                .copied()
                .unwrap_or(0)
                > 0
        {
            return Err(cancelled());
        }
        let scope = registry
            .scopes
            .entry((account_id.clone(), incarnation.clone()))
            .or_default()
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
        state.active.insert(id, cancellation);
        drop(state);
        drop(registry);
        Ok(ForegroundAttachmentGuard { scope, id })
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

    pub(super) async fn fence_all_and_drain(&self) {
        let scopes = {
            let mut registry = self
                .state
                .lock()
                .expect("foreground Attachment registry lock poisoned");
            registry.globally_fenced = true;
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
        ForegroundAttachmentPublication {
            scope: Arc::clone(&guard.scope),
            #[cfg(test)]
            before_admission: Arc::clone(&self.before_publication_admission),
        }
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

impl AccountForegroundRetirement<'_> {
    pub(super) async fn drain(&self) {
        drain_scopes(&self.scopes).await;
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
        let mut state = self
            .scope
            .state
            .lock()
            .expect("foreground Attachment scope lock poisoned");
        let removed = state.active.remove(&self.id).is_some();
        let empty = removed && state.active.is_empty();
        drop(state);
        if empty {
            self.scope.drained.notify_waiters();
        }
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
