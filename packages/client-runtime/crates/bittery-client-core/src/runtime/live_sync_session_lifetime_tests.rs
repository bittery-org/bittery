//! A live quiet SSE stream must not retain the Session wrappers removed by verified Travel policy.
use super::*;

async fn track_wrapped_session(setup: &Setup) -> (crate::replica::ReplicaSnapshot, Arc<()>) {
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let mut session = setup
        .runtime
        .platform_storage
        .load_current_session(&setup.account, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    session.vault_keys = [TEST_VAULT_ID, "vault-2"]
        .into_iter()
        .map(|id| crate::server_contract::AuthVaultKeyResponse {
            encrypted_vault_key: crate::test_fixtures::personal_vault(id, USER).encrypted_vault_key,
            role: crate::server_contract::VaultRole::Owner,
            vault_icon: None,
            vault_id: id.into(),
            vault_image_url: None,
            vault_name: id.into(),
            vault_type: crate::server_contract::VaultType::Personal,
        })
        .collect();
    setup
        .runtime
        .platform_storage
        .store_current_session(&session)
        .await
        .unwrap();
    drop(session);
    let lifetime = Arc::new(());
    setup
        .runtime
        .platform_storage
        .observe_session_lifetime_for_test(
            setup.account.clone(),
            snapshot.incarnation.clone(),
            TEST_VAULT_ID.into(),
            &lifetime,
        );
    // Calibrate the real decode/Clone/Drop witness before relying on zero retained snapshots.
    let loaded = setup
        .runtime
        .platform_storage
        .load_current_session(&setup.account, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    let copied = loaded.clone();
    assert_eq!(Arc::strong_count(&lifetime), 3);
    drop(loaded);
    assert_eq!(Arc::strong_count(&lifetime), 2);
    drop(copied);
    assert_eq!(Arc::strong_count(&lifetime), 1);

    (snapshot, lifetime)
}

#[tokio::test]
async fn held_stream_open_retains_only_its_token_not_vault_wrappers() {
    let setup = setup().await;
    let (_, lifetime) = track_wrapped_session(&setup).await;
    let release = Arc::new(Semaphore::new(0));
    *setup.server.stream_open_release.lock().unwrap() = Some(release.clone());
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.opened).await;
    assert_eq!(setup.server.stream_reads.load(Ordering::SeqCst), 0);
    assert_eq!(setup.server.changes.available_permits(), 0);
    let retained = Arc::strong_count(&lifetime) - 1;
    release.add_permits(1);
    setup.runtime.close().await;
    runner.await.unwrap();
    assert_eq!(
        retained, 0,
        "held stream opening must retain no Session Vault wrapper snapshot"
    );
    assert_eq!(Arc::strong_count(&lifetime), 1);
}

#[tokio::test]
async fn quiet_sse_releases_pruned_session_snapshots_and_renews_only_current_authority() {
    let setup = setup().await;
    let (snapshot, lifetime) = track_wrapped_session(&setup).await;
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    let authority = snapshot.bootstrap.snapshot();
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"travel-hide-lifetime"}}),
        json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"travel-hide-lifetime"}}),
    ]);
    let policy = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled":true,"hiddenVaultIds":[TEST_VAULT_ID],
                "enabledAt":"2023-11-14T22:13:20Z","updatedAt":"2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    });
    *setup.server.policy_read.lock().unwrap() = Some(policy.clone());
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"travel-hide-lifetime","type":"travel_mode_updated","entityType":"user",
            "entityId":USER,"userId":USER,"vaultId":null,"clientId":"second-device",
            "metadata":null,"timestamp":"1700000000001","version":1
        })],
        "travel-hide-lifetime",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&policy.entered).await;
    // Both the event GET and its later Bootstrap watermark verification use this policy.
    policy.release.add_permits(2);
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "travel-hide-lifetime".into(),
            }
    })
    .await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 2).await;
    let pruned = setup
        .runtime
        .platform_storage
        .load_current_session(&setup.account, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        pruned
            .vault_keys
            .iter()
            .map(|key| key.vault_id.as_str())
            .collect::<Vec<_>>(),
        vec!["vault-2"]
    );
    drop(pruned);
    let retained = Arc::strong_count(&lifetime) - 1;
    let opened = setup.server.opens.lock().unwrap().len();
    let cancelled = setup.server.cancelled.lock().unwrap().len();
    if retained != 0 {
        setup.runtime.close().await;
        runner.await.unwrap();
        assert_eq!(
            retained, 0,
            "a quiet live SSE stream retained a pre-prune Session snapshot after exact policy cleanup"
        );
        return;
    }
    assert_eq!(opened, 1, "pruning must preserve the existing stream");
    assert_eq!(cancelled, 0);

    // A real control hint still renews from the guarded current Session, preserving its pruning.
    *setup.server.finite.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
    setup.server.hint(b"event: session_revoked\ndata: {}\n\n");
    until(|| setup.server.finite.refresh_calls.load(Ordering::SeqCst) == 1).await;
    until(|| setup.timer.requested().contains(&1_000)).await;
    let renewed = setup
        .runtime
        .platform_storage
        .load_current_session(&setup.account, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renewed.token.as_ref(), SECOND_TOKEN);
    assert_eq!(
        renewed
            .vault_keys
            .iter()
            .map(|key| key.vault_id.as_str())
            .collect::<Vec<_>>(),
        vec!["vault-2"]
    );
    assert_eq!(Arc::strong_count(&lifetime), 1);
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn held_selective_cleanup_retains_no_pre_policy_session_snapshot() {
    let setup = setup().await;
    let (snapshot, lifetime) = track_wrapped_session(&setup).await;
    let cancellation = RequestCancellation::new();
    let loan = setup
        .runtime
        .foreground_attachments
        .register_target(
            &setup.account,
            &snapshot.incarnation,
            super::super::foreground_attachment_lifecycle::ForegroundAttachmentTarget::Item {
                vault_id: TEST_VAULT_ID.into(),
                item_id: "item-existing".into(),
            },
            cancellation.clone(),
        )
        .unwrap();
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    let authority = snapshot.bootstrap.snapshot();
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"travel-held-cleanup"}}),
        json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"travel-held-cleanup"}}),
    ]);
    let policy = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled":true,"hiddenVaultIds":[TEST_VAULT_ID],
                "enabledAt":"2023-11-14T22:13:20Z","updatedAt":"2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    });
    *setup.server.policy_read.lock().unwrap() = Some(policy.clone());
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"travel-held-cleanup","type":"travel_mode_updated","entityType":"user",
            "entityId":USER,"userId":USER,"vaultId":null,"clientId":"second-device",
            "metadata":null,"timestamp":"1700000000001","version":1
        })],
        "travel-held-cleanup",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&policy.entered).await;
    // Both the event GET and its later Bootstrap watermark verification use this policy.
    policy.release.add_permits(2);
    until(|| {
        cancellation.is_cancelled()
            && setup
                .runtime
                .replica
                .snapshot(&setup.account)
                .unwrap()
                .bootstrap
                .pending_vault_retirements
                .contains(&TEST_VAULT_ID.to_owned())
    })
    .await;
    // The durable selective duty is waiting on this real admitted Item loan. No cleanup
    // Session load has begun yet, so every tracked snapshot would be a stale GET capture.
    let retained = Arc::strong_count(&lifetime) - 1;
    drop(loan);
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "travel-held-cleanup".into(),
            }
    })
    .await;
    setup.runtime.close().await;
    runner.await.unwrap();
    assert_eq!(
        retained, 0,
        "selective cleanup must not retain the policy GET's Session wrappers while draining"
    );
    assert_eq!(Arc::strong_count(&lifetime), 1);
}
#[tokio::test]
async fn held_complete_bootstrap_cleanup_retains_no_authority_selection_sessions() {
    let setup = setup().await;
    let (snapshot, lifetime) = track_wrapped_session(&setup).await;
    let cancellation = RequestCancellation::new();
    let loan = setup
        .runtime
        .foreground_attachments
        .register_target(
            &setup.account,
            &snapshot.incarnation,
            super::super::foreground_attachment_lifecycle::ForegroundAttachmentTarget::Item {
                vault_id: TEST_VAULT_ID.into(),
                item_id: "item-existing".into(),
            },
            cancellation.clone(),
        )
        .unwrap();
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;

    // Complete fresh membership omits the Vault. The verified Travel policy stays disabled, so
    // Bootstrap's own omitted-authority retirement must select both Session documents' old keys.
    let mut authority = snapshot.bootstrap.snapshot();
    authority
        .visible_vaults
        .retain(|vault| vault.id != TEST_VAULT_ID);
    authority
        .visible_items
        .retain(|item| item.vault_id != TEST_VAULT_ID);
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"membership-held-cleanup"}}),
        json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"membership-held-cleanup"}}),
    ]);
    let policy = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled":false,"hiddenVaultIds":[],"enabledAt":null,
                "updatedAt":"2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    });
    *setup.server.policy_read.lock().unwrap() = Some(policy.clone());
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"membership-held-cleanup","type":"vault_deleted","entityType":"vault",
            "entityId":TEST_VAULT_ID,"userId":USER,"vaultId":TEST_VAULT_ID,
            "clientId":"second-device","metadata":null,"timestamp":"1700000000001","version":1
        })],
        "membership-held-cleanup",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&policy.entered).await;
    policy.release.add_permits(1);
    until(|| {
        cancellation.is_cancelled()
            && setup
                .runtime
                .replica
                .snapshot(&setup.account)
                .unwrap()
                .bootstrap
                .pending_vault_retirements
                .contains(&TEST_VAULT_ID.to_owned())
    })
    .await;
    let retiring = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(!retiring.bootstrap.policy_verification_pending);
    assert_eq!(
        retiring.bootstrap.active_cursor,
        SyncCursor::CapturedValue {
            id: "membership-held-cleanup".into()
        }
    );
    assert!(!retiring
        .bootstrap
        .snapshot()
        .visible_vaults
        .iter()
        .any(|vault| vault.id == TEST_VAULT_ID));
    // The actual admitted loan holds cleanup before its Session-pruning loads. Every observed
    // wrapper snapshot here belongs to Bootstrap's earlier retirement selection, not new work.
    let retained = Arc::strong_count(&lifetime) - 1;
    drop(loan);
    until(|| {
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .pending_vault_retirements
            .is_empty()
    })
    .await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 2).await;
    let pruned = setup
        .runtime
        .platform_storage
        .load_current_session(&setup.account, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        pruned
            .vault_keys
            .iter()
            .map(|key| key.vault_id.as_str())
            .collect::<Vec<_>>(),
        vec!["vault-2"]
    );
    drop(pruned);
    setup.runtime.close().await;
    runner.await.unwrap();
    assert_eq!(
        retained, 0,
        "complete Bootstrap must release both authority-selection Session snapshots before selective cleanup drains"
    );
    assert_eq!(Arc::strong_count(&lifetime), 1);
}
