//! Missing original source evidence reserves one workflow without fabricating an Item.
use super::*;
use crate::replica::persistence_contract::{
    prepare_commit, reconstruct_snapshot, snapshot_rows, PreparedReplicaWrite, ReplicaHead,
    ReplicaStore, StoredReplicaRow,
};
use crate::replica::recovery::RecoveryCoverage;

fn missing_source_fixture() -> (
    InMemoryReplica,
    AccountId,
    CrossAccountMoveRecord,
    serde_json::Value,
) {
    missing_source_fixture_with_authority(crate::replica::AuthorityVaultRole::Owner, false)
}

fn missing_source_fixture_with_authority(
    role: crate::replica::AuthorityVaultRole,
    source_present: bool,
) -> (
    InMemoryReplica,
    AccountId,
    CrossAccountMoveRecord,
    serde_json::Value,
) {
    let (mut original, _) = super::super::tests::oracle_record();
    let admission = original.legacy_admission.as_mut().unwrap();
    let command = &mut admission.source_command;
    command.id = original.operation_id.clone();
    command.operation_id = Some(original.operation_id.clone());
    command.attempt_id = Some(original.operation_id.clone());
    command.status = Some(LegacyItemCommandStatus::Pending);
    command.retry_count = 0;
    command.next_attempt_at = None;
    command.last_error = None;
    command.conflict_copy_id = None;
    command.projection_claim_id = None;
    command.projection_claim_expires_at = None;
    admission.disposition = LegacyWorkflowDisposition::Normal;
    original.scheduling = admission.initial_scheduling();
    let account = admission.source_command.account_id.clone();
    let entry = json!({
        "type":"legacySourceUnavailable", "version":1, "operationId":original.operation_id,
        "sourceIdentity":original.source_identity, "destinationIdentity":original.destination_identity,
        "destinationBinding":original.destination_binding, "targetCreate":original.children[0].item().unwrap(),
        "scheduling":original.scheduling, "legacyAdmission":original.legacy_admission,
    });
    let replica = InMemoryReplica::default();
    replica
        .install(
            account.clone(),
            original.source_identity.user_id.clone(),
            "source-incarnation".into(),
        )
        .unwrap();
    let mut vault = crate::test_fixtures::personal_vault(
        &original.source.vault_id,
        &original.source_identity.user_id,
    );
    vault.role = role;
    replica
        .seed_ready_authority(
            &account,
            vec![vault],
            source_present
                .then(|| original.source.clone())
                .into_iter()
                .collect(),
        )
        .unwrap();
    (replica, account, original, entry)
}

fn admit_missing(entry: &serde_json::Value) -> PlanMutation {
    serde_json::from_value(json!({"type":"admitLegacySourceUnavailableMove", "record":entry}))
        .expect("missing-source capture needs its guarded parked admission")
}

fn head(snapshot: &ReplicaSnapshot) -> ReplicaHead {
    ReplicaHead {
        account_id: snapshot.account_id.clone(),
        user_id: snapshot.user_id.clone(),
        incarnation: snapshot.incarnation.clone(),
        replica_revision: snapshot.revision,
        lock_epoch: snapshot.lock_epoch,
        failure: snapshot.failure,
    }
}

fn coverage(
    head: ReplicaHead,
    rows: &[StoredReplicaRow],
) -> Result<crate::replica::recovery::CoverageProof, RuntimeError> {
    let mut proof = RecoveryCoverage::new(head)?;
    for row in rows {
        proof.push_row(row.store, &row.key.record_id, &row.payload_json)?;
    }
    proof.finish()
}

#[test]
fn missing_source_admission_preserves_one_exact_owner_without_authority_or_overlay() {
    let (replica, account, original, entry) = missing_source_fixture();
    let before = replica.snapshot(&account).unwrap();
    let plan = GuardedCommitPlan::new(
        account.clone(),
        before.incarnation.clone(),
        before.revision,
        before.lock_epoch,
        vec![admit_missing(&entry)],
    );
    let prepared = prepare_commit(before.clone(), plan).unwrap();
    execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
    let after = replica.snapshot(&account).unwrap();
    assert_eq!(after, prepared.next_snapshot);
    assert_eq!(after.revision, before.revision + 1);
    assert_eq!(after.bootstrap, before.bootstrap);
    assert_eq!(after.operations, before.operations);
    assert!(after.items.is_empty());
    assert!(after.item_has_optimistic_owner(&original.source.id));
    assert_eq!(
        serde_json::to_value(&after.cross_account_moves).unwrap(),
        json!([entry])
    );
    assert_eq!(prepared.wire.writes.len(), 1);
    assert!(
        matches!(&prepared.wire.writes[0], PreparedReplicaWrite::Put { row } if row.store == ReplicaStore::CrossAccountMoves && serde_json::from_str::<serde_json::Value>(&row.payload_json).unwrap() == entry)
    );
    let rows = snapshot_rows(after.clone()).unwrap();
    for reverse in [false, true] {
        let mut ordered = rows.clone();
        if reverse {
            ordered.reverse();
        }
        let proof = coverage(head(&after), &ordered).unwrap();
        assert!(proof.authority_valid);
        assert_eq!(proof.operation_count, 1);
        assert_eq!(proof.accepted_rows().count(), 1);
        assert!(proof.required_attachments.is_empty());
        assert_eq!(
            reconstruct_snapshot(&account, Some(head(&after)), ordered).unwrap(),
            Some(after.clone())
        );
    }
}

#[test]
fn missing_source_retirement_keeps_reservation_and_cannot_authorize_or_advance() {
    let (replica, account, original, entry) = missing_source_fixture();
    execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
    execute(
        &replica,
        &account,
        vec![PlanMutation::RetireCrossAccountMoveDestination {
            operation_id: original.operation_id.clone(),
            expected_binding_revision: 0,
            target_account_id: original.destination_binding.account_id.clone(),
            target_incarnation: original.destination_binding.incarnation.clone(),
        }],
    )
    .unwrap();
    let retired = replica.snapshot(&account).unwrap();
    let mut expected = entry.clone();
    expected["destinationBinding"]["status"] = json!("retired");
    expected["destinationBinding"]["bindingRevision"] = json!("1");
    assert_eq!(
        serde_json::to_value(&retired.cross_account_moves).unwrap(),
        json!([expected])
    );
    assert!(retired.item_has_optimistic_owner(&original.source.id));
    assert!(retired.items.is_empty());
    for mutation in [
        PlanMutation::ReauthorizeCrossAccountMoveDestination {
            operation_id: original.operation_id.clone(),
            expected_binding_revision: 1,
            destination_account_id: "re-added-account".into(),
            destination_incarnation: "new-incarnation".into(),
            verified_attachments: Vec::new(),
        },
        PlanMutation::AdvanceCrossAccountMove {
            operation_id: original.operation_id.clone(),
            expected_binding_revision: 1,
            next: Box::new(original.clone()),
            source_authority: CrossAccountMoveSourceAuthority::Unchanged,
        },
    ] {
        assert!(execute(&replica, &account, vec![mutation]).is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), retired);
    }
    replica
        .seed_ready_authority(
            &account,
            vec![crate::test_fixtures::personal_vault(
                &original.source.vault_id,
                &original.source_identity.user_id,
            )],
            vec![original.source.clone()],
        )
        .unwrap();
    let current = replica.snapshot(&account).unwrap();
    assert!(current.item_has_optimistic_owner(&original.source.id));
    assert!(current.items.is_empty());
    assert_eq!(current.cross_account_moves, retired.cross_account_moves);
}

#[test]
fn missing_source_admission_refuses_each_reserved_original_identity_and_independent_owner() {
    for conflict in [
        "same-item-active",
        "same-item-inactive",
        "semantic",
        "create-target",
        "trash-source",
        "delete-source",
    ] {
        let (replica, account, original, entry) = missing_source_fixture();
        let mut other = original.clone();
        if !conflict.starts_with("same-item") {
            other.source.id = "independent-other-item".into();
        }
        let (mut operation, mut overlay) =
            same_item_create(&other, conflict == "same-item-inactive");
        if !conflict.starts_with("same-item") {
            let id = if conflict == "semantic" {
                original.operation_id.clone()
            } else {
                format!("{}:{conflict}", original.operation_id)
            };
            operation.operation_id = id.clone();
            operation
                .legacy_admission
                .as_mut()
                .unwrap()
                .source_command
                .id = id.clone();
            overlay.operation_id = id;
        }
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
        assert!(
            execute(&replica, &account, vec![admit_missing(&entry)]).is_err(),
            "{conflict}"
        );
        assert_eq!(replica.snapshot(&account).unwrap(), before);
    }
}

#[test]
fn missing_source_recovery_refuses_forbidden_overlay_and_future_id_in_either_row_order() {
    let (replica, account, original, entry) = missing_source_fixture();
    execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
    let snapshot = replica.snapshot(&account).unwrap();
    let rows = snapshot_rows(snapshot.clone()).unwrap();
    for conflict in [
        "owned-overlay",
        "active-owner",
        "inactive-owner",
        "create-target",
        "trash-source",
        "delete-source",
    ] {
        let mut extra_snapshot = snapshot.clone();
        // Serialize ordinary rows separately; append them to the existing owner rows so Recovery
        // must enforce cross-row constraints regardless of inventory order.
        extra_snapshot.cross_account_moves.clear();
        if conflict == "owned-overlay" {
            extra_snapshot.items.push(original.source_overlay(&account));
        } else {
            let mut other = original.clone();
            if conflict.ends_with("target") || conflict.ends_with("source") {
                other.source.id = "different-source".into();
            }
            let (mut operation, mut overlay) =
                same_item_create(&other, conflict == "inactive-owner");
            if conflict.ends_with("target") || conflict.ends_with("source") {
                let id = format!("{}:{conflict}", original.operation_id);
                operation.operation_id = id.clone();
                operation
                    .legacy_admission
                    .as_mut()
                    .unwrap()
                    .source_command
                    .id = id.clone();
                overlay.operation_id = id;
            }
            extra_snapshot.operations.push(operation);
            extra_snapshot.items.push(overlay);
        }
        let extras: Vec<_> = snapshot_rows(extra_snapshot)
            .unwrap()
            .into_iter()
            .filter(|row| {
                matches!(
                    row.store,
                    ReplicaStore::Operations | ReplicaStore::OptimisticItems
                )
            })
            .collect();
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            ordered.extend(extras.clone());
            if reverse {
                ordered.reverse();
            }
            assert!(
                coverage(head(&snapshot), &ordered).is_err(),
                "{conflict}/{reverse}"
            );
            assert!(
                reconstruct_snapshot(&account, Some(head(&snapshot)), ordered).is_err(),
                "{conflict}/{reverse}"
            );
        }
    }
}

