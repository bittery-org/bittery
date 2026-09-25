#![cfg(not(target_arch = "wasm32"))]

use bittery_client_core::{
    RuntimeErrorCode, SerializedReplicaExecutor, SqliteAttachmentArtifactStore, SqliteReplica,
    SqliteVaultImageArtifactStore,
};
use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "bittery-profile-inventory-{}",
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
async fn inventory_refuses_unknown_table_resembling_sqlite_prefix_without_writes() {
    let directory = TestDirectory::new();
    let path = directory.0.join("replica.sqlite");
    let replica = SqliteReplica::open(&path).unwrap();
    {
        let raw = rusqlite::Connection::open(&path).unwrap();
        // This is a legal user table, not an object with SQLite's reserved `sqlite_` prefix.
        raw.execute_batch("CREATE TABLE sqliteXforeign (payload BLOB NOT NULL);")
            .unwrap();
        raw.execute(
            "INSERT INTO sqliteXforeign (payload) VALUES (?1)",
            [b"unexplained-retained-evidence".as_slice()],
        )
        .unwrap();
    }
    let before = database_bytes(&path);

    let result = replica
        .invoke(r#"{"type":"inventory","cursor":null}"#.into())
        .await;

    assert!(
        database_bytes(&path) == before,
        "a physical inventory must leave the database and optional WAL unchanged"
    );
    let error = result.expect_err("an unknown user table cannot be reported as an empty Replica");
    assert_eq!(error.code, RuntimeErrorCode::StorageUnavailable);
}

#[test]
fn native_owners_refuse_unversioned_unknown_table_without_adopting_or_writing() {
    for (owner, error_code) in [
        ("replica", RuntimeErrorCode::StorageUnavailable),
        ("attachment", RuntimeErrorCode::InvariantViolation),
        ("vault-image", RuntimeErrorCode::StorageUnavailable),
    ] {
        let directory = TestDirectory::new();
        let path = directory.0.join("unversioned.sqlite");
        {
            let raw = rusqlite::Connection::open(&path).unwrap();
            raw.execute_batch("CREATE TABLE sqliteXforeign (payload BLOB NOT NULL);")
                .unwrap();
            raw.execute(
                "INSERT INTO sqliteXforeign (payload) VALUES (?1)",
                [b"unversioned-retained-evidence".as_slice()],
            )
            .unwrap();
        }
        let before = database_bytes(&path);

        let result = match owner {
            "replica" => SqliteReplica::open(&path).map(drop),
            "attachment" => SqliteAttachmentArtifactStore::open(&path).map(drop),
            "vault-image" => SqliteVaultImageArtifactStore::open(&path).map(drop),
            _ => unreachable!(),
        };

        assert!(
            database_bytes(&path) == before,
            "{owner} must preserve the unversioned database and optional WAL"
        );
        let error = result.expect_err("an unknown schema cannot be adopted as an empty database");
        assert_eq!(error.code, error_code, "{owner}");
    }
}

#[test]
fn replica_open_refuses_view_only_unversioned_database_without_writes() {
    let directory = TestDirectory::new();
    let path = directory.0.join("view-only.sqlite");
    {
        let raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute_batch("CREATE VIEW foreign_view AS SELECT 'retained' AS payload;")
            .unwrap();
    }
    let before = database_bytes(&path);

    let result = SqliteReplica::open(&path).map(drop);

    assert!(
        database_bytes(&path) == before,
        "Replica open must preserve the foreign view, database stamps, and optional WAL"
    );
    let error = result.expect_err("a view-only database is not an empty Replica destination");
    assert_eq!(error.code, RuntimeErrorCode::StorageUnavailable);
}

#[tokio::test]
async fn replica_inventory_requires_an_object_cursor_and_preserves_orphan_rows() {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let directory = TestDirectory::new();
    let path = directory.0.join("paged-replica.sqlite");
    let replica = SqliteReplica::open(&path).unwrap();
    {
        let mut raw = rusqlite::Connection::open(&path).unwrap();
        raw.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        let transaction = raw.transaction().unwrap();
        for index in 0..129 {
            transaction.execute(
                "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES ('orphan-account', 9, ?1, 'opaque-evidence')",
                [format!("retained-{index:03}")],
            ).unwrap();
        }
        transaction.commit().unwrap();
    }
    let before = database_bytes(&path);
    let first: serde_json::Value = serde_json::from_str(
        &replica
            .invoke(r#"{"type":"inventory","cursor":null}"#.into())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(first["entries"].as_array().unwrap().len(), 128);
    let cursor = first["continuation"]["cursor"].as_str().unwrap();
    let second: serde_json::Value = serde_json::from_str(
        &replica
            .invoke(serde_json::json!({"type":"inventory", "cursor":cursor}).to_string())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(second["entries"].as_array().unwrap().len(), 1);
    assert_eq!(second["entries"][0]["recordId"], "retained-128");
    assert_eq!(second["continuation"]["type"], "end");
    let replayed: serde_json::Value = serde_json::from_str(
        &replica
            .invoke(serde_json::json!({"type":"inventory", "cursor":cursor}).to_string())
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(replayed, second);
    let decoded: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(cursor).unwrap()).unwrap();
    let array = serde_json::json!([decoded["version"], decoded["owner"], decoded["after"]]);
    let malformed = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&array).unwrap());
    let result = replica
        .invoke(serde_json::json!({"type":"inventory", "cursor":malformed}).to_string())
        .await;
    assert!(
        database_bytes(&path) == before,
        "all inventory requests must preserve orphan evidence"
    );
    assert!(
        result.is_err(),
        "a positional array is not the closed inventory cursor object"
    );
    drop(replica);
    let reopened = SqliteReplica::open(&path).unwrap();
    let stale = reopened
        .invoke(serde_json::json!({"type":"inventory", "cursor":cursor}).to_string())
        .await;
    assert!(stale.is_err(), "a cursor cannot survive Replica owner loss");
    assert!(database_bytes(&path) == before);
}

#[tokio::test]
async fn replica_open_adopts_known_unversioned_layout_without_changing_orphan_evidence() {
    for application_id in [0_i32, 1_112_822_361] {
        let directory = TestDirectory::new();
        let path = directory.0.join("known-unversioned.sqlite");
        let replica = SqliteReplica::open(&path).unwrap();
        {
            let raw = rusqlite::Connection::open(&path).unwrap();
            raw.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
            raw.execute(
                "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES (?1, 9, ?2, ?3)",
                ["orphan-account", "retained-capability", "original-opaque-evidence"],
            )
            .unwrap();
        }
        let load = r#"{"type":"load","accountId":"orphan-account"}"#;
        let before = replica.invoke(load.into()).await.unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&before).unwrap(),
            serde_json::json!({
                "type": "loaded",
                "head": null,
                "rows": [{
                    "store": "shareCapabilities",
                    "key": { "accountId": "orphan-account", "recordId": "retained-capability" },
                    "payloadJson": "original-opaque-evidence"
                }]
            })
        );
        drop(replica);
        {
            let raw = rusqlite::Connection::open(&path).unwrap();
            raw.pragma_update(None, "application_id", application_id)
                .unwrap();
            raw.pragma_update(None, "user_version", 0).unwrap();
        }

        let reopened = SqliteReplica::open(&path).unwrap();

        assert_eq!(
            reopened.invoke(load.into()).await.unwrap(),
            before,
            "known-layout adoption with application_id {application_id} must retain the exact orphan row"
        );
    }
}
