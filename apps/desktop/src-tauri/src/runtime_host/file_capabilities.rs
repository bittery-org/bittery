//! Opaque OS-selected files. Core owns authorization and verification; this registry owns handles.

use async_trait::async_trait;
use bittery_client_core::{
    AccountId, AttachmentDownloadSink, AttachmentDownloadSinkError as SinkError,
    AttachmentDownloadSinkPort, AttachmentUploadSource, AttachmentUploadSourceError as SourceError,
    AttachmentUploadSourcePort, RequestCancellation, ARTIFACT_CHUNK_BYTES,
};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
};
use zeroize::Zeroize;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct UploadSelection {
    pub account_id: AccountId,
    pub item_id: String,
    pub name: String,
    pub content_type: String,
    pub expected_bytes: u64,
}

/// Captured before opening an OS dialog so a late reply cannot acquire a replacement generation.
#[derive(Clone)]
pub(super) struct FileScope {
    account_id: AccountId,
    epoch: String,
    caller: String,
    vault_id: String,
    vault_epoch: String,
}

#[derive(Default)]
pub(super) struct NativeFileCapabilities(Arc<Mutex<State>>);

#[derive(Default)]
struct State {
    closed: bool,
    callers: HashSet<String>,
    accounts: HashMap<AccountId, Epoch>,
    vaults: HashMap<(AccountId, String), VaultEpoch>,
    entries: HashMap<String, Entry>,
}
struct Epoch {
    identity: String,
    retired: bool,
}
struct VaultEpoch {
    identity: String,
    retired: bool,
    drained: bool,
}
fn vault_epoch() -> VaultEpoch {
    VaultEpoch {
        identity: identity(),
        retired: false,
        drained: false,
    }
}
struct Entry {
    scope: FileScope,
    claimed: bool,
    begun: bool,
    payload: Payload,
}
enum Payload {
    Upload {
        selection: UploadSelection,
        file: File,
        read: u64,
    },
    Download {
        attachment_id: String,
        file: File,
        destination: PathBuf,
    },
}

pub(super) struct FileCaller {
    identity: String,
    registry: Weak<Mutex<State>>,
}
impl Drop for FileCaller {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            let mut state = registry.lock().expect("Native file registry poisoned");
            state.callers.remove(&self.identity);
            state
                .entries
                .retain(|_, entry| entry.scope.caller != self.identity);
        }
    }
}
fn identity() -> String {
    bittery_crypto_core::generate_uuid()
}

impl NativeFileCapabilities {
    /// Release a native caller's unused selection without retaining an OS handle until detach.
    pub(super) fn release(
        &self,
        caller: &FileCaller,
        capability_id: &str,
    ) -> Result<(), SourceError> {
        let mut state = self.0.lock().map_err(|_| SourceError::Source)?;
        if state
            .entries
            .get(capability_id)
            .is_some_and(|entry| entry.scope.caller != caller.identity)
        {
            return Err(SourceError::Invariant);
        }
        state.entries.remove(capability_id);
        Ok(())
    }

    pub(super) fn caller(&self) -> Result<FileCaller, SourceError> {
        let mut state = self.0.lock().map_err(|_| SourceError::Source)?;
        if state.closed {
            return Err(SourceError::Cancelled);
        }
        let identity = identity();
        state.callers.insert(identity.clone());
        Ok(FileCaller {
            identity,
            registry: Arc::downgrade(&self.0),
        })
    }

    pub(super) fn scope(
        &self,
        caller: &FileCaller,
        account_id: AccountId,
        vault_id: &str,
    ) -> Result<FileScope, SourceError> {
        let mut state = self.0.lock().map_err(|_| SourceError::Source)?;
        if state.closed
            || !state.callers.contains(&caller.identity)
            || account_id.as_str().is_empty()
            || vault_id.is_empty()
        {
            return Err(SourceError::Cancelled);
        }
        let epoch = state
            .accounts
            .entry(account_id.clone())
            .or_insert_with(|| Epoch {
                identity: identity(),
                retired: false,
            });
        if epoch.retired {
            return Err(SourceError::Cancelled);
        }
        let account_epoch = epoch.identity.clone();
        let vault = state
            .vaults
            .entry((account_id.clone(), vault_id.to_owned()))
            .or_insert_with(vault_epoch);
        if vault.retired {
            return Err(SourceError::Cancelled);
        }
        Ok(FileScope {
            account_id,
            epoch: account_epoch,
            caller: caller.identity.clone(),
            vault_id: vault_id.to_owned(),
            vault_epoch: vault.identity.clone(),
        })
    }

    /// Only native OS selection code can supply this handle; no renderer path is accepted.
    pub(super) fn grant_upload(
        &self,
        scope: FileScope,
        selection: UploadSelection,
        file: File,
    ) -> Result<String, SourceError> {
        let mut state = self.0.lock().map_err(|_| SourceError::Source)?;
        state.check_scope(&scope)?;
        let metadata = file.metadata().map_err(|_| SourceError::Source)?;
        if scope.account_id != selection.account_id
            || selection.item_id.is_empty()
            || selection.name.is_empty()
            || selection.content_type.is_empty()
            || selection.expected_bytes == 0
            || !metadata.is_file()
            || metadata.len() != selection.expected_bytes
        {
            return Err(SourceError::Invariant);
        }
        let id = identity();
        state.entries.insert(
            id.clone(),
            Entry {
                scope,
                claimed: false,
                begun: false,
                payload: Payload::Upload {
                    selection,
                    file,
                    read: 0,
                },
            },
        );
        Ok(id)
    }

