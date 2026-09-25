use super::*;
use crate::replica::InMemoryReplica;

#[test]
fn full_bootstrap_erases_absent_vault_authority_from_all_generations() {
    let replica = InMemoryReplica::default();
    let account: AccountId = "retirement-account".into();
    replica
        .install(account.clone(), "user-1".into(), "incarnation-1".into())
        .unwrap();
    let visible = crate::test_fixtures::personal_vault("visible", "user-1");
    let hidden = crate::test_fixtures::personal_vault("hidden", "user-1");
    replica
        .seed_ready_authority(&account, vec![visible.clone(), hidden], vec![])
        .unwrap();
    let snapshot = replica.snapshot(&account).unwrap();
    replica
        .mark_refresh_required(MarkRefreshRequiredPlan {
            guard: BootstrapGuard {
                account_id: account.clone(),
                user_id: snapshot.user_id,
                incarnation: snapshot.incarnation,
                expected_replica_revision: snapshot.revision,
                expected_lock_epoch: snapshot.lock_epoch,
            },
        })
        .unwrap();
    replica
        .seed_ready_authority(&account, vec![visible], vec![])
        .unwrap();
    let snapshot = replica.snapshot(&account).unwrap();
    assert!(
        snapshot
            .bootstrap
            .vaults
            .keys()
            .all(|(_, vault)| vault != "hidden"),
        "fresh complete authority must erase hidden wrapped keys from every older generation"
    );
}

fn ready() -> (InMemoryReplica, AccountId) {
    let replica = InMemoryReplica::default();
    let account: AccountId = "retirement-account".into();
    replica
        .install(account.clone(), "user-1".into(), "incarnation-1".into())
        .unwrap();
    replica
        .seed_ready_authority(
            &account,
            vec![
                crate::test_fixtures::personal_vault("hidden", "user-1"),
                crate::test_fixtures::personal_vault("visible", "user-1"),
            ],
            vec![],
        )
        .unwrap();
    (replica, account)
}

fn plan(snapshot: &ReplicaSnapshot, mutations: Vec<PlanMutation>) -> GuardedCommitPlan {
    GuardedCommitPlan {
        account_id: snapshot.account_id.clone(),
        expected_incarnation: snapshot.incarnation.clone(),
        expected_replica_revision: snapshot.revision,
        expected_lock_epoch: snapshot.lock_epoch,
        mutations,
    }
}

fn move_work(account: &AccountId) -> (OperationRecord, ReplicaItemRecord) {
    let body = serde_json::to_vec(&crate::server_contract::MoveItemBody::Prepared {
        attachments: None,
        source_vault_id: "hidden".into(),
        target_vault_id: "visible".into(),
        encrypted_data: "target-ciphertext".into(),
        encryption_algorithm: "AES-GCM-AAD-V1".into(),
        encryption_iv: "AAAAAAAAAAAAAAAA".into(),
    })
    .unwrap();
    let mut operation = crate::test_fixtures::test_operation("move", "item");
    operation.kind = OperationKind::MoveItem;
    operation.target = ResourceRef::Item {
        item_id: "item".into(),
        vault_id: "visible".into(),
    };
    operation.request = ImmutableHttpRequest {
        method: HttpMethod::Post,
        path: "/api/v1/items/item/moves".into(),
        headers: vec![],
        body,
    };
    operation.request_fingerprint = Sha256Fingerprint::of_bytes(&operation.request.body);
    let mut overlay = crate::test_fixtures::test_overlay(account.clone(), "item", "move");
    overlay.vault_id = "visible".into();
    (operation, overlay)
}

