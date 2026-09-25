//! OS-selected Vault image handles; Core owns image validation and durable acceptance policy.
use async_trait::async_trait;
use bittery_client_core::{
    AccountId, RequestCancellation, VaultImageSource, VaultImageSourceError as SourceError,
    VaultImageSourceGrant, VaultImageSourceInput, VaultImageSourcePort, VAULT_IMAGE_CHUNK_BYTES,
};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom},
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Notify;
use zeroize::Zeroizing;

pub(super) struct NativeVaultImageSources(Arc<Inner>);
struct Inner {
    incarnation: String,
    state: Mutex<State>,
    changed: Notify,
}
#[derive(Default)]
struct State {
    closed: bool,
    callers: HashSet<String>,
    accounts: HashMap<AccountId, Epoch>,
    vaults: HashMap<(AccountId, String), VaultEpoch>,
    entries: HashMap<String, Entry>,
    closed_sources: HashMap<String, ClosedSource>,
}
struct Epoch {
    identity: String,
    retiring: bool,
    retired: bool,
    acceptances: HashMap<String, BoundVault>,
}
struct VaultEpoch {
    identity: String,
    retired: bool,
    drained: bool,
}
#[derive(Clone)]
struct BoundVault {
    id: String,
    epoch: String,
}
fn vault_epoch() -> VaultEpoch {
    VaultEpoch {
        identity: identity(),
        retired: false,
        drained: false,
    }
}
struct Entry {
    source: Arc<SelectedFile>,
    operation: Option<String>,
}
struct ClosedSource {
    scope: VaultImageFileScope,
    operation: String,
}
struct SelectedFile {
    scope: VaultImageFileScope,
    content_type: String,
    byte_length: u64,
    file: Mutex<Option<File>>,
    cancelled: RequestCancellation,
}
#[derive(Clone)]
pub(super) struct VaultImageFileScope {
    account: AccountId,
    epoch: String,
    caller: String,
    vault: Option<BoundVault>,
}
pub(super) struct VaultImageCaller {
    identity: String,
    registry: Weak<Inner>,
}
fn identity() -> String {
    bittery_crypto_core::generate_uuid()
}
fn epoch() -> Epoch {
    Epoch {
        identity: identity(),
        retiring: false,
        retired: false,
        acceptances: HashMap::new(),
    }
}
fn valid(state: &State, scope: &VaultImageFileScope) -> bool {
    !state.closed
        && state.callers.contains(&scope.caller)
        && state.accounts.get(&scope.account).is_some_and(|account| {
            !account.retiring && !account.retired && account.identity == scope.epoch
        })
        && scope.vault.as_ref().is_none_or(|bound| {
            state
                .vaults
                .get(&(scope.account.clone(), bound.id.clone()))
                .is_some_and(|epoch| !epoch.retired && epoch.identity == bound.epoch)
        })
}
fn targeted(
    scope: &VaultImageFileScope,
    account: &AccountId,
    targets: &HashMap<String, String>,
) -> bool {
    &scope.account == account
        && scope
            .vault
            .as_ref()
            .is_some_and(|bound| targets.get(&bound.id) == Some(&bound.epoch))
}
impl Drop for VaultImageCaller {
    fn drop(&mut self) {
        if let Some(inner) = self.registry.upgrade() {
            let mut state = inner.state.lock().expect("Vault image registry poisoned");
            state.callers.remove(&self.identity);
            state.entries.retain(|_, entry| {
                if entry.source.scope.caller != self.identity {
                    return true;
                }
                entry.source.cancelled.cancel();
                entry.operation.is_some()
            });
            state
                .closed_sources
                .retain(|_, entry| entry.scope.caller != self.identity);
            inner.changed.notify_waiters();
        }
    }
}
impl NativeVaultImageSources {
    pub(super) fn new(runtime_incarnation: impl Into<String>) -> Result<Self, SourceError> {
        let incarnation = runtime_incarnation.into();
        if incarnation.is_empty() {
            return Err(SourceError::Invariant);
        }
        Ok(Self(Arc::new(Inner {
            incarnation,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        })))
    }
    pub(super) fn caller(&self) -> Result<VaultImageCaller, SourceError> {
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        if state.closed {
            return Err(SourceError::Cancelled);
        }
        let identity = identity();
        state.callers.insert(identity.clone());
        Ok(VaultImageCaller {
            identity,
            registry: Arc::downgrade(&self.0),
        })
    }
    pub(super) fn scope(
        &self,
        caller: &VaultImageCaller,
        account: AccountId,
    ) -> Result<VaultImageFileScope, SourceError> {
        if !Weak::ptr_eq(&caller.registry, &Arc::downgrade(&self.0)) || account.as_str().is_empty()
        {
            return Err(SourceError::Invariant);
        }
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        if state.closed || !state.callers.contains(&caller.identity) {
            return Err(SourceError::Cancelled);
        }
        let current = state.accounts.entry(account.clone()).or_insert_with(epoch);
        if current.retiring || current.retired {
            return Err(SourceError::Cancelled);
        }
        Ok(VaultImageFileScope {
            account,
            epoch: current.identity.clone(),
            caller: caller.identity.clone(),
            vault: None,
        })
    }
    /// Capture a known Update Vault before opening the platform picker. Create uses `scope` until
    /// Core supplies its new Vault identity at claim; an unrelated retirement cannot invent it.
    pub(super) fn scope_for_vault(
        &self,
        caller: &VaultImageCaller,
        account: AccountId,
        vault_id: &str,
    ) -> Result<VaultImageFileScope, SourceError> {
        if vault_id.is_empty() {
            return Err(SourceError::Invariant);
        }
        let mut scope = self.scope(caller, account.clone())?;
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        if !valid(&state, &scope) {
            return Err(SourceError::Cancelled);
        }
        let current = state
            .vaults
            .entry((account, vault_id.into()))
            .or_insert_with(vault_epoch);
        if current.retired {
            return Err(SourceError::Cancelled);
        }
        scope.vault = Some(BoundVault {
            id: vault_id.into(),
            epoch: current.identity.clone(),
        });
        Ok(scope)
    }
    async fn retire_vaults(
        &self,
        incarnation: &str,
        account: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), SourceError> {
        self.check_incarnation(incarnation)?;
        if account.as_str().is_empty() || vault_ids.iter().any(String::is_empty) {
            return Err(SourceError::Invariant);
        }
        let targets = {
            let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
            let mut targets = HashMap::new();
            for vault in vault_ids {
                let epoch = state
                    .vaults
                    .entry((account.clone(), vault.clone()))
                    .or_insert_with(vault_epoch);
                epoch.retired = true;
                targets.insert(vault.clone(), epoch.identity.clone());
            }
            state.entries.retain(|_, entry| {
                if !targeted(&entry.source.scope, account, &targets) {
                    return true;
                }
                entry.source.cancelled.cancel();
                entry.operation.is_some()
            });
            state
                .closed_sources
                .retain(|_, entry| !targeted(&entry.scope, account, &targets));
            targets
        };
        loop {
            let changed = self.0.changed.notified();
            {
                let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
                let sources_pending = state
                    .entries
                    .values()
                    .any(|entry| targeted(&entry.source.scope, account, &targets));
                let acceptance_pending = state.accounts.get(account).is_some_and(|epoch| {
                    epoch
                        .acceptances
                        .values()
                        .any(|bound| targets.get(&bound.id) == Some(&bound.epoch))
                });
                if !sources_pending && !acceptance_pending {
                    for (vault, identity) in &targets {
                        if let Some(epoch) = state.vaults.get_mut(&(account.clone(), vault.clone()))
                        {
                            if &epoch.identity == identity {
                                epoch.drained = true;
                            }
                        }
                    }
                    return Ok(());
                }
            }
            changed.await;
        }
    }
    fn complete_vault_retirement(
        &self,
        incarnation: &str,
        account: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), SourceError> {
        self.check_incarnation(incarnation)?;
        if account.as_str().is_empty() || vault_ids.iter().any(String::is_empty) {
            return Err(SourceError::Invariant);
        }
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        if state.closed
            || state
                .accounts
                .get(account)
                .is_some_and(|epoch| epoch.retiring || epoch.retired)
        {
            return Err(SourceError::Cancelled);
        }
        if vault_ids.iter().any(|vault| {
            state
                .vaults
                .get(&(account.clone(), vault.clone()))
                .is_some_and(|epoch| epoch.retired && !epoch.drained)
        }) {
            return Err(SourceError::Source);
        }
        for vault in vault_ids {
            if let Some(epoch) = state.vaults.get_mut(&(account.clone(), vault.clone())) {
                if epoch.retired {
                    *epoch = vault_epoch();
                }
            }
        }
        Ok(())
    }
    pub(super) fn grant(
        &self,
        scope: VaultImageFileScope,
        content_type: String,
        mut file: File,
    ) -> Result<VaultImageSourceInput, SourceError> {
        let metadata = file.metadata().map_err(|_| SourceError::Source)?;
        if !metadata.is_file() {
            return Err(SourceError::Source);
        }
        file.seek(SeekFrom::Start(0))
            .map_err(|_| SourceError::Source)?;
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        if !valid(&state, &scope) {
            return Err(SourceError::Cancelled);
        }
        let capability_id = identity();
        let input = VaultImageSourceInput {
            capability_id: capability_id.clone(),
            content_type: content_type.clone(),
            byte_length: metadata.len(),
        };
        state.entries.insert(
            capability_id,
            Entry {
                operation: None,
                source: Arc::new(SelectedFile {
                    scope,
                    content_type,
                    byte_length: metadata.len(),
                    file: Mutex::new(Some(file)),
                    cancelled: RequestCancellation::new(),
                }),
            },
        );
        Ok(input)
    }
    /// Release a settled or abandoned host selection. A begun Core acceptance keeps its lease.
    pub(super) fn release(
        &self,
        caller: &VaultImageCaller,
        capability_id: &str,
    ) -> Result<(), SourceError> {
        if !Weak::ptr_eq(&caller.registry, &Arc::downgrade(&self.0)) {
            return Err(SourceError::Invariant);
        }
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        if let Some(entry) = state.entries.get(capability_id) {
            if entry.source.scope.caller != caller.identity {
                return Err(SourceError::Invariant);
            }
            entry.source.cancelled.cancel();
            if entry.operation.is_none() {
                state.entries.remove(capability_id);
            }
        }
        if let Some(entry) = state.closed_sources.get(capability_id) {
            if entry.scope.caller != caller.identity {
                return Err(SourceError::Invariant);
            }
            state.closed_sources.remove(capability_id);
        }
        self.0.changed.notify_waiters();
        Ok(())
    }
    fn check_incarnation(&self, incarnation: &str) -> Result<(), SourceError> {
        if incarnation == self.0.incarnation {
            Ok(())
        } else {
            Err(SourceError::Invariant)
        }
    }
}
// The final lease includes any blocking read, including a read whose awaiting caller disappeared.
// Keeping the claimed entry until then lets retirement drain real work before artifact deletion.
struct SourceLease {
    registry: Weak<Inner>,
    capability: String,
}
impl Drop for SourceLease {
    fn drop(&mut self) {
        if let Some(inner) = self.registry.upgrade() {
            let mut state = inner.state.lock().expect("Vault image registry poisoned");
            if let Some(entry) = state.entries.remove(&self.capability) {
                // Final read leases drop after releasing their IO mutex. Close the OS handle
                // before notifying retirement, even if the worker still holds its source Arc.
                entry
                    .source
                    .file
                    .lock()
                    .expect("Vault image source poisoned")
                    .take();
                if !entry.source.cancelled.is_cancelled() && valid(&state, &entry.source.scope) {
                    if let Some(operation) = entry.operation {
                        state.closed_sources.insert(
                            self.capability.clone(),
                            ClosedSource {
                                scope: entry.source.scope.clone(),
                                operation,
                            },
                        );
                    }
                }
            }
            inner.changed.notify_waiters();
        }
    }
}
struct SourceHandle {
    source: Arc<SelectedFile>,
    lease: Option<Arc<SourceLease>>,
}
impl Drop for SourceHandle {
    fn drop(&mut self) {
        if self.lease.is_some() {
            self.source.cancelled.cancel();
        }
    }
}
struct ReadGuard(Option<RequestCancellation>);
impl Drop for ReadGuard {
    fn drop(&mut self) {
        if let Some(cancelled) = self.0.take() {
            cancelled.cancel();
        }
    }
}
#[async_trait]
impl VaultImageSource for SourceHandle {
    async fn next_chunk(&mut self, max_bytes: usize) -> Result<Option<Vec<u8>>, SourceError> {
        if max_bytes == 0 || max_bytes > VAULT_IMAGE_CHUNK_BYTES {
            return Err(SourceError::Invariant);
        }
        let lease = self.lease.as_ref().ok_or(SourceError::Cancelled)?.clone();
        let source = self.source.clone();
        let mut guard = ReadGuard(Some(source.cancelled.clone()));
        let result = tokio::task::spawn_blocking(move || {
            let _lease = lease;
            let mut slot = source.file.lock().map_err(|_| SourceError::Source)?;
            if source.cancelled.is_cancelled() {
                return Err(SourceError::Cancelled);
            }
            let file = slot.as_mut().ok_or(SourceError::Cancelled)?;
            let mut bytes = Zeroizing::new(vec![0; max_bytes]);
            let mut length = 0;
            while length < max_bytes {
                match file.read(&mut bytes[length..]) {
                    Ok(0) => break,
                    Ok(count) => length += count,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => return Err(SourceError::Source),
                }
            }
            if source.cancelled.is_cancelled() {
                return Err(SourceError::Cancelled);
            }
            bytes.truncate(length);
            Ok(if length == 0 { None } else { Some(bytes) })
        })
        .await
        .map_err(|_| SourceError::Source)?;
        guard.0.take();
        result.map(|bytes| bytes.map(|mut bytes| std::mem::take(&mut *bytes)))
    }
    async fn close(&mut self) -> Result<(), SourceError> {
        let Some(lease) = self.lease.as_ref().cloned() else {
            return Ok(());
        };
        let source = self.source.clone();
        tokio::task::spawn_blocking(move || {
            let _lease = lease;
            source.file.lock().map_err(|_| SourceError::Source)?.take();
            Ok::<_, SourceError>(())
        })
        .await
        .map_err(|_| SourceError::Source)??;
        self.lease.take();
        Ok(())
    }
}
#[async_trait]
impl VaultImageSourcePort for NativeVaultImageSources {
    async fn claim(
        &self,
        grant: &VaultImageSourceGrant,
    ) -> Result<Box<dyn VaultImageSource>, SourceError> {
        self.check_incarnation(&grant.runtime_incarnation)?;
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        let entry = state
            .entries
            .get(&grant.capability_id)
            .ok_or(SourceError::Invariant)?;
        if !valid(&state, &entry.source.scope) {
            return Err(SourceError::Cancelled);
        }
        if entry.operation.is_some()
            || grant.operation_id.is_empty()
            || grant.vault_id.is_empty()
            || entry
                .source
                .scope
                .vault
                .as_ref()
                .is_some_and(|bound| bound.id != grant.vault_id)
            || entry.source.scope.account != grant.account_id
            || entry.source.content_type != grant.content_type
            || entry.source.byte_length != grant.byte_length
        {
            return Err(SourceError::Invariant);
        }
        let epoch = state
            .vaults
            .entry((grant.account_id.clone(), grant.vault_id.clone()))
            .or_insert_with(vault_epoch);
        if epoch.retired {
            return Err(SourceError::Cancelled);
        }
        let bound = BoundVault {
            id: grant.vault_id.clone(),
            epoch: epoch.identity.clone(),
        };
        let entry = state
            .entries
            .get_mut(&grant.capability_id)
            .expect("checked entry");
        // No source loan exists before a single successful claim; the original picker scope is
        // checked above and the claimed source now retains the exact Core-supplied Vault.
        Arc::get_mut(&mut entry.source)
            .ok_or(SourceError::Invariant)?
            .scope
            .vault = Some(bound);
        entry.operation = Some(grant.operation_id.clone());
        Ok(Box::new(SourceHandle {
            source: entry.source.clone(),
            lease: Some(Arc::new(SourceLease {
                registry: Arc::downgrade(&self.0),
                capability: grant.capability_id.clone(),
            })),
        }))
    }
    async fn retire_account(
        &self,
        incarnation: &str,
        account: &AccountId,
    ) -> Result<(), SourceError> {
        self.check_incarnation(incarnation)?;
        let retiring_epoch = {
            let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
            let current = state.accounts.entry(account.clone()).or_insert_with(epoch);
            current.retiring = true;
            let retiring_epoch = current.identity.clone();
            state.entries.retain(|_, entry| {
                if &entry.source.scope.account != account {
                    return true;
                }
                entry.source.cancelled.cancel();
                entry.operation.is_some()
            });
            state
                .closed_sources
                .retain(|_, entry| &entry.scope.account != account);
            retiring_epoch
        };
        loop {
            let changed = self.0.changed.notified();
            {
                let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
                // An earlier concurrent retirement may already have completed this generation.
                if state
                    .accounts
                    .get(account)
                    .is_none_or(|current| current.identity != retiring_epoch)
                {
                    return Ok(());
                }
                if !state
                    .entries
                    .values()
                    .any(|entry| &entry.source.scope.account == account)
                    && state
                        .accounts
                        .get(account)
                        .is_none_or(|entry| entry.acceptances.is_empty())
                {
                    let current = state.accounts.get_mut(account).expect("retiring account");
                    current.retired = true;
                    return Ok(());
                }
            }
            changed.await;
        }
    }
    async fn complete_account_retirement(
        &self,
        incarnation: &str,
        account: &AccountId,
    ) -> Result<(), SourceError> {
        self.check_incarnation(incarnation)?;
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        if state.closed {
            return Err(SourceError::Cancelled);
        }
        let current = state
            .accounts
            .get_mut(account)
            .ok_or(SourceError::Invariant)?;
        if !current.retired {
            return Err(SourceError::Invariant);
        }
        *current = epoch();
        Ok(())
    }
    async fn begin_acceptance(
        &self,
        incarnation: &str,
        account: &AccountId,
        operation: &str,
    ) -> Result<(), SourceError> {
        self.check_incarnation(incarnation)?;
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        let bound = state
            .closed_sources
            .values()
            .find(|entry| {
                &entry.scope.account == account
                    && entry.operation == operation
                    && valid(&state, &entry.scope)
            })
            .and_then(|entry| entry.scope.vault.clone())
            .ok_or(SourceError::Cancelled)?;
        let acceptances = &mut state
            .accounts
            .get_mut(account)
            .ok_or(SourceError::Invariant)?
            .acceptances;
        if acceptances.contains_key(operation) {
            return Err(SourceError::Invariant);
        }
        acceptances.insert(operation.into(), bound);
        Ok(())
    }
    async fn end_acceptance(
        &self,
        incarnation: &str,
        account: &AccountId,
        operation: &str,
    ) -> Result<(), SourceError> {
        self.check_incarnation(incarnation)?;
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        if let Some(current) = state.accounts.get_mut(account) {
            current.acceptances.remove(operation);
        }
        state
            .closed_sources
            .retain(|_, entry| &entry.scope.account != account || entry.operation != operation);
        self.0.changed.notify_waiters();
        Ok(())
    }
    async fn retire_vaults(
        &self,
        incarnation: &str,
        account: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), SourceError> {
        NativeVaultImageSources::retire_vaults(self, incarnation, account, vault_ids).await
    }
    async fn complete_vault_retirement(
        &self,
        incarnation: &str,
        account: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), SourceError> {
        NativeVaultImageSources::complete_vault_retirement(self, incarnation, account, vault_ids)
    }
    async fn forget_account_vault_retirements(
        &self,
        incarnation: &str,
        account: &AccountId,
    ) -> Result<(), SourceError> {
        self.check_incarnation(incarnation)?;
        let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
        if !state
            .accounts
            .get(account)
            .is_some_and(|epoch| epoch.retired && epoch.acceptances.is_empty())
            || state
                .entries
                .values()
                .any(|entry| &entry.source.scope.account == account)
        {
            return Err(SourceError::Invariant);
        }
        state
            .vaults
            .retain(|(candidate, _), _| candidate != account);
        Ok(())
    }
    async fn retire_runtime(&self, incarnation: &str) -> Result<(), SourceError> {
        self.check_incarnation(incarnation)?;
        let accounts = {
            let mut state = self.0.state.lock().map_err(|_| SourceError::Source)?;
            state.closed = true;
            state.callers.clear();
            // Fence every Account before awaiting any one Account's outstanding lease.
            for entry in state.entries.values() {
                entry.source.cancelled.cancel();
            }
            state.accounts.keys().cloned().collect::<Vec<_>>()
        };
        for account in accounts {
            self.retire_account(incarnation, &account).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bittery_client_core::{
        AccountId, RequestCancellation, SqliteVaultImageArtifactStore, VaultImageArtifactPort,
        VaultImageIngressFacade, VaultImageSourceGrant,
    };
    use std::{fs::File, sync::Arc};

    #[tokio::test]
    async fn selected_file_crosses_core_ingress_and_reopens_from_real_sqlite() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("selected.gif");
        let bytes = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b";
        std::fs::write(&path, bytes).unwrap();
        let sources = Arc::new(NativeVaultImageSources::new("runtime-a").unwrap());
        let caller = sources.caller().unwrap();
        let scope = sources
            .scope(&caller, AccountId::from("account-a"))
            .unwrap();
        let selection = sources
            .grant(scope, "image/gif".into(), File::open(path).unwrap())
            .unwrap();
        let sqlite = directory.path().join("vault-images.sqlite");
        let store = Arc::new(SqliteVaultImageArtifactStore::open(&sqlite).unwrap());
        let facade =
            VaultImageIngressFacade::new("runtime-a", sources.clone(), store.clone()).unwrap();
        let grant = VaultImageSourceGrant {
            runtime_incarnation: "runtime-a".into(),
            account_id: AccountId::from("account-a"),
            operation_id: "operation-a".into(),
            vault_id: "vault-a".into(),
            capability_id: selection.capability_id,
            content_type: selection.content_type,
            byte_length: selection.byte_length,
        };
        let prepared = facade
            .prepare(grant, &RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(prepared.metadata().byte_length(), bytes.len() as u64);
        assert_eq!(prepared.metadata().content_type(), "image/gif");
        drop(facade);
        drop(store);
        let reopened = SqliteVaultImageArtifactStore::open(sqlite).unwrap();
        assert_eq!(
            reopened
                .read_chunk(prepared.metadata(), 0)
                .await
                .unwrap()
                .unwrap(),
            bytes
        );
        assert_eq!(
            reopened.read_chunk(prepared.metadata(), 1).await.unwrap(),
            None
        );
    }
    fn selected(
        sources: &NativeVaultImageSources,
        caller: &VaultImageCaller,
        account: &str,
        bytes: &[u8],
    ) -> VaultImageSourceGrant {
        use std::io::{Seek, Write};
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(bytes).unwrap();
        file.rewind().unwrap();
        let scope = sources.scope(caller, AccountId::from(account)).unwrap();
        let input = sources.grant(scope, "image/gif".into(), file).unwrap();
        VaultImageSourceGrant {
            runtime_incarnation: "runtime-a".into(),
            account_id: AccountId::from(account),
            operation_id: identity(),
            vault_id: "vault-a".into(),
            capability_id: input.capability_id,
            content_type: input.content_type,
            byte_length: input.byte_length,
        }
    }
    #[tokio::test]
    async fn exact_binding_single_claim_and_bounded_reads() {
        let sources = NativeVaultImageSources::new("runtime-a").unwrap();
        let caller = sources.caller().unwrap();
        let bytes = vec![7; VAULT_IMAGE_CHUNK_BYTES + 19];
        let grant = selected(&sources, &caller, "a", &bytes);
        let mut wrong = grant.clone();
        wrong.account_id = AccountId::from("b");
        assert!(matches!(
            sources.claim(&wrong).await,
            Err(SourceError::Invariant)
        ));
        wrong = grant.clone();
        wrong.runtime_incarnation = "runtime-b".into();
        assert!(matches!(
            sources.claim(&wrong).await,
            Err(SourceError::Invariant)
        ));
        wrong = grant.clone();
        wrong.content_type = "image/png".into();
        assert!(matches!(
            sources.claim(&wrong).await,
            Err(SourceError::Invariant)
        ));
        wrong = grant.clone();
        wrong.byte_length += 1;
        assert!(matches!(
            sources.claim(&wrong).await,
            Err(SourceError::Invariant)
        ));
        let mut source = sources.claim(&grant).await.unwrap();
        assert!(sources.claim(&grant).await.is_err());
        assert_eq!(source.next_chunk(0).await, Err(SourceError::Invariant));
        assert_eq!(
            source.next_chunk(VAULT_IMAGE_CHUNK_BYTES + 1).await,
            Err(SourceError::Invariant)
        );
        assert_eq!(
            source
                .next_chunk(VAULT_IMAGE_CHUNK_BYTES)
                .await
                .unwrap()
                .unwrap(),
            bytes[..VAULT_IMAGE_CHUNK_BYTES]
        );
        assert_eq!(
            source
                .next_chunk(VAULT_IMAGE_CHUNK_BYTES)
                .await
                .unwrap()
                .unwrap(),
            bytes[VAULT_IMAGE_CHUNK_BYTES..]
        );
        assert_eq!(source.next_chunk(1).await.unwrap(), None);
        source.close().await.unwrap();
        source.close().await.unwrap();
        assert_eq!(source.next_chunk(1).await, Err(SourceError::Cancelled));
        assert!(sources.claim(&grant).await.is_err());
    }
    #[tokio::test]
    async fn retirement_waits_for_claim_and_acceptance_and_rejects_late_dialogs() {
        let sources = Arc::new(NativeVaultImageSources::new("runtime-a").unwrap());
        let caller = sources.caller().unwrap();
        let account = AccountId::from("a");
        let old_scope = sources.scope(&caller, account.clone()).unwrap();
        let grant = selected(&sources, &caller, "a", b"selected");
        let mut source = sources.claim(&grant).await.unwrap();
        let other = selected(&sources, &caller, "b", b"other-account");
        let retire = {
            let sources = sources.clone();
            let account = account.clone();
            tokio::spawn(async move { sources.retire_account("runtime-a", &account).await })
        };
        while sources.scope(&caller, account.clone()).is_ok() {
            tokio::task::yield_now().await;
        }
        assert!(!retire.is_finished());
        assert_eq!(source.next_chunk(1).await, Err(SourceError::Cancelled));
        assert!(sources.claim(&other).await.is_ok());
        source.close().await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), retire)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        sources
            .complete_account_retirement("runtime-a", &account)
            .await
            .unwrap();
        assert!(matches!(
            sources.grant(old_scope, "image/gif".into(), tempfile::tempfile().unwrap()),
            Err(SourceError::Cancelled)
        ));
        assert!(sources
            .begin_acceptance("runtime-a", &account, &grant.operation_id)
            .await
            .is_err());
        let next = selected(&sources, &caller, "a", b"new");
        sources.claim(&next).await.unwrap().close().await.unwrap();
        sources
            .begin_acceptance("runtime-a", &account, &next.operation_id)
            .await
            .unwrap();
        assert!(sources
            .begin_acceptance("runtime-a", &account, &next.operation_id)
            .await
            .is_err());
        let retire = {
            let sources = sources.clone();
            let account = account.clone();
            tokio::spawn(async move { sources.retire_account("runtime-a", &account).await })
        };
        while sources.scope(&caller, account.clone()).is_ok() {
            tokio::task::yield_now().await;
        }
        assert!(!retire.is_finished());
        sources
            .end_acceptance("runtime-a", &account, &next.operation_id)
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), retire)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
    #[tokio::test]
    async fn caller_loss_and_runtime_retirement_fence_old_capabilities() {
        let sources = NativeVaultImageSources::new("runtime-a").unwrap();
        let caller = sources.caller().unwrap();
        let scope = sources.scope(&caller, AccountId::from("a")).unwrap();
        let grant = selected(&sources, &caller, "a", b"data");
        let mut source = sources.claim(&grant).await.unwrap();
        drop(caller);
        assert_eq!(source.next_chunk(1).await, Err(SourceError::Cancelled));
        assert!(sources
            .grant(scope, "image/gif".into(), tempfile::tempfile().unwrap())
            .is_err());
        drop(source);
        sources.retire_runtime("runtime-a").await.unwrap();
        sources.retire_runtime("runtime-a").await.unwrap();
        assert!(sources.caller().is_err());
        assert!(sources
            .complete_account_retirement("runtime-a", &AccountId::from("a"))
            .await
            .is_err());
    }
    #[test]
    fn dropped_read_keeps_retirement_pending_until_native_worker_releases() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let sources = Arc::new(NativeVaultImageSources::new("runtime-a").unwrap());
            let caller = sources.caller().unwrap();
            let grant = selected(&sources, &caller, "a", b"real selected file");
            let mut source = sources.claim(&grant).await.unwrap();
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let blocked = tokio::task::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            started_rx.await.unwrap();
            let mut read = source.next_chunk(1);
            assert!(matches!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(read.as_mut().poll(cx))).await,
                std::task::Poll::Pending
            ));
            drop(read);
            drop(source);
            let retire = {
                let sources = sources.clone();
                tokio::spawn(async move {
                    sources
                        .retire_account("runtime-a", &AccountId::from("a"))
                        .await
                })
            };
            while sources.scope(&caller, AccountId::from("a")).is_ok() {
                tokio::task::yield_now().await;
            }
            let was_pending = !retire.is_finished();
            release_tx.send(()).unwrap();
            blocked.await.unwrap();
            tokio::time::timeout(std::time::Duration::from_secs(2), retire)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            assert!(
                was_pending,
                "retirement must wait for the dropped read's queued native worker"
            );
        });
    }
    #[tokio::test]
    async fn runtime_retirement_fences_every_account_before_waiting_for_any_claim() {
        let sources = Arc::new(NativeVaultImageSources::new("runtime-a").unwrap());
        let caller = sources.caller().unwrap();
        let a = selected(&sources, &caller, "a", b"a");
        let b = selected(&sources, &caller, "b", b"b");
        let mut a = sources.claim(&a).await.unwrap();
        let mut b = sources.claim(&b).await.unwrap();
        let retirement = {
            let sources = sources.clone();
            tokio::spawn(async move { sources.retire_runtime("runtime-a").await })
        };
        while sources.caller().is_ok() {
            tokio::task::yield_now().await;
        }
        let a_result = a.next_chunk(1).await;
        let b_result = b.next_chunk(1).await;
        drop(a);
        drop(b);
        retirement.await.unwrap().unwrap();
        assert_eq!(a_result, Err(SourceError::Cancelled));
        assert_eq!(b_result, Err(SourceError::Cancelled));
    }
    #[tokio::test]
    async fn repeated_retirement_cannot_retire_a_replacement_account_epoch() {
        let sources = NativeVaultImageSources::new("runtime-a").unwrap();
        let caller = sources.caller().unwrap();
        let account = AccountId::from("a");
        let grant = selected(&sources, &caller, "a", b"a");
        let mut source = sources.claim(&grant).await.unwrap();
        let mut first = sources.retire_account("runtime-a", &account);
        let mut second = sources.retire_account("runtime-a", &account);
        for retirement in [&mut first, &mut second] {
            assert!(matches!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(retirement.as_mut().poll(cx)))
                    .await,
                std::task::Poll::Pending
            ));
        }
        source.close().await.unwrap();
        first.await.unwrap();
        sources
            .complete_account_retirement("runtime-a", &account)
            .await
            .unwrap();
        second.await.unwrap();
        assert!(sources.scope(&caller, account).is_ok());
    }
    #[tokio::test]
    async fn explicit_release_is_caller_scoped_and_preserves_begun_acceptance() {
        let sources = Arc::new(NativeVaultImageSources::new("runtime-a").unwrap());
        let caller = sources.caller().unwrap();
        let foreign = sources.caller().unwrap();
        let grant = selected(&sources, &caller, "a", b"a");
        assert!(sources.release(&foreign, &grant.capability_id).is_err());
        let mut source = sources.claim(&grant).await.unwrap();
        sources.release(&caller, &grant.capability_id).unwrap();
        assert_eq!(source.next_chunk(1).await, Err(SourceError::Cancelled));
        drop(source);
        sources.release(&caller, &grant.capability_id).unwrap();
        let grant = selected(&sources, &caller, "a", b"a");
        sources.claim(&grant).await.unwrap().close().await.unwrap();
        sources
            .begin_acceptance("runtime-a", &grant.account_id, &grant.operation_id)
            .await
            .unwrap();
        sources.release(&caller, &grant.capability_id).unwrap();
        let retirement = {
            let sources = sources.clone();
            tokio::spawn(async move {
                sources
                    .retire_account("runtime-a", &AccountId::from("a"))
                    .await
            })
        };
        while sources.scope(&caller, AccountId::from("a")).is_ok() {
            tokio::task::yield_now().await;
        }
        assert!(!retirement.is_finished());
        sources
            .end_acceptance("runtime-a", &grant.account_id, &grant.operation_id)
            .await
            .unwrap();
        retirement.await.unwrap().unwrap();
    }
    #[tokio::test]
    async fn selective_image_retirement_drains_bound_sources_and_acceptance_but_keeps_other_drafts()
    {
        use std::io::Write;
        let sources = Arc::new(NativeVaultImageSources::new("runtime-a").unwrap());
        let caller = sources.caller().unwrap();
        let account = AccountId::from("a");
        let old_scope = sources
            .scope_for_vault(&caller, account.clone(), "hidden")
            .unwrap();
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"image").unwrap();
        let input = sources
            .grant(old_scope.clone(), "image/gif".into(), file)
            .unwrap();
        let grant = VaultImageSourceGrant {
            runtime_incarnation: "runtime-a".into(),
            account_id: account.clone(),
            operation_id: "hidden-operation".into(),
            vault_id: "hidden".into(),
            capability_id: input.capability_id,
            content_type: input.content_type,
            byte_length: input.byte_length,
        };
        let mut hidden = sources.claim(&grant).await.unwrap();
        let mut visible_grant = selected(&sources, &caller, "a", b"visible");
        visible_grant.vault_id = "visible".into();
        let mut visible = sources.claim(&visible_grant).await.unwrap();
        visible.close().await.unwrap();
        sources
            .begin_acceptance("runtime-a", &account, &visible_grant.operation_id)
            .await
            .unwrap();
        let draft = selected(&sources, &caller, "a", b"unbound draft");
        let other = selected(&sources, &caller, "b", b"other account");
        let retiring = {
            let sources = sources.clone();
            let account = account.clone();
            tokio::spawn(async move {
                sources
                    .retire_vaults("runtime-a", &account, &["hidden".into()])
                    .await
            })
        };
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert!(
            !retiring.is_finished(),
            "selected claimed image must retain its real loan until close"
        );
        assert!(hidden.next_chunk(16).await.is_err());
        assert!(sources
            .scope_for_vault(&caller, account.clone(), "hidden")
            .is_err());
        assert!(sources
            .complete_vault_retirement("runtime-a", &account, &["hidden".into()])
            .is_err());
        hidden.close().await.unwrap();
        retiring.await.unwrap().unwrap();
        assert!(sources
            .begin_acceptance("runtime-a", &account, &grant.operation_id)
            .await
            .is_err());
        assert!(
            sources.claim(&draft).await.is_ok(),
            "unbound Create draft survives unrelated Vault retirement"
        );
        assert!(sources.claim(&other).await.is_ok());
        sources
            .end_acceptance("runtime-a", &account, &visible_grant.operation_id)
            .await
            .unwrap();
        sources
            .complete_vault_retirement("runtime-a", &account, &["hidden".into()])
            .unwrap();
        assert!(sources.scope_for_vault(&caller, account, "hidden").is_ok());
        assert!(sources
            .grant(old_scope, "image/gif".into(), tempfile::tempfile().unwrap())
            .is_err());
    }
    #[tokio::test]
    async fn image_claim_checks_picker_vault_and_selective_retirement_waits_for_begun_acceptance() {
        use std::io::Write;
        let sources = Arc::new(NativeVaultImageSources::new("runtime-a").unwrap());
        let caller = sources.caller().unwrap();
        let account = AccountId::from("a");
        let scope = sources
            .scope_for_vault(&caller, account.clone(), "hidden")
            .unwrap();
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"image").unwrap();
        let input = sources.grant(scope, "image/gif".into(), file).unwrap();
        let mut grant = VaultImageSourceGrant {
            runtime_incarnation: "runtime-a".into(),
            account_id: account.clone(),
            operation_id: "accepted-image".into(),
            vault_id: "other".into(),
            capability_id: input.capability_id,
            content_type: input.content_type,
            byte_length: input.byte_length,
        };
        assert!(
            sources.claim(&grant).await.is_err(),
            "wrong Core Vault cannot consume a prebound picker capability"
        );
        grant.vault_id = "hidden".into();
        let mut source = sources.claim(&grant).await.unwrap();
        source.close().await.unwrap();
        sources
            .begin_acceptance("runtime-a", &account, &grant.operation_id)
            .await
            .unwrap();
        let retiring = {
            let sources = sources.clone();
            let account = account.clone();
            tokio::spawn(async move {
                sources
                    .retire_vaults("runtime-a", &account, &["hidden".into()])
                    .await
            })
        };
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert!(
            !retiring.is_finished(),
            "closed source does not end an already begun Core acceptance"
        );
        sources.release(&caller, &grant.capability_id).unwrap();
        assert!(
            !retiring.is_finished(),
            "host finally cannot release Core acceptance"
        );
        sources
            .end_acceptance("runtime-a", &account, &grant.operation_id)
            .await
            .unwrap();
        retiring.await.unwrap().unwrap();
        sources.retire_account("runtime-a", &account).await.unwrap();
        sources
            .complete_account_retirement("runtime-a", &account)
            .await
            .unwrap();
        assert!(
            sources
                .scope_for_vault(&caller, account.clone(), "hidden")
                .is_err(),
            "ordinary unlock preserves the Vault fence"
        );
        assert!(VaultImageSourcePort::forget_account_vault_retirements(
            sources.as_ref(),
            "runtime-a",
            &account
        )
        .await
        .is_err());
        sources.retire_account("runtime-a", &account).await.unwrap();
        VaultImageSourcePort::forget_account_vault_retirements(
            sources.as_ref(),
            "runtime-a",
            &account,
        )
        .await
        .unwrap();
        sources
            .complete_account_retirement("runtime-a", &account)
            .await
            .unwrap();
        assert!(sources.scope_for_vault(&caller, account, "hidden").is_ok());
    }
}
