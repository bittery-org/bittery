//! Applied SQLite checkpoints survive lost replies without inventing original child results.
use super::*;

#[derive(Clone, Copy, Debug)]
enum LostCheckpoint {
    TrashPreparation,
    DeleteResult,
}

struct LostCheckpointReply {
    sqlite: Arc<MoveSqlite>,
    source: AccountId,
    checkpoint: LostCheckpoint,
    lost: AtomicBool,
    committed_record: Mutex<Option<Value>>,
}

impl LostCheckpointReply {
    fn matches(&self, record: &Value) -> bool {
        let children = record["children"].as_array().unwrap();
        match self.checkpoint {
            LostCheckpoint::TrashPreparation => {
                record["stage"]["type"] == "sourceTrash"
                    && children.len() == 2
                    && children[1]["operationId"] == "legacy-move:trash-source"
                    && children[1]["result"].is_null()
            }
            LostCheckpoint::DeleteResult => {
                record["stage"]["type"] == "sourceDelete"
                    && children.len() == 3
                    && children[2]["operationId"] == "legacy-move:delete-source"
                    && !children[2]["result"].is_null()
            }
        }
    }
}

#[async_trait]
impl SerializedReplicaExecutor for LostCheckpointReply {
    async fn invoke(&self, input: String) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        let candidate = if !self.lost.load(Ordering::SeqCst)
            && request["type"] == "commit"
            && request["prepared"]["expected"]["accountId"] == self.source.as_str()
        {
            request["prepared"]["writes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|write| {
                    write["type"] == "put"
                        && write["row"]["store"] == "crossAccountMoves"
                        && write["row"]["key"]["recordId"] == SEMANTIC
                })
                .map(|write| {
                    serde_json::from_str::<Value>(write["row"]["payloadJson"].as_str().unwrap())
                        .unwrap()
                })
                .find(|record| self.matches(record))
        } else {
            None
        };
        let response = self.sqlite.invoke(input).await?;
        if let Some(record) = candidate {
            let answer: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(answer["type"], "committed");
            assert_eq!(answer["result"]["type"], "applied");
            assert!(!self.lost.swap(true, Ordering::SeqCst));
            *self.committed_record.lock().unwrap() = Some(record);
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "injected lost acknowledgement after actual SQLite workflow checkpoint",
            ));
        }
        Ok(response)
    }
}

