//! The held missing-source owner permits a distinct current same-Item command.
use super::super::sync_tests::{current_source_network, install_current_source};
use super::*;
use bittery_client_core::RuntimeResponse;

#[tokio::test]
async fn failed_missing_source_allows_independent_favorite_after_actual_current_sync_and_reopen() {
    let (source, command, auth) =
        protected_crash_source_from(&failed_independent_deletion_oracle());
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let network = current_source_network(auth);
    let runtime = authenticated_runtime(&directory, platform.clone(), network.clone()).await;
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: source.clone(),
        })
        .await
        .unwrap();
    runtime.open().await.unwrap();
    let original = row(
        &snapshot(&directory, desktop::ACCOUNT).await,
        "crossAccountMoves",
    );
    let semantic = command["operationId"].as_str().unwrap();
    runtime
        .request(
            RuntimeRequest::QuickUnlock {
                account_id: desktop::ACCOUNT.into(),
                master_password: PASSWORD.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(snapshot(&directory, desktop::ACCOUNT).await["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "authorityItems"));
    install_current_source(&runtime, &directory, &network).await;
    let synced = snapshot(&directory, desktop::ACCOUNT).await;
    assert_eq!(row(&synced, "crossAccountMoves"), original);
    assert!(synced["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "optimisticItems" && row["store"] != "operations"));
    assert_failed_projection(&runtime, semantic);
    let requests = network.request_log();
    let RuntimeResponse::Accepted { operation_id, .. } = runtime
        .request(
            RuntimeRequest::SetItemFavorite {
                account_id: desktop::ACCOUNT.into(),
                item_id: "source:item/雪".into(),
                favorite: true,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("new independent Favorite accepted")
    };
    assert_ne!(operation_id, semantic);
    assert!(![
        format!("{semantic}:create-target"),
        format!("{semantic}:trash-source"),
        format!("{semantic}:delete-source")
    ]
    .contains(&operation_id));
    assert_eq!(
        network.request_log(),
        requests,
        "acceptance creates no remote effect"
    );
    let accepted = snapshot(&directory, desktop::ACCOUNT).await;
    let target = snapshot(&directory, SECOND_ACCOUNT).await;
    assert_eq!(row(&accepted, "crossAccountMoves"), original);
    let operation = row(&accepted, "operations");
    assert_eq!(operation["operationId"], operation_id);
    let overlay = row(&accepted, "optimisticItems");
    assert_eq!(overlay["operationId"], operation_id);
    assert_ne!(overlay["operationId"], semantic);
    assert_failed_projection(&runtime, semantic);
    assert_independent_favorite(&runtime);
    runtime.close().await;
    let source_calls = source.calls.lock().unwrap().len();
    let reopened = authenticated_runtime(&directory, platform, network.clone()).await;
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    assert_eq!(network.request_log(), requests);
    assert_eq!(
        snapshot(&directory, desktop::ACCOUNT).await["rows"],
        accepted["rows"]
    );
    assert_eq!(
        snapshot(&directory, SECOND_ACCOUNT).await["rows"],
        target["rows"]
    );
    assert_failed_projection(&reopened, semantic);
    reopened
        .request(
            RuntimeRequest::QuickUnlock {
                account_id: desktop::ACCOUNT.into(),
                master_password: PASSWORD.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let restored = snapshot(&directory, desktop::ACCOUNT).await;
    assert_eq!(row(&restored, "crossAccountMoves"), original);
    assert_eq!(row(&restored, "operations"), operation);
    assert_eq!(row(&restored, "optimisticItems"), overlay);
    assert_independent_favorite(&reopened);
    assert_failed_projection(&reopened, semantic);
    assert_eq!(source.calls.lock().unwrap().len(), source_calls);
    reopened.close().await;
}

fn assert_independent_favorite(runtime: &Arc<Runtime>) {
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::Items {
                account_id: desktop::ACCOUNT.into(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Items(items) = sink.0.lock().unwrap().last().cloned().unwrap() else {
        panic!("Items")
    };
    assert_eq!(items.items.len(), 1);
    assert!(items.items[0].favorite);
    observation.close();
}
