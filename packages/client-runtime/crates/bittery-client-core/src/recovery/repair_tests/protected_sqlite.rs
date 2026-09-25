//! Real SQLite capture/immutable restore/repair; only the encrypted archive transport is in memory.
use super::*;
use crate::{
    SqliteAttachmentArtifactStore, SqliteRecoveryStorage, SqliteReplica,
    SqliteVaultImageArtifactStore,
};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

struct Databases(PathBuf);
impl Databases {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "bittery-protected-repair-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        SqliteReplica::open(path.join("replica.sqlite")).unwrap();
        SqliteAttachmentArtifactStore::open(path.join("attachments.sqlite")).unwrap();
        SqliteVaultImageArtifactStore::open(path.join("images.sqlite")).unwrap();
        Self(path)
    }
    fn open(&self) -> SqliteRecoveryStorage {
        open(&self.0)
    }
    fn connection(&self, name: &str) -> Connection {
        Connection::open(self.0.join(name)).unwrap()
    }
}
impl Drop for Databases {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn open(path: &Path) -> SqliteRecoveryStorage {
    SqliteRecoveryStorage::open(
        path.join("replica.sqlite"),
        path.join("attachments.sqlite"),
        path.join("images.sqlite"),
    )
    .unwrap()
}

struct Physical {
    storage: Mutex<SqliteRecoveryStorage>,
    archive: Arc<Storage>,
    lose_commit_reply: AtomicBool,
}
#[async_trait::async_trait]
impl SerializedRecoveryExecutor for Physical {
    async fn invoke(
        &self,
        request: String,
        binary: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
        let control: Control = serde_json::from_str(&request).unwrap();
        if matches!(
            control,
            Control::SinkWrite { .. }
                | Control::SinkCommit { .. }
                | Control::SinkDiscard { .. }
                | Control::SourceRewind { .. }
                | Control::SourceRead { .. }
                | Control::SourceClose { .. }
        ) {
            return self.archive.invoke(request, binary).await;
        }
        let mut storage = self.storage.lock().unwrap();
        let cancellation = RequestCancellation::new();
        let (reply, bytes) = match &control {
            Control::EnterMaintenance { .. } => (
                Reply::MaintenanceEntered {
                    physical_schemas: storage.physical_schemas(),
                },
                None,
            ),
            Control::LeaveMaintenance { .. } => (Reply::MaintenanceLeft, None),
            Control::ListAccounts { cursor, .. } => storage.list_accounts(cursor.as_deref())?,
            Control::ReadEntry {
                account_id, cursor, ..
            } => storage.read_entry(account_id, cursor.as_deref())?,
            Control::AddArtifactEntry {
                account_id, record, ..
            } => (
                storage.add_artifact(account_id, record, binary.as_deref(), &cancellation)?,
                None,
            ),
            Control::BeginRepairStage { .. }
            | Control::StageExpectedRow { .. }
            | Control::StageRowStart { .. }
            | Control::StageRowChunk { .. }
            | Control::StageRowEnd { .. }
            | Control::CommitRepair { .. }
            | Control::DiscardRepairStage { .. } => (
                storage.execute_repair(&control, binary.as_deref(), &cancellation)?,
                None,
            ),
            _ => panic!("Unexpected nonphysical recovery request"),
        };
        if matches!(reply, Reply::Repaired) && self.lose_commit_reply.swap(false, Ordering::SeqCst)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "Actual SQLite commit reply lost",
            ));
        }
        Ok((serde_json::to_string(&reply).unwrap(), bytes))
    }
}
async fn port(
    databases: &Databases,
    archive: Arc<Storage>,
    key: [u8; 32],
) -> (RecoveryPort, Arc<Physical>) {
    let storage = databases.open();
    let schemas = storage.physical_schemas();
    let executor = Arc::new(Physical {
        storage: Mutex::new(storage),
        archive,
        lose_commit_reply: AtomicBool::new(false),
    });
    let platform = crate::platform_storage::PlatformStorage::new(
        crate::runtime::operation_fixtures::MemoryPlatform::new(),
    );
    platform
        .store_device_key(&crate::platform_storage::DeviceKeyDocument::new(key))
        .await
        .unwrap();
    let port = RecoveryPort::new(
        executor.clone(),
        "sqlite-protected-recovery".into(),
        RequestCancellation::new(),
    )
    .with_platform_storage(platform);
    assert!(port.record_physical_schemas(schemas));
    (port, executor)
}
fn records(databases: &Databases) -> Vec<Entry> {
    let mut storage = databases.open();
    let mut cursor = None;
    let mut entries = Vec::new();
    loop {
        match storage.read_entry("account", cursor.as_deref()).unwrap() {
            (
                Reply::Entry {
                    record,
                    next_cursor,
                    ..
                },
                bytes,
            ) => {
                entries.push(Entry { record, bytes });
                cursor = next_cursor;
            }
            (Reply::End, None) => return entries,
            _ => panic!("Unexpected physical scan result"),
        }
    }
}

