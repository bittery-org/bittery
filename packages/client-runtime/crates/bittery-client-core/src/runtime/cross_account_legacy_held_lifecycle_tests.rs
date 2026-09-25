//! Register beneath cross_account_legacy_remote_progress_tests.rs.
use super::*;
use crate::runtime::dispatch::DispatchPass;

#[tokio::test]
async fn held_cross_public_destination_remove_preserves_the_original_retired_hold_across_reopen() {
    let (mut fixture, original) =
        admitted_legacy_move_with_history(json!({"status":"failed"}), None).await;
    // Every original proof exists: only the actual Account retirement prevents this recovery.
    establish_prefix(&fixture, &original, RemotePrefix::Deleted, None);
    let source_authority = fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .bootstrap;
    let source_evidence = server_evidence(&fixture.http.source.server);
    let target_evidence = server_evidence(&fixture.http.target.server);
    let _artifacts = super::super::super::retirement_tests::remove_target(&fixture).await;
    let retired = current(&fixture);
    let mut expected = original.clone();
    expected.destination_binding.status = CrossAccountMoveBindingStatus::Retired;
    expected.destination_binding.binding_revision = 1;
    expected.disposition = CrossAccountMoveDisposition::Blocked {
        reason: crate::replica::CrossAccountMoveBlockedReason::DestinationRetired,
    };
    assert_eq!(retired, expected);
    assert_eq!(retired.destination_binding.account_id, fixture.target);
    assert!(fixture.runtime.replica.snapshot(&fixture.target).is_none());
    assert!(!fixture
        .platform
        .catalog()
        .unwrap()
        .accounts
        .iter()
        .any(|entry| entry.account_id == fixture.target));
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.source)
            .unwrap()
            .bootstrap,
        source_authority
    );
    let rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let requests = fixture.http.requests.lock().unwrap().len();
    let source = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .dispatch_cross_account_move(&source, SEMANTIC)
            .await,
        DispatchPass::Parked
    ));
    assert_eq!(fixture.http.requests.lock().unwrap().len(), requests);
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        rows
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Authoritative,
    );
    fixture.runtime.close().await;
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    fixture.runtime = open_move_runtime(
        fixture.sqlite.clone(),
        fixture.platform.clone(),
        fixture.http.clone(),
    )
    .await;
    assert_eq!(fixture.http.requests.lock().unwrap().len(), requests);
    assert_eq!(
        fixture.runtime.account_access_state(&fixture.source),
        Some(AccountAccessState::Locked)
    );
    assert!(fixture.runtime.replica.snapshot(&fixture.target).is_none());
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            SEMANTIC
        ),
        serde_json::to_value(&retired).unwrap()
    );
    fixture
        .runtime
        .request(
            quick_unlock_request(fixture.source.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let source = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let after_unlock_requests = fixture.http.requests.lock().unwrap().len();
    assert_eq!(current(&fixture), retired);
    assert!(matches!(
        fixture
            .runtime
            .dispatch_cross_account_move(&source, SEMANTIC)
            .await,
        DispatchPass::Parked
    ));
    assert_eq!(
        fixture.http.requests.lock().unwrap().len(),
        after_unlock_requests
    );
    assert_eq!(current(&fixture), retired);
    assert_eq!(
        resolution(&fixture.runtime, &fixture.source, SEMANTIC),
        OperationResolution::LegacyFailed
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    assert_eq!(
        server_evidence(&fixture.http.source.server),
        source_evidence
    );
    assert_eq!(
        server_evidence(&fixture.http.target.server),
        target_evidence
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn held_cross_public_source_sign_out_preserves_work_but_prevents_original_proof_reads() {
    let (fixture, original) =
        admitted_legacy_move_with_history(json!({"status":"conflicted"}), None).await;
    establish_prefix(&fixture, &original, RemotePrefix::Deleted, None);
    let source_before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    assert!(fixture
        .runtime
        .has_live_master_unlock_key(&fixture.source, &source_before.incarnation));
    let source_evidence = server_evidence(&fixture.http.source.server);
    let target_evidence = server_evidence(&fixture.http.target.server);
    let response = fixture
        .runtime
        .request(
            RuntimeRequest::SignOut {
                account_id: fixture.source.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        response,
        RuntimeResponse::AccessChanged {
            account_id: fixture.source.clone(),
            access: AccountAccessState::SignedOut
        }
    );
    assert!(!fixture
        .runtime
        .has_live_master_unlock_key(&fixture.source, &source_before.incarnation));
    assert!(!fixture.platform.has_document(
        fixture.source.as_str(),
        source_before.incarnation.as_str(),
        "quick-unlock"
    ));
    assert!(!fixture.platform.has_document(
        fixture.source.as_str(),
        source_before.incarnation.as_str(),
        "current-session"
    ));
    let source_after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(source_after.bootstrap, source_before.bootstrap);
    assert_eq!(source_after.items, source_before.items);
    assert_eq!(source_after.cross_account_moves, vec![original.into()]);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target_before
    );
    let durable = durable_rows(&fixture.database.0, &fixture.source).await;
    let requests = fixture.http.requests.lock().unwrap().len();
    assert!(matches!(
        fixture
            .runtime
            .dispatch_cross_account_move(&source_before, SEMANTIC)
            .await,
        DispatchPass::Parked
    ));
    assert!(matches!(
        fixture
            .runtime
            .dispatch_cross_account_move(&source_after, SEMANTIC)
            .await,
        DispatchPass::Parked
    ));
    assert_eq!(fixture.http.requests.lock().unwrap().len(), requests);
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        source_after
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        durable
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    assert_eq!(
        server_evidence(&fixture.http.source.server),
        source_evidence
    );
    assert_eq!(
        server_evidence(&fixture.http.target.server),
        target_evidence
    );
    fixture.runtime.close().await;
}