#[test]
fn missing_source_entry_is_closed_map_only_and_rejects_semantic_shape_injection() {
    let (replica, account, original, entry) = missing_source_fixture();
    // The valid wrapper must decode before malformed variants are meaningful.
    let good = serde_json::to_value(admit_missing(&entry)).unwrap();
    for invalid in [
        "source",
        "target",
        "children",
        "attachments",
        "stage",
        "disposition",
        "unknown",
        "missing",
        "array",
    ] {
        let mut wire = good.clone();
        match invalid {
            "missing" => {
                wire["record"]
                    .as_object_mut()
                    .unwrap()
                    .remove("targetCreate");
            }
            "array" => wire["record"] = json!([entry]),
            key => wire["record"][key] = json!({}),
        }
        assert!(
            serde_json::from_value::<PlanMutation>(wire).is_err(),
            "{invalid}"
        );
    }
    let encoded = serde_json::to_string(&good).unwrap();
    for key in [
        "type",
        "version",
        "operationId",
        "targetCreate",
        "legacyAdmission",
    ] {
        let value = serde_json::to_string(&entry[key]).unwrap();
        let needle = format!("\"{key}\":{value}");
        let duplicate = encoded.replacen(&needle, &format!("{needle},{needle}"), 1);
        assert!(
            serde_json::from_str::<PlanMutation>(&duplicate).is_err(),
            "duplicate {key}"
        );
    }
    for invalid in [
        "version",
        "identity",
        "request",
        "proof",
        "failed-without-diagnostic",
        "attempt",
        "scheduling",
        "authorized",
        "binding",
    ] {
        let mut wire = entry.clone();
        match invalid {
            "version" => wire["version"] = json!(2),
            "identity" => wire["targetCreate"]["operationId"] = json!("replacement"),
            "request" => wire["targetCreate"]["request"]["body"] = json!([]),
            "proof" => {
                wire["targetCreate"]["result"] = serde_json::to_value(ObservedOutcome {
                    operation_id: original.children[0].item().unwrap().operation_id.clone(),
                    request_fingerprint: original.children[0].item().unwrap().request_fingerprint,
                    result: OperationOutcomeResult::Applied {
                        entity_id: original.target.id.clone(),
                        version: 1,
                    },
                })
                .unwrap()
            }
            "failed-without-diagnostic" => {
                wire["legacyAdmission"]["sourceCommand"]["status"] = json!("failed");
                wire["legacyAdmission"]["disposition"] = json!("legacyFailed");
            }
            "attempt" => {
                wire["legacyAdmission"]["sourceCommand"]["attemptId"] = json!("another-attempt")
            }
            "scheduling" => wire["scheduling"]["notBeforeMs"] = json!("999"),
            "authorized" => {
                wire["legacyAdmission"]["disposition"] = json!({"destinationReauthorized":{"priorHold":"legacyFailed","bindingRevision":"2"}})
            }
            "binding" => wire["destinationBinding"]["bindingRevision"] = json!("2"),
            _ => unreachable!(),
        }
        let before = replica.snapshot(&account).unwrap();
        let result = serde_json::from_value::<PlanMutation>(
            json!({"type":"admitLegacySourceUnavailableMove", "record":wire}),
        );
        if let Ok(mutation) = result {
            assert!(
                execute(&replica, &account, vec![mutation]).is_err(),
                "{invalid}"
            );
        }
        assert_eq!(replica.snapshot(&account).unwrap(), before);
    }
}

#[test]
fn missing_source_admission_requires_valid_ready_capture_and_actual_absence() {
    let (replica, account, original, entry) = missing_source_fixture();
    for invalid in [
        "cold",
        "missing-generation",
        "present-original",
        "present-trashed",
        "present-newer",
        "wrong-key",
    ] {
        let mut snapshot = replica.snapshot(&account).unwrap();
        let generation = snapshot.bootstrap.active_generation.clone().unwrap();
        match invalid {
            "cold" => snapshot.bootstrap = BootstrapAuthority::default(),
            "missing-generation" => {
                snapshot.bootstrap.generations.remove(&generation);
            }
            _ => {
                let mut source = original.source.clone();
                if invalid == "present-trashed" {
                    source.version += 1;
                    source.deleted_at = Some("2026-01-01T00:00:00Z".into());
                }
                if invalid == "present-newer" {
                    source.version += 2;
                }
                let key = if invalid == "wrong-key" {
                    "wrong-key".to_owned()
                } else {
                    source.id.clone()
                };
                snapshot.bootstrap.items.insert((generation, key), source);
            }
        }
        let before = snapshot.clone();
        let mut state = AccountReplica::from_snapshot(snapshot);
        assert!(state.apply(admit_missing(&entry)).is_err(), "{invalid}");
        assert_eq!(state.snapshot(), before, "{invalid}");
    }
}

#[test]
fn missing_source_owner_envelope_preserves_existing_full_record_wire_bytes() {
    let (replica, account, original, _) = missing_source_fixture();
    let original_json = serde_json::to_string(&original).unwrap();
    let mut wire = serde_json::to_value(replica.snapshot(&account).unwrap()).unwrap();
    wire["crossAccountMoves"] = json!([original]);
    let restored: ReplicaSnapshot = serde_json::from_value(wire).unwrap();
    assert_eq!(
        serde_json::to_string(&restored.cross_account_moves[0]).unwrap(),
        original_json
    );
}

#[test]
fn missing_source_refuses_empty_target_ciphertext_or_iv_with_recomputed_request_fingerprint() {
    let (replica, account, original, entry) = missing_source_fixture();
    let before = replica.snapshot(&account).unwrap();
    for empty_field in ["ciphertext", "iv"] {
        let mut malformed = entry.clone();
        let mut body: crate::server_contract::CreateItemBody =
            serde_json::from_slice(&original.children[0].item().unwrap().request.body).unwrap();
        if empty_field == "ciphertext" {
            body.encrypted_data.clear();
        } else {
            body.encryption_iv.clear();
        }
        let bytes = super::super::legacy_target_create_body(
            original
                .legacy_admission
                .as_ref()
                .unwrap()
                .source_command
                .category
                .unwrap(),
            &body.encrypted_data,
            &body.encryption_iv,
            &body.encryption_algorithm,
        )
        .unwrap();
        malformed["targetCreate"]["request"]["body"] = serde_json::to_value(&bytes).unwrap();
        malformed["targetCreate"]["requestFingerprint"] = serde_json::to_value(
            create_item_fingerprint(&original.target.vault_id, &original.target.id, &bytes),
        )
        .unwrap();
        assert!(
            execute(&replica, &account, vec![admit_missing(&malformed)]).is_err(),
            "{empty_field}"
        );
        assert_eq!(replica.snapshot(&account).unwrap(), before);
        let mut rows = snapshot_rows(before.clone()).unwrap();
        rows.push(StoredReplicaRow {
            store: ReplicaStore::CrossAccountMoves,
            key: crate::replica::persistence_contract::ReplicaRowKey {
                account_id: account.clone(),
                record_id: original.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&malformed).unwrap(),
        });
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert!(
                coverage(head(&before), &ordered).is_err(),
                "{empty_field}/{reverse}"
            );
            assert!(
                reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err(),
                "{empty_field}/{reverse}"
            );
        }
    }
}

#[test]
fn missing_source_nested_controls_require_objects_and_explicit_result_null() {
    let (_, _, _, entry) = missing_source_fixture();
    let valid = serde_json::to_value(admit_missing(&entry)).unwrap();
    let positional = |value: &serde_json::Value, fields: &[&str]| {
        serde_json::Value::Array(fields.iter().map(|field| value[*field].clone()).collect())
    };
    for field in [
        "sourceIdentity",
        "destinationIdentity",
        "destinationBinding",
        "scheduling",
        "targetCreate",
        "request",
        "header",
        "missing-result",
        "step-array",
        "step-unknown-field",
    ] {
        let mut wire = valid.clone();
        let record = &mut wire["record"];
        match field {
            "sourceIdentity" | "destinationIdentity" => {
                record[field] = positional(&record[field], &["serverUrl", "userId"])
            }
            "destinationBinding" => {
                record[field] = positional(
                    &record[field],
                    &["accountId", "incarnation", "bindingRevision", "status"],
                )
            }
            "scheduling" => {
                record[field] = positional(&record[field], &["attemptCount", "notBeforeMs"])
            }
            "targetCreate" => {
                record[field] = positional(
                    &record[field],
                    &[
                        "step",
                        "endpoint",
                        "operationId",
                        "kind",
                        "target",
                        "request",
                        "requestFingerprint",
                        "result",
                    ],
                )
            }
            "request" => {
                record["targetCreate"]["request"] = positional(
                    &record["targetCreate"]["request"],
                    &["method", "path", "headers", "body"],
                )
            }
            "header" => {
                record["targetCreate"]["request"]["headers"][0] = positional(
                    &record["targetCreate"]["request"]["headers"][0],
                    &["name", "value"],
                )
            }
            "step-array" => record["targetCreate"]["step"] = json!(["targetCreate"]),
            "step-unknown-field" => record["targetCreate"]["step"]["unknown"] = json!(true),
            "missing-result" => {
                record["targetCreate"]
                    .as_object_mut()
                    .unwrap()
                    .remove("result");
            }
            _ => unreachable!(),
        }
        assert!(
            serde_json::from_value::<PlanMutation>(wire).is_err(),
            "{field}"
        );
    }
    // Header-list and request-byte arrays remain legitimate parts of the canonical HTTP request.
    assert!(valid["record"]["targetCreate"]["request"]["headers"].is_array());
    assert!(valid["record"]["targetCreate"]["request"]["body"].is_array());
    assert!(serde_json::from_value::<PlanMutation>(valid).is_ok());
}

#[test]
fn missing_source_preserves_typed_optional_history_and_original_deadline_without_an_overlay() {
    let (replica, account, original, mut entry) = missing_source_fixture();
    // Domain compatibility control; the actual first-success producer fixture omits these fields.
    entry["legacyAdmission"]["sourceCommand"]["nextAttemptAt"] = json!("9000");
    entry["legacyAdmission"]["sourceCommand"]["lastError"] = json!("retained diagnostic only");
    entry["legacyAdmission"]["sourceCommand"]["projectionClaimId"] = json!("departed-projection");
    entry["legacyAdmission"]["sourceCommand"]["projectionClaimExpiresAt"] = json!("8000");
    entry["scheduling"]["notBeforeMs"] = json!("9000");
    execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
    let snapshot = replica.snapshot(&account).unwrap();
    assert_eq!(
        serde_json::to_value(&snapshot.cross_account_moves).unwrap(),
        json!([entry])
    );
    assert!(snapshot.items.is_empty());
    assert!(snapshot.item_has_optimistic_owner(&original.source.id));
    let rows = snapshot_rows(snapshot.clone()).unwrap();
    for reverse in [false, true] {
        let mut ordered = rows.clone();
        if reverse {
            ordered.reverse();
        }
        assert_eq!(
            coverage(head(&snapshot), &ordered).unwrap().operation_count,
            1
        );
        assert_eq!(
            reconstruct_snapshot(&account, Some(head(&snapshot)), ordered).unwrap(),
            Some(snapshot.clone())
        );
    }
}

