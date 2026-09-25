use super::*;
use crate::{
    ArtifactChunkWrite, AttachmentMoveDownload, AttachmentMoveDownloadRequest,
    AttachmentMovePreparationFacade, AttachmentMoveTransferError, AttachmentMoveTransferPort,
    AttachmentMoveUpload, AttachmentMoveUploadGrant, AuthClientConfig, ClientPlatform,
    LegacyProfileFormat, ProfileAdmissionRequest, ProfileAdmissionSource,
    ProfileSnapshotCloseSelector, SerializedProfileAdmissionExecutor,
};
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bittery-profile-admission-{}",
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

struct RecordedReplica {
    inner: crate::replica::SqliteReplica,
    exchanges: Mutex<Vec<(Value, Value)>>,
}

#[async_trait]
impl SerializedReplicaExecutor for RecordedReplica {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request = serde_json::from_str(&request_json).unwrap();
        let response = SerializedReplicaExecutor::invoke(&self.inner, request_json).await?;
        self.exchanges
            .lock()
            .unwrap()
            .push((request, serde_json::from_str(&response).unwrap()));
        Ok(response)
    }
}

#[derive(Default)]
struct RecordedPlatform {
    inner: MemoryPlatformExecutor,
    requests: Mutex<Vec<Value>>,
    exchanges: Mutex<Vec<(Value, Value)>>,
}

#[async_trait]
impl SerializedPlatformStorageExecutor for RecordedPlatform {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let request: Value = serde_json::from_str(&request_json).unwrap();
        self.requests.lock().unwrap().push(request.clone());
        let response = self.inner.invoke(request_json).await?;
        self.exchanges
            .lock()
            .unwrap()
            .push((request, serde_json::from_str(&response).unwrap()));
        Ok(response)
    }
}

/// A valid exclusive primitive fixture for an applicable but empty legacy source.
/// The unexplained destination must still be preserved, even when all old families are absent.
struct EmptyDesktopSource;

#[async_trait]
impl SerializedProfileAdmissionExecutor for EmptyDesktopSource {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let response = match serde_json::from_str::<ProfileAdmissionRequest>(&request_json).unwrap()
        {
            ProfileAdmissionRequest::BeginSourceSnapshot { format } => {
                assert_eq!(format, LegacyProfileFormat::DesktopLegacyV1);
                json!({
                    "type": "sourceSnapshot",
                    "snapshot": {
                        "format": "desktopLegacyV1",
                        "snapshotHandle": "live-desktop-snapshot",
                        "profileIdentity": "isolated-desktop-profile",
                        "captureId": "first-source-capture",
                        "families": [
                            {"family": "desktopStore", "presence": "missing"},
                            {"family": "desktopSyncStore", "presence": "missing"},
                            {"family": "desktopCredentials", "presence": "missing"}
                        ]
                    }
                })
            }
            ProfileAdmissionRequest::ReadSourcePage { .. } => {
                panic!("Destination collision must refuse before reading source pages")
            }
            ProfileAdmissionRequest::CloseSourceSnapshot { selector } => {
                assert_eq!(
                    selector,
                    ProfileSnapshotCloseSelector::Exact {
                        handle: "live-desktop-snapshot".into()
                    }
                );
                json!({"type": "sourceSnapshotClosed"})
            }
            ProfileAdmissionRequest::ReopenSourceSnapshot { .. }
            | ProfileAdmissionRequest::VerifySourceSnapshot { .. }
            | ProfileAdmissionRequest::ReopenSourceForCleanup { .. }
            | ProfileAdmissionRequest::DeleteCapturedSource { .. }
            | ProfileAdmissionRequest::PrepareLegacyProfileReset { .. }
            | ProfileAdmissionRequest::ResetLegacySourceFamily { .. } => {
                panic!("Initial collision tests cannot verify or reopen a snapshot")
            }
        };
        Ok((Zeroizing::new(response.to_string()), None))
    }
}

