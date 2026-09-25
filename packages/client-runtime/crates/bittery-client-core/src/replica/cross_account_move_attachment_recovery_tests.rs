//! Recovery inventory follows actual guarded workflow transitions through serialized SQLite.
use super::*;
use std::collections::BTreeSet;

async fn required_from_current(
    adapter: &SqliteReplica,
    seen: &mut BTreeSet<&'static str>,
) -> Option<CrossAccountMoveRecord> {
    let before = loaded(adapter).await;
    let ReplicaPersistenceResponse::Loaded { rows, .. } = &before else {
        panic!("expected serialized source inventory");
    };
    let row = rows
        .iter()
        .find(|row| row.store == crate::replica::ReplicaStore::CrossAccountMoves)?;
    let record: CrossAccountMoveRecord = serde_json::from_str(&row.payload_json).unwrap();
    let proof = coverage(&before).unwrap();
    assert_eq!(
        loaded(adapter).await,
        before,
        "inventory must not write rows"
    );
    assert_eq!(record.attachments.len(), 1);
    if record.stage == CrossAccountMoveStage::Completed {
        seen.insert("completed");
        assert!(proof.required_attachments.is_empty());
        return Some(record);
    }
    assert_eq!(proof.required_attachments.len(), 1);
    let required = &proof.required_attachments[0];
    let checkpoint = &record.attachments[0];
    assert_eq!(proof.head.account_id.as_str(), SOURCE);
    assert_eq!(required.operation_id, record.operation_id);
    assert_eq!(required.attachment_id, checkpoint.target_attachment_id);
    assert_ne!(required.attachment_id, checkpoint.source_attachment_id);
    match &checkpoint.progress {
        CrossAccountMoveAttachmentProgress::Pending => {
            seen.insert("pending");
            assert!(required.artifact.is_none());
        }
        CrossAccountMoveAttachmentProgress::Encrypted { artifact, .. } => {
            seen.insert("encrypted");
            assert_eq!(required.artifact.as_ref(), Some(artifact));
        }
    }
    if record.destination_binding.status == CrossAccountMoveBindingStatus::Retired {
        seen.insert("retired");
    }
    if record.stage == CrossAccountMoveStage::Rejected {
        seen.insert("rejected");
    }
    Some(record)
}

#[tokio::test]
async fn serialized_recovery_inventory_conserves_cross_account_attachment_ownership_until_completed(
) {
    let history = attachment_history::history().unwrap();
    let database = Database::new();
    let adapter = SqliteReplica::open(&database.0).unwrap();
    let mut seen = BTreeSet::new();
    let mut rejection_boundary = None;
    for (index, step) in history.steps.iter().enumerate() {
        SerializedReplicaExecutor::invoke(&adapter, serde_json::to_string(&step.request).unwrap())
            .await
            .unwrap();
        let Some(record) = required_from_current(&adapter, &mut seen).await else {
            continue;
        };
        if record.stage == CrossAccountMoveStage::SourceTrash
            && record.children.len() == 3
            && record.children[2].item().unwrap().result.is_none()
        {
            rejection_boundary = Some(index);
        }
    }
    assert_eq!(
        seen,
        BTreeSet::from(["completed", "encrypted", "pending", "retired"])
    );
    drop(adapter);

    // Branch the same real accepted prefix at the prepared source Trash. A real retained Item
    // rejection ends automatic progression but must preserve its source-owned artifact duty.
    let rejected_database = Database::new();
    let rejected_adapter = Arc::new(SqliteReplica::open(&rejected_database.0).unwrap());
    for step in &history.steps[..=rejection_boundary.expect("prepared source Trash boundary")] {
        SerializedReplicaExecutor::invoke(
            rejected_adapter.as_ref(),
            serde_json::to_string(&step.request).unwrap(),
        )
        .await
        .unwrap();
    }
    let replica = Replica::new(Arc::new(SerializedReplicaPersistence::new(
        rejected_adapter.clone(),
    )));
    let current = replica.load(&SOURCE.into()).await.unwrap().unwrap();
    let mut rejected = current.cross_account_moves[0].captured().unwrap().clone();
    let child = rejected.children[2].item_mut().unwrap();
    child.result = Some(ObservedOutcome {
        operation_id: child.operation_id.clone(),
        request_fingerprint: child.request_fingerprint,
        result: OperationOutcomeResult::Rejected {
            code: OperationRejectionCode::VaultReadOnly,
        },
    });
    rejected.stage = CrossAccountMoveStage::Rejected;
    rejected.disposition = CrossAccountMoveDisposition::Rejected {
        code: OperationRejectionCode::VaultReadOnly,
    };
    advance_record(&replica, rejected.clone()).await;
    drop(replica);
    drop(rejected_adapter);
    let reopened = SqliteReplica::open(&rejected_database.0).unwrap();
    assert_eq!(
        required_from_current(&reopened, &mut seen).await,
        Some(rejected)
    );
    assert_eq!(
        seen,
        BTreeSet::from(["completed", "encrypted", "pending", "rejected", "retired"])
    );
}
