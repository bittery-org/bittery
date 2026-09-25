use super::*;
use crate::recovery::{
    control::{
        RecoveryControlRequest as Control, RecoveryControlResponse as Reply,
        RecoveryUnavailableReason, SerializedRecoveryExecutor,
    },
    transfer::{export_snapshot, RecoveryPort},
};
use crate::{
    RecoveryDeviceStatus, RecoveryMaintenanceStatus, RecoverySchemaStatus, RecoveryStorageState,
    StorageRecoveryAccount, StorageRecoveryDiagnostics,
};
use zeroize::Zeroize;

struct RecoveryRequest(RuntimeRequest);
impl Drop for RecoveryRequest {
    fn drop(&mut self) {
        match &mut self.0 {
            RuntimeRequest::ExportAccountRecovery { password, .. }
            | RuntimeRequest::RepairAccountRecovery { password, .. } => password.zeroize(),
            _ => {}
        }
    }
}

#[derive(Default)]
pub(super) struct StorageRecovery {
    executor: Mutex<Option<Arc<dyn SerializedRecoveryExecutor>>>,
    serial: tokio::sync::Mutex<()>,
    closed: AtomicBool,
    retired: AtomicBool,
    active: Mutex<Option<Arc<RecoveryPort>>>,
}
impl Runtime {
    /// Installs one physical recovery family before opening this owner. No alternate Runtime or
    /// cryptographic owner is created when normal opening later fails.
    #[doc(hidden)]
    pub fn set_recovery_executor(
        &self,
        executor: Arc<dyn SerializedRecoveryExecutor>,
    ) -> Result<(), RuntimeError> {
        self.ensure_not_closed()?;
        let mut installed = self
            .storage_recovery
            .executor
            .lock()
            .expect("recovery executor lock poisoned");
        if self.ready.load(Ordering::SeqCst) || installed.is_some() {
            return Err(recovery_unavailable());
        }
        *installed = Some(executor);
        Ok(())
    }

    pub(super) async fn close_with_recovery(&self) {
        self.storage_recovery.closed.store(true, Ordering::SeqCst);
        if let Some(port) = self
            .storage_recovery
            .active
            .lock()
            .expect("recovery active lock poisoned")
            .as_ref()
        {
            port.cancel();
        }
        if !self.storage_recovery.retired.load(Ordering::SeqCst)
            || ActiveRuntimeDelivery::is_active(self.identity())
        {
            self.close_normal_owner().await;
            return;
        }
        let _serial = self.storage_recovery.serial.lock().await;
        let active = self
            .storage_recovery
            .active
            .lock()
            .expect("recovery active lock poisoned")
            .clone();
        if let Some(port) = active {
            // A failed physical release preserves exclusion. As with other owner retirement,
            // teardown cannot report completion while callbacks may still own durable writes.
            let mut failures = 0_u32;
            loop {
                if matches!(
                    port.invoke_cleanup(
                        Control::LeaveMaintenance {
                            recovery_id: port.recovery_id.clone()
                        },
                        None
                    )
                    .await,
                    Ok((Reply::MaintenanceLeft, None))
                ) {
                    break;
                }
                self.device_timer.sleep_ms(10_u64 << failures.min(7)).await;
                failures = failures.saturating_add(1);
            }
            self.storage_recovery
                .active
                .lock()
                .expect("recovery active lock poisoned")
                .take();
        }
        self.close_normal_owner().await;
    }

