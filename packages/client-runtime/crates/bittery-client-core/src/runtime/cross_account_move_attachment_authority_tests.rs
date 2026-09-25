//! Changed current file authority cannot reuse an earlier registration proof to destroy the source.
use super::*;

#[derive(Clone, Copy)]
enum CurrentFileChange {
    SourceFileRemoved,
    ProvedTargetFileRemoved,
    ProvedTargetFileEdited,
}

async fn changed_current_files_preserve_the_accepted_move(change: CurrentFileChange) {
    let fixture = RefusalFixture::new().await;
    let proved = until(&fixture, |record| record["stage"]["type"] == "sourceTrash").await;
    assert_eq!(proved["disposition"], json!({"type":"ready"}));
    assert_eq!(proved["children"].as_array().unwrap().len(), 2);
    assert_eq!(proved["children"][0]["result"]["result"]["type"], "applied");
    assert_eq!(proved["children"][1]["result"]["type"], "acknowledged");
    assert_eq!(fixture.binary.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.binary.uploads.load(Ordering::SeqCst), 1);
    let grants = fixture.http.matching("/attachment-uploads");
    let registrations = fixture.http.matching("/attachments");
    assert_eq!(registrations.len(), 1);

    let source_server = &fixture.http.inner.actors.http.source.server;
    let target_server = &fixture.http.inner.actors.http.target.server;
    let source_files = source_server.attachments.lock().unwrap().clone();
    let target_files = target_server.attachments.lock().unwrap().clone();
    assert_eq!(source_files.len(), 1);
    assert_eq!(target_files.len(), 1);
    assert_eq!(source_files[0]["id"], SOURCE_ATTACHMENT);
    assert_eq!(
        target_files[0]["id"],
        proved["attachments"][0]["targetAttachmentId"]
    );
    let target_items = target_server.created_items();
    assert_eq!(target_items.len(), 1);
    let owner = checkpoint_owner(&proved, &fixture.source);
    let generation = publication_generation(&fixture.artifacts, &owner)
        .await
        .unwrap();
    let ciphertext = stored_ciphertext(&fixture.artifacts, &owner).await.unwrap();
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let requests_before = fixture.http.calls();

    // These change the existing Server's current metadata only. The accepted ciphertext,
    // durable child result, and Runtime's local authority remain the original values.
    let reason = match change {
        CurrentFileChange::SourceFileRemoved => {
            source_server.set_attachment_authority(Vec::new());
            "sourceChanged"
        }
        CurrentFileChange::ProvedTargetFileRemoved => {
            target_server.set_attachment_authority(Vec::new());
            "targetChanged"
        }
        CurrentFileChange::ProvedTargetFileEdited => {
            let mut edited = target_files.clone();
            edited[0]["fileSize"] = json!(target_files[0]["fileSize"].as_u64().unwrap() + 1);
            target_server.set_attachment_authority(edited);
            "targetChanged"
        }
    };
    fixture.step().await;
    let blocked = fixture.record().await;
    let mut expected = proved.clone();
    expected["disposition"] = json!({"type":"blocked", "reason":reason});
    assert_eq!(
        blocked, expected,
        "current file changes must preserve all fixed accepted evidence"
    );
    assert_eq!(
        resolution(fixture.runtime(), &fixture.source, &fixture.operation_id),
        OperationResolution::Pending
    );
    assert_source_visible(
        fixture.runtime(),
        &fixture.source,
        ItemProjectionStatus::Pending,
    );
    let RuntimeProjection::Operations(operations) = fixture
        .runtime()
        .projection(&ObservationRequest::Operations {
            account_id: fixture.source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Operations")
    };
    let public_move = serde_json::to_value(
        operations.operations[0]
            .cross_account_move
            .as_ref()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(public_move["disposition"], expected["disposition"]);
    assert_eq!(public_move["sourceVisible"], true);

    {
        let requests = fixture.http.requests.lock().unwrap();
        let current_reads = &requests[requests_before..];
        let changed_item = match change {
            CurrentFileChange::SourceFileRemoved => proved["source"]["id"].as_str().unwrap(),
            _ => proved["target"]["id"].as_str().unwrap(),
        };
        assert!(
            current_reads.iter().any(
                |request| request.url == format!("{SOURCE_ORIGIN}/api/v1/items/{changed_item}")
            ),
            "the changed authority must be observed over HTTP"
        );
        assert!(
            current_reads.iter().all(|request| request.method == "GET"),
            "a stale registration proof must not authorize source destruction, reupload, or compensation"
        );
        assert!(requests.iter().all(|request| request.method != "DELETE"));
    }
    let non_workflow_rows = |rows: Vec<Value>| {
        rows.into_iter()
            .filter(|row| row["store"] != "crossAccountMoves")
            .collect::<Vec<_>>()
    };
    assert_eq!(
        non_workflow_rows(durable_rows(&fixture.database.0, &fixture.source).await),
        non_workflow_rows(source_rows)
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    assert_eq!(target_server.created_items(), target_items);
    {
        let source_items = source_server.created_items.lock().unwrap();
        assert_eq!(source_items.len(), 1);
        assert_eq!(source_items[0].version, 1);
        assert!(source_items[0].deleted_at.is_none());
    }

    let calls = fixture.http.calls();
    fixture.clock.advance(86_400_000);
    fixture.step().await;
    assert_eq!(
        fixture.http.calls(),
        calls,
        "blocked work must remain unscheduled"
    );
    assert_eq!(fixture.record().await, blocked);
    assert_eq!(
        fixture.http.matching("/attachment-uploads").len(),
        grants.len()
    );
    assert_eq!(
        fixture.http.matching("/attachments").len(),
        registrations.len()
    );
    assert_eq!(fixture.binary.downloads.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.binary.uploads.load(Ordering::SeqCst), 1);
    assert_eq!(
        publication_generation(&fixture.artifacts, &owner)
            .await
            .unwrap(),
        generation
    );
    assert_eq!(
        stored_ciphertext(&fixture.artifacts, &owner).await.unwrap(),
        ciphertext
    );
    fixture.runtime().close().await;
}

#[tokio::test]
async fn changed_source_file_set_blocks_before_source_trash_and_preserves_all_proofs() {
    changed_current_files_preserve_the_accepted_move(CurrentFileChange::SourceFileRemoved).await;
}

#[tokio::test]
async fn missing_proved_target_file_blocks_before_source_trash_and_preserves_all_proofs() {
    changed_current_files_preserve_the_accepted_move(CurrentFileChange::ProvedTargetFileRemoved)
        .await;
}

#[tokio::test]
async fn edited_proved_target_file_blocks_before_source_trash_and_preserves_all_proofs() {
    changed_current_files_preserve_the_accepted_move(CurrentFileChange::ProvedTargetFileEdited)
        .await;
}
