//! Full original remote proof completes any sealed earlier held Item prefix atomically.
use super::*;

fn earlier_prefix(
    status: LegacyItemCommandStatus,
    shape: &str,
) -> (InMemoryReplica, AccountId, CrossAccountMoveRecord) {
    let (replica, account, original) = held_replica(status);
    if shape != "target-create" {
        let mut next = original.clone();
        next.children[0].item_mut().unwrap().result = Some(
            serde_json::from_value(
                full_completion_proofs(&original, &delete_proof(&original))["targetCreate"].clone(),
            )
            .unwrap(),
        );
        next.stage = CrossAccountMoveStage::SourceTrash;
        advance_record(&replica, &account, next.clone());
        if shape == "source-trash-materialized" {
            next.children.push(
                next.legacy_item_child(CrossAccountMoveStep::SourceTrash)
                    .unwrap()
                    .unwrap(),
            );
            advance_record(&replica, &account, next);
        }
    }
    retire(&replica, &account);
    (replica, account, original)
}

#[test]
fn held_full_completion_authorizes_earlier_prefixes_in_one_final_write() {
    for status in [
        LegacyItemCommandStatus::Failed,
        LegacyItemCommandStatus::Conflicted,
    ] {
        for shape in [
            "target-create",
            "source-trash-unmaterialized",
            "source-trash-materialized",
        ] {
            let (replica, account, original) = earlier_prefix(status, shape);
            let before = replica.snapshot(&account).unwrap();
            let proof = full_completion_proofs(&original, &delete_proof(&original));
            let mutation = completion_mutation(
                before.cross_account_moves[0].captured().unwrap(),
                &delete_proof(&original),
            );
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
            execute(&replica, &account, vec![mutation]).unwrap();
            let after = replica.snapshot(&account).unwrap();
            assert_eq!(after, prepared.next_snapshot);
            let mut expected = before.clone();
            expected.revision += 1;
            let record = expected.cross_account_moves[0].captured_mut().unwrap();
            record.children = [
                CrossAccountMoveStep::TargetCreate,
                CrossAccountMoveStep::SourceTrash,
                CrossAccountMoveStep::SourceDelete,
            ]
            .into_iter()
            .zip(["targetCreate", "sourceTrash", "sourceDelete"])
            .map(|(step, key)| {
                let mut child = original.legacy_item_child(step).unwrap().unwrap();
                child.item_mut().unwrap().result =
                    Some(serde_json::from_value(proof[key].clone()).unwrap());
                child
            })
            .collect();
            record.stage = CrossAccountMoveStage::Completed;
            record.disposition = CrossAccountMoveDisposition::Ready;
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
            let generation = expected.bootstrap.active_generation.clone().unwrap();
            expected
                .bootstrap
                .items
                .remove(&(generation, original.source.id.clone()));
            assert_eq!(after, expected, "{shape}");
            assert!(prepared.wire.writes.iter().all(|write| !matches!(write, PreparedReplicaWrite::Put { row } if row.store == ReplicaStore::OptimisticItems)));
            assert_eq!(prepared.wire.writes.iter().filter(|write| matches!(write, PreparedReplicaWrite::Put { row } if row.store == ReplicaStore::CrossAccountMoves)).count(), 1);
        }
    }
}

#[test]
fn held_full_completion_refuses_each_wrong_proof_and_retained_replacement() {
    for shape in [
        "target-create",
        "source-trash-unmaterialized",
        "source-trash-materialized",
    ] {
        let (replica, account, original) = earlier_prefix(LegacyItemCommandStatus::Failed, shape);
        let before = replica.snapshot(&account).unwrap();
        for key in ["targetCreate", "sourceTrash", "sourceDelete"] {
            for invalid in ["identity", "fingerprint", "entity", "version", "rejected"] {
                let mut mutation = serde_json::to_value(completion_mutation(
                    before.cross_account_moves[0].captured().unwrap(),
                    &delete_proof(&original),
                ))
                .unwrap();
                let proof = &mut mutation["verifiedOutcomes"][key];
                match invalid {
                    "identity" => proof["operationId"] = json!("unrelated-operation"),
                    "fingerprint" => {
                        proof["requestFingerprint"] =
                            serde_json::to_value(Sha256Fingerprint::of_bytes(b"wrong request"))
                                .unwrap()
                    }
                    "entity" => proof["result"]["entityId"] = json!("other-item"),
                    "version" => proof["result"]["version"] = json!(999),
                    "rejected" => {
                        proof["result"] = serde_json::to_value(OperationOutcomeResult::Rejected {
                            code: OperationRejectionCode::VaultReadOnly,
                        })
                        .unwrap()
                    }
                    _ => unreachable!(),
                }
                assert!(
                    execute(
                        &replica,
                        &account,
                        vec![serde_json::from_value(mutation).unwrap()]
                    )
                    .is_err(),
                    "{shape}/{key}/{invalid}"
                );
                assert_eq!(replica.snapshot(&account).unwrap(), before);
            }
        }
    }
}

