//! Public accepted intent survives fresh Attachment refusals using the ordinary durable scheduler.
use super::*;
use crate::runtime::operation_fixtures::TestClock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Refusal {
    Online,
    SourceForbidden,
    GrantForbidden,
    GrantQuota,
    GrantSize400,
    GrantSize413,
    GrantConflict { retryable: bool },
    RegistrationForbidden,
    RegistrationQuota,
    RegistrationConflict { retryable: bool },
    RegistrationLost { unavailable_current: bool },
}

struct RefusalHttp {
    inner: Arc<AttachmentHttp>,
    mode: Mutex<Refusal>,
    unavailable_current: AtomicBool,
    requests: Mutex<Vec<RecordedRequest>>,
}

fn refusal_problem(status: u16, code: &str, retryable: bool) -> String {
    let body = json!({
        "type":"https://bittery.com/problems/attachment", "title":"Attachment unavailable",
        "status":status, "code":code, "detail":"opaque current policy",
        "instance":"urn:bittery:request:attachment-refusal", "requestId":"attachment-refusal",
        "retryable":retryable, "errors":null
    });
    json!({"type":"completed", "status":status,
        "headers":[{"name":"content-type","value":"application/problem+json"}],
        "body":serde_json::to_vec(&body).unwrap()
    })
    .to_string()
}

#[async_trait]
impl SerializedHttpExecutor for RefusalHttp {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        if request.get("url").is_none() {
            return self.inner.invoke(input).await;
        }
        let recorded = attachment_request(&request);
        let mode = *self.mode.lock().unwrap();
        let source = recorded.method == "POST"
            && recorded
                .url
                .ends_with(&format!("/{SOURCE_ATTACHMENT}/download-urls"));
        let grant = recorded.method == "POST" && recorded.url.ends_with("/attachment-uploads");
        let registration = recorded.method == "POST" && recorded.url.ends_with("/attachments");
        self.requests.lock().unwrap().push(recorded.clone());
        if self.unavailable_current.load(Ordering::SeqCst) && recorded.method == "GET" {
            let target_id = self
                .inner
                .actors
                .http
                .target
                .server
                .created_items
                .lock()
                .unwrap()
                .first()
                .map(|item| item.id.clone());
            if target_id
                .is_some_and(|id| recorded.url == format!("{SOURCE_ORIGIN}/api/v1/items/{id}"))
            {
                return Ok(json!({"type":"networkFailure"}).to_string());
            }
        }
        let problem = match mode {
            Refusal::SourceForbidden if source => Some((403, "FORBIDDEN", false)),
            Refusal::GrantForbidden if grant => Some((403, "FORBIDDEN", false)),
            Refusal::GrantQuota if grant => Some((403, "ATTACHMENT_QUOTA_EXCEEDED", false)),
            Refusal::GrantSize400 if grant => Some((400, "BAD_REQUEST", false)),
            Refusal::GrantSize413 if grant => Some((413, "BAD_REQUEST", false)),
            Refusal::GrantConflict { retryable } if grant => Some((409, "CONFLICT", retryable)),
            Refusal::RegistrationForbidden if registration => Some((403, "FORBIDDEN", false)),
            Refusal::RegistrationQuota if registration => {
                Some((403, "ATTACHMENT_QUOTA_EXCEEDED", false))
            }
            Refusal::RegistrationConflict { retryable } if registration => {
                Some((409, "CONFLICT", retryable))
            }
            _ => None,
        };
        if let Some((status, code, retryable)) = problem {
            return Ok(refusal_problem(status, code, retryable));
        }
        let answer = self.inner.invoke(input).await?;
        if let Refusal::RegistrationLost {
            unavailable_current,
        } = mode
        {
            if registration {
                let completed: Value = serde_json::from_str(&answer).unwrap();
                assert_eq!(completed["type"], "completed");
                assert_eq!(
                    completed["status"], 200,
                    "the actual fixture must commit registration before losing its reply"
                );
                // Keep the original server's complete Attachment metadata; discard only its
                // successful reply, and optionally make later exact current reads unavailable.
                self.unavailable_current
                    .store(unavailable_current, Ordering::SeqCst);
                return Ok(json!({"type":"networkFailure"}).to_string());
            }
        }
        Ok(answer)
    }

    fn cancel(&self, dispatch_id: &str) {
        self.inner.cancel(dispatch_id);
    }
}

