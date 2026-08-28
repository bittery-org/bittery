use super::*;
use crate::{
    attachment_artifact_store::{
        AttachmentArtifactStore, AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
    },
    platform_storage::{
        AccountMetadataDocument, DeviceCatalogAccount, DeviceCatalogDocument,
        SerializedPlatformStorageExecutor,
    },
    replica::{
        GuardedCommitPlan, InMemoryReplica, PlanMutation, ReplicaPersistence,
        ReplicaPersistenceRequest, ReplicaPersistenceResponse,
    },
    test_fixtures::test_operation,
    TeardownPhase, TeardownScope, TeardownStatus,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use zeroize::Zeroizing;

#[derive(Default)]
struct RecordingSink;

impl ObservationSink for RecordingSink {
    fn publish(&self, _projection: RuntimeProjection) {}
}

#[derive(Clone, Copy)]
enum Fault {
    None,
    Artifact,
    WrongArtifactResponse,
    Host,
    WrongHostResponse,
    Platform,
    Replica,
    PlatformAndReplica,
    CatalogDetach,
}

struct ReplicaPort {
    inner: Arc<InMemoryReplica>,
    fail: AtomicBool,
    events: Arc<Mutex<Vec<&'static str>>>,
}

#[async_trait]
impl ReplicaPersistence for ReplicaPort {
    async fn invoke(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
        if matches!(
            request,
            ReplicaPersistenceRequest::DeleteAccount { .. } | ReplicaPersistenceRequest::WipeDevice
        ) {
            self.events.lock().unwrap().push("replica");
            if self.fail.swap(false, Ordering::SeqCst) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "SECRET_REPLICA_HOST_DETAIL",
                ));
            }
        }
        self.inner.invoke(request).await
    }
}

struct PlatformPort {
    values: Mutex<HashMap<(String, String), String>>,
    fail: AtomicBool,
    events: Arc<Mutex<Vec<&'static str>>>,
    fail_catalog_store: AtomicBool,
    invocations: AtomicUsize,
}

#[async_trait]
impl SerializedPlatformStorageExecutor for PlatformPort {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        self.invocations.fetch_add(1, Ordering::SeqCst);
        let request: Value = serde_json::from_str(&request_json).unwrap();
        let area = request["area"].as_str().unwrap().to_owned();
        match request["type"].as_str().unwrap() {
            "get" => {
                let key = request["key"].as_str().unwrap().to_owned();
                Ok(Zeroizing::new(json!({"type":"value", "value": self.values.lock().unwrap().get(&(area, key)).cloned()}).to_string()))
            }
            "set" => {
                let key = request["key"].as_str().unwrap().to_owned();
                if key.ends_with("device-catalog")
                    && self.fail_catalog_store.swap(false, Ordering::SeqCst)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "SECRET_CATALOG_STORE_DETAIL",
                    ));
                }
                let value = request["value"].as_str().unwrap().to_owned();
                self.values.lock().unwrap().insert((area, key), value);
                Ok(Zeroizing::new(json!({"type":"done"}).to_string()))
            }
            "delete" => {
                let key = request["key"].as_str().unwrap().to_owned();
                self.values.lock().unwrap().remove(&(area, key));
                Ok(Zeroizing::new(json!({"type":"done"}).to_string()))
            }
            "deletePrefix" => {
                self.events.lock().unwrap().push("platform");
                if self.fail.swap(false, Ordering::SeqCst) {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "SECRET_PLATFORM_HOST_DETAIL",
                    ));
                }
                let prefix = request["prefix"].as_str().unwrap();
                self.values
                    .lock()
                    .unwrap()
                    .retain(|(_, key), _| !key.starts_with(prefix));
                Ok(Zeroizing::new(json!({"type":"done"}).to_string()))
            }
            other => panic!("unexpected platform request {other}"),
        }
    }
}

struct ArtifactPause {
    reached: AtomicBool,
    released: AtomicBool,
    reached_notify: tokio::sync::Notify,
    release_notify: tokio::sync::Notify,
}

impl ArtifactPause {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            reached: AtomicBool::new(false),
            released: AtomicBool::new(false),
            reached_notify: tokio::sync::Notify::new(),
            release_notify: tokio::sync::Notify::new(),
        })
    }

    async fn wait_until_reached(&self) {
        while !self.reached.load(Ordering::SeqCst) {
            self.reached_notify.notified().await;
        }
    }

    fn release(&self) {
        self.released.store(true, Ordering::SeqCst);
        self.release_notify.notify_waiters();
    }
}

