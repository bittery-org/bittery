//! A subscription lifetime may wait for policy proof without constructing a private answer.
use super::*;

#[tokio::test]
async fn items_subscription_created_during_policy_verification_waits_for_its_first_frame() {
    let setup = setup().await;
    let installed = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let metadata = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &installed.incarnation)
        .await
        .unwrap()
        .unwrap();
    setup
        .runtime
        .account_display_identities
        .lock()
        .unwrap()
        .insert(setup.account.clone(), account_presentation(&metadata));
    setup
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let policy_sink = Arc::new(ItemsSink::default());
    let policy_observer = setup
        .runtime
        .observe(
            ObservationRequest::TravelMode {
                account_id: setup.account.clone(),
            },
            policy_sink.clone(),
        )
        .unwrap();
    assert!(matches!(policy_sink.0.lock().unwrap().last(),
        Some(RuntimeProjection::TravelMode(value))
        if value.enforcement == crate::TravelModeEnforcement::Ready));

    let baseline = Arc::new(ItemsSink::default());
    let original = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            baseline.clone(),
        )
        .unwrap();
    let expected = match &baseline.0.lock().unwrap()[0] {
        RuntimeProjection::Items(value) => serde_json::to_value(&value.items).unwrap(),
        _ => panic!("seeded Items projection"),
    };
    assert!(!expected.as_array().unwrap().is_empty());
    original.close();
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    let authority = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .snapshot();
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"pending-observation-event"}}),
        json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"pending-observation-event"}}),
    ]);
    let gate = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled": false, "enabledAt": null, "hiddenVaultIds": [],
                "updatedAt": "2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    });
    *setup.server.policy_read.lock().unwrap() = Some(gate.clone());
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"pending-observation-event", "type":"travel_mode_updated", "entityType":"user",
            "entityId":USER,"userId":USER,"vaultId":null,"clientId":"second-device",
            "metadata":{"enabled":false,"hiddenVaultIds":[]},
            "timestamp":"1700000000001","version":1
        })],
        "pending-observation-event",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&gate.entered).await;
    let verified_gate = matches!(policy_sink.0.lock().unwrap().last(),
        Some(RuntimeProjection::TravelMode(value))
        if value.enforcement == crate::TravelModeEnforcement::Unverified);
    let sink = Arc::new(ItemsSink::default());
    let observation = setup.runtime.observe(
        ObservationRequest::Items {
            account_id: setup.account.clone(),
        },
        sink.clone(),
    );
    let silent_while_pending = sink.0.lock().unwrap().is_empty();
    gate.release.add_permits(4);
    until(|| {
        matches!(policy_sink.0.lock().unwrap().last(),
        Some(RuntimeProjection::TravelMode(value))
        if value.enforcement == crate::TravelModeEnforcement::Ready)
    })
    .await;
    let frames = sink.0.lock().unwrap().clone();
    if let Ok(handle) = &observation {
        handle.close();
    }
    policy_observer.close();
    setup.runtime.close().await;
    runner.await.unwrap();
    assert!(
        verified_gate,
        "actual Sync invalidation must establish public Unverified gate"
    );
    assert!(
        observation.is_ok(),
        "valid Items subscription must remain owned while proof is pending"
    );
    assert!(
        silent_while_pending,
        "no fabricated or private initial frame during verification"
    );
    assert!(
        matches!(frames.first(), Some(RuntimeProjection::Items(value))
        if serde_json::to_value(&value.items).unwrap() == expected),
        "the same subscription receives its original current Items after verified publication"
    );
}
