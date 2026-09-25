//! Public Resume enriches only the original registration proof and destination binding.
use super::*;

async fn assert_original_artifact(
    fixture: &RefusalFixture,
    owner: &AttachmentArtifactOwner,
    generation: &str,
    ciphertext: &[u8],
) {
    assert_eq!(
        publication_generation(&fixture.artifacts, owner)
            .await
            .unwrap(),
        generation
    );
    assert_eq!(
        stored_ciphertext(&fixture.artifacts, owner).await.unwrap(),
        ciphertext
    );
}

fn assert_only_current_reads(requests: &[RecordedRequest], source_id: &str, target_id: &str) {
    assert!(
        requests.iter().all(|request| request.method == "GET"),
        "Prepare and confirmation must not replay a proved Item request or create an Attachment effect"
    );
    for item_id in [source_id, target_id] {
        assert!(requests
            .iter()
            .any(|request| { request.url == format!("{SOURCE_ORIGIN}/api/v1/items/{item_id}") }));
    }
}

#[tokio::test]
async fn explicit_attachment_resume_proves_lost_registration_without_rewriting_or_reuploading() {
    let fixture = RefusalFixture::new().await;
    fixture.http.set(Refusal::RegistrationLost {
        unavailable_current: true,
    });
    let waiting = fixture.next_failure(0).await;
    assert_eq!(
        waiting["disposition"],
        json!({"type":"waiting", "reason":"offline"})
    );
    assert_eq!(
        waiting["stage"],
        json!({"type":"attachments", "nextIndex":0})
    );
    assert_eq!(waiting["children"].as_array().unwrap().len(), 2);
    assert!(waiting["children"][1]["result"].is_null());
    let committed = fixture
        .http
        .inner
        .actors
        .http
        .target
        .server
        .attachments
        .lock()
        .unwrap()
        .clone();
    assert_eq!(
        committed.len(),
        1,
        "registration really committed before its reply was lost"
    );
    let owner = checkpoint_owner(&waiting, &fixture.source);
    let generation = publication_generation(&fixture.artifacts, &owner)
        .await
        .unwrap();
    let ciphertext = stored_ciphertext(&fixture.artifacts, &owner).await.unwrap();
    assert_eq!(fixture.binary.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.binary.uploads.load(Ordering::SeqCst), 1);
    let grants = fixture.http.matching("/attachment-uploads");
    assert!(!grants.is_empty());
    for grant in &grants {
        assert_exact_retry(grant, &grants[0]);
    }
    assert_eq!(
        grants[0].body,
        serde_json::from_value::<Vec<u8>>(
            waiting["attachments"][0]["progress"]["grantRequest"]["body"].clone()
        )
        .unwrap()
    );
    let registration = fixture.http.matching("/attachments");
    assert_eq!(registration.len(), 1);
    assert_eq!(
        registration[0].body,
        serde_json::from_value::<Vec<u8>>(waiting["children"][1]["request"]["body"].clone())
            .unwrap()
    );
    fixture.before_deadline(&waiting).await;

    fixture
        .platform
        .allow_teardown_prefixes
        .store(true, Ordering::SeqCst);
    fixture
        .runtime()
        .install_teardown_host_cleanup(Arc::new(ScopedCleanup(fixture.target.clone())));
    let removed = fixture
        .runtime()
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: fixture.target.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(
        matches!(removed, RuntimeResponse::Teardown {
        status: crate::TeardownStatus::Complete, ref failures, ..
    } if failures.is_empty()),
        "target Remove must finish its real artifact and catalog cleanup: {removed:?}"
    );
    let retired = fixture.record().await;
    let mut expected_retired = waiting.clone();
    expected_retired["destinationBinding"]["status"] = json!("retired");
    expected_retired["destinationBinding"]["bindingRevision"] = json!("1");
    expected_retired["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
    assert_eq!(
        retired, expected_retired,
        "retirement must preserve every accepted byte and unproved request"
    );
    assert_original_artifact(&fixture, &owner, &generation, &ciphertext).await;

    fixture.http.set(Refusal::Online);
    let RuntimeResponse::SignedIn {
        account_id: replacement,
        ..
    } = fixture
        .runtime()
        .request(
            sign_in_request_to(SOURCE_ORIGIN, OTHER_USER.normalized_email),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("the original destination User must complete a fresh public Sign-in")
    };
    assert_ne!(replacement, fixture.target);
    assert_eq!(
        fixture.record().await,
        retired,
        "same-User Sign-in must not resume accepted work"
    );
    assert_original_artifact(&fixture, &owner, &generation, &ciphertext).await;

    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &replacement).await;
    let source_revision = fixture
        .runtime()
        .require_snapshot(&fixture.source)
        .unwrap()
        .revision;
    let requests_before = fixture.http.calls();
    let prepared = fixture
        .runtime()
        .request(
            serde_json::from_value(json!({
                "type":"prepareCrossAccountMoveResume", "accountId":fixture.source,
                "operationId":fixture.operation_id, "targetAccountId":replacement,
                "expectedBindingRevision":"1"
            }))
            .unwrap(),
            RequestCancellation::new(),
        )
        .await
        .expect("read-only Prepare must recognize the original artifact and current registration");
    let prepared = serde_json::to_value(prepared).unwrap();
    assert_eq!(prepared["type"], "crossAccountMoveResumePrepared");
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_rows
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &replacement).await,
        target_rows
    );
    assert_eq!(
        fixture
            .runtime()
            .require_snapshot(&fixture.source)
            .unwrap()
            .revision,
        source_revision
    );
    assert_original_artifact(&fixture, &owner, &generation, &ciphertext).await;
    assert_only_current_reads(
        &fixture.http.requests.lock().unwrap()[requests_before..],
        waiting["source"]["id"].as_str().unwrap(),
        waiting["target"]["id"].as_str().unwrap(),
    );

    let requests_before = fixture.http.calls();
    let accepted = fixture
        .runtime()
        .request(
            serde_json::from_value(
                json!({"type":"resumeCrossAccountMove", "guard":prepared["guard"]}),
            )
            .unwrap(),
            RequestCancellation::new(),
        )
        .await
        .expect("explicit confirmation must durably enrich the same registration and rebind");
    assert!(
        matches!(accepted, RuntimeResponse::Accepted { ref operation_id, .. } if operation_id == &fixture.operation_id)
    );
    assert_eq!(
        fixture
            .runtime()
            .require_snapshot(&fixture.source)
            .unwrap()
            .revision,
        source_revision + 1,
        "confirmation must commit proof enrichment and reauthorization in one source revision"
    );
    let rebound = fixture.record().await;
    let mut expected = retired;
    expected["destinationBinding"] = json!({
        "accountId":replacement,
        "incarnation":fixture.runtime().require_snapshot(&replacement).unwrap().incarnation,
        "bindingRevision":"2", "status":"active"
    });
    expected["disposition"] = json!({"type":"ready"});
    expected["children"][1]["result"] =
        json!({"type":"verifiedPresent", "attachment":committed[0]});
    assert_eq!(
        rebound, expected,
        "confirmation may only enrich exact current proof and reauthorize the destination"
    );
    let remaining_rows = |rows: Vec<Value>| {
        rows.into_iter()
            .filter(|row| row["store"] != "crossAccountMoves")
            .collect::<Vec<_>>()
    };
    assert_eq!(
        remaining_rows(durable_rows(&fixture.database.0, &fixture.source).await),
        remaining_rows(source_rows)
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &replacement).await,
        target_rows
    );
    assert_original_artifact(&fixture, &owner, &generation, &ciphertext).await;
    assert_only_current_reads(
        &fixture.http.requests.lock().unwrap()[requests_before..],
        waiting["source"]["id"].as_str().unwrap(),
        waiting["target"]["id"].as_str().unwrap(),
    );

    let completed = until(&fixture, |record| record["stage"]["type"] == "completed").await;
    assert_eq!(
        resolution(fixture.runtime(), &fixture.source, &fixture.operation_id),
        OperationResolution::Applied
    );
    fixture.runtime().close().await;
    assert_eq!(completed["source"], waiting["source"]);
    assert_eq!(completed["target"], waiting["target"]);
    assert_eq!(completed["attachments"], waiting["attachments"]);
    assert_eq!(completed["children"][0], waiting["children"][0]);
    assert_eq!(completed["children"][1], rebound["children"][1]);
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
    assert_eq!(
        fixture.binary.downloads.load(Ordering::SeqCst),
        2,
        "Resume must not retranscrypt the accepted file"
    );
    assert_eq!(
        fixture.binary.uploads.load(Ordering::SeqCst),
        1,
        "current registration proof must prevent another PUT"
    );
    let after_grants = fixture.http.matching("/attachment-uploads");
    assert_eq!(
        after_grants.len(),
        grants.len(),
        "Resume must not request another grant"
    );
    for (actual, original) in after_grants.iter().zip(&grants) {
        assert_exact_retry(actual, original);
    }
    let after = fixture.http.matching("/attachments");
    assert_eq!(
        after.len(),
        1,
        "the registration's current proof must prevent any registration replay"
    );
    assert_exact_retry(&after[0], &registration[0]);
    assert!(fixture
        .http
        .inner
        .actors
        .http
        .source
        .server
        .created_items()
        .is_empty());
}