#[tokio::test]
async fn sqlite_protected_archive_repair_preserves_accepted_work_across_device_change_and_lost_commit(
) {
    let (archive, identity, plaintext) = super::protected_images::protected_fixture();
    let databases = Databases::new();
    install_fixture(&databases, &archive);
    let original = records(&databases);
    let accepted = original
        .iter()
        .find_map(|entry| match &entry.record {
            RecoveryRecord::RawReplicaRow {
                store: ReplicaStore::Operations,
                payload_json,
                ..
            } => Some(payload_json.clone()),
            _ => None,
        })
        .unwrap();
    let ciphertext = original
        .iter()
        .find(|entry| {
            matches!(
                entry.record,
                RecoveryRecord::ProtectedVaultImageChunk { .. }
            )
        })
        .unwrap()
        .bytes
        .clone()
        .unwrap();
    let (source, source_executor) = port(&databases, archive.clone(), [7; 32]).await;
    let snapshot = capture(&source, &identity.account_id).await.unwrap();
    assert!(snapshot.complete);
    assert_eq!(
        export_snapshot(
            &source,
            &identity.account_id,
            Some(identity.server_url.clone()),
            Some(identity.user_id.clone()),
            "separate recovery password",
            "sink",
            &snapshot
        )
        .await
        .unwrap()
        .1,
        RecoveryClassification::Complete
    );
    drop(source);
    drop(source_executor);
    let replica = databases.connection("replica.sqlite");
    replica.execute("INSERT INTO replica_rows VALUES('account',?1,'generation/item','malformed derived row')", [crate::replica::sqlite::encode_store(ReplicaStore::AuthorityItems)]).unwrap();
    drop(replica);
    let images = databases.connection("images.sqlite");
    images
        .execute(
            "DELETE FROM vault_image_artifact_chunks WHERE account_id='account'",
            [],
        )
        .unwrap();
    images
        .execute(
            "DELETE FROM vault_image_artifacts WHERE account_id='account'",
            [],
        )
        .unwrap();
    drop(images);
    // Reopen every physical handle; destination Device-key scope is intentionally different.
    let (destination, executor) = port(&databases, archive, [8; 32]).await;
    let current = capture(&destination, &identity.account_id).await.unwrap();
    assert!(!current.complete);
    executor.lose_commit_reply.store(true, Ordering::SeqCst);
    assert_eq!(
        repair_bundle(
            &destination,
            &identity,
            &current,
            "separate recovery password",
            "source"
        )
        .await
        .unwrap_err()
        .code,
        RuntimeErrorCode::StorageUnavailable
    );
    let repaired = capture(&destination, &identity.account_id).await.unwrap();
    assert!(repaired.complete);
    let revision = repaired.proof.as_ref().unwrap().head.replica_revision;
    assert_eq!(revision, 6);
    assert_eq!(
        repair_bundle(
            &destination,
            &identity,
            &repaired,
            "separate recovery password",
            "source"
        )
        .await
        .unwrap(),
        revision
    );
    let final_entries = records(&databases);
    assert!(final_entries.iter().any(|entry| matches!(&entry.record, RecoveryRecord::RawReplicaRow {store: ReplicaStore::Operations, payload_json, ..} if payload_json == &accepted)));
    let chunks: Vec<_> = final_entries
        .iter()
        .filter(|entry| {
            matches!(
                entry.record,
                RecoveryRecord::ProtectedVaultImageChunk { .. }
            )
        })
        .map(|entry| entry.bytes.clone().unwrap())
        .collect();
    assert_eq!(chunks, vec![ciphertext]);
    let metadata: crate::recovery::artifacts::ImageMetadata = final_entries
        .iter()
        .find_map(|entry| match &entry.record {
            RecoveryRecord::ProtectedVaultImageMetadata { metadata_json, .. } => {
                Some(serde_json::from_str(metadata_json).unwrap())
            }
            _ => None,
        })
        .unwrap();
    let protection = metadata.protection.as_ref().unwrap();
    assert_eq!(
        crate::vault_image::protected::read_protected_image(
            &metadata.original().unwrap(),
            "user",
            &protection.witness,
            protection,
            &chunks,
            &[8; 32]
        )
        .unwrap()
        .as_slice(),
        plaintext
    );
    assert!(crate::vault_image::protected::read_protected_image(
        &metadata.original().unwrap(),
        "user",
        &protection.witness,
        protection,
        &chunks,
        &[7; 32]
    )
    .is_err());
}