struct ArtifactPort {
    fail: AtomicBool,
    wrong: AtomicBool,
    events: Arc<Mutex<Vec<&'static str>>>,
    pause: Mutex<Option<Arc<ArtifactPause>>>,
}

#[async_trait]
impl AttachmentArtifactStore for ArtifactPort {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        self.events.lock().unwrap().push("artifact");
        let pause = self.pause.lock().unwrap().clone();
        if let Some(pause) = pause {
            pause.reached.store(true, Ordering::SeqCst);
            pause.reached_notify.notify_waiters();
            while !pause.released.load(Ordering::SeqCst) {
                pause.release_notify.notified().await;
            }
        }
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "SECRET_ARTIFACT_HOST_DETAIL",
            ));
        }
        if self.wrong.swap(false, Ordering::SeqCst) {
            return Ok(AttachmentArtifactStoreResponse::DeviceWiped);
        }
        match request {
            AttachmentArtifactStoreRequest::DeleteAccount { .. } => {
                Ok(AttachmentArtifactStoreResponse::AccountDeleted)
            }
            AttachmentArtifactStoreRequest::WipeDevice => {
                Ok(AttachmentArtifactStoreResponse::DeviceWiped)
            }
            _ => panic!("teardown invoked a non-destructive artifact request"),
        }
    }
}

struct HostPort {
    fail: AtomicBool,
    wrong: AtomicBool,
    events: Arc<Mutex<Vec<&'static str>>>,
    scopes: Mutex<Vec<TeardownHostCleanupRequest>>,
}

#[async_trait]
impl TeardownHostCleanup for HostPort {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        self.events.lock().unwrap().push("host");
        self.scopes.lock().unwrap().push(request.clone());
        if self.fail.swap(false, Ordering::SeqCst) {
            Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "SECRET_OPFS_HOST_DETAIL",
            ))
        } else if self.wrong.swap(false, Ordering::SeqCst) {
            Ok(TeardownHostCleanupResponse::DeviceWiped)
        } else {
            Ok(match request {
                TeardownHostCleanupRequest::DeleteAccount { .. } => {
                    TeardownHostCleanupResponse::AccountDeleted
                }
                TeardownHostCleanupRequest::WipeDevice => TeardownHostCleanupResponse::DeviceWiped,
            })
        }
    }
}

struct Harness {
    runtime: Arc<Runtime>,
    persistence: Arc<InMemoryReplica>,
    platform: Arc<PlatformPort>,
    host: Arc<HostPort>,
    artifacts: Arc<ArtifactPort>,
    replica_port: Arc<ReplicaPort>,
    events: Arc<Mutex<Vec<&'static str>>>,
}

fn teardown_harness(fault: Fault) -> Harness {
    build_teardown_harness(fault, true)
}

/// A Runtime that has not finished `open()`. A user reaches for "wipe this Device" exactly here,
/// so every Device phase has to work with no restored Account and no Replica cache.
fn wedged_teardown_harness(fault: Fault) -> Harness {
    build_teardown_harness(fault, false)
}

fn build_teardown_harness(fault: Fault, opened: bool) -> Harness {
    let events = Arc::new(Mutex::new(Vec::new()));
    let persistence = Arc::new(InMemoryReplica::default());
    persistence
        .install(
            AccountId::from("account-1"),
            "user-1".into(),
            "incarnation-1".into(),
        )
        .unwrap();
    persistence
        .install(
            AccountId::from("account-2"),
            "user-2".into(),
            "incarnation-2".into(),
        )
        .unwrap();
    let replica = Arc::new(ReplicaPort {
        inner: Arc::clone(&persistence),
        fail: AtomicBool::new(matches!(fault, Fault::Replica | Fault::PlatformAndReplica)),
        events: Arc::clone(&events),
    });
    let platform = Arc::new(PlatformPort {
        values: Mutex::new(HashMap::from([
            (
                (
                    "deviceSecret".into(),
                    "bittery:runtime:platform-storage:account:9:account-1:secret".into(),
                ),
                "one".into(),
            ),
            (
                (
                    "deviceSecret".into(),
                    "bittery:runtime:platform-storage:account:9:account-2:secret".into(),
                ),
                "two".into(),
            ),
        ])),
        fail: AtomicBool::new(matches!(fault, Fault::Platform | Fault::PlatformAndReplica)),
        events: Arc::clone(&events),
        fail_catalog_store: AtomicBool::new(matches!(fault, Fault::CatalogDetach)),
        invocations: AtomicUsize::new(0),
    });
    let artifacts = Arc::new(ArtifactPort {
        fail: AtomicBool::new(matches!(fault, Fault::Artifact)),
        wrong: AtomicBool::new(matches!(fault, Fault::WrongArtifactResponse)),
        events: Arc::clone(&events),
        pause: Mutex::new(None),
    });
    let host = Arc::new(HostPort {
        fail: AtomicBool::new(matches!(fault, Fault::Host)),
        wrong: AtomicBool::new(matches!(fault, Fault::WrongHostResponse)),
        events: Arc::clone(&events),
        scopes: Mutex::new(Vec::new()),
    });
    let runtime = if opened {
        Runtime::with_test_teardown_environment(
            replica.clone(),
            platform.clone(),
            artifacts.clone(),
            host.clone(),
        )
    } else {
        Runtime::restart_test_teardown_environment(
            replica.clone(),
            platform.clone(),
            artifacts.clone(),
            host.clone(),
        )
    };
    Harness {
        runtime,
        persistence,
        platform,
        host,
        artifacts,
        replica_port: replica,
        events,
    }
}

