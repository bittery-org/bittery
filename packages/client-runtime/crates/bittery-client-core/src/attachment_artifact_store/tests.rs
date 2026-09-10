use super::{
    ArtifactChunkWrite, ArtifactPublication, AttachmentArtifactOwner, ExclusiveStartupBoundary,
    ProvisionalAttachmentArtifactRecovery, ProvisionalAttachmentArtifactScope,
    ProvisionalAttachmentArtifactStore, ProvisionalAttachmentArtifactStoreRequest,
    ProvisionalAttachmentArtifactStoreResponse, ProvisionalAttachmentArtifactWriter,
    SqliteAttachmentArtifactStore, SqliteFailureOperation, ARTIFACT_CHUNK_BYTES,
};
use crate::{replica::attachment_move_artifact_ref, AccountId};
use bittery_crypto_core::{
    attachment_move::{AttachmentBlobScope, AttachmentEnvelopeScanner, AttachmentMoveTranscryptor},
    attachment_move::{AttachmentPublicationIdentity, AttachmentPublicationProof},
    encrypt_with_aad, AadContext,
};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::{Arc, Barrier},
};

struct TestDatabase(PathBuf);

impl TestDatabase {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "bittery-attachment-artifacts-{name}-{}.sqlite3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        Self(path)
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn owner(
    account: &str,
    operation: &str,
    attachment: &str,
    bytes: &[u8],
) -> AttachmentArtifactOwner {
    let account_id = AccountId::from(account);
    let digest = format!("{:x}", Sha256::digest(bytes));
    let artifact = attachment_move_artifact_ref(
        &account_id,
        operation,
        attachment,
        &digest,
        bytes.len() as u64,
    )
    .unwrap();
    AttachmentArtifactOwner::new(account_id, operation, attachment, artifact).unwrap()
}

fn chunks(bytes: &[u8]) -> impl Iterator<Item = (u32, &[u8])> {
    bytes
        .chunks(ARTIFACT_CHUNK_BYTES)
        .enumerate()
        .map(|(index, chunk)| (index as u32, chunk))
}

fn seed_orphan_artifact_rows(path: &PathBuf, account_id: &str) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch("PRAGMA foreign_keys = OFF;")
        .unwrap();
    connection
        .execute(
            "INSERT INTO attachment_move_artifacts (
                account_id, artifact_id, operation_id, attachment_id,
                ciphertext_sha256, byte_length, chunk_count, publication_state
             ) VALUES (?1, 'orphan-artifact', 'operation', 'attachment', ?2, 1, 1, 2)",
            params![account_id, "00".repeat(32)],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO attachment_move_artifact_chunks (
                account_id, artifact_id, chunk_index, ciphertext, ciphertext_sha256
             ) VALUES (?1, 'missing-artifact', 0, X'01', ?2)",
            params![account_id, "00".repeat(32)],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO attachment_move_provisional_artifacts (
                account_id, operation_id, attachment_id, generation, publication_state
             ) VALUES (?1, 'orphan-operation', 'orphan-attachment', ?2, 0)",
            params![account_id, "9f20db4b-2cf0-4b73-a2a4-ad93c3615c4d"],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO attachment_move_provisional_chunks (
                account_id, operation_id, attachment_id, generation,
                chunk_index, ciphertext, ciphertext_sha256
             ) VALUES (?1, 'missing-operation', 'missing-attachment', ?2, 0, X'01', ?3)",
            params![
                account_id,
                "9f20db4b-2cf0-4b73-a2a4-ad93c3615c4d",
                "00".repeat(32)
            ],
        )
        .unwrap();
}

fn artifact_row_counts(path: &PathBuf, account_id: &str) -> [i64; 4] {
    let connection = Connection::open(path).unwrap();
    [
        "attachment_move_provisional_chunks",
        "attachment_move_artifact_chunks",
        "attachment_move_provisional_artifacts",
        "attachment_move_artifacts",
    ]
    .map(|table| {
        connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE account_id = ?1"),
                params![account_id],
                |row| row.get(0),
            )
            .unwrap()
    })
}

fn authenticated_target(plaintext: &str) -> (Vec<u8>, AttachmentPublicationProof) {
    authenticated_target_for(
        plaintext,
        "account-1",
        "user-1",
        "operation-1",
        "attachment-1",
    )
}

fn authenticated_target_for(
    plaintext: &str,
    account_id: &str,
    user_id: &str,
    operation_id: &str,
    attachment_id: &str,
) -> (Vec<u8>, AttachmentPublicationProof) {
    let source_key = [31_u8; 32];
    let target_key = [47_u8; 32];
    let source_context = AadContext {
        vault_id: "vault-source".into(),
        entity_id: attachment_id.into(),
        entity_type: "attachment_blob".into(),
        version: 1,
        user_id: user_id.into(),
    };
    let source =
        serde_json::to_vec(&encrypt_with_aad(plaintext, &source_key, &source_context).unwrap())
            .unwrap();
    let mut scanner = AttachmentEnvelopeScanner::new();
    for chunk in source.chunks(8_191) {
        scanner.push(chunk).unwrap();
    }
    let mut transcryptor = AttachmentMoveTranscryptor::new(
        scanner.finish().unwrap(),
        source_key,
        AttachmentBlobScope::new("vault-source".into(), attachment_id.into(), user_id.into()),
        target_key,
        AttachmentBlobScope::new("vault-target".into(), attachment_id.into(), user_id.into()),
        AttachmentPublicationIdentity::new(
            account_id.into(),
            user_id.into(),
            operation_id.into(),
            attachment_id.into(),
        )
        .unwrap(),
    )
    .unwrap();
    let mut target = Vec::new();
    for chunk in source.chunks(7_919) {
        target.extend(transcryptor.push(chunk).unwrap());
    }
    let finished = transcryptor.finish().unwrap();
    target.extend(finished.final_chunk);
    (target, finished.publication_proof)
}

