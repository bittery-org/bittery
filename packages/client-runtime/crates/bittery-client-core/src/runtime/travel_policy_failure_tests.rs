use super::*;
use crate::platform_storage::{SerializedPlatformStorageExecutor, VerifiedTravelModePolicy};

struct PolicyWriteFault {
    inner: Arc<MemoryPlatform>,
    replica: Arc<PlainReplica>,
    reject_next: AtomicBool,
    committed: Mutex<Vec<(VerifiedTravelModePolicy, bool, Vec<String>)>>,
}

#[async_trait]
impl SerializedPlatformStorageExecutor for PolicyWriteFault {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<zeroize::Zeroizing<String>, RuntimeError> {
        let request: Value = serde_json::from_str(&request_json).unwrap();
        let policy = if request["type"] == "set"
            && request["key"]
                .as_str()
                .is_some_and(|key| key.ends_with(":metadata"))
        {
            let metadata: Value = serde_json::from_str(request["value"].as_str().unwrap()).unwrap();
            metadata
                .get("verifiedTravelMode")
                .filter(|value| !value.is_null())
                .map(|value| {
                    serde_json::from_value::<VerifiedTravelModePolicy>(value.clone()).unwrap()
                })
        } else {
            None
        };
        if policy.is_some() && self.reject_next.swap(false, Ordering::SeqCst) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::StorageUnavailable,
                "injected policy metadata write failure",
            ));
        }
        let result = self.inner.invoke(request_json).await;
        if result.is_ok() {
            if let Some(policy) = policy {
                let snapshot = self
                    .replica
                    .state
                    .snapshot(&AccountId::from(ACCOUNT))
                    .unwrap();
                let selected_authority = snapshot
                    .bootstrap
                    .vaults
                    .keys()
                    .any(|(_, id)| id == TEST_VAULT_ID)
                    || snapshot
                        .bootstrap
                        .items
                        .values()
                        .any(|item| item.vault_id == TEST_VAULT_ID)
                    || snapshot
                        .items
                        .iter()
                        .any(|item| item.vault_id == TEST_VAULT_ID);
                self.committed.lock().unwrap().push((
                    policy,
                    selected_authority,
                    snapshot.bootstrap.pending_vault_retirements,
                ));
            }
        }
        result
    }
}

async fn setup_with_policy_fault() -> (Setup, Arc<PolicyWriteFault>) {
    let captured = Arc::new(Mutex::new(None));
    let capture = captured.clone();
    let setup = setup_with_platform(move |inner, replica| {
        let port = Arc::new(PolicyWriteFault {
            inner,
            replica,
            reject_next: AtomicBool::new(false),
            committed: Mutex::new(Vec::new()),
        });
        *capture.lock().unwrap() = Some(port.clone());
        port
    })
    .await;
    let port = captured.lock().unwrap().take().unwrap();
    (setup, port)
}

#[tokio::test]
async fn failed_policy_proof_is_retried_and_retired_before_a_newer_disabled_reply() {
    let (setup, platform) = setup_with_policy_fault().await;
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
        panic!("Item accepted before policy changed");
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
    platform.reject_next.store(true, Ordering::SeqCst);
    *setup.server.policy_read.lock().unwrap() = Some(Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled":true,"hiddenVaultIds":[TEST_VAULT_ID],
                "enabledAt":"2023-11-14T22:13:20Z","updatedAt":"2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    }));
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"failed-policy-proof-event","type":"travel_mode_updated","entityType":"user",
            "entityId":USER,"userId":USER,"vaultId":null,"clientId":"second-device",
            "metadata":{"enabled":true,"hiddenVaultIds":[TEST_VAULT_ID]},
            "timestamp":"1700000000001","version":1
        })],
        "failed-policy-proof-event",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    until(|| setup.timer.requested().contains(&1_000)).await;
    let failed = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(failed.bootstrap.policy_verification_pending);
    assert!(failed.bootstrap.pending_vault_retirements.is_empty());
    assert!(platform.committed.lock().unwrap().is_empty());
    assert!(
        failed
            .bootstrap
            .vaults
            .keys()
            .any(|(_, id)| id == TEST_VAULT_ID),
        "a rejected metadata proof cannot claim its all-generation purge committed"
    );
    let pending_sink = Arc::new(ItemsSink::default());
    let pending_observation = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            pending_sink.clone(),
        )
        .expect("pending policy admits a silent owned Items subscription");
    assert!(pending_sink.0.lock().unwrap().is_empty());
    pending_observation.close();
    // The previous verified response owns a selected retirement duty. A newer GET cannot drop it.
    *setup.server.policy_read.lock().unwrap() = Some(Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled":false,"hiddenVaultIds":[TEST_VAULT_ID],"enabledAt":null,
                "updatedAt":"2023-11-14T22:13:21Z"
            }))
            .unwrap(),
        ),
    }));
    let response = setup
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect("a valid newer reply must first finish the captured failed proof duty");
    assert!(matches!(response, RuntimeResponse::TravelMode {
        result: crate::TravelModeCommandResult::Confirmed { policy, .. }, ..
    } if !policy.enabled));
    {
        let committed = platform.committed.lock().unwrap();
        assert_eq!(
            committed.len(),
            2,
            "retry exact original proof, then install the newer reply"
        );
        assert!(committed[0].0.enabled);
        assert!(
            committed[0].1,
            "the original policy proof must precede physical authority erasure"
        );
        assert!(committed[0].2.is_empty());
        assert!(!committed[1].0.enabled);
        assert!(
            !committed[1].1,
            "new disabled metadata cannot bypass original selected erasure"
        );
        assert!(
            committed[1].2.is_empty(),
            "the old journal must finish before newer policy installation"
        );
    }
    let current = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(
        current
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id),
        Some(&accepted)
    );
    assert!(!current.bootstrap.policy_verification_pending);
    assert!(
        setup.runtime.foreground_attachments.is_vault_fenced(
            &setup.account,
            &current.incarnation,
            TEST_VAULT_ID
        ),
        "disabled policy does not resurrect an old scope before fresh Bootstrap readmission"
    );
    setup.runtime.close().await;
    runner.await.unwrap();
}
fn configured_policy_reply(setup: &Setup, enabled: bool, count: usize) {
    let ids: Vec<_> = (0..count)
        .map(|index| format!("configured-vault-{index}"))
        .collect();
    *setup.server.policy_read.lock().unwrap() = Some(Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled":enabled,"hiddenVaultIds":ids,
                "enabledAt":enabled.then_some("2023-11-14T22:13:20Z"),
                "updatedAt":"2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    }));
}

#[tokio::test]
async fn policy_bounds_reject_oversized_current_reply_before_creating_retirement_scopes() {
    let setup = setup().await;
    configured_policy_reply(&setup, false, 100);
    let accepted = setup
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(accepted, RuntimeResponse::TravelMode {
        result: crate::TravelModeCommandResult::Confirmed { policy, .. }, ..
    } if policy.hidden_vault_ids.len() == 100));
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let prior = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &before.incarnation)
        .await
        .unwrap()
        .unwrap()
        .verified_travel_mode;
    configured_policy_reply(&setup, true, 101);
    let rejected = setup
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await;
    assert!(
        rejected.is_err(),
        "an oversized policy cannot enter the selected retirement owner"
    );
    assert!(
        setup
            .runtime
            .foreground_attachments
            .fenced_vault_ids(&setup.account, &before.incarnation)
            .is_empty(),
        "response validation must precede any selective fence or retained proof payload"
    );
    let after = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &before.incarnation)
        .await
        .unwrap()
        .unwrap()
        .verified_travel_mode;
    assert_eq!(
        after, prior,
        "malformed current policy cannot replace last verified metadata"
    );
    setup.runtime.close().await;
}