#[test]
fn missing_source_vault_retirement_reopens_exact_owner_and_blocks_later_same_item_work() {
    use crate::replica::persistence_contract::apply_prepared_writes_to_rows;

    let (replica, account, original, entry) = missing_source_fixture();
    execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
    for mutation in [
        PlanMutation::RetireVaults {
            vault_ids: vec![original.source.vault_id.clone()],
        },
        PlanMutation::CompleteVaultRetirements {
            vault_ids: vec![original.source.vault_id.clone()],
        },
    ] {
        let before = replica.snapshot(&account).unwrap();
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
        assert_eq!(after.cross_account_moves, before.cross_account_moves);
        assert!(after.items.is_empty());
        assert!(after.item_has_optimistic_owner(&original.source.id));
        // Lifecycle changes authority metadata, not the preserved accepted owner.
        assert!(!prepared.wire.writes.iter().any(|write| match write {
            PreparedReplicaWrite::Put { row } => row.store == ReplicaStore::CrossAccountMoves,
            PreparedReplicaWrite::Delete { store, .. } => *store == ReplicaStore::CrossAccountMoves,
        }));
        let rows =
            apply_prepared_writes_to_rows(snapshot_rows(before).unwrap(), &prepared.wire.writes);
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            let proof = coverage(head(&after), &ordered).unwrap();
            assert_eq!(proof.operation_count, 1);
            assert!(proof.required_attachments.is_empty());
            assert_eq!(
                reconstruct_snapshot(&account, Some(head(&after)), ordered).unwrap(),
                Some(after.clone())
            );
        }
    }
    // This is a Domain authority fixture, not an assertion that an actual Sync ran.
    replica
        .seed_ready_authority(
            &account,
            vec![crate::test_fixtures::personal_vault(
                &original.source.vault_id,
                &original.source_identity.user_id,
            )],
            vec![original.source.clone()],
        )
        .unwrap();
    let before = replica.snapshot(&account).unwrap();
    assert_eq!(
        serde_json::to_value(&before.cross_account_moves).unwrap(),
        json!([entry])
    );
    let (operation, overlay) = same_item_create(&original, false);
    let mutations = vec![
        PlanMutation::AcceptOperation(operation),
        PlanMutation::PutOptimisticItem(overlay),
    ];
    // The same accepted request is valid absent this owner; isolate the ownership fence.
    let mut unowned = before.clone();
    unowned.cross_account_moves.clear();
    prepare_commit(
        unowned.clone(),
        GuardedCommitPlan::new(
            account.clone(),
            unowned.incarnation.clone(),
            unowned.revision,
            unowned.lock_epoch,
            mutations.clone(),
        ),
    )
    .unwrap();
    assert!(execute(&replica, &account, mutations).is_err());
    assert_eq!(replica.snapshot(&account).unwrap(), before);
}

fn retrying_missing_source_entry(
    mut entry: serde_json::Value,
    retry_count: u64,
    error: &str,
) -> serde_json::Value {
    let semantic = entry["operationId"].as_str().unwrap().to_owned();
    let command = &mut entry["legacyAdmission"]["sourceCommand"];
    command["status"] = json!("retrying");
    command["retryCount"] = json!(retry_count.to_string());
    command["attemptId"] = json!(format!("{semantic}:attempt:producer-retry"));
    command["nextAttemptAt"] = json!("1789000001123");
    command["lastError"] = json!(error);
    // Retained optional fields are history, not an execution or ownership capability.
    command["projectionClaimId"] = json!("prior-projection");
    command["projectionClaimExpiresAt"] = json!("1789000000123");
    entry["scheduling"] =
        json!({"attemptCount":retry_count.to_string(),"notBeforeMs":"1789000001123"});
    entry
}

#[test]
fn missing_source_retrying_preserves_exact_history_one_owner_and_recovery() {
    for retry_count in 1..=4 {
        for error in ["network down", ""] {
            let (replica, account, original, entry) = missing_source_fixture();
            let entry = retrying_missing_source_entry(entry, retry_count, error);
            let before = replica.snapshot(&account).unwrap();
            let prepared = prepare_commit(
                before.clone(),
                GuardedCommitPlan::new(
                    account.clone(),
                    before.incarnation.clone(),
                    before.revision,
                    before.lock_epoch,
                    vec![admit_missing(&entry)],
                ),
            )
            .expect("producer retry acknowledgement must preserve its parked owner");
            execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
            let after = replica.snapshot(&account).unwrap();
            assert_eq!(after, prepared.next_snapshot);
            assert_eq!(after.bootstrap, before.bootstrap);
            assert_eq!(after.operations, before.operations);
            assert!(after.items.is_empty());
            assert!(after.item_has_optimistic_owner(&original.source.id));
            assert_eq!(
                serde_json::to_value(&after.cross_account_moves).unwrap(),
                json!([entry])
            );
            assert_eq!(
                after.cross_account_moves[0].reserved_child_operation_ids(),
                vec![
                    format!("{}:create-target", original.operation_id),
                    format!("{}:trash-source", original.operation_id),
                    format!("{}:delete-source", original.operation_id),
                ]
            );
            assert_eq!(prepared.wire.writes.len(), 1);
            assert!(
                matches!(&prepared.wire.writes[0], PreparedReplicaWrite::Put { row }
                if row.store == ReplicaStore::CrossAccountMoves
                && serde_json::from_str::<serde_json::Value>(&row.payload_json).unwrap() == entry)
            );
            let rows = snapshot_rows(after.clone()).unwrap();
            for reverse in [false, true] {
                let mut ordered = rows.clone();
                if reverse {
                    ordered.reverse();
                }
                let proof = coverage(head(&after), &ordered).unwrap();
                assert!(proof.authority_valid);
                assert_eq!(proof.operation_count, 1);
                assert_eq!(proof.accepted_rows().count(), 1);
                assert!(proof.required_attachments.is_empty());
                assert_eq!(
                    reconstruct_snapshot(&account, Some(head(&after)), ordered).unwrap(),
                    Some(after.clone())
                );
            }
        }
    }
}

#[test]
fn missing_source_retrying_rejects_mixed_or_unsupported_history_without_writes() {
    for invalid in [
        "count-zero",
        "count-five",
        "missing-attempt",
        "empty-attempt",
        "semantic-attempt",
        "missing-operation",
        "other-operation",
        "other-id",
        "missing-deadline",
        "unsafe-deadline",
        "missing-error",
        "schedule-count",
        "schedule-deadline",
        "pending-retry",
        "failed",
        "conflicted",
        "staged",
        "applying",
        "missing-status",
        "version-two",
    ] {
        let (replica, account, original, entry) = missing_source_fixture();
        let mut entry = retrying_missing_source_entry(entry, 1, "network down");
        let command = &mut entry["legacyAdmission"]["sourceCommand"];
        match invalid {
            "count-zero" => command["retryCount"] = json!("0"),
            "count-five" => command["retryCount"] = json!("5"),
            "missing-attempt" => {
                command.as_object_mut().unwrap().remove("attemptId");
            }
            "empty-attempt" => command["attemptId"] = json!(""),
            "semantic-attempt" => command["attemptId"] = json!(original.operation_id),
            "missing-operation" => {
                command.as_object_mut().unwrap().remove("operationId");
            }
            "other-operation" => command["operationId"] = json!("other-semantic"),
            "other-id" => command["id"] = json!("other-queue-row"),
            "missing-deadline" => {
                command.as_object_mut().unwrap().remove("nextAttemptAt");
            }
            "unsafe-deadline" => command["nextAttemptAt"] = json!("9007199254740992"),
            "missing-error" => {
                command.as_object_mut().unwrap().remove("lastError");
            }
            "pending-retry" => command["status"] = json!("pending"),
            "failed" | "conflicted" | "staged" | "applying" => command["status"] = json!(invalid),
            "missing-status" => {
                command.as_object_mut().unwrap().remove("status");
            }
            "schedule-count" | "schedule-deadline" | "version-two" => {}
            _ => unreachable!(),
        }
        match invalid {
            "count-zero" => entry["scheduling"]["attemptCount"] = json!("0"),
            "count-five" => entry["scheduling"]["attemptCount"] = json!("5"),
            "missing-deadline" => entry["scheduling"]["notBeforeMs"] = json!("0"),
            "unsafe-deadline" => entry["scheduling"]["notBeforeMs"] = json!("9007199254740992"),
            "schedule-count" => entry["scheduling"]["attemptCount"] = json!("2"),
            "schedule-deadline" => entry["scheduling"]["notBeforeMs"] = json!("1789000001124"),
            "version-two" => entry["version"] = json!(2),
            _ => {}
        }
        let before = replica.snapshot(&account).unwrap();
        if let Ok(mutation) = serde_json::from_value::<PlanMutation>(
            json!({"type":"admitLegacySourceUnavailableMove","record":entry}),
        ) {
            assert!(
                execute(&replica, &account, vec![mutation]).is_err(),
                "{invalid}"
            );
        }
        assert_eq!(replica.snapshot(&account).unwrap(), before, "{invalid}");
        let mut rows = snapshot_rows(before.clone()).unwrap();
        rows.push(StoredReplicaRow {
            store: ReplicaStore::CrossAccountMoves,
            key: crate::replica::persistence_contract::ReplicaRowKey {
                account_id: account.clone(),
                record_id: original.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&entry).unwrap(),
        });
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert!(
                coverage(head(&before), &ordered).is_err(),
                "{invalid}/{reverse}"
            );
            assert!(
                reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err(),
                "{invalid}/{reverse}"
            );
        }
    }
}

#[test]
fn missing_source_retrying_extension_keeps_original_pending_wire() {
    let (replica, account, _, entry) = missing_source_fixture();
    execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
    assert_eq!(
        serde_json::to_value(&replica.snapshot(&account).unwrap().cross_account_moves).unwrap(),
        json!([entry])
    );
}

fn failed_missing_source_entry(entry: serde_json::Value, error: &str) -> serde_json::Value {
    let mut entry = retrying_missing_source_entry(entry, 5, error);
    entry["legacyAdmission"]["disposition"] = json!("legacyFailed");
    entry["legacyAdmission"]["sourceCommand"]["status"] = json!("failed");
    entry["legacyAdmission"]["sourceCommand"]
        .as_object_mut()
        .unwrap()
        .remove("nextAttemptAt");
    entry["scheduling"]["notBeforeMs"] = json!("0");
    entry
}