#[tokio::test]
async fn applicable_admission_preserves_headless_replica_instead_of_publishing_empty_profile() {
    let directory = TestDirectory::new();
    let path = directory.0.join("replica.sqlite");
    let replica = Arc::new(RecordedReplica {
        inner: crate::replica::SqliteReplica::open(&path).unwrap(),
        exchanges: Mutex::new(Vec::new()),
    });
    // Inject physical orphan evidence that no catalog or known-Account enumeration can discover.
    let raw = rusqlite::Connection::open(&path).unwrap();
    raw.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    raw.execute(
        "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES (?1, 9, ?2, ?3)",
        ["unknown-account", "retained-capability", "original-opaque-evidence"],
    )
    .unwrap();
    drop(raw);

    let platform = Arc::new(RecordedPlatform::default());
    let runtime = Runtime::with_configured_serialized_executors(
        replica.clone(),
        platform.clone(),
        Arc::new(UnusedHttpExecutor),
        AuthClientConfig::new(
            "admission-test".into(),
            ClientPlatform::Desktop,
            "0.5.2".into(),
        )
        .unwrap(),
    );
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: Arc::new(EmptyDesktopSource),
        })
        .await
        .unwrap();

    let error = runtime.open().await.expect_err(
        "an absent catalog cannot authorize an empty profile over unexplained Replica evidence",
    );
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        error.message,
        "Profile admission found unexplained destination Replica records"
    );
    let sink = Arc::new(Sink::default());
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone()
        )
        .is_err());
    assert!(sink.0.lock().unwrap().is_empty());
    assert_eq!(
        runtime
            .request(
                RuntimeRequest::LocalSecuritySettings {
                    account_id: account("unknown-account")
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::InvariantViolation
    );

    let exchanges = replica.exchanges.lock().unwrap().clone();
    assert!(exchanges
        .iter()
        .all(|(request, _)| request["type"] == "inventory"));
    assert!(
        exchanges
            .iter()
            .any(
                |(_, response)| response["entries"].as_array().is_some_and(|entries| entries
                    .iter()
                    .any(|entry| entry
                        == &json!({
                            "type": "row", "accountId": "unknown-account",
                            "store": "shareCapabilities", "recordId": "retained-capability"
                        })))
            ),
        "the refusal must observe the real orphan, not an unrelated unavailable port"
    );
    assert!(platform
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|request| request["type"] == "get"));
    for (area, key) in [
        ("devicePlain", catalog_key()),
        (
            "deviceSecret",
            "bittery:runtime:platform-storage:device-key".into(),
        ),
    ] {
        let response = platform
            .invoke(Zeroizing::new(
                json!({"type":"get", "area":area, "key":key}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap(),
            json!({"type":"value", "value":null})
        );
    }
    let preserved = replica
        .invoke(r#"{"type":"load","accountId":"unknown-account"}"#.into())
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&preserved).unwrap(),
        json!({
            "type":"loaded", "head":null,
            "rows":[{"store":"shareCapabilities", "key":{"accountId":"unknown-account", "recordId":"retained-capability"}, "payloadJson":"original-opaque-evidence"}]
        })
    );
    runtime.close().await;
}

#[tokio::test]
async fn applicable_admission_preserves_unexplained_platform_key_with_empty_replica() {
    let directory = TestDirectory::new();
    let replica = Arc::new(RecordedReplica {
        inner: crate::replica::SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap(),
        exchanges: Mutex::new(Vec::new()),
    });
    let platform = Arc::new(RecordedPlatform::default());
    let orphan_key = "bittery:runtime:platform-storage:orphan";
    let orphan_value = "original-opaque-platform-evidence";
    let seeded = platform
        .invoke(Zeroizing::new(
            json!({
                "type": "set", "area": "devicePlain", "key": orphan_key, "value": orphan_value
            })
            .to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&seeded).unwrap(),
        json!({"type": "done"})
    );
    platform.requests.lock().unwrap().clear();
    platform.exchanges.lock().unwrap().clear();

    let runtime = Runtime::with_configured_serialized_executors(
        replica.clone(),
        platform.clone(),
        Arc::new(UnusedHttpExecutor),
        AuthClientConfig::new(
            "admission-test".into(),
            ClientPlatform::Desktop,
            "0.5.2".into(),
        )
        .unwrap(),
    );
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: Arc::new(EmptyDesktopSource),
        })
        .await
        .unwrap();

    let error = runtime
        .open()
        .await
        .expect_err("unexplained platform evidence must block admission");
    assert_eq!(
        error.message,
        "Profile admission found unexplained destination platform records"
    );
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    let sink = Arc::new(Sink::default());
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone()
        )
        .is_err());
    assert!(sink.0.lock().unwrap().is_empty());
    assert_eq!(
        runtime
            .request(
                RuntimeRequest::LocalSecuritySettings {
                    account_id: account("unknown-account")
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::InvariantViolation
    );

    let replica_exchanges = replica.exchanges.lock().unwrap().clone();
    assert!(!replica_exchanges.is_empty());
    assert!(replica_exchanges.iter().all(|(request, response)| {
        request == &json!({"type": "inventory", "cursor": null})
            && response
                == &json!({
                    "type": "inventoryPage", "version": 1, "family": "replica",
                    "entries": [], "continuation": {"type": "end"}
                })
    }));
    let exchanges = platform.exchanges.lock().unwrap().clone();
    assert!(
        exchanges.iter().any(|(request, response)| {
            request
                == &json!({
                    "type": "listKeys", "area": "devicePlain",
                    "prefix": "bittery:runtime:platform-storage:", "cursor": null
                })
                && response
                    == &json!({
                        "type": "keysPage", "version": 1, "family": "platformStorage",
                        "backingAreas": ["devicePlain"], "keys": [orphan_key],
                        "continuation": {"type": "end"}
                    })
        }),
        "refusal must discover the exact physical orphan key through ListKeys"
    );
    assert!(platform
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|request| { matches!(request["type"].as_str(), Some("get" | "listKeys")) }));
    for (area, key, expected) in [
        ("devicePlain", orphan_key.to_owned(), json!(orphan_value)),
        ("devicePlain", catalog_key(), Value::Null),
        (
            "deviceSecret",
            "bittery:runtime:platform-storage:device-key".into(),
            Value::Null,
        ),
    ] {
        let response = platform
            .invoke(Zeroizing::new(
                json!({
                    "type": "get", "area": area, "key": key
                })
                .to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap(),
            json!({"type": "value", "value": expected})
        );
    }
    runtime.close().await;
}

#[derive(Default)]
struct RecordedEmptyDesktopSource {
    completed: Mutex<Vec<ProfileAdmissionRequest>>,
}

#[async_trait]
impl SerializedProfileAdmissionExecutor for RecordedEmptyDesktopSource {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let request = serde_json::from_str(&request_json).unwrap();
        let response = EmptyDesktopSource.invoke(request_json).await?;
        self.completed.lock().unwrap().push(request);
        Ok(response)
    }
}

