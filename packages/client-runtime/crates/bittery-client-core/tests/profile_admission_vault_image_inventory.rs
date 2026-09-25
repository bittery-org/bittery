#![cfg(not(target_arch = "wasm32"))]

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bittery_client_core::{
    AccountId, SqliteVaultImageArtifactStore, VaultImageArtifactPort, VaultImageArtifactScope,
    VaultImageChunkWrite, VaultImageInventoryContinuation, VaultImageInventoryFamily,
    VaultImageInventoryPage, VaultImageInventorySchema, VaultImagePhysicalKey,
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
            "bittery-profile-image-inventory-{}",
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
async fn inventory_preserves_raw_protected_and_orphan_physical_keys_without_account_authority() {
    let directory = TestDirectory::new();
    let path = directory.0.join("vault-images.sqlite");
    let store = SqliteVaultImageArtifactStore::open(&path).unwrap();
    // No Account, Replica, or catalog is installed. Both unpublished generations are
    // legitimate partial store writes; the census does not confer publication authority.
    let account = AccountId::from("uninstalled-image-account");
    let raw = VaultImageArtifactScope::new(account.clone(), "unowned-image-operation").unwrap();
    let protected = raw.for_publication("protected-sibling").unwrap();
    for (scope, bytes) in [
        (&raw, [0xff, 0x00, 0x81, 0x7e]),
        (&protected, [0xfe, 0x00, 0x82, 0x7d]),
    ] {
        store.begin(scope).await.unwrap();
        assert_eq!(
            store.write_chunk(scope, 0, &bytes).await.unwrap(),
            VaultImageChunkWrite::Stored
        );
    }
    {
        let orphan = Connection::open(&path).unwrap();
        // A chunk without its metadata cannot be made by a valid writer. Inject only
        // this physical damage; inventory must not join it away or read its payload.
        orphan.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
        orphan
            .execute(
                "INSERT INTO vault_image_artifact_chunks (
                    account_id, operation_id, publication_id, chunk_index, plaintext
                 ) VALUES (?1, ?2, 'orphan-publication', 7, ?3)",
                params![
                    account.as_str(),
                    raw.operation_id(),
                    [0xfd_u8, 0x00, 0x83, 0x7c].as_slice(),
                ],
            )
            .unwrap();
    }
    let before = database_bytes(&path);

    let result = store.inventory_page(None).await;

    assert!(
        database_bytes(&path) == before,
        "inventory must leave all database and optional WAL bytes unchanged"
    );
    let page = result.unwrap();
    page.validate().unwrap();
    assert_eq!(
        page,
        VaultImageInventoryPage {
            version: 1,
            family: VaultImageInventoryFamily::VaultImages,
            schema: VaultImageInventorySchema::SqliteV1,
            entries: vec![
                VaultImagePhysicalKey::Metadata {
                    account_id: account.clone(),
                    operation_id: "unowned-image-operation".into(),
                    publication_id: "".into(),
                },
                VaultImagePhysicalKey::Metadata {
                    account_id: account.clone(),
                    operation_id: "unowned-image-operation".into(),
                    publication_id: "protected-sibling".into(),
                },
                VaultImagePhysicalKey::Chunk {
                    account_id: account.clone(),
                    operation_id: "unowned-image-operation".into(),
                    publication_id: "".into(),
                    chunk_index: 0,
                },
                VaultImagePhysicalKey::Chunk {
                    account_id: account.clone(),
                    operation_id: "unowned-image-operation".into(),
                    publication_id: "orphan-publication".into(),
                    chunk_index: 7,
                },
                VaultImagePhysicalKey::Chunk {
                    account_id: account,
                    operation_id: "unowned-image-operation".into(),
                    publication_id: "protected-sibling".into(),
                    chunk_index: 0,
                },
            ],
            continuation: VaultImageInventoryContinuation::End {},
        }
    );

    // The native port is typed; measure the public page in the specified flat JSON
    // control envelope, retaining the empty raw publication component explicitly.
    let mut control = serde_json::to_value(&page).unwrap();
    control.as_object_mut().unwrap().insert(
        "type".into(),
        serde_json::Value::String("inventoryPage".into()),
    );
    assert_eq!(control["entries"][0]["publicationId"], "");
    assert_eq!(control["entries"][2]["publicationId"], "");
    let encoded = serde_json::to_string(&control).unwrap();
    assert!(encoded.len() <= 262_144);
    assert!(!encoded.contains("plaintext"));
    assert!(!encoded.contains("bytes"));
    assert!(!encoded.contains("protection"));
    assert!(!encoded.contains("published"));
    assert!(!encoded.contains("sha256"));
}