#[test]
fn missing_source_failed_five_preserves_inactive_owner_in_writable_and_readonly_scopes() {
    for read_only in [false, true] {
        for error in ["network down", ""] {
            let role = if read_only {
                crate::replica::AuthorityVaultRole::ReadOnly
            } else {
                crate::replica::AuthorityVaultRole::Owner
            };
            let (replica, account, original, entry) =
                missing_source_fixture_with_authority(role, false);
            let entry = failed_missing_source_entry(entry, error);
            let before = replica.snapshot(&account).unwrap();
            let prepared = prepare_commit(
                before.clone(),
                GuardedCommitPlan::new(
                    account.clone(),
                    before.incarnation.clone(),
                    before.revision,
                    before.lock_epoch,
                    vec![admit_missing(&entry)],
                ),
            )
            .expect("genuine Failed5 source-free history needs an inactive held owner");
            execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
            let after = replica.snapshot(&account).unwrap();
            assert_eq!(after, prepared.next_snapshot);
            assert_eq!(after.bootstrap, before.bootstrap);
            assert!(after.items.is_empty());
            assert!(after.operations.is_empty());
            assert!(!after.item_has_optimistic_owner(&original.source.id));
            assert!(!after.cross_account_moves[0].owns_source_item());
            assert_eq!(
                serde_json::to_value(&after.cross_account_moves).unwrap(),
                json!([entry])
            );
            assert_eq!(prepared.wire.writes.len(), 1);
            assert!(
                matches!(&prepared.wire.writes[0], PreparedReplicaWrite::Put {row} if row.store == ReplicaStore::CrossAccountMoves)
            );
            let rows = snapshot_rows(after.clone()).unwrap();
            for reverse in [false, true] {
                let mut ordered = rows.clone();
                if reverse {
                    ordered.reverse();
                }
                let proof = coverage(head(&after), &ordered).unwrap();
                assert_eq!(proof.operation_count, 1);
                assert!(proof.required_attachments.is_empty());
                assert_eq!(
                    reconstruct_snapshot(&account, Some(head(&after)), ordered).unwrap(),
                    Some(after.clone())
                );
            }
        }
    }
}

#[test]
fn missing_source_failed_five_coexists_with_independent_owners_but_never_owns_an_overlay() {
    for held_other in [false, true] {
        for prior_other in [false, true] {
            let (replica, account, original, entry) = missing_source_fixture();
            let entry = failed_missing_source_entry(entry, "network down");
            let (operation, overlay) = same_item_create(&original, held_other);
            let independent = vec![
                PlanMutation::AcceptOperation(operation),
                PlanMutation::PutOptimisticItem(overlay.clone()),
            ];
            if prior_other {
                execute(&replica, &account, independent.clone()).unwrap();
            }
            execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
            if !prior_other {
                execute(&replica, &account, independent).unwrap();
            }
            let after = replica.snapshot(&account).unwrap();
            assert_eq!(after.items, vec![overlay]);
            assert_eq!(
                serde_json::to_value(&after.cross_account_moves).unwrap(),
                json!([entry])
            );
            assert!(!after.cross_account_moves[0].owns_source_item());
            let rows = snapshot_rows(after.clone()).unwrap();
            for reverse in [false, true] {
                let mut ordered = rows.clone();
                if reverse {
                    ordered.reverse();
                }
                assert_eq!(coverage(head(&after), &ordered).unwrap().operation_count, 2);
                assert_eq!(
                    reconstruct_snapshot(&account, Some(head(&after)), ordered).unwrap(),
                    Some(after.clone())
                );
            }
        }
    }
    let (replica, account, original, entry) = missing_source_fixture();
    execute(
        &replica,
        &account,
        vec![admit_missing(&failed_missing_source_entry(entry, ""))],
    )
    .unwrap();
    let before = replica.snapshot(&account).unwrap();
    for other_item in [false, true] {
        let mut overlay = original.source_overlay(&account);
        if other_item {
            overlay.item_id = "unrelated-item".into();
        }
        assert!(execute(
            &replica,
            &account,
            vec![PlanMutation::PutOptimisticItem(overlay.clone())]
        )
        .is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), before);
        let mut malformed = before.clone();
        malformed.items.push(overlay);
        let rows = snapshot_rows(malformed).unwrap();
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert!(coverage(head(&before), &ordered).is_err());
            assert!(reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err());
        }
    }
}

#[test]
fn missing_source_failed_five_rejects_other_histories_and_preserves_normal_ownership() {
    for invalid in [
        "retry-four-original-attempt",
        "retry-six",
        "deadline",
        "missing-error",
        "missing-attempt",
        "empty-attempt",
        "normal-disposition",
        "conflicted",
        "pending",
        "retrying",
    ] {
        let (replica, account, original, entry) = missing_source_fixture();
        let mut entry = failed_missing_source_entry(entry, "network down");
        match invalid {
            "retry-four-original-attempt" | "retry-six" => {
                let count = if invalid == "retry-four-original-attempt" {
                    "4"
                } else {
                    "6"
                };
                entry["legacyAdmission"]["sourceCommand"]["retryCount"] = json!(count);
                entry["scheduling"]["attemptCount"] = json!(count);
                if invalid == "retry-four-original-attempt" {
                    entry["legacyAdmission"]["sourceCommand"]["attemptId"] =
                        json!(original.operation_id);
                }
            }
            "deadline" => {
                entry["legacyAdmission"]["sourceCommand"]["nextAttemptAt"] = json!("42");
                entry["scheduling"]["notBeforeMs"] = json!("42");
            }
            "missing-error" => {
                entry["legacyAdmission"]["sourceCommand"]
                    .as_object_mut()
                    .unwrap()
                    .remove("lastError");
            }
            "missing-attempt" => {
                entry["legacyAdmission"]["sourceCommand"]
                    .as_object_mut()
                    .unwrap()
                    .remove("attemptId");
            }
            "empty-attempt" => entry["legacyAdmission"]["sourceCommand"]["attemptId"] = json!(""),
            "normal-disposition" => entry["legacyAdmission"]["disposition"] = json!("normal"),
            status => entry["legacyAdmission"]["sourceCommand"]["status"] = json!(status),
        }
        let before = replica.snapshot(&account).unwrap();
        assert!(
            execute(&replica, &account, vec![admit_missing(&entry)]).is_err(),
            "{invalid}"
        );
        assert_eq!(replica.snapshot(&account).unwrap(), before);
        let mut rows = snapshot_rows(before.clone()).unwrap();
        rows.push(StoredReplicaRow {
            store: ReplicaStore::CrossAccountMoves,
            key: crate::replica::persistence_contract::ReplicaRowKey {
                account_id: account.clone(),
                record_id: original.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&entry).unwrap(),
        });
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert!(
                coverage(head(&before), &ordered).is_err(),
                "{invalid}/{reverse}"
            );
            assert!(
                reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err(),
                "{invalid}/{reverse}"
            );
        }
    }
    for retry in [false, true] {
        let (replica, account, original, entry) = missing_source_fixture();
        let entry = if retry {
            retrying_missing_source_entry(entry, 1, "")
        } else {
            entry
        };
        execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
        let before = replica.snapshot(&account).unwrap();
        assert!(before.item_has_optimistic_owner(&original.source.id));
        let (operation, overlay) = same_item_create(&original, false);
        assert!(execute(
            &replica,
            &account,
            vec![
                PlanMutation::AcceptOperation(operation),
                PlanMutation::PutOptimisticItem(overlay)
            ]
        )
        .is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), before);
    }
}

#[test]
fn missing_source_failed_five_coexists_with_an_independent_captured_workflow() {
    for other_held in [false, true] {
        for prior_other in [false, true] {
            let (replica, account, original, entry) = missing_source_fixture_with_authority(
                crate::replica::AuthorityVaultRole::Owner,
                prior_other,
            );
            let mut admission = original.legacy_admission.clone().unwrap();
            admission.source_command.id = "independent-captured-move".into();
            admission.source_command.operation_id = Some("independent-captured-move".into());
            admission.source_command.attempt_id = Some("independent-captured-move".into());
            if other_held {
                admission.source_command.status = Some(LegacyItemCommandStatus::Failed);
                admission.disposition = LegacyWorkflowDisposition::LegacyFailed;
            }
            let other = admission
                .bind(
                    original.source_identity.clone(),
                    original.destination_identity.clone(),
                    original.destination_binding.clone(),
                    original.source.clone(),
                    original.target.clone(),
                )
                .unwrap();
            let overlay = (!other_held).then(|| other.source_overlay(&account));
            let add_other = PlanMutation::AdmitCrossAccountMove {
                record: Box::new(other.clone()),
                source_overlay: overlay.clone(),
            };
            let vault = crate::test_fixtures::personal_vault(
                &original.source.vault_id,
                &original.source_identity.user_id,
            );
            if prior_other {
                execute(&replica, &account, vec![add_other.clone()]).unwrap();
                // Current authority can disappear independently of an already accepted owner.
                replica
                    .seed_ready_authority(&account, vec![vault.clone()], Vec::new())
                    .unwrap();
            }
            execute(
                &replica,
                &account,
                vec![admit_missing(&failed_missing_source_entry(
                    entry,
                    "network down",
                ))],
            )
            .unwrap();
            if !prior_other {
                // Later current authority permits new captured work, never upgrades held evidence.
                replica
                    .seed_ready_authority(&account, vec![vault], vec![original.source.clone()])
                    .unwrap();
                execute(&replica, &account, vec![add_other]).unwrap();
            }
            let after = replica.snapshot(&account).unwrap();
            assert_eq!(after.cross_account_moves.len(), 2);
            assert_eq!(after.items, overlay.into_iter().collect::<Vec<_>>());
            assert_eq!(
                after.item_has_optimistic_owner(&original.source.id),
                !other_held
            );
            let rows = snapshot_rows(after.clone()).unwrap();
            for reverse in [false, true] {
                let mut ordered = rows.clone();
                if reverse {
                    ordered.reverse();
                }
                assert_eq!(coverage(head(&after), &ordered).unwrap().operation_count, 2);
                assert_eq!(
                    reconstruct_snapshot(&account, Some(head(&after)), ordered).unwrap(),
                    Some(after.clone())
                );
            }
        }
    }
}

#[test]
fn missing_source_failed_five_reserves_semantic_and_all_original_child_ids_unconditionally() {
    for suffix in [
        None,
        Some("create-target"),
        Some("trash-source"),
        Some("delete-source"),
    ] {
        let (replica, account, original, entry) = missing_source_fixture();
        let mut unrelated = original.clone();
        unrelated.source.id = "independent-other-item".into();
        let (mut operation, mut overlay) = same_item_create(&unrelated, true);
        let id = suffix.map_or_else(
            || original.operation_id.clone(),
            |suffix| format!("{}:{suffix}", original.operation_id),
        );
        operation.operation_id = id.clone();
        operation
            .legacy_admission
            .as_mut()
            .unwrap()
            .source_command
            .id = id.clone();
        overlay.operation_id = id;
        execute(
            &replica,
            &account,
            vec![
                PlanMutation::AcceptOperation(operation.clone()),
                PlanMutation::PutOptimisticItem(overlay.clone()),
            ],
        )
        .unwrap();
        let before = replica.snapshot(&account).unwrap();
        let entry = failed_missing_source_entry(entry, "");
        assert!(execute(&replica, &account, vec![admit_missing(&entry)]).is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), before);
        let mut rows = snapshot_rows(before.clone()).unwrap();
        rows.push(StoredReplicaRow {
            store: ReplicaStore::CrossAccountMoves,
            key: crate::replica::persistence_contract::ReplicaRowKey {
                account_id: account.clone(),
                record_id: original.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&entry).unwrap(),
        });
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert!(coverage(head(&before), &ordered).is_err());
            assert!(reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err());
        }
    }
}

