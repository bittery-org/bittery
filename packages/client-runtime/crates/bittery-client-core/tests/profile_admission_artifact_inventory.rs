#![cfg(not(target_arch = "wasm32"))]

use bittery_client_core::{
    AccountId, ArtifactChunkWrite, AttachmentArtifactInventoryContinuation,
    AttachmentArtifactInventoryFamily, AttachmentArtifactInventoryPage,
    AttachmentArtifactInventorySchema, AttachmentArtifactPhysicalKey, AttachmentArtifactStore,
    AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
    ProvisionalAttachmentArtifactScope, ProvisionalAttachmentArtifactStore,
    ProvisionalAttachmentArtifactStoreRequest, ProvisionalAttachmentArtifactStoreResponse,
    ProvisionalAttachmentArtifactWriter, SqliteAttachmentArtifactStore,
};
use rusqlite::{params, Connection};
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bittery-profile-artifact-inventory-{}",
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

fn database_bytes(path: &Path) -> (Vec<u8>, Option<Vec<u8>>) {
    let mut wal_path = path.as_os_str().to_os_string();
    wal_path.push("-wal");
    let wal = match std::fs::read(PathBuf::from(wal_path)) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => panic!("could not capture the database WAL: {error}"),
    };
    (std::fs::read(path).unwrap(), wal)
}

#[tokio::test]
async fn inventory_reports_all_physical_families_without_account_or_publication_authority() {
    let directory = TestDirectory::new();
    let path = directory.0.join("artifacts.sqlite");
    // No Replica, catalog, or Account installation exists for any of these physical keys.
    let store = SqliteAttachmentArtifactStore::open(&path).unwrap();
    let account = AccountId::from("uninstalled-account");
    let scope = ProvisionalAttachmentArtifactScope::new(
        account.clone(),
        "pending-operation",
        "pending-attachment",
    )
    .unwrap();
    let writer = ProvisionalAttachmentArtifactWriter::new(scope.clone());
    assert_eq!(
        store
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
                writer: writer.clone(),
            })
            .await
            .unwrap(),
        ProvisionalAttachmentArtifactStoreResponse::Begun(writer.clone())
    );
    assert_eq!(
        store
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::WriteChunk {
                writer: writer.clone(),
                chunk_index: 0,
                bytes: vec![0xff, 0x00, 0x80, 0x7f],
            })
            .await
            .unwrap(),
        ProvisionalAttachmentArtifactStoreResponse::ChunkWritten(ArtifactChunkWrite::Stored)
    );
    assert_eq!(
        store
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Recover { scope })
            .await
            .unwrap(),
        ProvisionalAttachmentArtifactStoreResponse::RecoveryUnavailable
    );

    let old_generation = ProvisionalAttachmentArtifactWriter::new(
        ProvisionalAttachmentArtifactScope::new(
            account.clone(),
            "pending-operation",
            "pending-attachment",
        )
        .unwrap(),
    )
    .generation()
    .to_owned();
    assert_ne!(old_generation, writer.generation());
    {
        let raw = Connection::open(&path).unwrap();
        // Only the physical damage fixtures bypass the owner: an unowned metadata row,
        // a chunk without metadata, and a chunk from a noncurrent provisional generation.
        raw.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        raw.execute(
            "INSERT INTO attachment_move_artifacts (
                account_id, artifact_id, operation_id, attachment_id,
                ciphertext_sha256, byte_length, chunk_count, publication_state
             ) VALUES (?1, 'unowned-artifact', 'unowned-operation', 'unowned-attachment',
                       'opaque metadata: not JSON or a digest', 4, 1, 0)",
            [account.as_str()],
        )
        .unwrap();
        raw.execute(
            "INSERT INTO attachment_move_artifact_chunks (
                account_id, artifact_id, chunk_index, ciphertext, ciphertext_sha256
             ) VALUES (?1, 'orphan-chunk-without-metadata', 7, ?2, ?3)",
            params![
                account.as_str(),
                [0xfe_u8, 0x00, 0x81, 0x7e].as_slice(),
                "opaque orphan checksum: not JSON",
            ],
        )
        .unwrap();
        raw.execute(
            "INSERT INTO attachment_move_provisional_chunks (
                account_id, operation_id, attachment_id, generation,
                chunk_index, ciphertext, ciphertext_sha256
             ) VALUES (?1, 'pending-operation', 'pending-attachment', ?2, 3, ?3, ?4)",
            params![
                account.as_str(),
                &old_generation,
                [0xfd_u8, 0x00, 0x82, 0x7d].as_slice(),
                "opaque noncurrent checksum: not JSON",
            ],
        )
        .unwrap();
    }
    let before = database_bytes(&path);

    let result = store
        .invoke(AttachmentArtifactStoreRequest::Inventory { cursor: None })
        .await;

    assert!(
        database_bytes(&path) == before,
        "inventory must preserve every database and optional WAL byte"
    );
    let AttachmentArtifactStoreResponse::InventoryPage(page) = result.unwrap() else {
        panic!("inventory must return the closed physical key page");
    };
    page.validate().unwrap();

    // The two random, canonical generation keys follow the documented UTF-8 tuple order.
    let mut generations = [(old_generation, 3), (writer.generation().to_owned(), 0)];
    generations.sort_by(|left, right| left.0.cmp(&right.0));
    let mut expected = vec![
        AttachmentArtifactPhysicalKey::Artifact {
            account_id: account.clone(),
            artifact_id: "unowned-artifact".into(),
        },
        AttachmentArtifactPhysicalKey::ArtifactChunk {
            account_id: account.clone(),
            artifact_id: "orphan-chunk-without-metadata".into(),
            chunk_index: 7,
        },
        AttachmentArtifactPhysicalKey::ProvisionalScope {
            account_id: account.clone(),
            operation_id: "pending-operation".into(),
            attachment_id: "pending-attachment".into(),
        },
    ];
    expected.extend(generations.into_iter().map(|(generation, chunk_index)| {
        AttachmentArtifactPhysicalKey::ProvisionalChunk {
            account_id: account.clone(),
            operation_id: "pending-operation".into(),
            attachment_id: "pending-attachment".into(),
            generation,
            chunk_index,
        }
    }));
    assert_eq!(
        page,
        AttachmentArtifactInventoryPage {
            version: 1,
            family: AttachmentArtifactInventoryFamily::AttachmentArtifacts,
            schema: AttachmentArtifactInventorySchema::SqliteV1,
            entries: expected,
            continuation: AttachmentArtifactInventoryContinuation::End {},
        }
    );

    // The native port is typed. Measure its public page in the specified flat control
    // envelope without fetching metadata values or exposing a ciphertext read API.
    let mut control = serde_json::to_value(&page).unwrap();
    control.as_object_mut().unwrap().insert(
        "type".into(),
        serde_json::Value::String("inventoryPage".into()),
    );
    let control = serde_json::to_string(&control).unwrap();
    assert!(control.len() <= 262_144);
    assert!(!control.contains("opaque"));
    assert!(!control.contains("ciphertext"));
    assert!(!control.contains("publicationState"));
    assert!(!control.contains("byteLength"));
}

