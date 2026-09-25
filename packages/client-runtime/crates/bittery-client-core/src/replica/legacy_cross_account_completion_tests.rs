//! Remote completion atomically changes authority without ever installing a pending source.
use super::*;
use crate::replica::persistence_contract::{prepare_commit, PreparedReplicaWrite, ReplicaStore};

fn delete_proof(record: &CrossAccountMoveRecord) -> ObservedOutcome {
    let fixed = record
        .legacy_item_child(CrossAccountMoveStep::SourceDelete)
        .unwrap()
        .unwrap();
    let child = fixed.item().unwrap();
    ObservedOutcome {
        operation_id: child.operation_id.clone(),
        request_fingerprint: child.request_fingerprint,
        result: OperationOutcomeResult::Applied {
            entity_id: record.source.id.clone(),
            version: record.source.version + 2,
        },
    }
}

fn full_completion_proofs(
    record: &CrossAccountMoveRecord,
    delete: &ObservedOutcome,
) -> serde_json::Value {
    let proof = |step, entity_id: String, version| {
        let fixed = record.legacy_item_child(step).unwrap().unwrap();
        let child = fixed.item().unwrap();
        ObservedOutcome {
            operation_id: child.operation_id.clone(),
            request_fingerprint: child.request_fingerprint,
            result: OperationOutcomeResult::Applied { entity_id, version },
        }
    };
    json!({
        "targetCreate": proof(CrossAccountMoveStep::TargetCreate, record.target.id.clone(), 1),
        "sourceTrash": proof(CrossAccountMoveStep::SourceTrash, record.source.id.clone(), record.source.version + 1),
        "sourceDelete": delete,
    })
}

fn completion_mutation(record: &CrossAccountMoveRecord, outcome: &ObservedOutcome) -> PlanMutation {
    // Deliberately exercise the existing serialized plan boundary for the behavioral RED.
    serde_json::from_value(json!({
        "type":"reauthorizeAndCompleteLegacyCrossAccountMove",
        "operationId":record.operation_id,
        "expectedBindingRevision":record.destination_binding.binding_revision.to_string(),
        "destinationAccountId":"replacement-account",
        "destinationIncarnation":"replacement-incarnation",
        "verifiedOutcomes":full_completion_proofs(record, outcome),
    }))
    .expect("the guarded domain must support atomic legacy completion")
}

fn completion_fixture(
    status: LegacyItemCommandStatus,
    materialized: bool,
    retained: bool,
) -> (InMemoryReplica, AccountId, CrossAccountMoveRecord) {
    let (replica, account, original) = held_source_delete(status, materialized);
    if retained {
        let mut next = replica
            .snapshot(&account)
            .unwrap()
            .cross_account_moves
            .remove(0)
            .into_captured()
            .unwrap();
        next.children[2].item_mut().unwrap().result = Some(delete_proof(&original));
        advance_record(&replica, &account, next);
    }
    retire(&replica, &account);
    (replica, account, original)
}