    pub(super) async fn request_storage_recovery(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let request = RecoveryRequest(request);
        let _serial = self.storage_recovery.serial.lock().await;
        if self.storage_recovery.closed.load(Ordering::SeqCst)
            || (self.is_closed() && !self.storage_recovery.retired.load(Ordering::SeqCst))
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::RuntimeClosed,
                "Runtime is closed",
            ));
        }
        let executor = self
            .storage_recovery
            .executor
            .lock()
            .expect("recovery executor lock poisoned")
            .clone()
            .ok_or_else(recovery_unavailable)?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Recovery was cancelled",
            ));
        }
        self.storage_recovery.retired.store(true, Ordering::SeqCst);
        self.close_normal_owner().await;
        if self.storage_recovery.closed.load(Ordering::SeqCst) || cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Recovery was cancelled",
            ));
        }
        if self
            .storage_recovery
            .active
            .lock()
            .expect("recovery active lock poisoned")
            .is_some()
        {
            return Err(recovery_unavailable());
        }
        let port = Arc::new(
            RecoveryPort::new(executor, bittery_crypto_core::generate_uuid(), cancellation)
                .with_platform_storage(self.platform_storage.as_ref().clone()),
        );
        *self
            .storage_recovery
            .active
            .lock()
            .expect("recovery active lock poisoned") = Some(port.clone());
        let entered = port
            .invoke_raw(
                Control::EnterMaintenance {
                    recovery_id: port.recovery_id.clone(),
                },
                None,
            )
            .await;
        let admitted = matches!(&entered, Ok((Reply::MaintenanceEntered { physical_schemas }, None)) if port.record_physical_schemas(*physical_schemas));
        if !admitted {
            let left = port
                .invoke_cleanup(
                    Control::LeaveMaintenance {
                        recovery_id: port.recovery_id.clone(),
                    },
                    None,
                )
                .await;
            if !matches!(left, Ok((Reply::MaintenanceLeft, None))) {
                return Err(recovery_unavailable());
            }
            self.storage_recovery
                .active
                .lock()
                .expect("recovery active lock poisoned")
                .take();
            if let Ok((Reply::LimitExceeded { bound }, None)) = &entered {
                return Err(crate::recovery::limits::exceeded(*bound));
            }
            if let Ok((Reply::Unavailable { reason }, None)) = entered {
                if matches!(request.0, RuntimeRequest::InspectRecovery { .. })
                    && reason != RecoveryUnavailableReason::Cancelled
                {
                    let catalog = self
                        .platform_storage
                        .load_device_catalog()
                        .await
                        .ok()
                        .flatten();
                    let accounts = catalog
                        .as_ref()
                        .map(|catalog| {
                            catalog
                                .accounts
                                .iter()
                                .map(|entry| StorageRecoveryAccount {
                                    account_id: entry.account_id.clone(),
                                    email: None,
                                    server_url: None,
                                    user_id: None,
                                    can_rebootstrap: false,
                                    state: RecoveryStorageState::Unknown,
                                    operation_count: None,
                                    receipt_count: None,
                                    missing_artifacts: None,
                                    can_export: false,
                                    can_repair: false,
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    return Ok(RuntimeResponse::RecoveryDiagnosed {
                        diagnostics: StorageRecoveryDiagnostics {
                            failure: Some(crate::recovery::transfer::unavailable(reason).code),
                            schema: if reason == RecoveryUnavailableReason::UnsupportedSchema {
                                RecoverySchemaStatus::Unsupported
                            } else {
                                RecoverySchemaStatus::Unknown
                            },
                            maintenance: match reason {
                                RecoveryUnavailableReason::Unsupported => {
                                    RecoveryMaintenanceStatus::Unsupported
                                }
                                RecoveryUnavailableReason::Busy => RecoveryMaintenanceStatus::Busy,
                                _ => RecoveryMaintenanceStatus::Unavailable,
                            },
                            device: if catalog.is_some() {
                                RecoveryDeviceStatus::KnownAccounts
                            } else {
                                RecoveryDeviceStatus::StorageUnavailable
                            },
                            accounts,
                        },
                    });
                }
                return Err(crate::recovery::transfer::unavailable(reason));
            }
            return Err(entered.err().unwrap_or_else(recovery_unavailable));
        }
        let result = self.execute_storage_recovery(&port, &request.0).await;
        let left = port
            .invoke_cleanup(
                Control::LeaveMaintenance {
                    recovery_id: port.recovery_id.clone(),
                },
                None,
            )
            .await;
        if !matches!(left, Ok((Reply::MaintenanceLeft, None))) {
            return Err(recovery_unavailable());
        }
        self.storage_recovery
            .active
            .lock()
            .expect("recovery active lock poisoned")
            .take();
        if port.cancellation.is_cancelled()
            && !matches!(result, Ok(RuntimeResponse::RecoveryRepaired { .. }))
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Recovery was cancelled",
            ));
        }
        result
    }

    async fn execute_storage_recovery(
        &self,
        port: &RecoveryPort,
        request: &RuntimeRequest,
    ) -> Result<RuntimeResponse, RuntimeError> {
        use crate::recovery::{
            capture::capture,
            repair::{can_rebootstrap, can_repair, rebootstrap, repair_bundle},
        };
        match request {
            RuntimeRequest::InspectRecovery { account_id } => {
                let catalog = self.platform_storage.load_device_catalog().await;
                let mut ids = std::collections::BTreeSet::new();
                if let Ok(Some(catalog)) = &catalog {
                    ids.extend(
                        catalog
                            .accounts
                            .iter()
                            .map(|entry| entry.account_id.clone()),
                    );
                }
                ids.extend(list_accounts(port).await?);
                if let Some(account_id) = account_id {
                    ids.retain(|id| id == account_id);
                }
                let known_accounts = !ids.is_empty();
                let mut accounts = Vec::new();
                let mut failure = catalog.as_ref().err().map(|error| error.code);
                for id in ids {
                    let snapshot = capture(port, &id).await?;
                    failure = failure.or(snapshot.failure);
                    let metadata = self.recovery_metadata(&id).await;
                    let identity = self.recovery_identity(&id, metadata.as_ref()).await;
                    let state = if snapshot.head_json.is_none() {
                        if snapshot.read_complete {
                            RecoveryStorageState::Missing
                        } else {
                            RecoveryStorageState::Unreadable
                        }
                    } else if !snapshot.can_preserve_work() || snapshot.needs_rebuild() {
                        RecoveryStorageState::Corrupt
                    } else if snapshot
                        .proof
                        .as_ref()
                        .is_some_and(|proof| proof.head.failure.is_some())
                    {
                        RecoveryStorageState::Unknown
                    } else {
                        RecoveryStorageState::Ready
                    };
                    accounts.push(StorageRecoveryAccount {
                        account_id: id,
                        email: metadata.as_ref().map(|value| value.email.clone()),
                        server_url: metadata
                            .as_ref()
                            .map(|value| value.normalized_server_url.clone()),
                        user_id: metadata.as_ref().map(|value| value.user_id.clone()),
                        state,
                        operation_count: snapshot
                            .proof
                            .as_ref()
                            .filter(|_| snapshot.read_complete)
                            .map(|proof| proof.operation_count + proof.preparation_count),
                        receipt_count: snapshot
                            .proof
                            .as_ref()
                            .filter(|_| snapshot.read_complete)
                            .map(|proof| proof.receipt_count),
                        missing_artifacts: snapshot.can_preserve_work().then_some(0),
                        can_export: snapshot.record_count > 0,
                        can_repair: identity
                            .as_ref()
                            .is_some_and(|identity| can_repair(&snapshot, identity)),
                        can_rebootstrap: identity
                            .as_ref()
                            .is_some_and(|identity| can_rebootstrap(&snapshot, identity)),
                    });
                }
                Ok(RuntimeResponse::RecoveryDiagnosed {
                    diagnostics: StorageRecoveryDiagnostics {
                        failure,
                        schema: RecoverySchemaStatus::Supported,
                        maintenance: RecoveryMaintenanceStatus::Available,
                        device: if catalog.is_err() {
                            RecoveryDeviceStatus::StorageUnavailable
                        } else if known_accounts {
                            RecoveryDeviceStatus::KnownAccounts
                        } else {
                            RecoveryDeviceStatus::FreshOrUnknown
                        },
                        accounts,
                    },
                })
            }
            RuntimeRequest::ExportAccountRecovery {
                account_id,
                password,
                sink_capability_id,
            } => {
                let known = list_accounts(port).await?;
                let catalog = self
                    .platform_storage
                    .load_device_catalog()
                    .await
                    .ok()
                    .flatten();
                if !known.contains(account_id)
                    && !catalog.as_ref().is_some_and(|catalog| {
                        catalog
                            .accounts
                            .iter()
                            .any(|entry| &entry.account_id == account_id)
                    })
                {
                    return Err(recovery_unavailable());
                }
                let metadata = self.recovery_metadata(account_id).await;
                let identity = self.recovery_identity(account_id, metadata.as_ref()).await;
                let snapshot = match capture(port, account_id).await {
                    Ok(snapshot) => snapshot,
                    Err(error) => {
                        let _ = port
                            .invoke_cleanup(
                                Control::SinkDiscard {
                                    recovery_id: port.recovery_id.clone(),
                                    account_id: account_id.as_str().into(),
                                    capability_id: sink_capability_id.clone(),
                                },
                                None,
                            )
                            .await;
                        return Err(error);
                    }
                };
                let bound = identity.as_ref().is_some_and(|identity| {
                    snapshot.proof.as_ref().is_some_and(|proof| {
                        proof.head.account_id == identity.account_id
                            && proof.head.user_id == identity.user_id
                            && proof.head.incarnation == identity.incarnation
                    })
                });
                let (byte_length, classification) = export_snapshot(
                    port,
                    account_id,
                    metadata
                        .as_ref()
                        .map(|value| value.normalized_server_url.clone()),
                    if bound {
                        metadata.as_ref().map(|value| value.user_id.clone())
                    } else {
                        None
                    },
                    password,
                    sink_capability_id,
                    &snapshot,
                )
                .await?;
                Ok(RuntimeResponse::RecoveryExported {
                    account_id: account_id.clone(),
                    classification,
                    byte_length,
                })
            }
            RuntimeRequest::RepairAccountRecovery {
                account_id,
                password,
                source_capability_id,
            } => {
                let metadata = self.recovery_metadata(account_id).await;
                let identity = self
                    .recovery_identity(account_id, metadata.as_ref())
                    .await
                    .ok_or_else(recovery_unavailable)?;
                let current = capture(port, account_id).await?;
                let replica_revision =
                    repair_bundle(port, &identity, &current, password, source_capability_id)
                        .await?;
                Ok(RuntimeResponse::RecoveryRepaired {
                    account_id: account_id.clone(),
                    replica_revision,
                })
            }
            RuntimeRequest::RebootstrapAccountRecovery { account_id } => {
                let metadata = self.recovery_metadata(account_id).await;
                let identity = self
                    .recovery_identity(account_id, metadata.as_ref())
                    .await
                    .ok_or_else(recovery_unavailable)?;
                let current = capture(port, account_id).await?;
                let replica_revision = rebootstrap(port, &identity, &current).await?;
                Ok(RuntimeResponse::RecoveryRepaired {
                    account_id: account_id.clone(),
                    replica_revision,
                })
            }
            _ => Err(recovery_unavailable()),
        }
    }
    async fn recovery_metadata(
        &self,
        account_id: &AccountId,
    ) -> Option<crate::platform_storage::AccountMetadataDocument> {
        let catalog = self
            .platform_storage
            .load_device_catalog()
            .await
            .ok()
            .flatten()?;
        let entry = catalog
            .accounts
            .iter()
            .find(|entry| &entry.account_id == account_id)?;
        let incarnation = entry.active_incarnation.as_ref().or_else(|| {
            entry
                .pending_install
                .as_ref()
                .map(|intent| &intent.incarnation)
        })?;
        self.platform_storage
            .load_account_metadata(account_id, incarnation)
            .await
            .ok()
            .flatten()
    }
    async fn recovery_identity(
        &self,
        account_id: &AccountId,
        metadata: Option<&crate::platform_storage::AccountMetadataDocument>,
    ) -> Option<crate::recovery::repair::RecoveryIdentity> {
        let metadata = metadata?;
        let catalog = self
            .platform_storage
            .load_device_catalog()
            .await
            .ok()
            .flatten()?;
        let entry = catalog
            .accounts
            .iter()
            .find(|entry| &entry.account_id == account_id)?;
        let incarnation = entry.active_incarnation.as_ref()?;
        if entry.pending_install.is_some() || metadata.incarnation != *incarnation {
            return None;
        }
        Some(crate::recovery::repair::RecoveryIdentity {
            account_id: account_id.clone(),
            incarnation: incarnation.clone(),
            user_id: metadata.user_id.clone(),
            server_url: metadata.normalized_server_url.clone(),
        })
    }
}
fn recovery_unavailable() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::StorageUnavailable,
        "Account recovery is unavailable",
    )
}