impl RefusalHttp {
    fn set(&self, mode: Refusal) {
        *self.mode.lock().unwrap() = mode;
        self.unavailable_current.store(false, Ordering::SeqCst);
    }

    fn calls(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    fn renewals(&self) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.url.ends_with("/sessions/current/refresh"))
            .count()
    }

    fn matching(&self, suffix: &str) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == "POST" && request.url.ends_with(suffix))
            .cloned()
            .collect()
    }
}

struct RefusalFixture {
    database: MoveDatabase,
    _artifact_database: MoveDatabase,
    artifacts: Arc<SqliteAttachmentArtifactStore>,
    platform: Arc<InstallationPlatform>,
    http: Arc<RefusalHttp>,
    binary: Arc<AttachmentBinary>,
    clock: Arc<TestClock>,
    runtime: Option<Arc<Runtime>>,
    source: AccountId,
    target: AccountId,
    operation_id: String,
    accepted: Value,
}

impl RefusalFixture {
    async fn open(
        database: &Path,
        artifacts: Arc<SqliteAttachmentArtifactStore>,
        platform: Arc<InstallationPlatform>,
        http: Arc<RefusalHttp>,
        binary: Arc<AttachmentBinary>,
        clock: Arc<TestClock>,
    ) -> Arc<Runtime> {
        let runtime = Runtime::with_persistence(
            Arc::new(SerializedReplicaPersistence::new(MoveSqlite::open(
                database,
            ))),
            Arc::new(PlatformStorage::for_platform(
                platform,
                ClientPlatform::Desktop,
            )),
            Arc::new(HttpTransport::new(http)),
            Some(
                AuthClientConfig::new(
                    "client-routing".into(),
                    ClientPlatform::Desktop,
                    "0.5.2-test".into(),
                )
                .unwrap(),
            ),
            Some((
                AttachmentMovePreparationFacade::new(artifacts.clone(), artifacts, binary),
                Arc::new(crate::runtime::attachment_move_lifecycle::TestAccountLeasePort),
            )),
            false,
            clock,
            Arc::new(SystemDeviceTimer),
            None,
        );
        runtime.open().await.unwrap();
        runtime
    }

