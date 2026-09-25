//! One fixed Attachment registration survives restart and explicit destination reauthorization.
use super::*;
use crate::replica::{CrossAccountMoveAttachmentCheckpoint, CrossAccountMoveAttachmentProgress};

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

fn verified_attachment(record: &CrossAccountMoveRecord) -> AuthorityAttachmentRecord {
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

pub(in crate::replica::replica_conformance) fn history() -> Result<History, RuntimeError> {
    let mut history = HistoryBuilder::new(
        "cross-account-move-attachment-registration-resume",
        &[
            "fixed destination Attachment metadata and source-owned artifact survive lost commit acknowledgement",
            "registration is an actual request with typed evidence, never an Item operation receipt",
            "explicit reauthorization enriches only missing registration evidence and changes the destination binding",
            "retained Item proofs and current source absence complete the original immutable workflow",
        ],
        &[SOURCE, DESTINATION],
    );
    let mut record = attachment_record();
    history.install("install source Account", SOURCE, "first")?;
    history.install("install destination Account", DESTINATION, "first")?;
    history.begin_bootstrap(
        "begin source Item and Attachment authority",
        BeginBootstrapPlan {
            guard: guard(SOURCE, 0, 0),
            generation_id: BootstrapGenerationId("generation-1".into()),
        },
    )?;
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
        history.stage_bootstrap("stage source Item and Attachment authority", page)?;
    }
    history.promote_bootstrap(
        "promote source Item and Attachment authority",
        PromoteBootstrapPlan {
            guard: guard(SOURCE, 1, 0),
            generation_id: BootstrapGenerationId("generation-1".into()),
            additional_retired_vault_ids: Vec::new(),
        },
    )?;
    commit(
        &mut history,
        "admit fixed encrypted Attachment metadata and original source overlay",
        PlanMutation::AdmitCrossAccountMove {
            source_overlay: Some(source_overlay(&record)),
            record: Box::new(record.clone()),
        },
    )?;
    applied(&mut record.children[0], 1);
    record.stage = CrossAccountMoveStage::Attachments { next_index: 0 };
    commit(
        &mut history,
        "retain target Create Item proof before Attachment preparation",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    let artifact = attachment_move_artifact_ref(
        &SOURCE.into(),
        &record.operation_id,
        &record.attachments[0].target_attachment_id,
        &"ab".repeat(32),
        1024,
    )?;
    let grant_request = record.attachment_grant_request(0, &artifact)?;
    record.attachments[0].progress = CrossAccountMoveAttachmentProgress::Encrypted {
        artifact,
        grant_request,
    };
    commit(
        &mut history,
        "checkpoint canonical source-owned target artifact and exact grant request",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    record
        .children
        .push(CrossAccountMoveChild::AttachmentRegistration(
            record.attachment_registration(0, "attachments/fixed-target-key.enc")?,
        ));
    let prepared = commit(
        &mut history,
        "retain immutable registration request before binary dispatch",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    history.replay(
        "lost registration checkpoint acknowledgement refuses duplicate source commit",
        prepared,
        ReplicaPersistenceResponse::Committed {
            result: PlanResult::Stale {
                actual_revision: history.snapshot(SOURCE).unwrap().revision,
            },
        },
    )?;
    history.load(
        "reopen exact unproved registration and sealed artifact",
        SOURCE,
    )?;
    commit(
        &mut history,
        "retire destination binding while registration proof remains missing",
        PlanMutation::RetireCrossAccountMoveDestination {
            operation_id: record.operation_id.clone(),
            expected_binding_revision: 0,
            target_account_id: DESTINATION.into(),
            target_incarnation: incarnation(DESTINATION, "first"),
        },
    )?;
    history.install(
        "install replacement destination incarnation",
        DESTINATION,
        "replacement",
    )?;
    commit(
        &mut history,
        "explicit Resume retains stage and requests while proving current registration",
        PlanMutation::ReauthorizeCrossAccountMoveDestination {
            operation_id: record.operation_id.clone(),
            expected_binding_revision: 1,
            destination_account_id: DESTINATION.into(),
            destination_incarnation: incarnation(DESTINATION, "replacement"),
            verified_attachments: vec![verified_attachment(&record)],
        },
    )?;
    history.load(
        "reopen enriched registration at the same Attachment index",
        SOURCE,
    )?;
    record = history.snapshot(SOURCE).unwrap().cross_account_moves[0]
        .captured()
        .unwrap()
        .clone();
    record.stage = CrossAccountMoveStage::SourceTrash;
    commit(
        &mut history,
        "advance only after all fixed Attachment registrations are proved",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    record.children.push(source_child(false));
    commit(
        &mut history,
        "prepare source Trash after target registration proof",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    applied(&mut record.children[2], 2);
    record.stage = CrossAccountMoveStage::SourceDelete;
    commit(
        &mut history,
        "retain source Trash Item proof and original source Attachment overlay",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    record.children.push(source_child(true));
    commit(
        &mut history,
        "prepare exact source Delete after retained Trash proof",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    applied(&mut record.children[3], 3);
    commit(
        &mut history,
        "retain source Delete Item proof before deciding current absence",
        advance(record.clone(), CrossAccountMoveSourceAuthority::Unchanged),
    )?;
    record.stage = CrossAccountMoveStage::Completed;
    commit(
        &mut history,
        "complete original Attachment Move only with current source absence",
        advance(record, CrossAccountMoveSourceAuthority::Absent),
    )?;
    history.load(
        "reopen completed Attachment evidence without source authority or overlay",
        SOURCE,
    )?;
    Ok(history.finish())
}
