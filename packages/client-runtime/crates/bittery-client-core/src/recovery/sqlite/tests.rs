use super::*;
use crate::{SqliteAttachmentArtifactStore, SqliteReplica, SqliteVaultImageArtifactStore};
use rusqlite::{params, Connection};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

struct Databases {
    directory: PathBuf,
}
impl Databases {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "bittery-recovery-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        SqliteReplica::open(directory.join("replica.sqlite")).unwrap();
        SqliteAttachmentArtifactStore::open(directory.join("attachments.sqlite")).unwrap();
        SqliteVaultImageArtifactStore::open(directory.join("images.sqlite")).unwrap();
        Self { directory }
    }
    fn open(&self) -> Result<SqliteRecoveryStorage, RecoveryUnavailableReason> {
        SqliteRecoveryStorage::open(
            self.directory.join("replica.sqlite"),
            self.directory.join("attachments.sqlite"),
            self.directory.join("images.sqlite"),
        )
    }
    fn connection(&self, name: &str) -> Connection {
        Connection::open(self.directory.join(name)).unwrap()
    }
}
impl Drop for Databases {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

fn capture(storage: &mut SqliteRecoveryStorage, account: &str) -> Vec<(Record, Option<Vec<u8>>)> {
    let mut cursor = None;
    let mut records = Vec::new();
    loop {
        match storage.read_entry(account, cursor.as_deref()).unwrap() {
            (
                Reply::Entry {
                    record,
                    next_cursor,
                    ..
                },
                bytes,
            ) => {
                records.push((record, bytes));
                cursor = next_cursor;
            }
            (Reply::End, None) => return records,
            _ => panic!("unexpected physical reply"),
        }
    }
}

#[tokio::test]
async fn image_recovery_roundtrips_published_bytes_and_refuses_conflicts_cancellation_and_scope_changes(
) {
    use crate::{VaultImageArtifactMetadata, VaultImageArtifactPort, VaultImageArtifactScope};
    use sha2::{Digest, Sha256};
    let source = Databases::new();
    let image =
        SqliteVaultImageArtifactStore::open(source.directory.join("images.sqlite")).unwrap();
    let scope = VaultImageArtifactScope::new("a".into(), "image-operation").unwrap();
    let bytes = vec![17; CHUNK_BYTES + 7];
    let metadata = VaultImageArtifactMetadata::new(
        scope.clone(),
        "vault",
        bytes.len() as u64,
        "image/png",
        format!("{:x}", Sha256::digest(&bytes)),
    )
    .unwrap();
    image.begin(&scope).await.unwrap();
    for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
        image
            .write_chunk(&scope, index as u32, chunk)
            .await
            .unwrap();
    }
    image.publish(&metadata).await.unwrap();
    drop(image);
    let expected = capture(&mut source.open().unwrap(), "a");
    let destination = Databases::new();
    let mut restored = destination.open().unwrap();
    let token = crate::RequestCancellation::default();
    for (record, binary) in &expected {
        assert!(matches!(
            restored
                .add_artifact("a", record, binary.as_deref(), &token)
                .unwrap(),
            Reply::ArtifactAdded
        ));
        assert!(restored
            .add_artifact("b", record, binary.as_deref(), &token)
            .is_err());
    }
    let (chunk, binary) = expected.last().unwrap();
    let different = vec![99; binary.as_ref().unwrap().len()];
    assert!(restored
        .add_artifact("a", chunk, Some(&different), &token)
        .is_err());
    token.cancel();
    assert!(matches!(
        restored
            .add_artifact("a", chunk, Some(&different), &token)
            .unwrap(),
        Reply::Unavailable {
            reason: RecoveryUnavailableReason::Cancelled
        }
    ));
    drop(restored);
    assert!(capture(&mut destination.open().unwrap(), "a") == expected);
    assert!(capture(&mut destination.open().unwrap(), "b").is_empty());
    let image =
        SqliteVaultImageArtifactStore::open(destination.directory.join("images.sqlite")).unwrap();
    let mut actual = Vec::new();
    for index in 0..2 {
        actual.extend(image.read_chunk(&metadata, index).await.unwrap().unwrap());
    }
    assert!(image.read_chunk(&metadata, 2).await.unwrap().is_none());
    assert_eq!(actual, bytes);
}