#[test]
fn native_sqlite_begins_an_account_operation_attachment_bound_provisional_writer() {
    let database = TestDatabase::new("provisional-begin");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();

    let writer = store.begin_provisional(&scope).unwrap();

    assert_eq!(writer.account_id(), &AccountId::from("account-1"));
    assert_eq!(writer.operation_id(), "operation-1");
    assert_eq!(writer.attachment_id(), "attachment-1");
}

#[tokio::test]
async fn rust_owned_exact_begin_replay_preserves_already_durable_chunks() {
    let database = TestDatabase::new("provisional-begin-replay");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let writer = ProvisionalAttachmentArtifactWriter::new(scope);
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert_eq!(
        store
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
                writer: writer.clone(),
            })
            .await
            .unwrap(),
        ProvisionalAttachmentArtifactStoreResponse::Begun(writer.clone())
    );
    store
        .write_provisional_chunk(&writer, 0, b"ciphertext")
        .unwrap();

    store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
            writer: writer.clone(),
        })
        .await
        .unwrap();

    assert_eq!(
        store
            .write_provisional_chunk(&writer, 0, b"ciphertext")
            .unwrap(),
        ArtifactChunkWrite::AlreadyStored
    );
}

#[test]
fn authenticated_provisional_ciphertext_becomes_canonical_in_one_final_transition() {
    let database = TestDatabase::new("provisional-finalize");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let (bytes, publication) = authenticated_target(&"ciphertext payload ".repeat(20_000));
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let writer = store.begin_provisional(&scope).unwrap();
    for (index, chunk) in chunks(&bytes) {
        assert_eq!(
            store
                .write_provisional_chunk(&writer, index, chunk)
                .unwrap(),
            ArtifactChunkWrite::Stored
        );
    }

    let owner = store.finalize_provisional(&writer, publication).unwrap();

    let mut restored_bytes = Vec::new();
    for index in 0..=((bytes.len() - 1) / ARTIFACT_CHUNK_BYTES) as u32 {
        restored_bytes.extend(store.read_chunk(&owner, index).unwrap().bytes);
    }
    assert_eq!(restored_bytes, bytes);
    drop(store);
    let restarted = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert_eq!(
        restarted.resume_provisional_finalization(&writer).unwrap(),
        owner
    );
}

#[test]
fn final_publication_maps_one_physical_generation_without_copying_unbounded_blobs() {
    let database = TestDatabase::new("provisional-stable-physical-generation");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let (bytes, publication) = authenticated_target(&"large ciphertext ".repeat(40_000));
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let writer = store.begin_provisional(&scope).unwrap();
    for (index, chunk) in chunks(&bytes) {
        store
            .write_provisional_chunk(&writer, index, chunk)
            .unwrap();
    }
    store.finalize_provisional(&writer, publication).unwrap();
    drop(store);

    let connection = Connection::open(&database.0).unwrap();
    let copied_chunks: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM attachment_move_artifact_chunks WHERE account_id = ?1",
            params!["account-1"],
            |row| row.get(0),
        )
        .unwrap();
    let physical_chunks: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM attachment_move_provisional_chunks WHERE account_id = ?1",
            params!["account-1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(copied_chunks, 0);
    assert_eq!(physical_chunks, chunks(&bytes).count() as i64);
}

#[tokio::test]
async fn a_redo_can_publish_a_new_nonce_while_the_unreferenced_prior_artifact_awaits_sweep() {
    let database = TestDatabase::new("provisional-redo-before-sweep");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let (first_bytes, first_publication) = authenticated_target("same plaintext");
    let first_writer = store.begin_provisional(&scope).unwrap();
    store
        .write_provisional_chunk(&first_writer, 0, &first_bytes)
        .unwrap();
    let first = store
        .finalize_provisional(&first_writer, first_publication)
        .unwrap();

    let (second_bytes, second_publication) = authenticated_target("same plaintext");
    let second_writer = store.begin_provisional(&scope).unwrap();
    store
        .write_provisional_chunk(&second_writer, 0, &second_bytes)
        .unwrap();
    let second = store
        .finalize_provisional(&second_writer, second_publication)
        .unwrap();

    assert_ne!(first.artifact_id(), second.artifact_id());
    assert_eq!(store.read_chunk(&first, 0).unwrap().bytes, first_bytes);
    assert_eq!(store.read_chunk(&second, 0).unwrap().bytes, second_bytes);
    assert_eq!(
        store
            .resume_provisional_finalization(&first_writer)
            .unwrap(),
        first
    );
    assert_eq!(
        store
            .resume_provisional_finalization(&second_writer)
            .unwrap(),
        second
    );
    let first_generation = first_writer.generation().to_owned();
    drop(first_writer);
    let recovered_first =
        ProvisionalAttachmentArtifactRecovery::new(scope.clone(), first_generation).unwrap();
    let recovered_owner = match store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered {
            recovery: recovered_first.clone(),
        })
        .await
        .unwrap()
    {
        ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) => owner,
        _ => panic!("mapped state-2 recovery returned the wrong response"),
    };
    assert_eq!(recovered_owner, first);
    store
        .sweep_orphans(
            ExclusiveStartupBoundary::proven_by_runtime_startup(),
            &AccountId::from("account-1"),
            std::slice::from_ref(&second),
        )
        .unwrap();
    let stale_request = ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered {
        recovery: recovered_first,
    };
    assert!(store.invoke_provisional(stale_request).await.is_err());
}

