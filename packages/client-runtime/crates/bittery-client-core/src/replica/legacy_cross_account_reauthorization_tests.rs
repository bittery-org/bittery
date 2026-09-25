//! Explicit destination confirmation changes authority without changing original accepted work.
use super::*;
use crate::replica::InMemoryReplica;
use serde_json::json;

fn held_replica(
    status: LegacyItemCommandStatus,
) -> (InMemoryReplica, AccountId, CrossAccountMoveRecord) {
    let (mut record, _) = super::tests::oracle_record();
    let admission = record.legacy_admission.as_mut().unwrap();
    admission.source_command.status = Some(status);
    admission.disposition = match status {
        LegacyItemCommandStatus::Failed => LegacyWorkflowDisposition::LegacyFailed,
        LegacyItemCommandStatus::Conflicted => LegacyWorkflowDisposition::LegacyConflicted,
        _ => unreachable!(),
    };
    admission.source_command.retry_count = 3;
    admission.source_command.next_attempt_at = Some(9000);
    admission.source_command.last_error = Some("captured failure".into());
    admission.source_command.conflict_copy_id = Some("independent-copy".into());
    admission.source_command.projection_claim_id = Some("departed-claim".into());
    admission.source_command.projection_claim_expires_at = Some(8000);
    record.scheduling = admission.initial_scheduling();
    let account = admission.source_command.account_id.clone();
    let replica = InMemoryReplica::default();
    replica
        .install(
            account.clone(),
            record.source_identity.user_id.clone(),
            "source-incarnation".into(),
        )
        .unwrap();
    replica
        .seed_ready_authority(
            &account,
            vec![crate::test_fixtures::personal_vault(
                &record.source.vault_id,
                &record.source_identity.user_id,
            )],
            vec![record.source.clone()],
        )
        .unwrap();
    execute(
        &replica,
        &account,
        vec![PlanMutation::AdmitCrossAccountMove {
            record: Box::new(record.clone()),
            source_overlay: None,
        }],
    )
    .unwrap();
    (replica, account, record)
}

fn execute(
    replica: &InMemoryReplica,
    account: &AccountId,
    mutations: Vec<PlanMutation>,
) -> Result<PlanResult, RuntimeError> {
    let snapshot = replica.snapshot(account).unwrap();
    replica.execute(GuardedCommitPlan::new(
        account.clone(),
        snapshot.incarnation,
        snapshot.revision,
        snapshot.lock_epoch,
        mutations,
    ))
}

fn retire(replica: &InMemoryReplica, account: &AccountId) {
    let record = replica
        .snapshot(account)
        .unwrap()
        .cross_account_moves
        .remove(0)
        .into_captured()
        .unwrap();
    execute(
        replica,
        account,
        vec![PlanMutation::RetireCrossAccountMoveDestination {
            operation_id: record.operation_id,
            expected_binding_revision: record.destination_binding.binding_revision,
            target_account_id: record.destination_binding.account_id,
            target_incarnation: record.destination_binding.incarnation,
        }],
    )
    .unwrap();
}

fn authorize(
    replica: &InMemoryReplica,
    account: &AccountId,
    destination: &str,
) -> Result<PlanResult, RuntimeError> {
    let record = replica
        .snapshot(account)
        .unwrap()
        .cross_account_moves
        .remove(0)
        .into_captured()
        .unwrap();
    execute(
        replica,
        account,
        vec![PlanMutation::ReauthorizeCrossAccountMoveDestination {
            operation_id: record.operation_id,
            expected_binding_revision: record.destination_binding.binding_revision,
            destination_account_id: destination.into(),
            destination_incarnation: format!("{destination}-incarnation").into(),
            verified_attachments: Vec::new(),
        }],
    )
}