// Synthetic Domain fixtures exercise preserved provenance; the public test uses the real WASM
// producer conflict/copy/reopen/Delta/full-refresh capture.
fn conflicted_missing_source_entry(
    mut entry: serde_json::Value,
    copy_id: &str,
) -> serde_json::Value {
    entry["legacyAdmission"]["disposition"] = json!("legacyConflicted");
    entry["legacyAdmission"]["sourceCommand"]["status"] = json!("conflicted");
    entry["legacyAdmission"]["sourceCommand"]["lastError"] =
        json!("The Item changed on another device");
    entry["legacyAdmission"]["sourceCommand"]["conflictCopyId"] = json!(copy_id);
    entry
}

#[test]
fn missing_source_conflicted_zero_preserves_provenance_without_a_copy_foreign_key() {
    for copy_kind in ["independent-copy", "source-id", "target-id"] {
        for empty_error in [false, true] {
            let (replica, account, original, entry) = missing_source_fixture_with_authority(
                crate::replica::AuthorityVaultRole::ReadOnly,
                false,
            );
            let copy_id = match copy_kind {
                "source-id" => original.source.id.as_str(),
                "target-id" => original.target.id.as_str(),
                _ => copy_kind,
            };
            let mut entry = conflicted_missing_source_entry(entry, copy_id);
            if empty_error {
                entry["legacyAdmission"]["sourceCommand"]["lastError"] = json!("");
            }
            let before = replica.snapshot(&account).unwrap();
            let prepared = prepare_commit(
                before.clone(),
                GuardedCommitPlan::new(
                    account.clone(),
                    before.incarnation.clone(),
                    before.revision,
                    before.lock_epoch,
                    vec![admit_missing(&entry)],
                ),
            )
            .expect("first-attempt conflicted provenance needs an inactive parked owner");
            execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
            let after = replica.snapshot(&account).unwrap();
            assert_eq!(after, prepared.next_snapshot);
            assert_eq!(after.bootstrap, before.bootstrap);
            assert!(after.operations.is_empty());
            assert!(after.items.is_empty());
            assert!(!after.item_has_optimistic_owner(&original.source.id));
            assert_eq!(
                serde_json::to_value(&after.cross_account_moves).unwrap(),
                json!([entry])
            );
            assert_eq!(prepared.wire.writes.len(), 1);
            assert!(
                matches!(&prepared.wire.writes[0],PreparedReplicaWrite::Put{row} if row.store==ReplicaStore::CrossAccountMoves)
            );
            let rows = snapshot_rows(after.clone()).unwrap();
            for reverse in [false, true] {
                let mut ordered = rows.clone();
                if reverse {
                    ordered.reverse();
                }
                let proof = coverage(head(&after), &ordered).unwrap();
                assert_eq!(proof.operation_count, 1);
                assert!(proof.required_attachments.is_empty());
                assert_eq!(
                    reconstruct_snapshot(&account, Some(head(&after)), ordered).unwrap(),
                    Some(after.clone())
                );
            }
        }
    }
}

#[test]
fn missing_source_conflicted_zero_preserves_independent_copy_and_forbids_owned_overlay() {
    for copy_first in [false, true] {
        let (replica, account, original, entry) = missing_source_fixture();
        let entry = conflicted_missing_source_entry(entry, "independent-copy");
        let mut copy_fixture = original.clone();
        copy_fixture.source.id = "independent-copy".into();
        let (mut operation, mut overlay) = same_item_create(&copy_fixture, false);
        let copy_operation = format!("conflict-copy:{}", original.operation_id);
        operation.operation_id = copy_operation.clone();
        operation
            .legacy_admission
            .as_mut()
            .unwrap()
            .source_command
            .id = copy_operation.clone();
        overlay.operation_id = copy_operation;
        let accept_copy = vec![
            PlanMutation::AcceptOperation(operation.clone()),
            PlanMutation::PutOptimisticItem(overlay.clone()),
        ];
        if copy_first {
            execute(&replica, &account, accept_copy.clone()).unwrap();
        }
        execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
        if !copy_first {
            execute(&replica, &account, accept_copy).unwrap();
        }
        let after = replica.snapshot(&account).unwrap();
        assert_eq!(after.operations, vec![operation]);
        assert_eq!(after.items, vec![overlay]);
        assert!(!after.item_has_optimistic_owner(&original.source.id));
        assert!(after.item_has_optimistic_owner("independent-copy"));
        assert_eq!(
            serde_json::to_value(&after.cross_account_moves).unwrap(),
            json!([entry])
        );
        let rows = snapshot_rows(after.clone()).unwrap();
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert_eq!(coverage(head(&after), &ordered).unwrap().operation_count, 2);
            assert_eq!(
                reconstruct_snapshot(&account, Some(head(&after)), ordered).unwrap(),
                Some(after.clone())
            );
        }
        let owned = original.source_overlay(&account);
        assert!(execute(
            &replica,
            &account,
            vec![PlanMutation::PutOptimisticItem(owned.clone())]
        )
        .is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), after);
        let mut malformed = after.clone();
        malformed.items.push(owned);
        let rows = snapshot_rows(malformed).unwrap();
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert!(coverage(head(&after), &ordered).is_err());
            assert!(reconstruct_snapshot(&account, Some(head(&after)), ordered).is_err());
        }
    }
}

#[test]
fn missing_source_conflicted_zero_keeps_all_original_identity_fences() {
    for suffix in [
        None,
        Some("create-target"),
        Some("trash-source"),
        Some("delete-source"),
    ] {
        let (replica, account, original, entry) = missing_source_fixture();
        let mut unrelated = original.clone();
        unrelated.source.id = "other-item".into();
        let (mut operation, mut overlay) = same_item_create(&unrelated, true);
        let id = suffix.map_or_else(
            || original.operation_id.clone(),
            |suffix| format!("{}:{suffix}", original.operation_id),
        );
        operation.operation_id = id.clone();
        operation
            .legacy_admission
            .as_mut()
            .unwrap()
            .source_command
            .id = id.clone();
        overlay.operation_id = id;
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
        let entry = conflicted_missing_source_entry(entry, "independent-copy");
        assert!(execute(&replica, &account, vec![admit_missing(&entry)]).is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), before);
        let mut rows = snapshot_rows(before.clone()).unwrap();
        rows.push(StoredReplicaRow {
            store: ReplicaStore::CrossAccountMoves,
            key: crate::replica::persistence_contract::ReplicaRowKey {
                account_id: account.clone(),
                record_id: original.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&entry).unwrap(),
        });
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert!(coverage(head(&before), &ordered).is_err());
            assert!(reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err());
        }
    }
}

#[test]
fn missing_source_conflicted_zero_rejects_mixed_history_without_changing_prior_branches() {
    for invalid in [
        "missing-copy",
        "empty-copy",
        "retry-five",
        "attempt-reminted",
        "missing-attempt",
        "missing-operation",
        "other-operation",
        "deadline",
        "missing-error",
        "normal-disposition",
        "failed-disposition",
    ] {
        let (replica, account, original, entry) = missing_source_fixture();
        let mut entry = conflicted_missing_source_entry(entry, "independent-copy");
        match invalid {
            "missing-copy" => {
                entry["legacyAdmission"]["sourceCommand"]
                    .as_object_mut()
                    .unwrap()
                    .remove("conflictCopyId");
            }
            "empty-copy" => entry["legacyAdmission"]["sourceCommand"]["conflictCopyId"] = json!(""),
            "retry-five" => {
                entry["legacyAdmission"]["sourceCommand"]["retryCount"] = json!("5");
                entry["scheduling"]["attemptCount"] = json!("5");
            }
            "attempt-reminted" => {
                entry["legacyAdmission"]["sourceCommand"]["attemptId"] = json!("other-attempt")
            }
            "missing-attempt" => {
                entry["legacyAdmission"]["sourceCommand"]
                    .as_object_mut()
                    .unwrap()
                    .remove("attemptId");
            }
            "missing-operation" => {
                entry["legacyAdmission"]["sourceCommand"]
                    .as_object_mut()
                    .unwrap()
                    .remove("operationId");
            }
            "other-operation" => {
                entry["legacyAdmission"]["sourceCommand"]["operationId"] = json!("other-operation")
            }
            "deadline" => {
                entry["legacyAdmission"]["sourceCommand"]["nextAttemptAt"] = json!("42");
                entry["scheduling"]["notBeforeMs"] = json!("42");
            }
            "missing-error" => {
                entry["legacyAdmission"]["sourceCommand"]
                    .as_object_mut()
                    .unwrap()
                    .remove("lastError");
            }
            "normal-disposition" => entry["legacyAdmission"]["disposition"] = json!("normal"),
            "failed-disposition" => entry["legacyAdmission"]["disposition"] = json!("legacyFailed"),
            _ => unreachable!(),
        }
        let before = replica.snapshot(&account).unwrap();
        assert!(
            execute(&replica, &account, vec![admit_missing(&entry)]).is_err(),
            "{invalid}"
        );
        assert_eq!(replica.snapshot(&account).unwrap(), before);
        let mut rows = snapshot_rows(before.clone()).unwrap();
        rows.push(StoredReplicaRow {
            store: ReplicaStore::CrossAccountMoves,
            key: crate::replica::persistence_contract::ReplicaRowKey {
                account_id: account.clone(),
                record_id: original.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&entry).unwrap(),
        });
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert!(coverage(head(&before), &ordered).is_err(), "{invalid}");
            assert!(
                reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err(),
                "{invalid}"
            );
        }
    }
    for history in ["pending", "retrying", "failed"] {
        let (replica, account, original, entry) = missing_source_fixture();
        let entry = match history {
            "retrying" => retrying_missing_source_entry(entry, 1, ""),
            "failed" => failed_missing_source_entry(entry, ""),
            _ => entry,
        };
        let mut forbidden_copy = entry.clone();
        forbidden_copy["legacyAdmission"]["sourceCommand"]["conflictCopyId"] =
            json!("independent-copy");
        let before = replica.snapshot(&account).unwrap();
        assert!(execute(&replica, &account, vec![admit_missing(&forbidden_copy)]).is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), before);
        let mut rows = snapshot_rows(before.clone()).unwrap();
        rows.push(StoredReplicaRow {
            store: ReplicaStore::CrossAccountMoves,
            key: crate::replica::persistence_contract::ReplicaRowKey {
                account_id: account.clone(),
                record_id: original.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&forbidden_copy).unwrap(),
        });
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert!(coverage(head(&before), &ordered).is_err(), "{history}");
            assert!(
                reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err(),
                "{history}"
            );
        }
        execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
        let after = replica.snapshot(&account).unwrap();
        assert_eq!(
            serde_json::to_value(&after.cross_account_moves).unwrap(),
            json!([entry])
        );
        assert_eq!(
            after.item_has_optimistic_owner(&original.source.id),
            history != "failed"
        );
    }
}

fn failed_zero_missing_source_entry(
    mut entry: serde_json::Value,
    error: &str,
) -> serde_json::Value {
    entry["legacyAdmission"]["disposition"] = json!("legacyFailed");
    entry["legacyAdmission"]["sourceCommand"]["status"] = json!("failed");
    entry["legacyAdmission"]["sourceCommand"]["lastError"] = json!(error);
    entry
}