fn seed_restartable_catalog(harness: &Harness) {
    let account_id = AccountId::from("account-1");
    let incarnation = crate::protocol::Incarnation::from("incarnation-1");
    let catalog = DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
        account_id: account_id.clone(),
        active_incarnation: Some(incarnation.clone()),
        pending_install: None,
    }])
    .unwrap();
    let metadata = AccountMetadataDocument::new(
        account_id,
        incarnation,
        "user-1".into(),
        "person@example.test".into(),
        "Person".into(),
        "https://server.test".into(),
        None,
        None,
        "A3-…".into(),
        1,
        1,
        false,
        false,
        bittery_crypto_core::current_kdf_profile(),
        None,
    )
    .unwrap();
    harness.platform.values.lock().unwrap().insert(
        (
            "devicePlain".into(),
            "bittery:runtime:platform-storage:device-catalog".into(),
        ),
        serde_json::to_string(&catalog).unwrap(),
    );
    harness.platform.values.lock().unwrap().insert(
        (
            "devicePlain".into(),
            "bittery:runtime:platform-storage:account:9:account-1:incarnation:13:incarnation-1:metadata".into(),
        ),
        serde_json::to_string(&metadata).unwrap(),
    );
}

fn projected_account(runtime: &Runtime, account_id: &str) -> AccountStatus {
    let projected = runtime
        .projection(&ObservationRequest::RuntimeStatus {
            account_id: Some(AccountId::from(account_id)),
        })
        .unwrap();
    let RuntimeProjection::RuntimeStatus(status) = projected.projection else {
        panic!("expected Runtime status projection");
    };
    status.accounts.into_iter().next().unwrap()
}

#[tokio::test]
async fn remove_account_is_an_explicit_closed_runtime_request() {
    let runtime = Runtime::new();
    let response = runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: AccountId::from("account-1"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        response,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Account {
                account_id: AccountId::from("account-1")
            },
            status: TeardownStatus::Incomplete,
            failures: vec![
                TeardownPhase::AttachmentArtifacts,
                TeardownPhase::HostCleanup,
                TeardownPhase::PlatformStorage,
                TeardownPhase::Replica
            ],
        }
    );
}

#[tokio::test]
async fn named_teardown_fences_then_deletes_every_authority_without_crossing_account_scope() {
    let harness = teardown_harness(Fault::None);
    let target = AccountId::from("account-1");
    let installed = harness.persistence.snapshot(&target).unwrap();
    harness
        .persistence
        .execute(GuardedCommitPlan::new(
            target.clone(),
            installed.incarnation,
            installed.revision,
            installed.lock_epoch,
            vec![PlanMutation::AcceptOperation(test_operation(
                "pending-operation",
                "pending-item",
            ))],
        ))
        .unwrap();
    let lock = harness.runtime.account_execution_lock(&target).unwrap();
    let held = lock.lock().await;
    let runtime = Arc::clone(&harness.runtime);
    let request = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::RemoveAccount {
                    account_id: AccountId::from("account-1"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap()
    });
    tokio::task::yield_now().await;
    assert!(
        harness.events.lock().unwrap().is_empty(),
        "no delete starts before the Account execution fence"
    );
    drop(held);
    let response = request.await.unwrap();
    assert_eq!(
        response,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Account {
                account_id: AccountId::from("account-1")
            },
            status: TeardownStatus::Complete,
            failures: vec![]
        }
    );
    assert_eq!(
        *harness.events.lock().unwrap(),
        ["artifact", "host", "platform", "platform", "platform", "replica"]
    );
    assert!(harness.persistence.snapshot(&target).is_none());
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-2"))
        .is_some());
    assert!(harness
        .platform
        .values
        .lock()
        .unwrap()
        .keys()
        .any(|(_, key)| key.contains("account-2")));
    assert!(!harness
        .platform
        .values
        .lock()
        .unwrap()
        .keys()
        .any(|(_, key)| key.contains("account-1")));
    assert_eq!(
        *harness.host.scopes.lock().unwrap(),
        [TeardownHostCleanupRequest::DeleteAccount {
            account_id: AccountId::from("account-1")
        }]
    );
}

