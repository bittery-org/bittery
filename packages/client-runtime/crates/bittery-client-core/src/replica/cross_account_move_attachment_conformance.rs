//! The serialized store refuses forged Attachment work before changing durable rows.
use super::tests::{coverage, loaded};
use super::*;
use crate::replica::{
    attachment_move_artifact_ref, CrossAccountMoveAttachmentCheckpoint,
    CrossAccountMoveAttachmentEvidence, CrossAccountMoveAttachmentProgress, CrossAccountMoveEntry,
    PreparedMoveAttachment, Replica, SerializedReplicaExecutor, SerializedReplicaPersistence,
};

fn attachment_record() -> CrossAccountMoveRecord {
    let mut record = accepted_record();
    let source = authority_attachment(SOURCE, &record.source.id);
    record
        .attachments
        .push(CrossAccountMoveAttachmentCheckpoint {
            source_attachment_id: source.id.clone(),
            target_attachment_id: "8d9c6985-cedc-4abc-9f90-f0cbb01c230f".into(),
            target_metadata: PreparedMoveAttachment {
                encrypted_name: "target-name-ciphertext".into(),
                encryption_iv: "target-name-iv".into(),
                encryption_algorithm: "AES-GCM-AAD-V1".into(),
                encrypted_attachment_key: "target-key-ciphertext".into(),
                attachment_key_iv: "target-key-iv".into(),
                attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
                encrypted_content_type: "target-type-ciphertext".into(),
                encrypted_content_type_iv: "target-type-iv".into(),
            },
            progress: CrossAccountMoveAttachmentProgress::Pending,
        });
    record.source.attachments.push(source);
    record
}

struct Database(std::path::PathBuf);
impl Database {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "bittery-cross-move-attachment-domain-{}.sqlite",
            bittery_crypto_core::generate_uuid()
        )))
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

async fn installed(database: &Database) -> (Arc<SqliteReplica>, Replica) {
    let adapter = Arc::new(SqliteReplica::open(&database.0).unwrap());
    let record = attachment_record();
    let mut history =
        HistoryBuilder::new("cross-move-attachment-domain", &[], &[SOURCE, DESTINATION]);
    history.install("install source", SOURCE, "first").unwrap();
    history
        .install("install target", DESTINATION, "first")
        .unwrap();
    history
        .begin_bootstrap(
            "begin",
            BeginBootstrapPlan {
                guard: guard(SOURCE, 0, 0),
                generation_id: BootstrapGenerationId("generation-1".into()),
            },
        )
        .unwrap();
    for cursor in [
        BootstrapPageCursor::VaultsInitial,
        BootstrapPageCursor::ItemsInitial,
    ] {
        let mut page = stage_page(
            SOURCE,
            1,
            0,
            cursor,
            SyncCursor::CapturedEmpty,
            BootstrapContinuation::Final,
            &record.source.id,
        );
        if !page.items.is_empty() {
            page.items = vec![record.source.clone()];
        }
        history.stage_bootstrap("stage", page).unwrap();
    }
    history
        .promote_bootstrap(
            "promote",
            PromoteBootstrapPlan {
                guard: guard(SOURCE, 1, 0),
                generation_id: BootstrapGenerationId("generation-1".into()),
                additional_retired_vault_ids: Vec::new(),
            },
        )
        .unwrap();
    commit(
        &mut history,
        ADMITTED,
        PlanMutation::AdmitCrossAccountMove {
            source_overlay: Some(source_overlay(&record)),
            record: Box::new(record),
        },
    )
    .unwrap();
    for step in history.finish().steps {
        SerializedReplicaExecutor::invoke(
            adapter.as_ref(),
            serde_json::to_string(&step.request).unwrap(),
        )
        .await
        .unwrap();
    }
    let replica = Replica::new(Arc::new(SerializedReplicaPersistence::new(adapter.clone())));
    replica.load(&SOURCE.into()).await.unwrap().unwrap();
    (adapter, replica)
}

async fn advance_record(replica: &Replica, record: CrossAccountMoveRecord) -> ReplicaSnapshot {
    let snapshot = replica.snapshot(&SOURCE.into()).unwrap();
    assert!(matches!(
        replica
            .execute(plan(
                &snapshot,
                advance(record, CrossAccountMoveSourceAuthority::Unchanged)
            ))
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));
    replica.snapshot(&SOURCE.into()).unwrap()
}

fn encrypt_checkpoint(record: &mut CrossAccountMoveRecord) {
    let artifact = attachment_move_artifact_ref(
        &SOURCE.into(),
        &record.operation_id,
        &record.attachments[0].target_attachment_id,
        &"ab".repeat(32),
        1024,
    )
    .unwrap();
    let grant_request = record.attachment_grant_request(0, &artifact).unwrap();
    record.attachments[0].progress = CrossAccountMoveAttachmentProgress::Encrypted {
        artifact,
        grant_request,
    };
}