#[tokio::test]
async fn policy_bounds_reject_oversized_stored_policy_as_malformed_metadata() {
    let (setup, platform) = setup_with_policy_fault().await;
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let mut metadata = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    metadata.verified_travel_mode = Some(VerifiedTravelModePolicy {
        enabled: false,
        hidden_vault_ids: (0..101)
            .map(|index| format!("stored-vault-{index}"))
            .collect(),
        server_enabled_at_ms: None,
        server_updated_at_ms: Some(START_MS),
        verified_at_ms: Some(START_MS),
    });
    // A damaged physical document bypasses the writer; the shared decoder must still reject it.
    let encoded = serde_json::to_string(&metadata).unwrap();
    {
        let mut values = platform.inner.values.lock().unwrap();
        let key = values
            .keys()
            .find(|(_, key)| key.ends_with(":metadata"))
            .unwrap()
            .clone();
        values.insert(key, encoded);
    }
    assert!(
        setup
            .runtime
            .platform_storage
            .load_account_metadata(&setup.account, &snapshot.incarnation)
            .await
            .is_err(),
        "oversized stored policy cannot become cached verification evidence"
    );
    setup.runtime.close().await;
}

#[derive(Default)]
struct MarkerPolicySink(
    Mutex<Vec<RuntimeProjection>>,
    Mutex<Vec<crate::ObservationControl>>,
);
impl crate::ObservationSink for MarkerPolicySink {
    fn publish(&self, value: RuntimeProjection) {
        self.0.lock().unwrap().push(value);
    }
    fn control(&self, value: crate::ObservationControl) {
        self.1.lock().unwrap().push(value);
    }
}

async fn seed_marker_policy_observation(
    setup: &Setup,
) -> (Arc<MarkerPolicySink>, Arc<ObservationHandle>) {
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let metadata = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &snapshot.incarnation)
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
    let sink = Arc::new(MarkerPolicySink::default());
    let observer = setup
        .runtime
        .observe(
            ObservationRequest::TravelMode {
                account_id: setup.account.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    (sink, observer)
}

#[tokio::test]
async fn lost_pending_true_ack_never_dispatches_settings_and_sync_reloads_the_committed_duty() {
    let setup = setup().await;
    let (_sink, _observer) = seed_marker_policy_observation(&setup).await;
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    *setup.commits.lose_pending_ack.lock().unwrap() = Some(true);
    let reply = setup
        .runtime
        .request(
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id: setup.account.clone(),
                hidden_vault_ids: vec![TEST_VAULT_ID.into()],
            },
            RequestCancellation::new(),
        )
        .await;
    assert!(
        reply.is_err(),
        "an unacknowledged pending handoff cannot dispatch settings"
    );
    assert_eq!(setup.commits.lost_pending_acks.load(Ordering::SeqCst), 1);
    let physical = setup.persistence.state.snapshot(&setup.account).unwrap();
    assert!(physical.bootstrap.policy_verification_pending);
    assert!(physical.revision > before.revision);
    assert!(setup
        .server
        .policy_settings_requests
        .lock()
        .unwrap()
        .is_empty());
    let read = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled": false, "hiddenVaultIds": [], "updatedAt":"2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    });
    *setup.server.policy_read.lock().unwrap() = Some(read.clone());
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    let verified = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        read.entered.acquire().await.unwrap().forget();
        until(|| {
            !setup
                .runtime
                .replica
                .snapshot(&setup.account)
                .unwrap()
                .bootstrap
                .policy_verification_pending
        })
        .await;
    })
    .await
    .is_ok();
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    setup.runtime.close().await;
    runner.await.unwrap();
    assert!(
        verified,
        "Sync must reload the committed head before retrying the pending marker, without a hint"
    );
    assert!(!after.bootstrap.policy_verification_pending);
    assert_eq!(after.operations, before.operations);
    assert!(
        setup
            .server
            .policy_settings_requests
            .lock()
            .unwrap()
            .is_empty(),
        "lost marker ACK never permits later mutation replay"
    );
}

#[tokio::test]
async fn lost_pending_false_ack_flushes_committed_policy_to_ready_observers_without_another_get() {
    let setup = setup().await;
    let (sink, _observer) = seed_marker_policy_observation(&setup).await;
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert!(matches!(sink.0.lock().unwrap().last(),
        Some(RuntimeProjection::TravelMode(value))
        if value.enforcement == crate::TravelModeEnforcement::Ready
            && value.last_verified_policy.as_ref().is_some_and(|policy|
                !policy.enabled && policy.hidden_vault_ids.is_empty())));
    *setup.server.policy_settings_response.lock().unwrap() = Some(completed(
        200,
        serde_json::to_vec(&json!({
            "enabled":false,"hiddenVaultIds":[TEST_VAULT_ID],
            "updatedAt":"2023-11-14T22:13:20Z"
        }))
        .unwrap(),
    ));
    *setup.commits.lose_pending_ack.lock().unwrap() = Some(false);
    let reply = setup
        .runtime
        .request(
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id: setup.account.clone(),
                hidden_vault_ids: vec![TEST_VAULT_ID.into()],
            },
            RequestCancellation::new(),
        )
        .await;
    assert!(
        reply.is_err(),
        "the physical false commit's acknowledgment was lost"
    );
    assert_eq!(setup.commits.lost_pending_acks.load(Ordering::SeqCst), 1);
    let physical = setup.persistence.state.snapshot(&setup.account).unwrap();
    assert!(!physical.bootstrap.policy_verification_pending);
    assert!(physical.revision > before.revision);
    assert!(
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .policy_verification_pending,
        "the withheld ACK leaves only the cached marker stale"
    );
    assert_eq!(
        setup.server.policy_settings_requests.lock().unwrap().len(),
        1
    );
    let metadata = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &physical.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        metadata.verified_travel_mode.unwrap().hidden_vault_ids,
        [TEST_VAULT_ID]
    );
    let forbidden_read = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: json!({"type":"networkFailure"}),
    });
    *setup.server.policy_read.lock().unwrap() = Some(forbidden_read.clone());
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    let ready = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let complete = matches!(sink.0.lock().unwrap().last(),
                Some(RuntimeProjection::TravelMode(value))
                if value.account_id == setup.account
                    && value.enforcement == crate::TravelModeEnforcement::Ready
                    && value.last_verified_policy.as_ref().is_some_and(|policy|
                        !policy.enabled && policy.hidden_vault_ids == [TEST_VAULT_ID]));
            if complete {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    setup.runtime.close().await;
    runner.await.unwrap();
    assert!(
        ready,
        "the committed policy must replace the old display when the known resolved marker flushes"
    );
    assert_eq!(
        forbidden_read.entered.available_permits(),
        0,
        "a lost false ACK is a durability flush, not a new verification episode"
    );
    assert!(!after.bootstrap.policy_verification_pending);
    assert_eq!(after.operations, before.operations);
    assert_eq!(
        setup.server.policy_settings_requests.lock().unwrap().len(),
        1
    );
}

