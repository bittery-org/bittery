use super::*;
use crate::attachment_artifact_store::{
    AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
};
use async_trait::async_trait;
use std::collections::BTreeSet;

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
    accounts: BTreeSet<AccountId>,
}

impl PendingTeardown {
    fn insert(&mut self, scope: &TeardownScope) {
        match scope {
            TeardownScope::Account { account_id } => {
                self.accounts.insert(account_id.clone());
            }
            TeardownScope::Device => self.device = true,
        }
    }

    fn remove(&mut self, scope: &TeardownScope) {
        match scope {
            TeardownScope::Account { account_id } => {
                self.accounts.remove(account_id);
            }
            // A converged Wipe destroyed every Account, so it also clears their narrower scopes.
            TeardownScope::Device => {
                self.device = false;
                self.accounts.clear();
            }
        }
    }

    fn contains_account(&self, account_id: &AccountId) -> bool {
        self.rejects(Some(account_id))
    }

    /// Device scope fences everything, including a request that names no Account.
    fn rejects(&self, account_id: Option<&AccountId>) -> bool {
        self.device || account_id.is_some_and(|account_id| self.accounts.contains(account_id))
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
    /// A Device `Wipe` needs only a Runtime that is not closed. Its phases are namespace-wide and
    /// read no catalog, and `catalog_transition` still serializes them against a concurrent
    /// `open()`. That relaxation is the whole point: `open()` fails for as long as the Device
    /// catalog and the durable Replica disagree, which is what a cleared IndexedDB beside a kept
    /// `localStorage` leaves behind, and a wipe is the only way out of it.
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
        let mut account_ids = match &scope {
            TeardownScope::Account { account_id } => vec![account_id.clone()],
            TeardownScope::Device => self.known_teardown_accounts(),
        };
        account_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
        account_ids.dedup();
        let execution_locks: Vec<_> = account_ids
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
        match &scope {
            TeardownScope::Account { account_id } => {
                self.retire_attachment_download_account(account_id).await;
                self.retire_attachment_upload_account(account_id).await;
            }
            TeardownScope::Device => {
                self.retire_all_attachment_downloads().await;
                self.retire_all_attachment_uploads().await;
            }
        }
        {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            self.pending_teardown
                .lock()
                .expect("pending teardown lock poisoned")
                .insert(&scope);
        }

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
        let platform = self.delete_platform_state(&scope).await;
        if platform.result.is_err() {
            failures.push(TeardownPhase::PlatformStorage);
        }
        if !platform.replica_allowed || self.delete_replica_state(&scope).await.is_err() {
            failures.push(TeardownPhase::Replica);
        }

        drop(execution_guards);
        if failures.is_empty() {
            if let TeardownScope::Account { account_id } = &scope {
                self.complete_attachment_download_account_retirement(account_id)
                    .await;
                self.complete_attachment_upload_account_retirement(account_id)
                    .await;
            }
            let _publication = self.publication.lock().expect("publication lock poisoned");
            self.pending_teardown
                .lock()
                .expect("pending teardown lock poisoned")
                .remove(&scope);
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

    pub(super) fn account_teardown_is_pending(&self, account_id: &AccountId) -> bool {
        self.pending_teardown
            .lock()
            .expect("pending teardown lock poisoned")
            .contains_account(account_id)
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

    async fn delete_platform_state(&self, scope: &TeardownScope) -> PlatformDeletion {
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
                                .into_iter()
                                .filter(|account| &account.account_id != account_id)
                                .collect();
                            let updated = match DeviceCatalogDocument::new(retained) {
                                Ok(updated) => updated,
                                Err(error) => {
                                    return PlatformDeletion {
                                        result: Err(error),
                                        replica_allowed: false,
                                    }
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
                        }
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
                let result = self.platform_storage.wipe_runtime_namespace().await;
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
