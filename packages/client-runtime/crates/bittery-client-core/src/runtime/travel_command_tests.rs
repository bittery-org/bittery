//! Foreground commands are exercised through the same public Runtime and HTTP primitive seam.
use super::*;

#[tokio::test]
async fn explicit_travel_refresh_verifies_current_policy_without_accepting_an_operation() {
    let setup = setup().await;
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let gate = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled": false, "hiddenVaultIds": [TEST_VAULT_ID],
                "updatedAt": "2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    });
    *setup.server.policy_read.lock().unwrap() = Some(gate.clone());
    let response = setup
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect("explicit refresh must establish current verified Travel policy");
    match response {
        RuntimeResponse::TravelMode {
            account_id,
            result:
                crate::TravelModeCommandResult::Confirmed {
                    policy,
                    enforcement,
                },
        } => {
            assert_eq!(account_id, setup.account);
            assert!(!policy.enabled);
            assert_eq!(policy.hidden_vault_ids, [TEST_VAULT_ID]);
            assert_eq!(enforcement, crate::TravelModeEnforcement::Ready);
        }
        _ => panic!("refresh did not confirm the current policy"),
    }
    assert_eq!(
        gate.entered.available_permits(),
        1,
        "refresh must perform one fresh policy read"
    );
    assert_eq!(
        setup.server.finite.refresh_calls.load(Ordering::SeqCst),
        0,
        "a usable retained Session needs no replacement"
    );
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(
        after.operations, before.operations,
        "settings refresh is not an accepted Operation"
    );
    let stored = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &after.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(!stored.verified_travel_mode.unwrap().enabled);
    setup.runtime.close().await;
}

#[derive(Default)]
struct TravelSink(Mutex<Vec<RuntimeProjection>>);
impl crate::ObservationSink for TravelSink {
    fn publish(&self, value: RuntimeProjection) {
        self.0.lock().unwrap().push(value);
    }
}

#[tokio::test]
async fn travel_observation_distinguishes_unknown_policy_from_verified_disabled_configuration() {
    let setup = setup().await;
    let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let metadata = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    // The shared fixture seeds an unlocked Account without running production installation.
    setup
        .runtime
        .account_display_identities
        .lock()
        .unwrap()
        .insert(setup.account.clone(), account_presentation(&metadata));
    let sink = Arc::new(TravelSink::default());
    let _observer = setup
        .runtime
        .observe(
            ObservationRequest::TravelMode {
                account_id: setup.account.clone(),
            },
            sink.clone(),
        )
        .expect("settings must observe unknown policy without treating it as disabled");
    assert!(matches!(sink.0.lock().unwrap().as_slice(),
        [RuntimeProjection::TravelMode(value)]
        if value.account_id == setup.account && value.last_verified_policy.is_none()
            && value.enforcement == crate::TravelModeEnforcement::Unverified));
    *setup.server.policy_read.lock().unwrap() = Some(Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled": false, "hiddenVaultIds": [], "updatedAt": "2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    }));
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
    assert!(matches!(sink.0.lock().unwrap().last(),
        Some(RuntimeProjection::TravelMode(value))
        if value.account_id == setup.account
            && value.last_verified_policy.as_ref().is_some_and(|policy| !policy.enabled)
            && value.enforcement == crate::TravelModeEnforcement::Ready));
    setup.runtime.close().await;
}

#[tokio::test]
async fn unavailable_travel_refresh_reports_uncertainty_and_preserves_verified_configuration() {
    let setup = setup().await;
    *setup.server.policy_read.lock().unwrap() = Some(Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled": false, "hiddenVaultIds": [TEST_VAULT_ID],
                "updatedAt": "2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    }));
    let initial = setup
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::TravelMode {
        result:
            crate::TravelModeCommandResult::Confirmed {
                policy: previous, ..
            },
        ..
    } = initial
    else {
        panic!("initial policy was not verified")
    };
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let metadata = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &before.incarnation)
        .await
        .unwrap()
        .unwrap();
    let gate = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: json!({"type": "networkFailure"}),
    });
    *setup.server.policy_read.lock().unwrap() = Some(gate.clone());
    let response = setup
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: setup.account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect("unavailable current policy must produce an explicit uncertain settings result");
    assert_eq!(
        response,
        RuntimeResponse::TravelMode {
            account_id: setup.account.clone(),
            result: crate::TravelModeCommandResult::Uncertain {
                last_verified_policy: Some(previous)
            },
        }
    );
    assert_eq!(
        gate.entered.available_permits(),
        1,
        "one bounded current read, no request replay"
    );
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(after.operations, before.operations);
    assert_eq!(
        setup
            .runtime
            .platform_storage
            .load_account_metadata(&setup.account, &after.incarnation)
            .await
            .unwrap()
            .unwrap(),
        metadata,
        "an unavailable read must not replace verified metadata"
    );
    setup.runtime.close().await;
}