async fn refuse_advance(
    adapter: &SqliteReplica,
    replica: &Replica,
    record: CrossAccountMoveRecord,
) {
    let before = loaded(adapter).await;
    let snapshot = replica.snapshot(&SOURCE.into()).unwrap();
    assert_eq!(
        replica
            .execute(plan(
                &snapshot,
                advance(record, CrossAccountMoveSourceAuthority::Unchanged)
            ))
            .await
            .unwrap_err()
            .code,
        RuntimeErrorCode::InvariantViolation
    );
    assert_eq!(loaded(adapter).await, before);
}

fn current_attachment(record: &CrossAccountMoveRecord) -> AuthorityAttachmentRecord {
    let registration = record.registration(0).unwrap();
    let body: crate::server_contract::CreateAttachmentBody =
        serde_json::from_slice(&registration.request.body).unwrap();
    AuthorityAttachmentRecord {
        id: body.attachment_id,
        item_id: record.target.id.clone(),
        vault_id: record.target.vault_id.clone(),
        storage_key: body.storage_key,
        encrypted_name: body.encrypted_name,
        encryption_iv: body.encryption_iv,
        encryption_algorithm: body.encryption_algorithm,
        encrypted_attachment_key: body.encrypted_attachment_key,
        attachment_key_iv: body.attachment_key_iv,
        attachment_key_algorithm: body.attachment_key_algorithm,
        encrypted_content_type: body.encrypted_content_type,
        encrypted_content_type_iv: body.encrypted_content_type_iv,
        envelope_version: body.envelope_version,
        file_size: body.file_size,
        uploaded_by: record.destination_identity.user_id.clone(),
        created_at: "2026-09-14T00:00:00Z".into(),
    }
}

async fn fixed_registration(replica: &Replica) -> CrossAccountMoveRecord {
    let mut record = replica
        .snapshot(&SOURCE.into())
        .unwrap()
        .cross_account_moves[0]
        .captured()
        .unwrap()
        .clone();
    applied(&mut record.children[0], 1);
    record.stage = CrossAccountMoveStage::Attachments { next_index: 0 };
    advance_record(replica, record.clone()).await;
    encrypt_checkpoint(&mut record);
    advance_record(replica, record.clone()).await;
    record
        .children
        .push(CrossAccountMoveChild::AttachmentRegistration(
            record
                .attachment_registration(0, "attachments/original-fixed-key.enc")
                .unwrap(),
        ));
    advance_record(replica, record.clone()).await;
    record
}

#[tokio::test]
async fn serialized_attachment_prefix_preserves_fixed_intent_and_required_proofs() {
    let database = Database::new();
    let (adapter, replica) = installed(&database).await;
    let mut record = replica
        .snapshot(&SOURCE.into())
        .unwrap()
        .cross_account_moves[0]
        .captured()
        .unwrap()
        .clone();
    applied(&mut record.children[0], 1);
    record.stage = CrossAccountMoveStage::Attachments { next_index: 0 };
    advance_record(&replica, record.clone()).await;
    let mut skip_files = record.clone();
    skip_files.stage = CrossAccountMoveStage::SourceTrash;
    refuse_advance(&adapter, &replica, skip_files).await;
    let mut changed_metadata = record.clone();
    changed_metadata.attachments[0]
        .target_metadata
        .encrypted_attachment_key
        .push('x');
    refuse_advance(&adapter, &replica, changed_metadata).await;
    let mut early_registration = record.clone();
    early_registration
        .children
        .push(CrossAccountMoveChild::AttachmentRegistration(
            record.attachment_registration(0, "fixed-key").unwrap(),
        ));
    refuse_advance(&adapter, &replica, early_registration).await;
    encrypt_checkpoint(&mut record);
    advance_record(&replica, record.clone()).await;
    let mut another_artifact = record.clone();
    let other = attachment_move_artifact_ref(
        &SOURCE.into(),
        &record.operation_id,
        &record.attachments[0].target_attachment_id,
        &"cd".repeat(32),
        1024,
    )
    .unwrap();
    let grant_request = another_artifact
        .attachment_grant_request(0, &other)
        .unwrap();
    another_artifact.attachments[0].progress = CrossAccountMoveAttachmentProgress::Encrypted {
        artifact: other,
        grant_request,
    };
    refuse_advance(&adapter, &replica, another_artifact).await;
    record
        .children
        .push(CrossAccountMoveChild::AttachmentRegistration(
            record.attachment_registration(0, "fixed-key").unwrap(),
        ));
    advance_record(&replica, record.clone()).await;
    let mut changed_request = record.clone();
    changed_request.children[1] = CrossAccountMoveChild::AttachmentRegistration(
        record
            .attachment_registration(0, "replacement-key")
            .unwrap(),
    );
    refuse_advance(&adapter, &replica, changed_request).await;
    let mut unproved_destruction = record.clone();
    unproved_destruction.stage = CrossAccountMoveStage::SourceTrash;
    refuse_advance(&adapter, &replica, unproved_destruction).await;
    let mut wrong_ack = record.clone();
    let CrossAccountMoveChild::AttachmentRegistration(registration) = &mut wrong_ack.children[1]
    else {
        unreachable!()
    };
    registration.result = Some(CrossAccountMoveAttachmentEvidence::Acknowledged {
        attachment_id: record.source.attachments[0].id.clone(),
    });
    refuse_advance(&adapter, &replica, wrong_ack).await;
    let CrossAccountMoveChild::AttachmentRegistration(registration) = &mut record.children[1]
    else {
        unreachable!()
    };
    registration.result = Some(CrossAccountMoveAttachmentEvidence::Acknowledged {
        attachment_id: record.attachments[0].target_attachment_id.clone(),
    });
    advance_record(&replica, record.clone()).await;
    let mut changed_proof = record.clone();
    let authority = current_attachment(&record);
    let CrossAccountMoveChild::AttachmentRegistration(registration) =
        &mut changed_proof.children[1]
    else {
        unreachable!()
    };
    registration.result = Some(CrossAccountMoveAttachmentEvidence::VerifiedPresent {
        attachment: Box::new(authority),
    });
    refuse_advance(&adapter, &replica, changed_proof).await;
    record.stage = CrossAccountMoveStage::SourceTrash;
    advance_record(&replica, record.clone()).await;
    record.children.push(source_child(false));
    let snapshot = advance_record(&replica, record.clone()).await;
    assert_eq!(
        snapshot.cross_account_moves,
        vec![CrossAccountMoveEntry::from(record)]
    );
    assert!(snapshot.operations.is_empty());
    assert_eq!(
        snapshot.items[0].attachments,
        attachment_record().source.attachments
    );
    drop(replica);
    assert!(coverage(&loaded(&adapter).await).is_ok());
}

