use super::*;
use crate::{
    platform_storage::{
        AccountMetadataDocument, DeviceKeyDocument, PendingAccountInstallIntent,
        QuickUnlockDocument,
    },
    protocol::Incarnation,
    replica::{
        InMemoryReplica, ReplicaPersistence, ReplicaPersistenceRequest, SerializedReplicaExecutor,
    },
    vault_image::{
        MemoryVaultImageArtifactStore, VaultImageArtifactMetadata, VaultImageArtifactPort,
        VaultImageArtifactScope, VaultImageChunkWrite, VaultImageIngressFacade,
        VaultImagePublication, VaultImageSource, VaultImageSourceError, VaultImageSourceGrant,
        VaultImageSourcePort,
    },
    ObservationSink, RequestCancellation, RuntimeRequest,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::AtomicUsize;
use std::{future::Future, task::Wake, thread};

struct ThreadWake(thread::Thread);

impl Wake for ThreadWake {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<F: Future>(future: F) -> F::Output {
    let waker = Arc::new(ThreadWake(thread::current())).into();
    let mut context = std::task::Context::from_waker(&waker);
    let mut future = Box::pin(future);
    loop {
        match future.as_mut().poll(&mut context) {
            std::task::Poll::Ready(value) => return value,
            std::task::Poll::Pending => thread::park(),
        }
    }
}

struct MemoryReplicaExecutor {
    state: InMemoryReplica,
    loads: AtomicUsize,
}

struct UnusedHttpExecutor;

#[async_trait]
impl SerializedHttpExecutor for UnusedHttpExecutor {
    async fn invoke(&self, _request_json: String) -> Result<String, RuntimeError> {
        panic!("startup tests must not invoke HTTP")
    }

    fn cancel(&self, _dispatch_id: &str) {
        panic!("startup tests must not cancel HTTP")
    }
}

impl Default for MemoryReplicaExecutor {
    fn default() -> Self {
        Self {
            state: InMemoryReplica::default(),
            loads: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl SerializedReplicaExecutor for MemoryReplicaExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
        if matches!(request, ReplicaPersistenceRequest::Load { .. }) {
            self.loads.fetch_add(1, Ordering::SeqCst);
        }
        serde_json::to_string(&self.state.invoke(request).await?)
            .map_err(|_| startup_invariant("test Replica response could not serialize"))
    }
}

#[derive(Default)]
struct MemoryPlatformExecutor {
    values: Mutex<HashMap<(String, String), String>>,
    deletes: Mutex<Vec<String>>,
    fail_next_set: AtomicBool,
}

#[derive(Default)]
struct PausingPlatformExecutor {
    inner: MemoryPlatformExecutor,
    reached: (Mutex<bool>, Condvar),
    released: (Mutex<bool>, Condvar),
}

impl PausingPlatformExecutor {
    fn wait_until_reached(&self) {
        let mut reached = self.reached.0.lock().unwrap();
        while !*reached {
            reached = self.reached.1.wait(reached).unwrap();
        }
    }

    fn release(&self) {
        *self.released.0.lock().unwrap() = true;
        self.released.1.notify_all();
    }
}

impl MemoryPlatformExecutor {
    fn put<T: serde::Serialize>(&self, area: &str, key: String, value: &T) {
        self.values
            .lock()
            .unwrap()
            .insert((area.into(), key), serde_json::to_string(value).unwrap());
    }

    fn catalog(&self) -> Option<DeviceCatalogDocument> {
        self.values
            .lock()
            .unwrap()
            .get(&("devicePlain".into(), catalog_key()))
            .map(|value| serde_json::from_str(value).unwrap())
    }
}

#[async_trait]
impl SerializedPlatformStorageExecutor for MemoryPlatformExecutor {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<zeroize::Zeroizing<String>, RuntimeError> {
        let request: Value = serde_json::from_str(&request_json).unwrap();
        let area = request["area"].as_str().unwrap().to_owned();
        let key = request["key"].as_str().unwrap().to_owned();
        match request["type"].as_str().unwrap() {
            "get" => Ok(zeroize::Zeroizing::new(
                json!({
                    "type": "value",
                    "value": self.values.lock().unwrap().get(&(area, key)).cloned()
                })
                .to_string(),
            )),
            "set" => {
                if self.fail_next_set.swap(false, Ordering::SeqCst) {
                    return Err(startup_invariant("injected catalog write failure"));
                }
                self.values
                    .lock()
                    .unwrap()
                    .insert((area, key), request["value"].as_str().unwrap().to_owned());
                Ok(zeroize::Zeroizing::new(json!({"type": "done"}).to_string()))
            }
            "delete" => {
                self.values.lock().unwrap().remove(&(area, key.clone()));
                self.deletes.lock().unwrap().push(key);
                Ok(zeroize::Zeroizing::new(json!({"type": "done"}).to_string()))
            }
            _ => unreachable!(),
        }
    }
}

#[async_trait]
impl SerializedPlatformStorageExecutor for PausingPlatformExecutor {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<zeroize::Zeroizing<String>, RuntimeError> {
        if serde_json::from_str::<Value>(&request_json).unwrap()["type"] == "get" {
            *self.reached.0.lock().unwrap() = true;
            self.reached.1.notify_all();
            let mut released = self.released.0.lock().unwrap();
            while !*released {
                released = self.released.1.wait(released).unwrap();
            }
        }
        self.inner.invoke(request_json).await
    }
}

#[derive(Default)]
struct Sink(Mutex<Vec<RuntimeProjection>>);

impl ObservationSink for Sink {
    fn publish(&self, projection: RuntimeProjection) {
        self.0.lock().unwrap().push(projection);
    }
}

fn catalog_key() -> String {
    "bittery:runtime:platform-storage:device-catalog".into()
}

fn generation_key(account: &str, incarnation: &str, document: &str) -> String {
    format!(
            "bittery:runtime:platform-storage:account:{}:{account}:incarnation:{}:{incarnation}:{document}",
            account.len(),
            incarnation.len()
        )
}

fn account(value: &str) -> AccountId {
    AccountId::from(value)
}

fn incarnation(value: &str) -> Incarnation {
    Incarnation::from(value)
}

fn metadata(account_id: &str, generation: &str, user_id: &str) -> AccountMetadataDocument {
    AccountMetadataDocument::new(
        account(account_id),
        incarnation(generation),
        user_id.into(),
        "user@example.com".into(),
        "User".into(),
        "https://vault.example.com".into(),
        None,
        None,
        "A3-TEST".into(),
        1,
        2,
        false,
        false,
        bittery_crypto_core::KdfProfile {
            schema_version: 1,
            algorithm: "pbkdf2-sha256".into(),
            iterations: 600_000,
        },
        None,
    )
    .unwrap()
}

fn seed_catalog(platform: &MemoryPlatformExecutor, accounts: Vec<DeviceCatalogAccount>) {
    platform.put(
        "devicePlain",
        catalog_key(),
        &DeviceCatalogDocument::new(accounts).unwrap(),
    );
}

fn seed_metadata(
    platform: &MemoryPlatformExecutor,
    account_id: &str,
    generation: &str,
    user_id: &str,
) {
    platform.put(
        "devicePlain",
        generation_key(account_id, generation, "metadata"),
        &metadata(account_id, generation, user_id),
    );
}

/// Seeds what a password-only unlock needs: the Device key that wraps the stored master
/// unlock key, and the Account's Quick Unlock document.
fn seed_quick_unlock_material(
    platform: &MemoryPlatformExecutor,
    account_id: &str,
    generation: &str,
) {
    platform.put(
        "deviceSecret",
        "bittery:runtime:platform-storage:device-key".into(),
        &DeviceKeyDocument::new([7u8; 32]),
    );
    platform.put(
        "deviceSecret",
        generation_key(account_id, generation, "quick-unlock"),
        &QuickUnlockDocument::new(
            account(account_id),
            incarnation(generation),
            bittery_crypto_core::EncryptedData {
                ciphertext: "Y2lwaGVy".into(),
                iv: "aXZpdml2aXZpdml2".into(),
                algorithm: "AES-GCM-AAD-V1".into(),
            },
            "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2".into(),
            1,
            None,
            false,
        )
        .unwrap(),
    );
}

fn production_runtime(
    replica: Arc<MemoryReplicaExecutor>,
    platform: Arc<MemoryPlatformExecutor>,
) -> Arc<Runtime> {
    Runtime::with_serialized_executors(replica, platform, Arc::new(UnusedHttpExecutor))
}

struct UnusedVaultImageSource;

#[async_trait]
impl VaultImageSourcePort for UnusedVaultImageSource {
    async fn claim(
        &self,
        _grant: &VaultImageSourceGrant,
    ) -> Result<Box<dyn VaultImageSource>, VaultImageSourceError> {
        panic!("startup sweep must not claim a source")
    }
    async fn retire_account(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn complete_account_retirement(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
    async fn begin_acceptance(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _operation_id: &str,
    ) -> Result<(), VaultImageSourceError> {
        panic!("startup sweep must not accept work")
    }
    async fn end_acceptance(
        &self,
        _runtime_incarnation: &str,
        _account_id: &AccountId,
        _operation_id: &str,
    ) -> Result<(), VaultImageSourceError> {
        panic!("startup sweep must not release work")
    }
    async fn retire_runtime(
        &self,
        _runtime_incarnation: &str,
    ) -> Result<(), VaultImageSourceError> {
        Ok(())
    }
}

#[derive(Clone)]
struct FailFirstSweep {
    inner: MemoryVaultImageArtifactStore,
    fail: Arc<AtomicBool>,
}

#[async_trait]
impl VaultImageArtifactPort for FailFirstSweep {
    async fn begin(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError> {
        self.inner.begin(scope).await
    }
    async fn write_chunk(
        &self,
        scope: &VaultImageArtifactScope,
        index: u32,
        bytes: &[u8],
    ) -> Result<VaultImageChunkWrite, RuntimeError> {
        self.inner.write_chunk(scope, index, bytes).await
    }
    async fn publish(
        &self,
        metadata: &VaultImageArtifactMetadata,
    ) -> Result<VaultImagePublication, RuntimeError> {
        self.inner.publish(metadata).await
    }
    async fn read_chunk(
        &self,
        metadata: &VaultImageArtifactMetadata,
        index: u32,
    ) -> Result<Option<Vec<u8>>, RuntimeError> {
        self.inner.read_chunk(metadata, index).await
    }
    async fn delete(&self, scope: &VaultImageArtifactScope) -> Result<(), RuntimeError> {
        self.inner.delete(scope).await
    }
    async fn delete_account(&self, account_id: &AccountId) -> Result<(), RuntimeError> {
        self.inner.delete_account(account_id).await
    }
    async fn wipe(&self) -> Result<(), RuntimeError> {
        self.inner.wipe().await
    }
    async fn sweep_orphans(
        &self,
        account_id: &AccountId,
        referenced_operations: &HashSet<String>,
    ) -> Result<(), RuntimeError> {
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(startup_invariant("injected Vault image sweep failure"));
        }
        self.inner
            .sweep_orphans(account_id, referenced_operations)
            .await
    }
}

fn active(account_id: &str, generation: &str) -> DeviceCatalogAccount {
    DeviceCatalogAccount {
        account_id: account(account_id),
        active_incarnation: Some(incarnation(generation)),
        pending_install: None,
    }
}

fn pending(account_id: &str, active: Option<&str>, pending: &str) -> DeviceCatalogAccount {
    DeviceCatalogAccount {
        account_id: account(account_id),
        active_incarnation: active.map(incarnation),
        pending_install: Some(PendingAccountInstallIntent {
            incarnation: incarnation(pending),
            expected_active_incarnation: active.map(incarnation),
        }),
    }
}

#[tokio::test]
async fn production_runtime_is_cold_and_missing_catalog_opens_without_scanning_replica() {
    let replica = Arc::new(MemoryReplicaExecutor::default());
    let platform = Arc::new(MemoryPlatformExecutor::default());
    let runtime = production_runtime(replica.clone(), platform);
    let error = runtime
        .request(
            RuntimeRequest::SignIn {
                email: "user@example.com".into(),
                master_password: "password".into(),
                secret_key: "A3-TEST".into(),
                server_url: "https://vault.example.com".into(),
                insecure_transport_confirmed: false,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            Arc::new(Sink::default()),
        )
        .is_err());

    runtime.open().await.unwrap();
    runtime.open().await.unwrap();
    assert_eq!(replica.loads.load(Ordering::SeqCst), 0);
    assert!(runtime.replica.snapshots().is_empty());
}

#[tokio::test]
async fn open_restores_final_active_accounts_signed_out_once() {
    let replica = Arc::new(MemoryReplicaExecutor::default());
    replica
        .state
        .install(
            account("account-1"),
            "user-1".into(),
            incarnation("generation-1"),
        )
        .unwrap();
    let platform = Arc::new(MemoryPlatformExecutor::default());
    seed_catalog(&platform, vec![active("account-1", "generation-1")]);
    seed_metadata(&platform, "account-1", "generation-1", "user-1");
    let runtime = production_runtime(replica.clone(), platform);

    runtime.open().await.unwrap();
    runtime.open().await.unwrap();

    assert_eq!(replica.loads.load(Ordering::SeqCst), 1);
    assert_eq!(runtime.device_revision.load(Ordering::SeqCst), 1);
    assert_eq!(
        runtime.account_access_state(&account("account-1")),
        Some(AccountAccessState::SignedOut)
    );
    assert_eq!(runtime.lock_epoch(&account("account-1")), Some(0));
    let projected = runtime
        .projection(&ObservationRequest::RuntimeStatus { account_id: None })
        .unwrap();
    let RuntimeProjection::RuntimeStatus(status) = projected.projection else {
        panic!("expected Runtime status projection");
    };
    assert_eq!(
        status.accounts[0]
            .display_identity
            .as_ref()
            .map(|identity| identity.email.as_str()),
        Some("user@example.com")
    );
}

#[tokio::test]
async fn open_exclusively_sweeps_vault_images_before_publishing_account_work_and_retries_failure() {
    let replica = Arc::new(MemoryReplicaExecutor::default());
    replica
        .state
        .install(
            account("account-sweep"),
            "user-sweep".into(),
            incarnation("generation-sweep"),
        )
        .unwrap();
    let platform = Arc::new(MemoryPlatformExecutor::default());
    seed_catalog(&platform, vec![active("account-sweep", "generation-sweep")]);
    seed_metadata(&platform, "account-sweep", "generation-sweep", "user-sweep");
    let artifacts = MemoryVaultImageArtifactStore::default();
    let orphan = VaultImageArtifactScope::new(account("account-sweep"), "orphan").unwrap();
    artifacts.begin(&orphan).await.unwrap();
    artifacts.write_chunk(&orphan, 0, b"x").await.unwrap();
    let metadata = VaultImageArtifactMetadata::new(
        orphan,
        "vault-sweep",
        1,
        "image/png",
        "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    )
    .unwrap();
    artifacts.publish(&metadata).await.unwrap();
    let runtime = production_runtime(replica, platform);
    runtime.install_vault_image_ingress(
        VaultImageIngressFacade::new(
            "runtime-sweep",
            Arc::new(UnusedVaultImageSource),
            Arc::new(FailFirstSweep {
                inner: artifacts.clone(),
                fail: Arc::new(AtomicBool::new(true)),
            }),
        )
        .unwrap(),
    );

    assert!(runtime.open().await.is_err());
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            Arc::new(Sink::default()),
        )
        .is_err());
    runtime.open().await.unwrap();
    assert_eq!(artifacts.read_chunk(&metadata, 0).await.unwrap(), None);
    assert_eq!(
        runtime.account_access_state(&account("account-sweep")),
        Some(AccountAccessState::SignedOut)
    );
}

#[tokio::test]
async fn open_promotes_or_rolls_back_pending_install_from_the_replica_head() {
    for (head, expected_active, expected_orphan) in [("new", "new", "old"), ("old", "old", "new")] {
        let replica = Arc::new(MemoryReplicaExecutor::default());
        replica
            .state
            .install(account("account"), "user".into(), incarnation(head))
            .unwrap();
        let platform = Arc::new(MemoryPlatformExecutor::default());
        seed_catalog(&platform, vec![pending("account", Some("old"), "new")]);
        seed_metadata(&platform, "account", head, "user");
        let runtime = production_runtime(replica, platform.clone());

        runtime.open().await.unwrap();

        let catalog = platform.catalog().unwrap();
        assert_eq!(
            catalog.accounts[0].active_incarnation,
            Some(incarnation(expected_active))
        );
        assert!(catalog.accounts[0].pending_install.is_none());
        assert!(platform
            .deletes
            .lock()
            .unwrap()
            .iter()
            .any(|key| key.contains(expected_orphan)));
    }
}

#[tokio::test]
async fn open_removes_an_uncommitted_first_install() {
    let replica = Arc::new(MemoryReplicaExecutor::default());
    let platform = Arc::new(MemoryPlatformExecutor::default());
    seed_catalog(&platform, vec![pending("account", None, "new")]);
    let runtime = production_runtime(replica, platform.clone());

    runtime.open().await.unwrap();

    assert!(platform.catalog().unwrap().accounts.is_empty());
    assert!(runtime.replica.snapshots().is_empty());
}

#[tokio::test]
async fn open_fails_atomically_for_missing_third_or_metadata_mismatched_heads() {
    for scenario in ["missing", "third", "user"] {
        let replica = Arc::new(MemoryReplicaExecutor::default());
        if scenario != "missing" {
            let generation = if scenario == "third" { "third" } else { "old" };
            replica
                .state
                .install(account("account"), "user".into(), incarnation(generation))
                .unwrap();
        }
        let platform = Arc::new(MemoryPlatformExecutor::default());
        seed_catalog(&platform, vec![active("account", "old")]);
        if scenario == "user" {
            seed_metadata(&platform, "account", "old", "another-user");
        }
        let runtime = production_runtime(replica, platform);

        assert!(runtime.open().await.is_err(), "scenario {scenario}");
        assert!(runtime.replica.snapshots().is_empty());
        assert!(runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                Arc::new(Sink::default()),
            )
            .is_err());
    }
}

#[tokio::test]
async fn corrective_catalog_write_failure_exposes_nothing_and_open_retries() {
    let replica = Arc::new(MemoryReplicaExecutor::default());
    replica
        .state
        .install(account("account"), "user".into(), incarnation("old"))
        .unwrap();
    let platform = Arc::new(MemoryPlatformExecutor::default());
    seed_catalog(&platform, vec![pending("account", Some("old"), "new")]);
    seed_metadata(&platform, "account", "old", "user");
    platform.fail_next_set.store(true, Ordering::SeqCst);
    let runtime = production_runtime(replica, platform.clone());

    assert!(runtime.open().await.is_err());
    assert!(runtime.replica.snapshots().is_empty());
    assert!(platform.catalog().unwrap().accounts[0]
        .pending_install
        .is_some());
    runtime.open().await.unwrap();
    assert!(platform.catalog().unwrap().accounts[0]
        .pending_install
        .is_none());
    assert_eq!(runtime.replica.snapshots().len(), 1);
}

#[tokio::test]
async fn closed_cold_runtime_never_opens() {
    let runtime = production_runtime(
        Arc::new(MemoryReplicaExecutor::default()),
        Arc::new(MemoryPlatformExecutor::default()),
    );
    runtime.close().await;
    let error = runtime.open().await.unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
    assert!(runtime.replica.snapshots().is_empty());
}

#[test]
fn close_racing_open_prevents_startup_publication() {
    let platform = Arc::new(PausingPlatformExecutor::default());
    let runtime = Runtime::with_serialized_executors(
        Arc::new(MemoryReplicaExecutor::default()),
        platform.clone(),
        Arc::new(UnusedHttpExecutor),
    );
    let opening = {
        let runtime = runtime.clone();
        thread::spawn(move || block_on(runtime.open()))
    };
    platform.wait_until_reached();
    let closing = {
        let runtime = runtime.clone();
        thread::spawn(move || block_on(runtime.close()))
    };
    while !runtime.is_closed() {
        thread::yield_now();
    }
    platform.release();

    let error = opening.join().unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
    closing.join().unwrap();
    assert!(runtime.replica.snapshots().is_empty());
}

#[tokio::test]
async fn open_restores_an_account_with_intact_quick_unlock_material_as_locked() {
    let replica = Arc::new(MemoryReplicaExecutor::default());
    replica
        .state
        .install(
            account("account-1"),
            "user-1".into(),
            incarnation("generation-1"),
        )
        .unwrap();
    let platform = Arc::new(MemoryPlatformExecutor::default());
    seed_catalog(&platform, vec![active("account-1", "generation-1")]);
    seed_metadata(&platform, "account-1", "generation-1", "user-1");
    seed_quick_unlock_material(&platform, "account-1", "generation-1");
    let runtime = production_runtime(replica, platform);

    runtime.open().await.unwrap();

    // Locked, not SignedOut: the Device still holds everything a password-only unlock needs,
    // so the host must offer Quick Unlock rather than a full Sign-in.
    assert_eq!(
        runtime.account_access_state(&account("account-1")),
        Some(AccountAccessState::Locked)
    );
}

#[tokio::test]
async fn open_restores_an_account_without_the_device_key_as_signed_out() {
    let replica = Arc::new(MemoryReplicaExecutor::default());
    replica
        .state
        .install(
            account("account-1"),
            "user-1".into(),
            incarnation("generation-1"),
        )
        .unwrap();
    let platform = Arc::new(MemoryPlatformExecutor::default());
    seed_catalog(&platform, vec![active("account-1", "generation-1")]);
    seed_metadata(&platform, "account-1", "generation-1", "user-1");
    seed_quick_unlock_material(&platform, "account-1", "generation-1");
    platform
        .values
        .lock()
        .unwrap()
        .remove(&(
            "deviceSecret".into(),
            "bittery:runtime:platform-storage:device-key".into(),
        ))
        .unwrap();
    let runtime = production_runtime(replica, platform);

    runtime.open().await.unwrap();

    assert_eq!(
        runtime.account_access_state(&account("account-1")),
        Some(AccountAccessState::SignedOut)
    );
}

#[tokio::test]
async fn open_restores_an_account_whose_quick_unlock_material_is_unusable_as_signed_out() {
    let replica = Arc::new(MemoryReplicaExecutor::default());
    replica
        .state
        .install(
            account("account-1"),
            "user-1".into(),
            incarnation("generation-1"),
        )
        .unwrap();
    let platform = Arc::new(MemoryPlatformExecutor::default());
    seed_catalog(&platform, vec![active("account-1", "generation-1")]);
    seed_metadata(&platform, "account-1", "generation-1", "user-1");
    seed_quick_unlock_material(&platform, "account-1", "generation-1");
    platform.values.lock().unwrap().insert(
        (
            "deviceSecret".into(),
            generation_key("account-1", "generation-1", "quick-unlock"),
        ),
        "{\"version\":1}".into(),
    );
    let runtime = production_runtime(replica, platform);

    // Unusable material is not a startup failure: it is a Device that has to sign in again.
    runtime.open().await.unwrap();

    assert_eq!(
        runtime.account_access_state(&account("account-1")),
        Some(AccountAccessState::SignedOut)
    );
}