#[tokio::test]
async fn mounted_travel_observation_reports_unverified_before_the_policy_read_returns() {
    let setup = setup().await;
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
    let sink = Arc::new(TravelSink::default());
    let _observer = setup
        .runtime
        .observe(
            ObservationRequest::TravelMode {
                account_id: setup.account.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    assert!(
        matches!(sink.0.lock().unwrap().last(), Some(RuntimeProjection::TravelMode(value))
        if value.enforcement == crate::TravelModeEnforcement::Ready)
    );
    let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
    permit(&setup.server.changes).await;
    until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
    let gate = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: json!({"type":"networkFailure"}),
    });
    *setup.server.policy_read.lock().unwrap() = Some(gate.clone());
    setup.server.finite.script_sync_page(
        vec![json!({
            "id":"settings-policy-invalidation", "type":"travel_mode_updated", "entityType":"user",
            "entityId":USER, "userId":USER, "vaultId":null, "clientId":"second-device",
            "metadata":{"enabled":true,"hiddenVaultIds":[TEST_VAULT_ID]},
            "timestamp":"1700000000001", "version":1
        })],
        "settings-policy-invalidation",
        false,
    );
    setup.server.hint(b"event: sync\ndata: {}\n\n");
    permit(&gate.entered).await;
    let during_read = sink.0.lock().unwrap().last().cloned();
    gate.release.add_permits(1);
    setup.runtime.close().await;
    runner.await.unwrap();
    assert!(
        matches!(during_read, Some(RuntimeProjection::TravelMode(value))
        if value.account_id == setup.account
            && value.enforcement == crate::TravelModeEnforcement::Unverified
            && value.last_verified_policy.as_ref().is_some_and(|policy| !policy.enabled)),
        "a mounted settings observer must retain prior configuration but report pending verification before GET returns"
    );
}

#[tokio::test]
async fn saving_travel_selection_uses_one_foreground_request_without_hiding_vaults() {
    let setup = setup().await;
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
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    *setup.server.policy_settings_response.lock().unwrap() = Some(completed(
        200,
        serde_json::to_vec(&json!({
            "enabled":false,"hiddenVaultIds":[TEST_VAULT_ID],"updatedAt":"2023-11-14T22:13:20Z"
        }))
        .unwrap(),
    ));
    let result = setup
        .runtime
        .request(
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id: setup.account.clone(),
                hidden_vault_ids: vec![TEST_VAULT_ID.into()],
            },
            RequestCancellation::new(),
        )
        .await
        .expect("saving an existing visible Vault selection is a foreground settings request");
    assert!(matches!(result, RuntimeResponse::TravelMode {
        account_id,
        result: crate::TravelModeCommandResult::Confirmed { policy, enforcement: crate::TravelModeEnforcement::Ready }
    } if account_id == setup.account && !policy.enabled && policy.hidden_vault_ids == [TEST_VAULT_ID]));
    {
        let requests = setup.server.policy_settings_requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["method"], "PUT");
        assert_eq!(
            requests[0]["url"],
            format!("{SERVER_URL}/api/v1/travel-mode/hidden-vaults")
        );
        let body = requests[0]["body"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"hiddenVaultIds":[TEST_VAULT_ID]})
        );
        assert!(!requests[0]["headers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|header| header["name"]
                .as_str()
                .unwrap()
                .eq_ignore_ascii_case("idempotency-key")));
    }
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(after.operations, before.operations);
    assert_eq!(after.bootstrap.vaults, before.bootstrap.vaults);
    assert!(after.bootstrap.pending_vault_retirements.is_empty());
    let stored = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &after.incarnation)
        .await
        .unwrap()
        .unwrap()
        .verified_travel_mode
        .unwrap();
    assert!(!stored.enabled);
    assert_eq!(stored.hidden_vault_ids, [TEST_VAULT_ID]);
    setup.runtime.close().await;
}