#[tokio::test]
async fn removed_account_display_identity_cannot_leak_into_a_recovered_account() {
    let harness = wedged_teardown_harness(Fault::None);
    seed_restartable_catalog(&harness);
    harness.runtime.open().await.unwrap();
    assert_eq!(
        projected_account(&harness.runtime, "account-1")
            .display_identity
            .map(|identity| identity.email),
        Some("person@example.test".into())
    );

    harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: AccountId::from("account-1"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(
        !harness
            .runtime
            .account_display_identities
            .lock()
            .unwrap()
            .contains_key(&AccountId::from("account-1")),
        "RemoveAccount retires its display identity before any replacement is installed"
    );
    harness
        .runtime
        .install_or_replace_account(
            AccountId::from("account-1"),
            "recovered-user".into(),
            "recovered-incarnation".into(),
        )
        .await
        .unwrap();

    assert_eq!(
        projected_account(&harness.runtime, "account-1").display_identity,
        None
    );
}

#[tokio::test]
async fn every_deletion_phase_is_redacted_bounded_and_an_identical_retry_converges() {
    for (fault, expected) in [
        (Fault::Artifact, TeardownPhase::AttachmentArtifacts),
        (
            Fault::WrongArtifactResponse,
            TeardownPhase::AttachmentArtifacts,
        ),
        (Fault::Host, TeardownPhase::HostCleanup),
        (Fault::Platform, TeardownPhase::PlatformStorage),
        (Fault::Replica, TeardownPhase::Replica),
    ] {
        let harness = teardown_harness(fault);
        let request = || RuntimeRequest::RemoveAccount {
            account_id: AccountId::from("account-1"),
        };
        let first = harness
            .runtime
            .request(request(), RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(
            first,
            RuntimeResponse::Teardown {
                scope: TeardownScope::Account {
                    account_id: AccountId::from("account-1")
                },
                status: TeardownStatus::Incomplete,
                failures: vec![expected]
            }
        );
        assert!(!serde_json::to_string(&first).unwrap().contains("SECRET_"));
        let retry = harness
            .runtime
            .request(request(), RequestCancellation::new())
            .await
            .unwrap();
        assert_eq!(
            retry,
            RuntimeResponse::Teardown {
                scope: TeardownScope::Account {
                    account_id: AccountId::from("account-1")
                },
                status: TeardownStatus::Complete,
                failures: vec![]
            }
        );
    }
}

#[tokio::test]
async fn wipe_is_explicit_and_deletes_all_known_and_orphan_device_authorities() {
    let harness = teardown_harness(Fault::None);
    harness
        .runtime
        .account_display_identities
        .lock()
        .unwrap()
        .extend([
            (
                AccountId::from("account-1"),
                AccountDisplayIdentity {
                    email: "one@example.test".into(),
                },
            ),
            (
                AccountId::from("account-2"),
                AccountDisplayIdentity {
                    email: "two@example.test".into(),
                },
            ),
            (
                AccountId::from("identity-only"),
                AccountDisplayIdentity {
                    email: "orphan@example.test".into(),
                },
            ),
        ]);
    harness.platform.values.lock().unwrap().insert(
        (
            "devicePlain".into(),
            "bittery:runtime:platform-storage:orphan".into(),
        ),
        "ciphertext".into(),
    );
    let response = harness
        .runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        response,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Device,
            status: TeardownStatus::Complete,
            failures: vec![]
        }
    );
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-1"))
        .is_none());
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-2"))
        .is_none());
    assert!(harness.platform.values.lock().unwrap().is_empty());
    assert!(
        harness
            .runtime
            .account_display_identities
            .lock()
            .unwrap()
            .is_empty(),
        "Wipe retires every cached Account display identity"
    );
    assert_eq!(
        *harness.host.scopes.lock().unwrap(),
        [TeardownHostCleanupRequest::WipeDevice]
    );
}