#[tokio::test]
async fn protected_image_recovery_restores_exact_generation_without_overwriting_raw_sibling() {
    use crate::vault_image::protected::{
        ProtectedImageWriter, PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES,
    };
    use crate::{VaultImageArtifactMetadata, VaultImageArtifactPort, VaultImageArtifactScope};
    use sha2::{Digest, Sha256};
    let source = Databases::new();
    let bytes = vec![17; PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES + 7];
    let original = VaultImageArtifactMetadata::new(
        VaultImageArtifactScope::new("a".into(), "op").unwrap(),
        "vault",
        bytes.len() as u64,
        "image/png",
        format!("{:x}", Sha256::digest(&bytes)),
    )
    .unwrap();
    let mut writer = ProtectedImageWriter::new(original.scope().clone(), "vault", "user").unwrap();
    let chunks: Vec<_> = bytes
        .chunks(PROTECTED_IMAGE_PLAINTEXT_CHUNK_BYTES)
        .map(|bytes| writer.push(bytes).unwrap())
        .collect();
    let protection = writer.finish(&original, &[7; 32]).unwrap();
    let store =
        SqliteVaultImageArtifactStore::open(source.directory.join("images.sqlite")).unwrap();
    store.begin(original.scope()).await.unwrap();
    for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
        store
            .write_chunk(original.scope(), index as u32, chunk)
            .await
            .unwrap();
    }
    store.publish(&original).await.unwrap();
    let metadata = original.clone().with_protection(protection).unwrap();
    store.begin(metadata.scope()).await.unwrap();
    for (index, chunk) in chunks.iter().enumerate() {
        store
            .write_chunk(metadata.scope(), index as u32, chunk)
            .await
            .unwrap();
    }
    store.publish(&metadata).await.unwrap();
    drop(store);
    let account = metadata.account_id().as_str();
    let expected = capture(&mut source.open().unwrap(), account);
    let destination = Databases::new();
    let mut restored = destination.open().unwrap();
    let token = crate::RequestCancellation::default();
    for _ in 0..2 {
        for (record, binary) in &expected {
            assert!(matches!(
                restored
                    .add_artifact(account, record, binary.as_deref(), &token)
                    .unwrap(),
                Reply::ArtifactAdded
            ));
        }
    }
    assert!(capture(&mut restored, account) == expected);
    let (chunk, encrypted) = expected.last().unwrap();
    assert!(restored
        .add_artifact(
            account,
            chunk,
            Some(&vec![0; encrypted.as_ref().unwrap().len()]),
            &token
        )
        .is_err());
    assert!(restored
        .add_artifact("another-account", chunk, encrypted.as_deref(), &token)
        .is_err());
    drop(restored);
    assert!(capture(&mut destination.open().unwrap(), account) == expected);
    let store =
        SqliteVaultImageArtifactStore::open(destination.directory.join("images.sqlite")).unwrap();
    let mut ciphertext = Vec::new();
    for index in 0..chunks.len() {
        ciphertext.push(
            store
                .read_chunk(&metadata, index as u32)
                .await
                .unwrap()
                .unwrap(),
        );
    }
    assert!(store
        .read_chunk(&metadata, chunks.len() as u32)
        .await
        .unwrap()
        .is_none());
    let protection = metadata.protection().unwrap();
    let decoded = crate::vault_image::protected::read_protected_image(
        &original,
        "user",
        &protection.witness,
        protection,
        &ciphertext,
        &[7; 32],
    )
    .unwrap();
    assert_eq!(decoded.as_slice(), bytes);
}

#[test]
fn foreign_historical_generation_without_a_native_mapping_is_explicitly_unsupported() {
    let databases = Databases::new();
    let mut storage = databases.open().unwrap();
    let record=Record::ProvisionalMetadata {
        account_id:"a".into(), operation_id:"op".into(),attachment_id:"attachment".into(),generation:"foreign-history".into(),
        metadata_json:serde_json::json!({"accountId":"a","operationId":"op","attachmentId":"attachment","generation":"foreign-history","current":false,"publicationState":0,"durableChunkCount":0,"durableByteLength":0}).to_string(),
    };
    assert!(matches!(
        storage
            .add_artifact("a", &record, None, &crate::RequestCancellation::default())
            .unwrap(),
        Reply::Unavailable {
            reason: RecoveryUnavailableReason::Unsupported
        }
    ));
    assert!(capture(&mut storage, "a").is_empty());
}