#[test]
fn held_completion_commits_exact_authorization_and_source_removal_without_overlay_writes() {
    for status in [
        LegacyItemCommandStatus::Failed,
        LegacyItemCommandStatus::Conflicted,
    ] {
        for (materialized, retained) in [(false, false), (true, false), (true, true)] {
            for cache in ["original", "trashed", "newer", "absent"] {
                let (replica, account, original) =
                    completion_fixture(status, materialized, retained);
                if cache != "original" {
                    // Newer ciphertext is domain coverage, not a claimed original Server history.
                    let mut source = original.source.clone();
                    source.version += if cache == "newer" { 5 } else { 1 };
                    if cache == "trashed" {
                        source.deleted_at = Some("2026-01-01T00:00:00Z".into());
                    } else if cache == "newer" {
                        source.encrypted_data = "newer-unrelated-authority-ciphertext".into();
                        source.favorite = !source.favorite;
                    }
                    replica
                        .seed_ready_authority(
                            &account,
                            vec![crate::test_fixtures::personal_vault(
                                &original.source.vault_id,
                                &original.source_identity.user_id,
                            )],
                            if cache == "absent" {
                                Vec::new()
                            } else {
                                vec![source]
                            },
                        )
                        .unwrap();
                }
                let mut unrelated = original.clone();
                unrelated.source.id = "unrelated-source".into();
                let (operation, overlay) = same_item_create(&unrelated, true);
                execute(
                    &replica,
                    &account,
                    vec![
                        PlanMutation::AcceptOperation(operation),
                        PlanMutation::PutOptimisticItem(overlay),
                    ],
                )
                .unwrap();
                let before = replica.snapshot(&account).unwrap();
                let proof = delete_proof(&original);
                let mutation =
                    completion_mutation(before.cross_account_moves[0].captured().unwrap(), &proof);
                let plan = GuardedCommitPlan::new(
                    account.clone(),
                    before.incarnation.clone(),
                    before.revision,
                    before.lock_epoch,
                    vec![mutation.clone()],
                );
                let prepared = prepare_commit(before.clone(), plan).unwrap();
                assert!(prepared.wire.writes.iter().all(|write| !matches!(write, PreparedReplicaWrite::Put { row } if row.store == ReplicaStore::OptimisticItems)));
                execute(&replica, &account, vec![mutation]).unwrap();
                let after = replica.snapshot(&account).unwrap();
                assert_eq!(after, prepared.next_snapshot);
                assert_eq!(after.revision, before.revision + 1);
                let mut expected = before.cross_account_moves[0].captured().unwrap().clone();
                expected.destination_binding.account_id = "replacement-account".into();
                expected.destination_binding.incarnation = "replacement-incarnation".into();
                expected.destination_binding.binding_revision = 2;
                expected.destination_binding.status = CrossAccountMoveBindingStatus::Active;
                expected.legacy_admission.as_mut().unwrap().disposition =
                    LegacyWorkflowDisposition::DestinationReauthorized(
                        LegacyWorkflowAuthorization {
                            prior_hold: original
                                .legacy_admission
                                .as_ref()
                                .unwrap()
                                .disposition
                                .prior_hold()
                                .unwrap(),
                            binding_revision: 2,
                        },
                    );
                if !materialized {
                    expected.children.push(
                        expected
                            .legacy_item_child(CrossAccountMoveStep::SourceDelete)
                            .unwrap()
                            .unwrap(),
                    );
                }
                expected.children[2].item_mut().unwrap().result = Some(proof);
                expected.stage = CrossAccountMoveStage::Completed;
                expected.disposition = CrossAccountMoveDisposition::Ready;
                assert_eq!(
                    after.cross_account_moves,
                    vec![CrossAccountMoveEntry::from(expected)]
                );
                assert_eq!(after.items, before.items);
                assert_eq!(after.operations, before.operations);
                assert!(after
                    .bootstrap
                    .snapshot()
                    .visible_items
                    .iter()
                    .all(|item| item.id != original.source.id));
                let mut expected_bootstrap = before.bootstrap.clone();
                let generation = expected_bootstrap.active_generation.clone().unwrap();
                expected_bootstrap
                    .items
                    .remove(&(generation, original.source.id.clone()));
                assert_eq!(after.bootstrap, expected_bootstrap);
            }
        }
    }
}

#[test]
fn held_completion_refuses_wrong_or_replacement_delete_proofs_atomically() {
    for (materialized, retained) in [(false, false), (true, false), (true, true)] {
        let (replica, account, original) =
            completion_fixture(LegacyItemCommandStatus::Failed, materialized, retained);
        let before = replica.snapshot(&account).unwrap();
        for mismatch in ["identity", "fingerprint", "entity", "version", "rejected"] {
            let mut proof = delete_proof(&original);
            match mismatch {
                "identity" => proof.operation_id.push_str("-unrelated"),
                "fingerprint" => {
                    proof.request_fingerprint = Sha256Fingerprint::of_bytes(b"wrong request")
                }
                "entity" => {
                    proof.result = OperationOutcomeResult::Applied {
                        entity_id: "other-source".into(),
                        version: original.source.version + 2,
                    }
                }
                "version" => {
                    proof.result = OperationOutcomeResult::Applied {
                        entity_id: original.source.id.clone(),
                        version: original.source.version + 3,
                    }
                }
                "rejected" => {
                    proof.result = OperationOutcomeResult::Rejected {
                        code: OperationRejectionCode::VaultReadOnly,
                    }
                }
                _ => unreachable!(),
            }
            assert!(
                execute(
                    &replica,
                    &account,
                    vec![completion_mutation(
                        before.cross_account_moves[0].captured().unwrap(),
                        &proof
                    )]
                )
                .is_err(),
                "{mismatch}"
            );
            assert_eq!(replica.snapshot(&account).unwrap(), before);
        }
    }
}