    async fn new() -> Self {
        let database = MoveDatabase::new();
        let artifact_database = MoveDatabase::new();
        let artifacts =
            Arc::new(SqliteAttachmentArtifactStore::open(&artifact_database.0).unwrap());
        let platform = Arc::new(InstallationPlatform::default());
        let (inner, binary) = attachment_ports(&database.0);
        let http = Arc::new(RefusalHttp {
            inner,
            mode: Mutex::new(Refusal::Online),
            unavailable_current: AtomicBool::new(false),
            requests: Mutex::new(Vec::new()),
        });
        let clock = TestClock::new();
        let runtime = Self::open(
            &database.0,
            artifacts.clone(),
            platform.clone(),
            http.clone(),
            binary.clone(),
            clock.clone(),
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
                panic!("each User must complete public SRP Sign-in")
            };
            accounts.push(account_id);
        }
        let [source, target]: [AccountId; 2] = accounts.try_into().unwrap();
        http.inner.actors.http.offline.store(true, Ordering::SeqCst);
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
            panic!("valid manifest must be admitted")
        };
        let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
        http.inner.actors.http.resumed.store(true, Ordering::SeqCst);
        http.inner
            .actors
            .http
            .offline
            .store(false, Ordering::SeqCst);
        http.inner.actors.http.trash_result.release.add_permits(1);
        http.inner.actors.http.delete_result.release.add_permits(1);
        Self {
            database,
            _artifact_database: artifact_database,
            artifacts,
            platform,
            http,
            binary,
            clock,
            runtime: Some(runtime),
            source,
            target,
            operation_id,
            accepted,
        }
    }

    fn runtime(&self) -> &Arc<Runtime> {
        self.runtime.as_ref().unwrap()
    }

    async fn record(&self) -> Value {
        workflow(
            &durable_rows(&self.database.0, &self.source).await,
            &self.operation_id,
        )
    }

    async fn step(&self) {
        tokio::time::timeout(
            Duration::from_secs(10),
            self.runtime().dispatch_eligible_operations(),
        )
        .await
        .expect("one eligible dispatch pass must settle");
    }

    async fn next_failure(&self, previous_attempts: u64) -> Value {
        for _ in 0..12 {
            self.step().await;
            let record = self.record().await;
            if record["scheduling"]["attemptCount"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                > previous_attempts
            {
                return record;
            }
        }
        panic!(
            "fresh refusal was not durably scheduled: {:?}",
            self.record().await
        );
    }

    async fn before_deadline(&self, record: &Value) {
        let deadline = record["scheduling"]["notBeforeMs"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        self.clock.0.store(deadline - 1, Ordering::SeqCst);
        let calls = self.http.calls();
        self.step().await;
        assert_eq!(
            self.http.calls(),
            calls,
            "durable retry deadline must prevent every early HTTP call"
        );
        assert_eq!(
            self.record().await,
            *record,
            "early dispatch may not rewrite accepted evidence or scheduling"
        );
        self.clock.0.store(deadline, Ordering::SeqCst);
    }

    async fn reopen_before_deadline(&mut self, record: &Value) {
        let deadline = record["scheduling"]["notBeforeMs"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        self.clock.0.store(deadline - 1, Ordering::SeqCst);
        let prior = self.runtime.take().unwrap();
        let weak = Arc::downgrade(&prior);
        drop(prior);
        assert!(
            weak.upgrade().is_none(),
            "the former Runtime owner must actually be gone"
        );
        self.runtime = Some(
            Self::open(
                &self.database.0,
                self.artifacts.clone(),
                self.platform.clone(),
                self.http.clone(),
                self.binary.clone(),
                self.clock.clone(),
            )
            .await,
        );
        assert_eq!(
            self.record().await,
            *record,
            "startup must retain the original durable deadline"
        );
        for account in [&self.source, &self.target] {
            self.runtime()
                .request(
                    RuntimeRequest::QuickUnlock {
                        account_id: account.clone(),
                        master_password: MASTER_PASSWORD.into(),
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
        }
        assert_eq!(
            self.record().await,
            *record,
            "explicit unlock must not reset durable backoff"
        );
        self.before_deadline(record).await;
    }
}

#[path = "cross_account_move_attachment_evidence_tests.rs"]
mod evidence_tests;

#[path = "cross_account_move_attachment_stream_tests.rs"]
mod stream_tests;

#[tokio::test]
async fn renewable_attachment_refusals_keep_one_intent_and_capped_deadlines_across_owner_loss() {
    let mut fixture = RefusalFixture::new().await;
    let mut sealed: Option<Value> = None;
    let mut registration: Option<Value> = None;
    let mut original_artifact: Option<(AttachmentArtifactOwner, String, Vec<u8>)> = None;
    let scenarios = [
        (Refusal::SourceForbidden, "attachmentAccessDenied", 1_000),
        (Refusal::GrantForbidden, "attachmentAccessDenied", 2_000),
        (Refusal::GrantQuota, "attachmentQuotaExceeded", 4_000),
        (Refusal::GrantSize400, "attachmentSizeRejected", 8_000),
        (Refusal::GrantSize413, "attachmentSizeRejected", 16_000),
        (
            Refusal::GrantConflict { retryable: true },
            "offline",
            32_000,
        ),
        (Refusal::GrantForbidden, "attachmentAccessDenied", 64_000),
        (Refusal::GrantQuota, "attachmentQuotaExceeded", 128_000),
        (Refusal::GrantForbidden, "attachmentAccessDenied", 256_000),
        (Refusal::GrantQuota, "attachmentQuotaExceeded", 300_000),
        (Refusal::GrantForbidden, "attachmentAccessDenied", 300_000),
        (
            Refusal::RegistrationForbidden,
            "attachmentAccessDenied",
            300_000,
        ),
        (
            Refusal::RegistrationQuota,
            "attachmentQuotaExceeded",
            300_000,
        ),
    ];
    for (index, (mode, reason, delay)) in scenarios.into_iter().enumerate() {
        fixture.http.set(mode);
        let now = fixture.clock.0.load(Ordering::SeqCst);
        let renewals = fixture.http.renewals();
        let record = fixture.next_failure(index as u64).await;
        assert_eq!(
            record["disposition"],
            json!({"type":"waiting", "reason":reason})
        );
        assert_eq!(
            record["scheduling"]["attemptCount"],
            (index + 1).to_string()
        );
        assert_eq!(
            record["scheduling"]["notBeforeMs"],
            (now + delay).to_string()
        );
        assert_eq!(
            fixture.http.renewals(),
            renewals,
            "fresh non-401 refusal must not renew a Session"
        );
        assert_eq!(record["source"], fixture.accepted["source"]);
        assert_eq!(record["target"], fixture.accepted["target"]);
        assert_eq!(
            record["attachments"][0]["targetMetadata"],
            fixture.accepted["attachments"][0]["targetMetadata"]
        );
        assert_eq!(
            record["stage"],
            json!({"type":"attachments", "nextIndex":0})
        );
        assert_source_visible(
            fixture.runtime(),
            &fixture.source,
            ItemProjectionStatus::Pending,
        );
        assert_eq!(
            resolution(fixture.runtime(), &fixture.source, &fixture.operation_id),
            OperationResolution::Pending
        );
        if mode == Refusal::SourceForbidden {
            assert_eq!(record["attachments"][0]["progress"]["type"], "pending");
            assert_eq!(fixture.binary.downloads.load(Ordering::SeqCst), 0);
            assert!(fixture.http.matching("/attachment-uploads").is_empty());
        } else if let Some(sealed) = &sealed {
            assert_eq!(
                record["attachments"], *sealed,
                "refusals cannot regenerate fixed metadata, grant or artifact"
            );
        } else {
            sealed = Some(record["attachments"].clone());
            let owner = checkpoint_owner(&record, &fixture.source);
            original_artifact = Some((
                owner.clone(),
                publication_generation(&fixture.artifacts, &owner)
                    .await
                    .unwrap(),
                stored_ciphertext(&fixture.artifacts, &owner).await.unwrap(),
            ));
        }
        if let Some(child) = record["children"].as_array().unwrap().get(1) {
            assert_eq!(child["type"], "attachmentRegistration");
            assert!(
                child["result"].is_null(),
                "a refusal is no registration or Item outcome"
            );
            if let Some(expected) = &registration {
                assert_eq!(child, expected);
            } else {
                registration = Some(child.clone());
            }
        }
        if index == 2 {
            fixture.reopen_before_deadline(&record).await;
        } else {
            fixture.before_deadline(&record).await;
        }
    }
    let grants = fixture.http.matching("/attachment-uploads");
    for grant in &grants[1..] {
        assert_exact_retry(grant, &grants[0]);
    }
    let registrations = fixture.http.matching("/attachments");
    assert_eq!(registrations.len(), 2);
    assert_exact_retry(&registrations[1], &registrations[0]);
    assert!(
        fixture
            .http
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.method != "DELETE"),
        "no source destruction may precede proved target Attachment registration"
    );
    let (owner, generation, bytes) = original_artifact.unwrap();
    assert_eq!(
        publication_generation(&fixture.artifacts, &owner)
            .await
            .unwrap(),
        generation
    );
    assert_eq!(
        stored_ciphertext(&fixture.artifacts, &owner).await.unwrap(),
        bytes
    );
    assert_eq!(
        fixture.binary.downloads.load(Ordering::SeqCst),
        2,
        "one Scan and one Transcrypt suffice through all retries"
    );
    fixture.http.set(Refusal::Online);
    for _ in 0..12 {
        if fixture.record().await["stage"]["type"] == "completed" {
            break;
        }
        fixture.step().await;
    }
    let completed = fixture.record().await;
    fixture.runtime().close().await;
    assert_eq!(completed["stage"]["type"], "completed");
    assert_eq!(completed["attachments"], sealed.unwrap());
    assert_eq!(
        completed["children"][1]["request"],
        registration.unwrap()["request"]
    );
    assert_eq!(completed["children"][1]["result"]["type"], "acknowledged");
    assert_eq!(
        completed["children"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|child| child["type"] == "itemOperation"
                && child["result"]["result"]["type"] == "applied")
            .count(),
        3
    );
}
