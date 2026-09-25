//! Explicit Resume retains the original canonical Server and User identity.
use super::*;

#[tokio::test]
async fn resume_refuses_same_user_on_another_server_without_changing_either_workflow() {
    let fixture = FanoutFixture::new().await;
    let _artifacts = remove_target(&fixture.primary).await;
    let source_before = durable_rows(&fixture.primary.database.0, &fixture.primary.source).await;
    let candidate_before = durable_rows(&fixture.primary.database.0, &fixture.other_source).await;
    let retired = workflow(&source_before, &fixture.primary.operation_id);
    assert_eq!(retired["destinationBinding"]["status"], "retired");

    // The candidate is independently installed, unlocked, and writable, with the same Server
    // User ID. Only its canonical Server differs from the original accepted destination.
    let candidate = fixture
        .primary
        .runtime
        .require_snapshot(&fixture.other_source)
        .unwrap();
    assert_eq!(
        candidate.bootstrap.state,
        crate::replica::ReplicaState::Ready
    );
    assert_eq!(
        fixture
            .primary
            .runtime
            .account_access_state(&fixture.other_source),
        Some(AccountAccessState::Unlocked)
    );
    assert_eq!(
        json!(candidate.user_id),
        retired["destinationIdentity"]["userId"]
    );
    let metadata = fixture
        .primary
        .runtime
        .platform_storage
        .load_account_metadata(&fixture.other_source, &candidate.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(metadata.normalized_server_url, OTHER_SOURCE_ORIGIN);
    assert_ne!(
        json!(metadata.normalized_server_url),
        retired["destinationIdentity"]["serverUrl"]
    );
    let RuntimeProjection::Items(items) = fixture
        .primary
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: fixture.other_source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected candidate Items")
    };
    assert!(items.vaults.iter().any(
        |vault| vault.vault_id == "vault-1" && vault.role == crate::VaultProjectionRole::Owner
    ));

    fixture.http.set_offline(false);
    let requests_before = fixture.http.original_urls.lock().unwrap().len();
    let request = serde_json::from_value(json!({
        "type":"prepareCrossAccountMoveResume",
        "accountId":fixture.primary.source,
        "operationId":fixture.primary.operation_id,
        "targetAccountId":fixture.other_source,
        "expectedBindingRevision":retired["destinationBinding"]["bindingRevision"],
    }))
    .unwrap();
    let error = fixture
        .primary
        .runtime
        .request(request, RequestCancellation::new())
        .await
        .expect_err("another canonical Server cannot receive the original Move binding");
    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(
        fixture.http.original_urls.lock().unwrap().len(),
        requests_before,
        "canonical identity refusal must precede any remote authority or dispatch request"
    );
    assert_eq!(
        durable_rows(&fixture.primary.database.0, &fixture.primary.source).await,
        source_before
    );
    assert_eq!(
        durable_rows(&fixture.primary.database.0, &fixture.other_source).await,
        candidate_before
    );
    for account in [&fixture.primary.source, &fixture.other_source] {
        assert_source_visible(
            &fixture.primary.runtime,
            account,
            crate::ItemProjectionStatus::Pending,
        );
    }
    assert_eq!(
        resolution(
            &fixture.primary.runtime,
            &fixture.primary.source,
            &fixture.primary.operation_id
        ),
        OperationResolution::Pending
    );
    assert_eq!(
        resolution(
            &fixture.primary.runtime,
            &fixture.other_source,
            &fixture.other_operation_id
        ),
        OperationResolution::Pending
    );
    for http in [&fixture.http.primary, &fixture.http.other_source] {
        assert!(http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(http.mutations(TARGET_ORIGIN).is_empty());
        assert!(http.source.server.outcomes.lock().unwrap().is_empty());
        assert!(http.target.server.outcomes.lock().unwrap().is_empty());
    }
    tokio::time::timeout(Duration::from_secs(5), fixture.primary.runtime.close())
        .await
        .unwrap();
}

#[path = "cross_account_move_actor_tests.rs"]
mod actor_tests;
