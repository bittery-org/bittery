#![cfg(not(target_arch = "wasm32"))]
use async_trait::async_trait;
use bittery_client_core::{
    AuthClientConfig, ClientPlatform, LegacyProfileFormat, ObservationRequest, ObservationSink,
    PlatformStorageRequest, PlatformStorageResponse, ProfileAdmissionSource, RequestCancellation,
    Runtime, RuntimeError, RuntimeProjection, RuntimeRequest, RuntimeResponse,
    SerializedHttpExecutor, SerializedPlatformStorageExecutor, SerializedProfileAdmissionExecutor,
    SqliteReplica, TeardownPhase, TeardownScope, TeardownStatus,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use zeroize::Zeroizing;
const CATALOG: &str = "bittery:runtime:platform-storage:device-catalog";
#[derive(Default)]
struct Sink(Mutex<Vec<RuntimeProjection>>);
impl ObservationSink for Sink {
    fn publish(&self, projection: RuntimeProjection) {
        self.0.lock().unwrap().push(projection);
    }
}

fn complete() -> Value {
    json!({"kind":"import", "version":1, "admissionId":"admission-1", "revision":"7", "phase":"complete", "source":{"format":"desktopLegacyV1", "profileIdentity":"profile-1", "recordedCaptureId":"capture-1"}, "manifestDigest":"ab".repeat(32), "completionId":"completion-1"})
}
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bittery-admission-catalog-{}",
            bittery_crypto_core::generate_uuid()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[derive(Default)]
struct Ports {
    values: Mutex<HashMap<String, String>>,
    mutations: Mutex<Vec<PlatformStorageRequest>>,
}
impl Ports {
    fn seed(raw: String) -> Arc<Self> {
        let ports = Arc::new(Self::default());
        ports.values.lock().unwrap().insert(CATALOG.into(), raw);
        ports
    }
    fn catalog(&self) -> Value {
        serde_json::from_str(self.values.lock().unwrap().get(CATALOG).unwrap()).unwrap()
    }
}
#[async_trait]
impl SerializedPlatformStorageExecutor for Ports {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let request: PlatformStorageRequest = serde_json::from_str(&input).unwrap();
        let response = match &request {
            PlatformStorageRequest::Get { key, .. } => PlatformStorageResponse::Value {
                value: self
                    .values
                    .lock()
                    .unwrap()
                    .get(key)
                    .cloned()
                    .map(Into::into),
            },
            PlatformStorageRequest::Set { key, value, .. } => {
                self.values
                    .lock()
                    .unwrap()
                    .insert(key.clone(), value.to_string());
                self.mutations.lock().unwrap().push(request);
                PlatformStorageResponse::Done
            }
            PlatformStorageRequest::Delete { key, .. } => {
                self.values.lock().unwrap().remove(key);
                self.mutations.lock().unwrap().push(request);
                PlatformStorageResponse::Done
            }
            PlatformStorageRequest::DeletePrefix { prefix, .. } => {
                self.values
                    .lock()
                    .unwrap()
                    .retain(|key, _| !key.starts_with(prefix));
                self.mutations.lock().unwrap().push(request);
                PlatformStorageResponse::Done
            }
            _ => panic!("completed admission must not census destination storage"),
        };
        Ok(Zeroizing::new(serde_json::to_string(&response).unwrap()))
    }
}
#[async_trait]
impl SerializedHttpExecutor for Ports {
    async fn invoke(&self, _: Zeroizing<String>) -> Result<String, RuntimeError> {
        panic!("catalog restoration must not use HTTP")
    }
    fn cancel(&self, _: &str) {}
}
#[async_trait]
impl SerializedProfileAdmissionExecutor for Ports {
    async fn invoke(
        &self,
        request: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let request: bittery_client_core::ProfileAdmissionRequest =
            serde_json::from_str(&request).unwrap();
        let response = match request {
            bittery_client_core::ProfileAdmissionRequest::PrepareLegacyProfileReset { .. } => {
                bittery_client_core::ProfileAdmissionResponse::ProfileResetPrepared {
                    result: bittery_client_core::ProfileResetPreparedResult::Unavailable {},
                }
            }
            bittery_client_core::ProfileAdmissionRequest::CloseSourceSnapshot { .. } => {
                bittery_client_core::ProfileAdmissionResponse::SourceSnapshotClosed {}
            }
            _ => panic!("completed admission must not read or reimport legacy source"),
        };
        Ok((
            Zeroizing::new(serde_json::to_string(&response).unwrap()),
            None,
        ))
    }
}
async fn make_runtime(directory: &Directory, ports: Arc<Ports>) -> Arc<Runtime> {
    make_runtime_with_source(
        directory,
        ports.clone(),
        ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: ports,
        },
    )
    .await
}