#[tokio::test]
async fn inventory_pages_raw_and_protected_keys_and_rejects_nonobject_or_retired_cursors() {
    let directory = TestDirectory::new();
    let path = directory.0.join("paged-vault-images.sqlite");
    let store = SqliteVaultImageArtifactStore::open(&path).unwrap();
    let account = AccountId::from("uninstalled-paged-images");
    let mut operations: Vec<String> = (0..129).map(|index| format!("image-{index:03}")).collect();
    for operation in operations.iter().rev() {
        let scope = VaultImageArtifactScope::new(account.clone(), operation).unwrap();
        store.begin(&scope).await.unwrap();
    }
    // Physical census must retain even keys that ordinary domain construction rejects.
    {
        let raw = Connection::open(&path).unwrap();
        for operation in ["\u{10000}", "\u{e000}"] {
            raw.execute(
                "INSERT INTO vault_image_artifacts (account_id, operation_id, publication_id) VALUES (?1, ?2, '')",
                params![account.as_str(), operation],
            ).unwrap();
        }
    }
    operations.extend(["\u{e000}", "\u{10000}"].map(str::to_owned));
    let raw = VaultImageArtifactScope::new(account.clone(), "image-000").unwrap();
    let protected = raw.for_publication("protected").unwrap();
    store.begin(&protected).await.unwrap();
    for scope in [&raw, &protected] {
        store
            .write_chunk(scope, 0, &[0xfe, 0x00, 0x81])
            .await
            .unwrap();
    }
    let mut expected = Vec::new();
    for operation in operations {
        expected.push(VaultImagePhysicalKey::Metadata {
            account_id: account.clone(),
            operation_id: operation.clone(),
            publication_id: "".into(),
        });
        if operation == "image-000" {
            expected.push(VaultImagePhysicalKey::Metadata {
                account_id: account.clone(),
                operation_id: operation,
                publication_id: "protected".into(),
            });
        }
    }
    expected.extend(
        ["", "protected"].map(|publication| VaultImagePhysicalKey::Chunk {
            account_id: account.clone(),
            operation_id: "image-000".into(),
            publication_id: publication.into(),
            chunk_index: 0,
        }),
    );
    let before = database_bytes(&path);
    let first = store.inventory_page(None).await.unwrap();
    first.validate().unwrap();
    assert_eq!(first.entries, expected[..128]);
    assert_eq!(store.inventory_page(None).await.unwrap(), first);
    let VaultImageInventoryContinuation::More { cursor } = first.continuation else {
        panic!("a nonempty continuation must preserve every remaining physical image key");
    };
    let second = store.inventory_page(Some(&cursor)).await.unwrap();
    second.validate().unwrap();
    assert_eq!(second.entries, expected[128..]);
    assert_eq!(second.continuation, VaultImageInventoryContinuation::End {});
    assert_eq!(store.inventory_page(Some(&cursor)).await.unwrap(), second);

    // Serde accepts positional struct arrays unless the cursor decoder insists on an object.
    // The cursor is opaque authority scoped to a live physical owner, with one closed shape.
    let decoded: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(&cursor).unwrap()).unwrap();
    let array = serde_json::json!([decoded["version"], decoded["owner"], decoded["after"]]);
    let malformed = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&array).unwrap());
    let malformed_result = store.inventory_page(Some(&malformed)).await;
    assert!(
        database_bytes(&path) == before,
        "paging and rejected cursors must preserve physical evidence"
    );
    drop(store);
    let reopened = SqliteVaultImageArtifactStore::open(&path).unwrap();
    assert!(
        reopened.inventory_page(Some(&cursor)).await.is_err(),
        "a cursor cannot survive owner loss"
    );
    assert!(
        malformed_result.is_err(),
        "a positional array is not the closed inventory cursor object"
    );
}