#[tokio::test]
async fn inventory_pages_every_physical_key_and_rejects_a_cursor_after_owner_reopen() {
    let directory = TestDirectory::new();
    let path = directory.0.join("paged-artifacts.sqlite");
    let store = SqliteAttachmentArtifactStore::open(&path).unwrap();
    let account = AccountId::from("uninstalled-paging-account");
    let writer = ProvisionalAttachmentArtifactWriter::new(
        ProvisionalAttachmentArtifactScope::new(account.clone(), "pending-op", "pending-file")
            .unwrap(),
    );
    assert_eq!(
        store
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
                writer: writer.clone(),
            })
            .await
            .unwrap(),
        ProvisionalAttachmentArtifactStoreResponse::Begun(writer.clone())
    );
    assert_eq!(
        store
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::WriteChunk {
                writer: writer.clone(),
                chunk_index: 0,
                bytes: vec![0xff, 0x00, 0x80],
            })
            .await
            .unwrap(),
        ProvisionalAttachmentArtifactStoreResponse::ChunkWritten(ArtifactChunkWrite::Stored)
    );

    // This is the independently specified UTF-8 order, including embedded NUL and
    // supplementary-plane keys whose UTF-16 order would differ from SQLite BINARY.
    let mut artifact_ids: Vec<String> = ["\0", "\"", "Z", "a"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    artifact_ids.extend((0..126).map(|index| format!("item-{index:03}")));
    artifact_ids.extend(["z", "é", "\u{e000}", "\u{10000}", "😀"].map(str::to_owned));
    let chunk_keys = [
        ("orphan-\u{e000}", 2),
        ("orphan-\u{e000}", 10),
        ("orphan-\u{10000}", 1),
    ];
    {
        let mut raw = Connection::open(&path).unwrap();
        raw.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        let transaction = raw.transaction().unwrap();
        // These orphan rows have no Account, workflow, or publication authority. Insert
        // them in reverse order so insertion order cannot stand in for physical key order.
        for artifact_id in artifact_ids.iter().rev() {
            transaction
                .execute(
                    "INSERT INTO attachment_move_artifacts (
                        account_id, artifact_id, operation_id, attachment_id,
                        ciphertext_sha256, byte_length, chunk_count, publication_state
                     ) VALUES (?1, ?2, 'orphan-op', 'orphan-file', 'opaque digest', 3, 1, 0)",
                    params![account.as_str(), artifact_id],
                )
                .unwrap();
        }
        for (artifact_id, chunk_index) in chunk_keys.iter().rev() {
            transaction
                .execute(
                    "INSERT INTO attachment_move_artifact_chunks (
                        account_id, artifact_id, chunk_index, ciphertext, ciphertext_sha256
                     ) VALUES (?1, ?2, ?3, ?4, 'opaque orphan checksum')",
                    params![
                        account.as_str(),
                        artifact_id,
                        chunk_index,
                        [0xfe_u8, 0x00, 0x81].as_slice(),
                    ],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
    }
    let mut expected: Vec<_> = artifact_ids
        .into_iter()
        .map(|artifact_id| AttachmentArtifactPhysicalKey::Artifact {
            account_id: account.clone(),
            artifact_id,
        })
        .collect();
    expected.extend(chunk_keys.map(|(artifact_id, chunk_index)| {
        AttachmentArtifactPhysicalKey::ArtifactChunk {
            account_id: account.clone(),
            artifact_id: artifact_id.into(),
            chunk_index,
        }
    }));
    expected.push(AttachmentArtifactPhysicalKey::ProvisionalScope {
        account_id: account.clone(),
        operation_id: "pending-op".into(),
        attachment_id: "pending-file".into(),
    });
    expected.push(AttachmentArtifactPhysicalKey::ProvisionalChunk {
        account_id: account,
        operation_id: "pending-op".into(),
        attachment_id: "pending-file".into(),
        generation: writer.generation().into(),
        chunk_index: 0,
    });
    assert_eq!(expected.len(), 140);
    let before = database_bytes(&path);
    let mut cursor = None;
    let mut old_cursor = None;
    let mut observed = Vec::new();

    for (page_index, expected_entries) in expected.chunks(128).enumerate() {
        let response = store
            .invoke(AttachmentArtifactStoreRequest::Inventory {
                cursor: cursor.clone(),
            })
            .await
            .unwrap();
        let repeated = store
            .invoke(AttachmentArtifactStoreRequest::Inventory {
                cursor: cursor.clone(),
            })
            .await
            .unwrap();
        assert!(
            database_bytes(&path) == before,
            "reading or repeating a page must preserve the database and optional WAL"
        );
        assert_eq!(
            repeated, response,
            "the same cursor must replay the exact page"
        );
        let AttachmentArtifactStoreResponse::InventoryPage(page) = response else {
            panic!("inventory must return a physical key page");
        };
        page.validate().unwrap();
        assert_eq!(page.version, 1);
        assert_eq!(
            page.family,
            AttachmentArtifactInventoryFamily::AttachmentArtifacts
        );
        assert_eq!(page.schema, AttachmentArtifactInventorySchema::SqliteV1);
        assert_eq!(page.entries, expected_entries);
        observed.extend(page.entries);
        match (page_index, page.continuation) {
            (0, AttachmentArtifactInventoryContinuation::More { cursor: next }) => {
                old_cursor = Some(next.clone());
                cursor = Some(next);
            }
            (1, AttachmentArtifactInventoryContinuation::End {}) => cursor = None,
            _ => panic!("140 small physical keys require one full page and one final page"),
        }
    }
    assert_eq!(
        observed, expected,
        "traversal must neither omit nor duplicate a key"
    );
    assert!(cursor.is_none());
    let old_cursor = old_cursor.expect("the first page must provide a continuation");
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let decoded: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&old_cursor).unwrap()).unwrap();
    let array = serde_json::json!([decoded["version"], decoded["owner"], decoded["after"]]);
    let malformed = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&array).unwrap());
    let malformed_result = store
        .invoke(AttachmentArtifactStoreRequest::Inventory {
            cursor: Some(malformed),
        })
        .await;
    drop(store);

    let reopened = SqliteAttachmentArtifactStore::open(&path).unwrap();
    let refused = reopened
        .invoke(AttachmentArtifactStoreRequest::Inventory {
            cursor: Some(old_cursor),
        })
        .await;
    let fresh = reopened
        .invoke(AttachmentArtifactStoreRequest::Inventory { cursor: None })
        .await;
    assert!(
        database_bytes(&path) == before,
        "reopen and rejected stale-cursor reads must preserve all physical evidence"
    );
    assert_eq!(
        refused
            .expect_err("a cursor belongs to the previous store instance")
            .code,
        bittery_client_core::RuntimeErrorCode::StorageUnavailable
    );
    let AttachmentArtifactStoreResponse::InventoryPage(fresh) = fresh.unwrap() else {
        panic!("the reopened owner must permit a new inventory pass");
    };
    fresh.validate().unwrap();
    assert_eq!(fresh.entries, expected[..128]);
    assert!(matches!(
        fresh.continuation,
        AttachmentArtifactInventoryContinuation::More { .. }
    ));
    assert!(
        malformed_result.is_err(),
        "a positional array is not the closed inventory cursor object"
    );
}