#[tokio::test]
async fn close_retires_every_cached_account_display_identity() {
    let runtime = Runtime::new();
    runtime.account_display_identities.lock().unwrap().insert(
        AccountId::from("account-1"),
        AccountDisplayIdentity {
            email: "person@example.test".into(),
        },
    );

    runtime.close().await;

    assert!(runtime
        .account_display_identities
        .lock()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn empty_remove_account_scope_is_rejected_without_touching_a_primitive() {
    let harness = teardown_harness(Fault::None);
    let error = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: AccountId::from(""),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(harness.events.lock().unwrap().is_empty());
}

#[tokio::test]
async fn teardown_serializes_both_an_already_admitted_request_and_a_later_racing_request() {
    let harness = teardown_harness(Fault::None);
    let account_two = AccountId::from("account-2");
    let ordinary_lock = harness
        .runtime
        .account_execution_lock(&account_two)
        .unwrap();
    let held_ordinary = ordinary_lock.lock().await;
    let ordinary_runtime = Arc::clone(&harness.runtime);
    let ordinary = tokio::spawn(async move {
        ordinary_runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: account_two,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap()
    });
    loop {
        if harness.runtime.teardown_admission.try_write().is_err() {
            break;
        }
        tokio::task::yield_now().await;
    }
    let teardown_runtime = Arc::clone(&harness.runtime);
    let teardown = tokio::spawn(async move {
        teardown_runtime
            .request(
                RuntimeRequest::RemoveAccount {
                    account_id: AccountId::from("account-1"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap()
    });
    assert!(harness.events.lock().unwrap().is_empty());
    drop(held_ordinary);
    assert!(matches!(
        ordinary.await.unwrap(),
        RuntimeResponse::AccessChanged { .. }
    ));
    assert!(matches!(
        teardown.await.unwrap(),
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));

    let harness = teardown_harness(Fault::None);
    let target_lock = harness
        .runtime
        .account_execution_lock(&AccountId::from("account-1"))
        .unwrap();
    let held_teardown = target_lock.lock().await;
    let teardown_runtime = Arc::clone(&harness.runtime);
    let teardown = tokio::spawn(async move {
        teardown_runtime
            .request(
                RuntimeRequest::RemoveAccount {
                    account_id: AccountId::from("account-1"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap()
    });
    loop {
        if harness.runtime.teardown_admission.try_read().is_err() {
            break;
        }
        tokio::task::yield_now().await;
    }
    let racing_runtime = Arc::clone(&harness.runtime);
    let racing = tokio::spawn(async move {
        racing_runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: AccountId::from("account-2"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap()
    });
    tokio::task::yield_now().await;
    assert!(
        !racing.is_finished(),
        "new admission waits behind irreversible teardown"
    );
    drop(held_teardown);
    assert!(matches!(
        teardown.await.unwrap(),
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
    assert!(matches!(
        racing.await.unwrap(),
        RuntimeResponse::AccessChanged { .. }
    ));
}

#[tokio::test]
async fn incomplete_teardown_keeps_the_selected_account_fenced_until_identical_retry_completes() {
    let harness = teardown_harness(Fault::PlatformAndReplica);
    let account = AccountId::from("account-1");
    let restored = harness
        .runtime
        .replica()
        .restore_known_accounts(std::slice::from_ref(&account))
        .await
        .unwrap();
    harness.runtime.replica().cache(restored[0].clone());
    let installed = harness.runtime.replica().snapshot(&account).unwrap();
    harness
        .runtime
        .execute_plan(GuardedCommitPlan::new(
            account.clone(),
            installed.incarnation,
            installed.revision,
            installed.lock_epoch,
            vec![PlanMutation::AcceptOperation(test_operation(
                "still-pending",
                "pending-item",
            ))],
        ))
        .await
        .unwrap();

    let first = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        first,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Account {
                account_id: account.clone(),
            },
            status: TeardownStatus::Incomplete,
            failures: vec![TeardownPhase::PlatformStorage, TeardownPhase::Replica],
        }
    );

    let unlock = harness
        .runtime
        .request(
            RuntimeRequest::QuickUnlock {
                account_id: account.clone(),
                master_password: "must-not-be-used".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(unlock.code, RuntimeErrorCode::AccountMissing);
    assert_eq!(unlock.message, "Account teardown is pending");
    let other = harness
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: AccountId::from("account-2"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(other, RuntimeResponse::AccessChanged { .. }));
    let platform_invocations = harness.platform.invocations.load(Ordering::SeqCst);
    let _ = harness.runtime.dispatch_eligible_operations().await;
    assert_eq!(
        harness.platform.invocations.load(Ordering::SeqCst),
        platform_invocations,
        "background dispatch must not revive a pending teardown Account",
    );

    let retry = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: account,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        retry,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
}

#[tokio::test]
async fn observation_admission_cannot_cross_a_held_delete_phase_and_wipe_closes_global_status() {
    let harness = teardown_harness(Fault::None);
    let global = harness
        .runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            Arc::new(RecordingSink),
        )
        .unwrap();
    let pause = ArtifactPause::new();
    *harness.artifacts.pause.lock().unwrap() = Some(Arc::clone(&pause));
    let runtime = Arc::clone(&harness.runtime);
    let wipe = tokio::spawn(async move {
        runtime
            .request(RuntimeRequest::Wipe, RequestCancellation::new())
            .await
            .unwrap()
    });
    pause.wait_until_reached().await;

    assert!(global.subscription.delivery.lock().unwrap().closed);
    let racing = harness.runtime.observe(
        ObservationRequest::RuntimeStatus { account_id: None },
        Arc::new(RecordingSink),
    );
    let Err(racing) = racing else {
        panic!("Wipe must reject racing observation admission");
    };
    assert_eq!(racing.code, RuntimeErrorCode::AccountMissing);
    assert_eq!(racing.message, "Account teardown is pending");

    pause.release();
    assert!(matches!(
        wipe.await.unwrap(),
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
}

#[tokio::test]
async fn account_teardown_closes_and_rejects_only_the_selected_observation_scope() {
    let harness = teardown_harness(Fault::None);
    let account_one = AccountId::from("account-1");
    let account_two = AccountId::from("account-2");
    let restored = harness
        .runtime
        .replica()
        .restore_known_accounts(&[account_one.clone(), account_two.clone()])
        .await
        .unwrap();
    for snapshot in restored {
        harness.runtime.replica().cache(snapshot);
    }
    let target = harness
        .runtime
        .observe(
            ObservationRequest::RuntimeStatus {
                account_id: Some(account_one.clone()),
            },
            Arc::new(RecordingSink),
        )
        .unwrap();
    let unrelated = harness
        .runtime
        .observe(
            ObservationRequest::RuntimeStatus {
                account_id: Some(account_two.clone()),
            },
            Arc::new(RecordingSink),
        )
        .unwrap();
    let pause = ArtifactPause::new();
    *harness.artifacts.pause.lock().unwrap() = Some(Arc::clone(&pause));
    let runtime = Arc::clone(&harness.runtime);
    let remove = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::RemoveAccount {
                    account_id: account_one.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap()
    });
    pause.wait_until_reached().await;
    assert!(target.subscription.delivery.lock().unwrap().closed);
    assert!(!unrelated.subscription.delivery.lock().unwrap().closed);

    let racing_target = harness.runtime.observe(
        ObservationRequest::RuntimeStatus {
            account_id: Some(AccountId::from("account-1")),
        },
        Arc::new(RecordingSink),
    );
    let Err(error) = racing_target else {
        panic!("selected Account observation must remain fenced");
    };
    assert_eq!(error.code, RuntimeErrorCode::AccountMissing);
    let racing_unrelated = harness.runtime.observe(
        ObservationRequest::RuntimeStatus {
            account_id: Some(account_two),
        },
        Arc::new(RecordingSink),
    );
    assert!(racing_unrelated.is_ok());

    pause.release();
    assert!(matches!(
        remove.await.unwrap(),
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
}

#[tokio::test]
async fn catalog_detachment_is_a_restart_safe_dependency_of_namespace_and_replica_deletion() {
    let harness = teardown_harness(Fault::CatalogDetach);
    seed_restartable_catalog(&harness);
    let account = AccountId::from("account-1");

    let first = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        first,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Account {
                account_id: account.clone(),
            },
            status: TeardownStatus::Incomplete,
            failures: vec![TeardownPhase::PlatformStorage, TeardownPhase::Replica],
        }
    );
    assert!(harness.persistence.snapshot(&account).is_some());
    assert!(harness
        .platform
        .values
        .lock()
        .unwrap()
        .keys()
        .any(|(_, key)| key.contains("account-1")));

    let restarted = Runtime::restart_test_teardown_environment(
        harness.replica_port,
        harness.platform,
        harness.artifacts,
        harness.host,
    );
    restarted.open().await.unwrap();
    let retry = restarted
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: account,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        retry,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
}

#[tokio::test]
async fn wrong_scope_host_cleanup_response_is_incomplete_and_retryable() {
    let harness = teardown_harness(Fault::WrongHostResponse);
    let account = AccountId::from("account-1");
    let first = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        first,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Account {
                account_id: account.clone(),
            },
            status: TeardownStatus::Incomplete,
            failures: vec![TeardownPhase::HostCleanup],
        }
    );
    let retry = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: account,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        retry,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
}

#[tokio::test]
async fn wipe_converges_after_an_incomplete_account_removal() {
    let harness = teardown_harness(Fault::PlatformAndReplica);
    let account = AccountId::from("account-1");
    let first = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        first,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Account {
                account_id: account.clone(),
            },
            status: TeardownStatus::Incomplete,
            failures: vec![TeardownPhase::PlatformStorage, TeardownPhase::Replica],
        }
    );

    // Whole-Device destruction is the sweep for the residue an incomplete removal leaves behind.
    // A narrower pending scope must never refuse it.
    let wipe = harness
        .runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        wipe,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Device,
            status: TeardownStatus::Complete,
            failures: vec![],
        }
    );
    assert!(harness.persistence.snapshot(&account).is_none());
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-2"))
        .is_none());
    assert!(harness.platform.values.lock().unwrap().is_empty());
    assert!(
        harness
            .runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                Arc::new(RecordingSink),
            )
            .is_ok(),
        "a converged Device wipe lifts its own fence",
    );
    // The removed Account is now absent rather than fenced, so its earlier scope is gone too.
    let Err(removed) = harness.runtime.observe(
        ObservationRequest::RuntimeStatus {
            account_id: Some(account),
        },
        Arc::new(RecordingSink),
    ) else {
        panic!("a wiped Account cannot be observed");
    };
    assert_eq!(removed.code, RuntimeErrorCode::AccountMissing);
    assert_eq!(removed.message, "account is not installed");
}

#[tokio::test]
async fn an_unrelated_account_removal_is_not_refused_while_another_removal_is_pending() {
    let harness = teardown_harness(Fault::PlatformAndReplica);
    let pending = AccountId::from("account-1");
    let unrelated = AccountId::from("account-2");
    let first = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: pending.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        first,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Account {
                account_id: pending.clone(),
            },
            status: TeardownStatus::Incomplete,
            failures: vec![TeardownPhase::PlatformStorage, TeardownPhase::Replica],
        }
    );

    let second = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: unrelated.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        second,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Account {
                account_id: unrelated.clone(),
            },
            status: TeardownStatus::Complete,
            failures: vec![],
        }
    );
    assert!(harness.persistence.snapshot(&unrelated).is_none());

    // The unrelated removal must not lift the first Account's fence.
    let fenced = harness
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: pending.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(fenced.code, RuntimeErrorCode::AccountMissing);
    assert_eq!(fenced.message, "Account teardown is pending");

    let retry = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: pending.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        retry,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
    assert!(harness.persistence.snapshot(&pending).is_none());
}

