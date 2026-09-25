use super::*;
use rusqlite::types::Value;

fn physical_rows(path: &PathBuf) -> Vec<Vec<Vec<Value>>> {
    let connection = Connection::open(path).unwrap();
    [
        "attachment_move_artifacts",
        "attachment_move_artifact_chunks",
        "attachment_move_provisional_artifacts",
        "attachment_move_provisional_chunks",
    ]
    .into_iter()
    .map(|table| {
        let mut statement = connection
            .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
            .unwrap();
        let columns = statement.column_count();
        let rows = statement
            .query_map([], |row| {
                (0..columns)
                    .map(|column| row.get::<_, Value>(column))
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap();
        rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
    })
    .collect()
}

#[tokio::test]
async fn absent_and_incomplete_recover_are_unavailable_without_changing_durable_rows() {
    let database = TestDatabase::new("unavailable-recover");
    let absent = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-absent",
        "attachment-absent",
    )
    .unwrap();
    let incomplete = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-incomplete",
        "attachment-incomplete",
    )
    .unwrap();
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let ProvisionalAttachmentArtifactStoreResponse::Begun(writer) = store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
            writer: ProvisionalAttachmentArtifactWriter::new(incomplete.clone()),
        })
        .await
        .unwrap()
    else {
        panic!("incomplete fixture must begin without publishing");
    };
    store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::WriteChunk {
            writer,
            chunk_index: 0,
            bytes: vec![17; ARTIFACT_CHUNK_BYTES],
        })
        .await
        .unwrap();
    drop(store);
    let before = physical_rows(&database.0);
    let restarted = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let absent_result = restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Recover { scope: absent })
        .await;
    assert_eq!(physical_rows(&database.0), before);
    let incomplete_result = restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Recover {
            scope: incomplete,
        })
        .await;
    drop(restarted);
    assert_eq!(physical_rows(&database.0), before);
    assert!(
        matches!(
            &absent_result,
            Ok(ProvisionalAttachmentArtifactStoreResponse::RecoveryUnavailable)
        ) && matches!(
            &incomplete_result,
            Ok(ProvisionalAttachmentArtifactStoreResponse::RecoveryUnavailable)
        ),
        "Recovery must distinguish unavailable scopes from storage failure: absent={absent_result:?}, incomplete={incomplete_result:?}"
    );
}

#[tokio::test]
async fn recover_preserves_valid_redo_but_refuses_missing_or_contradictory_current_mapping() {
    let mut refusals = Vec::new();
    for history in ["swept-redo", "missing-current", "contradictory-state0"] {
        let database = TestDatabase::new(history);
        let scope = ProvisionalAttachmentArtifactScope::new(
            AccountId::from("account-1"),
            "operation-1",
            "attachment-1",
        )
        .unwrap();
        let (bytes, publication) = authenticated_target("retained published generation");
        let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
        let first = store.begin_provisional(&scope).unwrap();
        for (index, chunk) in chunks(&bytes) {
            store.write_provisional_chunk(&first, index, chunk).unwrap();
        }
        let owner = store.finalize_provisional(&first, publication).unwrap();
        assert_eq!(store.read_chunk(&owner, 0).unwrap().bytes, bytes);

        if history == "missing-current" {
            drop(store);
            // A restored database has lost only the singular current binding. The real
            // publication and all authenticated ciphertext remain as evidence, not absence.
            let connection = Connection::open(&database.0).unwrap();
            assert_eq!(
                connection
                    .execute("DELETE FROM attachment_move_provisional_artifacts", [])
                    .unwrap(),
                1
            );
        } else {
            // Explicit ordinary Begin can choose a new nonce while the accepted older
            // publication remains readable. Recover must not mistake that older mapping
            // for a contradictory mapping of the new incomplete generation.
            let second = store.begin_provisional(&scope).unwrap();
            assert_ne!(second.generation(), first.generation());
            store
                .write_provisional_chunk(&second, 0, &[19; 32])
                .unwrap();
            let before = physical_rows(&database.0);
            assert_eq!(
                store
                    .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Recover {
                        scope: scope.clone(),
                    })
                    .await
                    .unwrap(),
                ProvisionalAttachmentArtifactStoreResponse::RecoveryUnavailable
            );
            assert_eq!(physical_rows(&database.0), before);
            assert_eq!(store.read_chunk(&owner, 0).unwrap().bytes, bytes);

            if history == "swept-redo" {
                // A real empty-pending sweep can remove B while retaining live A. There is
                // then no proof whether A was current; Recover cannot select it or Begin.
                assert_eq!(
                    store
                        .sweep_orphans(
                            ExclusiveStartupBoundary::proven_by_runtime_startup(),
                            &scope.account_id,
                            std::slice::from_ref(&owner),
                        )
                        .unwrap(),
                    1
                );
                assert_eq!(store.read_chunk(&owner, 0).unwrap().bytes, bytes);
                drop(store);
                assert!(physical_rows(&database.0)[2].is_empty());
            } else {
                drop(store);
                // Corrupt only the current binding's generation: its unsealed state0 now
                // contradicts the already published mapping of that same generation.
                let connection = Connection::open(&database.0).unwrap();
                assert_eq!(
                    connection
                        .execute(
                            "UPDATE attachment_move_provisional_artifacts SET generation = ?1",
                            params![first.generation()],
                        )
                        .unwrap(),
                    1
                );
            }
        }
        let before = physical_rows(&database.0);
        let restarted = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
        let result = restarted
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Recover { scope })
            .await;
        drop(restarted);
        assert_eq!(physical_rows(&database.0), before, "{history}");
        refusals.push((history, result));
    }
    assert!(
        refusals.iter().all(|(_, result)| result.is_err()),
        "ambiguous or contradictory publication must refuse read-only recovery: {refusals:?}"
    );
}

