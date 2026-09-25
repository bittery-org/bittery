use super::*;
use crate::attachment_artifact_store::{
    AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
};
use crate::platform_storage::AccountRetirementPurpose;
use async_trait::async_trait;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TeardownHostCleanupRequest {
    DeleteAccount { account_id: AccountId },
    WipeDevice,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TeardownHostCleanupResponse {
    AccountDeleted,
    DeviceWiped,
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
pub trait TeardownHostCleanup: Send + Sync {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
pub trait TeardownHostCleanup {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError>;
}

pub(super) struct UnavailableTeardownHostCleanup;

/// Every teardown scope that has not yet converged in this Runtime. A scope is a set, not a slot,
/// so an incomplete removal of one Account can never refuse whole-Device destruction or the
/// removal of an unrelated Account.
#[derive(Default)]
pub(super) struct PendingTeardown {
    device: bool,
    accounts: BTreeMap<AccountId, AccountRetirementPurpose>,
}

impl PendingTeardown {
    fn insert_account(
        &mut self,
        account_id: &AccountId,
        purpose: AccountRetirementPurpose,
    ) -> bool {
        match self.accounts.get_mut(account_id) {
            Some(current)
                if *current == purpose || *current == AccountRetirementPurpose::Remove =>
            {
                false
            }
            Some(current) => {
                *current = purpose;
                true
            }
            None => {
                self.accounts.insert(account_id.clone(), purpose);
                true
            }
        }
    }

    fn insert(&mut self, scope: &TeardownScope) -> bool {
        match scope {
            TeardownScope::Account { account_id } => {
                self.insert_account(account_id, AccountRetirementPurpose::Remove)
            }
            TeardownScope::Device => !std::mem::replace(&mut self.device, true),
        }
    }

    fn remove(&mut self, scope: &TeardownScope) -> bool {
        match scope {
            TeardownScope::Account { account_id } => self.accounts.remove(account_id).is_some(),
            // A converged Wipe destroyed every Account, so it also clears their narrower scopes.
            TeardownScope::Device => {
                let changed = self.device || !self.accounts.is_empty();
                self.device = false;
                self.accounts.clear();
                changed
            }
        }
    }

    fn contains_account(&self, account_id: &AccountId) -> bool {
        self.rejects(Some(account_id))
    }

    /// Device scope fences everything, including a request that names no Account.
    fn rejects(&self, account_id: Option<&AccountId>) -> bool {
        self.device || account_id.is_some_and(|account_id| self.accounts.contains_key(account_id))
    }
}

struct PlatformDeletion {
    result: Result<(), RuntimeError>,
    replica_allowed: bool,
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl TeardownHostCleanup for UnavailableTeardownHostCleanup {
    async fn invoke(
        &self,
        _request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Host cleanup is unavailable",
        ))
    }
}

impl Runtime {
    async fn delete_vault_images_for_teardown(&self, scope: &TeardownScope) {
        let facade = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone();
        let Some(facade) = facade else { return };
        let mut failures = 0_u32;
        loop {
            let result = match scope {
                TeardownScope::Account { account_id } => {
                    facade.delete_account_artifacts(account_id).await
                }
                TeardownScope::Device => facade.wipe_artifacts().await,
            };
            if result.is_ok() {
                return;
            }
            self.device_timer.sleep_ms(10_u64 << failures.min(7)).await;
            failures = failures.saturating_add(1);
        }
    }

    pub(super) async fn remove_account(
        &self,
        account_id: AccountId,
    ) -> Result<RuntimeResponse, RuntimeError> {
        if account_id.as_str().is_empty() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account teardown scope is invalid",
            ));
        }
        self.teardown(TeardownScope::Account { account_id }).await
    }

    pub(super) async fn wipe_device(&self) -> Result<RuntimeResponse, RuntimeError> {
        self.teardown(TeardownScope::Device).await
    }

    /// How far this Runtime must have started before a scope may destroy.
    ///
    /// Device Wipe requires a Runtime that is not closed, even when catalog/Replica damage prevents
    /// open. Existing Reset journals are read when available; replacing unreadable catalog bytes
    /// requires an independently proven fixed namespace scope. The catalog guard serializes both
    /// recovery and ordinary namespace cleanup against open.
    ///
    /// Account scope reads the Device catalog and detaches one entry from it, so it keeps the
    /// full precondition.
    fn ensure_teardown_precondition(&self, scope: &TeardownScope) -> Result<(), RuntimeError> {
        match scope {
            TeardownScope::Account { .. } => self.ensure_open(),
            TeardownScope::Device => self.ensure_not_closed(),
        }
    }

    async fn teardown(&self, scope: TeardownScope) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_teardown_precondition(&scope)?;
        match &scope {
            TeardownScope::Account { account_id } => {
                self.native_authority.retire_account(account_id);
                self.biometric.retire(account_id);
            }
            TeardownScope::Device => {
                self.native_authority.retire_all();
                self.biometric.retire_all();
            }
        }
        self.ensure_teardown_precondition(&scope)?;
        // One Account lifecycle owns the intent through its exact host retirement and Core
        // convergence. This mutex is outside the shared admission/catalog/execution order so a
        // queued Lock, Sign-out, or Remove cannot borrow another lifecycle's completion.
        let lifecycle_lock = match &scope {
            TeardownScope::Account { account_id } => Some(self.account_lifecycle_lock(account_id)?),
            TeardownScope::Device => None,
        };
        let _lifecycle_guard = match lifecycle_lock {
            Some(lock) => Some(lock.lock_owned().await),
            None => None,
        };
        let mut foreground_account_retirements = Vec::new();
        let mut foreground_device_retirement = None;
        match &scope {
            TeardownScope::Account { account_id } => {
                foreground_account_retirements = self
                    .foreground_attachments
                    .begin_accounts_retirement(std::slice::from_ref(account_id));
                for retirement in &foreground_account_retirements {
                    retirement.drain().await;
                }
            }
            TeardownScope::Device => {
                let retirement = self.foreground_attachments.begin_device_retirement();
                retirement.drain().await;
                foreground_device_retirement = Some(retirement);
            }
        }

        // Foreground requests own the admission reader until their cleanup finishes, so lifecycle
        // intent must cancel and drain them before taking the writer. The writer is then held before
        // Account execution and every host/Core retirement phase.
        let _admission = self.teardown_admission.write().await;
        self.ensure_teardown_precondition(&scope)?;
        let _catalog = self.catalog_transition.lock().await;
        {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            if self
                .pending_teardown
                .lock()
                .expect("pending teardown lock poisoned")
                .insert(&scope)
            {
                self.device_revision.fetch_add(1, Ordering::SeqCst);
            }
        }
        // An Account removal owns every referring source binding before deleting its target.
        // Wipe remains namespace-wide and does not require a readable catalog.
        let retirement_catalog = match &scope {
            TeardownScope::Account { .. } => {
                match self.platform_storage.load_device_catalog().await {
                    Ok(catalog) => catalog,
                    Err(_) => {
                        return self
                            .incomplete_catalog_retirement(scope, TeardownPhase::PlatformStorage);
                    }
                }
            }
            TeardownScope::Device => None,
        };
        let mut account_ids = match &scope {
            TeardownScope::Account { account_id } => vec![account_id.clone()],
            TeardownScope::Device => self.known_teardown_accounts(),
        };
        account_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
        account_ids.dedup();
        let mut execution_account_ids = account_ids.clone();
        if let Some(catalog) = &retirement_catalog {
            execution_account_ids.extend(
                catalog
                    .accounts
                    .iter()
                    .map(|entry| entry.account_id.clone()),
            );
            execution_account_ids.sort();
            execution_account_ids.dedup();
        }
        let execution_locks: Vec<_> = execution_account_ids
            .iter()
            .map(|account_id| {
                let mut locks = self
                    .account_execution_locks
                    .lock()
                    .expect("Account execution lock map poisoned");
                locks
                    .entry(account_id.clone())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                    .clone()
            })
            .collect();
        let mut execution_guards = Vec::with_capacity(execution_locks.len());
        for lock in &execution_locks {
            execution_guards.push(lock.lock().await);
        }
        if let (TeardownScope::Account { account_id }, Some(catalog)) = (&scope, retirement_catalog)
        {
            if let Some(active) = catalog
                .accounts
                .iter()
                .find(|entry| &entry.account_id == account_id)
                .and_then(|entry| entry.active_incarnation.clone())
            {
                let marked = match self
                    .mark_catalog_account_retirement(
                        &catalog,
                        account_id,
                        crate::platform_storage::AccountRetirementPurpose::Remove,
                    )
                    .await
                {
                    Ok(marked) => marked,
                    Err(_) => {
                        return self
                            .incomplete_catalog_retirement(scope, TeardownPhase::PlatformStorage);
                    }
                };
                if self
                    .retire_cross_account_destination_bindings(&marked, account_id, &active)
                    .await
                    .is_err()
                {
                    return self.incomplete_catalog_retirement(scope, TeardownPhase::Replica);
                }
            }
        }
        let mut profile_reset = if matches!(scope, TeardownScope::Device) {
            match self.prepare_device_profile_reset().await {
                Ok(prepared) => prepared,
                Err(_) => {
                    return self
                        .incomplete_catalog_retirement(scope, TeardownPhase::PlatformStorage);
                }
            }
        } else {
            None
        };
        if let Some(prepared) = profile_reset.as_mut() {
            if self.reset_profile_sources(prepared).await.is_err() {
                return self.incomplete_catalog_retirement(scope, TeardownPhase::PlatformStorage);
            }
        }
        self.best_effort_create_vault_remote_cleanup(&account_ids)
            .await;
        match &scope {
            TeardownScope::Account { account_id } => {
                self.retire_attachment_download_account(account_id).await;
                self.retire_attachment_upload_account(account_id).await;
                self.retire_vault_image_account(account_id).await;
            }
            TeardownScope::Device => {
                self.retire_all_attachment_downloads().await;
                self.retire_all_attachment_uploads().await;
                self.retire_all_vault_images().await;
            }
        }
        self.delete_vault_images_for_teardown(&scope).await;
        let invalidated = {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            let invalidated: Vec<_> = account_ids
                .iter()
                .filter_map(|account_id| self.invalidate_delivery(account_id))
                .collect();
            for account_id in &account_ids {
                self.unlocked_items
                    .lock()
                    .expect("unlocked projection lock poisoned")
                    .remove(account_id);
                self.clear_live_master_unlock_keys_for_account(account_id);
                self.account_access
                    .lock()
                    .expect("Account access lock poisoned")
                    .remove(account_id);
                self.account_display_identities
                    .lock()
                    .expect("Account display identity lock poisoned")
                    .remove(account_id);
                self.recovery_accounts
                    .lock()
                    .expect("recovery Account lock poisoned")
                    .remove(account_id);
                self.account_lock_epochs
                    .lock()
                    .expect("Account lock epoch lock poisoned")
                    .remove(account_id);
                self.lock_epoch_pending
                    .lock()
                    .expect("pending lock epoch lock poisoned")
                    .remove(account_id);
                self.waiting_reasons
                    .lock()
                    .expect("waiting reason lock poisoned")
                    .remove(account_id);
            }
            invalidated
        };
        for token in invalidated {
            token.wait_for_other_threads();
        }
        self.close_teardown_observations(&scope, &account_ids);

        let mut failures = Vec::with_capacity(4);
        if self.delete_artifacts(&scope).await.is_err() {
            failures.push(TeardownPhase::AttachmentArtifacts);
        }
        let cleanup = self
            .teardown_host_cleanup
            .lock()
            .expect("teardown host cleanup lock poisoned")
            .clone();
        let cleanup_request = match &scope {
            TeardownScope::Account { account_id } => TeardownHostCleanupRequest::DeleteAccount {
                account_id: account_id.clone(),
            },
            TeardownScope::Device => TeardownHostCleanupRequest::WipeDevice,
        };
        let expected_cleanup = match &scope {
            TeardownScope::Account { .. } => TeardownHostCleanupResponse::AccountDeleted,
            TeardownScope::Device => TeardownHostCleanupResponse::DeviceWiped,
        };
        if cleanup.invoke(cleanup_request).await != Ok(expected_cleanup) {
            failures.push(TeardownPhase::HostCleanup);
        }
        let journal_matches = match &profile_reset {
            Some(prepared) => self.validate_profile_reset_journal(prepared).await.is_ok(),
            None => true,
        };
        let platform = if journal_matches {
            self.delete_platform_state(&scope, profile_reset.is_some())
                .await
        } else {
            PlatformDeletion {
                result: Err(startup_invariant(
                    "Profile reset journal changed before Core deletion",
                )),
                replica_allowed: false,
            }
        };
        if platform.result.is_err() {
            failures.push(TeardownPhase::PlatformStorage);
        }
        let journal_matches = match &profile_reset {
            Some(prepared) => self.validate_profile_reset_journal(prepared).await.is_ok(),
            None => true,
        };
        if !journal_matches && !failures.contains(&TeardownPhase::PlatformStorage) {
            failures.push(TeardownPhase::PlatformStorage);
        }
        if !platform.replica_allowed
            || !journal_matches
            || self.delete_replica_state(&scope).await.is_err()
        {
            failures.push(TeardownPhase::Replica);
        }

        if failures.is_empty() {
            if let Some(prepared) = profile_reset.as_mut() {
                if self.finish_profile_reset(prepared).await.is_err() {
                    failures.push(TeardownPhase::PlatformStorage);
                }
            }
        }
        drop(execution_guards);
        if failures.is_empty() {
            if let TeardownScope::Account { account_id } = &scope {
                self.complete_attachment_download_account_retirement(account_id)
                    .await;
                self.complete_attachment_upload_account_retirement(account_id)
                    .await;
                self.complete_vault_image_account_retirement(account_id)
                    .await;
                self.complete_native_account_teardown(account_id)?;
            }
            let _publication = self.publication.lock().expect("publication lock poisoned");
            if self
                .pending_teardown
                .lock()
                .expect("pending teardown lock poisoned")
                .remove(&scope)
            {
                self.device_revision.fetch_add(1, Ordering::SeqCst);
            }
        }
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all_unless_closed();
        drop(foreground_account_retirements);
        drop(foreground_device_retirement);
        Ok(RuntimeResponse::Teardown {
            scope,
            status: if failures.is_empty() {
                TeardownStatus::Complete
            } else {
                TeardownStatus::Incomplete
            },
            failures,
        })
    }

    /// Close ordinary work before intent I/O, or restore its gate during startup.
    /// Remove dominates Replace; only verified installation may retry a pending replacement.
    pub(super) fn gate_catalog_account_retirement(
        &self,
        account_id: &AccountId,
        purpose: AccountRetirementPurpose,
    ) {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        if self
            .pending_teardown
            .lock()
            .expect("pending teardown lock poisoned")
            .insert_account(account_id, purpose)
        {
            self.device_revision.fetch_add(1, Ordering::SeqCst);
        }
    }

    pub(super) fn reject_installation_during_account_removal(
        &self,
        account_id: &AccountId,
    ) -> Result<(), RuntimeError> {
        let pending = self
            .pending_teardown
            .lock()
            .expect("pending teardown lock poisoned");
        if pending.device
            || pending.accounts.get(account_id) == Some(&AccountRetirementPurpose::Remove)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountMissing,
                "Account teardown is pending",
            ));
        }
        Ok(())
    }

    pub(super) fn complete_catalog_account_replacement(&self, account_id: &AccountId) {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let mut pending = self
            .pending_teardown
            .lock()
            .expect("pending teardown lock poisoned");
        if pending.accounts.get(account_id) == Some(&AccountRetirementPurpose::Replace) {
            pending.accounts.remove(account_id);
            self.device_revision.fetch_add(1, Ordering::SeqCst);
        }
    }

    pub(super) fn account_teardown_is_pending(&self, account_id: &AccountId) -> bool {
        self.pending_teardown
            .lock()
            .expect("pending teardown lock poisoned")
            .contains_account(account_id)
    }

    fn incomplete_catalog_retirement(
        &self,
        scope: TeardownScope,
        phase: TeardownPhase,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all_unless_closed();
        Ok(RuntimeResponse::Teardown {
            scope,
            status: TeardownStatus::Incomplete,
            failures: vec![phase],
        })
    }

    pub(super) fn reject_request_during_pending_teardown(
        &self,
        request: &RuntimeRequest,
    ) -> Result<(), RuntimeError> {
        // A Sign-in names no Account. Account scope therefore fences it later, once installation has
        // resolved its Account identity, so a pending removal cannot block an unrelated Account.
        let rejected = self
            .pending_teardown
            .lock()
            .expect("pending teardown lock poisoned")
            .rejects(request.account_id());
        if rejected {
            Err(RuntimeError::new(
                RuntimeErrorCode::AccountMissing,
                "Account teardown is pending",
            ))
        } else {
            Ok(())
        }
    }

    pub(super) fn observation_teardown_is_pending(&self, request: &ObservationRequest) -> bool {
        self.pending_teardown
            .lock()
            .expect("pending teardown lock poisoned")
            .rejects(request.account_id())
    }

    fn known_teardown_accounts(&self) -> Vec<AccountId> {
        let mut accounts: Vec<_> = self
            .replica
            .snapshots()
            .into_iter()
            .map(|snapshot| snapshot.account_id)
            .collect();
        accounts.extend(
            self.account_execution_locks
                .lock()
                .expect("Account execution lock map poisoned")
                .keys()
                .cloned(),
        );
        accounts.extend(
            self.account_access
                .lock()
                .expect("Account access lock poisoned")
                .keys()
                .cloned(),
        );
        accounts.extend(
            self.account_display_identities
                .lock()
                .expect("Account display identity lock poisoned")
                .keys()
                .cloned(),
        );
        accounts
    }

    fn close_teardown_observations(&self, scope: &TeardownScope, account_ids: &[AccountId]) {
        let selected: Vec<_> = self
            .observers
            .lock()
            .expect("observer lock poisoned")
            .iter()
            .filter(|(_, subscription)| {
                matches!(scope, TeardownScope::Device)
                    || subscription
                        .request
                        .account_id()
                        .is_some_and(|account_id| account_ids.contains(account_id))
            })
            .map(|(id, subscription)| (*id, Arc::clone(subscription)))
            .collect();
        for (id, subscription) in selected {
            self.observers
                .lock()
                .expect("observer lock poisoned")
                .remove(&id);
            subscription.close_for_lifecycle();
        }
    }

    pub(super) async fn best_effort_create_vault_remote_cleanup(&self, account_ids: &[AccountId]) {
        let port = self
            .create_vault_cleanup_port
            .lock()
            .expect("create-Vault cleanup port lock poisoned")
            .clone();
        let mut bindings = Vec::new();
        let mut seen = BTreeSet::new();
        for account_id in account_ids {
            let Some(snapshot) = self.replica.snapshot(account_id) else {
                continue;
            };
            for operation in &snapshot.operations {
                let Some(intent) = &operation.create_vault else {
                    continue;
                };
                let Some(image) = &intent.image else { continue };
                if seen.insert((account_id.clone(), operation.operation_id.clone())) {
                    bindings.push(super::create_vault_staging::CreateVaultStagingBinding {
                        account_id: account_id.clone(),
                        operation_id: operation.operation_id.clone(),
                        vault_id: operation.vault_id().to_owned(),
                        object_key: image.object_key.clone(),
                        byte_length: image.byte_length,
                        content_type: image.content_type.clone(),
                        sha256: image.sha256.clone(),
                    });
                }
            }
            for receipt in &snapshot.receipts {
                let Some(cleanup) = &receipt.create_vault_cleanup else {
                    continue;
                };
                if !cleanup.remote_staging_pending
                    || !seen.insert((account_id.clone(), receipt.operation_id.clone()))
                {
                    continue;
                }
                bindings.push(super::create_vault_staging::CreateVaultStagingBinding {
                    account_id: account_id.clone(),
                    operation_id: receipt.operation_id.clone(),
                    vault_id: receipt.vault_id().to_owned(),
                    object_key: cleanup.image.object_key.clone(),
                    byte_length: cleanup.image.byte_length,
                    content_type: cleanup.image.content_type.clone(),
                    sha256: cleanup.image.sha256.clone(),
                });
            }
        }
        for binding in bindings {
            if let Some(port) = &port {
                if matches!(
                    port.cleanup_remote(&binding).await,
                    Err(super::create_vault_staging::CreateVaultStagingError::Unauthorized)
                ) && port.renew_session().await.is_ok()
                {
                    let _ = port.cleanup_remote(&binding).await;
                }
            } else {
                self.best_effort_production_create_vault_remote_cleanup(&binding)
                    .await;
            }
        }
    }

    async fn delete_artifacts(&self, scope: &TeardownScope) -> Result<(), RuntimeError> {
        let artifacts = self
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned")
            .as_ref()
            .map(|lifecycle| lifecycle.artifacts())
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "Attachment artifact cleanup is unavailable",
                )
            })?;
        let request = match scope {
            TeardownScope::Account { account_id } => {
                AttachmentArtifactStoreRequest::DeleteAccount {
                    account_id: account_id.clone(),
                }
            }
            TeardownScope::Device => AttachmentArtifactStoreRequest::WipeDevice,
        };
        let response = artifacts.invoke(request).await?;
        let valid = matches!(
            (scope, response),
            (
                TeardownScope::Account { .. },
                AttachmentArtifactStoreResponse::AccountDeleted
            ) | (
                TeardownScope::Device,
                AttachmentArtifactStoreResponse::DeviceWiped
            )
        );
        if valid {
            Ok(())
        } else {
            Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Attachment artifact cleanup returned the wrong response",
            ))
        }
    }

    async fn delete_platform_state(
        &self,
        scope: &TeardownScope,
        preserve_reset_catalog: bool,
    ) -> PlatformDeletion {
        match scope {
            TeardownScope::Account { account_id } => {
                match self.platform_storage.load_device_catalog().await {
                    Ok(Some(catalog)) => {
                        if catalog
                            .accounts
                            .iter()
                            .any(|account| &account.account_id == account_id)
                        {
                            let retained = catalog
                                .accounts
                                .iter()
                                .filter(|account| &account.account_id != account_id)
                                .cloned()
                                .collect();
                            let updated = match catalog.with_accounts(retained) {
                                Ok(updated) => updated,
                                Err(error) => {
                                    return PlatformDeletion {
                                        result: Err(error),
                                        replica_allowed: false,
                                    };
                                }
                            };
                            if let Err(error) =
                                self.platform_storage.store_device_catalog(&updated).await
                            {
                                return PlatformDeletion {
                                    result: Err(error),
                                    replica_allowed: false,
                                };
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        return PlatformDeletion {
                            result: Err(error),
                            replica_allowed: false,
                        };
                    }
                }
                let result = self
                    .platform_storage
                    .delete_account_namespace(account_id)
                    .await;
                PlatformDeletion {
                    result,
                    replica_allowed: true,
                }
            }
            TeardownScope::Device => {
                let result = if preserve_reset_catalog {
                    self.platform_storage
                        .wipe_runtime_namespace_preserving_catalog()
                        .await
                } else {
                    self.platform_storage.wipe_runtime_namespace().await
                };
                let replica_allowed = result.is_ok();
                PlatformDeletion {
                    result,
                    replica_allowed,
                }
            }
        }
    }

    async fn delete_replica_state(&self, scope: &TeardownScope) -> Result<(), RuntimeError> {
        match scope {
            TeardownScope::Account { account_id } => self.replica.delete_account(account_id).await,
            TeardownScope::Device => self.replica.wipe_device().await,
        }
    }
}