#[test]
fn held_completion_refuses_unsupported_stage_and_binding() {
    for invalid in ["active", "wrong-revision", "source-account", "rejected"] {
        let (replica, account, original) =
            held_source_delete(LegacyItemCommandStatus::Failed, true);
        if invalid == "rejected" {
            let mut next = replica
                .snapshot(&account)
                .unwrap()
                .cross_account_moves
                .remove(0)
                .into_captured()
                .unwrap();
            let mut rejected = delete_proof(&original);
            rejected.result = OperationOutcomeResult::Rejected {
                code: OperationRejectionCode::VaultReadOnly,
            };
            next.children[2].item_mut().unwrap().result = Some(rejected);
            next.stage = CrossAccountMoveStage::Rejected;
            next.disposition = CrossAccountMoveDisposition::Rejected {
                code: OperationRejectionCode::VaultReadOnly,
            };
            advance_record(&replica, &account, next);
        }
        if invalid != "active" {
            retire(&replica, &account);
        }
        let before = replica.snapshot(&account).unwrap();
        let mut mutation = serde_json::to_value(completion_mutation(
            before.cross_account_moves[0].captured().unwrap(),
            &delete_proof(&original),
        ))
        .unwrap();
        if invalid == "wrong-revision" {
            mutation["expectedBindingRevision"] = json!("0");
        }
        if invalid == "source-account" {
            mutation["destinationAccountId"] = json!(account);
        }
        assert!(
            execute(
                &replica,
                &account,
                vec![serde_json::from_value(mutation).unwrap()]
            )
            .is_err(),
            "{invalid}"
        );
        assert_eq!(replica.snapshot(&account).unwrap(), before);
    }
}

#[test]
fn held_completion_refuses_active_and_inactive_independent_overlay_owners() {
    for materialized in [false, true] {
        for inactive in [false, true] {
            let (replica, account, original) = completion_fixture(
                LegacyItemCommandStatus::Conflicted,
                materialized,
                materialized,
            );
            let (operation, overlay) = same_item_create(&original, inactive);
            execute(
                &replica,
                &account,
                vec![
                    PlanMutation::AcceptOperation(operation),
                    PlanMutation::PutOptimisticItem(overlay),
                ],
            )
            .unwrap();
            let before = replica.snapshot(&account).unwrap();
            assert_eq!(
                before.item_has_optimistic_owner(&original.source.id),
                !inactive
            );
            assert!(execute(
                &replica,
                &account,
                vec![completion_mutation(
                    before.cross_account_moves[0].captured().unwrap(),
                    &delete_proof(&original)
                )]
            )
            .is_err());
            assert_eq!(replica.snapshot(&account).unwrap(), before);
        }
    }
}

#[test]
fn held_completion_later_plan_failure_leaves_the_original_hold_and_authority_unchanged() {
    let (replica, account, original) =
        completion_fixture(LegacyItemCommandStatus::Failed, true, false);
    let before = replica.snapshot(&account).unwrap();
    let mut invalid_overlay = original.source_overlay(&account);
    invalid_overlay.account_id = "different-account".into();
    assert!(execute(
        &replica,
        &account,
        vec![
            completion_mutation(
                before.cross_account_moves[0].captured().unwrap(),
                &delete_proof(&original)
            ),
            PlanMutation::PutOptimisticItem(invalid_overlay)
        ]
    )
    .is_err());
    assert_eq!(replica.snapshot(&account).unwrap(), before);
}

