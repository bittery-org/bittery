//! Stopped ordinary Item commands retain their original request without replacing confirmed authority.
use crate::http_transport::{HttpHeader, HttpMethod};
use crate::replica::{
    item_operation_fingerprint, AuthorityItemCategory, ImmutableHttpRequest,
    LegacyOperationAdmission, OperationKind, OperationRecord, ResourceRef,
    LEGACY_OPERATION_ADMISSION_VERSION,
};
use crate::runtime::operation_fixtures::*;
use crate::runtime::*;
use crate::test_fixtures::{TEST_VAULT_ID, TEST_VAULT_KEY};
use serde_json::json;

const ITEM: &str = "item-existing";
const ATTEMPT: &str = "held-update-attempt";
const SEMANTIC: &str = "held-update-semantic";

fn changed_draft() -> crate::ItemDraft {
    let crate::ItemDraft::Login(mut item) = draft() else {
        unreachable!()
    };
    item.title = "Stopped edit, never confirmed".into();
    crate::ItemDraft::Login(item)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeldCase {
    Update,
    Favorite,
    Trash,
    Restore,
    Permanent,
    Move,
}

impl HeldCase {
    const REMAINING: [Self; 5] = [
        Self::Favorite,
        Self::Trash,
        Self::Restore,
        Self::Permanent,
        Self::Move,
    ];

    fn wire(
        self,
    ) -> (
        OperationKind,
        &'static str,
        HttpMethod,
        &'static str,
        &'static str,
        Option<&'static str>,
    ) {
        match self {
            Self::Update => (
                OperationKind::UpdateItem,
                "update",
                HttpMethod::Patch,
                "",
                "PATCH /api/v1/items/{itemId}",
                Some("application/merge-patch+json"),
            ),
            Self::Favorite => (
                OperationKind::SetItemFavorite,
                "toggle_favorite",
                HttpMethod::Patch,
                "/favorite",
                "PATCH /api/v1/items/{itemId}/favorite",
                Some("application/merge-patch+json"),
            ),
            Self::Trash => (
                OperationKind::TrashItem,
                "delete",
                HttpMethod::Delete,
                "",
                "DELETE /api/v1/items/{itemId}",
                None,
            ),
            Self::Restore => (
                OperationKind::RestoreItem,
                "restore",
                HttpMethod::Post,
                "/restore",
                "POST /api/v1/items/{itemId}/restore",
                None,
            ),
            Self::Permanent => (
                OperationKind::PermanentlyDeleteItem,
                "permanent_delete",
                HttpMethod::Delete,
                "/permanent",
                "DELETE /api/v1/items/{itemId}/permanent",
                None,
            ),
            Self::Move => (
                OperationKind::MoveItem,
                "move",
                HttpMethod::Post,
                "/moves",
                "POST /api/v1/items/{itemId}/moves",
                Some("application/json"),
            ),
        }
    }

    fn deleted(self) -> bool {
        matches!(self, Self::Restore | Self::Permanent)
    }
}

async fn held_update(status: &str) -> Harness {
    held_existing(HeldCase::Update, status).await
}

async fn held_existing(case: HeldCase, status: &str) -> Harness {
    held_existing_on(case, status, case.deleted()).await
}

async fn held_existing_on(case: HeldCase, status: &str, deleted: bool) -> Harness {
    held_existing_seed(case, status, deleted, false).await
}

async fn held_existing_seed(
    case: HeldCase,
    status: &str,
    deleted: bool,
    attachment: bool,
) -> Harness {
    held_existing_seed_with_history(case, status, deleted, attachment, None).await
}

async fn held_existing_seed_with_history(
    case: HeldCase,
    status: &str,
    deleted: bool,
    attachment: bool,
    newer_update_encryption_version: Option<i32>,
) -> Harness {
    let mut harness = seeded_with_existing_item(true, deleted).await;
    let source_base: i32 = if newer_update_encryption_version.is_some() {
        6
    } else {
        1
    };
    if let Some(encryption_version) = newer_update_encryption_version {
        assert_eq!(case, HeldCase::Update);
        assert!(!deleted && !attachment);
        let snapshot = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        let cached =
            history_server_item(&harness, 9, encryption_version, &cached_nine_draft(), true);
        let mut item = snapshot.bootstrap.snapshot().visible_items[0].clone();
        item.version = cached.version;
        item.encryption_version = cached.encryption_version;
        item.encrypted_data = cached.encrypted_data.clone();
        item.encryption_iv = cached.encryption_iv.clone();
        item.encryption_algorithm = cached.encryption_algorithm.clone();
        item.favorite = cached.favorite;
        // Advance confirmed authority through the existing guarded Sync owner. The queued
        // request remains at base six; neither the initial Bootstrap generation nor its cursor
        // is replaced merely to represent a later confirmed version-nine Item.
        assert!(matches!(
            harness
                .runtime
                .replica
                .apply_sync_item_authority(
                    crate::replica::BootstrapGuard {
                        account_id: snapshot.account_id.clone(),
                        user_id: snapshot.user_id.clone(),
                        incarnation: snapshot.incarnation.clone(),
                        expected_replica_revision: snapshot.revision,
                        expected_lock_epoch: snapshot.lock_epoch,
                    },
                    snapshot.bootstrap.active_cursor,
                    item.id.clone(),
                    Some(item),
                )
                .await
                .unwrap(),
            PlanResult::Applied { .. }
        ));
        harness.runtime.close().await;
        *harness.server.created_items.lock().unwrap() = vec![cached];
        harness.runtime = Runtime::with_test_dispatch_environment(
            harness.replica.clone(),
            harness.platform.clone(),
            harness.server.clone(),
            auth_config(),
            harness.clock.clone(),
            harness.timer.clone(),
        );
        harness
            .runtime
            .replica
            .load(&harness.account_id)
            .await
            .unwrap();
        harness
            .runtime
            .unlock_account(&harness.account_id)
            .await
            .unwrap();
    }
    if attachment {
        let snapshot = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        let mut item = snapshot.bootstrap.snapshot().visible_items[0].clone();
        item.attachments
            .push(serde_json::from_value(attachment_json(ITEM, TEST_VAULT_ID)).unwrap());
        harness
            .runtime
            .replica
            .execute(GuardedCommitPlan::new(
                snapshot.account_id,
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::CommitAttachmentAuthority {
                    attachment_id: "attachment-current".into(),
                    attachment_present: true,
                    item: Box::new(item),
                }],
            ))
            .await
            .unwrap();
    }
    let snapshot = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    let (kind, source_kind, method, suffix, route, content_type) = case.wire();
    let mut command = json!({
        "accountId":ACCOUNT,"id":"held-update-source-command","operationId":SEMANTIC,"attemptId":ATTEMPT,
        "type":source_kind,"entityId":ITEM,"vaultId":TEST_VAULT_ID,
        "baseVersion":source_base,"timestamp":START_MS.to_string(),"retryCount":"0","status":status
    });
    let target_vault = if case == HeldCase::Move {
        "vault-2"
    } else {
        TEST_VAULT_ID
    };
    let body = if matches!(case, HeldCase::Update | HeldCase::Move) {
        let plaintext = if case == HeldCase::Update {
            changed_draft()
        } else {
            draft()
        };
        let encrypted = bittery_crypto_core::encrypt_with_aad(
            &create::item_plaintext(&plaintext).unwrap(),
            &TEST_VAULT_KEY,
            &bittery_crypto_core::AadContext {
                vault_id: target_vault.into(),
                entity_id: ITEM.into(),
                entity_type: "item".into(),
                version: (source_base + 1).try_into().unwrap(),
                user_id: USER.into(),
            },
        )
        .unwrap();
        command["encryptedPayload"] =
            json!({"encryptionVersion":source_base + 1,"encryptedByUserId":USER});
        let payload = format!(
            r#""encryptedData":{},"encryptionIv":{},"encryptionAlgorithm":{}"#,
            serde_json::to_string(&encrypted.ciphertext).unwrap(),
            serde_json::to_string(&encrypted.iv).unwrap(),
            serde_json::to_string(&encrypted.algorithm).unwrap(),
        );
        if case == HeldCase::Move {
            command["targetVaultId"] = json!(target_vault);
            format!(r#"{{"mode":"prepared","sourceVaultId":"{TEST_VAULT_ID}","targetVaultId":"vault-2",{payload}}}"#).into_bytes()
        } else {
            format!("{{{payload}}}").into_bytes()
        }
    } else if case == HeldCase::Favorite {
        command["favorite"] = json!(true);
        br#"{"favorite":true}"#.to_vec()
    } else {
        vec![]
    };
    let admission: LegacyOperationAdmission = serde_json::from_value(json!({
        "version":LEGACY_OPERATION_ADMISSION_VERSION,"admissionId":"held-update-admission","sourceQueueIndex":"0",
        "sourceCommand":command,"disposition":if status == "failed" { "legacyFailed" } else { "legacyConflicted" }
    })).unwrap();
    let mut headers = content_type
        .into_iter()
        .map(|content_type| HttpHeader {
            name: "Content-Type".into(),
            value: content_type.into(),
        })
        .collect::<Vec<_>>();
    headers.push(HttpHeader {
        name: "If-Match".into(),
        value: format!("\"{source_base}\""),
    });
    let operation = OperationRecord {
        operation_id: ATTEMPT.into(),
        kind,
        target: ResourceRef::Item {
            item_id: ITEM.into(),
            vault_id: target_vault.into(),
        },
        request_fingerprint: item_operation_fingerprint(kind, route, ITEM, &body, source_base),
        request: ImmutableHttpRequest {
            method,
            path: format!("/api/v1/items/{ITEM}{suffix}"),
            headers,
            body,
        },
        accepted_item_category: Some(AuthorityItemCategory::Login),
        attachment_move_recovery: None,
        create_vault: None,
        update_vault: None,
        scheduling: admission.initial_scheduling(),
        legacy_admission: Some(Box::new(admission)),
    };
    harness
        .runtime
        .replica
        .execute(GuardedCommitPlan::new(
            snapshot.account_id,
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::AcceptOperation(operation)],
        ))
        .await
        .unwrap();
    harness
}