fn retained_policy_gate(enabled: bool, vault_ids: &[&str]) -> Arc<PolicyReadGate> {
    Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled": enabled, "hiddenVaultIds": vault_ids,
                "enabledAt": enabled.then_some("2023-11-14T22:13:20Z"),
                "updatedAt": "2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    })
}

fn spawn_policy_refresh(
    setup: &Setup,
) -> tokio::task::JoinHandle<Result<RuntimeResponse, RuntimeError>> {
    let runtime = setup.runtime.clone();
    let account_id = setup.account.clone();
    tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::RefreshTravelMode { account_id },
                RequestCancellation::new(),
            )
            .await
    })
}

#[tokio::test]
async fn additional_verified_restriction_survives_caller_loss_while_older_export_cleanup_waits() {
    let setup = setup().await;
    let accepted = setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: "vault-2".into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(accepted, RuntimeResponse::Accepted { .. }));
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let first_sink = Arc::new(MarkerPolicySink::default());
    let first_export = setup
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: setup.account.clone(),
                vault_ids: vec![TEST_VAULT_ID.into()],
            },
            first_sink.clone(),
        )
        .unwrap();
    let second_sink = Arc::new(MarkerPolicySink::default());
    let second_export = setup
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: setup.account.clone(),
                vault_ids: vec!["vault-2".into()],
            },
            second_sink.clone(),
        )
        .unwrap();
    assert!(matches!(
        first_sink.0.lock().unwrap().as_slice(),
        [RuntimeProjection::VaultExport(_)]
    ));
    assert!(matches!(
        second_sink.0.lock().unwrap().as_slice(),
        [RuntimeProjection::VaultExport(_)]
    ));

    *setup.server.policy_read.lock().unwrap() = Some(retained_policy_gate(true, &[TEST_VAULT_ID]));
    let first_caller = spawn_policy_refresh(&setup);
    until(|| {
        first_sink.1.lock().unwrap().len() == 1
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
    assert!(
        !first_caller.is_finished(),
        "the first Export has not acknowledged disposal"
    );
    assert!(second_sink.1.lock().unwrap().is_empty());
    first_caller.abort();
    assert!(first_caller.await.unwrap_err().is_cancelled());

    let additional = retained_policy_gate(true, &[TEST_VAULT_ID, "vault-2"]);
    *setup.server.policy_read.lock().unwrap() = Some(additional.clone());
    let second_caller = spawn_policy_refresh(&setup);
    permit(&additional.entered).await;
    let second_retired = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while second_sink.1.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    assert!(
        !second_caller.is_finished(),
        "older Export cleanup still owns its admitted plaintext"
    );
    second_caller.abort();
    assert!(second_caller.await.unwrap_err().is_cancelled());

    // Later verified Disable cannot cancel a restriction already observed before caller loss.
    *setup.server.policy_read.lock().unwrap() =
        Some(retained_policy_gate(false, &[TEST_VAULT_ID, "vault-2"]));
    first_sink.0.lock().unwrap().clear();
    second_sink.0.lock().unwrap().clear();
    first_export.close();
    second_export.close();
    let disabled = setup
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await;
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let session = setup
        .runtime
        .effective_session(&setup.account, &after.incarnation)
        .await
        .unwrap()
        .unwrap();
    let selected_wrappers_remain = session
        .vault_keys
        .iter()
        .any(|key| key.vault_id == TEST_VAULT_ID || key.vault_id == "vault-2");
    drop(session);
    let selected_authority_remains = after
        .bootstrap
        .vaults
        .keys()
        .any(|(_, id)| id == TEST_VAULT_ID || id == "vault-2");
    setup.runtime.close().await;

    assert!(
        second_retired,
        "a fresh validated restriction must notify the second Export before awaiting older cleanup"
    );
    assert!(matches!(disabled, Ok(RuntimeResponse::TravelMode {
        result: crate::TravelModeCommandResult::Confirmed { policy, .. }, ..
    }) if !policy.enabled));
    assert!(
        !selected_authority_remains,
        "both captured restrictions must erase authority before later Disable readmission"
    );
    assert!(
        !selected_wrappers_remain,
        "caller loss cannot preserve wrappers for the additional verified restriction"
    );
    assert!(after.bootstrap.pending_vault_retirements.is_empty());
    assert_eq!(
        after.operations, before.operations,
        "selected accepted ciphertext intent survives both erasures"
    );
    assert!(first_export.begin_vault_export_output().is_err());
    assert!(second_export.begin_vault_export_output().is_err());
}
struct CompleteStagePolicyReadGate {
    inner: Arc<MemoryPlatform>,
    replica: Arc<PlainReplica>,
    armed: AtomicBool,
    entered: Semaphore,
    release: Semaphore,
    hold_session_read: AtomicBool,
    session_entered: Semaphore,
    session_release: Semaphore,
}

#[async_trait]
impl SerializedPlatformStorageExecutor for CompleteStagePolicyReadGate {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<zeroize::Zeroizing<String>, RuntimeError> {
        let request: Value = serde_json::from_str(&request_json).unwrap();
        let metadata_read = request["type"] == "get"
            && request["key"]
                .as_str()
                .is_some_and(|key| key.ends_with(":metadata"));
        let complete_verified_stage = metadata_read
            && self
                .replica
                .state
                .snapshot(&AccountId::from(ACCOUNT))
                .is_some_and(|snapshot| {
                    !snapshot.bootstrap.policy_verification_pending
                        && snapshot.bootstrap.pending_vault_retirements.is_empty()
                        && snapshot
                            .bootstrap
                            .staging_generation
                            .as_ref()
                            .is_some_and(|id| {
                                snapshot
                                    .bootstrap
                                    .generations
                                    .get(id)
                                    .is_some_and(|generation| generation.final_page_staged)
                            })
                });
        if complete_verified_stage && self.armed.swap(false, Ordering::SeqCst) {
            self.entered.add_permits(1);
            self.release.acquire().await.unwrap().forget();
        }
        let session_read = request["type"] == "get"
            && request["key"]
                .as_str()
                .is_some_and(|key| key.ends_with(":current-session"));
        if session_read && self.hold_session_read.swap(false, Ordering::SeqCst) {
            self.session_entered.add_permits(1);
            self.session_release.acquire().await.unwrap().forget();
        }
        self.inner.invoke(request_json).await
    }
}

#[derive(Clone, Copy)]
enum CompleteStageHistory {
    DisjointSelection,
    OverlappingSelection,
    PendingPolicy,
    RejectedRetirementCommit,
    LostRetirementAcknowledgement,
    FreshOwnerAfterRejectedCommit,
}

async fn assert_complete_stage_policy_caller_loss(history: CompleteStageHistory) {
    let selected_ids: &[&str] = match history {
        CompleteStageHistory::DisjointSelection => &["vault-2"],
        _ => &[TEST_VAULT_ID, "vault-2"],
    };
    let pending_after_capture = !matches!(
        history,
        CompleteStageHistory::DisjointSelection | CompleteStageHistory::OverlappingSelection
    );
    let reject_stage_commit = matches!(
        history,
        CompleteStageHistory::RejectedRetirementCommit
            | CompleteStageHistory::FreshOwnerAfterRejectedCommit
    );
    let lose_stage_ack = matches!(history, CompleteStageHistory::LostRetirementAcknowledgement);
    let reopen_rejected_stage =
        matches!(history, CompleteStageHistory::FreshOwnerAfterRejectedCommit);
    let captured = Arc::new(Mutex::new(None));
    let capture = captured.clone();
    let setup = setup_with_platform(move |inner, replica| {
        let gate = Arc::new(CompleteStagePolicyReadGate {
            inner,
            replica,
            armed: AtomicBool::new(false),
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            hold_session_read: AtomicBool::new(false),
            session_entered: Semaphore::new(0),
            session_release: Semaphore::new(0),
        });
        *capture.lock().unwrap() = Some(gate.clone());
        gate
    })
    .await;
    let gate = captured.lock().unwrap().take().unwrap();
    let accepted = setup
        .runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: setup.account.clone(),
                vault_id: "vault-2".into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(accepted, RuntimeResponse::Accepted { .. }));
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let older_sink = Arc::new(MarkerPolicySink::default());
    let older_export = setup
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: setup.account.clone(),
                vault_ids: vec![TEST_VAULT_ID.into()],
            },
            older_sink.clone(),
        )
        .unwrap();
    let selected_sink = Arc::new(MarkerPolicySink::default());
    let selected_export = setup
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: setup.account.clone(),
                vault_ids: vec!["vault-2".into()],
            },
            selected_sink.clone(),
        )
        .unwrap();
    assert!(matches!(
        older_sink.0.lock().unwrap().as_slice(),
        [RuntimeProjection::VaultExport(_)]
    ));
    assert!(matches!(
        selected_sink.0.lock().unwrap().as_slice(),
        [RuntimeProjection::VaultExport(_)]
    ));

    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    let mut authority = before.bootstrap.snapshot();
    authority
        .visible_vaults
        .retain(|vault| vault.id != TEST_VAULT_ID);
    authority
        .visible_items
        .retain(|item| item.vault_id != TEST_VAULT_ID);
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"completed-before-policy-caller-loss"}}),
        json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"completed-before-policy-caller-loss"}}),
    ]);
    *setup.server.policy_read.lock().unwrap() = Some(retained_policy_gate(false, &[]));
    gate.armed.store(true, Ordering::SeqCst);
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"completed-before-policy-caller-loss","type":"vault_deleted","entityType":"vault",
            "entityId":TEST_VAULT_ID,"userId":USER,"vaultId":TEST_VAULT_ID,
            "clientId":"second-device","metadata":null,"timestamp":"1700000000001","version":1
        })],
        "completed-before-policy-caller-loss",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&gate.entered).await;
    let complete = setup.persistence.state.snapshot(&setup.account).unwrap();
    assert!(!complete.bootstrap.policy_verification_pending);
    assert!(complete.bootstrap.pending_vault_retirements.is_empty());
    assert!(complete
        .bootstrap
        .staging_generation
        .as_ref()
        .is_some_and(|id| {
            complete
                .bootstrap
                .generations
                .get(id)
                .is_some_and(|stage| stage.final_page_staged)
        }));
    assert!(older_sink.1.lock().unwrap().is_empty());
    assert!(selected_sink.1.lock().unwrap().is_empty());
    runner.abort();
    assert!(runner.await.unwrap_err().is_cancelled());

    // Fresh policy is learned after the old verified stage, while its omitted-Vault Export
    // remains admitted. The storage gate only interrupted the preceding public Sync attempt.
    let selected_policy = retained_policy_gate(true, selected_ids);
    let hold_omitted_scope = selected_ids.contains(&TEST_VAULT_ID);
    if hold_omitted_scope {
        selected_policy.release.try_acquire().unwrap().forget();
    }
    *setup.server.policy_read.lock().unwrap() = Some(selected_policy.clone());
    let caller = spawn_policy_refresh(&setup);
    permit(&selected_policy.entered).await;
    let mut selected_plaintext_during_session_read = false;
    if hold_omitted_scope {
        gate.hold_session_read.store(true, Ordering::SeqCst);
        selected_policy.release.add_permits(1);
        permit(&gate.session_entered).await;
        let sink = Arc::new(MarkerPolicySink::default());
        match setup.runtime.observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            sink.clone(),
        ) {
            Ok(handle) => {
                selected_plaintext_during_session_read = sink.0.lock().unwrap().iter().any(|projection| {
                    matches!(projection, RuntimeProjection::Items(items) if
                        items.vaults.iter().any(|vault| selected_ids.contains(&vault.vault_id.as_str()))
                        || items.items.iter().any(|item| selected_ids.contains(&item.vault_id.as_str())))
                });
                sink.0.lock().unwrap().clear();
                handle.close();
            }
            Err(error) => assert_eq!(error.code, RuntimeErrorCode::AuthorityMissing),
        }
    }
    let selected_retired = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while selected_sink.1.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    if hold_omitted_scope {
        gate.session_release.add_permits(1);
    }
    let caller_waited = !caller.is_finished();
    caller.abort();
    let _ = caller.await;

    if pending_after_capture {
        // The old metadata is still verified disabled: neither the newer policy proof nor
        // completed stage has committed through the interrupted Session read. Saving an
        // empty selection is a legitimate control request and creates no new Vault authority.
        let hold = Arc::new(PolicyReadGate {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            response: json!({"type":"networkFailure"}),
        });
        *setup.server.policy_settings_hold.lock().unwrap() = Some(hold.clone());
        let runtime = setup.runtime.clone();
        let account_id = setup.account.clone();
        let mutation = tokio::spawn(async move {
            runtime
                .request(
                    RuntimeRequest::SetTravelModeHiddenVaults {
                        account_id,
                        hidden_vault_ids: vec![],
                    },
                    RequestCancellation::new(),
                )
                .await
        });
        permit(&hold.entered).await;
        let pending = setup.persistence.state.snapshot(&setup.account).unwrap();
        assert!(pending.bootstrap.policy_verification_pending);
        assert!(pending.bootstrap.staging_generation.is_some());
        assert!(pending.bootstrap.pending_vault_retirements.is_empty());
        mutation.abort();
        assert!(mutation.await.unwrap_err().is_cancelled());
    }

    // Disposing the old frames permits existing cleanup to finish. A later disabled policy
    // must not discard the additional restriction captured before that caller disappeared.
    let fresh_policy = retained_policy_gate(false, selected_ids);
    *setup.server.policy_read.lock().unwrap() = Some(fresh_policy.clone());
    older_sink.0.lock().unwrap().clear();
    selected_sink.0.lock().unwrap().clear();
    older_export.close();
    selected_export.close();
    if reject_stage_commit {
        assert!(pending_after_capture);
        let before_rejected = setup.persistence.state.snapshot(&setup.account).unwrap();
        setup
            .commits
            .reject_stage_retirement
            .store(true, Ordering::SeqCst);
        let rejected = setup
            .runtime
            .request(
                RuntimeRequest::RefreshTravelMode {
                    account_id: setup.account.clone(),
                },
                RequestCancellation::new(),
            )
            .await;
        assert!(
            matches!(rejected, Err(ref error) if error.code == RuntimeErrorCode::StorageUnavailable),
            "the prepared stage retirement must reach the exact rejected storage boundary"
        );
        assert_eq!(
            setup
                .commits
                .rejected_stage_retirements
                .load(Ordering::SeqCst),
            1
        );
        let retained = setup.persistence.state.snapshot(&setup.account).unwrap();
        assert_eq!(
            retained.bootstrap.staging_generation,
            before_rejected.bootstrap.staging_generation
        );
        assert_eq!(
            retained.bootstrap.generations,
            before_rejected.bootstrap.generations
        );
        assert!(retained.bootstrap.policy_verification_pending);
        assert!(retained.bootstrap.pending_vault_retirements.is_empty());
        assert_eq!(
            retained.bootstrap.active_cursor,
            before_rejected.bootstrap.active_cursor
        );
        assert_eq!(retained.operations, before_rejected.operations);
        assert!(
            retained
                .bootstrap
                .vaults
                .keys()
                .any(|(_, id)| id == TEST_VAULT_ID),
            "a rejected commit must retain the older complete absence proof and physical authority"
        );
        if reopen_rejected_stage {
            assert_reopened_complete_stage_duty(setup, gate, retained).await;
            return;
        }
        fresh_policy.release.add_permits(1);
    }
    if lose_stage_ack {
        assert!(pending_after_capture && !reject_stage_commit);
        let before_lost = setup.persistence.state.snapshot(&setup.account).unwrap();
        setup
            .commits
            .lose_stage_retirement_ack
            .store(true, Ordering::SeqCst);
        let lost = setup
            .runtime
            .request(
                RuntimeRequest::RefreshTravelMode {
                    account_id: setup.account.clone(),
                },
                RequestCancellation::new(),
            )
            .await;
        assert!(
            matches!(lost, Err(ref error) if error.code == RuntimeErrorCode::StorageUnavailable),
            "the real stage retirement commit must precede its lost acknowledgement"
        );
        assert_eq!(
            setup
                .commits
                .lost_stage_retirement_acks
                .load(Ordering::SeqCst),
            1
        );
        let committed = setup.persistence.state.snapshot(&setup.account).unwrap();
        assert!(committed.bootstrap.staging_generation.is_none());
        assert!(committed.bootstrap.policy_verification_pending);
        assert_eq!(
            committed.bootstrap.pending_vault_retirements,
            vec![TEST_VAULT_ID.to_string()]
        );
        assert_eq!(
            committed.bootstrap.active_cursor,
            before_lost.bootstrap.active_cursor
        );
        assert_eq!(committed.operations, before_lost.operations);
        assert!(committed
            .bootstrap
            .vaults
            .keys()
            .all(|(_, id)| id != TEST_VAULT_ID));
        assert!(committed
            .bootstrap
            .items
            .values()
            .all(|item| item.vault_id != TEST_VAULT_ID));
        assert!(committed
            .items
            .iter()
            .all(|item| item.vault_id != TEST_VAULT_ID));
        let cached = setup.runtime.replica.snapshot(&setup.account).unwrap();
        assert_eq!(
            cached.bootstrap.staging_generation, before_lost.bootstrap.staging_generation,
            "the retry must recover through an uncached physical reload after the lost acknowledgement"
        );
        fresh_policy.release.add_permits(1);
    }
    let disabled = setup
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await;
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let session = setup
        .runtime
        .effective_session(&setup.account, &after.incarnation)
        .await
        .unwrap()
        .unwrap();
    let selected_wrapper_remains = session
        .vault_keys
        .iter()
        .any(|key| key.vault_id == "vault-2");
    let older_wrapper_remains = session
        .vault_keys
        .iter()
        .any(|key| key.vault_id == TEST_VAULT_ID);
    drop(session);
    let selected_authority_remains = after.bootstrap.vaults.keys().any(|(_, id)| id == "vault-2")
        || after
            .bootstrap
            .items
            .values()
            .any(|item| item.vault_id == "vault-2")
        || after.items.iter().any(|item| item.vault_id == "vault-2");
    let older_authority_remains = after
        .bootstrap
        .vaults
        .keys()
        .any(|(_, id)| id == TEST_VAULT_ID)
        || after
            .bootstrap
            .items
            .values()
            .any(|item| item.vault_id == TEST_VAULT_ID)
        || after
            .items
            .iter()
            .any(|item| item.vault_id == TEST_VAULT_ID);
    setup.runtime.close().await;

    assert!(
        !selected_plaintext_during_session_read,
        "both verified selections must refuse new plaintext before promotion reads Sessions"
    );
    assert!(
        selected_retired,
        "fresh verified restriction must notify its Export before an older complete stage waits on cleanup"
    );
    assert!(
        caller_waited,
        "the selected Export has not acknowledged disposal"
    );
    if pending_after_capture {
        assert_eq!(
            fresh_policy.entered.available_permits(),
            if reject_stage_commit || lose_stage_ack {
                2
            } else {
                1
            },
            "every public retry must obtain its own fresh current policy"
        );
        assert!(
            disabled.is_ok(),
            "fresh verified policy must resolve pending while preserving the captured stage and selected proof"
        );
        assert!(!after.bootstrap.policy_verification_pending);
        assert_eq!(
            after.bootstrap.active_cursor, before.bootstrap.active_cursor,
            "retirement-only adoption must not publish the captured stage cursor"
        );
        assert_eq!(
            setup.server.policy_settings_requests.lock().unwrap().len(),
            1,
            "pending recovery cannot replay the abandoned settings mutation"
        );
    }
    assert!(matches!(disabled, Ok(RuntimeResponse::TravelMode {
        result: crate::TravelModeCommandResult::Confirmed { policy, .. }, ..
    }) if !policy.enabled && policy.hidden_vault_ids.iter().map(String::as_str).eq(selected_ids.iter().copied())));
    assert!(
        !selected_authority_remains,
        "caller loss must not discard selected authority erasure"
    );
    assert!(
        !selected_wrapper_remains,
        "caller loss must not retain the selected Session wrapper"
    );
    assert!(
        !older_authority_remains && !older_wrapper_remains,
        "the older complete stage's absence proof must retire its own authority and Session wrapper"
    );
    assert!(after.bootstrap.pending_vault_retirements.is_empty());
    assert_eq!(
        after.operations, before.operations,
        "the selected accepted ciphertext survives both histories"
    );
    assert!(selected_export.begin_vault_export_output().is_err());
}

