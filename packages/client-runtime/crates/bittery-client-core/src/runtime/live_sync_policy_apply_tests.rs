//! Public incoming-policy history; the Server still returns its complete membership authority.
use super::*;
use std::sync::Condvar;

const REMAINING_VAULT: &str = "remaining-travel-vault";

struct HeldFirstItemsSink {
    values: Mutex<Vec<RuntimeProjection>>,
    first: AtomicBool,
    entered: Semaphore,
    released: Mutex<bool>,
    release: Condvar,
}

impl Default for HeldFirstItemsSink {
    fn default() -> Self {
        Self {
            values: Mutex::new(Vec::new()),
            first: AtomicBool::new(false),
            entered: Semaphore::new(0),
            released: Mutex::new(false),
            release: Condvar::new(),
        }
    }
}

impl HeldFirstItemsSink {
    fn release(&self) {
        *self.released.lock().unwrap() = true;
        self.release.notify_all();
    }
}

impl crate::ObservationSink for HeldFirstItemsSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.values.lock().unwrap().push(projection);
        if !self.first.swap(true, Ordering::SeqCst) {
            self.entered.add_permits(1);
            let mut released = self.released.lock().unwrap();
            while !*released {
                released = self.release.wait(released).unwrap();
            }
        }
    }
}

struct ReleaseItemsOnDrop(Arc<HeldFirstItemsSink>);
impl Drop for ReleaseItemsOnDrop {
    fn drop(&mut self) {
        self.0.release();
    }
}

fn script_membership_bootstrap(setup: &Setup, cursor: &str) {
    let mut authority = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .snapshot();
    if !authority
        .visible_vaults
        .iter()
        .any(|vault| vault.id == REMAINING_VAULT)
    {
        authority
            .visible_vaults
            .push(crate::test_fixtures::personal_vault(REMAINING_VAULT, USER));
    }
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":{"id":cursor}}),
        json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":{"id":cursor}}),
    ]);
}

