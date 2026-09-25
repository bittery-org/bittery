#![cfg(not(target_arch = "wasm32"))]

use async_trait::async_trait;
use bittery_client_core::{
    AuthClientConfig, ClientPlatform, LegacyProfileFormat, ObservationRequest, ObservationSink,
    PlatformStorageRequest, PlatformStorageResponse, ProfileAdmissionRequest,
    ProfileAdmissionResponse, ProfileAdmissionSource, ProfileSnapshotCloseSelector,
    ProfileSourceFamily, ProfileSourceFamilyInventory, ProfileSourcePresence,
    ProfileSourceSnapshot, Runtime, RuntimeError, RuntimeErrorCode, RuntimeProjection,
    SerializedHttpExecutor, SerializedPlatformStorageExecutor, SerializedProfileAdmissionExecutor,
    SerializedReplicaExecutor, SqliteReplica,
};
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs::File,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use zeroize::Zeroizing;

type SourceReply = Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError>;

struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bittery-profile-lifetime-{}",
            bittery_crypto_core::generate_uuid()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn unavailable() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: "Fixture primitive is unavailable".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

struct RecordedReplica {
    inner: SqliteReplica,
    exchanges: Mutex<Vec<(Value, Value)>>,
}
#[async_trait]
impl SerializedReplicaExecutor for RecordedReplica {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let recorded = serde_json::from_str(&request).unwrap();
        let response = self.inner.invoke(request).await?;
        self.exchanges
            .lock()
            .unwrap()
            .push((recorded, serde_json::from_str(&response).unwrap()));
        Ok(response)
    }
}

#[derive(Default)]
struct EmptyPlatform(Mutex<Vec<Value>>);
#[async_trait]
impl SerializedPlatformStorageExecutor for EmptyPlatform {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        self.0
            .lock()
            .unwrap()
            .push(serde_json::from_str(&request).unwrap());
        match serde_json::from_str::<PlatformStorageRequest>(&request).unwrap() {
            PlatformStorageRequest::Get { .. } => Ok(Zeroizing::new(
                serde_json::to_string(&PlatformStorageResponse::Value { value: None }).unwrap(),
            )),
            _ => Err(unavailable()),
        }
    }
}

#[derive(Default)]
struct NoHttp(AtomicUsize);
#[async_trait]
impl SerializedHttpExecutor for NoHttp {
    async fn invoke(&self, _: Zeroizing<String>) -> Result<String, RuntimeError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(unavailable())
    }
    fn cancel(&self, _: &str) {}
}

struct ReaderState {
    reader: Option<File>,
    lose_begin_response: bool,
    close_failures: usize,
    close_binary_responses: VecDeque<Zeroizing<Vec<u8>>>,
    calls: Vec<&'static str>,
    close_selectors: Vec<ProfileSnapshotCloseSelector>,
}

