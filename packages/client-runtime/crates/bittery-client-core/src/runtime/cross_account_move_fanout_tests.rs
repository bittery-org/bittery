//! One destination's retirement must reach every independently admitted source workflow.
use super::*;

const OTHER_SOURCE_ORIGIN: &str = "https://move-other-source.example.test";

struct FanoutHttp {
    primary: Arc<MoveHttp>,
    other_source: Arc<MoveHttp>,
    original_urls: Mutex<Vec<String>>,
}

impl FanoutHttp {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            primary: MoveHttp::new(),
            other_source: MoveHttp::new(),
            original_urls: Mutex::default(),
        })
    }

    fn set_offline(&self, offline: bool) {
        self.primary.offline.store(offline, Ordering::SeqCst);
        self.other_source.offline.store(offline, Ordering::SeqCst);
    }
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for FanoutHttp {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let mut value: Value = serde_json::from_str(&input).unwrap();
        let url = value["url"]
            .as_str()
            .expect("this fixture uses ordinary HTTP");
        self.original_urls.lock().unwrap().push(url.to_owned());
        if let Some(path) = url.strip_prefix(OTHER_SOURCE_ORIGIN) {
            // Only the controlled Server fixture routing changes. The real AuthHttp caller and
            // installed Account retain the third canonical origin and their original request.
            value["url"] = json!(format!("{SOURCE_ORIGIN}{path}"));
            self.other_source
                .invoke(Zeroizing::new(value.to_string()))
                .await
        } else {
            self.primary.invoke(input).await
        }
    }

    fn cancel(&self, dispatch_id: &str) {
        // IDs are unique across the Runtime; the executor which never saw one has nothing to cancel.
        self.primary.cancel(dispatch_id);
        self.other_source.cancel(dispatch_id);
    }
}

#[derive(Clone, Copy)]
enum CommitFailureTiming {
    Before,
    After,
}

struct FanoutReplica {
    sqlite: Arc<MoveSqlite>,
    commit_failure: Mutex<Option<(usize, CommitFailureTiming)>>,
    unreadable_source: Mutex<Option<(AccountId, usize)>>,
    failure_count: AtomicU64,
}

#[async_trait]
impl SerializedReplicaExecutor for FanoutReplica {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        let unreadable = if value["type"] == "load" {
            let mut source = self.unreadable_source.lock().unwrap();
            match source.as_mut() {
                Some((account_id, remaining)) if value["accountId"] == account_id.as_str() => {
                    if *remaining == 0 {
                        true
                    } else {
                        *remaining -= 1;
                        false
                    }
                }
                _ => false,
            }
        } else {
            false
        };
        if unreadable {
            self.failure_count.fetch_add(1, Ordering::SeqCst);
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "injected unreadable source inventory",
            ));
        }
        let failure = if value["type"] == "commit" {
            let mut remaining = self.commit_failure.lock().unwrap();
            match remaining.as_mut() {
                Some((0, timing)) => {
                    let timing = *timing;
                    *remaining = None;
                    Some(timing)
                }
                Some((count, _)) => {
                    *count -= 1;
                    None
                }
                None => None,
            }
        } else {
            None
        };
        if matches!(failure, Some(CommitFailureTiming::Before)) {
            self.failure_count.fetch_add(1, Ordering::SeqCst);
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "injected source retirement failure before SQLite commit",
            ));
        }
        let response = self.sqlite.invoke(request).await?;
        if matches!(failure, Some(CommitFailureTiming::After)) {
            let committed: Value = serde_json::from_str(&response).unwrap();
            assert_eq!(committed["type"], "committed");
            assert_eq!(committed["result"]["type"], "applied");
            self.failure_count.fetch_add(1, Ordering::SeqCst);
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "injected lost source retirement acknowledgement after SQLite commit",
            ));
        }
        Ok(response)
    }
}