#[cfg(not(target_arch = "wasm32"))]
#[tokio::test]
async fn verified_incoming_policy_retires_only_hidden_authority_and_resumes_queued_observers() {
    let setup = setup().await;
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    script_membership_bootstrap(&setup, "remaining-vault-event");
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"remaining-vault-event","type":"vault_created","entityType":"vault",
            "entityId":REMAINING_VAULT,"userId":USER,"vaultId":REMAINING_VAULT,
            "clientId":"second-device","metadata":null,
            "timestamp":"1700000000000","version":1
        })],
        "remaining-vault-event",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "remaining-vault-event".into(),
            }
    })
    .await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) >= 2).await;

    // The first delivery was admitted before invalidation. A second prepared frame waits behind
    // that host callback, so the pending gate must reject it at delivery and later allow recovery.
    let sink = Arc::new(HeldFirstItemsSink::default());
    let _release_on_failure = ReleaseItemsOnDrop(sink.clone());
    let runtime = setup.runtime.clone();
    let account = setup.account.clone();
    let observation_sink = sink.clone();
    let observation = std::thread::spawn(move || {
        runtime.observe(
            ObservationRequest::Items {
                account_id: account,
            },
            observation_sink,
        )
    });
    permit(&sink.entered).await;
    let RuntimeResponse::Accepted { operation_id, .. } = setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("offline Item accepted before policy invalidation");
    };
    let accepted = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .operations
        .into_iter()
        .find(|operation| operation.operation_id == operation_id)
        .unwrap();
    let before_policy_cursor = cursor(&setup);
    let mut expected_visible: Vec<_> = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_vaults
        .into_iter()
        .map(|vault| vault.id)
        .filter(|id| id != TEST_VAULT_ID)
        .collect();
    expected_visible.sort();
    let gate = Arc::new(PolicyReadGate {
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
    *setup.server.policy_read.lock().unwrap() = Some(gate.clone());
    // Deliberately includes the hidden Vault and Item: Core must apply verified policy itself.
    script_membership_bootstrap(&setup, "enabled-travel-event");
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"enabled-travel-event","type":"travel_mode_updated","entityType":"user",
            "entityId":USER,"userId":USER,"vaultId":null,"clientId":"second-device",
            "metadata":{"enabled":true,"hiddenVaultIds":[TEST_VAULT_ID]},
            "timestamp":"1700000000001","version":1
        })],
        "enabled-travel-event",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&gate.entered).await;
    assert_eq!(cursor(&setup), before_policy_cursor);
    sink.release();
    let _observer = observation.join().unwrap().unwrap();
    assert_eq!(
        sink.values.lock().unwrap().len(),
        1,
        "a prepared pre-invalidation plaintext frame is refused when its delivery resumes"
    );
    // Release the event read and the required fresh verification after Bootstrap watermark.
    gate.release.add_permits(2);
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "enabled-travel-event".into(),
            }
    })
    .await;
    let current = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(!current.bootstrap.policy_verification_pending);
    assert!(current.bootstrap.pending_vault_retirements.is_empty());
    assert!(current
        .bootstrap
        .vaults
        .keys()
        .all(|(_, id)| id != TEST_VAULT_ID));
    assert!(current
        .bootstrap
        .items
        .values()
        .all(|item| item.vault_id != TEST_VAULT_ID));
    assert!(current
        .items
        .iter()
        .all(|item| item.vault_id != TEST_VAULT_ID));
    assert_eq!(
        current
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id),
        Some(&accepted),
        "verified hiding retains the exact already-accepted ciphertext and identity"
    );
    let session = setup
        .runtime
        .effective_session(&setup.account, &current.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(session
        .vault_keys
        .iter()
        .all(|key| key.vault_id != TEST_VAULT_ID));
    let published = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            if sink
                .values
                .lock()
                .unwrap()
                .last()
                .is_some_and(|projection| {
                    let RuntimeProjection::Items(items) = projection else {
                        return false;
                    };
                    let mut visible: Vec<_> = items
                        .vaults
                        .iter()
                        .map(|vault| vault.vault_id.clone())
                        .collect();
                    visible.sort();
                    visible == expected_visible && items.items.is_empty()
                })
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(
        published.is_ok(),
        "post-policy observer summaries: {:?}; current Vaults: {:?}",
        sink.values
            .lock()
            .unwrap()
            .iter()
            .map(|projection| match projection {
                RuntimeProjection::Items(items) => (
                    items.replica_revision,
                    items
                        .vaults
                        .iter()
                        .map(|vault| vault.vault_id.clone())
                        .collect::<Vec<_>>(),
                    items.items.len()
                ),
                _ => panic!("Items observer received another projection"),
            })
            .collect::<Vec<_>>(),
        current
            .bootstrap
            .snapshot()
            .visible_vaults
            .iter()
            .map(|vault| vault.id.clone())
            .collect::<Vec<_>>()
    );
    assert!(
        matches!(
            setup
                .runtime
                .request(
                    RuntimeRequest::CreateItem {
                        account_id: setup.account.clone(),
                        vault_id: REMAINING_VAULT.into(),
                        draft: draft(),
                    },
                    RequestCancellation::new(),
                )
                .await,
            Ok(RuntimeResponse::Accepted { .. })
        ),
        "fresh work in the unrelated Vault resumes after verified selective retirement"
    );
    assert!(setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .is_err());
    setup.runtime.close().await;
    runner.await.unwrap();
}
#[tokio::test]
async fn hidden_item_event_does_not_block_later_visible_authority_or_recreate_hidden_rows() {
    let setup = setup().await;
    let sink = Arc::new(ItemsSink::default());
    let _observer = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    *setup.server.policy_read.lock().unwrap() = Some(Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(2),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled":true,"hiddenVaultIds":[TEST_VAULT_ID],
                "enabledAt":"2023-11-14T22:13:20Z","updatedAt":"2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    }));
    script_membership_bootstrap(&setup, "enable-before-item-events");
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"enable-before-item-events","type":"travel_mode_updated","entityType":"user",
            "entityId":USER,"userId":USER,"vaultId":null,"clientId":"second-device",
            "metadata":{"enabled":true,"hiddenVaultIds":[TEST_VAULT_ID]},
            "timestamp":"1700000000001","version":1
        })],
        "enable-before-item-events",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "enable-before-item-events".into(),
            }
    })
    .await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) >= 2).await;
    let item_id = "visible-item-after-travel";
    let sealed = bittery_crypto_core::encrypt_with_aad(
        &super::super::create::item_plaintext(&draft()).unwrap(),
        &crate::test_fixtures::TEST_VAULT_KEY,
        &bittery_crypto_core::AadContext {
            vault_id: REMAINING_VAULT.into(),
            entity_id: item_id.into(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    {
        let mut items = setup.server.finite.created_items.lock().unwrap();
        let mut visible = items[0].clone();
        visible.id = item_id.into();
        visible.vault_id = REMAINING_VAULT.into();
        visible.encrypted_data = sealed.ciphertext;
        visible.encryption_iv = sealed.iv;
        visible.encryption_algorithm = sealed.algorithm;
        items.push(visible);
    }
    setup.server.finite.script_sync_page(
        vec![
            json!({"id":"hidden-item-event","type":"item_updated","entityType":"item",
            "entityId":"item-existing","userId":USER,"vaultId":TEST_VAULT_ID,
            "clientId":"second-device","metadata":null,"timestamp":"1700000000002","version":1}),
            json!({"id":"visible-item-event","type":"item_created","entityType":"item",
            "entityId":item_id,"userId":USER,"vaultId":REMAINING_VAULT,
            "clientId":"second-device","metadata":null,"timestamp":"1700000000003","version":1}),
        ],
        "visible-item-event",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: "visible-item-event".into(),
            }
    })
    .await;
    let current = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(current
        .bootstrap
        .items
        .values()
        .all(|item| item.vault_id != TEST_VAULT_ID));
    until(|| {
        sink.0.lock().unwrap().last().is_some_and(|projection| {
            matches!(projection, RuntimeProjection::Items(items)
            if items.items.len() == 1 && items.items[0].item_id == item_id
                && items.items[0].status == ItemProjectionStatus::Authoritative)
        })
    })
    .await;
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn full_refresh_without_travel_event_verifies_policy_after_watermark_before_promotion() {
    const WATERMARK: &str = "travel-event-no-longer-retained";
    let setup = setup().await;
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    let RuntimeResponse::Accepted { operation_id, .. } = setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("offline Item accepted");
    };
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let accepted = before
        .operations
        .iter()
        .find(|operation| operation.operation_id == operation_id)
        .unwrap()
        .clone();
    // Both histories return real complete membership, including the now-hidden Vault. A changed
    // verified selection may legitimately abandon the first stage and use the ordinary retry.
    script_membership_bootstrap(&setup, WATERMARK);
    script_membership_bootstrap(&setup, WATERMARK);
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
    *setup.server.finite.sync_cursor.lock().unwrap() = Some(WATERMARK.into());
    setup
        .server
        .finite
        .sync_pages
        .lock()
        .unwrap()
        .push_back(json!({
            "events":[], "cursor":{"id":WATERMARK}, "hasMore":false, "requiresFullRefresh":true
        }));
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    let mut verified_after_watermark = false;
    for _ in 0..3 {
        let policy_requested = tokio::select! {
            biased;
            () = permit(&policy.entered) => true,
            () = until(|| cursor(&setup) == SyncCursor::CapturedValue { id: WATERMARK.into() }) => false,
        };
        if !policy_requested {
            break;
        }
        let current = setup.runtime.replica.snapshot(&setup.account).unwrap();
        let pinned = current
            .bootstrap
            .staging_generation
            .as_ref()
            .and_then(|id| current.bootstrap.generations.get(id))
            .is_some_and(|stage| {
                stage.pinned_watermark
                    == SyncCursor::CapturedValue {
                        id: WATERMARK.into(),
                    }
            });
        if pinned {
            verified_after_watermark = true;
            assert_eq!(
                current.bootstrap.active_cursor,
                before.bootstrap.active_cursor
            );
            assert!(current.bootstrap.policy_verification_pending);
            let pending_sink = Arc::new(ItemsSink::default());
            let pending_observation = setup
                .runtime
                .observe(
                    ObservationRequest::Items {
                        account_id: setup.account.clone(),
                    },
                    pending_sink.clone(),
                )
                .expect("pending watermark verification admits a silent Items subscription");
            assert!(pending_sink.0.lock().unwrap().is_empty());
            pending_observation.close();
            break;
        }
        // An additional early read is permitted, but cannot replace verification after the
        // Server watermark which covers an event no longer available in changes.
        policy.release.add_permits(1);
    }
    if !verified_after_watermark {
        setup.runtime.close().await;
        runner.await.unwrap();
        assert!(
            verified_after_watermark,
            "full membership Bootstrap promoted without a fresh policy read after its captured watermark"
        );
        return;
    }
    policy.release.add_permits(3);
    tokio::select! {
        () = until(|| cursor(&setup) == SyncCursor::CapturedValue { id: WATERMARK.into() }) => {},
        () = until(|| setup.timer.requested().contains(&1_000)) => { setup.timer.released.notify_waiters(); },
    }
    until(|| {
        cursor(&setup)
            == SyncCursor::CapturedValue {
                id: WATERMARK.into(),
            }
    })
    .await;
    let current = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(current.bootstrap.state, crate::replica::ReplicaState::Ready);
    assert!(!current.bootstrap.policy_verification_pending);
    assert!(current.bootstrap.pending_vault_retirements.is_empty());
    assert!(current
        .bootstrap
        .vaults
        .values()
        .all(|vault| vault.id != TEST_VAULT_ID));
    assert!(current
        .bootstrap
        .items
        .values()
        .all(|item| item.vault_id != TEST_VAULT_ID));
    assert_eq!(
        current
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id),
        Some(&accepted)
    );
    assert!(current
        .bootstrap
        .snapshot()
        .visible_vaults
        .iter()
        .any(|vault| vault.id == REMAINING_VAULT));
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn verified_disable_requires_fresh_bootstrap_before_readmitting_hidden_vault() {
    let setup = setup().await;
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let authority = before.bootstrap.snapshot();
    let policy_reply = |enabled: bool, permits| {
        Arc::new(PolicyReadGate {
            entered: Semaphore::new(0),
            release: Semaphore::new(permits),
            response: completed(
                200,
                serde_json::to_vec(&json!({
                    "enabled":enabled,"hiddenVaultIds":[TEST_VAULT_ID],
                    "enabledAt":enabled.then_some("2023-11-14T22:13:20Z"),
                    "updatedAt":"2023-11-14T22:13:20Z"
                }))
                .unwrap(),
            ),
        })
    };
    *setup.server.policy_read.lock().unwrap() = Some(policy_reply(true, 1));
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
    assert!(setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .bootstrap
        .snapshot()
        .visible_vaults
        .iter()
        .all(|vault| vault.id != TEST_VAULT_ID));
    *setup.server.policy_read.lock().unwrap() = Some(policy_reply(false, 2));
    let disabled = setup
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let refreshing = matches!(
        disabled,
        RuntimeResponse::TravelMode {
            result: crate::TravelModeCommandResult::Confirmed {
                enforcement: crate::TravelModeEnforcement::Refreshing,
                ..
            },
            ..
        }
    );
    if !refreshing {
        setup.runtime.close().await;
        assert!(
            refreshing,
            "verified disable must require fresh authority before reporting ready"
        );
        return;
    }
    assert_eq!(
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .state,
        crate::replica::ReplicaState::RefreshRequired
    );
    assert!(setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft()
            },
            RequestCancellation::new()
        )
        .await
        .is_err());
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"verified-disabled-current-authority"}}),
        json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"verified-disabled-current-authority"}}),
    ]);
    *setup.server.finite.sync_cursor.lock().unwrap() =
        Some("verified-disabled-current-authority".into());
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    until(|| {
        let current = setup.runtime.replica.snapshot(&setup.account).unwrap();
        current.bootstrap.state == crate::replica::ReplicaState::Ready
            && current
                .bootstrap
                .snapshot()
                .visible_vaults
                .iter()
                .any(|vault| vault.id == TEST_VAULT_ID)
    })
    .await;
    let accepted = setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(accepted, RuntimeResponse::Accepted { .. }));
    setup.runtime.close().await;
    runner.await.unwrap();
}

