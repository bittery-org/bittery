//! A witnessed current trashed source can stay authoritative while its Move resumes without an overlay.
use super::*;
use crate::replica::persistence_contract::{prepare_commit, PreparedReplicaWrite, ReplicaStore};

fn trashed_cache_fixture(
    status: LegacyItemCommandStatus,
    materialized: bool,
) -> (
    InMemoryReplica,
    AccountId,
    CrossAccountMoveRecord,
    AuthorityItemRecord,
) {
    let (replica, account, original) = held_source_delete(status, materialized);
    let mut current = original.source.clone();
    current.version += 1;
    current.deleted_at = Some("2026-01-01T00:00:00Z".into());
    current.updated_at = "2026-01-01T00:00:00Z".into();
    install_current(&replica, &account, &original, Some(current.clone()));
    retire(&replica, &account);
    (replica, account, original, current)
}

fn install_current(
    replica: &InMemoryReplica,
    account: &AccountId,
    original: &CrossAccountMoveRecord,
    current: Option<AuthorityItemRecord>,
) {
    replica
        .seed_ready_authority(
            account,
            vec![crate::test_fixtures::personal_vault(
                &original.source.vault_id,
                &original.source_identity.user_id,
            )],
            current.into_iter().collect(),
        )
        .unwrap();
}

fn trashed_cache_mutation(
    record: &CrossAccountMoveRecord,
    current: &AuthorityItemRecord,
) -> PlanMutation {
    serde_json::from_value(json!({"type":"reauthorizeLegacyCrossAccountMoveFromTrashedCache",
        "operationId":record.operation_id,
        "expectedBindingRevision":record.destination_binding.binding_revision.to_string(),
        "destinationAccountId":"replacement-account", "destinationIncarnation":"replacement-incarnation",
        "verifiedSource":current})).expect("the guarded domain must support witnessed trashed-cache continuation")
}

#[test]
fn held_trashed_cache_authorization_preserves_authority_and_reserves_source_without_overlay() {
    for status in [
        LegacyItemCommandStatus::Failed,
        LegacyItemCommandStatus::Conflicted,
    ] {
        for materialized in [false, true] {
            let (replica, account, original, current) = trashed_cache_fixture(status, materialized);
            let before = replica.snapshot(&account).unwrap();
            let mutation =
                trashed_cache_mutation(before.cross_account_moves[0].captured().unwrap(), &current);
            let prepared = prepare_commit(
                before.clone(),
                GuardedCommitPlan::new(
                    account.clone(),
                    before.incarnation.clone(),
                    before.revision,
                    before.lock_epoch,
                    vec![mutation.clone()],
                ),
            )
            .unwrap();
            assert_eq!(prepared.wire.writes.len(), 1);
            assert!(
                matches!(&prepared.wire.writes[0], PreparedReplicaWrite::Put {row} if row.store == ReplicaStore::CrossAccountMoves)
            );
            execute(&replica, &account, vec![mutation]).unwrap();
            let after = replica.snapshot(&account).unwrap();
            let mut expected = before.clone();
            expected.revision += 1;
            let record = expected.cross_account_moves[0].captured_mut().unwrap();
            record.destination_binding.account_id = "replacement-account".into();
            record.destination_binding.incarnation = "replacement-incarnation".into();
            record.destination_binding.binding_revision = 2;
            record.destination_binding.status = CrossAccountMoveBindingStatus::Active;
            record.legacy_admission.as_mut().unwrap().disposition =
                LegacyWorkflowDisposition::DestinationReauthorized(LegacyWorkflowAuthorization {
                    prior_hold: original
                        .legacy_admission
                        .as_ref()
                        .unwrap()
                        .disposition
                        .prior_hold()
                        .unwrap(),
                    binding_revision: 2,
                });
            record.disposition = CrossAccountMoveDisposition::Ready;
            assert_eq!(after, expected);
            assert_eq!(after, prepared.next_snapshot);
            assert!(after.items.is_empty());
            assert!(after.item_has_optimistic_owner(&original.source.id));
            assert!(after.cross_account_moves[0]
                .captured()
                .unwrap()
                .owns_source_item());
            retire(&replica, &account);
            let retired = replica.snapshot(&account).unwrap();
            assert!(retired.item_has_optimistic_owner(&original.source.id));
            assert!(retired.items.is_empty());
            authorize(&replica, &account, "second-replacement").unwrap();
            let repeated = replica.snapshot(&account).unwrap();
            assert!(repeated.items.is_empty());
            assert_eq!(repeated.bootstrap, before.bootstrap);
            assert_eq!(
                repeated.cross_account_moves[0].captured().unwrap().children,
                before.cross_account_moves[0].captured().unwrap().children
            );
            assert_eq!(
                repeated.cross_account_moves[0]
                    .captured()
                    .unwrap()
                    .destination_binding
                    .binding_revision,
                4
            );
        }
    }
}

#[test]
fn held_trashed_cache_requires_full_current_dto_and_precise_original_progression() {
    for mismatch in ["audit-only", "newer", "live", "ciphertext", "favorite"] {
        let (replica, account, original, mut current) =
            trashed_cache_fixture(LegacyItemCommandStatus::Failed, true);
        match mismatch {
            // Only an audit field changes: the existing progression comparison deliberately ignores it.
            "audit-only" => current.updated_at = "2026-01-02T00:00:00Z".into(),
            "newer" => current.version += 1,
            "live" => current.deleted_at = None,
            "ciphertext" => current.encrypted_data = "changed-source-ciphertext".into(),
            "favorite" => current.favorite = !current.favorite,
            _ => unreachable!(),
        }
        if mismatch != "audit-only" {
            // Exact cache/witness equality alone cannot authorize changed accepted content.
            install_current(&replica, &account, &original, Some(current.clone()));
        }
        let before = replica.snapshot(&account).unwrap();
        assert!(
            execute(
                &replica,
                &account,
                vec![trashed_cache_mutation(
                    before.cross_account_moves[0].captured().unwrap(),
                    &current
                )]
            )
            .is_err(),
            "{mismatch}"
        );
        assert_eq!(replica.snapshot(&account).unwrap(), before);
    }
}

