//! The Share Operation's terminal lifecycle and durable result delivery.

use super::operation_fixtures::seeded_with_share_item;
use super::*;
use crate::{
    CreateShareDraft, RequestCancellation, RuntimeRequest, ShareAccessMode, ShareExpiration,
};
use serde_json::json;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityPlaintext {
    token: String,
    share_key: String,
}

async fn accept_share(harness: &operation_fixtures::Harness) -> String {
    let response = harness
        .runtime
        .request(
            RuntimeRequest::CreateShare {
                account_id: harness.account_id.clone(),
                item_id: "item-existing".into(),
                draft: CreateShareDraft {
                    access_mode: ShareAccessMode::Anyone,
                    expires_in: ShareExpiration::SevenDays,
                    is_one_time_use: false,
                    allowed_emails: Vec::new(),
                },
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::Accepted { operation_id, .. } = response else {
        panic!("Share acceptance must return an Operation identity");
    };
    operation_id
}

#[tokio::test]
async fn production_dispatch_delivers_an_accepted_share_and_retains_its_result() {
    let harness = seeded_with_share_item(false).await;
    let operation_id = accept_share(&harness).await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    operation_fixtures::until("the accepted Share reaches the Server", || {
        harness.server.shares() == 1
    })
    .await;
    operation_fixtures::until("the applied Share result becomes durable", || {
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .is_some_and(|snapshot| snapshot.operations.is_empty())
    })
    .await;

    let RuntimeProjection::PendingShareResults(projected) = harness
        .runtime
        .projection(&ObservationRequest::PendingShareResults {
            account_id: harness.account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected PendingShareResults projection");
    };
    assert_eq!(projected.results.len(), 1);
    assert_eq!(projected.results[0].operation_id, operation_id);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn applied_create_share_answer_is_classified_for_the_accepted_operation() {
    let harness = seeded_with_share_item(false).await;
    accept_share(&harness).await;
    let operation = harness.operation().unwrap();
    let body = serde_json::to_vec(&json!({
        "operationId": operation.operation_id,
        "kind": "create_share",
        "result": {
            "status": "applied",
            "shareLinkId": "share-link-1",
            "baseShareUrl": "https://app.example.test/share/",
            "expiresAt": "2099-01-02T03:04:05Z"
        }
    }))
    .unwrap();

    assert!(matches!(
        harness.runtime.read_dispatch_answer(&operation, 200, &body),
        outcome::SemanticAnswer::Outcome(_)
    ));
}

#[tokio::test]
async fn applied_share_reconciliation_atomically_ends_the_operation() {
    let harness = seeded_with_share_item(false).await;
    let operation_id = accept_share(&harness).await;

    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;

    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(snapshot.operations.is_empty());
    assert_eq!(snapshot.receipts.len(), 1);
    assert_eq!(harness.server.shares(), 1);
}

#[tokio::test]
async fn unlocked_account_projects_the_durable_reconstructed_share_result() {
    let harness = seeded_with_share_item(false).await;
    let operation_id = accept_share(&harness).await;
    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let protected = &snapshot.share_capabilities[0];
    let plaintext = bittery_crypto_core::decrypt_share_capability(
        &bittery_crypto_core::EncryptedData {
            ciphertext: protected.ciphertext.clone(),
            iv: protected.iv.clone(),
            algorithm: protected.algorithm.clone(),
        },
        &crate::test_fixtures::TEST_MASTER_UNLOCK_KEY,
        &bittery_crypto_core::ShareCapabilityAadContext::new(
            harness.account_id.as_str().to_owned(),
            operation_id.clone(),
        )
        .unwrap(),
    )
    .unwrap();
    let capability: CapabilityPlaintext = serde_json::from_str(&plaintext).unwrap();
    let durable_json = serde_json::to_string(&snapshot).unwrap();
    assert!(!durable_json.contains(&capability.token));
    assert!(!durable_json.contains(&capability.share_key));

    let projected = harness
        .runtime
        .projection(&ObservationRequest::PendingShareResults {
            account_id: harness.account_id.clone(),
        })
        .unwrap()
        .projection;
    let RuntimeProjection::PendingShareResults(projected) = projected else {
        panic!("expected PendingShareResults projection");
    };
    assert_eq!(projected.account_id, harness.account_id);
    assert_eq!(projected.results.len(), 1);
    assert_eq!(projected.results[0].operation_id, operation_id);
    assert_eq!(projected.results[0].share_link_id, "share-link-1");
    assert_eq!(projected.results[0].expires_at, "2099-01-02T03:04:05Z");
    assert_eq!(
        projected.results[0].share_url,
        format!(
            "https://app.example.test/share/{}#{}",
            capability.token, capability.share_key
        )
    );
    let debug = format!("{projected:?}");
    assert!(!debug.contains(&capability.token));
    assert!(!debug.contains(&capability.share_key));
}

#[tokio::test]
async fn acknowledge_share_result_is_atomic_and_idempotent_for_one_explicit_account() {
    let harness = seeded_with_share_item(false).await;
    let operation_id = accept_share(&harness).await;
    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;
    assert_eq!(
        harness
            .runtime
            .request(
                RuntimeRequest::AcknowledgeShareResult {
                    account_id: AccountId::from("foreign-account"),
                    operation_id: operation_id.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .err()
            .unwrap()
            .code,
        RuntimeErrorCode::AccountMissing
    );
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .share_capabilities
            .len(),
        1
    );
    harness.replica.fail_next_commits(1);

    let request = RuntimeRequest::AcknowledgeShareResult {
        account_id: harness.account_id.clone(),
        operation_id: operation_id.clone(),
    };
    assert_eq!(
        harness
            .runtime
            .request(request.clone(), RequestCancellation::new())
            .await
            .err()
            .unwrap()
            .code,
        RuntimeErrorCode::InvariantViolation
    );
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .share_capabilities
            .len(),
        1
    );

    let response = harness
        .runtime
        .request(request.clone(), RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        response,
        RuntimeResponse::ShareResultAcknowledged {
            account_id: harness.account_id.clone(),
            operation_id: operation_id.clone(),
        }
    );
    let acknowledged = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(acknowledged.share_capabilities.is_empty());
    assert_eq!(acknowledged.receipts.len(), 1);
    let revision = acknowledged.revision;

    assert_eq!(
        harness
            .runtime
            .request(request, RequestCancellation::new())
            .await
            .unwrap(),
        RuntimeResponse::ShareResultAcknowledged {
            account_id: harness.account_id.clone(),
            operation_id,
        }
    );
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        revision,
        "an idempotent ACK does not invent another durable transition"
    );
}

#[tokio::test]
async fn pending_share_result_survives_lock_and_is_destroyed_by_sign_out() {
    let harness = seeded_with_share_item(false).await;
    let operation_id = accept_share(&harness).await;
    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;

    harness
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: harness.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        harness
            .runtime
            .projection(&ObservationRequest::PendingShareResults {
                account_id: harness.account_id.clone(),
            })
            .err()
            .unwrap()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .share_capabilities
            .len(),
        1
    );

    harness
        .runtime
        .unlock_account(&harness.account_id)
        .await
        .unwrap();
    let RuntimeProjection::PendingShareResults(projected) = harness
        .runtime
        .projection(&ObservationRequest::PendingShareResults {
            account_id: harness.account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected PendingShareResults projection");
    };
    assert_eq!(projected.results.len(), 1);

    harness
        .runtime
        .request(
            RuntimeRequest::SignOut {
                account_id: harness.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let signed_out = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(signed_out.share_capabilities.is_empty());
    assert_eq!(signed_out.receipts.len(), 1);
}

#[tokio::test]
async fn pending_share_result_reloads_from_durable_replica_after_restart() {
    let harness = seeded_with_share_item(false).await;
    let operation_id = accept_share(&harness).await;
    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;
    harness.runtime.close().await;

    let restarted = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        harness.server.clone(),
        operation_fixtures::auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    restarted
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        restarted
            .projection(&ObservationRequest::PendingShareResults {
                account_id: harness.account_id.clone(),
            })
            .err()
            .unwrap()
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
    restarted.unlock_account(&harness.account_id).await.unwrap();
    let RuntimeProjection::PendingShareResults(projected) = restarted
        .projection(&ObservationRequest::PendingShareResults {
            account_id: harness.account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected PendingShareResults projection");
    };
    assert_eq!(projected.results.len(), 1);
    assert_eq!(projected.results[0].operation_id, operation_id);
}

#[tokio::test]
async fn pending_share_item_correlation_is_derived_from_the_operation_receipt() {
    let harness = seeded_with_share_item(false).await;
    let operation_id = accept_share(&harness).await;
    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;

    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let capability = snapshot
        .share_capabilities
        .iter()
        .find(|candidate| candidate.operation_id == operation_id)
        .expect("applied Share capability should remain pending delivery");
    let durable_result = serde_json::to_value(
        capability
            .result
            .as_ref()
            .expect("applied Share capability should retain its result"),
    )
    .unwrap();
    assert_eq!(durable_result.get("itemId"), None);

    let receipt = snapshot
        .receipts
        .iter()
        .find(|candidate| candidate.operation_id == operation_id)
        .expect("applied Share should retain its Operation receipt");
    let RuntimeProjection::PendingShareResults(projected) = harness
        .runtime
        .projection(&ObservationRequest::PendingShareResults {
            account_id: harness.account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected PendingShareResults projection");
    };
    assert_eq!(projected.results[0].item_id, receipt.item_id);
}

#[tokio::test]
async fn share_survives_more_than_five_transient_attempts_with_identical_hash_only_bytes() {
    let harness = seeded_with_share_item(false).await;
    harness.server.script([
        operation_fixtures::Fault::NetworkFailure,
        operation_fixtures::Fault::Status(500),
        operation_fixtures::Fault::Status(502),
        operation_fixtures::Fault::NetworkFailure,
        operation_fixtures::Fault::Status(503),
        operation_fixtures::Fault::Status(429),
    ]);
    let operation_id = accept_share(&harness).await;
    let accepted = harness.operation().unwrap();

    for _ in 0..7 {
        harness
            .runtime
            .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
            .await;
        if let Some(operation) = harness.operation() {
            harness
                .clock
                .advance(operation.scheduling.not_before_ms - harness.clock.now());
        }
    }

    let requests: Vec<_> = harness
        .server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.method == "POST" && request.url.ends_with("/share-links"))
        .cloned()
        .collect();
    assert_eq!(requests.len(), 7);
    for request in requests {
        assert_eq!(request.body, accepted.request.body);
        assert_eq!(
            request.header("idempotency-key"),
            Some(operation_id.as_str())
        );
        assert_eq!(
            request.header("authorization"),
            Some("Bearer session-token-1")
        );
        let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
        assert!(body["tokenHash"].as_str().is_some());
        assert!(body.get("token").is_none());
    }
    assert_eq!(harness.server.created_share_links.lock().unwrap().len(), 1);
    assert!(harness.operation().is_none());
}

#[tokio::test]
async fn dropped_share_response_uses_lookup_as_a_hint_then_replays_the_identical_post_once() {
    let harness = seeded_with_share_item(false).await;
    harness.server.lose_next_response();
    let operation_id = accept_share(&harness).await;

    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;
    let waiting = harness.operation().unwrap();
    harness
        .clock
        .advance(waiting.scheduling.not_before_ms - harness.clock.now());
    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;

    assert_eq!(harness.server.shares(), 2);
    assert_eq!(harness.server.outcome_lookups(), 1);
    assert_eq!(harness.server.created_share_links.lock().unwrap().len(), 1);
    assert!(harness.operation().is_none());
}

#[tokio::test]
async fn same_kind_lookup_with_another_share_fingerprint_fails_closed_on_exact_post_replay() {
    let harness = seeded_with_share_item(false).await;
    harness
        .server
        .script([operation_fixtures::Fault::NetworkFailure]);
    let operation_id = accept_share(&harness).await;

    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;
    let waiting = harness.operation().unwrap();
    harness.server.outcomes.lock().unwrap().insert(
        operation_id.clone(),
        operation_fixtures::StoredOutcome {
            fingerprint: [9; 32],
            result: operation_fixtures::StoredResult::ShareApplied {
                share_link_id: "share-link-for-other-token-hash".into(),
                base_share_url: "https://app.example.test/share/".into(),
                expires_at: "2099-01-02T03:04:05Z".into(),
            },
        },
    );
    harness
        .clock
        .advance(waiting.scheduling.not_before_ms - harness.clock.now());

    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;

    let failed = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(failed.failure, Some(RuntimeErrorCode::InvariantViolation));
    assert_eq!(failed.operations.len(), 1);
    assert_eq!(failed.share_capabilities.len(), 1);
    assert!(failed.receipts.is_empty());
    assert_eq!(harness.server.outcome_lookups(), 1);
    assert_eq!(harness.server.shares(), 2);
}

#[tokio::test]
async fn sync_share_hint_cannot_complete_without_exact_post_identity_proof() {
    let harness = seeded_with_share_item(false).await;
    let operation_id = accept_share(&harness).await;
    let operation = harness.operation().unwrap();
    harness.server.outcomes.lock().unwrap().insert(
        operation_id.clone(),
        operation_fixtures::StoredOutcome {
            fingerprint: operation.request_fingerprint.0,
            result: operation_fixtures::StoredResult::ShareApplied {
                share_link_id: "share-link-sync-hint".into(),
                base_share_url: "https://app.example.test/share/".into(),
                expires_at: "2099-01-02T03:04:05Z".into(),
            },
        },
    );
    harness
        .server
        .script_operation_event(&operation_id, "sync-share-1");

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    let still_owed = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(still_owed.operations.len(), 1);
    assert_eq!(still_owed.share_capabilities.len(), 1);
    assert!(still_owed.receipts.is_empty());
    assert_eq!(harness.server.outcome_lookups(), 1);
    assert_eq!(harness.server.shares(), 0);
}

#[tokio::test]
async fn rejected_share_terminates_without_publishing_or_retaining_capability() {
    let harness = seeded_with_share_item(false).await;
    harness.server.reject_next("share_limit_reached");
    let operation_id = accept_share(&harness).await;
    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;

    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.share_capabilities.is_empty());
    assert_eq!(snapshot.receipts.len(), 1);
    let RuntimeProjection::PendingShareResults(projected) = harness
        .runtime
        .projection(&ObservationRequest::PendingShareResults {
            account_id: harness.account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected PendingShareResults projection");
    };
    assert!(projected.results.is_empty());
}

#[tokio::test]
async fn signed_out_share_without_a_capability_still_terminates_on_either_authoritative_outcome() {
    for result in [
        operation_fixtures::StoredResult::ShareApplied {
            share_link_id: "share-link-after-sign-out".into(),
            base_share_url: "https://app.example.test/share/".into(),
            expires_at: "2099-01-02T03:04:05Z".into(),
        },
        operation_fixtures::StoredResult::ShareRejected {
            code: "share_limit_reached",
        },
    ] {
        let harness = seeded_with_share_item(false).await;
        let operation_id = accept_share(&harness).await;
        let operation = harness.operation().unwrap();
        harness
            .runtime
            .request(
                RuntimeRequest::SignOut {
                    account_id: harness.account_id.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        assert!(harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .share_capabilities
            .is_empty());

        harness.server.outcomes.lock().unwrap().insert(
            operation_id.clone(),
            operation_fixtures::StoredOutcome {
                fingerprint: operation.request_fingerprint.0,
                result,
            },
        );
        operation_fixtures::store_session(
            &harness.runtime,
            &harness.account_id,
            operation_fixtures::FIRST_TOKEN,
        )
        .await;
        harness.runtime.note_session_available(&harness.account_id);
        harness
            .runtime
            .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
            .await;

        let completed = harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap();
        assert!(completed.operations.is_empty());
        assert!(completed.share_capabilities.is_empty());
        assert_eq!(completed.receipts.len(), 1);

        harness
            .runtime
            .unlock_account(&harness.account_id)
            .await
            .unwrap();
        let RuntimeProjection::PendingShareResults(projected) = harness
            .runtime
            .projection(&ObservationRequest::PendingShareResults {
                account_id: harness.account_id.clone(),
            })
            .unwrap()
            .projection
        else {
            panic!("expected PendingShareResults projection");
        };
        assert!(projected.results.is_empty());
    }
}

#[tokio::test]
async fn cross_kind_share_outcome_fails_closed_without_discarding_the_receiptless_capability() {
    let harness = seeded_with_share_item(false).await;
    let operation_id = accept_share(&harness).await;
    let operation = harness.operation().unwrap();
    harness.server.outcomes.lock().unwrap().insert(
        operation_id.clone(),
        operation_fixtures::StoredOutcome {
            fingerprint: operation.request_fingerprint.0,
            result: operation_fixtures::StoredResult::Applied {
                item_id: operation.item_id,
                version: 1,
            },
        },
    );

    harness
        .runtime
        .dispatch_create_share_once_for_test(&harness.account_id, &operation_id)
        .await;
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(snapshot.failure, Some(RuntimeErrorCode::InvariantViolation));
    assert_eq!(snapshot.operations.len(), 1);
    assert_eq!(snapshot.share_capabilities.len(), 1);
    assert!(snapshot.receipts.is_empty());
}