#[test]
fn missing_source_failed_zero_preserves_exact_inactive_history_and_recovery() {
    // Domain compatibility values, not fabricated producer outcome evidence.
    for error in ["vault_read_only", "", "rejection; local diagnostic"] {
        let (replica, account, original, entry) = missing_source_fixture();
        let entry = failed_zero_missing_source_entry(entry, error);
        let before = replica.snapshot(&account).unwrap();
        let prepared = prepare_commit(
            before.clone(),
            GuardedCommitPlan::new(
                account.clone(),
                before.incarnation.clone(),
                before.revision,
                before.lock_epoch,
                vec![admit_missing(&entry)],
            ),
        )
        .expect("Failed0 original history must preserve its inactive owner");
        execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
        let after = replica.snapshot(&account).unwrap();
        assert_eq!(after, prepared.next_snapshot);
        assert_eq!(after.bootstrap, before.bootstrap);
        assert!(after.operations.is_empty());
        assert!(after.items.is_empty());
        assert!(after.receipts.is_empty());
        assert!(!after.item_has_optimistic_owner(&original.source.id));
        assert_eq!(
            serde_json::to_value(&after.cross_account_moves).unwrap(),
            json!([entry])
        );
        assert_eq!(
            after.cross_account_moves[0].reserved_child_operation_ids(),
            vec![
                format!("{}:create-target", original.operation_id),
                format!("{}:trash-source", original.operation_id),
                format!("{}:delete-source", original.operation_id),
            ]
        );
        assert_eq!(prepared.wire.writes.len(), 1);
        assert!(
            matches!(&prepared.wire.writes[0], PreparedReplicaWrite::Put {row} if row.store == ReplicaStore::CrossAccountMoves)
        );
        let rows = snapshot_rows(after.clone()).unwrap();
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            let proof = coverage(head(&after), &ordered).unwrap();
            assert_eq!(proof.operation_count, 1);
            assert!(proof.required_attachments.is_empty());
            assert_eq!(
                reconstruct_snapshot(&account, Some(head(&after)), ordered).unwrap(),
                Some(after.clone())
            );
        }
    }
}

#[test]
fn missing_source_failed_zero_rejects_mixed_history_at_guard_and_recovery() {
    for invalid in [
        "count-one",
        "count-six-same-attempt",
        "reminted-attempt",
        "missing-attempt",
        "copy",
        "deadline",
        "missing-error",
        "normal",
        "conflicted",
    ] {
        let (replica, account, original, entry) = missing_source_fixture();
        let mut entry = failed_zero_missing_source_entry(entry, "");
        match invalid {
            "count-one" | "count-six-same-attempt" => {
                let count = if invalid == "count-one" { "1" } else { "6" };
                entry["legacyAdmission"]["sourceCommand"]["retryCount"] = json!(count);
                entry["scheduling"]["attemptCount"] = json!(count);
            }
            "reminted-attempt" => {
                entry["legacyAdmission"]["sourceCommand"]["attemptId"] = json!("other-attempt")
            }
            "missing-attempt" => {
                entry["legacyAdmission"]["sourceCommand"]
                    .as_object_mut()
                    .unwrap()
                    .remove("attemptId");
            }
            "copy" => {
                entry["legacyAdmission"]["sourceCommand"]["conflictCopyId"] =
                    json!("historical-copy")
            }
            "deadline" => {
                entry["legacyAdmission"]["sourceCommand"]["nextAttemptAt"] = json!("42");
                entry["scheduling"]["notBeforeMs"] = json!("42");
            }
            "missing-error" => {
                entry["legacyAdmission"]["sourceCommand"]
                    .as_object_mut()
                    .unwrap()
                    .remove("lastError");
            }
            "normal" => entry["legacyAdmission"]["disposition"] = json!("normal"),
            "conflicted" => entry["legacyAdmission"]["disposition"] = json!("legacyConflicted"),
            _ => unreachable!(),
        }
        let before = replica.snapshot(&account).unwrap();
        assert!(
            execute(&replica, &account, vec![admit_missing(&entry)]).is_err(),
            "{invalid}"
        );
        assert_eq!(replica.snapshot(&account).unwrap(), before);
        let mut rows = snapshot_rows(before.clone()).unwrap();
        rows.push(StoredReplicaRow {
            store: ReplicaStore::CrossAccountMoves,
            key: crate::replica::persistence_contract::ReplicaRowKey {
                account_id: account.clone(),
                record_id: original.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&entry).unwrap(),
        });
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert!(coverage(head(&before), &ordered).is_err(), "{invalid}");
            assert!(
                reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err(),
                "{invalid}"
            );
        }
    }
}

#[test]
fn missing_source_failed_zero_keeps_identity_fences_against_inactive_work() {
    for suffix in [
        None,
        Some("create-target"),
        Some("trash-source"),
        Some("delete-source"),
    ] {
        let (replica, account, original, entry) = missing_source_fixture();
        let mut other = original.clone();
        other.source.id = "other-source".into();
        let (mut operation, mut overlay) = same_item_create(&other, true);
        let id = suffix.map_or_else(
            || original.operation_id.clone(),
            |suffix| format!("{}:{suffix}", original.operation_id),
        );
        operation.operation_id = id.clone();
        operation
            .legacy_admission
            .as_mut()
            .unwrap()
            .source_command
            .id = id.clone();
        overlay.operation_id = id;
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
        let entry = failed_zero_missing_source_entry(entry, "");
        assert!(execute(&replica, &account, vec![admit_missing(&entry)]).is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), before);
    }
}

fn post_retry_held_entry(
    entry: serde_json::Value,
    conflicted: bool,
    count: u64,
    error: &str,
) -> serde_json::Value {
    let mut entry = retrying_missing_source_entry(entry, count, error);
    entry["legacyAdmission"]["disposition"] = json!(if conflicted {
        "legacyConflicted"
    } else {
        "legacyFailed"
    });
    entry["legacyAdmission"]["sourceCommand"]["status"] =
        json!(if conflicted { "conflicted" } else { "failed" });
    entry["legacyAdmission"]["sourceCommand"]
        .as_object_mut()
        .unwrap()
        .remove("nextAttemptAt");
    if conflicted {
        entry["legacyAdmission"]["sourceCommand"]["conflictCopyId"] = json!("independent-copy");
    }
    entry["scheduling"]["notBeforeMs"] = json!("0");
    entry
}

#[test]
fn missing_source_post_retry_held_preserves_all_counts_through_retirement_and_recovery() {
    for conflicted in [false, true] {
        for count in 1..=4 {
            for error in ["original terminal diagnostic", ""] {
                let (replica, account, original, entry) = missing_source_fixture();
                let mut expected = post_retry_held_entry(entry, conflicted, count, error);
                execute(&replica, &account, vec![admit_missing(&expected)])
                    .expect("post-retry terminal provenance must preserve an inactive owner");
                let admitted = replica.snapshot(&account).unwrap();
                assert_eq!(
                    serde_json::to_value(&admitted.cross_account_moves).unwrap(),
                    json!([expected])
                );
                assert!(!admitted.item_has_optimistic_owner(&original.source.id));
                assert!(admitted.items.is_empty());
                assert!(admitted.operations.is_empty());
                assert!(admitted.receipts.is_empty());
                assert_eq!(
                    admitted.cross_account_moves[0].reserved_child_operation_ids(),
                    vec![
                        format!("{}:create-target", original.operation_id),
                        format!("{}:trash-source", original.operation_id),
                        format!("{}:delete-source", original.operation_id)
                    ]
                );
                assert!(execute(
                    &replica,
                    &account,
                    vec![PlanMutation::PutOptimisticItem(
                        original.source_overlay(&account)
                    )]
                )
                .is_err());
                assert_eq!(replica.snapshot(&account).unwrap(), admitted);
                execute(
                    &replica,
                    &account,
                    vec![PlanMutation::RetireCrossAccountMoveDestination {
                        operation_id: original.operation_id.clone(),
                        expected_binding_revision: 0,
                        target_account_id: original.destination_binding.account_id.clone(),
                        target_incarnation: original.destination_binding.incarnation.clone(),
                    }],
                )
                .unwrap();
                expected["destinationBinding"]["status"] = json!("retired");
                expected["destinationBinding"]["bindingRevision"] = json!("1");
                let retired = replica.snapshot(&account).unwrap();
                assert_eq!(
                    serde_json::to_value(&retired.cross_account_moves).unwrap(),
                    json!([expected])
                );
                assert_eq!(retired.bootstrap, admitted.bootstrap);
                assert!(retired.items.is_empty());
                assert!(!retired.item_has_optimistic_owner(&original.source.id));
                for snapshot in [&admitted, &retired] {
                    let rows = snapshot_rows(snapshot.clone()).unwrap();
                    for reverse in [false, true] {
                        let mut ordered = rows.clone();
                        if reverse {
                            ordered.reverse();
                        }
                        let proof = coverage(head(snapshot), &ordered).unwrap();
                        assert_eq!(proof.operation_count, 1);
                        assert!(proof.required_attachments.is_empty());
                        assert_eq!(
                            reconstruct_snapshot(&account, Some(head(snapshot)), ordered).unwrap(),
                            Some(snapshot.clone())
                        );
                    }
                }
            }
        }
    }
}