#[tokio::test]
async fn pending_device_wipe_rejects_every_request_including_sign_in() {
    // A Device-scope platform failure forbids the Replica phase, so one injected fault is enough.
    let harness = teardown_harness(Fault::Platform);
    let first = harness
        .runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        first,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Device,
            status: TeardownStatus::Incomplete,
            failures: vec![TeardownPhase::PlatformStorage, TeardownPhase::Replica],
        }
    );

    let invocations = harness.platform.invocations.load(Ordering::SeqCst);
    let sign_in = harness
        .runtime
        .request(
            RuntimeRequest::SignIn {
                server_url: "https://vault.example.com".into(),
                email: "person@example.test".into(),
                master_password: "must-not-be-used".into(),
                secret_key: "must-not-be-used".into(),
                insecure_transport_confirmed: false,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(sign_in.code, RuntimeErrorCode::AccountMissing);
    assert_eq!(sign_in.message, "Account teardown is pending");
    let named = harness
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: AccountId::from("account-2"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(named.code, RuntimeErrorCode::AccountMissing);
    assert_eq!(named.message, "Account teardown is pending");
    assert_eq!(
        harness.platform.invocations.load(Ordering::SeqCst),
        invocations,
        "a Device-wide pending wipe admits no request",
    );

    let retry = harness
        .runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();
    assert!(matches!(
        retry,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
}

/// The Device a user clears IndexedDB on while `localStorage` keeps the catalog. The catalog names
/// an Account with no durable Replica, so `open()` can never converge on this Device again. A
/// `Wipe` is the only way out, and it must reach every namespace-wide authority.
#[tokio::test]
async fn a_wedged_device_is_still_wipeable_after_open_fails() {
    let harness = wedged_teardown_harness(Fault::None);
    let catalog = DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
        account_id: AccountId::from("account-3"),
        active_incarnation: Some(crate::protocol::Incarnation::from("incarnation-3")),
        pending_install: None,
    }])
    .unwrap();
    harness.platform.values.lock().unwrap().insert(
        (
            "devicePlain".into(),
            "bittery:runtime:platform-storage:device-catalog".into(),
        ),
        serde_json::to_string(&catalog).unwrap(),
    );
    let wedged = harness.runtime.open().await.unwrap_err();
    assert_eq!(wedged.code, RuntimeErrorCode::InvariantViolation);

    let response = harness
        .runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();

    assert_eq!(
        response,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Device,
            status: TeardownStatus::Complete,
            failures: vec![]
        }
    );
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-1"))
        .is_none());
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-2"))
        .is_none());
    assert!(harness.platform.values.lock().unwrap().is_empty());
    assert_eq!(
        *harness.host.scopes.lock().unwrap(),
        [TeardownHostCleanupRequest::WipeDevice]
    );
    assert_eq!(
        *harness.events.lock().unwrap(),
        ["artifact", "host", "platform", "platform", "platform", "replica"]
    );
}