async fn use_checkpoint_executor(
    fixture: &mut AdmittedMoveFixture,
    executor: Arc<LostCheckpointReply>,
) {
    let saved = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        SEMANTIC,
    );
    fixture.runtime.close().await;
    let calls = fixture.http.requests.lock().unwrap().len();
    fixture.runtime = Runtime::with_configured_serialized_executors(
        executor,
        fixture.platform.clone(),
        fixture.http.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    fixture.runtime.open().await.unwrap();
    assert_eq!(fixture.http.requests.lock().unwrap().len(), calls);
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC,
        ),
        saved
    );
    for account in [&fixture.source, &fixture.target] {
        assert_eq!(
            fixture.runtime.account_access_state(account),
            Some(AccountAccessState::Locked)
        );
        fixture
            .runtime
            .request(
                quick_unlock_request(account.as_str()),
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    assert_eq!(serde_json::to_value(current(fixture)).unwrap(), saved);
}

fn source_item_rows(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .filter(|row| {
            matches!(
                row["store"].as_str(),
                Some("authorityItems" | "optimisticItems")
            )
        })
        .cloned()
        .collect()
}

async fn loses_applied_checkpoint(checkpoint: LostCheckpoint, history: Option<Value>) {
    let (mut fixture, original) = match history {
        Some(history) => admitted_legacy_move_with_history(history, None).await,
        None => admitted_legacy_move().await,
    };
    establish_prefix(&fixture, &original, RemotePrefix::Deleted, None);
    let source_before = server_evidence(&fixture.http.source.server);
    let target_before = server_evidence(&fixture.http.target.server);
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let source_items = source_item_rows(&source_rows);
    assert_eq!(
        source_items.len(),
        if original.is_legacy_held() { 1 } else { 2 },
        "held work keeps only captured authority; normal work also owns its source overlay"
    );
    if original.is_legacy_held() {
        assert_eq!(source_items[0]["store"], "authorityItems");
    }
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let executor = Arc::new(LostCheckpointReply {
        sqlite: fixture.sqlite.clone(),
        source: fixture.source.clone(),
        checkpoint,
        lost: AtomicBool::new(false),
        committed_record: Mutex::default(),
    });
    use_checkpoint_executor(&mut fixture, executor.clone()).await;
    for _ in 0..12 {
        one_pass(&fixture).await;
        if executor.lost.load(Ordering::SeqCst) {
            break;
        }
        assert!(
            !matches!(
                current(&fixture).disposition,
                CrossAccountMoveDisposition::Blocked { .. }
            ),
            "original proofs must reach the intended SQLite checkpoint: {checkpoint:?}"
        );
    }
    assert!(executor.lost.load(Ordering::SeqCst), "{checkpoint:?}");
    let committed = executor.committed_record.lock().unwrap().clone().unwrap();
    let persisted_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    assert_eq!(
        workflow(&persisted_rows, SEMANTIC),
        committed,
        "a separate SQLite owner sees exactly the write whose acknowledgement was lost"
    );
    assert_eq!(
        source_item_rows(&persisted_rows),
        source_items,
        "neither preparation nor Delete result alone proves final current absence locally"
    );
    assert_eq!(
        committed["source"],
        serde_json::to_value(&original.source).unwrap()
    );
    assert_eq!(
        committed["target"],
        serde_json::to_value(&original.target).unwrap()
    );
    assert_eq!(
        committed["legacyAdmission"],
        serde_json::to_value(&original.legacy_admission).unwrap()
    );
    match checkpoint {
        LostCheckpoint::TrashPreparation => {
            assert!(committed["children"][1]["result"].is_null());
            assert!(
                fixture.http.mutations(SOURCE_ORIGIN).is_empty(),
                "pure preparation must precede any original source replay"
            );
        }
        LostCheckpoint::DeleteResult => {
            assert_eq!(
                committed["children"][2]["result"]["result"]["type"],
                "applied"
            );
            assert_eq!(committed["children"][2]["result"]["result"]["version"], 3);
            assert_eq!(committed["stage"]["type"], "sourceDelete");
        }
    }
    assert_eq!(server_evidence(&fixture.http.source.server), source_before);
    assert_eq!(server_evidence(&fixture.http.target.server), target_before);
    let calls_before_reopen = fixture.http.requests.lock().unwrap().len();
    reopen(&mut fixture).await;
    assert_eq!(serde_json::to_value(current(&fixture)).unwrap(), committed);
    let completed = finish_or_block(&fixture).await;
    assert_eq!(completed.stage, CrossAccountMoveStage::Completed);
    assert_eq!(completed.legacy_admission, original.legacy_admission);
    assert_exact_child_replays(&fixture, &original);
    match checkpoint {
        LostCheckpoint::TrashPreparation => {
            let replayed = fixture.http.requests.lock().unwrap();
            assert!(replayed.iter().skip(calls_before_reopen).any(|request| {
                request.header("Idempotency-Key") == Some("legacy-move:trash-source")
            }));
        }
        LostCheckpoint::DeleteResult => {
            let requests = fixture.http.requests.lock().unwrap();
            assert!(
                requests.iter().skip(calls_before_reopen).any(|request| {
                    request.method == "GET"
                        && request.url == format!("{SOURCE_ORIGIN}/api/v1/items/{SOURCE_ITEM}")
                }),
                "durable Delete proof still requires fresh absence after reopening"
            );
            assert!(
                !requests.iter().skip(calls_before_reopen).any(|request| {
                    request.header("Idempotency-Key") == Some("legacy-move:delete-source")
                }),
                "the durable original Delete result is not discarded with its lost acknowledgement"
            );
        }
    }
    let final_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    assert!(source_item_rows(&final_rows).is_empty());
    assert_eq!(
        workflow(&final_rows, SEMANTIC),
        serde_json::to_value(completed).unwrap()
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    assert_eq!(server_evidence(&fixture.http.source.server), source_before);
    assert_eq!(server_evidence(&fixture.http.target.server), target_before);
    fixture.runtime.close().await;
}

#[tokio::test]
async fn legacy_remote_trash_preparation_survives_lost_sqlite_reply_before_original_replay() {
    loses_applied_checkpoint(LostCheckpoint::TrashPreparation, None).await;
}

#[tokio::test]
async fn legacy_remote_delete_result_survives_lost_sqlite_reply_before_final_absence_check() {
    loses_applied_checkpoint(LostCheckpoint::DeleteResult, None).await;
}

#[tokio::test]
async fn held_cross_delete_result_survives_lost_sqlite_reply_without_an_owned_overlay() {
    loses_applied_checkpoint(
        LostCheckpoint::DeleteResult,
        Some(json!({"status":"failed", "retryCount":"0", "lastError":"departed owner failed after remote progress"})),
    ).await;
}