fn visible_item(harness: &Harness) -> crate::ItemProjection {
    visible_items(harness)
        .into_iter()
        .find(|item| item.item_id == ITEM)
        .unwrap()
}

fn visible_items(harness: &Harness) -> Vec<crate::ItemProjection> {
    harness
        .runtime
        .decrypt_visible_items(&harness.account_id)
        .unwrap();
    let RuntimeProjection::Items(items) = harness
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: harness.account_id.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Items")
    };
    items.items
}

async fn sync(harness: &Harness) -> outcome::CompletionResult {
    let snapshot = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    let mut session = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    let http = crate::auth_http::AuthHttpClient::new(
        &harness.runtime.http_transport,
        SERVER_URL,
        false,
        auth_config(),
    )
    .unwrap();
    harness
        .runtime
        .reconcile_resolved_operation(&harness.account_id, ATTEMPT, &http, &mut session)
        .await
}

fn retain_historical_operation(
    harness: &Harness,
    identity: &str,
    rejected: bool,
) -> OperationRecord {
    let operation = harness.operation().unwrap();
    if rejected {
        harness.server.reject_next("vault_read_only");
    }
    let mut headers = operation
        .request
        .headers
        .iter()
        .map(|header| (header.name.clone(), header.value.clone()))
        .collect::<Vec<_>>();
    headers.push(("Authorization".into(), format!("Bearer {FIRST_TOKEN}")));
    headers.push(("Idempotency-Key".into(), identity.into()));
    let response = harness
        .server
        .handle_existing_item_mutation(&RecordedRequest {
            method: match operation.request.method {
                HttpMethod::Patch => "PATCH",
                HttpMethod::Post => "POST",
                HttpMethod::Delete => "DELETE",
                _ => unreachable!(),
            }
            .into(),
            url: format!("{SERVER_URL}{}", operation.request.path),
            headers,
            body: operation.request.body.clone(),
        });
    assert_eq!(response["status"], 200);
    operation
}

#[tokio::test]
async fn stopped_update_semantic_outcome_cannot_authorize_the_original_attempt() {
    for through_sync in [false, true] {
        let harness = held_update("conflicted").await;
        retain_historical_operation(&harness, SEMANTIC, false);
        let before = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        if through_sync {
            assert!(matches!(
                sync(&harness).await,
                outcome::CompletionResult::Retry
            ));
        } else {
            assert!(matches!(
                harness.runtime.dispatch_eligible_operations().await,
                dispatch::DispatchPass::Parked
            ));
        }
        assert_eq!(
            harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap(),
            before
        );
        assert_eq!(
            visible_item(&harness).data,
            crate::PublicItemDraft::from(&draft())
        );
        assert_eq!(
            visible_item(&harness).status,
            crate::ItemProjectionStatus::Authoritative
        );
        assert!(harness.server.existing_item_mutation_requests().is_empty());
        assert!(harness.timer.requested().is_empty());
        let lookups = harness
            .server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.url.contains("/operations/"))
            .map(|request| request.url.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            lookups,
            vec![format!("{SERVER_URL}/api/v1/operations/{ATTEMPT}")]
        );
        assert!(harness
            .server
            .outcomes
            .lock()
            .unwrap()
            .contains_key(SEMANTIC));
        assert!(!harness
            .server
            .outcomes
            .lock()
            .unwrap()
            .contains_key(ATTEMPT));
        harness.runtime.close().await;
    }
}