#[test]
fn retirement_erases_cross_vault_move_overlay_preserving_exact_request_and_category() {
    let (replica, account) = ready();
    let (operation, overlay) = move_work(&account);
    replica
        .execute(plan(
            &replica.snapshot(&account).unwrap(),
            vec![
                PlanMutation::AcceptOperation(operation.clone()),
                PlanMutation::PutOptimisticItem(overlay),
            ],
        ))
        .unwrap();
    replica
        .execute(plan(
            &replica.snapshot(&account).unwrap(),
            vec![PlanMutation::RetireVaults {
                vault_ids: vec!["hidden".into()],
            }],
        ))
        .unwrap();
    let snapshot = replica.snapshot(&account).unwrap();
    assert!(
        snapshot.items.is_empty(),
        "the visible-target overlay must not reveal hidden-source intent"
    );
    assert_eq!(snapshot.operations[0].request, operation.request);
    assert_eq!(
        snapshot.operations[0].request_fingerprint,
        operation.request_fingerprint
    );
    assert_eq!(
        snapshot.operations[0].accepted_item_category,
        Some(AuthorityItemCategory::Login)
    );
    assert_eq!(snapshot.bootstrap.pending_vault_retirements, ["hidden"]);
    assert!(snapshot.require_vault_accepting_work("hidden").is_err());
    snapshot.require_vault_accepting_work("visible").unwrap();
}

#[test]
fn retirement_work_and_journal_round_trip_in_one_prepared_commit() {
    use crate::replica::persistence_contract::{
        apply_prepared_writes_to_rows, prepare_commit, reconstruct_snapshot, snapshot_rows,
    };
    let (replica, account) = ready();
    let (operation, overlay) = move_work(&account);
    replica
        .execute(plan(
            &replica.snapshot(&account).unwrap(),
            vec![
                PlanMutation::AcceptOperation(operation),
                PlanMutation::PutOptimisticItem(overlay),
            ],
        ))
        .unwrap();
    let before = replica.snapshot(&account).unwrap();
    let prepared = prepare_commit(
        before.clone(),
        plan(
            &before,
            vec![PlanMutation::RetireVaults {
                vault_ids: vec!["hidden".into()],
            }],
        ),
    )
    .unwrap();
    let rows = apply_prepared_writes_to_rows(snapshot_rows(before).unwrap(), &prepared.wire.writes);
    let reopened = reconstruct_snapshot(&account, Some(prepared.wire.next_head), rows)
        .unwrap()
        .unwrap();
    assert_eq!(reopened, prepared.next_snapshot);
    assert_eq!(reopened.bootstrap.pending_vault_retirements, ["hidden"]);
    assert!(reopened.items.is_empty());
    assert_eq!(
        reopened.operations[0].accepted_item_category,
        Some(AuthorityItemCategory::Login)
    );
}

#[test]
fn old_completion_cannot_clear_another_retirement_of_the_same_vault() {
    let (replica, account) = ready();
    replica
        .execute(plan(
            &replica.snapshot(&account).unwrap(),
            vec![PlanMutation::RetireVaults {
                vault_ids: vec!["hidden".into()],
            }],
        ))
        .unwrap();
    let old = plan(
        &replica.snapshot(&account).unwrap(),
        vec![PlanMutation::CompleteVaultRetirements {
            vault_ids: vec!["hidden".into()],
        }],
    );
    replica.execute(old.clone()).unwrap();
    replica
        .execute(plan(
            &replica.snapshot(&account).unwrap(),
            vec![PlanMutation::RetireVaults {
                vault_ids: vec!["hidden".into()],
            }],
        ))
        .unwrap();
    assert!(matches!(
        replica.execute(old).unwrap(),
        PlanResult::Stale { .. }
    ));
    assert_eq!(
        replica
            .snapshot(&account)
            .unwrap()
            .bootstrap
            .pending_vault_retirements,
        ["hidden"]
    );
}

#[test]
fn mismatched_category_witness_is_rejected_before_overlay_admission() {
    let (replica, account) = ready();
    let (mut operation, overlay) = move_work(&account);
    operation.accepted_item_category = Some(AuthorityItemCategory::SecureNote);
    assert!(replica
        .execute(plan(
            &replica.snapshot(&account).unwrap(),
            vec![
                PlanMutation::AcceptOperation(operation),
                PlanMutation::PutOptimisticItem(overlay),
            ]
        ))
        .is_err());
    assert!(replica.snapshot(&account).unwrap().operations.is_empty());
}

