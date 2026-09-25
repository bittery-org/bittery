//! Recovery keeps original workflow evidence and reserves children before they materialize.
use super::*;
use crate::replica::persistence_contract::{ReplicaRowKey, StoredReplicaRow};
use serde_json::json;

fn workflow_rows() -> (ReplicaHead, Vec<StoredReplicaRow>) {
    let (head, mut rows) = corpus_loaded_rows()
        .into_iter()
        .find(|(_, rows)| {
            rows.iter().any(|row| {
                if row.store != ReplicaStore::CrossAccountMoves {
                    return false;
                }
                let record: CrossAccountMoveRecord = decode(&row.payload_json).unwrap();
                record.stage == CrossAccountMoveStage::TargetCreate
                    && record.attachments.is_empty()
                    && record.children[0].item().unwrap().result.is_none()
            })
        })
        .expect("the maintained workflow corpus contains initial accepted work");
    let row = rows
        .iter_mut()
        .find(|row| row.store == ReplicaStore::CrossAccountMoves)
        .unwrap();
    let mut record: CrossAccountMoveRecord = decode(&row.payload_json).unwrap();
    assert_eq!(record.target.category, AuthorityItemCategory::Login);
    record.target.id = "legacy-target:/雪".into();
    record.target.vault_id = "legacy-vault:/雪".into();
    let body = format!(
        r#"{{"category":"login","encryptedData":{},"encryptionIv":{},"encryptionAlgorithm":{}}}"#,
        serde_json::to_string(&record.target.encrypted_data).unwrap(),
        serde_json::to_string(&record.target.encryption_iv).unwrap(),
        serde_json::to_string(&record.target.encryption_algorithm).unwrap(),
    )
    .into_bytes();
    let child = record.children[0].item_mut().unwrap();
    child.operation_id = format!("{}:create-target", record.operation_id);
    child.target = ResourceRef::Item {
        item_id: record.target.id.clone(),
        vault_id: record.target.vault_id.clone(),
    };
    child.request.path = format!(
        "/api/v1/vaults/{}/items/{}",
        encode_component(&record.target.vault_id),
        encode_component(&record.target.id),
    );
    child.request_fingerprint =
        create_item_fingerprint(&record.target.vault_id, &record.target.id, &body);
    child.request.body = body;
    let mut value = serde_json::to_value(&record).unwrap();
    value["legacyAdmission"] = json!({
        "version": 1,
        "admissionId": "legacy-cross-admission",
        "sourceQueueIndex": "2",
        "disposition": "normal",
        "sourceCommand": {
            "accountId": head.account_id,
            "id": "legacy-cross-command",
            "operationId": record.operation_id,
            "attemptId": "legacy-cross-attempt",
            "type": "cross_account_move",
            "entityId": record.source.id,
            "vaultId": record.source.vault_id,
            "targetAccountId": record.destination_binding.account_id,
            "targetItemId": record.target.id,
            "targetVaultId": record.target.vault_id,
            "category": "login",
            "encryptedPayload": {
                "type": "target",
                "encryptionVersion": 1,
                "encryptedByUserId": record.destination_identity.user_id
            },
            "baseVersion": record.source.version,
            "timestamp": "1770000000000",
            "retryCount": "0",
            "status": "pending"
        }
    });
    row.payload_json = serde_json::to_string(&value).unwrap();
    (head, rows)
}

fn coverage(head: ReplicaHead, rows: &[StoredReplicaRow]) -> Result<CoverageProof, RuntimeError> {
    let mut coverage = RecoveryCoverage::new(head)?;
    for row in rows {
        coverage.push_row(row.store, &row.key.record_id, &row.payload_json)?;
    }
    coverage.finish()
}