    /// `file` is anonymous private staging; `destination` comes from the native save dialog.
    pub(super) fn grant_download(
        &self,
        scope: FileScope,
        attachment_id: String,
        file: File,
        destination: PathBuf,
    ) -> Result<String, SourceError> {
        let mut state = self.0.lock().map_err(|_| SourceError::Source)?;
        state.check_scope(&scope)?;
        if attachment_id.is_empty()
            || !destination.is_absolute()
            || destination.file_name().is_none()
        {
            return Err(SourceError::Invariant);
        }
        let id = identity();
        state.entries.insert(
            id.clone(),
            Entry {
                scope,
                claimed: false,
                begun: false,
                payload: Payload::Download {
                    attachment_id,
                    file,
                    destination,
                },
            },
        );
        Ok(id)
    }

    async fn retire_vaults(
        &self,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), SourceError> {
        if account_id.as_str().is_empty() || vault_ids.iter().any(String::is_empty) {
            return Err(SourceError::Invariant);
        }
        let account_id = account_id.clone();
        let targets = {
            let mut state = self.0.lock().map_err(|_| SourceError::Source)?;
            if state.closed {
                return Ok(());
            }
            let mut targets = HashMap::new();
            for vault_id in vault_ids {
                let epoch = state
                    .vaults
                    .entry((account_id.clone(), vault_id.clone()))
                    .or_insert_with(vault_epoch);
                epoch.retired = true;
                targets.insert(vault_id.clone(), epoch.identity.clone());
            }
            targets
        };
        self.run(move |state| {
            // Blocking IO/finalization already owns this same mutex until it finishes. Removing
            // entries closes their OS files before acknowledging drain, even if the awaiter drops.
            // Captured identities keep an older queued cleanup from touching a re-admitted scope.
            state.entries.retain(|_, entry| {
                entry.scope.account_id != account_id
                    || targets.get(&entry.scope.vault_id) != Some(&entry.scope.vault_epoch)
            });
            for (vault_id, expected) in targets {
                if let Some(epoch) = state.vaults.get_mut(&(account_id.clone(), vault_id)) {
                    if epoch.identity == expected {
                        epoch.drained = true;
                    }
                }
            }
            Ok(())
        })
        .await
    }

    fn complete_vault_retirement(
        &self,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), SourceError> {
        if account_id.as_str().is_empty() || vault_ids.iter().any(String::is_empty) {
            return Err(SourceError::Invariant);
        }
        let mut state = self.0.lock().map_err(|_| SourceError::Source)?;
        if state.closed
            || state
                .accounts
                .get(account_id)
                .is_some_and(|epoch| epoch.retired)
        {
            return Err(SourceError::Cancelled);
        }
        if vault_ids.iter().any(|vault_id| {
            state
                .vaults
                .get(&(account_id.clone(), vault_id.clone()))
                .is_some_and(|epoch| epoch.retired && !epoch.drained)
        }) {
            return Err(SourceError::Source);
        }
        // Only Core's fresh authority admission calls this primitive. Replays are idempotent;
        // rotating a generation never makes a captured dialog scope or a prior handle valid.
        for vault_id in vault_ids {
            if let Some(epoch) = state
                .vaults
                .get_mut(&(account_id.clone(), vault_id.clone()))
            {
                if epoch.retired {
                    *epoch = vault_epoch();
                }
            }
        }
        Ok(())
    }

    fn forget_vaults(&self, account_id: &AccountId) -> Result<(), SourceError> {
        let mut state = self.0.lock().map_err(|_| SourceError::Source)?;
        if !state.closed
            && (!state
                .accounts
                .get(account_id)
                .is_some_and(|epoch| epoch.retired)
                || state
                    .entries
                    .values()
                    .any(|entry| entry.scope.account_id == *account_id))
        {
            return Err(SourceError::Invariant);
        }
        state.vaults.retain(|(account, _), _| account != account_id);
        Ok(())
    }

