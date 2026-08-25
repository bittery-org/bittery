use super::{
    ArtifactChunkWrite, ArtifactPublication, AttachmentArtifactOwner, ExclusiveStartupBoundary,
    SqliteAttachmentArtifactStore, SqliteFailureOperation, ARTIFACT_CHUNK_BYTES,
};
use crate::{replica::attachment_move_artifact_ref, AccountId};
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
