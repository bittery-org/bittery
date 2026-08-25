#[cfg(not(target_arch = "wasm32"))]
#[test]
fn native_host_can_select_an_artifact_database_and_share_rust_chunk_policy() {
    use bittery_client_core::{SqliteAttachmentArtifactStore, ARTIFACT_CHUNK_BYTES};

    let path = std::env::temp_dir().join(format!(
        "bittery-artifact-store-api-{}.sqlite3",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let store = SqliteAttachmentArtifactStore::open(&path).unwrap();

    assert_eq!(ARTIFACT_CHUNK_BYTES, 256 * 1024);
    drop(store);
    let _ = std::fs::remove_file(path);
}