#[tokio::test]
async fn serialized_resume_only_adds_exact_evidence_to_an_existing_unproved_registration() {
    let database = Database::new();
    let (adapter, replica) = installed(&database).await;
    let record = fixed_registration(&replica).await;
    let snapshot = replica.snapshot(&SOURCE.into()).unwrap();
    replica
        .execute(plan(
            &snapshot,
            PlanMutation::RetireCrossAccountMoveDestination {
                operation_id: record.operation_id.clone(),
                expected_binding_revision: 0,
                target_account_id: record.destination_binding.account_id.clone(),
                target_incarnation: record.destination_binding.incarnation.clone(),
            },
        ))
        .await
        .unwrap();
    let snapshot = replica.snapshot(&SOURCE.into()).unwrap();
    let retired = snapshot.cross_account_moves[0].captured().unwrap().clone();
    let current = current_attachment(&record);
    let mutation = |evidence| PlanMutation::ReauthorizeCrossAccountMoveDestination {
        operation_id: record.operation_id.clone(),
        expected_binding_revision: 1,
        destination_account_id: DESTINATION.into(),
        destination_incarnation: incarnation(DESTINATION, "reinstalled"),
        verified_attachments: evidence,
    };
    let mut foreign = current.clone();
    foreign.id = "unknown-attachment".into();
    let mut changed = current.clone();
    changed.encrypted_attachment_key.push('x');
    let mut wrong_user = current.clone();
    wrong_user.uploaded_by = record.source_identity.user_id.clone();
    for evidence in [
        vec![foreign],
        vec![changed],
        vec![wrong_user],
        vec![current.clone(), current.clone()],
    ] {
        let before = loaded(&adapter).await;
        assert_eq!(
            replica
                .execute(plan(&snapshot, mutation(evidence)))
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(loaded(&adapter).await, before);
    }
    replica
        .execute(plan(&snapshot, mutation(vec![current.clone()])))
        .await
        .unwrap();
    let resumed = replica
        .snapshot(&SOURCE.into())
        .unwrap()
        .cross_account_moves[0]
        .captured()
        .unwrap()
        .clone();
    assert_eq!(resumed.stage, retired.stage);
    assert_eq!(resumed.attachments, retired.attachments);
    assert_eq!(resumed.children[0], retired.children[0]);
    assert_eq!(
        resumed.registration(0).unwrap().request,
        retired.registration(0).unwrap().request
    );
    assert_eq!(
        resumed.registration(0).unwrap().result,
        Some(CrossAccountMoveAttachmentEvidence::VerifiedPresent {
            attachment: Box::new(current)
        })
    );
    assert_eq!(resumed.destination_binding.binding_revision, 2);
    assert_eq!(
        resumed.destination_binding.status,
        CrossAccountMoveBindingStatus::Active
    );
    assert_eq!(resumed.disposition, CrossAccountMoveDisposition::Ready);
    drop(replica);
    assert!(coverage(&loaded(&adapter).await).is_ok());
}

#[path = "cross_account_move_attachment_recovery_tests.rs"]
mod recovery_tests;