#[test]
fn legacy_workflow_recovery_preserves_exact_evidence_and_source_overlay_in_either_row_order() {
    let (head, rows) = workflow_rows();
    let accepted = rows
        .iter()
        .filter(|row| {
            matches!(
                row.store,
                ReplicaStore::CrossAccountMoves | ReplicaStore::OptimisticItems
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(accepted.len(), 2);
    for reverse in [false, true] {
        let mut ordered = rows.clone();
        if reverse {
            ordered.reverse();
        }
        let proof = coverage(head.clone(), &ordered).unwrap();
        assert!(proof.authority_valid);
        assert_eq!(proof.operation_count, 1);
        assert_eq!(proof.accepted_rows().count(), 2);
        for row in &accepted {
            let hash: [u8; 32] = Sha256::digest(row.payload_json.as_bytes()).into();
            assert!(proof.accepted_rows().any(|retained| {
                retained.store == row.store
                    && retained.record_id == row.key.record_id
                    && retained.payload_sha256 == hash
            }));
        }
    }
    let mut changed = rows;
    let overlay = changed
        .iter_mut()
        .find(|row| row.store == ReplicaStore::OptimisticItems)
        .unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&overlay.payload_json).unwrap();
    value["favorite"] = json!(true);
    overlay.payload_json = serde_json::to_string(&value).unwrap();
    assert!(coverage(head, &changed).is_err());
}

#[test]
fn legacy_workflow_recovery_keeps_source_history_beside_evolved_scheduling_in_either_row_order() {
    use crate::replica::persistence_contract::reconstruct_snapshot;

    for status in [
        None,
        Some("staged"),
        Some("applying"),
        Some("pending"),
        Some("retrying"),
    ] {
        for evolved in [false, true] {
            let (head, mut rows) = workflow_rows();
            let row = rows
                .iter_mut()
                .find(|row| row.store == ReplicaStore::CrossAccountMoves)
                .unwrap();
            let mut value: serde_json::Value = serde_json::from_str(&row.payload_json).unwrap();
            let children = value["children"].clone();
            let source = &mut value["legacyAdmission"]["sourceCommand"];
            if let Some(status) = status {
                source["status"] = json!(status);
            } else {
                source.as_object_mut().unwrap().remove("status");
            }
            source["attemptId"] = json!("reminted-attachment-attempt");
            source["retryCount"] = json!("3");
            source["lastError"] = json!("source client acquisition failed before any child");
            source["nextAttemptAt"] = json!("1800000000000");
            source["projectionClaimId"] = json!("departed-projector");
            source["projectionClaimExpiresAt"] = json!("1800000000500");
            let captured_source = source.clone();
            value["scheduling"]["attemptCount"] = json!(if evolved { "4" } else { "3" });
            value["scheduling"]["notBeforeMs"] = json!(if evolved {
                "1800000001000"
            } else {
                "1800000000000"
            });
            row.payload_json = serde_json::to_string(&value).unwrap();
            let expected: CrossAccountMoveRecord = decode(&row.payload_json).unwrap();
            assert_eq!(expected.children.len(), 1);
            assert!(expected.children[0].item().unwrap().result.is_none());
            assert_eq!(expected.stage, CrossAccountMoveStage::TargetCreate);
            let accepted = rows
                .iter()
                .filter(|row| {
                    matches!(
                        row.store,
                        ReplicaStore::CrossAccountMoves | ReplicaStore::OptimisticItems
                    )
                })
                .cloned()
                .collect::<Vec<_>>();
            assert_eq!(accepted.len(), 2);
            for reverse in [false, true] {
                let mut ordered = rows.clone();
                if reverse {
                    ordered.reverse();
                }
                let proof = coverage(head.clone(), &ordered).unwrap();
                assert!(proof.authority_valid);
                assert_eq!(proof.operation_count, 1);
                assert_eq!(proof.accepted_rows().count(), 2);
                assert_eq!(proof.receipt_count, 0);
                for row in &accepted {
                    let hash: [u8; 32] = Sha256::digest(row.payload_json.as_bytes()).into();
                    assert!(proof.accepted_rows().any(|retained| {
                        retained.store == row.store
                            && retained.record_id == row.key.record_id
                            && retained.payload_sha256 == hash
                    }));
                }
                let reopened = reconstruct_snapshot(&head.account_id, Some(head.clone()), ordered)
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    reopened.cross_account_moves,
                    vec![CrossAccountMoveEntry::from(expected.clone())]
                );
                assert_eq!(reopened.items.len(), 1);
                let retained =
                    serde_json::to_value(reopened.cross_account_moves[0].captured().unwrap())
                        .unwrap();
                assert_eq!(
                    retained["legacyAdmission"]["sourceCommand"],
                    captured_source
                );
                assert_eq!(retained["children"], children);
                assert_eq!(reopened.items[0], expected.source_overlay(&head.account_id));
                assert!(reopened.operations.is_empty());
            }
        }
    }
}

#[test]
fn legacy_workflow_recovery_reserves_original_children_before_source_effects_exist() {
    let (head, original) = workflow_rows();
    let value: serde_json::Value = serde_json::from_str(
        &original
            .iter()
            .find(|row| row.store == ReplicaStore::CrossAccountMoves)
            .unwrap()
            .payload_json,
    )
    .unwrap();
    let semantic = value["operationId"].as_str().unwrap();
    let vault = value["source"]["vaultId"].as_str().unwrap();
    assert_eq!(value["children"].as_array().unwrap().len(), 1);
    for suffix in [
        None,
        Some("create-target"),
        Some("trash-source"),
        Some("delete-source"),
    ] {
        let operation_id = suffix.map_or_else(
            || "independent-ordinary-command".to_owned(),
            |suffix| format!("{semantic}:{suffix}"),
        );
        let mut operation = crate::test_fixtures::test_operation(&operation_id, "independent-item");
        operation.target = ResourceRef::Item {
            item_id: "independent-item".into(),
            vault_id: vault.into(),
        };
        operation.request.path = format!("/api/v1/vaults/{vault}/items/independent-item");
        operation.request_fingerprint =
            create_item_fingerprint(vault, "independent-item", &operation.request.body);
        let mut overlay = crate::test_fixtures::test_overlay(
            head.account_id.clone(),
            "independent-item",
            &operation_id,
        );
        overlay.vault_id = vault.into();
        let mut rows = original.clone();
        for (store, record_id, payload_json) in [
            (
                ReplicaStore::Operations,
                operation_id.as_str(),
                serde_json::to_string(&operation).unwrap(),
            ),
            (
                ReplicaStore::OptimisticItems,
                "independent-item",
                serde_json::to_string(&overlay).unwrap(),
            ),
        ] {
            rows.push(StoredReplicaRow {
                store,
                key: ReplicaRowKey {
                    account_id: head.account_id.clone(),
                    record_id: record_id.into(),
                },
                payload_json,
            });
        }
        for reverse in [false, true] {
            if reverse {
                rows.reverse();
            }
            let result = coverage(head.clone(), &rows);
            if suffix.is_some() {
                assert!(
                    result.is_err(),
                    "reserved child {operation_id}, reverse={reverse}"
                );
            } else {
                assert_eq!(result.unwrap().operation_count, 2);
            }
        }
    }
}

#[test]
fn legacy_workflow_recovery_refuses_lost_or_altered_typed_lineage() {
    let (head, original) = workflow_rows();
    for mutation in [
        "null-admission",
        "unknown-payload",
        "null-semantic",
        "changed-child",
    ] {
        let mut rows = original.clone();
        let workflow = rows
            .iter_mut()
            .find(|row| row.store == ReplicaStore::CrossAccountMoves)
            .unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&workflow.payload_json).unwrap();
        match mutation {
            "null-admission" => value["legacyAdmission"] = serde_json::Value::Null,
            "unknown-payload" => {
                value["legacyAdmission"]["sourceCommand"]["encryptedPayload"]["ciphertext"] =
                    json!("unowned");
            }
            "null-semantic" => {
                value["legacyAdmission"]["sourceCommand"]["operationId"] = serde_json::Value::Null;
            }
            "changed-child" => value["children"][0]["operationId"] = json!("replacement-attempt"),
            _ => unreachable!(),
        }
        workflow.payload_json = serde_json::to_string(&value).unwrap();
        assert!(coverage(head.clone(), &rows).is_err(), "{mutation}");
    }
}