#[test]
fn raw_capture_preserves_malformed_rows_and_isolates_accounts_after_reopen() {
    let databases = Databases::new();
    let connection = databases.connection("replica.sqlite");
    for account in ["a", "b"] {
        connection
            .execute(
                "INSERT INTO replica_heads VALUES(?1,'user','incarnation','1','2',NULL)",
                [account],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO replica_rows VALUES(?1,1,'accepted',?2)",
                params![account, "{ malformed accepted bytes"],
            )
            .unwrap();
    }
    drop(connection);
    let mut storage = databases.open().unwrap();
    let first = storage.read_entry("a", None).unwrap();
    let (cursor, record) = match first.0 {
        Reply::Entry {
            next_cursor,
            record,
            ..
        } => (next_cursor, record),
        _ => panic!("head expected"),
    };
    assert!(matches!(record, Record::RawReplicaHead { account_id, .. } if account_id == "a"));
    let second = storage.read_entry("a", cursor.as_deref()).unwrap();
    let cursor = match second.0 {
        Reply::Entry {
            next_cursor,
            record:
                Record::RawReplicaRow {
                    account_id,
                    payload_json,
                    ..
                },
            ..
        } => {
            assert_eq!(account_id, "a");
            assert_eq!(payload_json, "{ malformed accepted bytes");
            next_cursor
        }
        _ => panic!("raw accepted row expected"),
    };
    assert!(matches!(
        storage.read_entry("a", cursor.as_deref()).unwrap().0,
        Reply::End
    ));
    assert!(storage.read_entry("b", cursor.as_deref()).is_err());
    assert!(
        matches!(storage.read_entry("b", None).unwrap().0, Reply::Entry { record: Record::RawReplicaHead { account_id, .. }, .. } if account_id == "b")
    );
}