#[test]
fn missing_source_post_retry_held_rejects_mixed_history_and_reserved_ids() {
    for conflicted in [false, true] {
        for invalid in [
            "same-attempt",
            "empty-attempt",
            "missing-attempt",
            "zero-reminted",
            "six",
            "conflicted-five",
            "deadline",
            "missing-error",
            "wrong-disposition",
            "copy-shape",
            "schedule",
        ] {
            if invalid == "conflicted-five" && !conflicted {
                continue; // Failed5 remains a supported exhausted-retry history.
            }
            if invalid == "same-attempt" && conflicted {
                continue; // Reconciliation-read retries now preserve this exact Conflicted history.
            }
            let (replica, account, original, entry) = missing_source_fixture();
            let mut entry = post_retry_held_entry(entry, conflicted, 2, "");
            match invalid {
                "same-attempt" => {
                    entry["legacyAdmission"]["sourceCommand"]["attemptId"] =
                        json!(original.operation_id)
                }
                "empty-attempt" => {
                    entry["legacyAdmission"]["sourceCommand"]["attemptId"] = json!("")
                }
                "missing-attempt" => {
                    entry["legacyAdmission"]["sourceCommand"]
                        .as_object_mut()
                        .unwrap()
                        .remove("attemptId");
                }
                "zero-reminted" | "six" | "conflicted-five" => {
                    let count = match invalid {
                        "six" => "6",
                        "conflicted-five" => "5",
                        _ => "0",
                    };
                    entry["legacyAdmission"]["sourceCommand"]["retryCount"] = json!(count);
                    entry["scheduling"]["attemptCount"] = json!(count);
                }
                "deadline" => {
                    entry["legacyAdmission"]["sourceCommand"]["nextAttemptAt"] = json!("42");
                    // Failed2 may retain the exact deadline; only a mixed schedule is invalid.
                    // Conflicted still cannot retain any deadline.
                    entry["scheduling"]["notBeforeMs"] =
                        json!(if conflicted { "42" } else { "43" });
                }
                "missing-error" => {
                    entry["legacyAdmission"]["sourceCommand"]
                        .as_object_mut()
                        .unwrap()
                        .remove("lastError");
                }
                "wrong-disposition" => entry["legacyAdmission"]["disposition"] = json!("normal"),
                "copy-shape" => {
                    if conflicted {
                        entry["legacyAdmission"]["sourceCommand"]
                            .as_object_mut()
                            .unwrap()
                            .remove("conflictCopyId");
                    } else {
                        entry["legacyAdmission"]["sourceCommand"]["conflictCopyId"] =
                            json!("other-copy");
                    }
                }
                "schedule" => entry["scheduling"]["attemptCount"] = json!("3"),
                _ => unreachable!(),
            }
            let before = replica.snapshot(&account).unwrap();
            assert!(
                execute(&replica, &account, vec![admit_missing(&entry)]).is_err(),
                "{conflicted}/{invalid}"
            );
            assert_eq!(replica.snapshot(&account).unwrap(), before);
            let mut rows = snapshot_rows(before.clone()).unwrap();
            rows.push(StoredReplicaRow {
                store: ReplicaStore::CrossAccountMoves,
                key: crate::replica::persistence_contract::ReplicaRowKey {
                    account_id: account.clone(),
                    record_id: original.operation_id.clone(),
                },
                payload_json: serde_json::to_string(&entry).unwrap(),
            });
            for reverse in [false, true] {
                let mut ordered = rows.clone();
                if reverse {
                    ordered.reverse();
                }
                assert!(
                    coverage(head(&before), &ordered).is_err(),
                    "{conflicted}/{invalid}"
                );
                assert!(
                    reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err(),
                    "{conflicted}/{invalid}"
                );
            }
        }
        for suffix in [
            None,
            Some("create-target"),
            Some("trash-source"),
            Some("delete-source"),
        ] {
            let (replica, account, original, entry) = missing_source_fixture();
            let mut other = original.clone();
            other.source.id = "other-source".into();
            let (mut operation, mut overlay) = same_item_create(&other, true);
            let id = suffix.map_or_else(
                || original.operation_id.clone(),
                |suffix| format!("{}:{suffix}", original.operation_id),
            );
            operation.operation_id = id.clone();
            operation
                .legacy_admission
                .as_mut()
                .unwrap()
                .source_command
                .id = id.clone();
            overlay.operation_id = id;
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
                vec![admit_missing(&post_retry_held_entry(
                    entry, conflicted, 3, ""
                ))]
            )
            .is_err());
            assert_eq!(replica.snapshot(&account).unwrap(), before);
        }
    }
}

#[test]
fn missing_source_reconciliation_held_preserves_original_attempt_history_and_retirement() {
    // Domain values isolate history policy; public artifacts prove the actual GET-failure path.
    for (conflicted, count) in [(true, 1), (true, 2), (true, 3), (true, 4), (false, 5)] {
        for error in ["transport diagnostic", ""] {
            let (replica, account, original, entry) = missing_source_fixture();
            let mut expected = post_retry_held_entry(entry, conflicted, count, error);
            expected["legacyAdmission"]["sourceCommand"]["attemptId"] =
                json!(original.operation_id);
            execute(&replica, &account, vec![admit_missing(&expected)])
                .expect("reconciliation retries retain their original attempt in held evidence");
            let before = replica.snapshot(&account).unwrap();
            assert_eq!(
                serde_json::to_value(&before.cross_account_moves).unwrap(),
                json!([expected])
            );
            assert!(!before.item_has_optimistic_owner(&original.source.id));
            assert!(before.items.is_empty());
            assert!(before.operations.is_empty());
            assert!(before.receipts.is_empty());
            assert_eq!(
                before.cross_account_moves[0].reserved_child_operation_ids(),
                vec![
                    format!("{}:create-target", original.operation_id),
                    format!("{}:trash-source", original.operation_id),
                    format!("{}:delete-source", original.operation_id)
                ]
            );
            assert!(execute(
                &replica,
                &account,
                vec![PlanMutation::PutOptimisticItem(
                    original.source_overlay(&account)
                )]
            )
            .is_err());
            assert_eq!(replica.snapshot(&account).unwrap(), before);
            execute(
                &replica,
                &account,
                vec![PlanMutation::RetireCrossAccountMoveDestination {
                    operation_id: original.operation_id.clone(),
                    expected_binding_revision: 0,
                    target_account_id: original.destination_binding.account_id.clone(),
                    target_incarnation: original.destination_binding.incarnation.clone(),
                }],
            )
            .unwrap();
            expected["destinationBinding"]["status"] = json!("retired");
            expected["destinationBinding"]["bindingRevision"] = json!("1");
            let after = replica.snapshot(&account).unwrap();
            assert_eq!(
                serde_json::to_value(&after.cross_account_moves).unwrap(),
                json!([expected])
            );
            assert_eq!(after.bootstrap, before.bootstrap);
            assert!(!after.item_has_optimistic_owner(&original.source.id));
            for snapshot in [&before, &after] {
                let rows = snapshot_rows(snapshot.clone()).unwrap();
                for reverse in [false, true] {
                    let mut ordered = rows.clone();
                    if reverse {
                        ordered.reverse();
                    }
                    let proof = coverage(head(snapshot), &ordered).unwrap();
                    assert_eq!(proof.operation_count, 1);
                    assert!(proof.required_attachments.is_empty());
                    assert_eq!(
                        reconstruct_snapshot(&account, Some(head(snapshot)), ordered).unwrap(),
                        Some(snapshot.clone())
                    );
                }
            }
        }
    }
}

#[test]
fn missing_source_reconciliation_held_retains_unsupported_history_boundaries() {
    for conflicted in [false, true] {
        for invalid in [
            "count-boundary",
            "empty-attempt",
            "missing-attempt",
            "wrong-operation",
            "deadline",
            "missing-error",
            "copy-shape",
            "wrong-disposition",
        ] {
            for boundary_count in 1..=4 {
                if boundary_count != 1 && (invalid != "count-boundary" || conflicted) {
                    continue;
                }
                let (replica, account, original, entry) = missing_source_fixture();
                let mut entry =
                    post_retry_held_entry(entry, conflicted, if conflicted { 1 } else { 5 }, "");
                entry["legacyAdmission"]["sourceCommand"]["attemptId"] =
                    json!(original.operation_id);
                match invalid {
                    "count-boundary" => {
                        let count = if conflicted { 5 } else { boundary_count };
                        entry["legacyAdmission"]["sourceCommand"]["retryCount"] =
                            json!(count.to_string());
                        entry["scheduling"]["attemptCount"] = json!(count.to_string());
                    }
                    "empty-attempt" => {
                        entry["legacyAdmission"]["sourceCommand"]["attemptId"] = json!("")
                    }
                    "missing-attempt" => {
                        entry["legacyAdmission"]["sourceCommand"]
                            .as_object_mut()
                            .unwrap()
                            .remove("attemptId");
                    }
                    "wrong-operation" => {
                        entry["legacyAdmission"]["sourceCommand"]["operationId"] =
                            json!("other-operation")
                    }
                    "deadline" => {
                        entry["legacyAdmission"]["sourceCommand"]["nextAttemptAt"] = json!("42");
                        entry["scheduling"]["notBeforeMs"] = json!("42");
                    }
                    "missing-error" => {
                        entry["legacyAdmission"]["sourceCommand"]
                            .as_object_mut()
                            .unwrap()
                            .remove("lastError");
                    }
                    "copy-shape" => {
                        if conflicted {
                            entry["legacyAdmission"]["sourceCommand"]
                                .as_object_mut()
                                .unwrap()
                                .remove("conflictCopyId");
                        } else {
                            entry["legacyAdmission"]["sourceCommand"]["conflictCopyId"] =
                                json!("unexpected-copy");
                        }
                    }
                    "wrong-disposition" => {
                        entry["legacyAdmission"]["disposition"] = json!("normal")
                    }
                    _ => unreachable!(),
                }
                let before = replica.snapshot(&account).unwrap();
                assert!(
                    execute(&replica, &account, vec![admit_missing(&entry)]).is_err(),
                    "{conflicted}/{invalid}/{boundary_count}"
                );
                assert_eq!(replica.snapshot(&account).unwrap(), before);
                let mut rows = snapshot_rows(before.clone()).unwrap();
                rows.push(StoredReplicaRow {
                    store: ReplicaStore::CrossAccountMoves,
                    key: crate::replica::persistence_contract::ReplicaRowKey {
                        account_id: account.clone(),
                        record_id: original.operation_id.clone(),
                    },
                    payload_json: serde_json::to_string(&entry).unwrap(),
                });
                for reverse in [false, true] {
                    let mut ordered = rows.clone();
                    if reverse {
                        ordered.reverse();
                    }
                    assert!(coverage(head(&before), &ordered).is_err());
                    assert!(reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err());
                }
            }
        }
    }
}

fn failed_retained_deadline_entry(
    entry: serde_json::Value,
    count: u64,
    original_attempt: bool,
    error: &str,
) -> serde_json::Value {
    let mut entry = retrying_missing_source_entry(entry, count, error);
    entry["legacyAdmission"]["sourceCommand"]["status"] = json!("failed");
    entry["legacyAdmission"]["disposition"] = json!("legacyFailed");
    if original_attempt {
        entry["legacyAdmission"]["sourceCommand"]["attemptId"] = entry["operationId"].clone();
    }
    entry
}