#[test]
fn stopped_legacy_workflow_recovery_retains_history_without_an_overlay() {
    use crate::replica::persistence_contract::reconstruct_snapshot;
    for (status, disposition) in [
        ("failed", "legacyFailed"),
        ("conflicted", "legacyConflicted"),
    ] {
        let (head, mut rows) = workflow_rows();
        let overlay = rows
            .iter()
            .find(|row| row.store == ReplicaStore::OptimisticItems)
            .unwrap()
            .clone();
        rows.retain(|row| row.store != ReplicaStore::OptimisticItems);
        let row = rows
            .iter_mut()
            .find(|row| row.store == ReplicaStore::CrossAccountMoves)
            .unwrap();
        let mut value: serde_json::Value = serde_json::from_str(&row.payload_json).unwrap();
        value["legacyAdmission"]["disposition"] = json!(disposition);
        let command = &mut value["legacyAdmission"]["sourceCommand"];
        command["status"] = json!(status);
        command["retryCount"] = json!("4");
        command["nextAttemptAt"] = json!("9000");
        command["lastError"] = json!("captured failure");
        command["conflictCopyId"] = json!("independently-captured-copy");
        command["projectionClaimId"] = json!("departed-producer");
        command["projectionClaimExpiresAt"] = json!("8000");
        value["scheduling"]["attemptCount"] = json!("4");
        value["scheduling"]["notBeforeMs"] = json!("9000");
        row.payload_json = serde_json::to_string(&value).unwrap();
        for reverse in [false, true] {
            let mut ordered = rows.clone();
            if reverse {
                ordered.reverse();
            }
            let proof = coverage(head.clone(), &ordered).unwrap();
            assert!(proof.authority_valid);
            assert_eq!(proof.operation_count, 1);
            assert_eq!(proof.accepted_rows().count(), 1);
            let reopened =
                reconstruct_snapshot(&head.account_id, Some(head.clone()), ordered.clone())
                    .unwrap()
                    .unwrap();
            assert!(reopened.items.is_empty());
            assert!(!reopened.item_has_optimistic_owner(
                &reopened.cross_account_moves[0]
                    .captured()
                    .unwrap()
                    .source
                    .id
            ));
            assert_eq!(
                serde_json::to_value(reopened.cross_account_moves[0].captured().unwrap()).unwrap(),
                value
            );
            ordered.push(overlay.clone());
            assert!(coverage(head.clone(), &ordered).is_err());
            assert!(reconstruct_snapshot(&head.account_id, Some(head.clone()), ordered).is_err());
        }
    }
}

