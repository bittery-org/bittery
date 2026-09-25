//! Completing the last accepted file workflow wakes the existing idle artifact lifecycle.
use super::*;

fn physical_artifact_rows(
    database: &Path,
    owner: &AttachmentArtifactOwner,
    generation: &str,
) -> [i64; 4] {
    let connection = rusqlite::Connection::open(database).unwrap();
    let published = |table: &str| {
        connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE account_id = ?1 AND artifact_id = ?2"),
                rusqlite::params![owner.account_id().as_str(), owner.artifact_id()],
                |row| row.get(0),
            )
            .unwrap()
    };
    let provisional = |table: &str| {
        connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE account_id = ?1 AND operation_id = ?2 AND attachment_id = ?3 AND generation = ?4"),
                rusqlite::params![
                    owner.account_id().as_str(),
                    owner.operation_id(),
                    owner.attachment_id(),
                    generation
                ],
                |row| row.get(0),
            )
            .unwrap()
    };
    [
        published("attachment_move_artifacts"),
        published("attachment_move_artifact_chunks"),
        provisional("attachment_move_provisional_artifacts"),
        provisional("attachment_move_provisional_chunks"),
    ]
}

#[tokio::test]
async fn completed_move_reclaims_ciphertext_without_another_operation_or_owner_restart() {
    let database = MoveDatabase::new();
    let artifact_database = MoveDatabase::new();
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let sweep = Arc::new(SweepWitness {
        store: artifacts.clone(),
        completed: Mutex::default(),
        changed: tokio::sync::Notify::new(),
    });
    let (http, binary) = attachment_ports(&database.0);
    let runtime = reopen_attachment_runtime(
        &database.0,
        artifacts.clone(),
        Arc::new(InstallationPlatform::default()),
        http.clone(),
        binary.clone(),
        sweep.clone(),
    )
    .await;
    let mut accounts = Vec::new();
    for identity in [RoutingAuthIdentity::default(), OTHER_USER] {
        let RuntimeResponse::SignedIn { account_id, .. } = runtime
            .request(
                sign_in_request_to(SOURCE_ORIGIN, identity.normalized_email),
                RequestCancellation::new(),
            )
            .await
            .unwrap()
        else {
            panic!("both Users must complete public SRP Sign-in")
        };
        accounts.push(account_id);
    }
    let [source, target]: [AccountId; 2] = accounts.try_into().unwrap();
    http.actors.http.offline.store(true, Ordering::SeqCst);
    let RuntimeResponse::Accepted { operation_id, .. } = runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: source.clone(),
                item_id: SOURCE_ITEM.into(),
                target_account_id: Some(target),
                target_vault_id: "vault-2".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("the nonempty Move must be admitted")
    };
    let lifecycle = runtime
        .attachment_move_lifecycle
        .lock()
        .unwrap()
        .clone()
        .unwrap();
    let incarnation = runtime.require_snapshot(&source).unwrap().incarnation;
    let preparation = tokio::spawn(runtime.clone().run_attachment_move_preparation());
    let initial = tokio::time::timeout(Duration::from_secs(10), async {
        sweep.wait_for(&source).await;
        while !lifecycle.has_swept(&source, &incarnation) {
            tokio::task::yield_now().await;
        }
    })
    .await;
    if initial.is_err() {
        preparation.abort();
        let _ = preparation.await;
        runtime.close().await;
        panic!("the real source Account startup sweep must finish before file execution")
    }
    let initial_sweeps = sweep
        .completed
        .lock()
        .unwrap()
        .iter()
        .filter(|id| **id == source)
        .count();
    http.actors.http.resumed.store(true, Ordering::SeqCst);
    http.actors.http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    http.actors
        .http
        .trash_result
        .wait("matching target file before source destruction")
        .await;
    let checkpoint = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let owner = checkpoint_owner(&checkpoint, &source);
    let generation = publication_generation(&artifacts, &owner).await.unwrap();
    let original = physical_artifact_rows(&artifact_database.0, &owner, &generation);
    let retained_ciphertext = stored_ciphertext(&artifacts, &owner).await.unwrap();
    http.actors.http.delete_result.release.add_permits(1);
    http.actors.http.trash_result.release.add_permits(1);
    let completed = tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&runtime, &source, &operation_id) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let terminal = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let reclaimed = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let changed = sweep.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let count = sweep
                .completed
                .lock()
                .unwrap()
                .iter()
                .filter(|id| **id == source)
                .count();
            if count > initial_sweeps {
                return;
            }
            changed.await;
        }
    })
    .await;
    let remaining = physical_artifact_rows(&artifact_database.0, &owner, &generation);
    preparation.abort();
    let _ = preparation.await;
    close_move_runtime(runtime, runner).await;

    completed.expect("the actual original child proofs must complete before reclamation");
    assert_eq!(terminal["stage"], json!({"type":"completed"}));
    assert_eq!(terminal["attachments"], checkpoint["attachments"]);
    assert_eq!(terminal["children"].as_array().unwrap().len(), 4);
    assert_eq!(
        original[0], 1,
        "the real finalized publication existed before completion"
    );
    assert_eq!(
        original[2], 1,
        "its original provisional generation existed"
    );
    assert!(
        original[3] > 2,
        "the actual file spans several physical ciphertext chunks"
    );
    assert_eq!(
        http.objects
            .uploaded
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .ciphertext,
        retained_ciphertext
    );
    assert!(
        reclaimed.is_ok(),
        "terminal Move must wake the already idle source artifact lifecycle"
    );
    assert_eq!(
        remaining, [0; 4],
        "completed work must release publication, generation and all chunks"
    );
    assert_eq!(binary.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 1);
}

#[path = "cross_account_move_attachment_completed_reply_tests.rs"]
mod lost_reply_tests;