fn install_fixture(databases: &Databases, archive: &Storage) {
    let mut physical = databases.open();
    let connection = databases.connection("replica.sqlite");
    for entry in archive.entries.lock().unwrap().iter() {
        match &entry.record {
            RecoveryRecord::RawReplicaHead { payload_json, .. } => {
                let head: ReplicaHead = serde_json::from_str(payload_json).unwrap();
                connection
                    .execute(
                        "INSERT INTO replica_heads VALUES(?1,?2,?3,?4,?5,NULL)",
                        params![
                            head.account_id.as_str(),
                            head.user_id,
                            head.incarnation.as_str(),
                            head.replica_revision.to_string(),
                            head.lock_epoch.to_string()
                        ],
                    )
                    .unwrap();
            }
            RecoveryRecord::RawReplicaRow {
                account_id,
                store,
                record_id,
                payload_json,
            } => {
                connection
                    .execute(
                        "INSERT INTO replica_rows VALUES(?1,?2,?3,?4)",
                        params![
                            account_id,
                            crate::replica::sqlite::encode_store(*store),
                            record_id,
                            payload_json
                        ],
                    )
                    .unwrap();
            }
            record => assert!(matches!(
                physical
                    .add_artifact(
                        "account",
                        record,
                        entry.bytes.as_deref(),
                        &RequestCancellation::new()
                    )
                    .unwrap(),
                Reply::ArtifactAdded
            )),
        }
    }
    drop(connection);
    drop(physical);
}

struct NoHttp;
#[async_trait::async_trait]
impl crate::SerializedHttpExecutor for NoHttp {
    async fn invoke(&self, _: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        panic!("failed-open recovery must not use HTTP");
    }
    fn cancel(&self, _: &str) {}
}