/// One primitive-owned reader survives a failed Close; repeated Begin reuses that same reader.
/// This exercises Core's public lifetime contract, not a native/Web adapter's release guarantee.
struct DesktopSource {
    path: PathBuf,
    state: Mutex<ReaderState>,
}
impl DesktopSource {
    fn invoke_sync(&self, request: Zeroizing<String>) -> SourceReply {
        let mut state = self.state.lock().unwrap();
        let response = match serde_json::from_str::<ProfileAdmissionRequest>(&request).unwrap() {
            ProfileAdmissionRequest::PrepareLegacyProfileReset { .. }
            | ProfileAdmissionRequest::ResetLegacySourceFamily { .. } => {
                panic!("Initial admission must not implicitly reset the source")
            }
            ProfileAdmissionRequest::BeginSourceSnapshot { format } => {
                assert_eq!(format, LegacyProfileFormat::DesktopLegacyV1);
                state.calls.push("begin");
                if state.reader.is_none() {
                    state.reader = Some(File::open(&self.path).unwrap());
                }
                let response = ProfileAdmissionResponse::SourceSnapshot {
                    snapshot: ProfileSourceSnapshot {
                        format,
                        snapshot_handle: "retained-source-reader".into(),
                        profile_identity: "isolated-profile".into(),
                        capture_id: "original-capture".into(),
                        families: [
                            (
                                ProfileSourceFamily::DesktopStore,
                                ProfileSourcePresence::Present,
                            ),
                            (
                                ProfileSourceFamily::DesktopSyncStore,
                                ProfileSourcePresence::Missing,
                            ),
                            (
                                ProfileSourceFamily::DesktopCredentials,
                                ProfileSourcePresence::Missing,
                            ),
                        ]
                        .into_iter()
                        .map(|(family, presence)| ProfileSourceFamilyInventory {
                            family,
                            presence,
                            file_identity: (family == ProfileSourceFamily::DesktopStore)
                                .then(|| "lifetime-store-file".into()),
                        })
                        .collect(),
                        session_instance: None,
                    },
                };
                if std::mem::take(&mut state.lose_begin_response) {
                    return Err(unavailable());
                }
                response
            }
            ProfileAdmissionRequest::ReadSourcePage { .. } => {
                panic!("Destination collision must refuse before reading source pages")
            }
            ProfileAdmissionRequest::CloseSourceSnapshot { selector } => {
                if let ProfileSnapshotCloseSelector::Exact { handle } = &selector {
                    assert_eq!(handle, "retained-source-reader");
                }
                state.calls.push("close");
                state.close_selectors.push(selector);
                if state.close_failures > 0 {
                    state.close_failures -= 1;
                    return Err(unavailable());
                }
                if let Some(binary) = state.close_binary_responses.pop_front() {
                    // A malformed acknowledgement does not prove that this reader was released.
                    return Ok((
                        Zeroizing::new(
                            serde_json::to_string(
                                &ProfileAdmissionResponse::SourceSnapshotClosed {},
                            )
                            .unwrap(),
                        ),
                        Some(binary),
                    ));
                }
                state.reader.take();
                ProfileAdmissionResponse::SourceSnapshotClosed {}
            }
            ProfileAdmissionRequest::ReopenSourceSnapshot { .. }
            | ProfileAdmissionRequest::ReopenSourceForCleanup { .. }
            | ProfileAdmissionRequest::DeleteCapturedSource { .. }
            | ProfileAdmissionRequest::VerifySourceSnapshot { .. } => {
                panic!("Initial lifetime tests cannot verify or reopen a snapshot")
            }
        };
        Ok((
            Zeroizing::new(serde_json::to_string(&response).unwrap()),
            None,
        ))
    }
}

#[async_trait]
impl SerializedProfileAdmissionExecutor for DesktopSource {
    async fn invoke(
        &self,
        request: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        self.invoke_sync(request)
    }
}

#[derive(Default)]
struct BeginPhase {
    released: bool,
    finished: bool,
}

#[derive(Default)]
struct BeginGate {
    phase: Mutex<BeginPhase>,
    release: Condvar,
    started: tokio::sync::Notify,
    finished: tokio::sync::Notify,
    close_entered: tokio::sync::Notify,
}

impl BeginGate {
    fn release(&self) {
        self.phase
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .released = true;
        self.release.notify_all();
    }
}

struct ReleaseBeginOnDrop(Arc<BeginGate>);
impl Drop for ReleaseBeginOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

/// The native blocking invocation outlives its awaiting Rust future. Close drains that invocation
/// before dropping the actual reader; this is a primitive fixture, not production adapter coverage.
struct BlockingDesktopSource {
    inner: Arc<DesktopSource>,
    gate: Arc<BeginGate>,
}