#[test]
fn missing_source_failed_retained_deadline_preserves_both_attempt_histories_as_inactive_owners() {
    for count in 1..=4 {
        for original_attempt in [false, true] {
            for error in ["typed HTTP400 diagnostic", ""] {
                for role in [
                    crate::replica::AuthorityVaultRole::Owner,
                    crate::replica::AuthorityVaultRole::ReadOnly,
                ] {
                    let (replica, account, original, entry) =
                        missing_source_fixture_with_authority(role, false);
                    let mut expected =
                        failed_retained_deadline_entry(entry, count, original_attempt, error);
                    execute(&replica, &account, vec![admit_missing(&expected)])
                        .expect("Failed HTTP400 retains the original retry deadline");
                    let before = replica.snapshot(&account).unwrap();
                    assert_eq!(
                        serde_json::to_value(&before.cross_account_moves).unwrap(),
                        json!([expected])
                    );
                    assert_eq!(
                        before.cross_account_moves[0].reserved_child_operation_ids(),
                        vec![
                            format!("{}:create-target", original.operation_id),
                            format!("{}:trash-source", original.operation_id),
                            format!("{}:delete-source", original.operation_id),
                        ]
                    );
                    assert!(!before.item_has_optimistic_owner(&original.source.id));
                    assert!(before.items.is_empty());
                    assert!(before.operations.is_empty());
                    assert!(before.receipts.is_empty());
                    assert!(execute(
                        &replica,
                        &account,
                        vec![PlanMutation::PutOptimisticItem(
                            original.source_overlay(&account)
                        )]
                    )
                    .is_err());
                    assert_eq!(replica.snapshot(&account).unwrap(), before);
                    execute(
                        &replica,
                        &account,
                        vec![PlanMutation::RetireCrossAccountMoveDestination {
                            operation_id: original.operation_id.clone(),
                            expected_binding_revision: 0,
                            target_account_id: original.destination_binding.account_id.clone(),
                            target_incarnation: original.destination_binding.incarnation.clone(),
                        }],
                    )
                    .unwrap();
                    expected["destinationBinding"]["status"] = json!("retired");
                    expected["destinationBinding"]["bindingRevision"] = json!("1");
                    let after = replica.snapshot(&account).unwrap();
                    assert_eq!(
                        serde_json::to_value(&after.cross_account_moves).unwrap(),
                        json!([expected])
                    );
                    assert!(!after.item_has_optimistic_owner(&original.source.id));
                    for snapshot in [&before, &after] {
                        let rows = snapshot_rows(snapshot.clone()).unwrap();
                        for reverse in [false, true] {
                            let mut ordered = rows.clone();
                            if reverse {
                                ordered.reverse();
                            }
                            assert_eq!(
                                coverage(head(snapshot), &ordered).unwrap().operation_count,
                                1
                            );
                            assert_eq!(
                                reconstruct_snapshot(&account, Some(head(snapshot)), ordered)
                                    .unwrap(),
                                Some(snapshot.clone())
                            );
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn missing_source_failed_retained_deadline_rejects_mixed_and_unsupported_histories() {
    for original_attempt in [false, true] {
        for invalid in [
            "count-zero",
            "count-five",
            "missing-deadline",
            "missing-attempt",
            "empty-attempt",
            "wrong-operation",
            "missing-error",
            "wrong-disposition",
            "conflicted",
            "copy",
            "schedule-mismatch",
        ] {
            if invalid == "missing-deadline" && !original_attempt {
                continue; // Reminted Failed1..4 without a deadline is an earlier valid history.
            }
            let (replica, account, original, entry) = missing_source_fixture();
            let mut entry = failed_retained_deadline_entry(entry, 2, original_attempt, "");
            let command = &mut entry["legacyAdmission"]["sourceCommand"];
            match invalid {
                "count-zero" | "count-five" => {
                    let count = if invalid == "count-zero" { "0" } else { "5" };
                    command["retryCount"] = json!(count);
                    entry["scheduling"]["attemptCount"] = json!(count);
                }
                "missing-deadline" => {
                    command.as_object_mut().unwrap().remove("nextAttemptAt");
                    entry["scheduling"]["notBeforeMs"] = json!("0");
                }
                "missing-attempt" => {
                    command.as_object_mut().unwrap().remove("attemptId");
                }
                "empty-attempt" => command["attemptId"] = json!(""),
                "wrong-operation" => command["operationId"] = json!("other-operation"),
                "missing-error" => {
                    command.as_object_mut().unwrap().remove("lastError");
                }
                "wrong-disposition" => entry["legacyAdmission"]["disposition"] = json!("normal"),
                "conflicted" => command["status"] = json!("conflicted"),
                "copy" => command["conflictCopyId"] = json!("unrelated-copy"),
                "schedule-mismatch" => entry["scheduling"]["notBeforeMs"] = json!("1"),
                _ => unreachable!(),
            }
            let before = replica.snapshot(&account).unwrap();
            assert!(
                execute(&replica, &account, vec![admit_missing(&entry)]).is_err(),
                "{original_attempt}/{invalid}"
            );
            assert_eq!(replica.snapshot(&account).unwrap(), before);
            let mut rows = snapshot_rows(before.clone()).unwrap();
            rows.push(StoredReplicaRow {
                store: ReplicaStore::CrossAccountMoves,
                key: crate::replica::persistence_contract::ReplicaRowKey {
                    account_id: account.clone(),
                    record_id: original.operation_id.clone(),
                },
                payload_json: serde_json::to_string(&entry).unwrap(),
            });
            for reverse in [false, true] {
                let mut ordered = rows.clone();
                if reverse {
                    ordered.reverse();
                }
                assert!(coverage(head(&before), &ordered).is_err());
                assert!(reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err());
            }
        }
    }
}

// These two statuses come from distinct stopped producer owners. Domain fixtures keep the
// already-accepted immutable Move request; the public SQLite tests consume the raw captures.
fn preprojection_missing_source_entry(
    mut entry: serde_json::Value,
    status: &str,
) -> serde_json::Value {
    let command = &mut entry["legacyAdmission"]["sourceCommand"];
    command["status"] = json!(status);
    if status == "staged" {
        command["projectionClaimId"] = json!("popup-projection-claim");
        command["projectionClaimExpiresAt"] = json!("30001");
    }
    entry
}

#[test]
fn missing_source_preprojection_cuts_keep_exact_inactive_lineage_and_recover_in_both_orders() {
    for status in ["staged", "applying"] {
        let (replica, account, original, entry) = missing_source_fixture();
        let entry = preprojection_missing_source_entry(entry, status);
        let before = replica.snapshot(&account).unwrap();
        let prepared = prepare_commit(
            before.clone(),
            GuardedCommitPlan::new(
                account.clone(),
                before.incarnation.clone(),
                before.revision,
                before.lock_epoch,
                vec![admit_missing(&entry)],
            ),
        )
        .expect("genuine stopped projection history must admit without original execution");
        execute(&replica, &account, vec![admit_missing(&entry)]).unwrap();
        let after = replica.snapshot(&account).unwrap();
        assert_eq!(after, prepared.next_snapshot, "{status}");
        assert_eq!(
            serde_json::to_value(&after.cross_account_moves).unwrap(),
            json!([entry])
        );
        assert_eq!(
            after.cross_account_moves[0].operation_id(),
            original.operation_id.as_str()
        );
        assert_eq!(
            after.cross_account_moves[0].reserved_child_operation_ids(),
            vec![
                format!("{}:create-target", original.operation_id),
                format!("{}:trash-source", original.operation_id),
                format!("{}:delete-source", original.operation_id),
            ]
        );
        assert_eq!(after.cross_account_moves[0].scheduling().attempt_count, 0);
        assert_eq!(after.cross_account_moves[0].scheduling().not_before_ms, 0);
        assert!(after.operations.is_empty() && after.receipts.is_empty() && after.items.is_empty());
        // Normal source-free work reserves the Item identity without owning an overlay.
        assert!(after.item_has_optimistic_owner(&original.source.id));
        assert!(execute(
            &replica,
            &account,
            vec![PlanMutation::PutOptimisticItem(
                original.source_overlay(&account),
            )]
        )
        .is_err());
        assert_eq!(replica.snapshot(&account).unwrap(), after);
        let rows = snapshot_rows(after.clone()).unwrap();
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            assert_eq!(coverage(head(&after), &ordered).unwrap().operation_count, 1);
            assert_eq!(
                reconstruct_snapshot(&account, Some(head(&after)), ordered).unwrap(),
                Some(after.clone())
            );
        }
    }
}

#[test]
fn missing_source_preprojection_cuts_reserve_semantic_and_all_three_child_ids() {
    for status in ["staged", "applying"] {
        for suffix in [
            None,
            Some("create-target"),
            Some("trash-source"),
            Some("delete-source"),
        ] {
            let (replica, account, original, entry) = missing_source_fixture();
            let mut unrelated = original.clone();
            unrelated.source.id = "independent-other-item".into();
            let (mut operation, mut overlay) = same_item_create(&unrelated, true);
            let reserved_id = suffix.map_or_else(
                || original.operation_id.clone(),
                |suffix| format!("{}:{suffix}", original.operation_id),
            );
            operation.operation_id = reserved_id.clone();
            operation
                .legacy_admission
                .as_mut()
                .unwrap()
                .source_command
                .id = reserved_id.clone();
            overlay.operation_id = reserved_id;
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
            let entry = preprojection_missing_source_entry(entry, status);
            assert!(
                execute(&replica, &account, vec![admit_missing(&entry)]).is_err(),
                "{status}/{suffix:?}"
            );
            assert_eq!(replica.snapshot(&account).unwrap(), before);
        }
    }
}

#[test]
fn missing_source_preprojection_cuts_refuse_mixed_claim_attempt_and_status_evidence() {
    for status in ["staged", "applying"] {
        for invalid in [
            "count-one",
            "missing-attempt",
            "reminted-attempt",
            "deadline",
            "diagnostic",
            "copy",
            "wrong-disposition",
            "wrong-status",
            "missing-claim",
            "missing-expiry",
            "empty-claim",
            "claim-on-applying",
            "expiry-on-applying",
        ] {
            if status == "staged" && matches!(invalid, "claim-on-applying" | "expiry-on-applying")
                || status == "applying"
                    && matches!(invalid, "missing-claim" | "missing-expiry" | "empty-claim")
            {
                continue;
            }
            let (replica, account, original, entry) = missing_source_fixture();
            let mut entry = preprojection_missing_source_entry(entry, status);
            let command = &mut entry["legacyAdmission"]["sourceCommand"];
            match invalid {
                "count-one" => {
                    command["retryCount"] = json!("1");
                    entry["scheduling"]["attemptCount"] = json!("1");
                }
                "missing-attempt" => {
                    command.as_object_mut().unwrap().remove("attemptId");
                }
                "reminted-attempt" => command["attemptId"] = json!("other-attempt"),
                "deadline" => {
                    command["nextAttemptAt"] = json!("1001");
                    entry["scheduling"]["notBeforeMs"] = json!("1001");
                }
                "diagnostic" => command["lastError"] = json!("historical error"),
                "copy" => command["conflictCopyId"] = json!("unproved-copy"),
                "wrong-disposition" => {
                    entry["legacyAdmission"]["disposition"] = json!("legacyFailed")
                }
                "wrong-status" => command["status"] = json!("retrying"),
                "missing-claim" => {
                    command.as_object_mut().unwrap().remove("projectionClaimId");
                }
                "missing-expiry" => {
                    command
                        .as_object_mut()
                        .unwrap()
                        .remove("projectionClaimExpiresAt");
                }
                "empty-claim" => command["projectionClaimId"] = json!(""),
                "claim-on-applying" => command["projectionClaimId"] = json!("unexpected-claim"),
                "expiry-on-applying" => command["projectionClaimExpiresAt"] = json!("30001"),
                _ => unreachable!(),
            }
            let before = replica.snapshot(&account).unwrap();
            assert!(
                execute(&replica, &account, vec![admit_missing(&entry)]).is_err(),
                "{status}/{invalid}"
            );
            assert_eq!(replica.snapshot(&account).unwrap(), before);
            let mut rows = snapshot_rows(before.clone()).unwrap();
            rows.push(StoredReplicaRow {
                store: ReplicaStore::CrossAccountMoves,
                key: crate::replica::persistence_contract::ReplicaRowKey {
                    account_id: account.clone(),
                    record_id: original.operation_id.clone(),
                },
                payload_json: serde_json::to_string(&entry).unwrap(),
            });
            for reverse in [false, true] {
                let mut ordered = rows.clone();
                if reverse {
                    ordered.reverse();
                }
                assert!(
                    coverage(head(&before), &ordered).is_err(),
                    "{status}/{invalid}"
                );
                assert!(
                    reconstruct_snapshot(&account, Some(head(&before)), ordered).is_err(),
                    "{status}/{invalid}"
                );
            }
        }
    }
}