#[test]
fn a_new_provisional_generation_fences_every_delayed_old_writer_action() {
    let database = TestDatabase::new("provisional-generation-fence");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let (old_bytes, old_publication) = authenticated_target("old target");
    let (new_bytes, new_publication) = authenticated_target("new target");
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let old_writer = store.begin_provisional(&scope).unwrap();
    store
        .write_provisional_chunk(&old_writer, 0, &old_bytes)
        .unwrap();

    let new_writer = store.begin_provisional(&scope).unwrap();

    assert!(store
        .write_provisional_chunk(&old_writer, 0, &old_bytes)
        .is_err());
    assert!(store
        .finalize_provisional(&old_writer, old_publication)
        .is_err());
    assert!(store.resume_provisional_finalization(&old_writer).is_err());
    store
        .write_provisional_chunk(&new_writer, 0, &new_bytes)
        .unwrap();
    let owner = store
        .finalize_provisional(&new_writer, new_publication)
        .unwrap();
    assert_eq!(store.read_chunk(&owner, 0).unwrap().bytes, new_bytes);
}

#[test]
fn provisional_writes_are_bounded_idempotent_and_conflict_closed() {
    let database = TestDatabase::new("provisional-write-contract");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let writer = store.begin_provisional(&scope).unwrap();
    let bytes = vec![7_u8; ARTIFACT_CHUNK_BYTES];
    assert!(store
        .write_provisional_chunk(&writer, 0, &vec![1_u8; ARTIFACT_CHUNK_BYTES + 1])
        .is_err());
    assert!(store.write_provisional_chunk(&writer, 0, &[]).is_err());
    assert_eq!(
        store.write_provisional_chunk(&writer, 0, &bytes).unwrap(),
        ArtifactChunkWrite::Stored
    );
    assert_eq!(
        store.write_provisional_chunk(&writer, 0, &bytes).unwrap(),
        ArtifactChunkWrite::AlreadyStored
    );
    assert!(store
        .write_provisional_chunk(&writer, 0, &vec![8_u8; ARTIFACT_CHUNK_BYTES])
        .is_err());
}

#[test]
fn only_an_authenticated_exact_complete_generation_can_become_readable() {
    let database = TestDatabase::new("provisional-invalid-finalization");
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();

    let missing_scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-missing",
        "attachment-1",
    )
    .unwrap();
    let (bytes, publication) = authenticated_target_for(
        &"missing chunk ".repeat(30_000),
        "account-1",
        "user-1",
        "operation-missing",
        "attachment-1",
    );
    let missing_writer = store.begin_provisional(&missing_scope).unwrap();
    store
        .write_provisional_chunk(&missing_writer, 0, &bytes[..ARTIFACT_CHUNK_BYTES])
        .unwrap();
    assert!(store
        .finalize_provisional(&missing_writer, publication)
        .is_err());
    assert!(store
        .resume_provisional_finalization(&missing_writer)
        .is_err());

    let digest_scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-digest",
        "attachment-1",
    )
    .unwrap();
    let (digest_bytes, _) = authenticated_target_for(
        "digest mismatch",
        "account-1",
        "user-1",
        "operation-digest",
        "attachment-1",
    );
    let (_, wrong) = authenticated_target_for(
        "another payload",
        "account-1",
        "user-1",
        "operation-digest",
        "attachment-1",
    );
    let writer = store.begin_provisional(&digest_scope).unwrap();
    store
        .write_provisional_chunk(&writer, 0, &digest_bytes)
        .unwrap();
    assert!(store.finalize_provisional(&writer, wrong).is_err());
    let wrong_owner = owner(
        "account-1",
        "operation-digest",
        "attachment-1",
        &vec![0_u8; digest_bytes.len()],
    );
    assert!(store.read_chunk(&wrong_owner, 0).is_err());
}

#[test]
fn publication_proof_cannot_cross_account_operation_or_attachment_scope() {
    let database = TestDatabase::new("provisional-proof-scope");
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let cases = [
        (
            "writer-account",
            "attachment-1",
            "account-2",
            "writer-account",
            "attachment-1",
        ),
        (
            "writer-operation",
            "attachment-1",
            "account-1",
            "other-operation",
            "attachment-1",
        ),
        (
            "writer-attachment",
            "attachment-1",
            "account-1",
            "writer-attachment",
            "attachment-2",
        ),
    ];
    for (writer_operation, writer_attachment, proof_account, proof_operation, proof_attachment) in
        cases
    {
        let scope = ProvisionalAttachmentArtifactScope::new(
            AccountId::from("account-1"),
            writer_operation,
            writer_attachment,
        )
        .unwrap();
        let (bytes, proof) = authenticated_target_for(
            "scope-bound ciphertext",
            proof_account,
            "user-1",
            proof_operation,
            proof_attachment,
        );
        let writer = store.begin_provisional(&scope).unwrap();
        store.write_provisional_chunk(&writer, 0, &bytes).unwrap();

        assert!(store.finalize_provisional(&writer, proof).is_err());
        assert!(store.resume_provisional_finalization(&writer).is_err());
    }
}

#[test]
fn authenticated_seal_and_every_final_transition_boundary_resume_after_restart() {
    let database = TestDatabase::new("provisional-finalize-restart");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let (bytes, publication) = authenticated_target(&"restart target ".repeat(20_000));
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let writer = store.begin_provisional(&scope).unwrap();
    for (index, chunk) in chunks(&bytes) {
        store
            .write_provisional_chunk(&writer, index, chunk)
            .unwrap();
    }
    drop(store);

    let interrupted = SqliteAttachmentArtifactStore::open_failing_after(
        &database.0,
        SqliteFailureOperation::VerifyProvisional,
        1,
    )
    .unwrap();
    assert!(interrupted
        .finalize_provisional(&writer, publication)
        .is_err());
    drop(interrupted);
    for boundary in 1..=2 {
        let interrupted = SqliteAttachmentArtifactStore::open_failing_after(
            &database.0,
            SqliteFailureOperation::FinalizeProvisional,
            boundary,
        )
        .unwrap();
        assert!(interrupted
            .resume_provisional_finalization(&writer)
            .is_err());
    }
    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let owner = restored.resume_provisional_finalization(&writer).unwrap();
    assert_eq!(
        restored.read_chunk(&owner, 0).unwrap().bytes,
        bytes[..ARTIFACT_CHUNK_BYTES]
    );
}