#[async_trait]
impl SerializedProfileAdmissionExecutor for BlockingDesktopSource {
    async fn invoke(
        &self,
        request: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        match serde_json::from_str::<ProfileAdmissionRequest>(&request).unwrap() {
            ProfileAdmissionRequest::PrepareLegacyProfileReset { .. }
            | ProfileAdmissionRequest::ResetLegacySourceFamily { .. } => {
                panic!("Interrupted admission must not implicitly reset the source")
            }
            ProfileAdmissionRequest::BeginSourceSnapshot { .. } => {
                let inner = self.inner.clone();
                let gate = self.gate.clone();
                // Dropping this JoinHandle detaches the already-running blocking invocation.
                tokio::task::spawn_blocking(move || {
                    let response = inner.invoke_sync(request);
                    gate.started.notify_one();
                    let mut phase = gate.phase.lock().unwrap();
                    while !phase.released {
                        phase = gate.release.wait(phase).unwrap();
                    }
                    phase.finished = true;
                    drop(phase);
                    gate.finished.notify_one();
                    response
                })
                .await
                .map_err(|_| unavailable())?
            }
            ProfileAdmissionRequest::ReadSourcePage { .. } => {
                panic!("Interrupted capture cannot read source pages")
            }
            ProfileAdmissionRequest::CloseSourceSnapshot { selector } => {
                assert_eq!(selector, ProfileSnapshotCloseSelector::CurrentCapability {});
                self.gate.close_entered.notify_one();
                loop {
                    let finished = self.gate.finished.notified();
                    if self.gate.phase.lock().unwrap().finished {
                        break;
                    }
                    finished.await;
                }
                self.inner.invoke_sync(request)
            }
            ProfileAdmissionRequest::ReopenSourceSnapshot { .. }
            | ProfileAdmissionRequest::ReopenSourceForCleanup { .. }
            | ProfileAdmissionRequest::DeleteCapturedSource { .. }
            | ProfileAdmissionRequest::VerifySourceSnapshot { .. } => {
                panic!("Interrupted capture cannot verify or reopen a snapshot")
            }
        }
    }
}

#[derive(Default)]
struct Sink(AtomicUsize);
impl ObservationSink for Sink {
    fn publish(&self, _: RuntimeProjection) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn orphan_replica(path: &Path) -> Arc<RecordedReplica> {
    let replica = Arc::new(RecordedReplica {
        inner: SqliteReplica::open(path).unwrap(),
        exchanges: Mutex::new(Vec::new()),
    });
    {
        let raw = rusqlite::Connection::open(path).unwrap();
        raw.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        raw.execute(
            "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES (?1, 9, ?2, ?3)",
            ["orphan-account", "retained-capability", "original-opaque-evidence"],
        )
        .unwrap();
    }
    replica
}

async fn configured_runtime(
    replica: Arc<RecordedReplica>,
    platform: Arc<EmptyPlatform>,
    http: Arc<NoHttp>,
    source: Arc<dyn SerializedProfileAdmissionExecutor>,
) -> Arc<Runtime> {
    let runtime = Runtime::with_configured_serialized_executors(
        replica,
        platform,
        http,
        AuthClientConfig::new(
            "profile-lifetime".into(),
            ClientPlatform::Desktop,
            "0.5.2".into(),
        )
        .unwrap(),
    );
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: source,
        })
        .await
        .unwrap();
    runtime
}