#[test]
fn malformed_or_uncompleted_journal_never_admits_new_authority() {
    let (replica, account) = ready();
    let before = replica.snapshot(&account).unwrap();
    for ids in [
        vec!["hidden".into(), "hidden".into()],
        vec![String::new()],
        vec!["visible".into(), "hidden".into()],
    ] {
        assert!(replica
            .execute(plan(
                &before,
                vec![PlanMutation::RetireVaults { vault_ids: ids }]
            ))
            .is_err());
    }
    replica
        .execute(plan(
            &before,
            vec![PlanMutation::RetireVaults {
                vault_ids: vec!["hidden".into()],
            }],
        ))
        .unwrap();
    assert!(replica
        .seed_ready_authority(
            &account,
            vec![crate::test_fixtures::personal_vault("hidden", "user-1")],
            vec![]
        )
        .is_err());
}

#[tokio::test]
async fn physical_stale_cleanup_completion_is_never_rebased_to_a_new_duty() {
    use crate::replica::{
        Replica, ReplicaPersistence, ReplicaPersistenceRequest, ReplicaPersistenceResponse,
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct RacedCompletion {
        state: InMemoryReplica,
        commits: AtomicUsize,
    }
    #[async_trait::async_trait]
    impl ReplicaPersistence for RacedCompletion {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            if let ReplicaPersistenceRequest::Commit { prepared } = &request {
                if self.commits.fetch_add(1, Ordering::SeqCst) == 0 {
                    let snapshot = self.state.snapshot(&prepared.expected.account_id).unwrap();
                    self.state
                        .execute(plan(
                            &snapshot,
                            vec![PlanMutation::CompleteVaultRetirements {
                                vault_ids: vec!["hidden".into()],
                            }],
                        ))
                        .unwrap();
                    let snapshot = self.state.snapshot(&prepared.expected.account_id).unwrap();
                    self.state
                        .execute(plan(
                            &snapshot,
                            vec![PlanMutation::RetireVaults {
                                vault_ids: vec!["hidden".into()],
                            }],
                        ))
                        .unwrap();
                }
            }
            self.state.invoke(request).await
        }
    }
    let (state, account) = ready();
    state
        .execute(plan(
            &state.snapshot(&account).unwrap(),
            vec![PlanMutation::RetireVaults {
                vault_ids: vec!["hidden".into()],
            }],
        ))
        .unwrap();
    let captured = plan(
        &state.snapshot(&account).unwrap(),
        vec![PlanMutation::CompleteVaultRetirements {
            vault_ids: vec!["hidden".into()],
        }],
    );
    let adapter = Arc::new(RacedCompletion {
        state,
        commits: AtomicUsize::new(0),
    });
    let replica = Replica::new(adapter.clone());
    assert!(matches!(
        replica.execute(captured).await.unwrap(),
        PlanResult::Stale { .. }
    ));
    assert_eq!(adapter.commits.load(Ordering::SeqCst), 1);
    assert_eq!(
        adapter
            .state
            .snapshot(&account)
            .unwrap()
            .bootstrap
            .pending_vault_retirements,
        ["hidden"]
    );
}

