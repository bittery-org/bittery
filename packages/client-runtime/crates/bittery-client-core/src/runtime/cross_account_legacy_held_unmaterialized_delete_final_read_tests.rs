//! A newly absent final read requires a fresh explicit attempt to derive the missing Delete.
use super::*;
use crate::http_transport::SerializedHttpExecutor;
use std::sync::atomic::AtomicUsize;

struct DeleteBeforeFinalSourceRead {
    inner: Arc<MoveHttp>,
    original_delete: RecordedRequest,
    armed: AtomicBool,
    source_reads: AtomicUsize,
}

#[async_trait]
impl SerializedHttpExecutor for DeleteBeforeFinalSourceRead {
    async fn invoke(&self, input: Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&input).unwrap();
        if self.armed.load(Ordering::SeqCst)
            && request["method"] == "GET"
            && request["url"] == format!("{SOURCE_ORIGIN}/api/v1/items/{SOURCE_ITEM}")
            && self.source_reads.fetch_add(1, Ordering::SeqCst) == 1
        {
            self.armed.store(false, Ordering::SeqCst);
            // Establish the original historical effect through the maintained handler, including
            // its real current CAS precondition. This is another client's request, not Core replay.
            let version = self.inner.source.server.created_items.lock().unwrap()[0].version;
            assert_eq!(
                self.original_delete.header("If-Match"),
                Some(format!("\"{version}\"").as_str())
            );
            let mut wire = self.original_delete.clone();
            wire.url = format!(
                "{SERVER_URL}{}",
                wire.url.strip_prefix(SOURCE_ORIGIN).unwrap()
            );
            let response = self
                .inner
                .source
                .server
                .handle_existing_item_mutation(&wire);
            assert_eq!(response["type"], "completed");
            assert_eq!(response["status"], 200);
            let body: Vec<u8> = serde_json::from_value(response["body"].clone()).unwrap();
            let outcome: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(outcome["operationId"], format!("{SEMANTIC}:delete-source"));
            assert_eq!(
                outcome["result"],
                json!({"status":"applied", "itemId":SOURCE_ITEM, "version":version + 1})
            );
        }
        self.inner.invoke(input).await
    }

    fn cancel(&self, request_id: &str) {
        self.inner.cancel(request_id);
    }
}

#[tokio::test]
async fn absence_first_seen_on_confirmation_final_read_requires_a_new_explicit_attempt() {
    let (mut fixture, original, _artifacts) = readded_source_delete("failed", false).await;
    let recorder = Arc::new(RecordCompletionCommits {
        inner: fixture.sqlite.clone(),
        commits: Mutex::default(),
    });
    let http = Arc::new(DeleteBeforeFinalSourceRead {
        inner: fixture.http.clone(),
        original_delete: legacy_request(&original, CrossAccountMoveStep::SourceDelete),
        armed: AtomicBool::new(false),
        source_reads: AtomicUsize::new(0),
    });
    super::super::super::recovery_tests::reopen_with_http(
        &mut fixture,
        recorder.clone(),
        http.clone(),
    )
    .await;
    let before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let observed = CompletionObservations::start(&fixture);
    let guard = prepare(&fixture, 1).await;
    let lookup = format!("{SOURCE_ORIGIN}/api/v1/operations/{SEMANTIC}:delete-source");
    assert!(!fixture
        .http
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.url == lookup));
    let start = fixture.http.requests.lock().unwrap().len();
    http.armed.store(true, Ordering::SeqCst);
    let error = fixture
        .runtime
        .request(
            RuntimeRequest::ResumeCrossAccountMove { guard },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(http.source_reads.load(Ordering::SeqCst), 2);
    assert!(!http.armed.load(Ordering::SeqCst));
    assert!(fixture.http.source.server.created_items().is_empty());
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        before
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_rows
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    assert!(recorder.commits.lock().unwrap().is_empty());
    assert_eq!(
        before.cross_account_moves[0]
            .captured()
            .unwrap()
            .children
            .len(),
        2
    );
    assert!(before.items.is_empty());
    {
        let requests = fixture.http.requests.lock().unwrap();
        let recent = &requests[start..];
        assert!(recent.iter().all(|r| r.method == "GET"));
        assert!(!recent.iter().any(|r| r.url.contains("/operations/")));
        let current_url = format!("{SOURCE_ORIGIN}/api/v1/items/{SOURCE_ITEM}");
        assert_eq!(recent.iter().filter(|r| r.url == current_url).count(), 2);
    }
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    observed.assert_no_pending();
    let expected = expected_completion(&before, &target, "legacyFailed");
    let guard = prepare(&fixture, 1).await;
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        before
    );
    assert!(recorder.commits.lock().unwrap().is_empty());
    fixture.http.delete_result.release.add_permits(2);
    let start = fixture.http.requests.lock().unwrap().len();
    confirm(&fixture, guard).await;
    assert_lookup_then_final_reads(&fixture, start);
    assert_final_commit(&fixture, &recorder, &before, &expected).await;
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    let mutations = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(mutations.len(), 2);
    assert_original_request(&mutations[1], &http.original_delete);
    assert_eq!(fixture.http.source.server.outcomes.lock().unwrap().len(), 2);
    observed.assert_completed();
    observed.close();
    fixture.runtime.close().await;
}