#[tokio::test]
async fn verified_restriction_survives_caller_loss_before_older_complete_stage_cleanup() {
    assert_complete_stage_policy_caller_loss(CompleteStageHistory::DisjointSelection).await;
}

#[tokio::test]
async fn overlapping_verified_selection_survives_older_complete_stage_cleanup() {
    assert_complete_stage_policy_caller_loss(CompleteStageHistory::OverlappingSelection).await;
}

#[tokio::test]
async fn fresh_policy_resolves_pending_with_captured_complete_stage_and_selected_proof() {
    assert_complete_stage_policy_caller_loss(CompleteStageHistory::PendingPolicy).await;
}

#[tokio::test]
async fn rejected_retirement_only_commit_preserves_complete_proof_for_public_retry() {
    assert_complete_stage_policy_caller_loss(CompleteStageHistory::RejectedRetirementCommit).await;
}

#[tokio::test]
async fn lost_retirement_only_ack_recovers_the_physical_journal_before_public_retry() {
    assert_complete_stage_policy_caller_loss(CompleteStageHistory::LostRetirementAcknowledgement)
        .await;
}

/// A fresh owner cannot inherit the uncommitted newer policy proof. Only the persisted older
/// complete-stage absence and Session documents supply this acceptance duty.
async fn assert_reopened_complete_stage_duty(
    setup: Setup,
    platform: Arc<CompleteStagePolicyReadGate>,
    expected: crate::replica::ReplicaSnapshot,
) {
    use crate::platform_storage::{DeviceCatalogAccount, DeviceCatalogDocument};
    setup
        .runtime
        .platform_storage
        .store_device_catalog(
            &DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
                account_id: setup.account.clone(),
                active_incarnation: Some(expected.incarnation.clone()),
                pending_retirement: None,
                pending_install: None,
            }])
            .unwrap(),
        )
        .await
        .unwrap();
    let metadata = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &expected.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(metadata
        .verified_travel_mode
        .as_ref()
        .is_some_and(|policy| !policy.enabled));
    setup.runtime.close().await;
    let Setup {
        runtime: old_runtime,
        account,
        commits,
        server,
        timer,
        persistence,
    } = setup;
    drop(old_runtime);
    let reopened = Runtime::with_test_dispatch_environment(
        commits,
        platform,
        server,
        auth_config(),
        timer.clock.clone(),
        timer,
    );
    reopened.ready.store(false, Ordering::SeqCst);
    assert!(
        reopened
            .foreground_attachments
            .pending_vault_retirements(&account, &expected.incarnation,)
            .is_empty(),
        "the fresh owner must not reuse transient retirement proof"
    );
    let opened = tokio::time::timeout(std::time::Duration::from_secs(2), reopened.open())
        .await
        .expect("existing local retirement during open must be bounded");
    let current = persistence.state.snapshot(&account).unwrap();
    let session = reopened
        .platform_storage
        .load_current_session(&account, &expected.incarnation)
        .await
        .unwrap()
        .unwrap();
    let old_wrapper_remains = session
        .vault_keys
        .iter()
        .any(|key| key.vault_id == TEST_VAULT_ID);
    drop(session);
    let after_metadata = reopened
        .platform_storage
        .load_account_metadata(&account, &expected.incarnation)
        .await
        .unwrap()
        .unwrap();
    reopened.close().await;
    assert!(
        opened.is_ok(),
        "the retained complete-stage duty must resume through public open"
    );
    assert!(
        current.bootstrap.staging_generation.is_none(),
        "public open must replace the original complete-stage proof before exposing the new owner"
    );
    assert!(current.bootstrap.pending_vault_retirements.is_empty());
    assert!(
        current.bootstrap.policy_verification_pending,
        "local cleanup cannot manufacture a current policy verification"
    );
    assert_eq!(
        current.bootstrap.active_cursor,
        expected.bootstrap.active_cursor
    );
    assert_eq!(current.operations, expected.operations);
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
    assert!(
        !old_wrapper_remains,
        "the older durable proof must prune its dormant Session key"
    );
    assert_eq!(
        after_metadata.verified_travel_mode, metadata.verified_travel_mode,
        "reopen must not invent durability for the newer transient policy proof"
    );
}