fn fanout_runtime(
    persistence: Arc<dyn SerializedReplicaExecutor>,
    platform: Arc<dyn SerializedPlatformStorageExecutor>,
    http: Arc<FanoutHttp>,
) -> Arc<Runtime> {
    Runtime::with_configured_serialized_executors(
        persistence,
        platform,
        http,
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    )
}

async fn open_fanout_runtime(
    persistence: Arc<dyn SerializedReplicaExecutor>,
    platform: Arc<InstallationPlatform>,
    http: Arc<FanoutHttp>,
) -> Arc<Runtime> {
    let runtime = fanout_runtime(persistence, platform, http);
    runtime.open().await.unwrap();
    runtime
}

struct FanoutFixture {
    primary: AdmittedMoveFixture,
    other_source: AccountId,
    other_operation_id: String,
    http: Arc<FanoutHttp>,
    persistence: Arc<FanoutReplica>,
}

impl FanoutFixture {
    async fn new() -> Self {
        let database = MoveDatabase::new();
        let platform = Arc::new(InstallationPlatform::default());
        let sqlite = MoveSqlite::open(&database.0);
        let persistence = Arc::new(FanoutReplica {
            sqlite: sqlite.clone(),
            commit_failure: Mutex::new(None),
            unreadable_source: Mutex::new(None),
            failure_count: AtomicU64::new(0),
        });
        let http = FanoutHttp::new();
        let runtime =
            open_fanout_runtime(persistence.clone(), platform.clone(), http.clone()).await;
        let mut accounts = Vec::new();
        for origin in [SOURCE_ORIGIN, TARGET_ORIGIN, OTHER_SOURCE_ORIGIN] {
            let RuntimeResponse::SignedIn { account_id, .. } = runtime
                .request(
                    sign_in_request_to(origin, NORMALIZED_EMAIL),
                    RequestCancellation::new(),
                )
                .await
                .unwrap()
            else {
                panic!("each independent Account needs real public Sign-in");
            };
            let snapshot = runtime.require_snapshot(&account_id).unwrap();
            let metadata = runtime
                .platform_storage
                .load_account_metadata(&account_id, &snapshot.incarnation)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(metadata.normalized_server_url, origin);
            accounts.push(account_id);
        }
        let [source, target, other_source]: [AccountId; 3] = accounts.try_into().unwrap();
        assert_ne!(source, target);
        assert_ne!(other_source, target);
        assert_ne!(source, other_source);
        http.set_offline(true);
        let mut operations = Vec::new();
        for account_id in [&source, &other_source] {
            let request: RuntimeRequest = serde_json::from_value(json!({
                "type":"moveItem", "accountId":account_id, "itemId":SOURCE_ITEM,
                "targetAccountId":target, "targetVaultId":"vault-1"
            }))
            .unwrap();
            let RuntimeResponse::Accepted { operation_id, .. } = runtime
                .request(request, RequestCancellation::new())
                .await
                .unwrap()
            else {
                panic!("each source must durably accept its own Move");
            };
            assert_source_visible(&runtime, account_id, crate::ItemProjectionStatus::Pending);
            operations.push(operation_id);
        }
        let [operation_id, other_operation_id]: [String; 2] = operations.try_into().unwrap();
        assert_ne!(operation_id, other_operation_id);
        Self {
            primary: AdmittedMoveFixture {
                database,
                platform,
                http: http.primary.clone(),
                sqlite,
                runtime,
                source,
                target,
                operation_id,
            },
            other_source,
            other_operation_id,
            http,
            persistence,
        }
    }
}