#[tokio::test]
async fn process_restart_recovers_an_authenticated_seal_by_scope_without_retained_caller_state() {
    let database = TestDatabase::new("provisional-process-restart-recovery");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let (bytes, publication) = authenticated_target("recover after process restart");
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let writer = store.begin_provisional(&scope).unwrap();
    store.write_provisional_chunk(&writer, 0, &bytes).unwrap();
    drop(store);
    let interrupted = SqliteAttachmentArtifactStore::open_failing_after(
        &database.0,
        SqliteFailureOperation::VerifyProvisional,
        1,
    )
    .unwrap();
    assert!(interrupted
        .finalize_provisional(&writer, publication)
        .is_err());
    drop(interrupted);
    let durable_generation = writer.generation().to_owned();
    drop(writer);

    let restarted = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let recovered_by_begin = match restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
            writer: ProvisionalAttachmentArtifactWriter::new(scope.clone()),
        })
        .await
        .unwrap()
    {
        ProvisionalAttachmentArtifactStoreResponse::RecoveryAvailable(recovery) => recovery,
        _ => panic!("Begin returned the wrong closed response"),
    };
    let recovered =
        ProvisionalAttachmentArtifactRecovery::new(scope.clone(), durable_generation).unwrap();
    assert_eq!(recovered_by_begin, recovered);
    let owner = match restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered {
            recovery: recovered,
        })
        .await
        .unwrap()
    {
        ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) => owner,
        _ => panic!("ResumeRecovered returned the wrong closed response"),
    };

    assert_eq!(restarted.read_chunk(&owner, 0).unwrap().bytes, bytes);
}

#[tokio::test]
async fn process_restart_recovers_after_the_atomic_final_transition_loses_its_response() {
    let database = TestDatabase::new("provisional-final-transition-recovery");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-final",
        "attachment-1",
    )
    .unwrap();
    let (bytes, publication) = authenticated_target_for(
        "recover final transition",
        "account-1",
        "user-1",
        "operation-final",
        "attachment-1",
    );
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let writer = store.begin_provisional(&scope).unwrap();
    store.write_provisional_chunk(&writer, 0, &bytes).unwrap();
    drop(store);
    let interrupted = SqliteAttachmentArtifactStore::open_failing_after(
        &database.0,
        SqliteFailureOperation::FinalizeProvisional,
        1,
    )
    .unwrap();
    assert!(interrupted
        .finalize_provisional(&writer, publication)
        .is_err());
    drop(interrupted);
    drop(writer);

    let restarted = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let recovered = match restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
            writer: ProvisionalAttachmentArtifactWriter::new(scope.clone()),
        })
        .await
        .unwrap()
    {
        ProvisionalAttachmentArtifactStoreResponse::RecoveryAvailable(recovery) => recovery,
        _ => panic!("Begin returned the wrong closed response"),
    };
    let owner = match restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered {
            recovery: recovered.clone(),
        })
        .await
        .unwrap()
    {
        ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) => owner,
        _ => panic!("ResumeRecovered returned the wrong closed response"),
    };
    assert_eq!(restarted.read_chunk(&owner, 0).unwrap().bytes, bytes);
    let durable_generation = recovered.generation().to_owned();
    drop(recovered);
    drop(restarted);
    let committed_restart = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let recovered_committed =
        ProvisionalAttachmentArtifactRecovery::new(scope, durable_generation).unwrap();
    let recovered_owner = match committed_restart
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered {
            recovery: recovered_committed,
        })
        .await
        .unwrap()
    {
        ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) => owner,
        _ => panic!("ResumeRecovered returned the wrong closed response"),
    };
    assert_eq!(recovered_owner, owner);
}

#[test]
fn provisional_begin_write_and_seal_failures_leave_only_the_prior_durable_state() {
    let database = TestDatabase::new("provisional-early-faults");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let (bytes, publication) = authenticated_target("durable ciphertext");
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let writer = store.begin_provisional(&scope).unwrap();
    drop(store);

    for boundary in 1..=2 {
        let failing = SqliteAttachmentArtifactStore::open_failing_after(
            &database.0,
            SqliteFailureOperation::BeginProvisional,
            boundary,
        )
        .unwrap();
        assert!(failing.begin_provisional(&scope).is_err());
        drop(failing);
        let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
        assert_eq!(
            restored
                .write_provisional_chunk(&writer, 0, &bytes)
                .unwrap(),
            if boundary == 1 {
                ArtifactChunkWrite::Stored
            } else {
                ArtifactChunkWrite::AlreadyStored
            }
        );
    }

    let write_scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-write",
        "attachment-1",
    )
    .unwrap();
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let write_writer = store.begin_provisional(&write_scope).unwrap();
    drop(store);
    let failing = SqliteAttachmentArtifactStore::open_failing_after(
        &database.0,
        SqliteFailureOperation::WriteProvisionalChunk,
        1,
    )
    .unwrap();
    assert!(failing
        .write_provisional_chunk(&write_writer, 0, &bytes)
        .is_err());
    drop(failing);
    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert_eq!(
        restored
            .write_provisional_chunk(&write_writer, 0, &bytes)
            .unwrap(),
        ArtifactChunkWrite::Stored
    );

    let failing = SqliteAttachmentArtifactStore::open_failing_after(
        &database.0,
        SqliteFailureOperation::SealProvisional,
        1,
    )
    .unwrap();
    assert!(failing.finalize_provisional(&writer, publication).is_err());
    drop(failing);
    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert!(restored.resume_provisional_finalization(&writer).is_err());
    assert_eq!(
        restored
            .write_provisional_chunk(&writer, 0, &bytes)
            .unwrap(),
        ArtifactChunkWrite::AlreadyStored
    );
}