#[tokio::test]
async fn stopped_update_original_proof_reconciles_authority_and_preserves_newer_active_edit() {
    for status in ["failed", "conflicted"] {
        for through_sync in [false, true] {
            for rejected in [false, true] {
                for newer_active in [false, true] {
                    let harness = held_update(status).await;
                    let original = retain_historical_operation(&harness, ATTEMPT, rejected);
                    let crate::ItemDraft::Login(mut item) = draft() else {
                        unreachable!()
                    };
                    item.title = "Newer active edit".into();
                    let newer_draft = crate::ItemDraft::Login(item);
                    let newer = if newer_active {
                        let (operation_id, _) = harness
                            .accept_existing(RuntimeRequest::UpdateItem {
                                guard: crate::ItemEditGuard::test_fixture(
                                    harness.account_id.clone(),
                                    ITEM,
                                ),
                                account_id: harness.account_id.clone(),
                                item_id: ITEM.into(),
                                draft: newer_draft.clone(),
                            })
                            .await;
                        let snapshot = harness
                            .runtime
                            .replica
                            .snapshot(&harness.account_id)
                            .unwrap();
                        let operation = snapshot
                            .operations
                            .iter()
                            .find(|operation| operation.operation_id == operation_id)
                            .unwrap()
                            .clone();
                        let overlay = snapshot
                            .items
                            .iter()
                            .find(|overlay| overlay.operation_id == operation_id)
                            .unwrap()
                            .clone();
                        assert_eq!(
                            visible_item(&harness).data,
                            crate::PublicItemDraft::from(&newer_draft)
                        );
                        assert_eq!(
                            visible_item(&harness).status,
                            crate::ItemProjectionStatus::Pending
                        );
                        Some((operation, overlay))
                    } else {
                        None
                    };
                    if through_sync {
                        assert!(matches!(
                            sync(&harness).await,
                            outcome::CompletionResult::Completed
                        ));
                    } else {
                        harness
                            .runtime
                            .dispatch_once_ignoring_lease(&harness.account_id, ATTEMPT)
                            .await;
                    }
                    let after = harness
                        .runtime
                        .replica
                        .load(&harness.account_id)
                        .await
                        .unwrap()
                        .unwrap();
                    assert_eq!(after.receipts.len(), 1);
                    let receipt = &after.receipts[0];
                    assert_eq!(receipt.operation_id, ATTEMPT);
                    assert_eq!(receipt.kind, OperationKind::UpdateItem);
                    assert_eq!(receipt.request_fingerprint, original.request_fingerprint);
                    let lineage = receipt.legacy_lineage.as_ref().unwrap();
                    assert_eq!(lineage.source_command_id, "held-update-source-command");
                    assert_eq!(lineage.source_operation_id.as_deref(), Some(SEMANTIC));
                    assert_eq!(lineage.source_attempt_id.as_deref(), Some(ATTEMPT));
                    assert_eq!(
                        lineage.source_status,
                        original
                            .legacy_admission
                            .as_ref()
                            .unwrap()
                            .source_command
                            .status
                    );
                    if rejected {
                        assert!(matches!(
                            receipt.result,
                            crate::replica::OperationOutcomeResult::Rejected {
                                code: crate::replica::OperationRejectionCode::VaultReadOnly,
                            }
                        ));
                    } else {
                        assert!(
                            matches!(&receipt.result,crate::replica::OperationOutcomeResult::Applied { entity_id,version:2 } if entity_id == ITEM)
                        );
                    }
                    let authority = after
                        .bootstrap
                        .snapshot()
                        .visible_items
                        .into_iter()
                        .find(|item| item.id == ITEM)
                        .unwrap();
                    assert_eq!(authority.version, if rejected { 1 } else { 2 });
                    if !rejected {
                        let body: serde_json::Value =
                            serde_json::from_slice(&original.request.body).unwrap();
                        assert_eq!(
                            authority.encrypted_data,
                            body["encryptedData"].as_str().unwrap()
                        );
                    }
                    if let Some((operation, overlay)) = newer {
                        assert_eq!(after.operations, vec![operation]);
                        assert_eq!(after.items, vec![overlay]);
                        assert_eq!(
                            visible_item(&harness).data,
                            crate::PublicItemDraft::from(&newer_draft)
                        );
                        assert_eq!(
                            visible_item(&harness).status,
                            crate::ItemProjectionStatus::Pending
                        );
                    } else {
                        assert!(after.operations.is_empty());
                        assert!(after.items.is_empty());
                        assert_eq!(
                            visible_item(&harness).data,
                            crate::PublicItemDraft::from(&if rejected {
                                draft()
                            } else {
                                changed_draft()
                            })
                        );
                        assert_eq!(
                            visible_item(&harness).status,
                            crate::ItemProjectionStatus::Authoritative
                        );
                    }
                    let mutations = harness.server.existing_item_mutation_requests();
                    assert_eq!(
                        mutations.len(),
                        1,
                        "only the exact proof replay is sent by Core"
                    );
                    assert_eq!(mutations[0].method, "PATCH");
                    assert_eq!(
                        mutations[0].url,
                        format!("{SERVER_URL}/api/v1/items/{ITEM}")
                    );
                    assert_eq!(mutations[0].header("Idempotency-Key"), Some(ATTEMPT));
                    assert_eq!(mutations[0].header("If-Match"), Some("\"1\""));
                    assert_eq!(
                        mutations[0].header("Content-Type"),
                        Some("application/merge-patch+json")
                    );
                    assert_eq!(mutations[0].body, original.request.body);
                    let effects = harness
                        .server
                        .requests
                        .lock()
                        .unwrap()
                        .iter()
                        .filter(|request| {
                            request.url.contains("/operations/") || request.method == "PATCH"
                        })
                        .map(|request| (request.method.clone(), request.url.clone()))
                        .collect::<Vec<_>>();
                    assert_eq!(
                        effects,
                        vec![
                            (
                                "GET".into(),
                                format!("{SERVER_URL}/api/v1/operations/{ATTEMPT}")
                            ),
                            ("PATCH".into(), format!("{SERVER_URL}/api/v1/items/{ITEM}")),
                        ]
                    );
                    assert_eq!(
                        harness.server.created_items.lock().unwrap()[0].version,
                        if rejected { 1 } else { 2 },
                        "proof replay does not apply twice"
                    );
                    assert_eq!(harness.server.outcomes.lock().unwrap().len(), 1);
                    assert!(harness.timer.requested().is_empty());
                    harness.runtime.close().await;
                }
            }
        }
    }
}