#[test]
fn held_trashed_cache_refuses_invalid_stage_result_cache_and_generation() {
    let (replica, account, original, current) =
        trashed_cache_fixture(LegacyItemCommandStatus::Conflicted, true);
    for invalid in [
        "cold",
        "missing-cache",
        "missing-generation",
        "wrong-key",
        "source-trash",
        "delete-applied",
        "delete-rejected",
    ] {
        let mut snapshot = replica.snapshot(&account).unwrap();
        let generation = snapshot.bootstrap.active_generation.clone().unwrap();
        let record = snapshot.cross_account_moves[0].captured_mut().unwrap();
        match invalid {
            "cold" => snapshot.bootstrap = BootstrapAuthority::default(),
            "missing-cache" => {
                snapshot
                    .bootstrap
                    .items
                    .remove(&(generation, original.source.id.clone()));
            }
            "missing-generation" => {
                snapshot.bootstrap.generations.remove(&generation);
            }
            "wrong-key" => {
                snapshot
                    .bootstrap
                    .items
                    .get_mut(&(generation, original.source.id.clone()))
                    .unwrap()
                    .id = "other-source-under-key".into();
            }
            "source-trash" => {
                record.stage = CrossAccountMoveStage::SourceTrash;
                record.children.pop();
            }
            "delete-applied" | "delete-rejected" => {
                let child = record.children[2].item_mut().unwrap();
                child.result = Some(ObservedOutcome {
                    operation_id: child.operation_id.clone(),
                    request_fingerprint: child.request_fingerprint,
                    result: if invalid == "delete-applied" {
                        OperationOutcomeResult::Applied {
                            entity_id: original.source.id.clone(),
                            version: original.source.version + 2,
                        }
                    } else {
                        OperationOutcomeResult::Rejected {
                            code: OperationRejectionCode::VaultReadOnly,
                        }
                    },
                });
                if invalid == "delete-rejected" {
                    record.stage = CrossAccountMoveStage::Rejected;
                    record.disposition = CrossAccountMoveDisposition::Rejected {
                        code: OperationRejectionCode::VaultReadOnly,
                    };
                }
            }
            _ => unreachable!(),
        }
        let mutation = trashed_cache_mutation(
            snapshot.cross_account_moves[0].captured().unwrap(),
            &current,
        );
        let before = snapshot.clone();
        let mut state = AccountReplica::from_snapshot(snapshot);
        assert!(state.apply(mutation).is_err(), "{invalid}");
        assert_eq!(state.snapshot(), before, "{invalid}");
    }
}

#[test]
fn held_trashed_cache_refuses_independent_active_and_inactive_owners() {
    for inactive in [false, true] {
        let (replica, account, original, current) =
            trashed_cache_fixture(LegacyItemCommandStatus::Failed, false);
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
            vec![trashed_cache_mutation(
                before.cross_account_moves[0].captured().unwrap(),
                &current
            )]
        )
        .is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), before);
    }
}

#[test]
fn held_trashed_cache_cannot_bypass_witness_through_ordinary_continue_or_advance() {
    let (replica, account, _, current) =
        trashed_cache_fixture(LegacyItemCommandStatus::Failed, true);
    let before = replica.snapshot(&account).unwrap();
    assert!(authorize(&replica, &account, "replacement-account").is_err());
    assert_eq!(replica.snapshot(&account).unwrap(), before);
    let mut next = before.cross_account_moves[0].captured().unwrap().clone();
    next.destination_binding.account_id = "replacement-account".into();
    next.destination_binding.incarnation = "replacement-incarnation".into();
    next.destination_binding.binding_revision = 2;
    next.destination_binding.status = CrossAccountMoveBindingStatus::Active;
    next.legacy_admission.as_mut().unwrap().disposition =
        LegacyWorkflowDisposition::DestinationReauthorized(LegacyWorkflowAuthorization {
            prior_hold: LegacyWorkflowPriorHold::LegacyFailed,
            binding_revision: 2,
        });
    next.disposition = CrossAccountMoveDisposition::Ready;
    assert!(execute(
        &replica,
        &account,
        vec![PlanMutation::AdvanceCrossAccountMove {
            operation_id: next.operation_id.clone(),
            expected_binding_revision: 1,
            next: Box::new(next),
            source_authority: CrossAccountMoveSourceAuthority::Unchanged,
        }]
    )
    .is_err());
    assert_eq!(replica.snapshot(&account).unwrap(), before);
    execute(
        &replica,
        &account,
        vec![trashed_cache_mutation(
            before.cross_account_moves[0].captured().unwrap(),
            &current,
        )],
    )
    .unwrap();
    let authorized = replica.snapshot(&account).unwrap();
    // The dedicated first-authorization mode cannot be reused to authorize an ordinary active row.
    assert!(execute(
        &replica,
        &account,
        vec![trashed_cache_mutation(
            authorized.cross_account_moves[0].captured().unwrap(),
            &current
        )]
    )
    .is_err());
    assert_eq!(replica.snapshot(&account).unwrap(), authorized);
}