#[test]
fn destination_authorization_atomically_restores_ownership_and_preserves_prior_hold_on_repeat() {
    for (status, prior_hold) in [
        (LegacyItemCommandStatus::Failed, "legacyFailed"),
        (LegacyItemCommandStatus::Conflicted, "legacyConflicted"),
    ] {
        let (replica, account, original) = held_replica(status);
        let original_source =
            serde_json::to_value(&original.legacy_admission.as_ref().unwrap().source_command)
                .unwrap();
        let expected_overlay = original.source_overlay(&account);
        for (revision, destination) in [(2, "replacement-account"), (4, "second-replacement")] {
            retire(&replica, &account);
            let retired = replica.snapshot(&account).unwrap();
            authorize(&replica, &account, destination).unwrap();
            let authorized = replica.snapshot(&account).unwrap();
            let record = authorized.cross_account_moves[0].captured().unwrap();
            assert_eq!(record.destination_binding.account_id.as_str(), destination);
            assert_eq!(record.destination_binding.binding_revision, revision);
            assert_eq!(
                record.destination_binding.status,
                CrossAccountMoveBindingStatus::Active
            );
            assert!(!record.is_legacy_held());
            assert!(record.owns_source_item());
            assert_eq!(record.disposition, CrossAccountMoveDisposition::Ready);
            assert_eq!(record.children, original.children);
            assert_eq!(record.source, original.source);
            assert_eq!(record.target, original.target);
            assert_eq!(record.scheduling, original.scheduling);
            assert_eq!(authorized.bootstrap, retired.bootstrap);
            assert_eq!(authorized.items, vec![expected_overlay.clone()]);
            assert!(authorized.item_has_optimistic_owner(&original.source.id));
            assert!(authorized.operations.is_empty());
            let evidence = serde_json::to_value(record.legacy_admission.as_ref().unwrap()).unwrap();
            assert_eq!(evidence["sourceCommand"], original_source);
            assert_eq!(
                evidence["disposition"],
                json!({"destinationReauthorized":{"priorHold":prior_hold, "bindingRevision":revision.to_string()}})
            );
            // The authorization plan has no permission to invent even the first child's proof.
            assert!(record.children[0].item().unwrap().result.is_none());
        }
    }
}