#[tokio::test]
async fn stopped_update_missing_proof_keeps_confirmed_plaintext_across_dispatch_sync_and_reopen() {
    for status in ["failed", "conflicted"] {
        let mut harness = held_update(status).await;
        let before = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        assert!(before.items.is_empty());
        assert_eq!(
            visible_item(&harness).data,
            crate::PublicItemDraft::from(&draft())
        );
        assert_eq!(
            visible_item(&harness).status,
            crate::ItemProjectionStatus::Authoritative
        );
        assert_ne!(
            visible_item(&harness).data,
            crate::PublicItemDraft::from(&changed_draft())
        );
        let RuntimeProjection::Operations(operations) = harness
            .runtime
            .projection(&ObservationRequest::Operations {
                account_id: harness.account_id.clone(),
            })
            .unwrap()
            .projection
        else {
            panic!("expected Operations")
        };
        assert_eq!(operations.operations.len(), 1);
        let projected = &operations.operations[0];
        assert_eq!(projected.operation_id, ATTEMPT);
        assert_eq!(
            projected.resolution,
            if status == "failed" {
                crate::OperationResolution::LegacyFailed
            } else {
                crate::OperationResolution::LegacyConflicted
            }
        );
        assert_eq!(projected.rejection_code, None);
        assert_eq!(projected.next_attempt_at_ms, None);
        assert!(matches!(
            harness.runtime.dispatch_eligible_operations().await,
            dispatch::DispatchPass::Parked
        ));
        assert!(matches!(
            sync(&harness).await,
            outcome::CompletionResult::Retry
        ));
        assert_eq!(
            harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap(),
            before
        );
        assert!(harness.server.existing_item_mutation_requests().is_empty());
        assert_eq!(harness.server.outcome_lookups(), 2);
        assert!(harness.timer.requested().is_empty());
        harness.runtime.close().await;
        harness.runtime = Runtime::with_test_dispatch_environment(
            harness.replica.clone(),
            harness.platform.clone(),
            harness.server.clone(),
            auth_config(),
            harness.clock.clone(),
            harness.timer.clone(),
        );
        harness
            .runtime
            .replica
            .load(&harness.account_id)
            .await
            .unwrap();
        harness
            .runtime
            .unlock_account(&harness.account_id)
            .await
            .unwrap();
        assert!(matches!(
            harness.runtime.dispatch_eligible_operations().await,
            dispatch::DispatchPass::Parked
        ));
        assert_eq!(
            visible_item(&harness).data,
            crate::PublicItemDraft::from(&draft())
        );
        assert_eq!(
            visible_item(&harness).status,
            crate::ItemProjectionStatus::Authoritative
        );
        let after = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        assert_eq!(after.operations, before.operations);
        assert_eq!(after.bootstrap, before.bootstrap);
        assert!(after.items.is_empty());
        assert!(after.receipts.is_empty());
        assert!(harness.server.existing_item_mutation_requests().is_empty());
        assert_eq!(harness.server.outcome_lookups(), 3);
        assert!(harness.timer.requested().is_empty());
        harness.runtime.close().await;
    }
}

#[tokio::test]
async fn stopped_favorite_keeps_confirmed_flag_until_original_attempt_is_proved() {
    let harness = held_existing(HeldCase::Favorite, "failed").await;
    let before = harness
        .runtime
        .replica
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(before.items.is_empty());
    assert!(!visible_item(&harness).favorite);
    assert_eq!(
        visible_item(&harness).data,
        crate::PublicItemDraft::from(&draft())
    );
    assert_eq!(
        visible_item(&harness).status,
        crate::ItemProjectionStatus::Authoritative
    );
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Parked
    ));
    assert_eq!(
        harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap(),
        before
    );
    assert!(harness.server.existing_item_mutation_requests().is_empty());
    retain_historical_operation(&harness, ATTEMPT, false);
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, ATTEMPT)
        .await;
    assert!(visible_item(&harness).favorite);
    assert_eq!(
        visible_item(&harness).data,
        crate::PublicItemDraft::from(&draft())
    );
    assert_eq!(
        visible_item(&harness).status,
        crate::ItemProjectionStatus::Authoritative
    );
    let requests = harness.server.existing_item_mutation_requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].body, br#"{"favorite":true}"#);
    assert_eq!(requests[0].header("Idempotency-Key"), Some(ATTEMPT));
    assert_eq!(requests[0].header("If-Match"), Some("\"1\""));
    harness.runtime.close().await;
}

fn assert_original_replay(harness: &Harness, original: &OperationRecord) {
    let requests = harness.server.requests.lock().unwrap();
    let effects = requests
        .iter()
        .filter(|request| {
            request.url.contains("/operations/")
                || matches!(request.method.as_str(), "PATCH" | "POST" | "DELETE")
        })
        .collect::<Vec<_>>();
    assert_eq!(effects.len(), 2);
    assert_eq!(effects[0].method, "GET");
    assert_eq!(
        effects[0].url,
        format!("{SERVER_URL}/api/v1/operations/{ATTEMPT}")
    );
    let expected_method = match original.request.method {
        HttpMethod::Patch => "PATCH",
        HttpMethod::Post => "POST",
        HttpMethod::Delete => "DELETE",
        _ => unreachable!(),
    };
    assert_eq!(effects[1].method, expected_method);
    assert_eq!(
        effects[1].url,
        format!("{SERVER_URL}{}", original.request.path)
    );
    assert_eq!(effects[1].body, original.request.body);
    assert_eq!(effects[1].header("Idempotency-Key"), Some(ATTEMPT));
    assert_eq!(effects[1].header("If-Match"), Some("\"1\""));
    for header in &original.request.headers {
        assert_eq!(effects[1].header(&header.name), Some(header.value.as_str()));
    }
}

#[tokio::test]
async fn stopped_metadata_and_move_original_proofs_preserve_exact_authority_semantics() {
    for case in HeldCase::REMAINING {
        for status in ["failed", "conflicted"] {
            for through_sync in [false, true] {
                for rejected in [false, true] {
                    let harness = held_existing(case, status).await;
                    let before = harness
                        .runtime
                        .replica
                        .snapshot(&harness.account_id)
                        .unwrap();
                    assert!(before.items.is_empty(), "{case:?}/{status}");
                    assert!(!before.item_has_optimistic_owner(ITEM));
                    let visible = visible_item(&harness);
                    assert_eq!(visible.status, crate::ItemProjectionStatus::Authoritative);
                    assert_eq!(visible.data, crate::PublicItemDraft::from(&draft()));
                    assert!(!visible.favorite);
                    assert_eq!(visible.deleted_at.is_some(), case.deleted());
                    assert_eq!(visible.vault_id, TEST_VAULT_ID);
                    let original = retain_historical_operation(&harness, ATTEMPT, rejected);
                    assert!(original
                        .legacy_admission
                        .as_ref()
                        .unwrap()
                        .overlay_sha256
                        .is_none());
                    if case == HeldCase::Move {
                        let body: serde_json::Value =
                            serde_json::from_slice(&original.request.body).unwrap();
                        assert!(body.get("attachments").is_none());
                        assert!(original.attachment_move_recovery.is_none());
                        assert_eq!(
                            original.accepted_vault_ids().unwrap(),
                            vec![TEST_VAULT_ID, "vault-2"]
                        );
                    }
                    if through_sync {
                        assert!(
                            matches!(sync(&harness).await, outcome::CompletionResult::Completed),
                            "{case:?}/{status}/{rejected}"
                        );
                    } else {
                        harness
                            .runtime
                            .dispatch_once_ignoring_lease(&harness.account_id, ATTEMPT)
                            .await;
                    }
                    let after = harness
                        .runtime
                        .replica
                        .load(&harness.account_id)
                        .await
                        .unwrap()
                        .unwrap();
                    assert!(after.operations.is_empty(), "{case:?}/{status}/{rejected}");
                    assert!(after.items.is_empty());
                    assert_eq!(after.receipts.len(), 1);
                    let receipt = &after.receipts[0];
                    assert_eq!(receipt.operation_id, ATTEMPT);
                    assert_eq!(receipt.kind, case.wire().0);
                    assert_eq!(receipt.request_fingerprint, original.request_fingerprint);
                    let lineage = receipt.legacy_lineage.as_ref().unwrap();
                    assert_eq!(lineage.source_operation_id.as_deref(), Some(SEMANTIC));
                    assert_eq!(lineage.source_attempt_id.as_deref(), Some(ATTEMPT));
                    assert_eq!(
                        lineage.source_status,
                        original
                            .legacy_admission
                            .as_ref()
                            .unwrap()
                            .source_command
                            .status
                    );
                    assert_eq!(
                        matches!(
                            receipt.result,
                            crate::replica::OperationOutcomeResult::Rejected { .. }
                        ),
                        rejected
                    );
                    let authority = after.bootstrap.snapshot().visible_items;
                    if case == HeldCase::Permanent && !rejected {
                        assert_eq!(
                            authority,
                            before.bootstrap.snapshot().visible_items,
                            "point absence is not permission to erase cached authority"
                        );
                        assert_eq!(
                            after.bootstrap.state,
                            crate::replica::ReplicaState::RefreshRequired
                        );
                        assert!(harness.server.created_items().is_empty());
                    } else {
                        assert_eq!(authority.len(), 1);
                        assert_eq!(authority[0].version, if rejected { 1 } else { 2 });
                        assert_eq!(
                            authority[0].favorite,
                            !rejected && case == HeldCase::Favorite
                        );
                        assert_eq!(
                            authority[0].deleted_at.is_some(),
                            if rejected {
                                case.deleted()
                            } else {
                                matches!(case, HeldCase::Trash | HeldCase::Permanent)
                            }
                        );
                        assert_eq!(
                            authority[0].vault_id,
                            if !rejected && case == HeldCase::Move {
                                "vault-2"
                            } else {
                                TEST_VAULT_ID
                            }
                        );
                        assert_eq!(
                            visible_item(&harness).data,
                            crate::PublicItemDraft::from(&draft())
                        );
                        assert_eq!(
                            visible_item(&harness).status,
                            crate::ItemProjectionStatus::Authoritative
                        );
                        assert_eq!(
                            harness.server.created_items.lock().unwrap()[0].version,
                            if rejected { 1 } else { 2 }
                        );
                    }
                    assert_original_replay(&harness, &original);
                    assert!(harness.timer.requested().is_empty());
                    harness.runtime.close().await;
                }
            }
        }
    }
}