    async fn retire(&self, account_id: Option<AccountId>) -> Result<(), SourceError> {
        self.run(move |state| {
            if let Some(account_id) = account_id {
                let epoch = state
                    .accounts
                    .entry(account_id.clone())
                    .or_insert_with(|| Epoch {
                        identity: identity(),
                        retired: false,
                    });
                epoch.retired = true;
                state
                    .entries
                    .retain(|_, entry| entry.scope.account_id != account_id);
            } else {
                state.closed = true;
                state.entries.clear();
                state.callers.clear();
                state.vaults.clear();
                state.accounts.clear();
            }
            Ok(())
        })
        .await
    }
    fn complete(&self, account_id: &AccountId) -> Result<(), SourceError> {
        let mut state = self.0.lock().map_err(|_| SourceError::Source)?;
        if state.closed {
            return Err(SourceError::Cancelled);
        }
        if let Some(epoch) = state.accounts.get_mut(account_id) {
            if epoch.retired {
                *epoch = Epoch {
                    identity: identity(),
                    retired: false,
                };
            }
        }
        Ok(())
    }
    async fn run<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut State) -> Result<T, SourceError> + Send + 'static,
    ) -> Result<T, SourceError> {
        let state = self.0.clone();
        tokio::task::spawn_blocking(move || {
            let mut state = state.lock().map_err(|_| SourceError::Source)?;
            action(&mut state)
        })
        .await
        .map_err(|_| SourceError::Source)?
    }
}
impl State {
    fn entry_mut(&mut self, id: &str) -> Result<&mut Entry, SourceError> {
        let entry = self.entries.get(id).ok_or(SourceError::Cancelled)?;
        self.check_scope(&entry.scope)?;
        self.entries.get_mut(id).ok_or(SourceError::Cancelled)
    }

    fn check_scope(&self, scope: &FileScope) -> Result<(), SourceError> {
        if self.closed
            || !self.callers.contains(&scope.caller)
            || !self
                .accounts
                .get(&scope.account_id)
                .is_some_and(|epoch| !epoch.retired && epoch.identity == scope.epoch)
            || !self
                .vaults
                .get(&(scope.account_id.clone(), scope.vault_id.clone()))
                .is_some_and(|epoch| !epoch.retired && epoch.identity == scope.vault_epoch)
        {
            Err(SourceError::Cancelled)
        } else {
            Ok(())
        }
    }
}

struct Handle {
    registry: NativeFileCapabilities,
    id: String,
}
impl Drop for Handle {
    fn drop(&mut self) {
        self.registry
            .0
            .lock()
            .expect("Native file registry poisoned")
            .entries
            .remove(&self.id);
    }
}
impl Handle {
    async fn close(&self) -> Result<(), SourceError> {
        let id = self.id.clone();
        self.registry
            .run(move |state| {
                state.entries.remove(&id);
                Ok(())
            })
            .await
    }
}
fn sink_error(error: SourceError) -> SinkError {
    match error {
        SourceError::Source => SinkError::Sink,
        SourceError::Cancelled => SinkError::Cancelled,
        SourceError::Invariant => SinkError::Invariant,
    }
}

#[async_trait]
impl AttachmentUploadSourcePort for NativeFileCapabilities {
    async fn claim(
        &self,
        account_id: &AccountId,
        vault_id: &str,
        item_id: &str,
        name: &str,
        content_type: &str,
        capability_id: &str,
        expected_bytes: u64,
    ) -> Result<Box<dyn AttachmentUploadSource>, SourceError> {
        let mut state = self.0.lock().map_err(|_| SourceError::Source)?;
        let entry = state.entry_mut(capability_id)?;
        let Payload::Upload { selection, .. } = &entry.payload else {
            return Err(SourceError::Invariant);
        };
        if entry.claimed
            || entry.scope.vault_id != vault_id
            || selection.account_id != *account_id
            || selection.item_id != item_id
            || selection.name != name
            || selection.content_type != content_type
            || selection.expected_bytes != expected_bytes
        {
            return Err(SourceError::Invariant);
        }
        entry.claimed = true;
        Ok(Box::new(Handle {
            registry: Self(self.0.clone()),
            id: capability_id.into(),
        }))
    }
    async fn retire_account(&self, account_id: &AccountId) -> Result<(), SourceError> {
        self.retire(Some(account_id.clone())).await
    }
    async fn complete_account_retirement(&self, account_id: &AccountId) -> Result<(), SourceError> {
        self.complete(account_id)
    }
    async fn retire_vaults(
        &self,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), SourceError> {
        NativeFileCapabilities::retire_vaults(self, account_id, vault_ids).await
    }
    async fn complete_vault_retirement(
        &self,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), SourceError> {
        NativeFileCapabilities::complete_vault_retirement(self, account_id, vault_ids)
    }
    async fn forget_account_vault_retirements(
        &self,
        account_id: &AccountId,
    ) -> Result<(), SourceError> {
        self.forget_vaults(account_id)
    }
    async fn retire_runtime(&self) -> Result<(), SourceError> {
        self.retire(None).await
    }
}