#[tokio::test]
async fn pending_policy_allows_exact_ciphertext_completion_without_new_authority() {
    let setup = setup().await;
    let RuntimeResponse::Accepted { operation_id, .. } = setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("offline Item accepted before pending verification");
    };
    let accepted = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .operations
        .into_iter()
        .find(|operation| operation.operation_id == operation_id)
        .unwrap();
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    let gate = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: json!({"type":"networkFailure"}),
    });
    *setup.server.policy_read.lock().unwrap() = Some(gate.clone());
    setup.server.finite.script_sync_page(vec![json!({
        "id":"pending-before-ciphertext-completion","type":"travel_mode_updated","entityType":"user",
        "entityId":USER,"userId":USER,"vaultId":null,"clientId":"second-device",
        "metadata":null,"timestamp":"1700000000001","version":1
    })], "pending-before-ciphertext-completion", false);
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&gate.entered).await;
    gate.release.add_permits(1);
    until(|| setup.timer.requested().contains(&1_000)).await;
    let before_dispatch = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(before_dispatch.bootstrap.policy_verification_pending);
    let dispatcher = tokio::spawn(setup.runtime.clone().run_operation_dispatch());
    until(|| {
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .receipts
            .iter()
            .any(|receipt| receipt.operation_id == operation_id)
    })
    .await;
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let receipt = after
        .receipts
        .iter()
        .find(|receipt| receipt.operation_id == operation_id)
        .unwrap();
    assert_eq!(receipt.request_fingerprint, accepted.request_fingerprint);
    assert!(matches!(
        receipt.result,
        crate::replica::OperationOutcomeResult::Applied { .. }
    ));
    assert!(after.bootstrap.policy_verification_pending);
    assert_eq!(
        after.bootstrap.active_cursor,
        before_dispatch.bootstrap.active_cursor
    );
    let authority_before = before_dispatch.bootstrap.snapshot().visible_items;
    let authority_after = after.bootstrap.snapshot().visible_items;
    let pending_sink = Arc::new(ItemsSink::default());
    let pending_observation = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            pending_sink.clone(),
        )
        .expect("pending policy admits a silent Items subscription after receipt completion");
    assert!(pending_sink.0.lock().unwrap().is_empty());
    pending_observation.close();
    setup.runtime.close().await;
    runner.await.unwrap();
    dispatcher.await.unwrap();
    assert_eq!(
        authority_after, authority_before,
        "accepted receipt may complete while pending, but its fetched current Item authority must not publish"
    );
}