#[tokio::test]
async fn stopped_metadata_and_move_completion_preserves_newer_same_item_owner() {
    for case in HeldCase::REMAINING {
        for rejected in [false, true] {
            let harness = held_existing(case, "failed").await;
            let original = retain_historical_operation(&harness, ATTEMPT, rejected);
            let request = if case.deleted() {
                RuntimeRequest::RestoreItem {
                    account_id: harness.account_id.clone(),
                    item_id: ITEM.into(),
                }
            } else {
                RuntimeRequest::UpdateItem {
                    guard: crate::ItemEditGuard::test_fixture(harness.account_id.clone(), ITEM),
                    account_id: harness.account_id.clone(),
                    item_id: ITEM.into(),
                    draft: changed_draft(),
                }
            };
            let (new_id, _) = harness.accept_existing(request).await;
            let accepted = harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap();
            let new_operation = accepted
                .operations
                .iter()
                .find(|operation| operation.operation_id == new_id)
                .unwrap()
                .clone();
            let new_overlay = accepted
                .items
                .iter()
                .find(|overlay| overlay.operation_id == new_id)
                .unwrap()
                .clone();
            assert_eq!(
                visible_item(&harness).status,
                crate::ItemProjectionStatus::Pending
            );
            let new_projection = visible_item(&harness);
            assert_eq!(
                new_projection
                    .duplicate_source_guard
                    .as_ref()
                    .expect("pending Item duplicate guard")
                    .replica_revision,
                accepted.revision
            );
            if rejected {
                assert!(matches!(
                    sync(&harness).await,
                    outcome::CompletionResult::Completed
                ));
            } else {
                harness
                    .runtime
                    .dispatch_once_ignoring_lease(&harness.account_id, ATTEMPT)
                    .await;
            }
            let after = harness
                .runtime
                .replica
                .load(&harness.account_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(after.operations, vec![new_operation], "{case:?}/{rejected}");
            assert_eq!(after.items, vec![new_overlay], "{case:?}/{rejected}");
            let mut expected_projection = new_projection;
            expected_projection
                .duplicate_source_guard
                .as_mut()
                .expect("pending Item duplicate guard")
                .replica_revision = after.revision;
            assert_eq!(
                visible_item(&harness),
                expected_projection,
                "{case:?}/{rejected}"
            );
            assert_eq!(after.receipts.len(), 1);
            assert_eq!(after.receipts[0].operation_id, ATTEMPT);
            assert_eq!(
                after.receipts[0].request_fingerprint,
                original.request_fingerprint
            );
            assert_original_replay(&harness, &original);
            harness.runtime.close().await;
        }
    }
}

#[tokio::test]
async fn stopped_live_restore_and_permanent_delete_need_real_item_not_trashed_proof() {
    for case in [HeldCase::Restore, HeldCase::Permanent] {
        let harness = held_existing_on(case, "conflicted", false).await;
        let before = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        assert!(matches!(
            sync(&harness).await,
            outcome::CompletionResult::Retry
        ));
        assert_eq!(
            harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap(),
            before
        );
        assert!(harness.server.existing_item_mutation_requests().is_empty());
        assert!(visible_item(&harness).deleted_at.is_none());
        harness.server.reject_next("item_not_trashed");
        retain_historical_operation(&harness, ATTEMPT, false);
        assert!(matches!(
            sync(&harness).await,
            outcome::CompletionResult::Completed
        ));
        let after = harness
            .runtime
            .replica
            .load(&harness.account_id)
            .await
            .unwrap()
            .unwrap();
        assert!(after.operations.is_empty());
        assert!(after.items.is_empty());
        assert!(matches!(
            after.receipts[0].result,
            crate::replica::OperationOutcomeResult::Rejected {
                code: crate::replica::OperationRejectionCode::ItemNotTrashed
            }
        ));
        assert!(visible_item(&harness).deleted_at.is_none());
        assert_eq!(
            visible_item(&harness).status,
            crate::ItemProjectionStatus::Authoritative
        );
        assert_eq!(
            visible_item(&harness).data,
            crate::PublicItemDraft::from(&draft())
        );
        harness.runtime.close().await;
    }
}

fn attachment_json(item_id: &str, vault_id: &str) -> serde_json::Value {
    json!({
        "id":"attachment-current","itemId":item_id,"vaultId":vault_id,
        "storageKey":format!("attachments/{item_id}/attachment-current.enc"),
        "encryptedName":"encrypted-name","encryptionIv":"name-iv","encryptionAlgorithm":"AES-256-GCM",
        "encryptedAttachmentKey":"encrypted-key","attachmentKeyIv":"key-iv","attachmentKeyAlgorithm":"AES-256-GCM",
        "encryptedContentType":"encrypted-content-type","encryptedContentTypeIv":"content-type-iv",
        "envelopeVersion":1,"fileSize":17,"uploadedBy":USER,"createdAt":"2026-08-30T00:00:00Z"
    })
}

#[tokio::test]
async fn stopped_move_retirement_of_either_vault_preserves_proof_without_republishing_authority() {
    for retired_vault in [TEST_VAULT_ID, "vault-2"] {
        for rejected in [false, true] {
            let harness = held_existing(HeldCase::Move, "conflicted").await;
            let snapshot = harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap();
            let original = harness.operation().unwrap();
            assert_eq!(
                original.accepted_vault_ids().unwrap(),
                vec![TEST_VAULT_ID, "vault-2"]
            );
            harness
                .runtime
                .replica
                .execute(GuardedCommitPlan::new(
                    snapshot.account_id,
                    snapshot.incarnation,
                    snapshot.revision,
                    snapshot.lock_epoch,
                    vec![PlanMutation::RetireVaults {
                        vault_ids: vec![retired_vault.into()],
                    }],
                ))
                .await
                .unwrap();
            let retired = harness
                .runtime
                .replica
                .load(&harness.account_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(retired.operations, vec![original.clone()]);
            assert!(retired.items.is_empty());
            assert_eq!(
                visible_items(&harness)
                    .iter()
                    .any(|item| item.item_id == ITEM),
                retired_vault != TEST_VAULT_ID
            );
            assert!(matches!(
                sync(&harness).await,
                outcome::CompletionResult::Retry
            ));
            assert_eq!(
                harness
                    .runtime
                    .replica
                    .snapshot(&harness.account_id)
                    .unwrap(),
                retired
            );
            assert!(harness.server.existing_item_mutation_requests().is_empty());
            assert!(harness.timer.requested().is_empty());
            retain_historical_operation(&harness, ATTEMPT, rejected);
            assert!(matches!(
                sync(&harness).await,
                outcome::CompletionResult::Completed
            ));
            let after = harness
                .runtime
                .replica
                .load(&harness.account_id)
                .await
                .unwrap()
                .unwrap();
            assert!(after.operations.is_empty());
            assert!(after.items.is_empty());
            assert_eq!(
                after.receipts[0].request_fingerprint,
                original.request_fingerprint
            );
            let current_vault = if rejected { TEST_VAULT_ID } else { "vault-2" };
            let authority = after.bootstrap.snapshot().visible_items;
            assert_eq!(
                after.bootstrap.snapshot().visible_vaults,
                retired.bootstrap.snapshot().visible_vaults
            );
            assert!(authority.iter().all(|item| item.vault_id != retired_vault));
            if current_vault == retired_vault {
                assert_eq!(authority, retired.bootstrap.snapshot().visible_items);
            } else {
                assert_eq!(authority.len(), 1);
                assert_eq!(authority[0].vault_id, current_vault);
                assert_eq!(authority[0].version, if rejected { 1 } else { 2 });
                assert_eq!(
                    visible_item(&harness).data,
                    crate::PublicItemDraft::from(&draft())
                );
            }
            assert_eq!(
                after.bootstrap.pending_vault_retirements,
                vec![retired_vault]
            );
            assert_eq!(
                visible_items(&harness)
                    .iter()
                    .any(|item| item.item_id == ITEM),
                !(retired_vault == TEST_VAULT_ID && rejected)
            );
            assert!(harness.timer.requested().is_empty());
            harness.runtime.close().await;
        }
    }
}

#[tokio::test]
async fn stopped_move_keeps_captured_attachments_and_requires_exact_current_completion_scope() {
    for fault in ["none", "foreignAttachment", "changedCategory"] {
        let harness = held_existing_seed(HeldCase::Move, "failed", false, true).await;
        let before = harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap();
        let original = harness.operation().unwrap();
        assert_eq!(
            before.bootstrap.snapshot().visible_items[0]
                .attachments
                .len(),
            1
        );
        assert!(before.items.is_empty());
        assert!(original.attachment_move_recovery.is_none());
        let body: serde_json::Value = serde_json::from_slice(&original.request.body).unwrap();
        assert!(body.get("attachments").is_none());
        assert!(matches!(
            sync(&harness).await,
            outcome::CompletionResult::Retry
        ));
        assert_eq!(
            harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap(),
            before
        );
        assert_eq!(
            visible_item(&harness).data,
            crate::PublicItemDraft::from(&draft())
        );
        assert_eq!(
            visible_item(&harness).status,
            crate::ItemProjectionStatus::Authoritative
        );
        if fault == "changedCategory" {
            retain_historical_operation(&harness, ATTEMPT, false);
            harness.server.created_items.lock().unwrap()[0].category = "secure-note".into();
        } else {
            harness.server.reject_next("attachment_state_conflict");
            retain_historical_operation(&harness, ATTEMPT, false);
            harness
                .server
                .set_attachment_authority(vec![attachment_json(
                    if fault == "foreignAttachment" {
                        "foreign-item"
                    } else {
                        ITEM
                    },
                    TEST_VAULT_ID,
                )]);
        }
        let result = sync(&harness).await;
        let after = harness
            .runtime
            .replica
            .load(&harness.account_id)
            .await
            .unwrap()
            .unwrap();
        assert!(after.items.is_empty());
        if fault == "none" {
            let authority = after.bootstrap.snapshot().visible_items;
            let base = &before.bootstrap.snapshot().visible_items[0];
            assert_eq!(authority[0].attachments, base.attachments);
            assert_eq!(authority[0].encrypted_data, base.encrypted_data);
            assert_eq!(authority[0].version, base.version);
            assert_eq!(authority[0].vault_id, base.vault_id);
            assert!(matches!(result, outcome::CompletionResult::Completed));
            assert!(after.operations.is_empty());
            assert!(matches!(
                after.receipts[0].result,
                crate::replica::OperationOutcomeResult::Rejected {
                    code: crate::replica::OperationRejectionCode::AttachmentStateConflict
                }
            ));
            assert_eq!(
                visible_item(&harness).data,
                crate::PublicItemDraft::from(&draft())
            );
        } else {
            assert_eq!(
                after.bootstrap.snapshot().visible_items,
                before.bootstrap.snapshot().visible_items,
                "{fault}"
            );
            assert!(!matches!(result, outcome::CompletionResult::Completed));
            assert_eq!(after.operations.len(), 1);
            assert_eq!(after.operations[0].request, original.request);
            assert_eq!(
                after.operations[0].legacy_admission,
                original.legacy_admission
            );
            assert!(after.receipts.is_empty());
        }
        let requests = harness.server.existing_item_mutation_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].body, original.request.body);
        assert_eq!(requests[0].header("Idempotency-Key"), Some(ATTEMPT));
        harness.runtime.close().await;
    }
}