#[test]
fn corrupted_same_length_provisional_chunks_and_bad_final_lengths_never_publish() {
    let database = TestDatabase::new("provisional-corruption");
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-corrupt",
        "attachment-1",
    )
    .unwrap();
    let (bytes, publication) = authenticated_target_for(
        "corrupt me",
        "account-1",
        "user-1",
        "operation-corrupt",
        "attachment-1",
    );
    let writer = store.begin_provisional(&scope).unwrap();
    store.write_provisional_chunk(&writer, 0, &bytes).unwrap();
    drop(store);
    let connection = Connection::open(&database.0).unwrap();
    connection
        .execute(
            "UPDATE attachment_move_provisional_chunks SET ciphertext = ?1
             WHERE account_id = ?2 AND operation_id = ?3 AND attachment_id = ?4
               AND generation = ?5 AND chunk_index = 0",
            params![
                vec![99_u8; bytes.len()],
                writer.account_id().as_str(),
                writer.operation_id(),
                writer.attachment_id(),
                writer.generation,
            ],
        )
        .unwrap();
    drop(connection);
    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert!(restored.finalize_provisional(&writer, publication).is_err());

    let length_scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-length",
        "attachment-1",
    )
    .unwrap();
    let (length_bytes, _) = authenticated_target_for(
        "wrong length",
        "account-1",
        "user-1",
        "operation-length",
        "attachment-1",
    );
    let (_, wrong_length) = authenticated_target_for(
        "a much longer authenticated target payload",
        "account-1",
        "user-1",
        "operation-length",
        "attachment-1",
    );
    let length_writer = restored.begin_provisional(&length_scope).unwrap();
    restored
        .write_provisional_chunk(&length_writer, 0, &length_bytes)
        .unwrap();
    assert!(restored
        .finalize_provisional(&length_writer, wrong_length)
        .is_err());
}

#[test]
fn account_deletion_and_restartable_orphan_sweep_cover_provisional_generations() {
    let database = TestDatabase::new("provisional-account-cleanup");
    let bytes = b"encrypted chunk";
    let scope_1 = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let scope_2 = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-2"),
        "operation-1",
        "attachment-1",
    )
    .unwrap();
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let writer_1 = store.begin_provisional(&scope_1).unwrap();
    let writer_2 = store.begin_provisional(&scope_2).unwrap();
    store.write_provisional_chunk(&writer_1, 0, bytes).unwrap();
    store.write_provisional_chunk(&writer_2, 0, bytes).unwrap();
    store.delete_account(&AccountId::from("account-1")).unwrap();
    assert!(store.write_provisional_chunk(&writer_1, 0, bytes).is_err());
    assert_eq!(
        store.write_provisional_chunk(&writer_2, 0, bytes).unwrap(),
        ArtifactChunkWrite::AlreadyStored
    );

    let extra_scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-2"),
        "operation-2",
        "attachment-2",
    )
    .unwrap();
    let extra = store.begin_provisional(&extra_scope).unwrap();
    store.write_provisional_chunk(&extra, 0, bytes).unwrap();
    drop(store);
    let failing = SqliteAttachmentArtifactStore::open_failing_after(
        &database.0,
        SqliteFailureOperation::SweepOrphans,
        2,
    )
    .unwrap();
    assert!(failing
        .sweep_orphans(
            ExclusiveStartupBoundary::proven_by_runtime_startup(),
            &AccountId::from("account-2"),
            &[],
        )
        .is_err());
    drop(failing);
    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert_eq!(
        restored
            .sweep_orphans(
                ExclusiveStartupBoundary::proven_by_runtime_startup(),
                &AccountId::from("account-2"),
                &[],
            )
            .unwrap(),
        1
    );
    assert!(restored
        .write_provisional_chunk(&writer_2, 0, bytes)
        .is_err());
    assert!(restored.write_provisional_chunk(&extra, 0, bytes).is_err());
}

#[test]
fn native_sqlite_publishes_and_restarts_a_real_multi_chunk_artifact() {
    let database = TestDatabase::new("publish-restart");
    let bytes: Vec<u8> = (0..(ARTIFACT_CHUNK_BYTES * 2 + 17))
        .map(|index| (index % 251) as u8)
        .collect();
    let owner = owner("account-1", "operation-1", "attachment-1", &bytes);

    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    for (index, chunk) in chunks(&bytes) {
        assert_eq!(
            store.write_chunk(&owner, index, chunk).unwrap(),
            ArtifactChunkWrite::Stored
        );
        assert_eq!(
            store.write_chunk(&owner, index, chunk).unwrap(),
            ArtifactChunkWrite::AlreadyStored
        );
    }
    assert_eq!(
        store.publish(&owner).unwrap(),
        ArtifactPublication::Published
    );
    drop(store);

    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let mut actual = Vec::new();
    for index in 0..3 {
        let chunk = restored.read_chunk(&owner, index).unwrap();
        actual.extend_from_slice(&chunk.bytes);
        assert_eq!(chunk.is_last, index == 2);
    }
    assert_eq!(actual, bytes);
    assert_eq!(
        restored.publish(&owner).unwrap(),
        ArtifactPublication::AlreadyPublished
    );
}

