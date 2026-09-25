//! Real incoming Native restrictions retire either participant of a held cross-Account attempt.
use super::*;

#[tokio::test]
async fn native_target_vault_hide_drains_committed_trash_and_preserves_the_source_workflow() {
    assert_native_participant_hide(false).await;
}

#[tokio::test]
async fn native_source_vault_hide_drains_committed_trash_and_erases_only_selected_authority() {
    assert_native_participant_hide(true).await;
}

async fn assert_native_participant_hide(retire_source: bool) {
    let mut http = MoveHttp::new();
    let server = Arc::get_mut(&mut http).unwrap();
    server.source.auth.accepted_client_platforms =
        &[ClientPlatform::Desktop, ClientPlatform::Extension];
    server.target.auth.accepted_client_platforms =
        &[ClientPlatform::Desktop, ClientPlatform::Extension];
    server.source.include_login_vault_keys = true;
    server.target.include_login_vault_keys = true;
    let fixture =
        AdmittedMoveFixture::with_http_and_platform(http, ClientPlatform::Extension).await;
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let (selected, unaffected, origin, endpoint) = if retire_source {
        (
            &fixture.source,
            &fixture.target,
            SOURCE_ORIGIN,
            &fixture.http.source,
        )
    } else {
        (
            &fixture.target,
            &fixture.source,
            TARGET_ORIGIN,
            &fixture.http.target,
        )
    };

    // This independently signed-in Desktop publishes actual verified policy for the same Server
    // and User. The Extension keeps its own two Sessions; no native import is performed.
    let publisher_database = MoveDatabase::new();
    let publisher = open_move_runtime(
        MoveSqlite::open(&publisher_database.0),
        Arc::new(InstallationPlatform::default()),
        fixture.http.clone(),
    )
    .await;
    let RuntimeResponse::SignedIn {
        account_id: publisher_account,
        ..
    } = publisher
        .request(
            sign_in_request_to(origin, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("independent Desktop publisher must Sign in publicly");
    };
    let publisher_control = publisher.native_authority();
    let consumer_control = fixture.runtime.native_authority();
    let initial = publisher_control
        .attach_source("cross-move-extension".into(), "publisher-port".into())
        .unwrap();
    assert!(initial.restrictions.is_empty());
    let publisher_channel = initial.channel_id.clone();
    let consumer_channel = consumer_control
        .attach_desktop(initial, "consumer-port".into())
        .await
        .unwrap();
    for account in [&fixture.source, &fixture.target] {
        let current = fixture.runtime.require_snapshot(account).unwrap();
        let persisted = fixture
            .runtime
            .platform_storage
            .load_current_session(account, &current.incarnation)
            .await
            .unwrap()
            .unwrap();
        let effective = fixture
            .runtime
            .effective_session(account, &current.incarnation)
            .await
            .unwrap()
            .unwrap();
        for session in [&persisted, &effective] {
            assert!(
                session
                    .vault_keys
                    .iter()
                    .any(|key| key.vault_id == "vault-1"),
                "actual Session keys must be present before selective retirement can erase them"
            );
        }
    }

    let runner = tokio::spawn(fixture.runtime.clone().run_operation_dispatch());
    fixture
        .http
        .trash_result
        .wait("committed source trash before Native participant retirement")
        .await;
    let before = durable_rows(&fixture.database.0, &fixture.source).await;
    let unaffected_before = durable_rows(&fixture.database.0, unaffected).await;
    let unaffected_snapshot_before = fixture
        .runtime
        .replica
        .load_uncached(unaffected)
        .await
        .unwrap()
        .unwrap();
    let accepted = workflow(&before, &fixture.operation_id);
    let children = accepted["children"].as_array().unwrap();
    assert_eq!(children.len(), 2);
    assert_eq!(children[0]["result"]["result"]["type"], "applied");
    assert_eq!(children[1]["step"]["type"], "sourceTrash");
    assert!(children[1]["result"].is_null());
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    let target_effect = fixture.http.target.server.created_items();
    assert_eq!(target_effect.len(), 1);
    {
        let remote = fixture.http.source.server.created_items.lock().unwrap();
        assert_eq!(remote[0].version, 2);
        assert!(remote[0].deleted_at.is_some());
    }
    let selected_before = fixture.runtime.require_snapshot(selected).unwrap();
    assert!(selected_before
        .bootstrap
        .pending_vault_retirements
        .is_empty());

    *endpoint.travel_policy.lock().unwrap() = Some(TravelModeResponse {
        enabled: true,
        enabled_at: Some("2029-01-03T00:00:00Z".into()),
        hidden_vault_ids: vec!["vault-1".into()],
        updated_at: "2029-01-03T00:00:00Z".into(),
    });
    tokio::time::timeout(
        Duration::from_secs(5),
        publisher.request(
            RuntimeRequest::RefreshTravelMode {
                account_id: publisher_account,
            },
            RequestCancellation::new(),
        ),
    )
    .await
    .expect("Desktop must verify the actual HTTP policy and complete its local hide")
    .unwrap();
    let restricted = publisher_control
        .source_snapshot(&publisher_channel)
        .unwrap();
    assert_eq!(restricted.restrictions.len(), 1);
    assert_eq!(restricted.restrictions[0].vault_ids, vec!["vault-1"]);
    let request = Zeroizing::new(
        serde_json::to_string(&crate::NativeAuthorityRequest::ApplyAuthority {
            channel_id: consumer_channel,
            source: restricted,
        })
        .unwrap(),
    );
    let adopted =
        tokio::time::timeout(Duration::from_secs(5), consumer_control.invoke(request)).await;
    if adopted.is_err() {
        runner.abort();
        let _ = runner.await;
        panic!("incoming selected Vault retirement must cancel the held cross-Move registration");
    }
    let response = adopted.unwrap().unwrap();
    assert!(matches!(
        serde_json::from_str::<crate::NativeAuthorityResponse>(&response).unwrap(),
        crate::NativeAuthorityResponse::Applied
    ));

    // Adoption is insufficient by itself: observe the actual durable cleanup and Session key
    // removal. This no-file fixture has no image or ordinary Attachment Move cleanup duties.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let current = fixture.runtime.require_snapshot(selected).unwrap();
            let session = fixture
                .runtime
                .platform_storage
                .load_current_session(selected, &current.incarnation)
                .await
                .unwrap()
                .unwrap();
            let complete = current.bootstrap.pending_vault_retirements.is_empty()
                && current
                    .bootstrap
                    .vaults
                    .keys()
                    .all(|(_, id)| id != "vault-1")
                && session
                    .vault_keys
                    .iter()
                    .all(|key| key.vault_id != "vault-1");
            drop(session);
            if complete {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the existing retirement dispatcher must complete the selected participant duty");
    let retired = fixture
        .runtime
        .replica
        .load_uncached(selected)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retired.incarnation, selected_before.incarnation);
    assert_eq!(retired.lock_epoch, selected_before.lock_epoch);
    assert!(retired.revision > selected_before.revision);
    assert!(retired.bootstrap.pending_vault_retirements.is_empty());
    assert!(retired
        .bootstrap
        .vaults
        .keys()
        .all(|(_, id)| id != "vault-1"));
    for account in [&fixture.source, &fixture.target] {
        assert_eq!(
            fixture.runtime.account_access_state(account),
            Some(AccountAccessState::Unlocked),
            "a selective Vault hide must not pass by locking a participant Account"
        );
        let current = fixture.runtime.require_snapshot(account).unwrap();
        let session = fixture
            .runtime
            .effective_session(account, &current.incarnation)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            session.provenance,
            crate::platform_storage::SessionProvenance::Independent
        ));
        assert_eq!(session.token.as_ref(), "fresh-token");
        assert_eq!(
            session
                .vault_keys
                .iter()
                .any(|key| key.vault_id == "vault-1"),
            account == unaffected,
        );
    }
    if retire_source {
        assert!(retired.items.iter().all(|item| item.vault_id != "vault-1"));
        assert!(retired
            .bootstrap
            .items
            .values()
            .all(|item| item.vault_id != "vault-1"));
        let sink = Arc::new(Sink::default());
        let observation = fixture
            .runtime
            .observe(
                ObservationRequest::Items {
                    account_id: fixture.source.clone(),
                },
                sink.clone(),
            )
            .unwrap();
        let RuntimeProjection::Items(items) = sink.0.lock().unwrap().last().cloned().unwrap()
        else {
            panic!("expected public Items after source retirement");
        };
        assert!(
            items.items.is_empty(),
            "retired source plaintext cannot remain in its observer"
        );
        assert!(items.vaults.is_empty());
        observation.close();
    } else {
        assert_source_visible(
            &fixture.runtime,
            &fixture.source,
            crate::ItemProjectionStatus::Pending,
        );
    }
    let sink = Arc::new(Sink::default());
    let observation = fixture
        .runtime
        .observe(
            ObservationRequest::Operations {
                account_id: fixture.source.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Operations(operations) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("expected public retained Operations after selective retirement");
    };
    assert_eq!(operations.operations.len(), 1);
    let operation = &operations.operations[0];
    assert_eq!(operation.operation_id, fixture.operation_id);
    assert_eq!(operation.resolution, OperationResolution::Pending);
    let movement = operation.cross_account_move.as_ref().unwrap();
    assert_eq!(movement.source_visible, !retire_source);
    assert_eq!(
        movement.disposition,
        crate::CrossAccountMoveDisposition::Waiting {
            reason: crate::CrossAccountMoveWaitingReason::AccessUnavailable,
        }
    );
    observation.close();
    assert_eq!(
        durable_rows(&fixture.database.0, unaffected).await,
        unaffected_before
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        accepted,
    );

    // A late response cannot restart the retired attempt. A normal public refresh while parked
    // confirms current policy through the ordinary serialized Account execution path as well.
    fixture.http.trash_result.release.add_permits(1);
    tokio::time::timeout(
        Duration::from_secs(5),
        fixture.runtime.request(
            RuntimeRequest::RefreshTravelMode {
                account_id: selected.clone(),
            },
            RequestCancellation::new(),
        ),
    )
    .await
    .expect("public selected policy refresh must finish while the Move stays parked")
    .unwrap();
    assert_eq!(
        fixture
            .runtime
            .replica
            .load_uncached(unaffected)
            .await
            .unwrap()
            .unwrap(),
        unaffected_snapshot_before,
        "the unaffected participant retains its complete durable snapshot, including its head"
    );
    assert_eq!(
        durable_rows(&fixture.database.0, unaffected).await,
        unaffected_before
    );
    close_move_runtime(fixture.runtime.clone(), runner).await;
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        accepted,
        "normal close may advance Account lock epochs, but cannot change the accepted workflow"
    );
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(fixture.http.target.server.created_items(), target_effect);
    tokio::time::timeout(Duration::from_secs(5), publisher.close())
        .await
        .unwrap();
}