fn cached_nine_draft() -> crate::ItemDraft {
    let crate::ItemDraft::Login(mut item) = draft() else {
        unreachable!()
    };
    item.title = "Confirmed edit captured at version nine".into();
    crate::ItemDraft::Login(item)
}

fn fetched_ten_draft() -> crate::ItemDraft {
    let crate::ItemDraft::Login(mut item) = draft() else {
        unreachable!()
    };
    item.title = "Fresh authenticated version ten".into();
    crate::ItemDraft::Login(item)
}

fn history_server_item(
    harness: &Harness,
    version: i32,
    encryption_version: i32,
    plaintext: &crate::ItemDraft,
    favorite: bool,
) -> StoredItem {
    let mut item = harness.server.created_items.lock().unwrap()[0].clone();
    let encrypted = bittery_crypto_core::encrypt_with_aad(
        &create::item_plaintext(plaintext).unwrap(),
        &TEST_VAULT_KEY,
        &bittery_crypto_core::AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: ITEM.into(),
            entity_type: "item".into(),
            version: encryption_version.try_into().unwrap(),
            user_id: USER.into(),
        },
    )
    .unwrap();
    item.version = version;
    item.encryption_version = encryption_version;
    item.encrypted_data = encrypted.ciphertext;
    item.encryption_iv = encrypted.iv;
    item.encryption_algorithm = encrypted.algorithm;
    item.favorite = favorite;
    item.deleted_at = None;
    item
}

