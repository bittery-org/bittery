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

#[cfg(not(target_arch = "wasm32"))]
#[tokio::test]
async fn external_host_can_resume_an_exact_durable_generation_without_receiving_a_writer() {
    use bittery_client_core::{
        AccountId, ProvisionalAttachmentArtifactRecovery, ProvisionalAttachmentArtifactScope,
        ProvisionalAttachmentArtifactStore, ProvisionalAttachmentArtifactStoreRequest,
        ProvisionalAttachmentArtifactStoreResponse, ProvisionalAttachmentArtifactWriter,
        SqliteAttachmentArtifactStore,
    };
    use rusqlite::{params, Connection};
    use sha2::{Digest, Sha256};

    let path = std::env::temp_dir().join(format!(
        "bittery-artifact-recovery-api-{}.sqlite3",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let generated = ProvisionalAttachmentArtifactWriter::new(scope.clone());
    let durable_generation = generated.generation().to_owned();
    drop(SqliteAttachmentArtifactStore::open(&path).unwrap());
    let connection = Connection::open(&path).unwrap();
    let ciphertext = b"x";
    let ciphertext_sha256 = format!("{:x}", Sha256::digest(ciphertext));
    connection
        .execute(
            "INSERT INTO attachment_move_provisional_artifacts (
                account_id, operation_id, attachment_id, generation,
                publication_state, ciphertext_sha256, byte_length
             ) VALUES (?1, ?2, ?3, ?4, 1, ?5, 1)",
            params![
                scope.account_id().as_str(),
                scope.operation_id(),
                scope.attachment_id(),
                durable_generation,
                ciphertext_sha256,
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO attachment_move_provisional_chunks (
                account_id, operation_id, attachment_id, generation,
                chunk_index, ciphertext, ciphertext_sha256
             ) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)",
            params![
                scope.account_id().as_str(),
                scope.operation_id(),
                scope.attachment_id(),
                durable_generation,
                ciphertext,
                ciphertext_sha256,
            ],
        )
        .unwrap();
    drop(connection);
    drop(generated);

    let restarted = SqliteAttachmentArtifactStore::open(&path).unwrap();
    let recovery =
        ProvisionalAttachmentArtifactRecovery::new(scope.clone(), durable_generation.clone())
            .unwrap();
    let recovered = match restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered { recovery })
        .await
        .unwrap()
    {
        ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) => owner,
        _ => panic!("exact durable resume returned the wrong response"),
    };
    assert_eq!(recovered.account_id().as_str(), "account-1");
    assert_eq!(recovered.operation_id(), "operation-1");
    assert_eq!(recovered.attachment_id(), "attachment-1");

    assert!(ProvisionalAttachmentArtifactRecovery::new(
        scope.clone(),
        "not-a-canonical-generation",
    )
    .is_err());
    let random = ProvisionalAttachmentArtifactWriter::new(scope.clone());
    let random_recovery =
        ProvisionalAttachmentArtifactRecovery::new(scope.clone(), random.generation().to_owned())
            .unwrap();
    assert!(restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered {
            recovery: random_recovery,
        })
        .await
        .is_err());
    let wrong_scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-other",
        "attachment-1",
    )
    .unwrap();
    let wrong_scope_recovery =
        ProvisionalAttachmentArtifactRecovery::new(wrong_scope, durable_generation).unwrap();
    assert!(restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered {
            recovery: wrong_scope_recovery,
        })
        .await
        .is_err());

    let unauthenticated_scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-writing",
        "attachment-1",
    )
    .unwrap();
    let unauthenticated = ProvisionalAttachmentArtifactWriter::new(unauthenticated_scope.clone());
    let begun = restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
            writer: unauthenticated,
        })
        .await
        .unwrap();
    let unauthenticated = match begun {
        ProvisionalAttachmentArtifactStoreResponse::Begun(writer) => writer,
        _ => panic!("begin returned the wrong response"),
    };
    let unauthenticated_recovery = ProvisionalAttachmentArtifactRecovery::new(
        unauthenticated_scope,
        unauthenticated.generation().to_owned(),
    )
    .unwrap();
    assert!(restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered {
            recovery: unauthenticated_recovery,
        })
        .await
        .is_err());

    drop(restarted);
    let _ = std::fs::remove_file(path);
}

#[cfg(not(target_arch = "wasm32"))]
#[tokio::test]
async fn raw_recovery_input_never_exposes_a_writer_before_state1_or_state2_validation() {
    use bittery_client_core::{
        AccountId, ProvisionalAttachmentArtifactRecovery, ProvisionalAttachmentArtifactScope,
        ProvisionalAttachmentArtifactStore, ProvisionalAttachmentArtifactStoreRequest,
        ProvisionalAttachmentArtifactWriter, SqliteAttachmentArtifactStore,
    };

    let path = std::env::temp_dir().join(format!(
        "bittery-artifact-recovery-capability-api-{}.sqlite3",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-writing",
        "attachment-1",
    )
    .unwrap();
    let store = SqliteAttachmentArtifactStore::open(&path).unwrap();
    let state0 = ProvisionalAttachmentArtifactWriter::new(scope.clone());
    store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
            writer: state0.clone(),
        })
        .await
        .unwrap();
    let recovery =
        ProvisionalAttachmentArtifactRecovery::new(scope, state0.generation().to_owned()).unwrap();

    assert!(store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered { recovery })
        .await
        .is_err());

    drop(store);
    let _ = std::fs::remove_file(path);
}