/// Relaxing `Wipe` must not relax Account removal. An Account scope reads the Device catalog and
/// detaches one entry from it, so it still needs the Runtime to have opened.
#[tokio::test]
async fn account_removal_still_requires_an_open_runtime() {
    let harness = wedged_teardown_harness(Fault::None);
    let error = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: AccountId::from("account-1"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        error.message,
        "Runtime must finish opening before it accepts work"
    );
    assert!(harness.events.lock().unwrap().is_empty());
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-1"))
        .is_some());
}

/// A wedged Device reports a failed phase honestly instead of claiming success, and an identical
/// retry on the same wedged Runtime converges.
#[tokio::test]
async fn a_wedged_wipe_reports_incomplete_and_converges_on_an_identical_retry() {
    let harness = wedged_teardown_harness(Fault::Platform);
    let first = harness
        .runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        first,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Device,
            status: TeardownStatus::Incomplete,
            failures: vec![TeardownPhase::PlatformStorage, TeardownPhase::Replica]
        }
    );
    assert!(!serde_json::to_string(&first).unwrap().contains("SECRET_"));
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-1"))
        .is_some());

    let retry = harness
        .runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        retry,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Device,
            status: TeardownStatus::Complete,
            failures: vec![]
        }
    );
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-1"))
        .is_none());
    assert!(harness.platform.values.lock().unwrap().is_empty());
}