async fn held_newer_update(status: &str, applied_history: bool) -> Harness {
    // Rejected/missing source history can retain ciphertext4 through metadata revision9.
    // Applied Update7 must instead precede a later encrypted edit8 and metadata revision9.
    held_existing_seed_with_history(
        HeldCase::Update,
        status,
        false,
        false,
        Some(if applied_history { 8 } else { 4 }),
    )
    .await
}

fn retain_source_era_update(harness: &Harness, rejected: bool) -> OperationRecord {
    let original = harness.operation().unwrap();
    assert_eq!(
        original
            .legacy_admission
            .as_ref()
            .unwrap()
            .source_command
            .base_version,
        6
    );
    let era = if rejected {
        // These intervening versions changed metadata only: keep ciphertext and IV exact.
        let mut cached = harness.server.created_items.lock().unwrap()[0].clone();
        assert_eq!((cached.version, cached.encryption_version), (9, 4));
        cached.version = 6;
        cached.favorite = false;
        cached
    } else {
        history_server_item(harness, 6, 4, &draft(), false)
    };
    *harness.server.created_items.lock().unwrap() = vec![era];
    // The permissive fake CAS helper is called only at the original source revision6.
    // Current revision8/10 is installed separately after this historical result exists.
    assert_eq!(harness.server.created_items.lock().unwrap()[0].version, 6);
    retain_historical_operation(harness, ATTEMPT, rejected);
    assert_eq!(
        harness.server.created_items.lock().unwrap()[0].version,
        if rejected { 6 } else { 7 }
    );
    if !rejected {
        assert_eq!(
            harness.server.created_items.lock().unwrap()[0].encryption_version,
            7
        );
    }
    original
}

fn set_history_fetch(harness: &Harness, version: i32) {
    let item = match version {
        6 => history_server_item(harness, 6, 4, &draft(), false),
        8 => {
            let cached = harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap()
                .bootstrap
                .snapshot()
                .visible_items[0]
                .clone();
            let mut current = harness.server.created_items.lock().unwrap()[0].clone();
            // Revision8 precedes the captured favorite=true metadata mutation at9.
            // Its ciphertext is the same encrypted edit4 (Rejected) or8 (Applied).
            current.version = 8;
            current.encryption_version = cached.encryption_version;
            current.encrypted_data = cached.encrypted_data;
            current.encryption_iv = cached.encryption_iv;
            current.encryption_algorithm = cached.encryption_algorithm;
            current.favorite = false;
            current
        }
        10 => history_server_item(harness, 10, 10, &fetched_ten_draft(), false),
        _ => unreachable!(),
    };
    *harness.server.created_items.lock().unwrap() = vec![item];
}

fn assert_newer_update_replay(harness: &Harness, original: &OperationRecord) {
    let requests = harness.server.requests.lock().unwrap();
    let effects = requests
        .iter()
        .filter(|request| request.url.contains("/operations/") || request.method == "PATCH")
        .collect::<Vec<_>>();
    assert_eq!(effects.len(), 2);
    assert_eq!(effects[0].method, "GET");
    assert_eq!(
        effects[0].url,
        format!("{SERVER_URL}/api/v1/operations/{ATTEMPT}")
    );
    assert_eq!(effects[1].method, "PATCH");
    assert_eq!(effects[1].url, format!("{SERVER_URL}/api/v1/items/{ITEM}"));
    assert_eq!(effects[1].header("Idempotency-Key"), Some(ATTEMPT));
    assert_eq!(effects[1].header("If-Match"), Some("\"6\""));
    assert_eq!(
        effects[1].header("Content-Type"),
        Some("application/merge-patch+json")
    );
    assert_eq!(effects[1].body, original.request.body);
}

#[tokio::test]
async fn stopped_update_newer_cache_missing_proof_keeps_confirmed_nine_and_original_seven() {
    for status in ["failed", "conflicted"] {
        for through_sync in [false, true] {
            let harness = held_newer_update(status, false).await;
            let before = harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap();
            let authority = &before.bootstrap.snapshot().visible_items[0];
            assert_eq!((authority.version, authority.encryption_version), (9, 4));
            assert!(before.items.is_empty());
            assert_eq!(
                visible_item(&harness).data,
                crate::PublicItemDraft::from(&cached_nine_draft())
            );
            assert!(visible_item(&harness).favorite);
            assert_eq!(
                visible_item(&harness).status,
                crate::ItemProjectionStatus::Authoritative
            );
            let operation = &before.operations[0];
            let evidence = operation.legacy_admission.as_ref().unwrap();
            assert_eq!(evidence.source_command.base_version, 6);
            assert_eq!(
                evidence
                    .source_command
                    .encrypted_payload
                    .as_ref()
                    .unwrap()
                    .encryption_version,
                7
            );
            assert!(evidence.overlay_sha256.is_none());
            if through_sync {
                assert!(matches!(
                    sync(&harness).await,
                    outcome::CompletionResult::Retry
                ));
            } else {
                assert!(matches!(
                    harness.runtime.dispatch_eligible_operations().await,
                    dispatch::DispatchPass::Parked
                ));
            }
            assert_eq!(
                harness
                    .runtime
                    .replica
                    .snapshot(&harness.account_id)
                    .unwrap(),
                before
            );
            assert!(harness.server.existing_item_mutation_requests().is_empty());
            assert_eq!(harness.server.outcome_lookups(), 1);
            assert!(harness.timer.requested().is_empty());
            harness.runtime.close().await;
        }
    }
}