#[tokio::test]
async fn fresh_owner_retires_pending_complete_stage_without_transient_policy_evidence() {
    assert_complete_stage_policy_caller_loss(CompleteStageHistory::FreshOwnerAfterRejectedCommit)
        .await;
}
#[tokio::test]
async fn fresh_owner_keeps_pending_complete_stage_when_no_scope_is_omitted() {
    use crate::platform_storage::{DeviceCatalogAccount, DeviceCatalogDocument};
    let captured = Arc::new(Mutex::new(None));
    let capture = captured.clone();
    let setup = setup_with_platform(move |inner, replica| {
        let gate = Arc::new(CompleteStagePolicyReadGate {
            inner,
            replica,
            armed: AtomicBool::new(false),
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            hold_session_read: AtomicBool::new(false),
            session_entered: Semaphore::new(0),
            session_release: Semaphore::new(0),
        });
        *capture.lock().unwrap() = Some(gate.clone());
        gate
    })
    .await;
    let platform = captured.lock().unwrap().take().unwrap();
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let authority = before.bootstrap.snapshot();
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"complete-no-omission"}}),
        json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"complete-no-omission"}}),
    ]);
    *setup.server.policy_read.lock().unwrap() = Some(retained_policy_gate(false, &[]));
    platform.armed.store(true, Ordering::SeqCst);
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"complete-no-omission","type":"vault_updated","entityType":"vault",
            "entityId":TEST_VAULT_ID,"userId":USER,"vaultId":TEST_VAULT_ID,
            "clientId":"second-device","metadata":null,"timestamp":"1700000000001","version":1
        })],
        "complete-no-omission",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&platform.entered).await;
    runner.abort();
    assert!(runner.await.unwrap_err().is_cancelled());
    let hold = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: json!({"type":"networkFailure"}),
    });
    *setup.server.policy_settings_hold.lock().unwrap() = Some(hold.clone());
    let owner = setup.runtime.clone();
    let account_id = setup.account.clone();
    let mutation = tokio::spawn(async move {
        owner
            .request(
                RuntimeRequest::SetTravelModeHiddenVaults {
                    account_id,
                    hidden_vault_ids: vec![],
                },
                RequestCancellation::new(),
            )
            .await
    });
    permit(&hold.entered).await;
    mutation.abort();
    assert!(mutation.await.unwrap_err().is_cancelled());
    let expected = setup.persistence.state.snapshot(&setup.account).unwrap();
    assert!(expected.bootstrap.policy_verification_pending);
    assert!(expected.bootstrap.pending_vault_retirements.is_empty());
    let stage = expected.bootstrap.staging_generation.as_ref().unwrap();
    assert!(expected.bootstrap.generations[stage].final_page_staged);
    assert!(expected.bootstrap.vaults.keys().all(|(_, id)| {
        expected
            .bootstrap
            .vaults
            .contains_key(&(stage.clone(), id.clone()))
    }));
    let session = setup
        .runtime
        .platform_storage
        .load_current_session(&setup.account, &expected.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(session.vault_keys.iter().all(|key| {
        expected
            .bootstrap
            .vaults
            .contains_key(&(stage.clone(), key.vault_id.clone()))
    }));
    let original_wrappers = serde_json::to_value(&session.vault_keys).unwrap();
    drop(session);
    setup
        .runtime
        .platform_storage
        .store_device_catalog(
            &DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
                account_id: setup.account.clone(),
                active_incarnation: Some(expected.incarnation.clone()),
                pending_retirement: None,
                pending_install: None,
            }])
            .unwrap(),
        )
        .await
        .unwrap();
    let original_policy = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &expected.incarnation)
        .await
        .unwrap()
        .unwrap()
        .verified_travel_mode;
    setup.runtime.close().await;
    let Setup {
        runtime: old,
        account,
        commits,
        server,
        timer,
        persistence,
    } = setup;
    drop(old);
    let reopened = Runtime::with_test_dispatch_environment(
        commits,
        platform,
        server,
        auth_config(),
        timer.clock.clone(),
        timer,
    );
    reopened.ready.store(false, Ordering::SeqCst);
    let opened = tokio::time::timeout(std::time::Duration::from_secs(2), reopened.open())
        .await
        .expect("empty omission startup must complete without a policy HTTP read");
    let current = persistence.state.snapshot(&account).unwrap();
    let session = reopened
        .platform_storage
        .load_current_session(&account, &expected.incarnation)
        .await
        .unwrap()
        .unwrap();
    let retained_wrappers = serde_json::to_value(&session.vault_keys).unwrap();
    drop(session);
    let current_policy = reopened
        .platform_storage
        .load_account_metadata(&account, &expected.incarnation)
        .await
        .unwrap()
        .unwrap()
        .verified_travel_mode;
    reopened.close().await;
    assert!(opened.is_ok());
    assert_eq!(
        current.bootstrap.staging_generation,
        expected.bootstrap.staging_generation
    );
    assert_eq!(
        current.bootstrap.generations,
        expected.bootstrap.generations
    );
    assert_eq!(current.bootstrap.vaults, expected.bootstrap.vaults);
    assert_eq!(current.bootstrap.items, expected.bootstrap.items);
    assert_eq!(
        current.bootstrap.active_cursor,
        expected.bootstrap.active_cursor
    );
    assert!(current.bootstrap.policy_verification_pending);
    assert!(current.bootstrap.pending_vault_retirements.is_empty());
    assert_eq!(current.operations, expected.operations);
    assert_eq!(retained_wrappers, original_wrappers);
    assert_eq!(current_policy, original_policy);
}
struct DifferingStageProofGate {
    stage: Arc<CompleteStagePolicyReadGate>,
    hold_policy_metadata: AtomicBool,
    entered: Semaphore,
    release: Semaphore,
}