async fn make_runtime_with_source(
    directory: &Directory,
    ports: Arc<Ports>,
    source: ProfileAdmissionSource,
) -> Arc<Runtime> {
    let runtime = Runtime::with_configured_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite3")).unwrap()),
        ports.clone(),
        ports.clone(),
        AuthClientConfig::new(
            "catalog-test".into(),
            ClientPlatform::Desktop,
            "0.5.2".into(),
        )
        .unwrap(),
    );
    runtime.set_profile_admission_source(source).await.unwrap();
    runtime
}

#[tokio::test]
async fn unavailable_applicable_source_never_means_empty_profile_but_retains_completed_ownership() {
    for completed in [false, true] {
        let directory = Directory::new();
        let ports = if completed {
            Ports::seed(
                json!({"version":1,"accounts":[],"profileAdmission":complete()}).to_string(),
            )
        } else {
            Arc::new(Ports::default())
        };
        let runtime = make_runtime_with_source(
            &directory,
            ports.clone(),
            ProfileAdmissionSource::LegacyUnavailable {
                format: LegacyProfileFormat::DesktopLegacyV1,
            },
        )
        .await;
        let result = runtime.open().await;
        if completed {
            result.unwrap();
        } else {
            assert_eq!(
                result.unwrap_err().code,
                bittery_client_core::RuntimeErrorCode::StorageUnavailable
            );
        }
        assert!(ports.mutations.lock().unwrap().is_empty());
        let response = runtime
            .request(RuntimeRequest::Wipe, RequestCancellation::new())
            .await
            .unwrap();
        assert!(matches!(
            response,
            RuntimeResponse::Teardown {
                status: TeardownStatus::Incomplete,
                ..
            }
        ));
        assert!(ports.mutations.lock().unwrap().is_empty());
        runtime.close().await;
    }
}
#[tokio::test]
async fn completed_empty_catalog_opens_and_reopens_without_source_or_writes() {
    let directory = Directory::new();
    let expected = json!({"version":1,"accounts":[],"profileAdmission":complete()});
    let ports = Ports::seed(expected.to_string());
    for _ in 0..2 {
        let runtime = make_runtime(&directory, ports.clone()).await;
        runtime.open().await.unwrap();
        runtime.open().await.unwrap();
        let sink = Arc::new(Sink::default());
        let observation = runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                sink.clone(),
            )
            .unwrap();
        assert!(
            matches!(sink.0.lock().unwrap().last(), Some(RuntimeProjection::RuntimeStatus(status)) if status.accounts.is_empty() && !status.closed)
        );
        observation.close();
        runtime.close().await;
    }
    assert_eq!(ports.catalog(), expected);
    assert!(ports.mutations.lock().unwrap().is_empty());
}
#[tokio::test]
async fn unsupported_or_malformed_admission_refuses_before_any_source_or_write() {
    let mut cases = Vec::new();
    for (field, value) in [
        ("version", json!(2)),
        ("phase", json!("preparing")),
        ("phase", json!("futurePhase")),
        ("kind", json!("reset")),
        ("revision", json!(7)),
        ("revision", json!("07")),
        ("manifestDigest", json!("AB".repeat(32))),
        ("completionId", json!("")),
        ("extra", json!(true)),
        (
            "source",
            json!(["desktopLegacyV1", "profile-1", "capture-1"]),
        ),
    ] {
        let mut record = complete();
        record[field] = value;
        cases.push(json!({"version":1,"accounts":[],"profileAdmission":record}).to_string());
    }
    cases.push(format!(
        r#"{{"version":1,"accounts":[],"profileAdmission":{}}}"#,
        complete()
            .to_string()
            .replacen("\"version\":1", "\"version\":1,\"version\":1", 1)
    ));
    cases.push(json!({"version":1,"accounts":[],"profileAdmission":null}).to_string());
    cases.push(json!({"version":1,"accounts":[],"profileAdmission":["import",1,"id","7","complete",{},"ab".repeat(32),"completion"]}).to_string());
    cases.push(json!([1, [], complete()]).to_string());
    for raw in cases {
        let directory = Directory::new();
        let ports = Ports::seed(raw);
        let runtime = make_runtime(&directory, ports.clone()).await;
        assert!(runtime.open().await.is_err());
        assert!(ports.mutations.lock().unwrap().is_empty());
        runtime.close().await;
    }
}
#[tokio::test]
async fn failed_pending_install_reconciliation_keeps_completed_marker_after_last_account() {
    let directory = Directory::new();
    let marker = complete();
    let ports = Ports::seed(json!({"version":1,"profileAdmission":marker,"accounts":[{"accountId":"new-account", "activeIncarnation":null, "pendingInstall":{"incarnation":"never-installed", "expectedActiveIncarnation":null}}]}).to_string());
    let runtime = make_runtime(&directory, ports.clone()).await;
    runtime.open().await.unwrap();
    assert_eq!(
        ports.catalog(),
        json!({"version":1,"accounts":[],"profileAdmission":complete()})
    );
    runtime.close().await;
    let reopened = make_runtime(&directory, ports.clone()).await;
    reopened.open().await.unwrap();
    reopened.close().await;
}
#[tokio::test]
async fn legacy_wipe_before_open_and_after_complete_preserves_catalog_without_side_effects() {
    for open_first in [false, true] {
        let directory = Directory::new();
        let expected = json!({"version":1,"accounts":[],"profileAdmission":complete()});
        let ports = Ports::seed(expected.to_string());
        let runtime = make_runtime(&directory, ports.clone()).await;
        if open_first {
            runtime.open().await.unwrap();
        }
        let response = runtime
            .request(RuntimeRequest::Wipe, RequestCancellation::new())
            .await
            .unwrap();
        assert!(
            matches!(response, RuntimeResponse::Teardown { scope:TeardownScope::Device, status:TeardownStatus::Incomplete, failures } if failures == vec![TeardownPhase::PlatformStorage])
        );
        assert_eq!(ports.catalog(), expected);
        assert!(ports.mutations.lock().unwrap().is_empty());
        runtime.close().await;
    }
}