#[test]
fn held_full_completion_payload_is_required_closed_and_map_only() {
    let (_, _, original) = held_replica(LegacyItemCommandStatus::Failed);
    let good =
        serde_json::to_value(completion_mutation(&original, &delete_proof(&original))).unwrap();
    let payload = good["verifiedOutcomes"].clone();
    assert!(serde_json::from_value::<LegacyCrossAccountCompletionProof>(payload).is_ok());
    for invalid in [
        "missing-target",
        "missing-trash",
        "missing-delete",
        "unknown",
        "array",
        "null",
    ] {
        let mut wire = good.clone();
        let proof = &mut wire["verifiedOutcomes"];
        match invalid {
            "missing-target" => {
                proof.as_object_mut().unwrap().remove("targetCreate");
            }
            "missing-trash" => {
                proof.as_object_mut().unwrap().remove("sourceTrash");
            }
            "missing-delete" => {
                proof.as_object_mut().unwrap().remove("sourceDelete");
            }
            "unknown" => proof["extra"] = json!(true),
            "array" => {
                *proof = json!([
                    proof["targetCreate"],
                    proof["sourceTrash"],
                    proof["sourceDelete"]
                ])
            }
            "null" => *proof = serde_json::Value::Null,
            _ => unreachable!(),
        }
        assert!(
            serde_json::from_value::<LegacyCrossAccountCompletionProof>(
                wire["verifiedOutcomes"].clone()
            )
            .is_err(),
            "{invalid}"
        );
        assert!(
            serde_json::from_value::<PlanMutation>(wire).is_err(),
            "{invalid}"
        );
    }
    let serialized = serde_json::to_string(&good).unwrap();
    for key in ["targetCreate", "sourceTrash", "sourceDelete"] {
        let value = serde_json::to_string(&good["verifiedOutcomes"][key]).unwrap();
        let duplicate = serialized.replacen(
            &format!("\"{key}\":"),
            &format!("\"{key}\":{value},\"{key}\":"),
            1,
        );
        let payload = serde_json::to_string(&good["verifiedOutcomes"]).unwrap();
        let duplicate_payload = payload.replacen(
            &format!("\"{key}\":"),
            &format!("\"{key}\":{value},\"{key}\":"),
            1,
        );
        assert!(
            serde_json::from_str::<LegacyCrossAccountCompletionProof>(&duplicate_payload).is_err(),
            "duplicate {key}"
        );
        assert!(
            serde_json::from_str::<PlanMutation>(&duplicate).is_err(),
            "duplicate {key}"
        );
    }
}

#[test]
fn held_full_completion_refuses_other_owners_and_ordinary_advance_bypass() {
    for inactive in [false, true] {
        let (replica, account, original) =
            earlier_prefix(LegacyItemCommandStatus::Conflicted, "target-create");
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
    let (replica, account, original) = earlier_prefix(
        LegacyItemCommandStatus::Failed,
        "source-trash-unmaterialized",
    );
    let before = replica.snapshot(&account).unwrap();
    let mut next = before.cross_account_moves[0].captured().unwrap().clone();
    let proof = full_completion_proofs(&original, &delete_proof(&original));
    for (step, key) in [
        (CrossAccountMoveStep::SourceTrash, "sourceTrash"),
        (CrossAccountMoveStep::SourceDelete, "sourceDelete"),
    ] {
        let mut child = original.legacy_item_child(step).unwrap().unwrap();
        child.item_mut().unwrap().result =
            Some(serde_json::from_value(proof[key].clone()).unwrap());
        next.children.push(child);
    }
    next.stage = CrossAccountMoveStage::Completed;
    assert!(execute(
        &replica,
        &account,
        vec![PlanMutation::AdvanceCrossAccountMove {
            operation_id: original.operation_id.clone(),
            expected_binding_revision: 1,
            next: Box::new(next),
            source_authority: CrossAccountMoveSourceAuthority::Unchanged
        }]
    )
    .is_err());
    assert_eq!(replica.snapshot(&account).unwrap(), before);
}

#[test]
fn held_full_completion_refuses_corrupt_or_unreachable_prefix_before_state_changes() {
    for invalid in [
        "target-create-proved",
        "source-trash-proved",
        "source-trash-without-target-proof",
        "foreign-id",
        "wrong-request",
        "wrong-resource",
        "extra-child",
    ] {
        let (replica, account, original) = earlier_prefix(
            LegacyItemCommandStatus::Failed,
            if invalid == "source-trash-proved" {
                "source-trash-materialized"
            } else {
                "target-create"
            },
        );
        let mut snapshot = replica.snapshot(&account).unwrap();
        let record = snapshot.cross_account_moves[0].captured_mut().unwrap();
        let proofs = full_completion_proofs(&original, &delete_proof(&original));
        match invalid {
            "target-create-proved" => {
                record.children[0].item_mut().unwrap().result =
                    Some(serde_json::from_value(proofs["targetCreate"].clone()).unwrap())
            }
            "source-trash-proved" => {
                record.children[1].item_mut().unwrap().result =
                    Some(serde_json::from_value(proofs["sourceTrash"].clone()).unwrap())
            }
            "source-trash-without-target-proof" => {
                record.stage = CrossAccountMoveStage::SourceTrash
            }
            "foreign-id" => record.children[0]
                .item_mut()
                .unwrap()
                .operation_id
                .push_str("-foreign"),
            "wrong-request" => record.children[0]
                .item_mut()
                .unwrap()
                .request
                .body
                .push(b' '),
            "wrong-resource" => {
                record.children[0].item_mut().unwrap().target = ResourceRef::Item {
                    item_id: "unrelated-item".into(),
                    vault_id: original.target.vault_id.clone(),
                }
            }
            "extra-child" => record.children.push(
                record
                    .legacy_item_child(CrossAccountMoveStep::SourceTrash)
                    .unwrap()
                    .unwrap(),
            ),
            _ => unreachable!(),
        }
        let mutation = completion_mutation(record, &delete_proof(&original));
        let before = snapshot.clone();
        let mut state = AccountReplica::from_snapshot(snapshot);
        assert!(state.apply(mutation).is_err(), "{invalid}");
        assert_eq!(state.snapshot(), before, "{invalid}");
    }
}