#[tokio::test]
async fn failed_source_close_is_retained_across_open_retry_until_runtime_close_releases_reader() {
    let directory = TestDirectory::new();
    let path = directory.0.join("replica.sqlite");
    let replica = orphan_replica(&path);
    let replica_before = std::fs::read(&path).unwrap();
    let source_path = directory.0.join("store.json");
    std::fs::write(&source_path, b"{}\n").unwrap();
    let source = Arc::new(DesktopSource {
        path: source_path.clone(),
        state: Mutex::new(ReaderState {
            reader: None,
            lose_begin_response: false,
            close_failures: 2,
            close_binary_responses: VecDeque::new(),
            calls: Vec::new(),
            close_selectors: Vec::new(),
        }),
    });
    let platform = Arc::new(EmptyPlatform::default());
    let http = Arc::new(NoHttp::default());
    let runtime = configured_runtime(
        replica.clone(),
        platform.clone(),
        http.clone(),
        source.clone(),
    )
    .await;
    let sink = Arc::new(Sink::default());

    let mut open_errors = Vec::new();
    for _ in 0..2 {
        open_errors.push(
            tokio::time::timeout(Duration::from_secs(2), runtime.open())
                .await
                .expect("open must report its failure")
                .expect_err("unexplained destination records must prevent opening"),
        );
        assert!(source.state.lock().unwrap().reader.is_some());
        assert!(runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                sink.clone()
            )
            .is_err());
    }
    assert_eq!(open_errors[0].code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        open_errors[0].message,
        "Profile admission found unexplained destination Replica records"
    );
    tokio::time::timeout(Duration::from_secs(2), runtime.close())
        .await
        .expect("shutdown must retry the retained reader cleanup");

    assert!(
        source.state.lock().unwrap().reader.is_none(),
        "Runtime.close must release the reader retained after failed source cleanup"
    );
    assert_eq!(
        source.state.lock().unwrap().calls,
        ["begin", "close", "close", "close"]
    );
    assert_eq!(open_errors[1].code, RuntimeErrorCode::StorageUnavailable);
    assert_eq!(sink.0.load(Ordering::SeqCst), 0);
    assert_eq!(http.0.load(Ordering::SeqCst), 0);
    assert!(platform
        .0
        .lock()
        .unwrap()
        .iter()
        .all(|request| request["type"] == "get"));
    let exchanges = replica.exchanges.lock().unwrap();
    assert!(exchanges
        .iter()
        .all(|(request, _)| request["type"] == "inventory"));
    assert!(
        exchanges.iter().any(|(_, response)| {
            response["entries"].as_array().is_some_and(|entries| {
                entries.iter().any(|entry| {
                    entry["accountId"] == "orphan-account"
                        && entry["recordId"] == "retained-capability"
                })
            })
        }),
        "the first refusal must observe the real orphan"
    );
    assert_eq!(std::fs::read(&source_path).unwrap(), b"{}\n");
    assert!(
        std::fs::read(&path).unwrap() == replica_before,
        "reader cleanup must preserve all destination bytes"
    );
}