async fn list_accounts(
    port: &RecoveryPort,
) -> Result<std::collections::BTreeSet<AccountId>, RuntimeError> {
    let mut ids = std::collections::BTreeSet::new();
    let mut seen = std::collections::HashSet::new();
    let mut cursor = None;
    let mut cursor_bytes = 0usize;
    loop {
        let (response, binary) = port
            .invoke(
                Control::ListAccounts {
                    recovery_id: port.recovery_id.clone(),
                    cursor,
                },
                None,
            )
            .await?;
        if binary.is_some() {
            return Err(recovery_unavailable());
        }
        match response {
            Reply::End => break,
            Reply::AccountEntry {
                account_id,
                cursor: observed,
                next_cursor,
            } => {
                cursor_bytes = cursor_bytes.checked_add(observed.len()).ok_or_else(|| {
                    crate::recovery::limits::exceeded(crate::RecoveryBound::SummaryBytes)
                })?;
                if account_id.len() > 128 {
                    return Err(crate::recovery::limits::exceeded(
                        crate::RecoveryBound::RecordBytes,
                    ));
                }
                if observed.len() > 1024
                    || next_cursor
                        .as_ref()
                        .is_some_and(|cursor| cursor.len() > 1024)
                {
                    return Err(crate::recovery::limits::exceeded(
                        crate::RecoveryBound::CursorBytes,
                    ));
                }
                if cursor_bytes > 16 * 1024 * 1024 {
                    return Err(crate::recovery::limits::exceeded(
                        crate::RecoveryBound::SummaryBytes,
                    ));
                }
                if seen.len() >= 100_000 {
                    return Err(crate::recovery::limits::exceeded(
                        crate::RecoveryBound::RecordCount,
                    ));
                }
                if account_id.is_empty() || observed.is_empty() || !seen.insert(observed) {
                    return Err(recovery_unavailable());
                }
                ids.insert(AccountId::from(account_id));
                if ids.len() > 1024 {
                    return Err(crate::recovery::limits::exceeded(
                        crate::RecoveryBound::RecordCount,
                    ));
                }
                let Some(next) = next_cursor else {
                    break;
                };
                if next.is_empty() || seen.contains(&next) {
                    return Err(recovery_unavailable());
                }
                cursor = Some(next);
            }
            _ => return Err(recovery_unavailable()),
        }
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::operation_fixtures::MemoryPlatform;
    use std::sync::atomic::AtomicUsize;

    struct Maintenance {
        enters: AtomicUsize,
        leaves: AtomicUsize,
        cancels: AtomicUsize,
        enter_fault: AtomicUsize,
        leave_failures: AtomicUsize,
        hold: AtomicBool,
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }
    impl Maintenance {
        fn new(hold: bool) -> Arc<Self> {
            Arc::new(Self {
                enters: AtomicUsize::new(0),
                leaves: AtomicUsize::new(0),
                cancels: AtomicUsize::new(0),
                enter_fault: AtomicUsize::new(0),
                leave_failures: AtomicUsize::new(0),
                hold: AtomicBool::new(hold),
                entered: tokio::sync::Notify::new(),
                release: tokio::sync::Notify::new(),
            })
        }
    }
    #[async_trait::async_trait]
    impl SerializedRecoveryExecutor for Maintenance {
        fn cancel(&self, _: &str) {
            self.cancels.fetch_add(1, Ordering::SeqCst);
        }
        async fn invoke(
            &self,
            request: String,
            binary: Option<Vec<u8>>,
        ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
            assert!(binary.is_none());
            let response = match serde_json::from_str::<Control>(&request).unwrap() {
                Control::EnterMaintenance { .. } => {
                    self.enters.fetch_add(1, Ordering::SeqCst);
                    self.entered.notify_one();
                    if self.hold.load(Ordering::SeqCst) {
                        self.release.notified().await;
                    }
                    match self.enter_fault.swap(0, Ordering::SeqCst) {
                        1 => return Err(recovery_unavailable()),
                        2 => return Ok(("malformed acquired acknowledgement".into(), None)),
                        4 => Reply::LimitExceeded {
                            bound: crate::RecoveryBound::SummaryBytes,
                        },
                        3 => Reply::Unavailable {
                            reason: RecoveryUnavailableReason::UnsupportedSchema,
                        },
                        _ => Reply::MaintenanceEntered {
                            physical_schemas: crate::recovery::control::TEST_PHYSICAL_SCHEMAS,
                        },
                    }
                }
                Control::ListAccounts { .. } => Reply::End,
                Control::LeaveMaintenance { .. } => {
                    self.leaves.fetch_add(1, Ordering::SeqCst);
                    if self
                        .leave_failures
                        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                            value.checked_sub(1)
                        })
                        .is_ok()
                    {
                        return Err(recovery_unavailable());
                    }
                    Reply::MaintenanceLeft
                }
                _ => panic!("unexpected maintenance command"),
            };
            Ok((serde_json::to_string(&response).unwrap(), None))
        }
    }
    fn runtime(platform: Arc<PlatformStorage>) -> Arc<Runtime> {
        Runtime::with_persistence(
            Arc::new(InMemoryReplica::default()),
            platform,
            Arc::new(HttpTransport::unavailable()),
            None,
            None,
            false,
            Arc::new(SystemClock),
            Arc::new(SystemDeviceTimer),
            None,
        )
    }
    #[tokio::test]
    async fn failed_open_same_runtime_can_inspect_without_reopening_normal_owner() {
        let runtime = runtime(Arc::new(PlatformStorage::unavailable()));
        let executor = Maintenance::new(false);
        runtime.set_recovery_executor(executor.clone()).unwrap();
        assert!(runtime.open().await.is_err());
        let result = runtime
            .request(
                RuntimeRequest::InspectRecovery { account_id: None },
                RequestCancellation::default(),
            )
            .await
            .unwrap();
        assert!(matches!(
            result,
            RuntimeResponse::RecoveryDiagnosed {
                diagnostics: StorageRecoveryDiagnostics {
                    device: RecoveryDeviceStatus::StorageUnavailable,
                    ..
                }
            }
        ));
        assert!(runtime.is_closed());
        assert!(runtime.open().await.is_err());
        assert_eq!(executor.enters.load(Ordering::SeqCst), 1);
        assert_eq!(executor.leaves.load(Ordering::SeqCst), 1);
        runtime.close().await;
        assert!(runtime
            .request(
                RuntimeRequest::InspectRecovery { account_id: None },
                RequestCancellation::default()
            )
            .await
            .is_err());
    }
    #[tokio::test]
    async fn healthy_fresh_device_recovery_is_explicitly_unknown_and_requires_new_normal_owner() {
        let platform = MemoryPlatform::new();
        let runtime = runtime(Arc::new(PlatformStorage::new(platform)));
        runtime
            .set_recovery_executor(Maintenance::new(false))
            .unwrap();
        runtime.open().await.unwrap();
        let result = runtime
            .request(
                RuntimeRequest::InspectRecovery { account_id: None },
                RequestCancellation::default(),
            )
            .await
            .unwrap();
        assert!(
            matches!(result, RuntimeResponse::RecoveryDiagnosed { diagnostics: StorageRecoveryDiagnostics { device: RecoveryDeviceStatus::FreshOrUnknown, accounts, .. } } if accounts.is_empty())
        );
        assert!(runtime.is_closed());
        assert!(runtime.open().await.is_err());
        runtime.close().await;
    }
    #[tokio::test]
    async fn close_waits_for_inflight_recovery_entry_and_releases_maintenance() {
        let runtime = runtime(Arc::new(PlatformStorage::new(MemoryPlatform::new())));
        let executor = Maintenance::new(true);
        runtime.set_recovery_executor(executor.clone()).unwrap();
        runtime.open().await.unwrap();
        let requesting = tokio::spawn({
            let runtime = runtime.clone();
            async move {
                runtime
                    .request(
                        RuntimeRequest::InspectRecovery { account_id: None },
                        RequestCancellation::default(),
                    )
                    .await
            }
        });
        executor.entered.notified().await;
        let closing = tokio::spawn({
            let runtime = runtime.clone();
            async move { runtime.close().await }
        });
        tokio::task::yield_now().await;
        assert!(!closing.is_finished());
        assert!(executor.cancels.load(Ordering::SeqCst) > 0);
        executor.release.notify_one();
        assert!(requesting.await.unwrap().is_err());
        closing.await.unwrap();
        assert_eq!(executor.leaves.load(Ordering::SeqCst), 1);
        assert!(runtime.storage_recovery.active.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn ambiguous_acquired_maintenance_entry_is_released_before_another_attempt() {
        for fault in [1, 2, 4] {
            let runtime = runtime(Arc::new(PlatformStorage::new(MemoryPlatform::new())));
            let executor = Maintenance::new(false);
            executor.enter_fault.store(fault, Ordering::SeqCst);
            runtime.set_recovery_executor(executor.clone()).unwrap();
            let error = runtime
                .request(
                    RuntimeRequest::InspectRecovery { account_id: None },
                    RequestCancellation::default(),
                )
                .await
                .unwrap_err();
            if fault == 4 {
                assert_eq!(error.code, RuntimeErrorCode::SizeRejected);
                assert_eq!(
                    error.recovery_bound,
                    Some(crate::RecoveryBound::SummaryBytes)
                );
            }
            assert_eq!(executor.leaves.load(Ordering::SeqCst), 1);
            assert!(runtime.storage_recovery.active.lock().unwrap().is_none());
            assert!(runtime
                .request(
                    RuntimeRequest::InspectRecovery { account_id: None },
                    RequestCancellation::default()
                )
                .await
                .is_ok());
            assert_eq!(executor.enters.load(Ordering::SeqCst), 2);
            assert_eq!(executor.leaves.load(Ordering::SeqCst), 2);
            runtime.close().await;
        }
    }
    #[tokio::test]
    async fn failed_ambiguous_entry_cleanup_retains_the_port_until_close_confirms_release() {
        let runtime = runtime(Arc::new(PlatformStorage::new(MemoryPlatform::new())));
        let executor = Maintenance::new(false);
        executor.enter_fault.store(1, Ordering::SeqCst);
        executor.leave_failures.store(1, Ordering::SeqCst);
        runtime.set_recovery_executor(executor.clone()).unwrap();
        assert!(runtime
            .request(
                RuntimeRequest::InspectRecovery { account_id: None },
                RequestCancellation::default()
            )
            .await
            .is_err());
        assert!(runtime.storage_recovery.active.lock().unwrap().is_some());
        assert!(runtime
            .request(
                RuntimeRequest::InspectRecovery { account_id: None },
                RequestCancellation::default()
            )
            .await
            .is_err());
        assert_eq!(executor.enters.load(Ordering::SeqCst), 1);
        runtime.close().await;
        assert_eq!(executor.leaves.load(Ordering::SeqCst), 2);
        assert!(runtime.storage_recovery.active.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn future_schema_is_diagnosed_separately_from_unavailable_maintenance() {
        let runtime = runtime(Arc::new(PlatformStorage::new(MemoryPlatform::new())));
        let executor = Maintenance::new(false);
        executor.enter_fault.store(3, Ordering::SeqCst);
        runtime.set_recovery_executor(executor).unwrap();
        let result = runtime
            .request(
                RuntimeRequest::InspectRecovery { account_id: None },
                RequestCancellation::default(),
            )
            .await
            .unwrap();
        assert!(matches!(
            result,
            RuntimeResponse::RecoveryDiagnosed {
                diagnostics: StorageRecoveryDiagnostics {
                    schema: RecoverySchemaStatus::Unsupported,
                    maintenance: RecoveryMaintenanceStatus::Unavailable,
                    ..
                }
            }
        ));
        runtime.close().await;
    }

    struct HeadPrefixOnly {
        fail_tail: bool,
    }
    #[async_trait::async_trait]
    impl SerializedRecoveryExecutor for HeadPrefixOnly {
        async fn invoke(
            &self,
            request: String,
            binary: Option<Vec<u8>>,
        ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
            assert!(binary.is_none());
            let response = match serde_json::from_str::<Control>(&request).unwrap() {
                Control::EnterMaintenance { .. } => Reply::MaintenanceEntered {
                    physical_schemas: crate::recovery::control::TEST_PHYSICAL_SCHEMAS,
                },
                Control::ListAccounts { .. } => Reply::AccountEntry {
                    account_id: "account".into(),
                    cursor: "account".into(),
                    next_cursor: None,
                },
                Control::ReadEntry { cursor: None, .. } => Reply::Entry {
                    cursor: "head".into(),
                    next_cursor: Some("after-head".into()),
                    record: crate::recovery::control::RecoveryRecord::RawReplicaHead {
                        account_id: "account".into(),
                        payload_json: serde_json::json!({
                            "accountId":"account", "userId":"user", "incarnation":"incarnation",
                            "replicaRevision":"7", "lockEpoch":"2", "failure":null,
                        })
                        .to_string(),
                    },
                },
                Control::ReadEntry { .. } if self.fail_tail => Reply::Unavailable {
                    reason: RecoveryUnavailableReason::StorageUnavailable,
                },
                Control::ReadEntry { .. } => Reply::End,
                Control::LeaveMaintenance { .. } => Reply::MaintenanceLeft,
                _ => panic!("diagnostics must not mutate source storage"),
            };
            Ok((serde_json::to_string(&response).unwrap(), None))
        }
    }
    #[tokio::test]
    async fn recovery_diagnostics_never_present_prefix_counts_as_known_totals() {
        for fail_tail in [true, false] {
            let runtime = runtime(Arc::new(PlatformStorage::new(MemoryPlatform::new())));
            runtime
                .set_recovery_executor(Arc::new(HeadPrefixOnly { fail_tail }))
                .unwrap();
            runtime.open().await.unwrap();
            let result = runtime
                .request(
                    RuntimeRequest::InspectRecovery { account_id: None },
                    RequestCancellation::default(),
                )
                .await
                .unwrap();
            let RuntimeResponse::RecoveryDiagnosed { diagnostics } = result else {
                panic!("missing diagnostics");
            };
            assert_eq!(diagnostics.accounts.len(), 1);
            let account = &diagnostics.accounts[0];
            let expected = if fail_tail { None } else { Some(0) };
            assert_eq!(account.operation_count, expected);
            assert_eq!(account.receipt_count, expected);
            assert_eq!(account.missing_artifacts, expected);
            assert!(!account.can_repair);
            assert!(!account.can_rebootstrap);
            assert!(account.can_export); // The readable head remains honest partial evidence.
            assert_eq!(account.email, None); // Physical scope alone cannot recreate catalog identity.
            runtime.close().await;
        }
    }
}