#[async_trait]
impl AttachmentUploadSource for Handle {
    async fn begin(&mut self, cancellation: RequestCancellation) -> Result<(), SourceError> {
        let id = self.id.clone();
        self.registry
            .run(move |state| {
                if cancellation.is_cancelled() {
                    return Err(SourceError::Cancelled);
                }
                let entry = state.entry_mut(&id)?;
                if entry.begun {
                    return Err(SourceError::Invariant);
                }
                let Payload::Upload { file, .. } = &mut entry.payload else {
                    return Err(SourceError::Invariant);
                };
                file.seek(SeekFrom::Start(0))
                    .map_err(|_| SourceError::Source)?;
                entry.begun = true;
                Ok(())
            })
            .await
    }
    async fn next_chunk(
        &mut self,
        cancellation: RequestCancellation,
    ) -> Result<Option<Vec<u8>>, SourceError> {
        let id = self.id.clone();
        self.registry
            .run(move |state| {
                if cancellation.is_cancelled() {
                    return Err(SourceError::Cancelled);
                }
                let entry = state.entry_mut(&id)?;
                if !entry.begun {
                    return Err(SourceError::Invariant);
                }
                let Payload::Upload {
                    selection,
                    file,
                    read,
                } = &mut entry.payload
                else {
                    return Err(SourceError::Invariant);
                };
                let mut bytes = vec![0; ARTIFACT_CHUNK_BYTES];
                let count = file.read(&mut bytes).map_err(|_| SourceError::Source)?;
                bytes.truncate(count);
                *read = read
                    .checked_add(count as u64)
                    .ok_or(SourceError::Invariant)?;
                if cancellation.is_cancelled() {
                    bytes.zeroize();
                    return Err(SourceError::Cancelled);
                }
                if *read > selection.expected_bytes
                    || (count == 0 && *read != selection.expected_bytes)
                {
                    bytes.zeroize();
                    return Err(SourceError::Source);
                }
                Ok((count != 0).then_some(bytes))
            })
            .await
    }
    async fn close(&mut self) -> Result<(), SourceError> {
        Handle::close(self).await
    }
}

#[async_trait]
impl AttachmentDownloadSinkPort for NativeFileCapabilities {
    fn claim(
        &self,
        account_id: &AccountId,
        vault_id: &str,
        attachment_id: &str,
        capability_id: &str,
    ) -> Result<Box<dyn AttachmentDownloadSink>, SinkError> {
        let mut state = self.0.lock().map_err(|_| SinkError::Sink)?;
        let entry = state.entry_mut(capability_id).map_err(sink_error)?;
        let Payload::Download {
            attachment_id: expected,
            ..
        } = &entry.payload
        else {
            return Err(SinkError::Invariant);
        };
        if entry.claimed
            || entry.scope.account_id != *account_id
            || entry.scope.vault_id != vault_id
            || expected != attachment_id
        {
            return Err(SinkError::Invariant);
        }
        entry.claimed = true;
        Ok(Box::new(Handle {
            registry: Self(self.0.clone()),
            id: capability_id.into(),
        }))
    }
    async fn retire_account(&self, account_id: &AccountId) -> Result<(), SinkError> {
        self.retire(Some(account_id.clone()))
            .await
            .map_err(sink_error)
    }
    async fn complete_account_retirement(&self, account_id: &AccountId) -> Result<(), SinkError> {
        self.complete(account_id).map_err(sink_error)
    }
    async fn retire_vaults(
        &self,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), SinkError> {
        NativeFileCapabilities::retire_vaults(self, account_id, vault_ids)
            .await
            .map_err(sink_error)
    }
    async fn complete_vault_retirement(
        &self,
        account_id: &AccountId,
        vault_ids: &[String],
    ) -> Result<(), SinkError> {
        NativeFileCapabilities::complete_vault_retirement(self, account_id, vault_ids)
            .map_err(sink_error)
    }
    async fn forget_account_vault_retirements(
        &self,
        account_id: &AccountId,
    ) -> Result<(), SinkError> {
        self.forget_vaults(account_id).map_err(sink_error)
    }
    async fn retire_runtime(&self) -> Result<(), SinkError> {
        self.retire(None).await.map_err(sink_error)
    }
}