#[tokio::test]
async fn lost_selection_answer_is_reconciled_by_one_current_read_without_reposting() {
    let setup = setup().await;
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
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    *setup.server.policy_settings_response.lock().unwrap() = Some(json!({"type":"networkFailure"}));
    let read = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled":false,"hiddenVaultIds":[TEST_VAULT_ID],"updatedAt":"2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    });
    *setup.server.policy_read.lock().unwrap() = Some(read.clone());
    let result = setup
        .runtime
        .request(
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id: setup.account.clone(),
                hidden_vault_ids: vec![TEST_VAULT_ID.into()],
            },
            RequestCancellation::new(),
        )
        .await
        .expect(
            "a lost settings answer must reconcile current policy without replaying the mutation",
        );
    assert!(matches!(result, RuntimeResponse::TravelMode {
        account_id,
        result: crate::TravelModeCommandResult::Confirmed { policy, enforcement: crate::TravelModeEnforcement::Ready }
    } if account_id == setup.account && !policy.enabled && policy.hidden_vault_ids == [TEST_VAULT_ID]));
    assert_eq!(
        setup.server.policy_settings_requests.lock().unwrap().len(),
        1,
        "current-state confirmation must never repost the foreground mutation"
    );
    assert_eq!(read.entered.available_permits(), 1);
    assert_eq!(setup.server.finite.refresh_calls.load(Ordering::SeqCst), 0);
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(after.operations, before.operations);
    let policy = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &after.incarnation)
        .await
        .unwrap()
        .unwrap()
        .verified_travel_mode
        .unwrap();
    assert!(!policy.enabled);
    assert_eq!(policy.hidden_vault_ids, [TEST_VAULT_ID]);
    setup.runtime.close().await;
}

#[tokio::test]
async fn lost_selection_mutation_reports_conflicting_current_policy_without_overwriting_it() {
    for enable in [false, true] {
        let setup = setup().await;
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
        let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
        *setup.server.policy_settings_response.lock().unwrap() =
            Some(json!({"type":"networkFailure"}));
        let read = Arc::new(PolicyReadGate {
            entered: Semaphore::new(0),
            release: Semaphore::new(1),
            response: completed(
                200,
                serde_json::to_vec(&json!({
                    "enabled":false,"hiddenVaultIds":[],"updatedAt":"2023-11-14T22:13:20Z"
                }))
                .unwrap(),
            ),
        });
        *setup.server.policy_read.lock().unwrap() = Some(read.clone());
        let request = if enable {
            RuntimeRequest::EnableTravelMode {
                account_id: setup.account.clone(),
                hidden_vault_ids: vec![TEST_VAULT_ID.into()],
            }
        } else {
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id: setup.account.clone(),
                hidden_vault_ids: vec![TEST_VAULT_ID.into()],
            }
        };
        let result = setup
            .runtime
            .request(request, RequestCancellation::new())
            .await
            .unwrap();
        assert!(matches!(result, RuntimeResponse::TravelMode {
            account_id,
            result: crate::TravelModeCommandResult::RetryRequired { policy }
        } if account_id == setup.account && !policy.enabled && policy.hidden_vault_ids.is_empty()));
        {
            let requests = setup.server.policy_settings_requests.lock().unwrap();
            assert_eq!(
                requests.len(),
                1,
                "a differing current policy cannot replay settings"
            );
            assert_eq!(requests[0]["method"], if enable { "POST" } else { "PUT" });
        }
        assert_eq!(read.entered.available_permits(), 1);
        assert_eq!(setup.server.finite.refresh_calls.load(Ordering::SeqCst), 0);
        let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
        assert_eq!(after.operations, before.operations);
        assert_eq!(after.bootstrap.vaults, before.bootstrap.vaults);
        assert!(after.bootstrap.pending_vault_retirements.is_empty());
        assert!(!after.bootstrap.policy_verification_pending);
        let policy = setup
            .runtime
            .platform_storage
            .load_account_metadata(&setup.account, &after.incarnation)
            .await
            .unwrap()
            .unwrap()
            .verified_travel_mode
            .unwrap();
        assert!(!policy.enabled);
        assert!(policy.hidden_vault_ids.is_empty());
        setup.runtime.close().await;
    }
}