#[tokio::test]
async fn binary_source_close_acknowledgements_keep_cleanup_until_a_valid_reply_releases_reader() {
    let directory = TestDirectory::new();
    let path = directory.0.join("replica.sqlite");
    let replica = orphan_replica(&path);
    let replica_before = std::fs::read(&path).unwrap();
    let source_path = directory.0.join("store.json");
    std::fs::write(&source_path, b"{}\n").unwrap();
    let source = Arc::new(DesktopSource {
        path: source_path.clone(),
        state: Mutex::new(ReaderState {
            reader: None,
            lose_begin_response: false,
            close_failures: 0,
            close_binary_responses: VecDeque::from([
                Zeroizing::new(Vec::new()),
                Zeroizing::new(vec![71; 32]),
            ]),
            calls: Vec::new(),
            close_selectors: Vec::new(),
        }),
    });
    let platform = Arc::new(EmptyPlatform::default());
    let http = Arc::new(NoHttp::default());
    let runtime = configured_runtime(
        replica.clone(),
        platform.clone(),
        http.clone(),
        source.clone(),
    )
    .await;
    let sink = Arc::new(Sink::default());
    let mut open_errors = Vec::new();
    for _ in 0..2 {
        open_errors.push(
            tokio::time::timeout(Duration::from_secs(2), runtime.open())
                .await
                .expect("open must report the orphan or malformed cleanup reply")
                .expect_err("source cleanup cannot authorize an unexplained destination"),
        );
        assert!(source.state.lock().unwrap().reader.is_some());
        assert!(runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                sink.clone()
            )
            .is_err());
    }
    assert_eq!(open_errors[0].code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        open_errors[0].message,
        "Profile admission found unexplained destination Replica records"
    );
    tokio::time::timeout(Duration::from_secs(2), runtime.close())
        .await
        .expect("shutdown must obtain a valid no-binary cleanup acknowledgement");

    let state = source.state.lock().unwrap();
    assert!(
        state.reader.is_none(),
        "unexpected binary, including Some(empty), must not clear the reader cleanup duty"
    );
    assert_eq!(state.calls, ["begin", "close", "close", "close"]);
    assert!(state.close_binary_responses.is_empty());
    assert_eq!(
        state.close_selectors,
        vec![
            ProfileSnapshotCloseSelector::Exact {
                handle: "retained-source-reader".into()
            };
            3
        ]
    );
    drop(state);
    assert_eq!(sink.0.load(Ordering::SeqCst), 0);
    assert_eq!(http.0.load(Ordering::SeqCst), 0);
    assert!(platform
        .0
        .lock()
        .unwrap()
        .iter()
        .all(|request| request["type"] == "get"));
    let exchanges = replica.exchanges.lock().unwrap();
    assert_eq!(
        exchanges.len(),
        1,
        "cleanup retry must not repeat inventory"
    );
    assert_eq!(exchanges[0].0["type"], "inventory");
    assert!(exchanges[0].1["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["accountId"] == "orphan-account"
            && entry["recordId"] == "retained-capability"));
    assert_eq!(std::fs::read(&source_path).unwrap(), b"{}\n");
    assert!(
        std::fs::read(&path).unwrap() == replica_before,
        "invalid cleanup replies must preserve all destination bytes"
    );
}

#[tokio::test]
async fn lost_begin_reply_retains_reader_cleanup_until_runtime_close_without_another_begin() {
    let directory = TestDirectory::new();
    let path = directory.0.join("replica.sqlite");
    let replica = orphan_replica(&path);
    let replica_before = std::fs::read(&path).unwrap();
    let source_path = directory.0.join("store.json");
    std::fs::write(&source_path, b"{}\n").unwrap();
    let source = Arc::new(DesktopSource {
        path: source_path.clone(),
        state: Mutex::new(ReaderState {
            reader: None,
            lose_begin_response: true,
            close_failures: 1,
            close_binary_responses: VecDeque::new(),
            calls: Vec::new(),
            close_selectors: Vec::new(),
        }),
    });
    let platform = Arc::new(EmptyPlatform::default());
    let http = Arc::new(NoHttp::default());
    let runtime = configured_runtime(
        replica.clone(),
        platform.clone(),
        http.clone(),
        source.clone(),
    )
    .await;
    let error = tokio::time::timeout(Duration::from_secs(2), runtime.open())
        .await
        .expect("open must report its lost Begin reply")
        .expect_err("the missing snapshot reply must prevent opening");
    assert_eq!(error.code, RuntimeErrorCode::StorageUnavailable);
    assert!(source.state.lock().unwrap().reader.is_some());
    let sink = Arc::new(Sink::default());
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone()
        )
        .is_err());

    tokio::time::timeout(Duration::from_secs(2), runtime.close())
        .await
        .expect("shutdown must retry cleanup after the lost Begin reply");

    assert!(
        source.state.lock().unwrap().reader.is_none(),
        "Runtime.close must release the reader created before the lost Begin reply"
    );
    assert_eq!(
        source.state.lock().unwrap().calls,
        ["begin", "close", "close"]
    );
    assert_eq!(
        source.state.lock().unwrap().close_selectors,
        [
            ProfileSnapshotCloseSelector::CurrentCapability {},
            ProfileSnapshotCloseSelector::CurrentCapability {},
        ]
    );
    assert_eq!(sink.0.load(Ordering::SeqCst), 0);
    assert_eq!(http.0.load(Ordering::SeqCst), 0);
    assert!(platform
        .0
        .lock()
        .unwrap()
        .iter()
        .all(|request| request["type"] == "get"));
    assert!(replica.exchanges.lock().unwrap().is_empty());
    assert_eq!(std::fs::read(&source_path).unwrap(), b"{}\n");
    assert!(
        std::fs::read(&path).unwrap() == replica_before,
        "lost-reply cleanup must preserve all destination bytes"
    );
}