#[test]
fn opening_a_b1_database_adds_the_mapping_without_losing_canonical_ciphertext() {
    let database = TestDatabase::new("b1-schema-evolution");
    let bytes = b"canonical B1 ciphertext";
    let owner = owner("account-1", "operation-1", "attachment-1", bytes);
    let connection = Connection::open(&database.0).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE attachment_move_artifacts (
                account_id TEXT NOT NULL,
                artifact_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                attachment_id TEXT NOT NULL,
                ciphertext_sha256 TEXT NOT NULL,
                byte_length INTEGER NOT NULL,
                chunk_count INTEGER NOT NULL,
                publication_state INTEGER NOT NULL,
                PRIMARY KEY (account_id, artifact_id)
            );
            CREATE TABLE attachment_move_artifact_chunks (
                account_id TEXT NOT NULL,
                artifact_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                ciphertext BLOB NOT NULL,
                ciphertext_sha256 TEXT NOT NULL,
                PRIMARY KEY (account_id, artifact_id, chunk_index)
            );",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO attachment_move_artifacts (
                account_id, artifact_id, operation_id, attachment_id,
                ciphertext_sha256, byte_length, chunk_count, publication_state
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 2)",
            params![
                owner.account_id().as_str(),
                owner.artifact_id(),
                owner.operation_id(),
                owner.attachment_id(),
                owner.ciphertext_sha256(),
                owner.byte_length() as i64,
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO attachment_move_artifact_chunks (
                account_id, artifact_id, chunk_index, ciphertext, ciphertext_sha256
             ) VALUES (?1, ?2, 0, ?3, ?4)",
            params![
                owner.account_id().as_str(),
                owner.artifact_id(),
                bytes,
                format!("{:x}", Sha256::digest(bytes)),
            ],
        )
        .unwrap();
    drop(connection);

    let evolved = SqliteAttachmentArtifactStore::open(&database.0).unwrap();

    assert_eq!(evolved.read_chunk(&owner, 0).unwrap().bytes, bytes);
    drop(evolved);
    let reopened = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert_eq!(reopened.read_chunk(&owner, 0).unwrap().bytes, bytes);
}

#[test]
fn orphan_sweep_preserves_every_supplied_live_reference() {
    let database = TestDatabase::new("orphan-sweep");
    let live_bytes = vec![7; ARTIFACT_CHUNK_BYTES + 1];
    let orphan_bytes = vec![9; 31];
    let live = owner(
        "account-1",
        "operation-live",
        "attachment-live",
        &live_bytes,
    );
    let orphan = owner(
        "account-1",
        "operation-orphan",
        "attachment-orphan",
        &orphan_bytes,
    );
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    for (index, chunk) in chunks(&live_bytes) {
        store.write_chunk(&live, index, chunk).unwrap();
    }
    store.publish(&live).unwrap();
    store.write_chunk(&orphan, 0, &orphan_bytes).unwrap();

    assert_eq!(
        store
            .sweep_orphans(
                ExclusiveStartupBoundary::proven_by_runtime_startup(),
                &AccountId::from("account-1"),
                std::slice::from_ref(&live),
            )
            .unwrap(),
        1
    );
    assert_eq!(
        store.read_chunk(&live, 0).unwrap().bytes,
        live_bytes[..ARTIFACT_CHUNK_BYTES]
    );
    assert!(store.publish(&orphan).is_err());
}

#[test]
fn protocol_rejects_noncanonical_ownership_bad_chunk_shapes_and_conflicting_bytes() {
    let database = TestDatabase::new("closed-protocol");
    let bytes = vec![3; ARTIFACT_CHUNK_BYTES + 5];
    let owner = owner("account-1", "operation-1", "attachment-1", &bytes);
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();

    let mut noncanonical = owner.artifact.clone();
    noncanonical.artifact_id = "0".repeat(64);
    assert!(AttachmentArtifactOwner::new(
        AccountId::from("account-1"),
        "operation-1",
        "attachment-1",
        noncanonical,
    )
    .is_err());

    assert!(store.write_chunk(&owner, 0, &bytes[..31]).is_err());
    assert!(store.write_chunk(&owner, 2, &[]).is_err());
    assert!(store.read_chunk(&owner, 0).is_err());

    store
        .write_chunk(&owner, 0, &bytes[..ARTIFACT_CHUNK_BYTES])
        .unwrap();
    let conflicting = vec![4; ARTIFACT_CHUNK_BYTES];
    assert!(store.write_chunk(&owner, 0, &conflicting).is_err());
    assert!(store.publish(&owner).is_err());

    let wrong_tail = vec![8; 5];
    store.write_chunk(&owner, 1, &wrong_tail).unwrap();
    assert!(store.publish(&owner).is_err());
    assert!(store.read_chunk(&owner, 0).is_err());
}

#[test]
fn whole_account_delete_is_explicit_and_does_not_use_implicit_active_scope() {
    let database = TestDatabase::new("account-delete");
    let bytes = vec![5; 43];
    let account_1 = owner("account-1", "same-operation", "same-attachment", &bytes);
    let account_2 = owner("account-2", "same-operation", "same-attachment", &bytes);
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    for owner in [&account_1, &account_2] {
        store.write_chunk(owner, 0, &bytes).unwrap();
        store.publish(owner).unwrap();
    }

    store.delete_account(&AccountId::from("account-1")).unwrap();
    assert!(store.read_chunk(&account_1, 0).is_err());
    assert_eq!(store.read_chunk(&account_2, 0).unwrap().bytes, bytes);
}