#[test]
fn destination_authorization_payload_is_closed_and_preserves_existing_unit_strings() {
    for existing in ["normal", "legacyFailed", "legacyConflicted"] {
        let parsed: LegacyWorkflowDisposition = serde_json::from_value(json!(existing)).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), json!(existing));
    }
    for prior in ["legacyFailed", "legacyConflicted"] {
        let value = json!({"destinationReauthorized":{"priorHold":prior,"bindingRevision":"2"}});
        let parsed: LegacyWorkflowDisposition = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }
}
#[test]
fn destination_authorization_rejects_malformed_payloads_and_impossible_binding_history() {
    for malformed in [
        r#""destinationReauthorized""#,
        r#"{"destinationReauthorized":[]}"#,
        r#"{"destinationReauthorized":{"priorHold":"normal","bindingRevision":"2"}}"#,
        r#"{"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":2}}"#,
        r#"{"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"02"}}"#,
        r#"{"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"-1"}}"#,
        r#"{"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"18446744073709551616"}}"#,
        r#"{"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"2","unexpected":null}}"#,
        r#"{"destinationReauthorized":{"priorHold":"legacyFailed","priorHold":"legacyFailed","bindingRevision":"2"}}"#,
        r#"{"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"2","bindingRevision":"2"}}"#,
        r#"{"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"2"},"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"2"}}"#,
        r#"{"destinationReauthorized":{"priorHold":"legacyFailed"}}"#,
    ] {
        assert!(
            serde_json::from_str::<LegacyWorkflowDisposition>(malformed).is_err(),
            "{malformed}"
        );
    }
    let (replica, account, _) = held_replica(LegacyItemCommandStatus::Failed);
    retire(&replica, &account);
    authorize(&replica, &account, "replacement-account").unwrap();
    let record = replica
        .snapshot(&account)
        .unwrap()
        .cross_account_moves
        .remove(0)
        .into_captured()
        .unwrap();
    let valid = serde_json::to_value(&record).unwrap();
    for mutation in [
        "status",
        "prior",
        "zero",
        "unreachable-one",
        "active-mismatch",
        "retired-same",
        "retired-earlier",
    ] {
        let mut value = valid.clone();
        match mutation {
            "status" => value["legacyAdmission"]["sourceCommand"]["status"] = json!("pending"),
            "prior" => {
                value["legacyAdmission"]["disposition"]["destinationReauthorized"]["priorHold"] =
                    json!("legacyConflicted")
            }
            "zero" | "unreachable-one" => {
                let revision = if mutation == "zero" { "0" } else { "1" };
                value["legacyAdmission"]["disposition"]["destinationReauthorized"]
                    ["bindingRevision"] = json!(revision);
                value["destinationBinding"]["bindingRevision"] = json!(revision);
            }
            "active-mismatch" => value["destinationBinding"]["bindingRevision"] = json!("3"),
            "retired-same" | "retired-earlier" => {
                value["destinationBinding"]["status"] = json!("retired");
                value["destinationBinding"]["bindingRevision"] =
                    json!(if mutation == "retired-same" { "2" } else { "1" });
                value["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
            }
            _ => unreachable!(),
        }
        let changed: CrossAccountMoveRecord = serde_json::from_value(value).unwrap();
        assert!(
            changed
                .validate(&account, &record.source_identity.user_id)
                .is_err(),
            "{mutation}"
        );
    }
    let mut forged_retired = held_replica(LegacyItemCommandStatus::Failed).2;
    forged_retired.destination_binding.status = CrossAccountMoveBindingStatus::Retired;
    forged_retired.disposition = CrossAccountMoveDisposition::Blocked {
        reason: CrossAccountMoveBlockedReason::DestinationRetired,
    };
    // A typed imported record cannot make a never-retired binding eligible for authorization.
    let mut snapshot = replica.snapshot(&account).unwrap();
    snapshot.cross_account_moves = vec![forged_retired.into()];
    snapshot.items.clear();
    let mut state = AccountReplica::from_snapshot(snapshot);
    let before = state.snapshot();
    assert!(state
        .reauthorize_cross_account_move_destination(
            &before.cross_account_moves[0]
                .captured()
                .unwrap()
                .operation_id,
            0,
            "replacement-account".into(),
            "replacement-incarnation".into(),
            Vec::new(),
        )
        .is_err());
    assert_eq!(state.snapshot(), before);
}

#[test]
fn destination_authorization_cannot_enter_through_initial_bind_or_ordinary_advance() {
    let (replica, account, original) = held_replica(LegacyItemCommandStatus::Failed);
    let mut forged = original.legacy_admission.as_ref().unwrap().as_ref().clone();
    forged.disposition =
        LegacyWorkflowDisposition::DestinationReauthorized(LegacyWorkflowAuthorization {
            prior_hold: LegacyWorkflowPriorHold::LegacyFailed,
            binding_revision: 2,
        });
    assert!(forged
        .bind(
            original.source_identity.clone(),
            original.destination_identity.clone(),
            original.destination_binding.clone(),
            original.source.clone(),
            original.target.clone()
        )
        .is_err());
    let mut next = original.clone();
    next.legacy_admission.as_mut().unwrap().disposition =
        LegacyWorkflowDisposition::DestinationReauthorized(LegacyWorkflowAuthorization {
            prior_hold: LegacyWorkflowPriorHold::LegacyFailed,
            binding_revision: 2,
        });
    next.destination_binding.binding_revision = 2;
    let before = replica.snapshot(&account).unwrap();
    assert!(execute(
        &replica,
        &account,
        vec![PlanMutation::AdvanceCrossAccountMove {
            operation_id: original.operation_id.clone(),
            expected_binding_revision: 0,
            next: Box::new(next),
            source_authority: CrossAccountMoveSourceAuthority::Unchanged,
        }]
    )
    .is_err());
    assert_eq!(replica.snapshot(&account).unwrap(), before);
    retire(&replica, &account);
    authorize(&replica, &account, "replacement-account").unwrap();
    let before = replica.snapshot(&account).unwrap();
    let mut next = before.cross_account_moves[0].captured().unwrap().clone();
    let admission = next.legacy_admission.as_mut().unwrap();
    admission.source_command.status = Some(LegacyItemCommandStatus::Conflicted);
    admission.disposition =
        LegacyWorkflowDisposition::DestinationReauthorized(LegacyWorkflowAuthorization {
            prior_hold: LegacyWorkflowPriorHold::LegacyConflicted,
            binding_revision: 2,
        });
    next.validate(&account, &next.source_identity.user_id)
        .unwrap();
    assert!(execute(
        &replica,
        &account,
        vec![PlanMutation::AdvanceCrossAccountMove {
            operation_id: original.operation_id,
            expected_binding_revision: 2,
            next: Box::new(next),
            source_authority: CrossAccountMoveSourceAuthority::Unchanged,
        }]
    )
    .is_err());
    assert_eq!(replica.snapshot(&account).unwrap(), before);
}

fn same_item_create(
    original: &CrossAccountMoveRecord,
    held_failure: bool,
) -> (OperationRecord, ReplicaItemRecord) {
    let account = original
        .legacy_admission
        .as_ref()
        .unwrap()
        .source_command
        .account_id
        .clone();
    let category = original
        .legacy_admission
        .as_ref()
        .unwrap()
        .source_command
        .category
        .unwrap();
    let operation_id = "independent-source-evidence";
    let mut operation = crate::test_fixtures::test_operation(operation_id, &original.source.id);
    operation.target = ResourceRef::Item {
        item_id: original.source.id.clone(),
        vault_id: original.source.vault_id.clone(),
    };
    operation.request.path = format!(
        "/api/v1/vaults/{}/items/{}",
        encode_component(&original.source.vault_id),
        encode_component(&original.source.id)
    );
    operation.request.body = format!(r#"{{"category":{},"encryptedData":"independent-ciphertext","encryptionIv":"independent-iv","encryptionAlgorithm":"AES-GCM-AAD-V1"}}"#, serde_json::to_string(&category).unwrap()).into_bytes();
    operation.request_fingerprint = create_item_fingerprint(
        &original.source.vault_id,
        &original.source.id,
        &operation.request.body,
    );
    operation.accepted_item_category = Some(original.source.category.clone());
    let mut evidence: LegacyOperationAdmission = serde_json::from_value(json!({
        "version":1, "admissionId":"independent-admission", "sourceQueueIndex":"1",
        "sourceCommand":{
            "accountId":account, "id":operation_id, "type":"create", "entityId":original.source.id,
            "vaultId":original.source.vault_id, "category":category,
            "encryptedPayload":{"encryptionVersion":1, "encryptedByUserId":original.source_identity.user_id},
            "baseVersion":0, "timestamp":"0", "retryCount":"0", "status":"pending"
        }, "disposition":"normal"
    })).unwrap();
    if held_failure {
        evidence.disposition = LegacyOperationDisposition::LegacyFailed;
        evidence.source_command.status = Some(LegacyItemCommandStatus::Failed);
        evidence.captured_failure_code = Some(LegacyCreateFailureCode::ItemIdConflict);
    }
    let overlay = evidence.create_overlay(&operation).unwrap();
    operation.legacy_admission = Some(Box::new(evidence));
    (operation, overlay)
}

#[test]
fn destination_authorization_never_overwrites_active_or_inactive_independent_evidence() {
    for held_failure in [false, true] {
        let (replica, account, original) = held_replica(LegacyItemCommandStatus::Failed);
        let (operation, overlay) = same_item_create(&original, held_failure);
        execute(
            &replica,
            &account,
            vec![
                PlanMutation::AcceptOperation(operation),
                PlanMutation::PutOptimisticItem(overlay),
            ],
        )
        .unwrap();
        retire(&replica, &account);
        let before = replica.snapshot(&account).unwrap();
        assert_eq!(
            before.item_has_optimistic_owner(&original.source.id),
            !held_failure
        );
        assert!(before.cross_account_move_has_conflicting_source_owner(
            before.cross_account_moves[0].captured().unwrap()
        ));
        assert!(authorize(&replica, &account, "replacement-account").is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), before);
    }
}

#[test]
fn destination_authorization_keeps_original_hold_stage_limits_and_authorized_normal_stage_rules() {
    for previously_authorized in [false, true] {
        for rejected in [false, true] {
            let (replica, account, original) = held_replica(LegacyItemCommandStatus::Failed);
            if previously_authorized {
                retire(&replica, &account);
                authorize(&replica, &account, "first-replacement").unwrap();
            }
            let mut next = replica
                .snapshot(&account)
                .unwrap()
                .cross_account_moves
                .remove(0)
                .into_captured()
                .unwrap();
            let expected_binding_revision = next.destination_binding.binding_revision;
            let child = next.children[0].item_mut().unwrap();
            child.result = Some(ObservedOutcome {
                operation_id: child.operation_id.clone(),
                request_fingerprint: child.request_fingerprint,
                result: if rejected {
                    OperationOutcomeResult::Rejected {
                        code: OperationRejectionCode::ItemIdConflict,
                    }
                } else {
                    OperationOutcomeResult::Applied {
                        entity_id: original.target.id.clone(),
                        version: 1,
                    }
                },
            });
            next.stage = if rejected {
                CrossAccountMoveStage::Rejected
            } else {
                CrossAccountMoveStage::SourceTrash
            };
            next.disposition = if rejected {
                CrossAccountMoveDisposition::Rejected {
                    code: OperationRejectionCode::ItemIdConflict,
                }
            } else {
                CrossAccountMoveDisposition::Ready
            };
            execute(
                &replica,
                &account,
                vec![PlanMutation::AdvanceCrossAccountMove {
                    operation_id: original.operation_id,
                    expected_binding_revision,
                    next: Box::new(next),
                    source_authority: CrossAccountMoveSourceAuthority::Unchanged,
                }],
            )
            .unwrap();
            if !previously_authorized && !rejected {
                let mut next = replica
                    .snapshot(&account)
                    .unwrap()
                    .cross_account_moves
                    .remove(0)
                    .into_captured()
                    .unwrap();
                next.children.push(
                    next.legacy_item_child(CrossAccountMoveStep::SourceTrash)
                        .unwrap()
                        .unwrap(),
                );
                advance_record(&replica, &account, next.clone());
                let child = next.children[1].item_mut().unwrap();
                child.result = Some(ObservedOutcome {
                    operation_id: child.operation_id.clone(),
                    request_fingerprint: child.request_fingerprint,
                    result: OperationOutcomeResult::Applied {
                        entity_id: original.source.id.clone(),
                        version: original.source.version + 1,
                    },
                });
                advance_record(&replica, &account, next);
            }
            retire(&replica, &account);
            let before = replica.snapshot(&account).unwrap();
            if previously_authorized && !rejected {
                authorize(&replica, &account, "second-replacement").unwrap();
                let after = replica.snapshot(&account).unwrap();
                assert_eq!(after.items, before.items);
                assert_eq!(after.bootstrap, before.bootstrap);
                assert_eq!(
                    after.cross_account_moves[0].captured().unwrap().stage,
                    CrossAccountMoveStage::SourceTrash
                );
                assert_eq!(
                    after.cross_account_moves[0].captured().unwrap().children,
                    before.cross_account_moves[0].captured().unwrap().children
                );
                assert_eq!(
                    after.cross_account_moves[0]
                        .captured()
                        .unwrap()
                        .legacy_admission
                        .as_ref()
                        .unwrap()
                        .disposition,
                    LegacyWorkflowDisposition::DestinationReauthorized(
                        LegacyWorkflowAuthorization {
                            prior_hold: LegacyWorkflowPriorHold::LegacyFailed,
                            binding_revision: 4,
                        }
                    )
                );
            } else {
                assert!(authorize(&replica, &account, "replacement-account").is_err());
                assert_eq!(replica.snapshot(&account).unwrap(), before);
            }
        }
    }
}

fn advance_record(replica: &InMemoryReplica, account: &AccountId, next: CrossAccountMoveRecord) {
    execute(
        replica,
        account,
        vec![PlanMutation::AdvanceCrossAccountMove {
            operation_id: next.operation_id.clone(),
            expected_binding_revision: next.destination_binding.binding_revision,
            next: Box::new(next),
            source_authority: CrossAccountMoveSourceAuthority::Unchanged,
        }],
    )
    .unwrap();
}

#[test]
fn held_sourcetrash_destination_authorization_preserves_proved_prefix_and_undecided_child() {
    for status in [
        LegacyItemCommandStatus::Failed,
        LegacyItemCommandStatus::Conflicted,
    ] {
        for materialized in [false, true] {
            let (replica, account, original) = held_replica(status);
            let mut next = original.clone();
            let child = next.children[0].item_mut().unwrap();
            child.result = Some(ObservedOutcome {
                operation_id: child.operation_id.clone(),
                request_fingerprint: child.request_fingerprint,
                result: OperationOutcomeResult::Applied {
                    entity_id: original.target.id.clone(),
                    version: 1,
                },
            });
            next.stage = CrossAccountMoveStage::SourceTrash;
            advance_record(&replica, &account, next.clone());
            if materialized {
                next.children.push(
                    next.legacy_item_child(CrossAccountMoveStep::SourceTrash)
                        .unwrap()
                        .unwrap(),
                );
                advance_record(&replica, &account, next);
            }
            retire(&replica, &account);
            let before = replica.snapshot(&account).unwrap();
            assert!(before.items.is_empty());
            authorize(&replica, &account, "replacement-account").unwrap();
            let after = replica.snapshot(&account).unwrap();
            let authorized = after.cross_account_moves[0].captured().unwrap();
            assert!(!authorized.is_legacy_held());
            assert_eq!(authorized.stage, CrossAccountMoveStage::SourceTrash);
            assert_eq!(
                authorized.children,
                before.cross_account_moves[0].captured().unwrap().children
            );
            assert_eq!(authorized.children.len(), if materialized { 2 } else { 1 });
            assert_eq!(authorized.scheduling, original.scheduling);
            assert_eq!(authorized.source, original.source);
            assert_eq!(authorized.target, original.target);
            assert_eq!(
                authorized.legacy_admission.as_ref().unwrap().source_command,
                original.legacy_admission.as_ref().unwrap().source_command
            );
            assert_eq!(
                authorized.legacy_admission.as_ref().unwrap().disposition,
                LegacyWorkflowDisposition::DestinationReauthorized(LegacyWorkflowAuthorization {
                    prior_hold: original
                        .legacy_admission
                        .as_ref()
                        .unwrap()
                        .disposition
                        .prior_hold()
                        .unwrap(),
                    binding_revision: 2,
                })
            );
            assert_eq!(after.bootstrap, before.bootstrap);
            assert_eq!(after.operations, before.operations);
            assert_eq!(after.items, vec![authorized.source_overlay(&account)]);
        }
    }
}

fn held_source_delete(
    status: LegacyItemCommandStatus,
    materialized: bool,
) -> (InMemoryReplica, AccountId, CrossAccountMoveRecord) {
    let (replica, account, original) = held_replica(status);
    let mut next = original.clone();
    let target = next.children[0].item_mut().unwrap();
    target.result = Some(ObservedOutcome {
        operation_id: target.operation_id.clone(),
        request_fingerprint: target.request_fingerprint,
        result: OperationOutcomeResult::Applied {
            entity_id: original.target.id.clone(),
            version: 1,
        },
    });
    next.stage = CrossAccountMoveStage::SourceTrash;
    advance_record(&replica, &account, next.clone());
    next.children.push(
        next.legacy_item_child(CrossAccountMoveStep::SourceTrash)
            .unwrap()
            .unwrap(),
    );
    advance_record(&replica, &account, next.clone());
    let trash = next.children[1].item_mut().unwrap();
    trash.result = Some(ObservedOutcome {
        operation_id: trash.operation_id.clone(),
        request_fingerprint: trash.request_fingerprint,
        result: OperationOutcomeResult::Applied {
            entity_id: original.source.id.clone(),
            version: original.source.version + 1,
        },
    });
    next.stage = CrossAccountMoveStage::SourceDelete;
    advance_record(&replica, &account, next.clone());
    if materialized {
        next.children.push(
            next.legacy_item_child(CrossAccountMoveStep::SourceDelete)
                .unwrap()
                .unwrap(),
        );
        advance_record(&replica, &account, next);
    }
    (replica, account, original)
}

#[test]
fn held_sourcedelete_destination_authorization_preserves_proved_prefix_and_undecided_child() {
    for status in [
        LegacyItemCommandStatus::Failed,
        LegacyItemCommandStatus::Conflicted,
    ] {
        for materialized in [false, true] {
            let (replica, account, original) = held_source_delete(status, materialized);
            retire(&replica, &account);
            let before = replica.snapshot(&account).unwrap();
            assert!(before.items.is_empty());
            let mut expected = before.cross_account_moves[0].captured().unwrap().clone();
            assert_eq!(expected.children.len(), if materialized { 3 } else { 2 });
            if materialized {
                assert!(expected.children[2].item().unwrap().result.is_none());
            }
            expected.destination_binding.account_id = "replacement-account".into();
            expected.destination_binding.incarnation = "replacement-account-incarnation".into();
            expected.destination_binding.binding_revision = 2;
            expected.destination_binding.status = CrossAccountMoveBindingStatus::Active;
            expected.disposition = CrossAccountMoveDisposition::Ready;
            expected.legacy_admission.as_mut().unwrap().disposition =
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
            authorize(&replica, &account, "replacement-account").unwrap();
            let after = replica.snapshot(&account).unwrap();
            assert_eq!(
                after.cross_account_moves,
                vec![CrossAccountMoveEntry::from(expected.clone())]
            );
            assert_eq!(after.bootstrap, before.bootstrap);
            assert_eq!(after.operations, before.operations);
            assert_eq!(after.items, vec![expected.source_overlay(&account)]);
            assert!(after.items[0].deleted_at.is_none());
            assert_eq!(after.items[0].version, original.source.version);
        }
    }
}

#[test]
fn held_sourcedelete_continuation_refuses_progressed_or_absent_active_source_cache() {
    for status in [
        LegacyItemCommandStatus::Failed,
        LegacyItemCommandStatus::Conflicted,
    ] {
        for cache in ["trashed", "newer", "absent"] {
            let (replica, account, original) = held_source_delete(status, true);
            retire(&replica, &account);

            let mut progressed = original.source.clone();
            let items = match cache {
                "trashed" => {
                    progressed.version += 1;
                    progressed.deleted_at = Some("2026-01-01T00:00:00Z".into());
                    vec![progressed]
                }
                "newer" => {
                    progressed.version += 5;
                    progressed.favorite = !progressed.favorite;
                    progressed.encrypted_data = "newer-unrelated-authority-ciphertext".into();
                    vec![progressed]
                }
                "absent" => Vec::new(),
                _ => unreachable!(),
            };
            replica
                .seed_ready_authority(
                    &account,
                    vec![crate::test_fixtures::personal_vault(
                        &original.source.vault_id,
                        &original.source_identity.user_id,
                    )],
                    items,
                )
                .unwrap();

            let before = replica.snapshot(&account).unwrap();
            let held = before.cross_account_moves[0].captured().unwrap();
            assert!(held.is_legacy_held());
            assert!(held.supports_legacy_held_destination_reauthorization());
            let authority = before.bootstrap.snapshot();
            let current = authority
                .visible_items
                .iter()
                .find(|item| item.id == original.source.id);
            match cache {
                "trashed" => assert!(current.is_some_and(|item| item.deleted_at.is_some())),
                "newer" => {
                    assert!(current.is_some_and(|item| item.version > original.source.version))
                }
                "absent" => assert!(current.is_none()),
                _ => unreachable!(),
            }

            assert!(authorize(&replica, &account, "replacement-account").is_err());
            assert_eq!(
                replica.snapshot(&account).unwrap(),
                before,
                "{cache} active authority cannot activate a held continuation"
            );
        }
    }
}

#[test]
fn held_sourcedelete_destination_authorization_refuses_retained_delete_results() {
    for status in [
        LegacyItemCommandStatus::Failed,
        LegacyItemCommandStatus::Conflicted,
    ] {
        for rejected in [false, true] {
            let (replica, account, original) = held_source_delete(status, true);
            let mut next = replica
                .snapshot(&account)
                .unwrap()
                .cross_account_moves
                .remove(0)
                .into_captured()
                .unwrap();
            let delete = next.children[2].item_mut().unwrap();
            delete.result = Some(ObservedOutcome {
                operation_id: delete.operation_id.clone(),
                request_fingerprint: delete.request_fingerprint,
                result: if rejected {
                    OperationOutcomeResult::Rejected {
                        code: OperationRejectionCode::VaultReadOnly,
                    }
                } else {
                    OperationOutcomeResult::Applied {
                        entity_id: original.source.id.clone(),
                        version: original.source.version + 2,
                    }
                },
            });
            if rejected {
                next.stage = CrossAccountMoveStage::Rejected;
                next.disposition = CrossAccountMoveDisposition::Rejected {
                    code: OperationRejectionCode::VaultReadOnly,
                };
            }
            advance_record(&replica, &account, next);
            retire(&replica, &account);
            let before = replica.snapshot(&account).unwrap();
            assert!(authorize(&replica, &account, "replacement-account").is_err());
            assert_eq!(replica.snapshot(&account).unwrap(), before);
        }
    }
}

#[path = "legacy_cross_account_completion_tests.rs"]
mod completion_tests;

#[path = "legacy_cross_account_trashed_cache_tests.rs"]
mod trashed_cache_tests;

#[path = "legacy_cross_account_missing_source_tests.rs"]
mod missing_source_tests;