#[tokio::test]
async fn dropped_open_keeps_blocking_begin_owned_until_runtime_close_drains_it() {
    let directory = TestDirectory::new();
    let path = directory.0.join("replica.sqlite");
    let replica = orphan_replica(&path);
    let replica_before = std::fs::read(&path).unwrap();
    let source_path = directory.0.join("store.json");
    std::fs::write(&source_path, b"{}\n").unwrap();
    let reader = Arc::new(DesktopSource {
        path: source_path.clone(),
        state: Mutex::new(ReaderState {
            reader: None,
            lose_begin_response: false,
            close_failures: 0,
            close_binary_responses: VecDeque::new(),
            calls: Vec::new(),
            close_selectors: Vec::new(),
        }),
    });
    let gate = Arc::new(BeginGate::default());
    let _release_on_failure = ReleaseBeginOnDrop(gate.clone());
    let source = Arc::new(BlockingDesktopSource {
        inner: reader.clone(),
        gate: gate.clone(),
    });
    let platform = Arc::new(EmptyPlatform::default());
    let http = Arc::new(NoHttp::default());
    let runtime = configured_runtime(replica.clone(), platform.clone(), http.clone(), source).await;

    let open = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.open().await }
    });
    tokio::time::timeout(Duration::from_secs(2), gate.started.notified())
        .await
        .expect("the actual blocking Begin must start");
    assert!(reader.state.lock().unwrap().reader.is_some());
    open.abort();
    assert!(open.await.unwrap_err().is_cancelled());
    let sink = Arc::new(Sink::default());
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone()
        )
        .is_err());

    let mut close = tokio::spawn({
        let runtime = runtime.clone();
        async move { runtime.close().await }
    });
    tokio::time::timeout(Duration::from_secs(2), gate.close_entered.notified())
        .await
        .expect("close must reach CurrentCapability cleanup after open is dropped");
    // The cleanup-entry barrier proves that close has run; this is not a scheduling delay probe.
    let close_waited = !close.is_finished();
    let begin_still_running = !gate.phase.lock().unwrap().finished;
    let reader_still_open = reader.state.lock().unwrap().reader.is_some();
    gate.release();
    tokio::time::timeout(Duration::from_secs(2), &mut close)
        .await
        .expect("close must complete after the blocking Begin is released")
        .unwrap();

    assert!(close_waited, "Runtime.close must drain the issued Begin");
    assert!(begin_still_running);
    assert!(reader_still_open);
    assert!(gate.phase.lock().unwrap().finished);
    assert!(reader.state.lock().unwrap().reader.is_none());
    assert_eq!(reader.state.lock().unwrap().calls, ["begin", "close"]);
    assert_eq!(
        reader.state.lock().unwrap().close_selectors,
        [ProfileSnapshotCloseSelector::CurrentCapability {}]
    );
    assert_eq!(sink.0.load(Ordering::SeqCst), 0);
    assert_eq!(http.0.load(Ordering::SeqCst), 0);
    assert!(platform
        .0
        .lock()
        .unwrap()
        .iter()
        .all(|request| request["type"] == "get"));
    assert!(replica.exchanges.lock().unwrap().is_empty());
    assert_eq!(std::fs::read(&source_path).unwrap(), b"{}\n");
    assert!(
        std::fs::read(&path).unwrap() == replica_before,
        "dropped-open cleanup must preserve all destination bytes"
    );
}