#[tokio::test]
async fn ordinary_unconfigured_catalog_keeps_its_wire_shape_and_default_wipe_behavior() {
    let directory = Directory::new();
    let expected = json!({"version":1,"accounts":[]});
    let ports = Ports::seed(expected.to_string());
    let runtime = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite3")).unwrap()),
        ports.clone(),
        ports.clone(),
    );
    runtime.open().await.unwrap();
    assert_eq!(ports.catalog(), expected);
    assert!(ports.mutations.lock().unwrap().is_empty());
    let response = runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();
    // Unavailable host/artifact adapters keep their established cleanup failures; the Core
    // storage phases still run, unlike the Legacy guard above.
    assert!(
        matches!(response, RuntimeResponse::Teardown { failures, .. } if !failures.contains(&TeardownPhase::PlatformStorage))
    );
    assert!(ports.values.lock().unwrap().is_empty());
    assert!(!ports.mutations.lock().unwrap().is_empty());
    runtime.close().await;
}

#[tokio::test]
async fn completed_marker_requires_reset_even_without_configured_legacy_provider() {
    let directory = Directory::new();
    let expected = json!({"version":1,"accounts":[],"profileAdmission":complete()});
    let ports = Ports::seed(expected.to_string());
    let runtime = Runtime::with_configured_serialized_executors(
        Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite3")).unwrap()),
        ports.clone(),
        ports.clone(),
        AuthClientConfig::new(
            "catalog-test".into(),
            ClientPlatform::Desktop,
            "0.5.2".into(),
        )
        .unwrap(),
    );
    runtime.open().await.unwrap();
    let result = runtime
        .request(RuntimeRequest::Wipe, RequestCancellation::new())
        .await
        .unwrap();
    assert!(matches!(
        result,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    assert_eq!(ports.catalog(), expected);
    assert!(ports.mutations.lock().unwrap().is_empty());
    runtime.close().await;
}

#[path = "profile_admission_catalog/reset.rs"]
mod reset;
