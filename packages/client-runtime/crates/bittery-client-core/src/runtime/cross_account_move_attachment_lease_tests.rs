use super::*;
use crate::runtime::foreground_attachment_lifecycle::ForegroundAttachmentTarget;
use crate::{AttachmentMoveAccountLease, AttachmentMoveAccountLeasePort};

struct LeaseState {
    live: AtomicBool,
    lost: tokio::sync::Notify,
    releases: AtomicUsize,
    released: tokio::sync::Semaphore,
}

struct ControlledLease(Arc<LeaseState>);

#[async_trait]
impl AttachmentMoveAccountLease for ControlledLease {
    fn is_live(&self) -> bool {
        self.0.live.load(Ordering::SeqCst)
    }

    async fn lost(&self) {
        loop {
            let notified = self.0.lost.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if !self.is_live() {
                return;
            }
            notified.await;
        }
    }
}

impl Drop for ControlledLease {
    fn drop(&mut self) {
        self.0.releases.fetch_add(1, Ordering::SeqCst);
        self.0.released.add_permits(1);
    }
}

struct ControlledLeasePort(Arc<LeaseState>);

#[async_trait]
impl AttachmentMoveAccountLeasePort for ControlledLeasePort {
    async fn acquire(
        &self,
        _: &AccountId,
    ) -> Result<Option<Box<dyn AttachmentMoveAccountLease>>, RuntimeError> {
        Ok(self.0.live.load(Ordering::SeqCst).then(|| {
            Box::new(ControlledLease(self.0.clone())) as Box<dyn AttachmentMoveAccountLease>
        }))
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Boundary {
    LoadBeforeCommit,
    IssuedCommit,
}

struct HeldCheckpoint {
    armed: Mutex<Option<(AccountId, String)>>,
    boundary: Boundary,
    held: AtomicBool,
    gate: MoveGate,
    finished: tokio::sync::Semaphore,
    issued_commits: AtomicUsize,
    proposed: Mutex<Option<Value>>,
}

struct PrimitiveLifetime(Arc<HeldCheckpoint>);

impl Drop for PrimitiveLifetime {
    fn drop(&mut self) {
        self.0.finished.add_permits(1);
    }
}

struct HeldReplica {
    sqlite: Arc<MoveSqlite>,
    checkpoint: Arc<HeldCheckpoint>,
    http: Arc<AttachmentHttp>,
}

#[async_trait]
impl SerializedReplicaExecutor for HeldReplica {
    async fn invoke(&self, input: String) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        let armed = self.checkpoint.armed.lock().unwrap().clone();
        let Some((account, operation)) = armed else {
            return self.sqlite.invoke(input).await;
        };
        let proposed = (request["type"] == "commit"
            && request["prepared"]["expected"]["accountId"] == account.as_str())
        .then(|| {
            request["prepared"]["writes"]
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
                .find(|record| {
                    record["children"][0]["result"]["result"]["type"] == "applied"
                        && record["stage"]["type"] == "attachments"
                })
        })
        .flatten();
        if let Some(proposed) = &proposed {
            self.checkpoint
                .issued_commits
                .fetch_add(1, Ordering::SeqCst);
            *self.checkpoint.proposed.lock().unwrap() = Some(proposed.clone());
        }
        let selected = match self.checkpoint.boundary {
            Boundary::IssuedCommit => proposed.is_some(),
            Boundary::LoadBeforeCommit => {
                request["type"] == "load"
                    && request["accountId"] == account.as_str()
                    // The single dispatcher can reach this source Load only after the
                    // actual target endpoint completed its Create response. Admission and
                    // all earlier reads happened while the target had no created Item.
                    && !self.http.actors.http.target.server.created_items().is_empty()
            }
        };
        if selected && !self.checkpoint.held.swap(true, Ordering::SeqCst) {
            let _lifetime = PrimitiveLifetime(self.checkpoint.clone());
            self.checkpoint.gate.hold().await;
            return self.sqlite.invoke(input).await;
        }
        self.sqlite.invoke(input).await
    }
}

#[tokio::test]
async fn lost_attachment_lease_during_final_load_prevents_commit_admission() {
    checkpoint_lease_history(Boundary::LoadBeforeCommit).await;
}

#[tokio::test]
async fn lost_attachment_lease_drains_issued_commit_without_adopting_its_checkpoint() {
    checkpoint_lease_history(Boundary::IssuedCommit).await;
}

async fn checkpoint_lease_history(boundary: Boundary) {
    let database = MoveDatabase::new();
    let artifact_database = MoveDatabase::new();
    let artifacts = Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
    let (http, binary) = attachment_ports(&database.0);
    let lease = Arc::new(LeaseState {
        live: AtomicBool::new(true),
        lost: tokio::sync::Notify::new(),
        releases: AtomicUsize::new(0),
        released: tokio::sync::Semaphore::new(0),
    });
    let checkpoint = Arc::new(HeldCheckpoint {
        armed: Mutex::new(None),
        boundary,
        held: AtomicBool::new(false),
        gate: MoveGate::new(),
        finished: tokio::sync::Semaphore::new(0),
        issued_commits: AtomicUsize::new(0),
        proposed: Mutex::new(None),
    });
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        Arc::new(HeldReplica {
            sqlite: MoveSqlite::open(&database.0),
            checkpoint: checkpoint.clone(),
            http: http.clone(),
        }),
        Arc::new(InstallationPlatform::default()),
        http.clone(),
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
        AttachmentMovePreparationFacade::new(artifacts.clone(), artifacts, binary.clone()),
        Arc::new(ControlledLeasePort(lease.clone())),
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
            panic!("both participating Users must complete actual SRP Sign-in");
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
                target_account_id: Some(target.clone()),
                target_vault_id: "vault-2".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("nonempty Move must be accepted before its dispatcher runs");
    };
    let source_before = runtime
        .replica
        .load_uncached(&source)
        .await
        .unwrap()
        .unwrap();
    let target_before = runtime
        .replica
        .load_uncached(&target)
        .await
        .unwrap()
        .unwrap();
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert!(accepted["children"][0]["result"].is_null());
    let cached_before = runtime.replica.snapshot(&source).unwrap();
    let device_revision_before = runtime.device_revision.load(Ordering::SeqCst);
    let observation = ObservationRequest::Operations {
        account_id: source.clone(),
    };
    let projected_before =
        serde_json::to_value(runtime.projection(&observation).unwrap().projection).unwrap();
    *checkpoint.armed.lock().unwrap() = Some((source.clone(), operation_id.clone()));
    http.actors.http.resumed.store(true, Ordering::SeqCst);
    http.actors.http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    let reached =
        tokio::time::timeout(Duration::from_secs(10), checkpoint.gate.reached.acquire()).await;
    if reached.is_err() {
        checkpoint.gate.release.add_permits(1);
        close_move_runtime(runtime, runner).await;
        panic!("actual TargetCreate proof never reached its guarded source checkpoint");
    }
    reached.unwrap().unwrap().forget();
    lease.live.store(false, Ordering::SeqCst);
    lease.lost.notify_waiters();
    let lease_released_before_reply =
        tokio::time::timeout(Duration::from_millis(100), lease.released.acquire())
            .await
            .map(|permit| permit.unwrap().forget())
            .is_ok();
    let guards_before_reply = [
        (&source_before, &accepted["source"]),
        (&target_before, &accepted["target"]),
    ]
    .map(|(snapshot, item)| {
        runtime.foreground_attachments.active_target_count(
            &snapshot.account_id,
            &snapshot.incarnation,
            ForegroundAttachmentTarget::Item {
                vault_id: item["vaultId"].as_str().unwrap().into(),
                item_id: item["id"].as_str().unwrap().into(),
            },
        )
    });
    let primitive_finished_before_reply = checkpoint
        .finished
        .try_acquire()
        .map(|permit| permit.forget())
        .is_ok();
    // Release every held primitive on both RED and GREEN paths before making assertions.
    checkpoint.gate.release.add_permits(1);
    if !primitive_finished_before_reply {
        tokio::time::timeout(Duration::from_secs(5), checkpoint.finished.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
    if !lease_released_before_reply {
        tokio::time::timeout(Duration::from_secs(5), lease.released.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
    }
    runner.abort();
    let _ = runner.await;
    let cached_after = runtime.replica.snapshot(&source).unwrap();
    let device_revision_after = runtime.device_revision.load(Ordering::SeqCst);
    let projected_after =
        serde_json::to_value(runtime.projection(&observation).unwrap().projection).unwrap();
    let source_after = runtime
        .replica
        .load_uncached(&source)
        .await
        .unwrap()
        .unwrap();
    let target_after = runtime
        .replica
        .load_uncached(&target)
        .await
        .unwrap()
        .unwrap();
    let workflow_after = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    let target_items = http
        .actors
        .http
        .target
        .server
        .created_items
        .lock()
        .unwrap()
        .clone();
    let proposed = checkpoint.proposed.lock().unwrap().clone();
    let projected = runtime.projection(&ObservationRequest::Items {
        account_id: source.clone(),
    });
    tokio::time::timeout(Duration::from_secs(5), runtime.close())
        .await
        .unwrap();

    assert_eq!(
        target_items.len(),
        1,
        "the actual target effect may already exist"
    );
    assert_eq!(
        target_items[0].id,
        accepted["target"]["id"].as_str().unwrap()
    );
    assert_eq!(target_after, target_before);
    match boundary {
        Boundary::LoadBeforeCommit => {
            assert_eq!(
                checkpoint.issued_commits.load(Ordering::SeqCst),
                0,
                "lease loss while loading must prevent Commit admission"
            );
            assert_eq!(source_after, source_before);
            assert_eq!(workflow_after, accepted);
            assert!(proposed.is_none());
        }
        Boundary::IssuedCommit => {
            assert!(
                !lease_released_before_reply,
                "issued Commit must retain its lease object until the reply drains"
            );
            assert!(!primitive_finished_before_reply);
            assert_eq!(
                guards_before_reply,
                [1, 1],
                "both Move foreground guards must remain until the issued Commit drains"
            );
            assert_eq!(checkpoint.issued_commits.load(Ordering::SeqCst), 1);
            let proposed = proposed.unwrap();
            assert_eq!(
                proposed["children"][0]["result"]["result"]["type"],
                "applied"
            );
            let mut expected_row = accepted;
            expected_row["children"][0]["result"] = proposed["children"][0]["result"].clone();
            expected_row["stage"] = proposed["stage"].clone();
            assert_eq!(
                proposed, expected_row,
                "the issued request retains only the original proof and next stage"
            );
            assert_eq!(workflow_after, expected_row);
            let mut expected_snapshot = source_before;
            expected_snapshot.revision += 1;
            *expected_snapshot
                .cross_account_moves
                .iter_mut()
                .find(|record| record.operation_id() == operation_id)
                .unwrap() = serde_json::from_value(expected_row).unwrap();
            assert_eq!(
                source_after, expected_snapshot,
                "an already issued atomic Commit may durably complete unchanged"
            );
        }
    }
    assert_eq!(
        cached_after, cached_before,
        "the lost owner cannot adopt its late checkpoint into the cache"
    );
    assert_eq!(device_revision_after, device_revision_before);
    assert_eq!(projected_after, projected_before);
    assert_eq!(lease.releases.load(Ordering::SeqCst), 1);
    assert_eq!(binary.downloads.load(Ordering::SeqCst), 0);
    assert_eq!(binary.uploads.load(Ordering::SeqCst), 0);
    let RuntimeProjection::Items(items) = projected.unwrap().projection else {
        panic!("source Items remain visible");
    };
    assert_eq!(items.items.len(), 1);
    assert_eq!(items.items[0].status, crate::ItemProjectionStatus::Pending);
}