#[test]
fn unknown_schema_and_missing_files_are_preserved_without_creation_or_migration() {
    let databases = Databases::new();
    databases
        .connection("replica.sqlite")
        .execute_batch("PRAGMA user_version=99")
        .unwrap();
    let path = databases.directory.join("replica.sqlite");
    let before = std::fs::read(&path).unwrap();
    assert!(databases.open().is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    std::fs::remove_file(&path).unwrap();
    assert!(databases.open().is_err());
    assert!(!path.exists());
}

#[test]
fn physical_account_scan_includes_artifact_only_accounts() {
    let databases = Databases::new();
    databases.connection("attachments.sqlite").execute("INSERT INTO attachment_move_provisional_artifacts(account_id,operation_id,attachment_id,generation) VALUES('orphan','op','attachment','generation')", []).unwrap();
    let mut storage = databases.open().unwrap();
    assert!(
        matches!(storage.list_accounts(None).unwrap().0, Reply::AccountEntry { account_id, .. } if account_id == "orphan")
    );
}

#[test]
fn encrypted_artifact_chunks_are_bounded_and_streamed_in_key_order_after_reopen() {
    use crate::attachment_artifact_store::AttachmentArtifactOwner;
    use sha2::{Digest, Sha256};
    let databases = Databases::new();
    let bytes = vec![41; CHUNK_BYTES + 7];
    let account = crate::AccountId::from("a");
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let reference = crate::replica::attachment_move_artifact_ref(
        &account,
        "operation",
        "attachment",
        &digest,
        bytes.len() as u64,
    )
    .unwrap();
    let owner =
        AttachmentArtifactOwner::new(account, "operation", "attachment", reference).unwrap();
    let artifacts =
        SqliteAttachmentArtifactStore::open(databases.directory.join("attachments.sqlite"))
            .unwrap();
    // Physical insertion order differs from the required archive chunk order.
    artifacts
        .write_chunk(&owner, 1, &bytes[CHUNK_BYTES..])
        .unwrap();
    artifacts
        .write_chunk(&owner, 0, &bytes[..CHUNK_BYTES])
        .unwrap();
    drop(artifacts);
    let mut storage = databases.open().unwrap();
    let mut cursor = None;
    let mut chunks = Vec::new();
    loop {
        let (reply, binary) = storage.read_entry("a", cursor.as_deref()).unwrap();
        match reply {
            Reply::Entry {
                record: Record::ArtifactMetadata { metadata_json, .. },
                next_cursor,
                ..
            } => {
                let metadata: serde_json::Value = serde_json::from_str(&metadata_json).unwrap();
                assert_eq!(metadata["durableChunkCount"], 2);
                assert_eq!(metadata["publicationState"], "incomplete");
                cursor = next_cursor;
            }
            Reply::Entry {
                record: Record::ArtifactChunk { chunk_index, .. },
                next_cursor,
                ..
            } => {
                assert_eq!(chunk_index as usize, chunks.len());
                chunks.push(binary.unwrap());
                cursor = next_cursor;
            }
            Reply::End => break,
            _ => panic!("unexpected record"),
        }
    }
    assert_eq!(chunks.concat(), bytes);
    let captured = capture(&mut storage, "a");
    let destination = Databases::new();
    let mut restored = destination.open().unwrap();
    for (record, bytes) in &captured {
        assert!(matches!(
            restored
                .add_artifact(
                    "a",
                    record,
                    bytes.as_deref(),
                    &crate::RequestCancellation::default()
                )
                .unwrap(),
            Reply::ArtifactAdded
        ));
    }
    drop(restored);
    assert!(capture(&mut destination.open().unwrap(), "a") == captured);
    databases.connection("attachments.sqlite").execute("UPDATE attachment_move_artifact_chunks SET ciphertext=zeroblob(?1) WHERE chunk_index=0",[(CHUNK_BYTES+1) as i64]).unwrap();
    drop(storage);
    let mut storage = databases.open().unwrap();
    let cursor = match storage.read_entry("a", None).unwrap().0 {
        Reply::Entry { next_cursor, .. } => next_cursor,
        _ => panic!("metadata"),
    };
    let error = storage.read_entry("a", cursor.as_deref()).err().unwrap();
    assert_eq!(error.recovery_bound, Some(RecoveryBound::ChunkBytes));
}

#[test]
fn altered_artifact_schema_is_refused_without_touching_retained_bytes() {
    let databases = Databases::new();
    databases
        .connection("attachments.sqlite")
        .execute_batch("ALTER TABLE attachment_move_artifacts ADD COLUMN future_authority TEXT")
        .unwrap();
    let path = databases.directory.join("attachments.sqlite");
    let before = std::fs::read(&path).unwrap();
    assert!(databases.open().is_err());
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn unexpected_triggers_are_not_treated_as_the_known_replica_schema() {
    let databases = Databases::new();
    databases.connection("replica.sqlite").execute_batch("CREATE TRIGGER unknown_behavior AFTER INSERT ON replica_heads BEGIN DELETE FROM replica_rows; END;").unwrap();
    assert!(matches!(
        databases.open(),
        Err(RecoveryUnavailableReason::UnsupportedSchema)
    ));
}

#[test]
fn known_alter_column_artifact_layout_is_read_without_running_a_migration() {
    let databases = Databases::new();
    let path = databases.directory.join("attachments.sqlite");
    std::fs::remove_file(&path).unwrap();
    let connection = Connection::open(&path).unwrap();
    let schema = crate::attachment_artifact_store::sqlite::SCHEMA
        .replace("    physical_generation TEXT,\n", "");
    connection.execute_batch(&schema).unwrap();
    drop(connection);
    SqliteAttachmentArtifactStore::open(&path).unwrap();
    let before = std::fs::read(&path).unwrap();
    databases.open().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn corrupt_image_publication_is_not_normalized_into_unpublished_metadata() {
    let databases = Databases::new();
    databases
        .connection("images.sqlite")
        .execute(
            "INSERT INTO vault_image_artifacts(account_id,operation_id,vault_id,byte_length,content_type,sha256,published) VALUES('a','operation','vault',1,'image/png',?1,2)",
            ["f".repeat(64)],
        )
        .unwrap();
    assert!(databases.open().unwrap().read_entry("a", None).is_err());
}

#[test]
fn legacy_raw_image_layout_remains_readable_without_recovery_migration() {
    let databases = Databases::new();
    let path = databases.directory.join("images.sqlite");
    std::fs::remove_file(&path).unwrap();
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(crate::vault_image::sqlite::RAW_SCHEMA)
        .unwrap();
    connection
        .execute(
            "INSERT INTO vault_image_artifacts VALUES('a','operation','vault',1,'image/png',?1,1)",
            ["f".repeat(64)],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO vault_image_artifact_chunks VALUES('a','operation',0,X'AA')",
            [],
        )
        .unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    let mut storage = databases.open().unwrap();
    assert_eq!(storage.physical_schemas().vault_images_version, 1);
    let records = capture(&mut storage, "a");
    assert_eq!(records.len(), 2);
    assert_eq!(records[1].1.as_deref(), Some([0xAA].as_slice()));
    assert_eq!(std::fs::read(path).unwrap(), before);
}

#[test]
fn protected_image_generation_is_not_misreported_as_legacy_raw_recovery_bytes() {
    let databases = Databases::new();
    assert_eq!(
        databases
            .open()
            .unwrap()
            .physical_schemas()
            .vault_images_version,
        2
    );
    let connection = databases.connection("images.sqlite");
    for publication in ["", "protected-a", "protected-b"] {
        connection.execute("INSERT INTO vault_image_artifacts(account_id,operation_id,publication_id) VALUES('a','operation',?1)", [publication]).unwrap();
        connection
            .execute(
                "INSERT INTO vault_image_artifact_chunks VALUES('a','operation',?1,0,X'AABB')",
                [publication],
            )
            .unwrap();
    }
    drop(connection);
    let before = std::fs::read(databases.directory.join("images.sqlite")).unwrap();
    let records = capture(&mut databases.open().unwrap(), "a");
    assert_eq!(
        records.len(),
        6,
        "Every raw/protected sibling must survive the bounded cursor"
    );
    assert!(matches!(&records[0].0, Record::VaultImageMetadata { .. }));
    assert!(
        matches!(&records[1].0, Record::ProtectedVaultImageMetadata { publication_id, .. } if publication_id == "protected-a")
    );
    assert!(
        matches!(&records[2].0, Record::ProtectedVaultImageMetadata { publication_id, .. } if publication_id == "protected-b")
    );
    assert!(matches!(&records[3].0, Record::VaultImageChunk { .. }));
    assert!(
        matches!(&records[4].0, Record::ProtectedVaultImageChunk { publication_id, .. } if publication_id == "protected-a")
    );
    assert!(
        matches!(&records[5].0, Record::ProtectedVaultImageChunk { publication_id, .. } if publication_id == "protected-b")
    );
    assert_eq!(
        std::fs::read(databases.directory.join("images.sqlite")).unwrap(),
        before
    );
}

#[test]
fn ordinary_artifact_open_refuses_future_layout_before_creating_or_altering_tables() {
    let databases = Databases::new();
    for (name, image) in [
        ("future-attachments.sqlite", false),
        ("future-images.sqlite", true),
    ] {
        let path = databases.directory.join(name);
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("PRAGMA user_version=99; CREATE TABLE accepted_future_work(bytes BLOB); INSERT INTO accepted_future_work VALUES(X'102030');").unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();
        let opened = if image {
            SqliteVaultImageArtifactStore::open(&path).map(drop)
        } else {
            SqliteAttachmentArtifactStore::open(&path).map(drop)
        };
        assert!(
            opened.is_err(),
            "normal startup must reject future artifact layout"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[test]
fn guarded_repair_preserves_other_accounts_and_rejects_same_head_row_changes() {
    use crate::{
        RecoveryControlRequest as Request, RecoveryExpectedRow, ReplicaHead, ReplicaStore,
    };
    use sha2::{Digest, Sha256};
    let databases = Databases::new();
    let connection = databases.connection("replica.sqlite");
    for account in ["a", "b"] {
        connection
            .execute(
                "INSERT INTO replica_heads VALUES(?1,'user','incarnation','1','2',NULL)",
                [account],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO replica_rows VALUES(?1,1,'accepted','retained-work')",
                [account],
            )
            .unwrap();
    }
    drop(connection);
    let mut storage = databases.open().unwrap();
    let head_json = match storage.read_entry("a", None).unwrap().0 {
        Reply::Entry {
            record: Record::RawReplicaHead { payload_json, .. },
            ..
        } => payload_json,
        _ => panic!("head"),
    };
    let mut next_head: ReplicaHead = serde_json::from_str(&head_json).unwrap();
    next_head.replica_revision += 1;
    next_head.lock_epoch += 1;
    let scope = || ("recovery".to_owned(), "a".to_owned());
    let (recovery_id, account_id) = scope();
    assert!(matches!(
        storage
            .execute_repair(
                &Request::BeginRepairStage {
                    recovery_id,
                    account_id
                },
                None,
                &crate::RequestCancellation::new()
            )
            .unwrap(),
        Reply::RepairStageBegun
    ));
    let (recovery_id, account_id) = scope();
    storage
        .execute_repair(
            &Request::StageExpectedRow {
                recovery_id,
                account_id,
                row: RecoveryExpectedRow {
                    store: ReplicaStore::Operations,
                    record_id: "accepted".into(),
                    payload_sha256: format!("{:x}", Sha256::digest(b"retained-work")),
                },
            },
            None,
            &crate::RequestCancellation::new(),
        )
        .unwrap();
    let (recovery_id, account_id) = scope();
    storage
        .execute_repair(
            &Request::StageRowStart {
                recovery_id,
                account_id,
                store: ReplicaStore::Operations,
                record_id: "accepted".into(),
                payload_byte_length: 13,
            },
            None,
            &crate::RequestCancellation::new(),
        )
        .unwrap();
    let (recovery_id, account_id) = scope();
    storage
        .execute_repair(
            &Request::StageRowChunk {
                recovery_id,
                account_id,
            },
            Some(b"retained-work"),
            &crate::RequestCancellation::new(),
        )
        .unwrap();
    let (recovery_id, account_id) = scope();
    storage
        .execute_repair(
            &Request::StageRowEnd {
                recovery_id,
                account_id,
            },
            None,
            &crate::RequestCancellation::new(),
        )
        .unwrap();
    let (recovery_id, account_id) = scope();
    let commit = Request::CommitRepair {
        recovery_id,
        account_id,
        expected_head_json: head_json,
        next_head,
        staged_row_count: 1,
        expected_row_count: 1,
    };
    let connection = databases.connection("replica.sqlite");
    connection
        .execute(
            "UPDATE replica_rows SET payload_json='concurrent-accepted' WHERE account_id='a'",
            [],
        )
        .unwrap();
    assert!(matches!(
        storage
            .execute_repair(&commit, None, &crate::RequestCancellation::new())
            .unwrap(),
        Reply::Stale
    ));
    connection
        .execute(
            "UPDATE replica_rows SET payload_json='retained-work' WHERE account_id='a'",
            [],
        )
        .unwrap();
    assert!(matches!(
        storage
            .execute_repair(&commit, None, &crate::RequestCancellation::new())
            .unwrap(),
        Reply::Repaired
    ));
    assert_eq!(
        connection
            .query_row(
                "SELECT replica_revision FROM replica_heads WHERE account_id='a'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "2"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT replica_revision FROM replica_heads WHERE account_id='b'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "1"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM replica_rows WHERE payload_json='retained-work'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
}

#[test]
fn malformed_staged_utf8_rolls_back_the_whole_install_and_abandoned_stage_is_not_durable() {
    use crate::{
        RecoveryControlRequest as Request, RecoveryExpectedRow, ReplicaHead, ReplicaStore,
        RequestCancellation,
    };
    use sha2::{Digest, Sha256};
    let databases = Databases::new();
    let connection = databases.connection("replica.sqlite");
    connection.execute_batch("INSERT INTO replica_heads VALUES('a','user','incarnation','1','2',NULL); INSERT INTO replica_rows VALUES('a',1,'accepted','retained-work');").unwrap();
    let before = std::fs::read(databases.directory.join("replica.sqlite")).unwrap();
    let mut storage = databases.open().unwrap();
    let head_json = match storage.read_entry("a", None).unwrap().0 {
        Reply::Entry {
            record: Record::RawReplicaHead { payload_json, .. },
            ..
        } => payload_json,
        _ => panic!("head"),
    };
    let mut next: ReplicaHead = serde_json::from_str(&head_json).unwrap();
    next.replica_revision += 1;
    next.lock_epoch += 1;
    let token = RequestCancellation::new();
    for request in [
        Request::BeginRepairStage {
            recovery_id: "recovery".into(),
            account_id: "a".into(),
        },
        Request::StageExpectedRow {
            recovery_id: "recovery".into(),
            account_id: "a".into(),
            row: RecoveryExpectedRow {
                store: ReplicaStore::Operations,
                record_id: "accepted".into(),
                payload_sha256: format!("{:x}", Sha256::digest(b"retained-work")),
            },
        },
        Request::StageRowStart {
            recovery_id: "recovery".into(),
            account_id: "a".into(),
            store: ReplicaStore::Operations,
            record_id: "accepted".into(),
            payload_byte_length: 1,
        },
    ] {
        storage.execute_repair(&request, None, &token).unwrap();
    }
    storage
        .execute_repair(
            &Request::StageRowChunk {
                recovery_id: "recovery".into(),
                account_id: "a".into(),
            },
            Some(&[255]),
            &token,
        )
        .unwrap();
    storage
        .execute_repair(
            &Request::StageRowEnd {
                recovery_id: "recovery".into(),
                account_id: "a".into(),
            },
            None,
            &token,
        )
        .unwrap();
    let commit = Request::CommitRepair {
        recovery_id: "recovery".into(),
        account_id: "a".into(),
        expected_head_json: head_json,
        next_head: next,
        staged_row_count: 1,
        expected_row_count: 1,
    };
    assert!(storage.execute_repair(&commit, None, &token).is_err());
    assert_eq!(
        connection
            .query_row(
                "SELECT payload_json FROM replica_rows WHERE account_id='a'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "retained-work"
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT replica_revision FROM replica_heads WHERE account_id='a'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "1"
    );
    drop(storage);
    assert_eq!(
        std::fs::read(databases.directory.join("replica.sqlite")).unwrap(),
        before
    );
    assert!(databases
        .open()
        .unwrap()
        .execute_repair(&commit, None, &token)
        .is_err());
}

#[tokio::test]
async fn historical_authenticated_generation_remains_recoverable_after_a_new_publication() {
    use crate::attachment_artifact_store::{
        authenticated_target_for, ProvisionalAttachmentArtifactScope,
    };
    use crate::replica::recovery::RecoveryCoverage;
    use crate::replica::{
        AttachmentMovePreparationRecord, AttachmentMoveProgress, ReplicaItemRecord,
    };
    use crate::{
        ProvisionalAttachmentArtifactStore,
        ProvisionalAttachmentArtifactStoreRequest as ArtifactRequest,
        ProvisionalAttachmentArtifactStoreResponse as ArtifactResponse,
        ProvisionalAttachmentArtifactWriter,
    };
    let (head, rows, mut preparation) = crate::replica::recovery::corpus_loaded_rows()
        .into_iter()
        .find_map(|(head, rows)| {
            let preparation = rows
                .iter()
                .filter(|row| row.store == crate::ReplicaStore::AttachmentMovePreparations)
                .find_map(|row| {
                    let value: AttachmentMovePreparationRecord =
                        serde_json::from_str(&row.payload_json).unwrap();
                    value
                        .progress
                        .iter()
                        .any(|progress| {
                            matches!(progress, AttachmentMoveProgress::Encrypted { .. })
                        })
                        .then_some(value)
                })?;
            Some((head, rows, preparation))
        })
        .unwrap();
    let databases = Databases::new();
    let artifacts =
        SqliteAttachmentArtifactStore::open(databases.directory.join("attachments.sqlite"))
            .unwrap();
    let progress = preparation
        .progress
        .iter_mut()
        .find(|progress| matches!(progress, AttachmentMoveProgress::Encrypted { .. }))
        .unwrap();
    let AttachmentMoveProgress::Encrypted {
        attachment_id,
        artifact,
        ..
    } = progress
    else {
        unreachable!()
    };
    let scope = ProvisionalAttachmentArtifactScope::new(
        head.account_id.clone(),
        &preparation.operation_id,
        attachment_id.clone(),
    )
    .unwrap();
    let mut old_generation = None;
    for iteration in 0..2 {
        let (bytes, proof) = authenticated_target_for(
            "same plaintext",
            head.account_id.as_str(),
            &head.user_id,
            &preparation.operation_id,
            attachment_id,
        );
        let writer = ProvisionalAttachmentArtifactWriter::new(scope.clone());
        let writer = match artifacts
            .invoke_provisional(ArtifactRequest::Begin { writer })
            .await
            .unwrap()
        {
            ArtifactResponse::Begun(writer) => writer,
            _ => panic!("new writer"),
        };
        for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
            artifacts
                .invoke_provisional(ArtifactRequest::WriteChunk {
                    writer: writer.clone(),
                    chunk_index: index as u32,
                    bytes: chunk.to_vec(),
                })
                .await
                .unwrap();
        }
        let owner = match artifacts
            .invoke_provisional(ArtifactRequest::Finalize {
                writer: writer.clone(),
                publication_proof: proof,
            })
            .await
            .unwrap()
        {
            ArtifactResponse::Finalized(owner) => owner,
            _ => panic!("publication"),
        };
        if iteration == 0 {
            *artifact = crate::replica::attachment_move_artifact_ref(
                &head.account_id,
                &preparation.operation_id,
                attachment_id,
                owner.ciphertext_sha256(),
                owner.byte_length(),
            )
            .unwrap();
            old_generation = Some(writer.generation().to_owned());
        }
    }
    drop(artifacts);
    let mut coverage = RecoveryCoverage::new(head.clone()).unwrap();
    coverage
        .push_row(
            crate::ReplicaStore::AttachmentMovePreparations,
            &preparation.operation_id,
            &serde_json::to_string(&preparation).unwrap(),
        )
        .unwrap();
    let overlay = rows
        .iter()
        .find(|row| {
            row.store == crate::ReplicaStore::OptimisticItems
                && serde_json::from_str::<ReplicaItemRecord>(&row.payload_json)
                    .unwrap()
                    .operation_id
                    == preparation.operation_id
        })
        .unwrap();
    coverage
        .push_row(overlay.store, &overlay.key.record_id, &overlay.payload_json)
        .unwrap();
    let proof = coverage.finish().unwrap();
    let mut inventory =
        super::super::artifacts::ArtifactInventory::new(head.account_id.as_str().to_owned());
    let mut storage = databases.open().unwrap();
    let mut cursor = None;
    let mut historical = false;
    let mut captured = Vec::new();
    loop {
        match storage
            .read_entry(head.account_id.as_str(), cursor.as_deref())
            .unwrap()
        {
            (
                Reply::Entry {
                    record,
                    next_cursor,
                    ..
                },
                bytes,
            ) => {
                if let Record::ProvisionalMetadata {
                    generation,
                    metadata_json,
                    ..
                } = &record
                {
                    if Some(generation) == old_generation.as_ref() {
                        assert_eq!(
                            serde_json::from_str::<serde_json::Value>(metadata_json).unwrap()
                                ["current"],
                            false
                        );
                        historical = true;
                    }
                }
                captured.push((record.clone(), bytes.clone()));
                let (header, body) = super::super::transfer::archive_record(
                    record,
                    bytes.map(zeroize::Zeroizing::new),
                )
                .unwrap();
                inventory
                    .observe(&super::super::archive::DecodedRecord { header, body })
                    .unwrap();
                cursor = next_cursor;
            }
            (Reply::End, None) => break,
            _ => panic!("unexpected capture reply"),
        }
    }
    assert!(
        historical,
        "published mapping must retain the older generation's physical metadata"
    );
    let selected = inventory.select(&proof).unwrap();
    assert!(selected
        .provisional
        .iter()
        .any(|(_, _, generation)| Some(generation) == old_generation.as_ref()));
    // Install through the physical recovery contract into a separate native device, then reopen.
    let destination = Databases::new();
    let mut restored = destination.open().unwrap();
    let token = crate::RequestCancellation::default();
    for (record, bytes) in &captured {
        assert!(matches!(
            restored
                .add_artifact(head.account_id.as_str(), record, bytes.as_deref(), &token)
                .unwrap(),
            Reply::ArtifactAdded
        ));
        // Retry of immutable content is idempotent.
        assert!(matches!(
            restored
                .add_artifact(head.account_id.as_str(), record, bytes.as_deref(), &token)
                .unwrap(),
            Reply::ArtifactAdded
        ));
    }
    drop(restored);
    let mut restored = destination.open().unwrap();
    let mut restored_cursor = None;
    let mut roundtrip = Vec::new();
    loop {
        match restored
            .read_entry(head.account_id.as_str(), restored_cursor.as_deref())
            .unwrap()
        {
            (
                Reply::Entry {
                    record,
                    next_cursor,
                    ..
                },
                bytes,
            ) => {
                roundtrip.push((record, bytes));
                restored_cursor = next_cursor;
            }
            (Reply::End, None) => break,
            _ => panic!("unexpected restored capture"),
        }
    }
    assert!(
        roundtrip == captured,
        "physical recovery must preserve every generation and byte"
    );
}