#[test]
fn full_bootstrap_commit_carries_move_witness_and_erasure_with_promoted_authority() {
    use crate::replica::persistence_contract::{
        apply_prepared_writes_to_rows, prepare_bootstrap_commit, reconstruct_snapshot,
        snapshot_rows,
    };
    let (replica, account) = ready();
    let (operation, overlay) = move_work(&account);
    replica
        .execute(plan(
            &replica.snapshot(&account).unwrap(),
            vec![
                PlanMutation::AcceptOperation(operation),
                PlanMutation::PutOptimisticItem(overlay),
            ],
        ))
        .unwrap();
    let mut model = AccountReplica::from_snapshot(replica.snapshot(&account).unwrap());
    let guard = |model: &AccountReplica| BootstrapGuard {
        account_id: model.account_id.clone(),
        user_id: model.user_id.clone(),
        incarnation: model.incarnation.clone(),
        expected_replica_revision: model.revision,
        expected_lock_epoch: model.lock_epoch,
    };
    let generation_id = BootstrapGenerationId("fresh-verified".into());
    model
        .begin_bootstrap(BeginBootstrapPlan {
            guard: guard(&model),
            generation_id: generation_id.clone(),
        })
        .unwrap();
    model
        .stage_bootstrap_page(StageBootstrapPagePlan {
            guard: guard(&model),
            generation_id: generation_id.clone(),
            page_identity: BootstrapPageIdentity::vaults(0),
            request_cursor: BootstrapPageCursor::VaultsInitial,
            raw_response_fingerprint: Sha256Fingerprint::of_bytes(b"fresh-vaults"),
            pinned_watermark: SyncCursor::CapturedEmpty,
            continuation: BootstrapContinuation::Final,
            vault_key_version_included: false,
            vaults: vec![crate::test_fixtures::personal_vault("visible", "user-1")],
            items: vec![],
        })
        .unwrap();
    model
        .stage_bootstrap_page(StageBootstrapPagePlan {
            guard: guard(&model),
            generation_id: generation_id.clone(),
            page_identity: BootstrapPageIdentity::items(0),
            request_cursor: BootstrapPageCursor::ItemsInitial,
            raw_response_fingerprint: Sha256Fingerprint::of_bytes(b"fresh-items"),
            pinned_watermark: SyncCursor::CapturedEmpty,
            continuation: BootstrapContinuation::Final,
            vault_key_version_included: false,
            vaults: vec![],
            items: vec![],
        })
        .unwrap();
    let before = model.snapshot();
    for invalid in [
        vec!["visible".into()],
        vec![String::new()],
        vec!["session-only".into(), "session-only".into()],
        vec!["z".into(), "a".into()],
    ] {
        assert!(model
            .promote_bootstrap(PromoteBootstrapPlan {
                guard: guard(&model),
                generation_id: generation_id.clone(),
                additional_retired_vault_ids: invalid,
            })
            .is_err());
        assert_eq!(model.snapshot(), before);
    }
    model
        .promote_bootstrap(PromoteBootstrapPlan {
            additional_retired_vault_ids: vec!["session-only".into()],
            guard: guard(&model),
            generation_id,
        })
        .unwrap();
    let prepared = prepare_bootstrap_commit(before.clone(), model.snapshot(), true).unwrap();
    let rows = apply_prepared_writes_to_rows(
        snapshot_rows(before.clone()).unwrap(),
        &prepared.wire.writes,
    );
    let reopened = reconstruct_snapshot(&account, Some(prepared.wire.next_head.clone()), rows)
        .unwrap()
        .unwrap();
    assert_eq!(reopened, model.snapshot());
    assert!(reopened.items.is_empty());
    assert_eq!(
        reopened.operations[0].accepted_item_category,
        Some(AuthorityItemCategory::Login)
    );
    assert_eq!(
        reopened.bootstrap.pending_vault_retirements,
        ["hidden", "session-only"]
    );
    let mut unrelated_change = model.snapshot();
    unrelated_change.operations[0].scheduling.attempt_count += 1;
    assert!(
        prepare_bootstrap_commit(before, unrelated_change, true).is_err(),
        "Bootstrap cannot smuggle unrelated work updates"
    );
}