#[tokio::test]
async fn stopped_update_newer_cache_reconciles_proof_without_rolling_back_confirmed_authority() {
    for status in ["failed", "conflicted"] {
        for through_sync in [false, true] {
            for rejected in [false, true] {
                for fetched_version in [8, 10] {
                    let harness = held_newer_update(status, !rejected).await;
                    let before = harness
                        .runtime
                        .replica
                        .snapshot(&harness.account_id)
                        .unwrap();
                    let cached = &before.bootstrap.snapshot().visible_items[0];
                    assert_eq!(cached.version, 9);
                    assert_eq!(cached.encryption_version, if rejected { 4 } else { 8 });
                    let original = retain_source_era_update(&harness, rejected);
                    set_history_fetch(&harness, fetched_version);
                    if through_sync {
                        assert!(matches!(
                            sync(&harness).await,
                            outcome::CompletionResult::Completed
                        ));
                    } else {
                        harness
                            .runtime
                            .dispatch_once_ignoring_lease(&harness.account_id, ATTEMPT)
                            .await;
                    }
                    let after = harness
                        .runtime
                        .replica
                        .load(&harness.account_id)
                        .await
                        .unwrap()
                        .unwrap();
                    assert!(after.operations.is_empty());
                    assert!(after.items.is_empty());
                    assert_eq!(after.receipts.len(), 1);
                    let receipt = &after.receipts[0];
                    assert_eq!(receipt.operation_id, ATTEMPT);
                    assert_eq!(receipt.request_fingerprint, original.request_fingerprint);
                    let lineage = receipt.legacy_lineage.as_ref().unwrap();
                    assert_eq!(lineage.source_operation_id.as_deref(), Some(SEMANTIC));
                    assert_eq!(lineage.source_attempt_id.as_deref(), Some(ATTEMPT));
                    assert_eq!(
                        lineage.source_status,
                        original
                            .legacy_admission
                            .as_ref()
                            .unwrap()
                            .source_command
                            .status
                    );
                    if rejected {
                        assert!(matches!(
                            receipt.result,
                            crate::replica::OperationOutcomeResult::Rejected {
                                code: crate::replica::OperationRejectionCode::VaultReadOnly
                            }
                        ));
                    } else {
                        assert!(
                            matches!(&receipt.result,crate::replica::OperationOutcomeResult::Applied {entity_id,version:7} if entity_id == ITEM)
                        );
                    }
                    let current = after.bootstrap.snapshot().visible_items;
                    if fetched_version == 8 {
                        assert_eq!(
                            current,
                            before.bootstrap.snapshot().visible_items,
                            "the stale point read must preserve the complete cached row"
                        );
                        assert_eq!(
                            visible_item(&harness).data,
                            crate::PublicItemDraft::from(&cached_nine_draft())
                        );
                        assert!(visible_item(&harness).favorite);
                    } else {
                        assert_eq!(
                            (current[0].version, current[0].encryption_version),
                            (10, 10)
                        );
                        assert_eq!(
                            visible_item(&harness).data,
                            crate::PublicItemDraft::from(&fetched_ten_draft())
                        );
                        assert!(!visible_item(&harness).favorite);
                    }
                    assert_eq!(
                        visible_item(&harness).status,
                        crate::ItemProjectionStatus::Authoritative
                    );
                    assert_newer_update_replay(&harness, &original);
                    assert_eq!(
                        harness.server.created_items.lock().unwrap()[0].version,
                        fetched_version,
                        "proof replay cannot overwrite later Server authority"
                    );
                    assert!(harness.timer.requested().is_empty());
                    harness.runtime.close().await;
                }
            }
        }
    }
}

#[tokio::test]
async fn stopped_update_applied_seven_with_fetched_six_fences_without_a_receipt_or_cache_rollback()
{
    for status in ["failed", "conflicted"] {
        for through_sync in [false, true] {
            let harness = held_newer_update(status, true).await;
            let before = harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap();
            let original = retain_source_era_update(&harness, false);
            set_history_fetch(&harness, 6);
            if through_sync {
                assert!(!matches!(
                    sync(&harness).await,
                    outcome::CompletionResult::Completed
                ));
            } else {
                harness
                    .runtime
                    .dispatch_once_ignoring_lease(&harness.account_id, ATTEMPT)
                    .await;
            }
            let after = harness
                .runtime
                .replica
                .load(&harness.account_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(after.failure, Some(RuntimeErrorCode::InvariantViolation));
            assert_eq!(after.operations, vec![original.clone()]);
            assert!(after.items.is_empty());
            assert!(after.receipts.is_empty());
            assert_eq!(
                after.bootstrap.snapshot().visible_items,
                before.bootstrap.snapshot().visible_items
            );
            assert_newer_update_replay(&harness, &original);
            harness.runtime.close().await;
        }
    }
}

#[tokio::test]
async fn stopped_update_newer_cache_proof_preserves_a_newer_active_update_overlay() {
    for rejected in [false, true] {
        for fetched_version in [8, 10] {
            let harness =
                held_newer_update(if rejected { "conflicted" } else { "failed" }, !rejected).await;
            let original = retain_source_era_update(&harness, rejected);
            set_history_fetch(&harness, fetched_version);
            let selected = visible_item(&harness);
            let edit_guard = selected
                .edit_guard
                .expect("current authoritative Item edit guard");
            assert_eq!(edit_guard.item_version, 9);
            let (new_id, _) = harness
                .accept_existing(RuntimeRequest::UpdateItem {
                    guard: edit_guard,
                    account_id: harness.account_id.clone(),
                    item_id: ITEM.into(),
                    draft: draft(),
                })
                .await;
            let accepted = harness
                .runtime
                .replica
                .snapshot(&harness.account_id)
                .unwrap();
            let new_operation = accepted
                .operations
                .iter()
                .find(|operation| operation.operation_id == new_id)
                .unwrap()
                .clone();
            let new_overlay = accepted
                .items
                .iter()
                .find(|overlay| overlay.operation_id == new_id)
                .unwrap()
                .clone();
            assert_eq!(new_overlay.encryption_version, 10);
            let new_projection = visible_item(&harness);
            assert_eq!(new_projection.data, crate::PublicItemDraft::from(&draft()));
            assert_eq!(new_projection.status, crate::ItemProjectionStatus::Pending);
            assert_eq!(
                new_projection
                    .duplicate_source_guard
                    .as_ref()
                    .expect("pending Item duplicate guard")
                    .replica_revision,
                accepted.revision
            );
            if rejected {
                assert!(matches!(
                    sync(&harness).await,
                    outcome::CompletionResult::Completed
                ));
            } else {
                harness
                    .runtime
                    .dispatch_once_ignoring_lease(&harness.account_id, ATTEMPT)
                    .await;
            }
            let after = harness
                .runtime
                .replica
                .load(&harness.account_id)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(after.operations, vec![new_operation]);
            assert_eq!(after.items, vec![new_overlay]);
            let mut expected_projection = new_projection;
            expected_projection
                .duplicate_source_guard
                .as_mut()
                .expect("pending Item duplicate guard")
                .replica_revision = after.revision;
            assert_eq!(visible_item(&harness), expected_projection);
            assert_eq!(after.receipts.len(), 1);
            assert_eq!(after.receipts[0].operation_id, ATTEMPT);
            assert_eq!(
                after.receipts[0].request_fingerprint,
                original.request_fingerprint
            );
            assert_eq!(
                after.bootstrap.snapshot().visible_items[0].version,
                if fetched_version == 8 { 9 } else { 10 }
            );
            assert_newer_update_replay(&harness, &original);
            harness.runtime.close().await;
        }
    }
}