#[test]
fn whole_device_wipe_removes_every_artifact_row_across_restart() {
    let database = TestDatabase::new("device-wipe");
    let bytes = vec![7; 29];
    let account_1 = owner("account-1", "operation-1", "attachment-1", &bytes);
    let account_2 = owner("account-2", "operation-2", "attachment-2", &bytes);
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    for owner in [&account_1, &account_2] {
        store.write_chunk(owner, 0, &bytes).unwrap();
        store.publish(owner).unwrap();
    }

    store.wipe_device().unwrap();
    drop(store);

    let restarted = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert!(restarted.read_chunk(&account_1, 0).is_err());
    assert!(restarted.read_chunk(&account_2, 0).is_err());
    restarted.wipe_device().unwrap();
}

#[test]
fn sqlite_rolls_back_every_chunk_write_and_publication_boundary() {
    let database = TestDatabase::new("write-failures");
    let bytes = vec![11; 97];
    let chunk_owner = owner("account-1", "operation-1", "attachment-1", &bytes);

    for boundary in 1..=2 {
        let failing = SqliteAttachmentArtifactStore::open_failing_after(
            &database.0,
            SqliteFailureOperation::WriteChunk,
            boundary,
        )
        .unwrap();
        assert!(failing.write_chunk(&chunk_owner, 0, &bytes).is_err());
        drop(failing);
        let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
        assert!(restored.publish(&chunk_owner).is_err());
    }

    for boundary in 1..=2 {
        let owner = owner(
            "account-1",
            &format!("publication-operation-{boundary}"),
            &format!("publication-attachment-{boundary}"),
            &bytes,
        );
        let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
        store.write_chunk(&owner, 0, &bytes).unwrap();
        drop(store);
        let failing = SqliteAttachmentArtifactStore::open_failing_after(
            &database.0,
            SqliteFailureOperation::Publish,
            boundary,
        )
        .unwrap();
        assert!(failing.publish(&owner).is_err());
        drop(failing);
        let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
        assert!(restored.read_chunk(&owner, 0).is_err());
        assert_eq!(
            restored.publish(&owner).unwrap(),
            ArtifactPublication::Published
        );
        assert_eq!(restored.read_chunk(&owner, 0).unwrap().bytes, bytes);
    }
}

#[test]
fn sqlite_rolls_back_account_delete_boundary() {
    let database = TestDatabase::new("delete-failures");
    let bytes = vec![13; 19];
    let first = owner("account-1", "operation-1", "attachment-1", &bytes);
    let second = owner("account-1", "operation-2", "attachment-2", &bytes);
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    for owner in [&first, &second] {
        store.write_chunk(owner, 0, &bytes).unwrap();
        store.publish(owner).unwrap();
    }
    drop(store);

    let failing_delete = SqliteAttachmentArtifactStore::open_failing_after(
        &database.0,
        SqliteFailureOperation::DeleteAccount,
        1,
    )
    .unwrap();
    assert!(failing_delete
        .delete_account(&AccountId::from("account-1"))
        .is_err());
    drop(failing_delete);
    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert_eq!(restored.read_chunk(&first, 0).unwrap().bytes, bytes);
}

#[test]
fn sqlite_account_and_device_deletion_roll_back_every_artifact_table() {
    for scope in ["account", "device"] {
        for boundary in 1..=4 {
            let database = TestDatabase::new(&format!("{scope}-orphan-rollback-{boundary}"));
            drop(SqliteAttachmentArtifactStore::open(&database.0).unwrap());
            seed_orphan_artifact_rows(&database.0, "account-1");
            seed_orphan_artifact_rows(&database.0, "account-2");
            let operation = if scope == "account" {
                SqliteFailureOperation::DeleteAccount
            } else {
                SqliteFailureOperation::WipeDevice
            };
            let failing =
                SqliteAttachmentArtifactStore::open_failing_after(&database.0, operation, boundary)
                    .unwrap();
            let result = if scope == "account" {
                failing.delete_account(&AccountId::from("account-1"))
            } else {
                failing.wipe_device()
            };
            assert!(result.is_err());
            drop(failing);
            assert_eq!(artifact_row_counts(&database.0, "account-1"), [1; 4]);
            assert_eq!(artifact_row_counts(&database.0, "account-2"), [1; 4]);

            let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
            if scope == "account" {
                restored
                    .delete_account(&AccountId::from("account-1"))
                    .unwrap();
                assert_eq!(artifact_row_counts(&database.0, "account-1"), [0; 4]);
                assert_eq!(artifact_row_counts(&database.0, "account-2"), [1; 4]);
                restored
                    .delete_account(&AccountId::from("account-1"))
                    .unwrap();
            } else {
                restored.wipe_device().unwrap();
                assert_eq!(artifact_row_counts(&database.0, "account-1"), [0; 4]);
                assert_eq!(artifact_row_counts(&database.0, "account-2"), [0; 4]);
                restored.wipe_device().unwrap();
            }
        }
    }
}

#[test]
fn sqlite_rejects_an_empty_explicit_artifact_account_scope() {
    let database = TestDatabase::new("empty-account-delete");
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();

    assert!(store.delete_account(&AccountId::from("")).is_err());
}