#[test]
fn share_capabilities_follow_receipt_vault_identity_not_current_item_location() {
    let (replica, account) = ready();
    let mut model = AccountReplica::from_snapshot(replica.snapshot(&account).unwrap());
    let mut share = crate::test_fixtures::test_operation("share", "item");
    share.kind = OperationKind::CreateShare;
    share.target = ResourceRef::Item {
        item_id: "item".into(),
        vault_id: "hidden".into(),
    };
    share.request.path = "/api/v1/items/item/share-links".into();
    let capability = ProtectedShareCapabilityRecord {
        account_id: account,
        operation_id: "share".into(),
        ciphertext: "protected-capability".into(),
        iv: "iv".into(),
        algorithm: "AES-GCM-AAD-V1".into(),
        result: None,
    };
    model
        .apply(PlanMutation::AcceptOperation(share.clone()))
        .unwrap();
    model
        .apply(PlanMutation::PutProtectedShareCapability(capability))
        .unwrap();
    let before = model.snapshot();
    model = AccountReplica::from_snapshot(
        apply_plan(
            before.clone(),
            plan(
                &before,
                vec![PlanMutation::ReconcileShareOutcome {
                    cursor: None,
                    outcome: ObservedOutcome {
                        operation_id: "share".into(),
                        request_fingerprint: share.request_fingerprint,
                        result: OperationOutcomeResult::ShareApplied {
                            share_link_id: "link".into(),
                            base_share_url: "https://vault.example.test/share/link".into(),
                            expires_at: "2026-09-10T00:00:00Z".into(),
                        },
                    },
                }],
            ),
        )
        .unwrap(),
    );
    assert_eq!(model.share_capabilities.len(), 1);
    let pending = before;
    let receipt = model.snapshot().receipts[0].clone();
    let outcome = ObservedOutcome {
        operation_id: receipt.operation_id,
        request_fingerprint: receipt.request_fingerprint,
        result: receipt.result,
    };
    let composed = apply_plan(
        pending.clone(),
        plan(
            &pending,
            vec![
                PlanMutation::ReconcileShareOutcome {
                    cursor: None,
                    outcome,
                },
                PlanMutation::RetireVaults {
                    vault_ids: vec!["hidden".into()],
                },
            ],
        ),
    )
    .unwrap();
    assert!(composed.share_capabilities.is_empty());
    assert_eq!(composed.receipts.len(), 1);
    model.retire_vault_authority(&["hidden".into()]).unwrap();
    assert!(model.share_capabilities.is_empty());
    assert_eq!(model.receipts.len(), 1);
    assert!(model
        .bootstrap
        .vaults
        .values()
        .all(|vault| vault.id == "visible"));
}