#[derive(Default)]
struct AdmissionNoNetwork(AtomicUsize);

#[async_trait]
impl SerializedHttpExecutor for AdmissionNoNetwork {
    async fn invoke(&self, _: Zeroizing<String>) -> Result<String, RuntimeError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(startup_invariant("Admission must not issue HTTP"))
    }

    fn cancel(&self, _: &str) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl AttachmentMoveTransferPort for AdmissionNoNetwork {
    async fn open_source(
        &self,
        _: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, AttachmentMoveTransferError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(AttachmentMoveTransferError::Invariant)
    }

    async fn open_upload(
        &self,
        _: &AccountId,
        _: &str,
        _: &AttachmentMoveUploadGrant,
        _: &crate::AttachmentArtifactOwner,
    ) -> Result<Box<dyn AttachmentMoveUpload>, AttachmentMoveTransferError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(AttachmentMoveTransferError::Invariant)
    }
}

fn physical_database_bytes(path: &Path) -> (Vec<u8>, Option<Vec<u8>>) {
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let wal = match std::fs::read(PathBuf::from(wal)) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => panic!("could not capture optional database WAL: {error}"),
    };
    (std::fs::read(path).unwrap(), wal)
}

#[tokio::test]
async fn applicable_admission_preserves_unsealed_artifact_despite_recovery_unavailable() {
    use crate::{
        ProvisionalAttachmentArtifactScope, ProvisionalAttachmentArtifactStore,
        ProvisionalAttachmentArtifactStoreRequest as ProvisionalRequest,
        ProvisionalAttachmentArtifactStoreResponse as ProvisionalResponse,
        ProvisionalAttachmentArtifactWriter, SqliteAttachmentArtifactStore,
    };

    let directory = TestDirectory::new();
    let replica_path = directory.0.join("replica.sqlite");
    let artifact_path = directory.0.join("artifacts.sqlite");
    let replica = Arc::new(RecordedReplica {
        inner: crate::replica::SqliteReplica::open(&replica_path).unwrap(),
        exchanges: Mutex::new(Vec::new()),
    });
    let scope = ProvisionalAttachmentArtifactScope::new(
        account("unexplained-artifact-account"),
        "unexplained-operation",
        "unexplained-attachment",
    )
    .unwrap();
    let bytes = vec![0x31; 32];
    let seeded = SqliteAttachmentArtifactStore::open(&artifact_path).unwrap();
    // This is a real partial preparation, with no publication proof or fabricated metadata.
    let ProvisionalResponse::Begun(writer) = seeded
        .invoke_provisional(ProvisionalRequest::Begin {
            writer: ProvisionalAttachmentArtifactWriter::new(scope.clone()),
        })
        .await
        .unwrap()
    else {
        panic!("empty artifact database must begin an unsealed generation");
    };
    assert_eq!(
        seeded
            .invoke_provisional(ProvisionalRequest::WriteChunk {
                writer: writer.clone(),
                chunk_index: 0,
                bytes: bytes.clone(),
            })
            .await
            .unwrap(),
        ProvisionalResponse::ChunkWritten(ArtifactChunkWrite::Stored)
    );
    drop(seeded);
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_path).unwrap());
    assert_eq!(
        artifacts
            .invoke_provisional(ProvisionalRequest::Recover {
                scope: scope.clone()
            })
            .await
            .unwrap(),
        ProvisionalResponse::RecoveryUnavailable
    );
    let before_artifacts = physical_database_bytes(&artifact_path);
    let before_replica = physical_database_bytes(&replica_path);
    let platform = Arc::new(RecordedPlatform::default());
    let network = Arc::new(AdmissionNoNetwork::default());
    let source = Arc::new(RecordedEmptyDesktopSource::default());
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        replica.clone(),
        platform.clone(),
        network.clone(),
        AuthClientConfig::new(
            "admission-test".into(),
            ClientPlatform::Desktop,
            "0.5.2".into(),
        )
        .unwrap(),
        AttachmentMovePreparationFacade::new(artifacts.clone(), artifacts.clone(), network.clone()),
        Arc::new(crate::runtime::attachment_move_lifecycle::TestAccountLeasePort),
    );
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: source.clone(),
        })
        .await
        .unwrap();

    let opened = runtime.open().await;
    let source_after_open = source.completed.lock().unwrap().clone();
    let replica_exchanges = replica.exchanges.lock().unwrap().clone();
    let platform_exchanges = platform.exchanges.lock().unwrap().clone();
    let artifacts_unchanged = physical_database_bytes(&artifact_path) == before_artifacts;
    let replica_unchanged = physical_database_bytes(&replica_path) == before_replica;
    let sink = Arc::new(Sink::default());
    let observation = runtime.observe(
        ObservationRequest::RuntimeStatus { account_id: None },
        sink.clone(),
    );
    let command = runtime
        .request(
            RuntimeRequest::LocalSecuritySettings {
                account_id: account("unexplained-artifact-account"),
            },
            RequestCancellation::new(),
        )
        .await;
    // A public idempotent write proves that the same generation and exact bytes still exist.
    // It runs only after the unchanged physical snapshot above has been captured.
    let duplicate = artifacts
        .invoke_provisional(ProvisionalRequest::WriteChunk {
            writer,
            chunk_index: 0,
            bytes,
        })
        .await;
    let recovered = artifacts
        .invoke_provisional(ProvisionalRequest::Recover { scope })
        .await;
    runtime.close().await;

    assert!(
        artifacts_unchanged && replica_unchanged,
        "admission must preserve both databases and their optional WALs"
    );
    assert_eq!(
        duplicate.unwrap(),
        ProvisionalResponse::ChunkWritten(ArtifactChunkWrite::AlreadyStored)
    );
    assert_eq!(recovered.unwrap(), ProvisionalResponse::RecoveryUnavailable);
    assert!(physical_database_bytes(&artifact_path) == before_artifacts);
    assert_eq!(
        source_after_open,
        vec![
            ProfileAdmissionRequest::BeginSourceSnapshot {
                format: LegacyProfileFormat::DesktopLegacyV1
            },
            ProfileAdmissionRequest::CloseSourceSnapshot {
                selector: ProfileSnapshotCloseSelector::Exact {
                    handle: "live-desktop-snapshot".into(),
                }
            },
        ]
    );
    assert_eq!(*source.completed.lock().unwrap(), source_after_open);
    assert!(observation.is_err());
    assert!(sink.0.lock().unwrap().is_empty());
    assert_eq!(
        command.unwrap_err().code,
        RuntimeErrorCode::InvariantViolation
    );
    assert_eq!(network.0.load(Ordering::SeqCst), 0);
    assert!(!replica_exchanges.is_empty());
    assert!(replica_exchanges.iter().all(|(request, response)| {
        request == &json!({"type":"inventory", "cursor":null})
            && response
                == &json!({
                    "type":"inventoryPage", "version":1, "family":"replica",
                    "entries":[], "continuation":{"type":"end"}
                })
    }));
    assert!(platform_exchanges
        .iter()
        .all(|(request, _)| matches!(request["type"].as_str(), Some("get" | "listKeys"))));
    for area in ["devicePlain", "deviceSecret", "sessionSecret"] {
        assert!(
            platform_exchanges.iter().any(|(request, response)| {
                request
                    == &json!({"type":"listKeys", "area":area,
                "prefix":"bittery:runtime:platform-storage:", "cursor":null})
                    && response
                        == &json!({
                            "type":"keysPage", "version":1, "family":"platformStorage",
                            "backingAreas":[area], "keys":[], "continuation":{"type":"end"}
                        })
            }),
            "the refusal must follow a complete empty platform census for {area}"
        );
    }
    assert!(platform.inner.values.lock().unwrap().is_empty());
    let error = opened.expect_err("an unsealed artifact must block empty profile admission");
    assert_eq!(
        error.message,
        "Profile admission found unexplained destination Attachment artifacts"
    );
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
}

#[path = "profile_admission_vault_image_tests.rs"]
mod vault_image_tests;