/// A failed namespace wipe from a Runtime that never opened must not strand restart. The Device
/// catalog and its Replica still agree, so a fresh Runtime opens and the retry converges.
#[tokio::test]
async fn a_failed_wedged_wipe_leaves_a_fresh_runtime_able_to_open_and_retry() {
    let harness = wedged_teardown_harness(Fault::Platform);
    seed_restartable_catalog(&harness);
    let platform = Arc::clone(&harness.platform);

    let first = harness
        .runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        first,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Device,
            status: TeardownStatus::Incomplete,
            failures: vec![TeardownPhase::PlatformStorage, TeardownPhase::Replica]
        }
    );
    assert!(harness
        .platform
        .values
        .lock()
        .unwrap()
        .keys()
        .any(|(_, key)| key.ends_with("device-catalog")));
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-1"))
        .is_some());

    let restarted = Runtime::restart_test_teardown_environment(
        harness.replica_port,
        harness.platform,
        harness.artifacts,
        harness.host,
    );
    restarted.open().await.unwrap();
    let retry = restarted
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        retry,
        RuntimeResponse::Teardown {
            scope: TeardownScope::Device,
            status: TeardownStatus::Complete,
            failures: vec![]
        }
    );
    assert!(platform.values.lock().unwrap().is_empty());
    assert!(harness
        .persistence
        .snapshot(&AccountId::from("account-1"))
        .is_none());
}