#[tokio::test]
async fn cold_journal_survives_sqlite_reopen_and_same_account_incarnation_replacement() {
    use crate::replica::{Replica, SqliteReplica};
    use std::sync::Arc;
    let path = std::env::temp_dir().join(format!(
        "bittery-vault-retirement-{}.sqlite",
        bittery_crypto_core::generate_uuid()
    ));
    let account: AccountId = "cold-account".into();
    {
        let replica = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
        let snapshot = replica
            .install_or_replace(account.clone(), "user".into(), "first".into())
            .await
            .unwrap();
        replica
            .execute_exact(plan(
                &snapshot,
                vec![PlanMutation::RetireVaults {
                    vault_ids: vec!["hidden".into()],
                }],
            ))
            .await
            .unwrap();
    }
    {
        let replica = Replica::new(Arc::new(SqliteReplica::open(&path).unwrap()));
        let restored = replica.load(&account).await.unwrap().unwrap();
        assert_eq!(restored.bootstrap.pending_vault_retirements, ["hidden"]);
        let replaced = replica
            .install_or_replace(account.clone(), "user".into(), "replacement".into())
            .await
            .unwrap();
        assert_eq!(replaced.bootstrap.pending_vault_retirements, ["hidden"]);
        assert_eq!(replaced.bootstrap.state, ReplicaState::Cold);
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn retiring_old_item_scope_preserves_same_item_currently_in_visible_vault() {
    let (replica, account) = ready();
    let mut model = AccountReplica::from_snapshot(replica.snapshot(&account).unwrap());
    let generation = model.bootstrap.active_generation.clone().unwrap();
    let current = AuthorityItemRecord {
        id: "item".into(),
        vault_id: "visible".into(),
        category: AuthorityItemCategory::Login,
        favorite: false,
        encrypted_data: "visible-current-ciphertext".into(),
        encryption_iv: "AAAAAAAAAAAAAAAA".into(),
        encryption_algorithm: "AES-GCM-AAD-V1".into(),
        version: 2,
        encryption_version: 1,
        encrypted_by_user_id: "user-1".into(),
        last_modified_by: "user-1".into(),
        created_at: "2026-09-09T00:00:00Z".into(),
        updated_at: "2026-09-09T00:00:00Z".into(),
        deleted_at: None,
        attachments: Vec::new(),
    };
    model
        .bootstrap
        .items
        .insert((generation, "item".into()), current.clone());
    model.retire_vault_authority(&["hidden".into()]).unwrap();
    assert_eq!(
        model.bootstrap.items.values().collect::<Vec<_>>(),
        [&current]
    );
}

#[test]
fn duplicate_journal_rows_cannot_replace_an_earlier_cleanup_duty() {
    use crate::replica::persistence_contract::{
        prepare_commit, reconstruct_snapshot, snapshot_rows, ReplicaStore,
    };
    let (replica, account) = ready();
    let before = replica.snapshot(&account).unwrap();
    let prepared = prepare_commit(
        before.clone(),
        plan(
            &before,
            vec![PlanMutation::RetireVaults {
                vault_ids: vec!["hidden".into()],
            }],
        ),
    )
    .unwrap();
    let mut rows = snapshot_rows(prepared.next_snapshot).unwrap();
    let mut duplicate = rows
        .iter()
        .find(|row| {
            row.store == ReplicaStore::ReplicaMetadata && row.key.record_id == "vault-retirements"
        })
        .unwrap()
        .clone();
    duplicate.payload_json = r#"{"vaultIds":["later"]}"#.into();
    rows.push(duplicate);
    assert!(reconstruct_snapshot(&account, Some(prepared.wire.next_head), rows).is_err());
}

#[test]
fn retained_result_abandons_preproof_staging_without_rewriting_current_authority() {
    use crate::replica::persistence_contract::{
        apply_prepared_writes_to_rows, prepare_commit, reconstruct_snapshot, snapshot_rows,
    };
    for initially_ready in [false, true] {
        let (replica, account) = ready();
        let mut model = AccountReplica::from_snapshot(replica.snapshot(&account).unwrap());
        if !initially_ready {
            model.bootstrap = BootstrapAuthority::default();
        }
        let (operation, overlay) = move_work(&account);
        model
            .apply(PlanMutation::AcceptOperation(operation.clone()))
            .unwrap();
        model
            .apply(PlanMutation::PutOptimisticItem(overlay))
            .unwrap();
        let generation = BootstrapGenerationId("before-exact-replay".into());
        model
            .begin_bootstrap(BeginBootstrapPlan {
                guard: BootstrapGuard {
                    account_id: account.clone(),
                    user_id: model.user_id.clone(),
                    incarnation: model.incarnation.clone(),
                    expected_replica_revision: model.revision,
                    expected_lock_epoch: model.lock_epoch,
                },
                generation_id: generation.clone(),
            })
            .unwrap();
        let before = model.snapshot();
        let current_authority = before.bootstrap.snapshot().visible_vaults;
        let completion = plan(
            &before,
            vec![PlanMutation::ReconcileRetainedResult {
                outcome: ObservedOutcome {
                    operation_id: operation.operation_id.clone(),
                    request_fingerprint: operation.request_fingerprint,
                    result: OperationOutcomeResult::Applied {
                        entity_id: operation.item_id().into(),
                        version: 2,
                    },
                },
            }],
        );
        let prepared = prepare_commit(before.clone(), completion)
            .expect("retained result must not depend on the unfinished current-authority fetch");
        let rows = snapshot_rows(before.clone()).unwrap();
        let rows = apply_prepared_writes_to_rows(rows, &prepared.wire.writes);
        let after = reconstruct_snapshot(&account, Some(prepared.wire.next_head.clone()), rows)
            .unwrap()
            .unwrap();
        assert_eq!(
            after.bootstrap.state,
            if initially_ready {
                ReplicaState::RefreshRequired
            } else {
                ReplicaState::Cold
            }
        );
        assert!(after.bootstrap.staging_generation.is_none());
        assert!(!after.bootstrap.generations.contains_key(&generation));
        assert_eq!(after.bootstrap.snapshot().visible_vaults, current_authority);
        assert!(after.operations.is_empty());
        assert!(after.items.is_empty());
        assert_eq!(after.receipts.len(), 1);
    }
}