#[test]
fn orphan_sweep_commits_each_delete_and_restart_resumes_after_a_later_failure() {
    let database = TestDatabase::new("sweep-partial-progress");
    let bytes = vec![17; 23];
    let first = owner("account-1", "operation-1", "attachment-1", &bytes);
    let second = owner("account-1", "operation-2", "attachment-2", &bytes);
    let live = owner("account-1", "operation-live", "attachment-live", &bytes);
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    for owner in [&first, &second, &live] {
        store.write_chunk(owner, 0, &bytes).unwrap();
        store.publish(owner).unwrap();
    }
    drop(store);

    let failing = SqliteAttachmentArtifactStore::open_failing_after(
        &database.0,
        SqliteFailureOperation::SweepOrphans,
        2,
    )
    .unwrap();
    assert!(failing
        .sweep_orphans(
            ExclusiveStartupBoundary::proven_by_runtime_startup(),
            &AccountId::from("account-1"),
            std::slice::from_ref(&live),
        )
        .is_err());
    drop(failing);

    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let deleted_before_restart = [&first, &second]
        .into_iter()
        .filter(|owner| restored.read_chunk(owner, 0).is_err())
        .count();
    assert_eq!(deleted_before_restart, 1);
    assert_eq!(restored.read_chunk(&live, 0).unwrap().bytes, bytes);
    assert_eq!(
        restored
            .sweep_orphans(
                ExclusiveStartupBoundary::proven_by_runtime_startup(),
                &AccountId::from("account-1"),
                std::slice::from_ref(&live),
            )
            .unwrap(),
        1
    );
    assert!(restored.read_chunk(&first, 0).is_err());
    assert!(restored.read_chunk(&second, 0).is_err());
    assert_eq!(restored.read_chunk(&live, 0).unwrap().bytes, bytes);
}

#[test]
fn concurrent_exact_publishers_converge_after_both_verify_ciphertext() {
    let database = TestDatabase::new("concurrent-publish");
    let bytes = vec![21; ARTIFACT_CHUNK_BYTES + 7];
    let owner = owner("account-1", "operation-1", "attachment-1", &bytes);
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    for (index, chunk) in chunks(&bytes) {
        store.write_chunk(&owner, index, chunk).unwrap();
    }
    drop(store);

    // Leave the complete artifact durably in `verifying`, the exact crash boundary both restarted
    // publishers must resume.
    let interrupted = SqliteAttachmentArtifactStore::open_failing_after(
        &database.0,
        SqliteFailureOperation::Publish,
        2,
    )
    .unwrap();
    assert!(interrupted.publish(&owner).is_err());
    drop(interrupted);

    let barrier = Arc::new(Barrier::new(2));
    let first_store =
        SqliteAttachmentArtifactStore::open_with_publish_barrier(&database.0, Arc::clone(&barrier))
            .unwrap();
    let second_store =
        SqliteAttachmentArtifactStore::open_with_publish_barrier(&database.0, barrier).unwrap();
    let first_owner = owner.clone();
    let second_owner = owner.clone();
    let first = std::thread::spawn(move || first_store.publish(&first_owner));
    let second = std::thread::spawn(move || second_store.publish(&second_owner));
    let mut results = [first.join().unwrap(), second.join().unwrap()];
    results.sort_by_key(|result| match result {
        Ok(ArtifactPublication::Published) => 0,
        Ok(ArtifactPublication::AlreadyPublished) => 1,
        Err(_) => 2,
    });
    assert_eq!(
        results,
        [
            Ok(ArtifactPublication::Published),
            Ok(ArtifactPublication::AlreadyPublished),
        ]
    );
    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert_eq!(
        restored.read_chunk(&owner, 0).unwrap().bytes,
        bytes[..ARTIFACT_CHUNK_BYTES]
    );
}

#[test]
fn published_reads_reject_same_length_and_oversized_sqlite_blob_corruption() {
    let database = TestDatabase::new("published-corruption");
    let bytes = vec![27; ARTIFACT_CHUNK_BYTES];
    let same_length = owner(
        "account-1",
        "operation-same-length",
        "attachment-same-length",
        &bytes,
    );
    let oversized = owner(
        "account-1",
        "operation-oversized",
        "attachment-oversized",
        &bytes,
    );
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    for owner in [&same_length, &oversized] {
        store.write_chunk(owner, 0, &bytes).unwrap();
        store.publish(owner).unwrap();
    }
    drop(store);

    let connection = Connection::open(&database.0).unwrap();
    connection
        .execute(
            "UPDATE attachment_move_artifact_chunks SET ciphertext = ?1
             WHERE account_id = ?2 AND artifact_id = ?3 AND chunk_index = 0",
            params![
                vec![28_u8; ARTIFACT_CHUNK_BYTES],
                same_length.account_id().as_str(),
                same_length.artifact_id(),
            ],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE attachment_move_artifact_chunks
             SET ciphertext = zeroblob(?1)
             WHERE account_id = ?2 AND artifact_id = ?3 AND chunk_index = 0",
            params![
                (ARTIFACT_CHUNK_BYTES + 1) as i64,
                oversized.account_id().as_str(),
                oversized.artifact_id(),
            ],
        )
        .unwrap();
    drop(connection);

    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert!(restored.read_chunk(&same_length, 0).is_err());
    assert!(restored.read_chunk(&oversized, 0).is_err());
}

#[test]
fn replay_and_publication_reject_corrupt_durable_chunk_digests() {
    let database = TestDatabase::new("prepublication-corruption");
    let bytes = vec![31; 89];
    let replay = owner("account-1", "operation-replay", "attachment-replay", &bytes);
    let publication = owner(
        "account-1",
        "operation-publication",
        "attachment-publication",
        &bytes,
    );
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    store.write_chunk(&replay, 0, &bytes).unwrap();
    store.write_chunk(&publication, 0, &bytes).unwrap();
    drop(store);

    let connection = Connection::open(&database.0).unwrap();
    for owner in [&replay, &publication] {
        connection
            .execute(
                "UPDATE attachment_move_artifact_chunks SET ciphertext = ?1
                 WHERE account_id = ?2 AND artifact_id = ?3 AND chunk_index = 0",
                params![
                    vec![32_u8; bytes.len()],
                    owner.account_id().as_str(),
                    owner.artifact_id(),
                ],
            )
            .unwrap();
    }
    drop(connection);

    let restored = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    assert!(restored.write_chunk(&replay, 0, &bytes).is_err());
    assert!(restored.publish(&publication).is_err());
    assert!(restored.read_chunk(&publication, 0).is_err());
}