#[test]
fn stopped_legacy_workflow_recovery_allows_a_newer_owner_but_reserves_all_children() {
    for (status, disposition) in [
        ("failed", "legacyFailed"),
        ("conflicted", "legacyConflicted"),
    ] {
        let (head, mut original) = workflow_rows();
        original.retain(|row| row.store != ReplicaStore::OptimisticItems);
        let row = original
            .iter_mut()
            .find(|row| row.store == ReplicaStore::CrossAccountMoves)
            .unwrap();
        let mut held: serde_json::Value = serde_json::from_str(&row.payload_json).unwrap();
        held["legacyAdmission"]["disposition"] = json!(disposition);
        held["legacyAdmission"]["sourceCommand"]["status"] = json!(status);
        row.payload_json = serde_json::to_string(&held).unwrap();
        let value: serde_json::Value = serde_json::from_str(
            &original
                .iter()
                .find(|row| row.store == ReplicaStore::CrossAccountMoves)
                .unwrap()
                .payload_json,
        )
        .unwrap();
        let semantic = value["operationId"].as_str().unwrap();
        let vault = value["source"]["vaultId"].as_str().unwrap();
        let item = value["source"]["id"].as_str().unwrap();
        assert_eq!(value["children"].as_array().unwrap().len(), 1);
        for suffix in [
            None,
            Some("create-target"),
            Some("trash-source"),
            Some("delete-source"),
        ] {
            let operation_id = suffix.map_or_else(
                || "independent-ordinary-command".to_owned(),
                |suffix| format!("{semantic}:{suffix}"),
            );
            let mut operation = crate::test_fixtures::test_operation(&operation_id, item);
            operation.target = ResourceRef::Item {
                item_id: item.into(),
                vault_id: vault.into(),
            };
            operation.request.path = format!(
                "/api/v1/vaults/{}/items/{}",
                encode_component(vault),
                encode_component(item)
            );
            operation.request_fingerprint =
                create_item_fingerprint(vault, item, &operation.request.body);
            let mut overlay =
                crate::test_fixtures::test_overlay(head.account_id.clone(), item, &operation_id);
            overlay.vault_id = vault.into();
            let mut rows = original.clone();
            for (store, record_id, payload_json) in [
                (
                    ReplicaStore::Operations,
                    operation_id.as_str(),
                    serde_json::to_string(&operation).unwrap(),
                ),
                (
                    ReplicaStore::OptimisticItems,
                    item,
                    serde_json::to_string(&overlay).unwrap(),
                ),
            ] {
                rows.push(StoredReplicaRow {
                    store,
                    key: ReplicaRowKey {
                        account_id: head.account_id.clone(),
                        record_id: record_id.into(),
                    },
                    payload_json,
                });
            }
            for reverse in [false, true] {
                if reverse {
                    rows.reverse();
                }
                let result = coverage(head.clone(), &rows);
                if suffix.is_some() {
                    assert!(
                        result.is_err(),
                        "reserved child {operation_id}, reverse={reverse}"
                    );
                } else {
                    let proof = result.unwrap();
                    assert_eq!(proof.operation_count, 2);
                    assert_eq!(proof.accepted_rows().count(), 3);
                    let reopened = crate::replica::persistence_contract::reconstruct_snapshot(
                        &head.account_id,
                        Some(head.clone()),
                        rows.clone(),
                    )
                    .unwrap()
                    .unwrap();
                    assert_eq!(reopened.items, vec![overlay.clone()]);
                    assert_eq!(reopened.operations, vec![operation.clone()]);
                    assert!(!reopened.cross_account_moves[0]
                        .captured()
                        .unwrap()
                        .owns_source_item());
                }
            }
        }
    }
}
#[test]
fn destination_authorization_recovery_preserves_closed_lineage_and_normal_ownership() {
    use crate::replica::persistence_contract::reconstruct_snapshot;
    for prior in ["legacyFailed", "legacyConflicted"] {
        for retired in [false, true] {
            let (head, mut rows) = workflow_rows();
            let row = rows
                .iter_mut()
                .find(|row| row.store == ReplicaStore::CrossAccountMoves)
                .unwrap();
            let mut value: serde_json::Value = serde_json::from_str(&row.payload_json).unwrap();
            value["legacyAdmission"]["sourceCommand"]["status"] =
                json!(if prior == "legacyFailed" {
                    "failed"
                } else {
                    "conflicted"
                });
            value["legacyAdmission"]["disposition"] =
                json!({"destinationReauthorized":{"priorHold":prior,"bindingRevision":"2"}});
            value["destinationBinding"]["accountId"] = json!("replacement-account");
            value["destinationBinding"]["incarnation"] = json!("replacement-incarnation");
            value["destinationBinding"]["bindingRevision"] = json!(if retired { "3" } else { "2" });
            if retired {
                value["destinationBinding"]["status"] = json!("retired");
                value["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
            }
            row.payload_json = serde_json::to_string(&value).unwrap();
            for reverse in [false, true] {
                let mut ordered = rows.clone();
                if reverse {
                    ordered.reverse();
                }
                let proof = coverage(head.clone(), &ordered).unwrap();
                assert!(proof.authority_valid);
                assert_eq!(proof.operation_count, 1);
                assert_eq!(proof.accepted_rows().count(), 2);
                let reopened =
                    reconstruct_snapshot(&head.account_id, Some(head.clone()), ordered.clone())
                        .unwrap()
                        .unwrap();
                let record = reopened.cross_account_moves[0].captured().unwrap();
                assert!(!record.is_legacy_held());
                assert!(record.owns_source_item());
                assert_eq!(serde_json::to_value(record).unwrap(), value);
                assert_eq!(
                    reopened.items,
                    vec![record.source_overlay(&head.account_id)]
                );
                for mutation in ["binding-revision", "prior-hold", "source-status", "overlay"] {
                    let mut changed = ordered.clone();
                    let row = changed
                        .iter_mut()
                        .find(|row| {
                            row.store
                                == if mutation == "overlay" {
                                    ReplicaStore::OptimisticItems
                                } else {
                                    ReplicaStore::CrossAccountMoves
                                }
                        })
                        .unwrap();
                    let mut payload: serde_json::Value =
                        serde_json::from_str(&row.payload_json).unwrap();
                    match mutation {
                        "binding-revision" => {
                            payload["legacyAdmission"]["disposition"]["destinationReauthorized"]
                                ["bindingRevision"] = json!(if retired { "3" } else { "4" })
                        }
                        "prior-hold" => {
                            payload["legacyAdmission"]["disposition"]["destinationReauthorized"]
                                ["priorHold"] = json!("normal")
                        }
                        "source-status" => {
                            payload["legacyAdmission"]["sourceCommand"]["status"] = json!("pending")
                        }
                        "overlay" => payload["encryptedData"] = json!("replacement-ciphertext"),
                        _ => unreachable!(),
                    }
                    row.payload_json = serde_json::to_string(&payload).unwrap();
                    assert!(coverage(head.clone(), &changed).is_err(), "{mutation}");
                    assert!(
                        reconstruct_snapshot(&head.account_id, Some(head.clone()), changed)
                            .is_err(),
                        "{mutation}"
                    );
                }
                // Normal policy may omit an overlay after Vault authority retirement; the accepted
                // source record remains its witness. Authorization adds no second overlay journal.
                let without_overlay = ordered
                    .into_iter()
                    .filter(|row| row.store != ReplicaStore::OptimisticItems)
                    .collect::<Vec<_>>();
                assert_eq!(
                    coverage(head.clone(), &without_overlay)
                        .unwrap()
                        .accepted_rows()
                        .count(),
                    1
                );
                assert!(reconstruct_snapshot(
                    &head.account_id,
                    Some(head.clone()),
                    without_overlay
                )
                .unwrap()
                .unwrap()
                .items
                .is_empty());
            }
        }
    }
}