#[tokio::test]
async fn enabling_travel_sends_one_selection_and_erases_only_selected_vault_authority() {
    let setup = setup().await;
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
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    *setup.server.policy_settings_response.lock().unwrap() = Some(completed(
        200,
        serde_json::to_vec(&json!({
            "enabled":true,"hiddenVaultIds":[TEST_VAULT_ID],
            "enabledAt":"2023-11-14T22:13:20Z","updatedAt":"2023-11-14T22:13:20Z"
        }))
        .unwrap(),
    ));
    let result = setup
        .runtime
        .request(
            RuntimeRequest::EnableTravelMode {
                account_id: setup.account.clone(),
                hidden_vault_ids: vec![TEST_VAULT_ID.into()],
            },
            RequestCancellation::new(),
        )
        .await
        .expect("enable must reconcile the selected Vault through shared erasure");
    assert!(matches!(result, RuntimeResponse::TravelMode {
        account_id, result: crate::TravelModeCommandResult::Confirmed {
            policy, enforcement: crate::TravelModeEnforcement::Ready
        }
    } if account_id == setup.account && policy.enabled && policy.hidden_vault_ids == [TEST_VAULT_ID]));
    {
        let requests = setup.server.policy_settings_requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            1,
            "enable must not first save selection or accept a durable Operation"
        );
        assert_eq!(requests[0]["method"], "POST");
        assert_eq!(
            requests[0]["url"],
            format!("{SERVER_URL}/api/v1/travel-mode/enable")
        );
        let body = requests[0]["body"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({"hiddenVaultIds":[TEST_VAULT_ID]})
        );
    }
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    assert_eq!(after.operations, before.operations);
    assert!(after
        .bootstrap
        .items
        .values()
        .all(|item| item.vault_id != TEST_VAULT_ID));
    assert!(after
        .bootstrap
        .vaults
        .values()
        .all(|vault| vault.id != TEST_VAULT_ID));
    assert!(before
        .bootstrap
        .vaults
        .values()
        .any(|vault| vault.id == "vault-2"));
    assert!(after
        .bootstrap
        .vaults
        .values()
        .any(|vault| vault.id == "vault-2"));
    assert!(after.bootstrap.pending_vault_retirements.is_empty());
    let session = setup
        .runtime
        .effective_session(&setup.account, &after.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(session
        .vault_keys
        .iter()
        .all(|key| key.vault_id != TEST_VAULT_ID));
    drop(session);
    setup.runtime.close().await;
}