#[tokio::test]
async fn missing_device_key_failed_open_preserves_public_encrypted_partial_recovery() {
    use crate::platform_storage::{
        AccountMetadataDocument, DeviceCatalogAccount, DeviceCatalogDocument, PlatformStorage,
    };
    use crate::recovery::{
        archive::EntryHeader,
        report::{RecoveryFinding, RecoveryReport},
        transfer::ArchiveReader,
    };
    use crate::{Runtime, RuntimeRequest, RuntimeResponse};
    let (archive, identity, plaintext) = super::protected_images::protected_fixture();
    let databases = Databases::new();
    install_fixture(&databases, &archive);
    let original = records(&databases);
    let device = crate::runtime::operation_fixtures::MemoryPlatform::new();
    let platform = PlatformStorage::new(device.clone());
    platform
        .store_device_catalog(
            &DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
                account_id: identity.account_id.clone(),
                active_incarnation: Some(identity.incarnation.clone()),
                pending_retirement: None,
                pending_install: None,
            }])
            .unwrap(),
        )
        .await
        .unwrap();
    platform
        .store_account_metadata(
            &AccountMetadataDocument::new(
                identity.account_id.clone(),
                identity.incarnation.clone(),
                identity.user_id.clone(),
                "user@example.test".into(),
                "User".into(),
                identity.server_url.clone(),
                None,
                None,
                "A3".into(),
                1,
                1,
                false,
                false,
                bittery_crypto_core::current_kdf_profile(),
                None,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let runtime = Runtime::with_serialized_executors(
        Arc::new(SqliteReplica::open(databases.0.join("replica.sqlite")).unwrap()),
        device,
        Arc::new(NoHttp),
    );
    let executor = Arc::new(Physical {
        storage: Mutex::new(databases.open()),
        archive: archive.clone(),
        lose_commit_reply: AtomicBool::new(false),
    });
    runtime.set_recovery_executor(executor.clone()).unwrap();
    let error = runtime.open().await.unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::StorageUnavailable);
    assert_eq!(
        error.message,
        "Device key is missing for accepted protected Vault images"
    );
    assert!(platform.load_device_key().await.unwrap().is_none());
    let diagnosis = runtime
        .request(
            RuntimeRequest::InspectRecovery {
                account_id: Some(identity.account_id.clone()),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::RecoveryDiagnosed { diagnostics } = diagnosis else {
        panic!("expected public recovery diagnostics")
    };
    assert_eq!(diagnostics.accounts.len(), 1);
    assert!(diagnostics.accounts[0].can_export);
    let response = runtime
        .request(
            RuntimeRequest::ExportAccountRecovery {
                account_id: identity.account_id.clone(),
                password: "separate recovery password".into(),
                sink_capability_id: "sink".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(
        matches!(response, RuntimeResponse::RecoveryExported { classification: RecoveryClassification::Partial, byte_length, .. } if byte_length > 0)
    );
    let archive_bytes = archive.source.lock().unwrap().clone();
    assert!(!archive_bytes
        .windows(plaintext.len())
        .any(|bytes| bytes == plaintext));
    assert!(platform.load_device_key().await.unwrap().is_none());
    let port = RecoveryPort::new(
        executor,
        "inspect-export".into(),
        RequestCancellation::new(),
    )
    .with_platform_storage(platform);
    let mut reader = ArchiveReader::open(
        &port,
        &identity.account_id,
        "source",
        "separate recovery password",
    )
    .await
    .unwrap();
    let mut report = None;
    let mut chunks = 0;
    let mut accepted = 0;
    while let Some(record) = reader.next().await.unwrap() {
        match record.header {
            EntryHeader::Report => report = Some(RecoveryReport::decode(&record.body).unwrap()),
            EntryHeader::ProtectedVaultImageKey { .. } => {
                panic!("missing Device key cannot yield portable key material")
            }
            EntryHeader::ProtectedVaultImageChunk { .. } => {
                let expected = original
                    .iter()
                    .find(|entry| {
                        matches!(
                            entry.record,
                            RecoveryRecord::ProtectedVaultImageChunk { .. }
                        )
                    })
                    .unwrap();
                assert_eq!(record.body.as_slice(), expected.bytes.as_ref().unwrap());
                chunks += 1;
            }
            EntryHeader::ReplicaRow {
                store: ReplicaStore::Operations,
                ..
            } => {
                let expected = original
                    .iter()
                    .find_map(|entry| match &entry.record {
                        RecoveryRecord::RawReplicaRow {
                            store: ReplicaStore::Operations,
                            payload_json,
                            ..
                        } => Some(payload_json),
                        _ => None,
                    })
                    .unwrap();
                assert_eq!(record.body.as_slice(), expected.as_bytes());
                accepted += 1;
            }
            _ => {}
        }
    }
    reader.source_fingerprint().unwrap();
    assert_eq!((chunks, accepted), (1, 1));
    assert!(report
        .unwrap()
        .findings
        .contains(&RecoveryFinding::UnavailableVaultImageKey {
            operation_id: "image".into()
        }));
    let after = records(&databases);
    assert_eq!(after.len(), original.len());
    for (before, after) in original.iter().zip(&after) {
        assert_eq!(
            serde_json::to_string(&before.record).unwrap(),
            serde_json::to_string(&after.record).unwrap()
        );
        assert_eq!(before.bytes, after.bytes);
    }
    runtime.close().await;
}