#[tokio::test]
async fn published_recover_rejects_changed_ciphertext_without_mutating_durable_rows() {
    let database = TestDatabase::new("published-recover-integrity");
    let scope = ProvisionalAttachmentArtifactScope::new(
        AccountId::from("account-1"),
        "operation-recover-integrity",
        "attachment-1",
    )
    .unwrap();
    let (bytes, publication) = authenticated_target_for(
        &"authenticated recovery ciphertext ".repeat(20_000),
        scope.account_id().as_str(),
        "user-1",
        scope.operation_id(),
        scope.attachment_id(),
    );
    assert!(bytes.len() > ARTIFACT_CHUNK_BYTES * 2);
    let store = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let ProvisionalAttachmentArtifactStoreResponse::Begun(writer) = store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin {
            writer: ProvisionalAttachmentArtifactWriter::new(scope.clone()),
        })
        .await
        .unwrap()
    else {
        panic!("fresh artifact must begin its first generation");
    };
    let generation = writer.generation().to_owned();
    for (chunk_index, chunk) in chunks(&bytes) {
        store
            .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::WriteChunk {
                writer: writer.clone(),
                chunk_index,
                bytes: chunk.to_vec(),
            })
            .await
            .unwrap();
    }
    let ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) = store
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Finalize {
            writer,
            publication_proof: publication,
        })
        .await
        .unwrap()
    else {
        panic!("authenticated Finalize must commit the published artifact");
    };
    drop(store);

    // Finalize really committed state2 before the owner disappeared. This is not a failure
    // injected inside publication, where a still-sealed generation could take a different path.
    let connection = Connection::open(&database.0).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT publication_state FROM attachment_move_provisional_artifacts",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT publication_state, physical_generation FROM attachment_move_artifacts",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .unwrap(),
        (2, generation.clone())
    );
    drop(connection);
    let healthy_rows = physical_rows(&database.0);
    let restarted = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let recovered = restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Recover {
            scope: scope.clone(),
        })
        .await
        .unwrap();
    assert_eq!(
        recovered,
        ProvisionalAttachmentArtifactStoreResponse::RecoveryAvailable(
            ProvisionalAttachmentArtifactRecovery::new(scope.clone(), generation.clone()).unwrap()
        )
    );
    let mut recovered_bytes = Vec::new();
    for (chunk_index, _) in chunks(&bytes) {
        recovered_bytes.extend(restarted.read_chunk(&owner, chunk_index).unwrap().bytes);
    }
    assert_eq!(recovered_bytes, bytes);
    drop(restarted);
    assert_eq!(physical_rows(&database.0), healthy_rows);

    // Model physical corruption after owner loss: only one ciphertext byte changes. The
    // durable per-chunk digest and authenticated publication seal remain exactly as accepted.
    let mut changed_chunk = bytes[..ARTIFACT_CHUNK_BYTES].to_vec();
    changed_chunk[ARTIFACT_CHUNK_BYTES / 2] ^= 1;
    let connection = Connection::open(&database.0).unwrap();
    assert_eq!(
        connection
            .execute(
                "UPDATE attachment_move_provisional_chunks SET ciphertext = ?1
                 WHERE account_id = ?2 AND operation_id = ?3 AND attachment_id = ?4
                   AND generation = ?5 AND chunk_index = 0",
                params![
                    changed_chunk,
                    scope.account_id().as_str(),
                    scope.operation_id(),
                    scope.attachment_id(),
                    generation,
                ],
            )
            .unwrap(),
        1
    );
    drop(connection);
    let corrupt_rows = physical_rows(&database.0);
    assert_ne!(corrupt_rows, healthy_rows);
    let restarted = SqliteAttachmentArtifactStore::open(&database.0).unwrap();
    let result = restarted
        .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Recover { scope })
        .await;
    drop(restarted);
    assert_eq!(physical_rows(&database.0), corrupt_rows);
    assert!(
        result.is_err(),
        "Recover accepted changed published ciphertext: {result:?}"
    );
}