#[tokio::test]
async fn malformed_successful_settings_policy_uses_current_read_without_replaying_mutation() {
    for enable in [false, true] {
        let setup = setup().await;
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
        *setup.server.policy_settings_response.lock().unwrap() = Some(completed(
            200,
            serde_json::to_vec(&json!({
                "enabled":enable,"hiddenVaultIds":[TEST_VAULT_ID],
                "enabledAt":"invalid timestamp","updatedAt":"2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ));
        let read = Arc::new(PolicyReadGate {
            entered: Semaphore::new(0),
            release: Semaphore::new(1),
            response: completed(
                200,
                serde_json::to_vec(&json!({
                    "enabled":enable,"hiddenVaultIds":[TEST_VAULT_ID],
                    "enabledAt":if enable {Some("2023-11-14T22:13:20Z")}else{None},
                    "updatedAt":"2023-11-14T22:13:20Z"
                }))
                .unwrap(),
            ),
        });
        *setup.server.policy_read.lock().unwrap() = Some(read.clone());
        let request = if enable {
            RuntimeRequest::EnableTravelMode {
                account_id: setup.account.clone(),
                hidden_vault_ids: vec![TEST_VAULT_ID.into()],
            }
        } else {
            RuntimeRequest::SetTravelModeHiddenVaults {
                account_id: setup.account.clone(),
                hidden_vault_ids: vec![TEST_VAULT_ID.into()],
            }
        };
        let response = setup.runtime.request(request, RequestCancellation::new()).await
            .expect("a malformed successful policy cannot establish mutation outcome; read current policy once");
        assert!(matches!(response, RuntimeResponse::TravelMode {
            result: crate::TravelModeCommandResult::Confirmed {policy, ..}, ..
        } if policy.enabled == enable && policy.hidden_vault_ids == [TEST_VAULT_ID]));
        assert_eq!(read.entered.available_permits(), 1);
        assert_eq!(
            setup.server.policy_settings_requests.lock().unwrap().len(),
            1
        );
        let snapshot = setup.runtime.replica.snapshot(&setup.account).unwrap();
        assert!(!snapshot.bootstrap.policy_verification_pending);
        let policy = setup
            .runtime
            .platform_storage
            .load_account_metadata(&setup.account, &snapshot.incarnation)
            .await
            .unwrap()
            .unwrap()
            .verified_travel_mode
            .unwrap();
        assert_eq!(policy.enabled, enable);
        assert_eq!(policy.hidden_vault_ids, [TEST_VAULT_ID]);
        setup.runtime.close().await;
    }
}

#[tokio::test]
async fn dropped_settings_caller_leaves_verification_for_existing_sync_without_a_hint() {
    settings_caller_loss_reconciles(false).await;
}

#[tokio::test]
async fn quiet_running_sync_reconciles_settings_caller_loss_without_a_server_hint() {
    settings_caller_loss_reconciles(true).await;
}

async fn settings_caller_loss_reconciles(start_with_quiet_connection: bool) {
    let setup = setup().await;
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
    let before = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let runner = if start_with_quiet_connection {
        let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.changes).await;
        until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
        Some(runner)
    } else {
        None
    };
    let policy_response = completed(
        200,
        serde_json::to_vec(&json!({
            "enabled": false, "hiddenVaultIds": [TEST_VAULT_ID],
            "updatedAt": "2023-11-14T22:13:20Z"
        }))
        .unwrap(),
    );
    let hold = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(0),
        response: policy_response.clone(),
    });
    *setup.server.policy_settings_hold.lock().unwrap() = Some(hold.clone());
    let runtime = setup.runtime.clone();
    let account_id = setup.account.clone();
    let caller = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::SetTravelModeHiddenVaults {
                    account_id,
                    hidden_vault_ids: vec![TEST_VAULT_ID.into()],
                },
                RequestCancellation::new(),
            )
            .await
    });
    permit(&hold.entered).await;
    // The Server committed the selection but its response never reaches the caller.
    let current = Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: policy_response,
    });
    *setup.server.policy_read.lock().unwrap() = Some(current.clone());
    let admitted = setup.runtime.replica.snapshot(&setup.account).unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    // An existing driver can finish immediately after execution releases; capture its durable
    // handoff while the response still holds execution. The startup case also checks after abort.
    let pending = if start_with_quiet_connection {
        admitted
    } else {
        setup.runtime.replica.snapshot(&setup.account).unwrap()
    };
    let runner = runner.unwrap_or_else(|| tokio::spawn(setup.runtime.clone().run_live_sync()));
    let verified =
        tokio::time::timeout(std::time::Duration::from_secs(2), current.entered.acquire())
            .await
            .is_ok();
    if verified {
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
    }
    let after = setup.runtime.replica.snapshot(&setup.account).unwrap();
    let metadata = setup
        .runtime
        .platform_storage
        .load_account_metadata(&setup.account, &after.incarnation)
        .await
        .unwrap()
        .unwrap();
    setup.runtime.close().await;
    runner.await.unwrap();
    assert!(
        pending.bootstrap.policy_verification_pending,
        "an admitted settings exchange must leave durable verification after caller loss"
    );
    assert!(
        verified,
        "existing Sync must reconcile admitted settings without an SSE hint"
    );
    assert_eq!(
        metadata.verified_travel_mode.unwrap().hidden_vault_ids,
        [TEST_VAULT_ID]
    );
    assert_eq!(
        setup.server.policy_settings_requests.lock().unwrap().len(),
        1,
        "caller loss must never replay the foreground mutation"
    );
    assert_eq!(after.operations, before.operations);
}
