//! Durable completion releases ciphertext even when its accepted SQLite reply is lost.
use super::*;

struct LostCompletedReply {
    sqlite: Arc<MoveSqlite>,
    armed: Mutex<Option<(AccountId, String)>>,
    lost: AtomicBool,
}

#[async_trait]
impl SerializedReplicaExecutor for LostCompletedReply {
    async fn invoke(&self, input: String) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        let armed = self.armed.lock().unwrap().clone();
        let terminal = armed.is_some_and(|(account, operation)| {
            request["type"] == "commit"
                && request["prepared"]["expected"]["accountId"] == account.as_str()
                && request["prepared"]["writes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|write| {
                        write["type"] == "put"
                            && write["row"]["store"] == "crossAccountMoves"
                            && write["row"]["key"]["recordId"] == operation.as_str()
                    })
                    .filter_map(|write| {
                        serde_json::from_str::<Value>(write["row"]["payloadJson"].as_str()?).ok()
                    })
                    .any(|record| record["stage"]["type"] == "completed")
        });
        let response = self.sqlite.invoke(input).await?;
        if terminal && !self.lost.swap(true, Ordering::SeqCst) {
            let answer: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(answer["type"], "committed");
            assert_eq!(answer["result"]["type"], "applied");
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "injected loss of the actually applied terminal Commit reply",
            ));
        }
        Ok(response)
    }
}

#[tokio::test]
async fn lost_completed_commit_reply_reclaims_durable_ciphertext_without_cache_adoption() {
    let database = MoveDatabase::new();
    let artifact_database = MoveDatabase::new();
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let sweep = Arc::new(SweepWitness {
        store: artifacts.clone(),
        completed: Mutex::default(),
        changed: tokio::sync::Notify::new(),
    });
    let persistence = Arc::new(LostCompletedReply {
        sqlite: MoveSqlite::open(&database.0),
        armed: Mutex::default(),
        lost: AtomicBool::new(false),
    });
    let (http, binary) = attachment_ports(&database.0);
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        persistence.clone(),
        Arc::new(InstallationPlatform::default()),
        http.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
        AttachmentMovePreparationFacade::new(artifacts.clone(), sweep.clone(), binary.clone()),
        Arc::new(crate::runtime::attachment_move_lifecycle::TestAccountLeasePort),
    );
    runtime.open().await.unwrap();
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
            panic!("each participating User must complete public SRP Sign-in")
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
        panic!("expected one source-owned accepted Move")
    };
    *persistence.armed.lock().unwrap() = Some((source.clone(), operation_id.clone()));
    let incarnation = runtime.require_snapshot(&source).unwrap().incarnation;
    let lifecycle = runtime
        .attachment_move_lifecycle
        .lock()
        .unwrap()
        .clone()
        .unwrap();
    let preparation = tokio::spawn(runtime.clone().run_attachment_move_preparation());
    tokio::time::timeout(Duration::from_secs(10), async {
        sweep.wait_for(&source).await;
        while !lifecycle.has_swept(&source, &incarnation) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("existing source full sweep must complete before file work");
    let initial_sweeps = sweep
        .completed
        .lock()
        .unwrap()
        .iter()
        .filter(|id| **id == source)
        .count();
    http.actors.http.resumed.store(true, Ordering::SeqCst);
    http.actors.http.offline.store(false, Ordering::SeqCst);
    http.actors.http.trash_result.release.add_permits(1);
    http.actors.http.delete_result.release.add_permits(1);
    let mut original: Option<(AttachmentArtifactOwner, String, [i64; 4])> = None;
    for _ in 0..16 {
        let _ = runtime.dispatch_eligible_operations().await;
        let record = workflow(&durable_rows(&database.0, &source).await, &operation_id);
        if original.is_none() && record["attachments"][0]["progress"]["type"] == "encrypted" {
            let owner = checkpoint_owner(&record, &source);
            let generation = publication_generation(&artifacts, &owner).await.unwrap();
            let rows = physical_artifact_rows(&artifact_database.0, &owner, &generation);
            original = Some((owner, generation, rows));
        }
        if persistence.lost.load(Ordering::SeqCst) {
            break;
        }
    }
    let durable = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let cached = runtime.require_snapshot(&source).unwrap();
    let (owner, generation, original_rows) =
        original.expect("actual file was sealed before any source deletion");
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
    runtime.close().await;

    assert!(persistence.lost.load(Ordering::SeqCst));
    assert_eq!(durable["stage"], json!({"type":"completed"}));
    assert_eq!(
        serde_json::to_value(&cached.cross_account_moves[0].captured().unwrap().stage).unwrap(),
        json!({"type":"sourceDelete"}),
        "lost Commit acknowledgement leaves the cached stage unadvanced"
    );
    assert_eq!(original_rows[0], 1);
    assert_eq!(original_rows[2], 1);
    assert!(original_rows[3] > 2);
    assert!(
        reclaimed.is_ok(),
        "the terminal write must schedule cleanup before its reply can be lost"
    );
    assert_eq!(
        remaining, [0; 4],
        "sweep must use durable completion despite the old cached stage"
    );
    assert_eq!(binary.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 1);
}