#[test]
fn held_completion_refuses_cold_missing_generation_and_malformed_item_key_before_cleanup() {
    let (replica, account, original) =
        completion_fixture(LegacyItemCommandStatus::Failed, true, true);
    for invalid in [
        "cold",
        "no-active-generation",
        "missing-generation-record",
        "wrong-item-key",
    ] {
        let mut snapshot = replica.snapshot(&account).unwrap();
        let generation = snapshot.bootstrap.active_generation.clone().unwrap();
        match invalid {
            "cold" => snapshot.bootstrap = BootstrapAuthority::default(),
            "no-active-generation" => snapshot.bootstrap.active_generation = None,
            "missing-generation-record" => {
                snapshot.bootstrap.generations.remove(&generation);
            }
            "wrong-item-key" => {
                snapshot
                    .bootstrap
                    .items
                    .get_mut(&(generation, original.source.id.clone()))
                    .unwrap()
                    .id = "other-item-under-source-key".into();
            }
            _ => unreachable!(),
        }
        let before = snapshot.clone();
        let mut state = AccountReplica::from_snapshot(snapshot);
        let result = state.reauthorize_and_complete_legacy_cross_account_move(
            &original.operation_id,
            1,
            "replacement-account".into(),
            "replacement-incarnation".into(),
            serde_json::from_value(full_completion_proofs(&original, &delete_proof(&original)))
                .unwrap(),
        );
        assert!(result.is_err(), "{invalid}");
        assert_eq!(
            state.snapshot(),
            before,
            "{invalid}: invalid cache must be refused before source cleanup"
        );
    }
}

#[test]
fn held_unmaterialized_completion_cannot_bypass_guarded_completion_with_ordinary_advance() {
    for retired in [false, true] {
        let (replica, account, original) =
            held_source_delete(LegacyItemCommandStatus::Failed, false);
        if retired {
            retire(&replica, &account);
        }
        let before = replica.snapshot(&account).unwrap();
        for completed in [false, true] {
            let mut next = before.cross_account_moves[0].captured().unwrap().clone();
            let mut child = next
                .legacy_item_child(CrossAccountMoveStep::SourceDelete)
                .unwrap()
                .unwrap();
            child.item_mut().unwrap().result = Some(delete_proof(&original));
            next.children.push(child);
            if completed {
                next.stage = CrossAccountMoveStage::Completed;
            }
            assert!(execute(
                &replica,
                &account,
                vec![PlanMutation::AdvanceCrossAccountMove {
                    operation_id: original.operation_id.clone(),
                    expected_binding_revision: before.cross_account_moves[0]
                        .captured()
                        .unwrap()
                        .destination_binding
                        .binding_revision,
                    next: Box::new(next),
                    source_authority: CrossAccountMoveSourceAuthority::Unchanged,
                }]
            )
            .is_err());
            assert_eq!(replica.snapshot(&account).unwrap(), before);
        }
    }
}

#[test]
fn held_unmaterialized_completion_requires_unchanged_exact_durable_prefix() {
    let (replica, account, original) =
        completion_fixture(LegacyItemCommandStatus::Conflicted, false, false);
    for invalid in [
        "missing-target-proof",
        "missing-trash-proof",
        "prefix-identity",
        "prefix-request",
        "prefix-target",
        "source-trash-stage",
    ] {
        let mut snapshot = replica.snapshot(&account).unwrap();
        let record = snapshot.cross_account_moves[0].captured_mut().unwrap();
        match invalid {
            "missing-target-proof" => record.children[0].item_mut().unwrap().result = None,
            "missing-trash-proof" => record.children[1].item_mut().unwrap().result = None,
            "prefix-identity" => record.children[1]
                .item_mut()
                .unwrap()
                .operation_id
                .push_str("-unrelated"),
            "prefix-request" => {
                record.children[1].item_mut().unwrap().request.body = b"replacement".to_vec()
            }
            "prefix-target" => {
                record.children[1].item_mut().unwrap().target = ResourceRef::Item {
                    item_id: "another-item".into(),
                    vault_id: original.source.vault_id.clone(),
                }
            }
            "source-trash-stage" => record.stage = CrossAccountMoveStage::SourceTrash,
            _ => unreachable!(),
        }
        let before = snapshot.clone();
        let mut state = AccountReplica::from_snapshot(snapshot);
        assert!(
            state
                .reauthorize_and_complete_legacy_cross_account_move(
                    &original.operation_id,
                    1,
                    "replacement-account".into(),
                    "replacement-incarnation".into(),
                    serde_json::from_value(full_completion_proofs(
                        &original,
                        &delete_proof(&original)
                    ))
                    .unwrap(),
                )
                .is_err(),
            "{invalid}"
        );
        assert_eq!(state.snapshot(), before, "{invalid}");
    }
}

#[path = "legacy_cross_account_full_completion_tests.rs"]
mod full_prefix_tests;