#[async_trait]
impl AttachmentDownloadSink for Handle {
    async fn begin(&mut self) -> Result<(), SinkError> {
        let id = self.id.clone();
        self.registry
            .run(move |state| {
                let entry = state.entry_mut(&id)?;
                if entry.begun {
                    return Err(SourceError::Invariant);
                }
                let Payload::Download { file, .. } = &mut entry.payload else {
                    return Err(SourceError::Invariant);
                };
                file.set_len(0).map_err(|_| SourceError::Source)?;
                file.seek(SeekFrom::Start(0))
                    .map_err(|_| SourceError::Source)?;
                entry.begun = true;
                Ok(())
            })
            .await
            .map_err(sink_error)
    }
    async fn write(&mut self, bytes: &[u8]) -> Result<(), SinkError> {
        if bytes.is_empty() || bytes.len() > ARTIFACT_CHUNK_BYTES {
            return Err(SinkError::Invariant);
        }
        let bytes = zeroize::Zeroizing::new(bytes.to_vec());
        let id = self.id.clone();
        self.registry
            .run(move |state| {
                let entry = state.entry_mut(&id)?;
                if !entry.begun {
                    return Err(SourceError::Invariant);
                }
                let Payload::Download { file, .. } = &mut entry.payload else {
                    return Err(SourceError::Invariant);
                };
                file.write_all(&bytes).map_err(|_| SourceError::Source)
            })
            .await
            .map_err(sink_error)
    }
    async fn commit(&mut self) -> Result<(), SinkError> {
        let id = self.id.clone();
        self.registry
            .run(move |state| {
                let entry = state.entry_mut(&id)?;
                if !entry.begun {
                    return Err(SourceError::Invariant);
                }
                let Payload::Download {
                    file, destination, ..
                } = &mut entry.payload
                else {
                    return Err(SourceError::Invariant);
                };
                // Core admitted verified finalization. Keep this entry locked through atomic replace:
                // even if this future is dropped, discard/retirement waits for the OS write to finish.
                // This serializes other file retirement behind slow destination IO. Before verification
                // plaintext has only an anonymous handle; a process crash during this final copy may
                // leave a private, verified output temporary in the chosen destination directory.
                super::files::commit_staged_file(file, destination, || Ok(()))
                    .map_err(|_| SourceError::Source)?;
                state.entries.remove(&id);
                Ok(())
            })
            .await
            .map_err(sink_error)
    }
    async fn discard(&mut self) -> Result<(), SinkError> {
        self.close().await.map_err(sink_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn selected(directory: &std::path::Path, bytes: &[u8]) -> (UploadSelection, File) {
        let path = directory.join("source");
        std::fs::write(&path, bytes).unwrap();
        (
            UploadSelection {
                account_id: AccountId::from("account-a"),
                item_id: "item-a".into(),
                name: "source".into(),
                content_type: "application/octet-stream".into(),
                expected_bytes: bytes.len() as u64,
            },
            File::open(path).unwrap(),
        )
    }
    async fn claim(
        registry: &NativeFileCapabilities,
        selection: &UploadSelection,
        id: &str,
        vault_id: &str,
    ) -> Result<Box<dyn AttachmentUploadSource>, SourceError> {
        AttachmentUploadSourcePort::claim(
            registry,
            &selection.account_id,
            vault_id,
            &selection.item_id,
            &selection.name,
            &selection.content_type,
            id,
            selection.expected_bytes,
        )
        .await
    }

    #[tokio::test]
    async fn release_is_caller_scoped_and_closes_an_abandoned_selection() {
        let directory = tempfile::tempdir().unwrap();
        let (selection, file) = selected(directory.path(), b"source");
        let registry = NativeFileCapabilities::default();
        let caller = registry.caller().unwrap();
        let other = registry.caller().unwrap();
        let scope = registry
            .scope(&caller, selection.account_id.clone(), "vault-a")
            .unwrap();
        let id = registry
            .grant_upload(scope, selection.clone(), file)
            .unwrap();
        assert_eq!(registry.release(&other, &id), Err(SourceError::Invariant));
        registry.release(&caller, &id).unwrap();
        registry.release(&caller, &id).unwrap();
        assert!(claim(&registry, &selection, &id, "vault-a").await.is_err());
    }

    #[tokio::test]
    async fn selected_file_is_single_use_scoped_and_streamed_in_bounded_chunks() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = vec![17; ARTIFACT_CHUNK_BYTES * 2 + 13];
        let (selection, file) = selected(directory.path(), &bytes);
        let registry = NativeFileCapabilities::default();
        let caller = registry.caller().unwrap();
        let scope = registry
            .scope(&caller, selection.account_id.clone(), "vault-a")
            .unwrap();
        let id = registry
            .grant_upload(scope, selection.clone(), file)
            .unwrap();
        let mut wrong = selection.clone();
        wrong.account_id = AccountId::from("account-b");
        assert!(matches!(
            claim(&registry, &wrong, &id, "vault-a").await,
            Err(SourceError::Invariant)
        ));
        let mut source = claim(&registry, &selection, &id, "vault-a").await.unwrap();
        assert!(claim(&registry, &selection, &id, "vault-a").await.is_err());
        assert_eq!(
            source
                .next_chunk(RequestCancellation::new())
                .await
                .unwrap_err(),
            SourceError::Invariant
        );
        source.begin(RequestCancellation::new()).await.unwrap();
        let mut result = Vec::new();
        while let Some(chunk) = source.next_chunk(RequestCancellation::new()).await.unwrap() {
            assert!(chunk.len() <= ARTIFACT_CHUNK_BYTES);
            result.extend_from_slice(&chunk);
        }
        assert_eq!(result, bytes);
        source.close().await.unwrap();
        source.close().await.unwrap();
    }

    #[tokio::test]
    async fn retirement_fences_claimed_files_and_dialog_replies_from_previous_generations() {
        let directory = tempfile::tempdir().unwrap();
        let (selection, file) = selected(directory.path(), b"source");
        let registry = NativeFileCapabilities::default();
        let caller = registry.caller().unwrap();
        let old_scope = registry
            .scope(&caller, selection.account_id.clone(), "vault-a")
            .unwrap();
        let id = registry
            .grant_upload(old_scope.clone(), selection.clone(), file)
            .unwrap();
        let mut source = claim(&registry, &selection, &id, "vault-a").await.unwrap();
        source.begin(RequestCancellation::new()).await.unwrap();
        AttachmentUploadSourcePort::retire_account(&registry, &selection.account_id)
            .await
            .unwrap();
        assert_eq!(
            source
                .next_chunk(RequestCancellation::new())
                .await
                .unwrap_err(),
            SourceError::Cancelled
        );
        assert!(registry
            .scope(&caller, selection.account_id.clone(), "vault-a")
            .is_err());
        AttachmentUploadSourcePort::complete_account_retirement(&registry, &selection.account_id)
            .await
            .unwrap();
        let (_, late_file) = selected(directory.path(), b"source");
        assert!(registry
            .grant_upload(old_scope, selection.clone(), late_file)
            .is_err());
        let new_scope = registry
            .scope(&caller, selection.account_id.clone(), "vault-a")
            .unwrap();
        let (_, file) = selected(directory.path(), b"source");
        let id = registry
            .grant_upload(new_scope.clone(), selection.clone(), file)
            .unwrap();
        drop(caller);
        assert!(claim(&registry, &selection, &id, "vault-a").await.is_err());
        let (_, late_file) = selected(directory.path(), b"source");
        assert!(registry
            .grant_upload(new_scope, selection, late_file)
            .is_err());
    }

    #[tokio::test]
    async fn changed_source_length_and_cancellation_do_not_produce_successful_eof() {
        let directory = tempfile::tempdir().unwrap();
        let (selection, file) = selected(directory.path(), b"source");
        let registry = NativeFileCapabilities::default();
        let caller = registry.caller().unwrap();
        let scope = registry
            .scope(&caller, selection.account_id.clone(), "vault-a")
            .unwrap();
        let id = registry
            .grant_upload(scope, selection.clone(), file)
            .unwrap();
        let mut source = claim(&registry, &selection, &id, "vault-a").await.unwrap();
        source.begin(RequestCancellation::new()).await.unwrap();
        std::fs::write(directory.path().join("source"), b"short").unwrap();
        assert_eq!(
            source
                .next_chunk(RequestCancellation::new())
                .await
                .unwrap()
                .unwrap(),
            b"short"
        );
        assert_eq!(
            source
                .next_chunk(RequestCancellation::new())
                .await
                .unwrap_err(),
            SourceError::Source
        );
        let cancelled = RequestCancellation::new();
        cancelled.cancel();
        assert_eq!(
            source.next_chunk(cancelled).await.unwrap_err(),
            SourceError::Cancelled
        );
    }

    fn download(
        registry: &NativeFileCapabilities,
        caller: &FileCaller,
        directory: &std::path::Path,
        destination: PathBuf,
    ) -> Box<dyn AttachmentDownloadSink> {
        let account = AccountId::from("account-a");
        let scope = registry.scope(caller, account.clone(), "vault-a").unwrap();
        let file = tempfile::tempfile_in(directory).unwrap();
        let id = registry
            .grant_download(scope, "attachment".into(), file, destination)
            .unwrap();
        AttachmentDownloadSinkPort::claim(registry, &account, "vault-a", "attachment", &id).unwrap()
    }

    #[tokio::test]
    async fn unverified_download_never_replaces_destination_and_commit_is_atomic() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("chosen-output");
        std::fs::write(&destination, b"previous user file").unwrap();
        let registry = NativeFileCapabilities::default();
        let caller = registry.caller().unwrap();
        let mut sink = download(&registry, &caller, directory.path(), destination.clone());
        sink.begin().await.unwrap();
        sink.write(b"unverified plaintext").await.unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"previous user file");
        sink.discard().await.unwrap();
        sink.discard().await.unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"previous user file");
        let mut sink = download(&registry, &caller, directory.path(), destination.clone());
        sink.begin().await.unwrap();
        sink.write(b"verified plaintext").await.unwrap();
        sink.commit().await.unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"verified plaintext");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn failed_or_retired_sink_cannot_publish_and_preserves_other_accounts() {
        let directory = tempfile::tempdir().unwrap();
        let registry = NativeFileCapabilities::default();
        let caller = registry.caller().unwrap();
        let mut failed = download(
            &registry,
            &caller,
            directory.path(),
            directory.path().join("missing-parent/output"),
        );
        failed.begin().await.unwrap();
        failed.write(b"verified").await.unwrap();
        assert_eq!(failed.commit().await.unwrap_err(), SinkError::Sink);
        failed.discard().await.unwrap();
        let destination = directory.path().join("output");
        let mut sink = download(&registry, &caller, directory.path(), destination.clone());
        sink.begin().await.unwrap();
        sink.write(b"unverified").await.unwrap();
        let other = registry
            .scope(&caller, AccountId::from("account-b"), "vault-a")
            .unwrap();
        AttachmentDownloadSinkPort::retire_account(&registry, &AccountId::from("account-a"))
            .await
            .unwrap();
        assert_eq!(sink.commit().await.unwrap_err(), SinkError::Cancelled);
        assert!(!destination.exists());
        let (mut selection, file) = selected(directory.path(), b"other");
        selection.account_id = AccountId::from("account-b");
        let other_id = registry
            .grant_upload(other.clone(), selection.clone(), file)
            .unwrap();
        let mut other_source = claim(&registry, &selection, &other_id, "vault-a")
            .await
            .unwrap();
        other_source
            .begin(RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(
            other_source
                .next_chunk(RequestCancellation::new())
                .await
                .unwrap()
                .unwrap(),
            b"other"
        );
        AttachmentDownloadSinkPort::retire_runtime(&registry)
            .await
            .unwrap();
        assert!(registry.caller().is_err());
        assert_eq!(
            other_source
                .next_chunk(RequestCancellation::new())
                .await
                .unwrap_err(),
            SourceError::Cancelled
        );
    }

    #[tokio::test]
    async fn vault_retirement_closes_unused_and_claimed_files_but_preserves_moved_ids() {
        let directory = tempfile::tempdir().unwrap();
        let registry = NativeFileCapabilities::default();
        let caller = registry.caller().unwrap();
        let mut claimed = Vec::new();
        let mut unused = Vec::new();
        for (account, vault) in [
            ("account-a", "hidden"),
            ("account-a", "visible"),
            ("account-b", "hidden"),
        ] {
            let (mut selection, file) = selected(directory.path(), b"selected plaintext");
            selection.account_id = AccountId::from(account);
            let scope = registry
                .scope(&caller, selection.account_id.clone(), vault)
                .unwrap();
            let id = registry
                .grant_upload(scope.clone(), selection.clone(), file)
                .unwrap();
            let mut source = claim(&registry, &selection, &id, vault).await.unwrap();
            source.begin(RequestCancellation::new()).await.unwrap();
            let id = registry
                .grant_upload(
                    scope.clone(),
                    selection.clone(),
                    File::open(directory.path().join("source")).unwrap(),
                )
                .unwrap();
            let destination = directory.path().join(format!("{account}-{vault}"));
            std::fs::write(&destination, b"previous user data").unwrap();
            let sink_id = registry
                .grant_download(
                    scope.clone(),
                    "same-attachment".into(),
                    tempfile::tempfile_in(directory.path()).unwrap(),
                    destination.clone(),
                )
                .unwrap();
            let mut sink = AttachmentDownloadSinkPort::claim(
                &registry,
                &selection.account_id,
                vault,
                "same-attachment",
                &sink_id,
            )
            .unwrap();
            sink.begin().await.unwrap();
            sink.write(b"unverified plaintext").await.unwrap();
            let unused_sink = registry
                .grant_download(
                    scope.clone(),
                    "same-attachment".into(),
                    tempfile::tempfile_in(directory.path()).unwrap(),
                    destination.clone(),
                )
                .unwrap();
            unused.push((selection, scope, id, unused_sink));
            claimed.push((source, sink, destination));
        }
        registry
            .retire_vaults(&AccountId::from("account-a"), &["hidden".into()])
            .await
            .unwrap();
        for (
            index,
            ((selection, scope, source_id, sink_id), (mut source, mut sink, destination)),
        ) in unused.into_iter().zip(claimed).enumerate()
        {
            if index == 0 {
                assert!(source.next_chunk(RequestCancellation::new()).await.is_err());
                assert!(sink.write(b"late plaintext").await.is_err());
                assert!(sink.commit().await.is_err());
                assert!(claim(&registry, &selection, &source_id, &scope.vault_id)
                    .await
                    .is_err());
                assert!(AttachmentDownloadSinkPort::claim(
                    &registry,
                    &selection.account_id,
                    &scope.vault_id,
                    "same-attachment",
                    &sink_id
                )
                .is_err());
                assert!(
                    registry
                        .grant_upload(
                            scope,
                            selection.clone(),
                            File::open(directory.path().join("source")).unwrap()
                        )
                        .is_err(),
                    "a pre-dialog scope cannot grant late into a retired Vault"
                );
                assert_eq!(std::fs::read(destination).unwrap(), b"previous user data");
                assert!(registry
                    .scope(&caller, selection.account_id, "hidden")
                    .is_err());
            } else {
                assert_eq!(
                    source
                        .next_chunk(RequestCancellation::new())
                        .await
                        .unwrap()
                        .unwrap(),
                    b"selected plaintext"
                );
                sink.commit().await.unwrap();
                assert_eq!(std::fs::read(destination).unwrap(), b"unverified plaintext");
                assert!(claim(&registry, &selection, &source_id, &scope.vault_id)
                    .await
                    .is_ok());
                assert!(AttachmentDownloadSinkPort::claim(
                    &registry,
                    &selection.account_id,
                    &scope.vault_id,
                    "same-attachment",
                    &sink_id
                )
                .is_ok());
            }
        }
    }

    #[tokio::test]
    async fn only_explicit_vault_readmission_opens_a_new_scope_generation() {
        let directory = tempfile::tempdir().unwrap();
        let (selection, file) = selected(directory.path(), b"source");
        let registry = NativeFileCapabilities::default();
        let caller = registry.caller().unwrap();
        let old = registry
            .scope(&caller, selection.account_id.clone(), "hidden")
            .unwrap();
        let old_id = registry
            .grant_upload(old.clone(), selection.clone(), file)
            .unwrap();
        registry
            .retire_vaults(&selection.account_id, &["hidden".into(), "hidden".into()])
            .await
            .unwrap();
        registry
            .retire_vaults(&selection.account_id, &["hidden".into()])
            .await
            .unwrap();
        AttachmentUploadSourcePort::retire_account(&registry, &selection.account_id)
            .await
            .unwrap();
        AttachmentUploadSourcePort::complete_account_retirement(&registry, &selection.account_id)
            .await
            .unwrap();
        assert!(
            registry
                .scope(&caller, selection.account_id.clone(), "hidden")
                .is_err(),
            "ordinary Account unlock cannot re-admit a hidden Vault"
        );
        assert!(registry
            .scope(&caller, selection.account_id.clone(), "visible")
            .is_ok());
        registry
            .complete_vault_retirement(&selection.account_id, &["hidden".into()])
            .unwrap();
        let fresh = registry
            .scope(&caller, selection.account_id.clone(), "hidden")
            .unwrap();
        assert!(claim(&registry, &selection, &old_id, "hidden")
            .await
            .is_err());
        assert!(registry
            .grant_upload(
                old,
                selection.clone(),
                File::open(directory.path().join("source")).unwrap()
            )
            .is_err());
        let id = registry
            .grant_upload(
                fresh,
                selection.clone(),
                File::open(directory.path().join("source")).unwrap(),
            )
            .unwrap();
        assert!(claim(&registry, &selection, &id, "hidden").await.is_ok());
    }

    #[test]
    fn queued_vault_retirement_fences_before_await_and_owns_dropped_cleanup() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap()
            .block_on(async {
                let directory = tempfile::tempdir().unwrap();
                let (selection, file) = selected(directory.path(), b"source");
                let registry = NativeFileCapabilities::default();
                let caller = registry.caller().unwrap();
                let old = registry
                    .scope(&caller, selection.account_id.clone(), "hidden")
                    .unwrap();
                let id = registry
                    .grant_upload(old.clone(), selection.clone(), file)
                    .unwrap();
                let (started_tx, started_rx) = std::sync::mpsc::channel();
                let (release_tx, release_rx) = std::sync::mpsc::channel();
                let occupied = tokio::task::spawn_blocking(move || {
                    started_tx.send(()).unwrap();
                    let _ = release_rx.recv();
                });
                started_rx.recv().unwrap();
                let vaults = ["hidden".into()];
                let mut retirement =
                    Box::pin(registry.retire_vaults(&selection.account_id, &vaults));
                std::future::poll_fn(|context| {
                    assert!(std::future::Future::poll(retirement.as_mut(), context).is_pending());
                    std::task::Poll::Ready(())
                })
                .await;
                assert!(
                    registry
                        .scope(&caller, selection.account_id.clone(), "hidden")
                        .is_err(),
                    "retirement intent must fence before queued physical cleanup"
                );
                assert!(
                    registry
                        .complete_vault_retirement(&selection.account_id, &vaults)
                        .is_err(),
                    "fresh admission must wait for actual drain"
                );
                drop(retirement);
                release_tx.send(()).unwrap();
                occupied.await.unwrap();
                // Await the same idempotent primitive; the dropped first waiter's job still owns its cleanup.
                registry
                    .retire_vaults(&selection.account_id, &vaults)
                    .await
                    .unwrap();
                assert!(claim(&registry, &selection, &id, "hidden").await.is_err());
                registry
                    .complete_vault_retirement(&selection.account_id, &vaults)
                    .unwrap();
                assert!(registry
                    .scope(&caller, selection.account_id.clone(), "hidden")
                    .is_ok());
                assert!(registry
                    .grant_upload(
                        old,
                        selection,
                        File::open(directory.path().join("source")).unwrap()
                    )
                    .is_err());
            });
    }

    #[tokio::test]
    async fn exact_core_claim_rejects_another_vault_with_the_same_resource_id() {
        let directory = tempfile::tempdir().unwrap();
        let registry = NativeFileCapabilities::default();
        let caller = registry.caller().unwrap();
        let (selection, file) = selected(directory.path(), b"source");
        let scope = registry
            .scope(&caller, selection.account_id.clone(), "original-vault")
            .unwrap();
        let id = registry
            .grant_upload(scope.clone(), selection.clone(), file)
            .unwrap();
        assert!(
            claim(&registry, &selection, &id, "current-other-vault")
                .await
                .is_err(),
            "same Item ID cannot rebind the selected source's Vault"
        );
        assert!(claim(&registry, &selection, &id, "original-vault")
            .await
            .is_ok());
        let id = registry
            .grant_download(
                scope,
                "same-attachment".into(),
                tempfile::tempfile_in(directory.path()).unwrap(),
                directory.path().join("output"),
            )
            .unwrap();
        assert!(
            AttachmentDownloadSinkPort::claim(
                &registry,
                &selection.account_id,
                "current-other-vault",
                "same-attachment",
                &id
            )
            .is_err(),
            "same Attachment ID cannot rebind the selected sink's Vault"
        );
        assert!(AttachmentDownloadSinkPort::claim(
            &registry,
            &selection.account_id,
            "original-vault",
            "same-attachment",
            &id
        )
        .is_ok());
    }
}