fn assert_retired_image(before: &Value, after: &Value, operation_id: &str) {
    let before_rows = before["rows"].as_array().unwrap();
    let after_rows = after["rows"].as_array().unwrap();
    let mut expected = workflow(before_rows, operation_id);
    expected["destinationBinding"]["status"] = json!("retired");
    expected["destinationBinding"]["bindingRevision"] = json!("1");
    expected["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
    assert_eq!(workflow(after_rows, operation_id), expected);
    assert_eq!(
        before_rows
            .iter()
            .filter(|row| row["store"] != "crossAccountMoves")
            .collect::<Vec<_>>(),
        after_rows
            .iter()
            .filter(|row| row["store"] != "crossAccountMoves")
            .collect::<Vec<_>>(),
        "retiring a destination must preserve the source overlay and every unrelated row"
    );
    let mut expected_head = before["head"].clone();
    let revision = expected_head["replicaRevision"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    expected_head["replicaRevision"] = json!((revision + 1).to_string());
    assert_eq!(after["head"], expected_head);
}

#[tokio::test]
async fn second_source_retirement_failure_preserves_first_commit_and_reopens_before_ready() {
    assert_commit_failure_recovers(1, CommitFailureTiming::Before, 1).await;
}

#[tokio::test]
async fn first_source_retirement_failure_preserves_both_moves_until_reopen() {
    assert_commit_failure_recovers(0, CommitFailureTiming::Before, 0).await;
}

#[tokio::test]
async fn lost_first_source_retirement_ack_preserves_commit_and_reopens_before_ready() {
    assert_commit_failure_recovers(0, CommitFailureTiming::After, 1).await;
}

#[tokio::test]
async fn lost_second_source_retirement_ack_preserves_both_commits_and_reopens_before_ready() {
    assert_commit_failure_recovers(1, CommitFailureTiming::After, 2).await;
}

async fn assert_commit_failure_recovers(
    commits_before_failure: usize,
    timing: CommitFailureTiming,
    expected_retired_sources: usize,
) {
    let fixture = FanoutFixture::new().await;
    let _artifacts = install_target_cleanup(&fixture.primary);
    let sources = [
        (
            fixture.primary.source.clone(),
            fixture.primary.operation_id.clone(),
        ),
        (
            fixture.other_source.clone(),
            fixture.other_operation_id.clone(),
        ),
    ];
    let mut admitted = Vec::new();
    for (account_id, _) in &sources {
        admitted.push(saved_replica_image(&fixture.primary.sqlite.sqlite, account_id).await);
    }
    let target_before =
        saved_replica_image(&fixture.primary.sqlite.sqlite, &fixture.primary.target).await;
    *fixture.persistence.commit_failure.lock().unwrap() = Some((commits_before_failure, timing));
    let response = fixture
        .primary
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: fixture.primary.target.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        response,
        RuntimeResponse::Teardown {
            scope: crate::TeardownScope::Account {
                account_id: fixture.primary.target.clone()
            },
            status: crate::TeardownStatus::Incomplete,
            failures: vec![crate::TeardownPhase::Replica],
        }
    );
    assert_eq!(fixture.persistence.failure_count.load(Ordering::SeqCst), 1);
    let marked_catalog = fixture.primary.platform.catalog().unwrap();
    let marker = marked_catalog
        .accounts
        .iter()
        .find(|entry| entry.account_id == fixture.primary.target)
        .unwrap()
        .pending_retirement
        .as_ref()
        .unwrap();
    assert_eq!(
        marker.purpose,
        crate::platform_storage::AccountRetirementPurpose::Remove
    );
    assert_eq!(
        json!(marker.incarnation),
        target_before["head"]["incarnation"]
    );
    let mut partial = Vec::new();
    let mut retired_count = 0;
    for (index, (account_id, operation_id)) in sources.iter().enumerate() {
        let image = saved_replica_image(&fixture.primary.sqlite.sqlite, account_id).await;
        if workflow(image["rows"].as_array().unwrap(), operation_id)["destinationBinding"]["status"]
            == "retired"
        {
            assert_retired_image(&admitted[index], &image, operation_id);
            retired_count += 1;
        } else {
            assert_eq!(
                image, admitted[index],
                "failed source commit preserves all accepted bytes"
            );
        }
        partial.push(image);
    }
    assert_eq!(
        retired_count, expected_retired_sources,
        "only the source writes which committed before owner loss may be retired"
    );
    assert_eq!(
        saved_replica_image(&fixture.primary.sqlite.sqlite, &fixture.primary.target).await,
        target_before
    );

    let FanoutFixture {
        primary,
        other_source: _,
        other_operation_id: _,
        http,
        persistence,
    } = fixture;
    let AdmittedMoveFixture {
        database,
        platform,
        http: primary_http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    } = primary;
    let old_owner = Arc::downgrade(&runtime);
    drop(runtime);
    drop(persistence);
    drop(sqlite);
    assert!(old_owner.upgrade().is_none());
    let sqlite = MoveSqlite::open(&database.0);
    let runtime = open_fanout_runtime(sqlite.clone(), platform.clone(), http.clone()).await;
    for (index, (account_id, operation_id)) in sources.iter().enumerate() {
        let current = saved_replica_image(&sqlite.sqlite, account_id).await;
        assert_retired_image(&admitted[index], &current, operation_id);
        if workflow(partial[index]["rows"].as_array().unwrap(), operation_id)["destinationBinding"]
            ["status"]
            == "retired"
        {
            assert_eq!(
                current, partial[index],
                "startup must not double-retire the committed source"
            );
        }
        let sink = Arc::new(Sink::default());
        let observation = runtime
            .observe(
                ObservationRequest::Operations {
                    account_id: account_id.clone(),
                },
                sink.clone(),
            )
            .unwrap();
        let RuntimeProjection::Operations(operations) =
            sink.0.lock().unwrap().last().cloned().unwrap()
        else {
            panic!("expected ready Operations");
        };
        observation.close();
        assert_eq!(operations.operations.len(), 1);
        assert_eq!(&operations.operations[0].operation_id, operation_id);
        assert_eq!(
            operations.operations[0].resolution,
            OperationResolution::Pending
        );
        assert_eq!(
            operations.operations[0]
                .cross_account_move
                .as_ref()
                .unwrap()
                .disposition,
            crate::CrossAccountMoveDisposition::Blocked {
                reason: crate::CrossAccountMoveBlockedReason::DestinationRetired
            }
        );
    }
    assert_eq!(platform.catalog().unwrap(), marked_catalog);
    let refusal = runtime
        .request(
            quick_unlock_request(target.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(refusal.code, RuntimeErrorCode::AccountMissing);
    let reopened = AdmittedMoveFixture {
        database,
        platform,
        http: primary_http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    };
    let _retry_artifacts = remove_target(&reopened).await;
    assert!(!reopened
        .platform
        .catalog()
        .unwrap()
        .accounts
        .iter()
        .any(|entry| entry.account_id == reopened.target));
    for (index, (account_id, operation_id)) in sources.iter().enumerate() {
        assert_retired_image(
            &admitted[index],
            &saved_replica_image(&reopened.sqlite.sqlite, account_id).await,
            operation_id,
        );
    }
    assert!(http.primary.mutations(SOURCE_ORIGIN).is_empty());
    assert!(http.primary.mutations(TARGET_ORIGIN).is_empty());
    assert!(http.other_source.mutations(SOURCE_ORIGIN).is_empty());
    assert!(http
        .original_urls
        .lock()
        .unwrap()
        .iter()
        .any(|url| url.starts_with(OTHER_SOURCE_ORIGIN)));
    reopened.runtime.close().await;
}

#[tokio::test]
async fn unreadable_source_inventory_keeps_startup_unready_and_preserves_partial_retirement() {
    let FanoutFixture {
        primary,
        other_source,
        other_operation_id,
        http,
        persistence,
    } = FanoutFixture::new().await;
    let AdmittedMoveFixture {
        database,
        platform,
        http: _,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    } = primary;
    let sources = [(source, operation_id), (other_source, other_operation_id)];
    let mut admitted = Vec::new();
    for (account_id, _) in &sources {
        admitted.push(saved_replica_image(&sqlite.sqlite, account_id).await);
    }
    let target_before = saved_replica_image(&sqlite.sqlite, &target).await;
    let old_owner = Arc::downgrade(&runtime);
    drop(runtime);
    drop(persistence);
    drop(sqlite);
    assert!(old_owner.upgrade().is_none());

    // Restore the two real source generations with their accepted Active workflows but no
    // catalog destination. This is recovery input, not a bypass of current public Remove.
    let mut restored_catalog = platform.catalog().unwrap();
    restored_catalog
        .accounts
        .retain(|entry| entry.account_id != target);
    let restored_catalog = DeviceCatalogDocument::new(restored_catalog.accounts).unwrap();
    assert_eq!(restored_catalog.accounts.len(), 2);
    for (entry, (account_id, _)) in restored_catalog.accounts.iter().zip(&sources) {
        assert_eq!(&entry.account_id, account_id);
        assert!(entry.pending_install.is_none());
        assert!(entry.pending_retirement.is_none());
    }
    platform.put_document(
        "devicePlain",
        "bittery:runtime:platform-storage:device-catalog".into(),
        &restored_catalog,
    );
    let sqlite = MoveSqlite::open(&database.0);
    let persistence = Arc::new(FanoutReplica {
        sqlite: sqlite.clone(),
        commit_failure: Mutex::new(None),
        // Let startup validate the stored Account first, then refuse its retirement inventory.
        unreadable_source: Mutex::new(Some((sources[1].0.clone(), 1))),
        failure_count: AtomicU64::new(0),
    });
    let runtime = fanout_runtime(persistence.clone(), platform.clone(), http.clone());
    let failure = runtime.open().await.unwrap_err();
    assert_eq!(failure.code, RuntimeErrorCode::StorageUnavailable);
    assert_eq!(persistence.failure_count.load(Ordering::SeqCst), 1);
    let first_commit = saved_replica_image(&sqlite.sqlite, &sources[0].0).await;
    assert_retired_image(&admitted[0], &first_commit, &sources[0].1);
    assert_eq!(
        saved_replica_image(&sqlite.sqlite, &sources[1].0).await,
        admitted[1],
        "an unreadable source is never treated as an empty source"
    );
    let sink = Arc::new(Sink::default());
    let Err(failure) = runtime.observe(
        ObservationRequest::Operations {
            account_id: sources[0].0.clone(),
        },
        sink.clone(),
    ) else {
        panic!("partial retirement must not publish a ready Runtime");
    };
    assert_eq!(failure.code, RuntimeErrorCode::InvariantViolation);
    assert!(sink.0.lock().unwrap().is_empty());
    assert_eq!(
        runtime
            .request(
                quick_unlock_request(target.as_str()),
                RequestCancellation::new()
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::InvariantViolation
    );
    assert_eq!(platform.catalog().unwrap(), restored_catalog);
    assert_eq!(
        saved_replica_image(&sqlite.sqlite, &target).await,
        target_before
    );

    *persistence.unreadable_source.lock().unwrap() = None;
    runtime.open().await.unwrap();
    for (index, (account_id, operation_id)) in sources.iter().enumerate() {
        let current = saved_replica_image(&sqlite.sqlite, account_id).await;
        assert_retired_image(&admitted[index], &current, operation_id);
        if index == 0 {
            assert_eq!(
                current, first_commit,
                "retry preserves the first committed retirement"
            );
        }
        let sink = Arc::new(Sink::default());
        let observation = runtime
            .observe(
                ObservationRequest::Operations {
                    account_id: account_id.clone(),
                },
                sink.clone(),
            )
            .unwrap();
        let RuntimeProjection::Operations(operations) =
            sink.0.lock().unwrap().last().cloned().unwrap()
        else {
            panic!("successful retry must publish both retired workflows");
        };
        observation.close();
        assert_eq!(operations.operations.len(), 1);
        assert_eq!(&operations.operations[0].operation_id, operation_id);
        assert_eq!(
            operations.operations[0].resolution,
            OperationResolution::Pending
        );
        assert_eq!(
            operations.operations[0]
                .cross_account_move
                .as_ref()
                .unwrap()
                .disposition,
            crate::CrossAccountMoveDisposition::Blocked {
                reason: crate::CrossAccountMoveBlockedReason::DestinationRetired,
            }
        );
    }
    assert_eq!(platform.catalog().unwrap(), restored_catalog);
    assert_eq!(
        saved_replica_image(&sqlite.sqlite, &target).await,
        target_before
    );
    assert!(http.primary.mutations(SOURCE_ORIGIN).is_empty());
    assert!(http.primary.mutations(TARGET_ORIGIN).is_empty());
    assert!(http.other_source.mutations(SOURCE_ORIGIN).is_empty());
    runtime.close().await;
}

struct LostRetirementMarkerReply {
    platform: Arc<InstallationPlatform>,
    target: AccountId,
    incarnation: crate::protocol::Incarnation,
    fail_next_marker: AtomicBool,
    failures: AtomicU64,
}

#[async_trait]
impl SerializedPlatformStorageExecutor for LostRetirementMarkerReply {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        let marker = if value["type"] == "set"
            && value["key"] == "bittery:runtime:platform-storage:device-catalog"
        {
            let catalog: DeviceCatalogDocument =
                serde_json::from_str(value["value"].as_str().unwrap()).unwrap();
            catalog.accounts.iter().any(|entry| {
                entry.account_id == self.target
                    && entry.pending_retirement.as_ref().is_some_and(|intent| {
                        intent.incarnation == self.incarnation
                            && intent.purpose
                                == crate::platform_storage::AccountRetirementPurpose::Remove
                    })
            })
        } else {
            false
        };
        let response = self.platform.invoke(request).await?;
        if marker && self.fail_next_marker.swap(false, Ordering::SeqCst) {
            assert_eq!(
                serde_json::from_str::<Value>(&response).unwrap()["type"],
                "done"
            );
            self.failures.fetch_add(1, Ordering::SeqCst);
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "injected lost acknowledgement after the actual catalog retirement marker write",
            ));
        }
        Ok(response)
    }
}

#[tokio::test]
async fn lost_retirement_marker_ack_reopens_with_both_original_sources_retired() {
    let FanoutFixture {
        primary,
        other_source,
        other_operation_id,
        http,
        persistence,
    } = FanoutFixture::new().await;
    let AdmittedMoveFixture {
        database,
        platform,
        http: primary_http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    } = primary;
    let sources = [
        (source.clone(), operation_id.clone()),
        (other_source, other_operation_id),
    ];
    let mut admitted = Vec::new();
    for (account_id, _) in &sources {
        admitted.push(saved_replica_image(&sqlite.sqlite, account_id).await);
    }
    let target_before = saved_replica_image(&sqlite.sqlite, &target).await;
    let target_incarnation = runtime.require_snapshot(&target).unwrap().incarnation;
    let original_catalog = platform.catalog().unwrap();
    assert!(original_catalog
        .accounts
        .iter()
        .all(|entry| entry.pending_retirement.is_none()));

    // Reopen the actual accepted storage through a response-loss executor. It delegates every
    // write to the same platform store, then loses only the matching Remove marker response.
    let old_owner = Arc::downgrade(&runtime);
    drop(runtime);
    drop(persistence);
    drop(sqlite);
    assert!(old_owner.upgrade().is_none());
    let sqlite = MoveSqlite::open(&database.0);
    let platform_fault = Arc::new(LostRetirementMarkerReply {
        platform: platform.clone(),
        target: target.clone(),
        incarnation: target_incarnation.clone(),
        fail_next_marker: AtomicBool::new(true),
        failures: AtomicU64::new(0),
    });
    let runtime = fanout_runtime(sqlite.clone(), platform_fault.clone(), http.clone());
    runtime.open().await.unwrap();
    let response = runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: target.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        response,
        RuntimeResponse::Teardown {
            scope: crate::TeardownScope::Account {
                account_id: target.clone()
            },
            status: crate::TeardownStatus::Incomplete,
            failures: vec![crate::TeardownPhase::PlatformStorage],
        }
    );
    assert_eq!(platform_fault.failures.load(Ordering::SeqCst), 1);
    let mut expected_catalog = original_catalog;
    let target_entry = expected_catalog
        .accounts
        .iter_mut()
        .find(|entry| entry.account_id == target)
        .unwrap();
    target_entry.pending_retirement =
        Some(crate::platform_storage::PendingAccountRetirementIntent {
            incarnation: target_incarnation,
            purpose: crate::platform_storage::AccountRetirementPurpose::Remove,
        });
    assert_eq!(platform.catalog().unwrap(), expected_catalog);
    for (index, (account_id, _)) in sources.iter().enumerate() {
        assert_eq!(
            saved_replica_image(&sqlite.sqlite, account_id).await,
            admitted[index],
            "a lost marker reply starts neither source retirement nor target cleanup"
        );
    }
    assert_eq!(
        saved_replica_image(&sqlite.sqlite, &target).await,
        target_before
    );

    // Lose the Runtime and SQLite owner after the marker committed, before any fanout. Fresh
    // public open must read that durable marker and complete both sources before publication.
    let old_owner = Arc::downgrade(&runtime);
    drop(runtime);
    drop(platform_fault);
    drop(sqlite);
    assert!(old_owner.upgrade().is_none());
    let sqlite = MoveSqlite::open(&database.0);
    let runtime = open_fanout_runtime(sqlite.clone(), platform.clone(), http.clone()).await;
    for (index, (account_id, operation_id)) in sources.iter().enumerate() {
        assert_retired_image(
            &admitted[index],
            &saved_replica_image(&sqlite.sqlite, account_id).await,
            operation_id,
        );
        let sink = Arc::new(Sink::default());
        let observation = runtime
            .observe(
                ObservationRequest::Operations {
                    account_id: account_id.clone(),
                },
                sink.clone(),
            )
            .unwrap();
        let RuntimeProjection::Operations(operations) =
            sink.0.lock().unwrap().last().cloned().unwrap()
        else {
            panic!("ready publication must already carry both retirements");
        };
        observation.close();
        assert_eq!(operations.operations.len(), 1);
        assert_eq!(&operations.operations[0].operation_id, operation_id);
        assert_eq!(
            operations.operations[0].resolution,
            OperationResolution::Pending
        );
        assert_eq!(
            operations.operations[0]
                .cross_account_move
                .as_ref()
                .unwrap()
                .disposition,
            crate::CrossAccountMoveDisposition::Blocked {
                reason: crate::CrossAccountMoveBlockedReason::DestinationRetired,
            }
        );
    }
    assert_eq!(platform.catalog().unwrap(), expected_catalog);
    assert_eq!(
        saved_replica_image(&sqlite.sqlite, &target).await,
        target_before
    );
    assert_eq!(
        runtime
            .request(
                quick_unlock_request(target.as_str()),
                RequestCancellation::new()
            )
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::AccountMissing
    );
    let reopened = AdmittedMoveFixture {
        database,
        platform,
        http: primary_http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    };
    let _artifacts = remove_target(&reopened).await;
    for (index, (account_id, operation_id)) in sources.iter().enumerate() {
        assert_retired_image(
            &admitted[index],
            &saved_replica_image(&reopened.sqlite.sqlite, account_id).await,
            operation_id,
        );
    }
    assert!(http.primary.mutations(SOURCE_ORIGIN).is_empty());
    assert!(http.primary.mutations(TARGET_ORIGIN).is_empty());
    assert!(http.other_source.mutations(SOURCE_ORIGIN).is_empty());
    reopened.runtime.close().await;
}

#[path = "cross_account_move_identity_tests.rs"]
mod identity_tests;