#[async_trait]
impl SerializedPlatformStorageExecutor for DifferingStageProofGate {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<zeroize::Zeroizing<String>, RuntimeError> {
        let request: Value = serde_json::from_str(&request_json).unwrap();
        if request["type"] == "get"
            && request["key"]
                .as_str()
                .is_some_and(|key| key.ends_with(":metadata"))
            && self.hold_policy_metadata.swap(false, Ordering::SeqCst)
        {
            self.entered.add_permits(1);
            self.release.acquire().await.unwrap().forget();
        }
        self.stage.invoke(request_json).await
    }
}

#[tokio::test]
async fn complete_stage_omissions_survive_a_selected_vaults_different_policy_proof() {
    let captured = Arc::new(Mutex::new(None));
    let capture = captured.clone();
    let setup = setup_with_platform(move |inner, replica| {
        let stage = Arc::new(CompleteStagePolicyReadGate {
            inner,
            replica,
            armed: AtomicBool::new(false),
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            hold_session_read: AtomicBool::new(false),
            session_entered: Semaphore::new(0),
            session_release: Semaphore::new(0),
        });
        let gate = Arc::new(DifferingStageProofGate {
            stage,
            hold_policy_metadata: AtomicBool::new(false),
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        });
        *capture.lock().unwrap() = Some(gate.clone());
        gate
    })
    .await;
    let gate = captured.lock().unwrap().take().unwrap();
    assert!(matches!(
        setup
            .runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: setup.account.clone(),
                    vault_id: TEST_VAULT_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new()
            )
            .await
            .unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let selected_sink = Arc::new(MarkerPolicySink::default());
    let selected_export = setup
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: setup.account.clone(),
                vault_ids: vec![TEST_VAULT_ID.into()],
            },
            selected_sink.clone(),
        )
        .unwrap();
    let omitted_sink = Arc::new(MarkerPolicySink::default());
    let omitted_export = setup
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: setup.account.clone(),
                vault_ids: vec!["vault-2".into()],
            },
            omitted_sink.clone(),
        )
        .unwrap();
    assert!(matches!(
        selected_sink.0.lock().unwrap().as_slice(),
        [RuntimeProjection::VaultExport(_)]
    ));
    assert!(matches!(
        omitted_sink.0.lock().unwrap().as_slice(),
        [RuntimeProjection::VaultExport(_)]
    ));
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    setup.server.bootstrap_pages.lock().unwrap().extend([
        json!({"phase":"vaults","vaults":[],"hasMore":false,"nextCursor":null,"syncCursor":{"id":"complete-differing-proof-omissions"}}),
        json!({"phase":"items","items":[],"hasMore":false,"nextCursor":null,"syncCursor":{"id":"complete-differing-proof-omissions"}}),
    ]);
    *setup.server.policy_read.lock().unwrap() = Some(retained_policy_gate(false, &[]));
    gate.stage.armed.store(true, Ordering::SeqCst);
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"complete-differing-proof-omissions","type":"vault_deleted","entityType":"vault",
            "entityId":TEST_VAULT_ID,"userId":USER,"vaultId":TEST_VAULT_ID,
            "clientId":"second-device","metadata":null,"timestamp":"1700000000001","version":1
        })],
        "complete-differing-proof-omissions",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&gate.stage.entered).await;
    runner.abort();
    assert!(runner.await.unwrap_err().is_cancelled());
    let complete = setup.persistence.state.snapshot(&setup.account).unwrap();
    let stage = complete.bootstrap.staging_generation.clone().unwrap();
    assert!(complete.bootstrap.generations[&stage].final_page_staged);
    for id in [TEST_VAULT_ID, "vault-2"] {
        assert!(before.bootstrap.vaults.keys().any(|(_, vault)| vault == id));
        assert!(
            !complete
                .bootstrap
                .vaults
                .contains_key(&(stage.clone(), id.into())),
            "the actual complete authority stage must omit each older Vault"
        );
    }
    assert!(selected_sink.1.lock().unwrap().is_empty());
    assert!(omitted_sink.1.lock().unwrap().is_empty());
    let hold = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: json!({"type":"networkFailure"}),
    });
    *setup.server.policy_settings_hold.lock().unwrap() = Some(hold.clone());
    let owner = setup.runtime.clone();
    let account_id = setup.account.clone();
    let mutation = tokio::spawn(async move {
        owner
            .request(
                RuntimeRequest::SetTravelModeHiddenVaults {
                    account_id,
                    hidden_vault_ids: vec![],
                },
                RequestCancellation::new(),
            )
            .await
    });
    permit(&hold.entered).await;
    mutation.abort();
    assert!(mutation.await.unwrap_err().is_cancelled());
    assert!(
        setup
            .persistence
            .state
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .policy_verification_pending
    );
    let restrictive = retained_policy_gate(true, &[TEST_VAULT_ID]);
    restrictive.release.try_acquire().unwrap().forget();
    *setup.server.policy_read.lock().unwrap() = Some(restrictive.clone());
    let first = spawn_policy_refresh(&setup);
    permit(&restrictive.entered).await;
    gate.hold_policy_metadata.store(true, Ordering::SeqCst);
    restrictive.release.add_permits(1);
    permit(&gate.entered).await;
    assert_eq!(selected_sink.1.lock().unwrap().len(), 1);
    assert!(omitted_sink.1.lock().unwrap().is_empty());
    assert!(matches!(
        omitted_sink.0.lock().unwrap().as_slice(),
        [RuntimeProjection::VaultExport(_)]
    ));
    let fenced = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(fenced.bootstrap.staging_generation, Some(stage.clone()));
    assert!(fenced.bootstrap.policy_verification_pending);
    assert!(fenced.bootstrap.pending_vault_retirements.is_empty());
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    *setup.server.policy_read.lock().unwrap() = Some(retained_policy_gate(false, &[]));
    let retry = spawn_policy_refresh(&setup);
    let omitted_notified = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while omitted_sink.1.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    let waited = !retry.is_finished();
    selected_sink.0.lock().unwrap().clear();
    omitted_sink.0.lock().unwrap().clear();
    selected_export.close();
    omitted_export.close();
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), retry)
        .await
        .expect("existing retry must finish after both disposal acknowledgements")
        .unwrap();
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let session = setup
        .runtime
        .platform_storage
        .load_current_session(&setup.account, &after.incarnation)
        .await
        .unwrap()
        .unwrap();
    let wrappers_remain = session
        .vault_keys
        .iter()
        .any(|key| [TEST_VAULT_ID, "vault-2"].contains(&key.vault_id.as_str()));
    drop(session);
    setup.runtime.close().await;
    assert!(
        omitted_notified,
        "the complete stage's other omission must be fenced before a different selected proof waits on cleanup"
    );
    assert!(
        waited,
        "the first selected Export has not acknowledged disposal"
    );
    assert!(matches!(result, Ok(RuntimeResponse::TravelMode {
        result: crate::TravelModeCommandResult::Confirmed { policy, .. }, ..
    }) if !policy.enabled));
    assert!(after.bootstrap.staging_generation.is_none());
    assert!(after.bootstrap.pending_vault_retirements.is_empty());
    assert!(!after.bootstrap.policy_verification_pending);
    for id in [TEST_VAULT_ID, "vault-2"] {
        assert!(after.bootstrap.vaults.keys().all(|(_, vault)| vault != id));
        assert!(after
            .bootstrap
            .items
            .values()
            .all(|item| item.vault_id != id));
        assert!(after.items.iter().all(|item| item.vault_id != id));
    }
    assert!(!wrappers_remain);
    assert_eq!(
        after.bootstrap.active_cursor,
        before.bootstrap.active_cursor
    );
    assert_eq!(after.operations, before.operations);
    assert_eq!(
        setup.server.policy_settings_requests.lock().unwrap().len(),
        1
    );
}
