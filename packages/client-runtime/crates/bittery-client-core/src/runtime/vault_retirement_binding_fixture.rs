//! A persisted crash history for the actual combined Worker/IndexedDB acceptance fixture.
//! This module cannot participate in production bindings or Runtime requests.
use super::*;
use crate::attachment_artifact_store::{
    authenticated_target_for_vaults, AttachmentArtifactOwner, AttachmentArtifactStoreRequest,
    ProvisionalAttachmentArtifactScope, ProvisionalAttachmentArtifactStore,
    ProvisionalAttachmentArtifactStoreRequest, ProvisionalAttachmentArtifactStoreResponse,
    ProvisionalAttachmentArtifactWriter,
};
use crate::replica::*;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{decrypt_with_aad, encrypt_with_aad, AadContext, EncryptedData};

impl Runtime {
    #[doc(hidden)]
    pub async fn seed_vault_retirement_binding_test_history(
        &self,
        server_url: String,
        provisional: Arc<dyn ProvisionalAttachmentArtifactStore>,
        ready: impl FnOnce(String),
    ) -> Result<(), RuntimeError> {
        self.seed_create_vault_binding_test_authority(server_url, None, false)
            .await?;
        let account = AccountId::from("account-1");
        let execution = self.account_execution_lock(&account)?;
        let _execution = execution.lock_owned().await;
        let initial = self.require_snapshot(&account)?;
        self.platform_storage
            .store_device_catalog(&DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
                account_id: account.clone(),
                active_incarnation: Some(initial.incarnation.clone()),
                pending_retirement: None,
                pending_install: None,
            }])?)
            .await?;
        let source = initial.bootstrap.snapshot().visible_vaults[0].clone();
        let target = crate::test_fixtures::personal_vault("vault-target", &initial.user_id);
        let mut item = initial.bootstrap.snapshot().visible_items[0].clone();
        let operation_id = "retirement-move";
        let encrypted_files = ["retained-encrypted", "retained-pending"]
            .into_iter()
            .map(|id| {
                let (bytes, proof) = authenticated_target_for_vaults(
                    &"retained ciphertext ".repeat(20_000),
                    account.as_str(),
                    &initial.user_id,
                    operation_id,
                    id,
                    &source.id,
                    &target.id,
                );
                (id, bytes, proof)
            })
            .collect::<Vec<_>>();
        let mut sources = Vec::new();
        for (id, bytes, _) in &encrypted_files {
            let metadata = fixture_metadata(&source.id, id, &initial.user_id, &[31; 32], 1);
            sources.push(AuthorityAttachmentRecord {
                id: (*id).into(),
                item_id: item.id.clone(),
                vault_id: source.id.clone(),
                storage_key: format!("source-{id}"),
                encrypted_name: metadata.encrypted_name,
                encryption_iv: metadata.encryption_iv,
                encryption_algorithm: metadata.encryption_algorithm,
                encrypted_attachment_key: metadata.encrypted_attachment_key,
                attachment_key_iv: metadata.attachment_key_iv,
                attachment_key_algorithm: metadata.attachment_key_algorithm,
                encrypted_content_type: metadata.encrypted_content_type,
                encrypted_content_type_iv: metadata.encrypted_content_type_iv,
                envelope_version: 1,
                file_size: i32::try_from(bytes.len()).map_err(|_| fixture_error())?,
                uploaded_by: initial.user_id.clone(),
                created_at: item.created_at.clone(),
            });
        }
        item.attachments = sources.clone();
        self.fixture_stage_authority(
            &account,
            "fixture-initial",
            vec![source.clone(), target.clone()],
            vec![item.clone()],
            true,
        )
        .await?;
        let snapshot = self.require_snapshot(&account)?;
        let plaintext = Zeroizing::new(
            decrypt_with_aad(
                &EncryptedData {
                    ciphertext: item.encrypted_data.clone(),
                    iv: item.encryption_iv.clone(),
                    algorithm: item.encryption_algorithm.clone(),
                },
                &crate::test_fixtures::TEST_VAULT_KEY,
                &AadContext {
                    vault_id: source.id.clone(),
                    entity_id: item.id.clone(),
                    entity_type: "item".into(),
                    version: item.encryption_version as u64,
                    user_id: initial.user_id.clone(),
                },
            )
            .map_err(|_| fixture_error())?,
        );
        let target_item = encrypt_with_aad(
            &plaintext,
            &crate::test_fixtures::TEST_VAULT_KEY,
            &AadContext {
                vault_id: target.id.clone(),
                entity_id: item.id.clone(),
                entity_type: "item".into(),
                version: 2,
                user_id: initial.user_id.clone(),
            },
        )
        .map_err(|_| fixture_error())?;
        let mut preparation = AttachmentMovePreparationRecord {
            accepted_item_category: Some(AuthorityItemCategory::Login),
            account_id: account.clone(),
            operation_id: operation_id.into(),
            item_id: item.id.clone(),
            source_vault_id: source.id.clone(),
            target_vault_id: target.id.clone(),
            expected_item_version: item.version,
            target_encrypted_data: target_item.ciphertext,
            target_encryption_algorithm: target_item.algorithm,
            target_encryption_iv: target_item.iv,
            source_attachments: sources,
            progress: ["retained-encrypted", "retained-pending"]
                .into_iter()
                .map(|id| AttachmentMoveProgress::Pending {
                    attachment_id: id.into(),
                    expected_envelope_version: 1,
                })
                .collect(),
            intent_fingerprint: Sha256Fingerprint([0; 32]),
            scheduling: OperationSchedulingState::default(),
        };
        preparation.intent_fingerprint = attachment_move_intent_fingerprint(&preparation)?;
        self.fixture_mutations(
            &snapshot,
            vec![PlanMutation::AcceptAttachmentMovePreparation(
                preparation.clone(),
            )],
        )
        .await?;
        let artifacts = self
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment lifecycle lock poisoned")
            .as_ref()
            .ok_or_else(fixture_error)?
            .artifacts();
        let mut retained = Vec::new();
        for (index, (id, bytes, proof)) in encrypted_files.into_iter().enumerate() {
            let writer = ProvisionalAttachmentArtifactWriter::new(
                ProvisionalAttachmentArtifactScope::new(account.clone(), operation_id, id)?,
            );
            let ProvisionalAttachmentArtifactStoreResponse::Begun(writer) = provisional
                .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Begin { writer })
                .await?
            else {
                return Err(fixture_error());
            };
            for (chunk_index, chunk) in bytes.chunks(crate::ARTIFACT_CHUNK_BYTES).enumerate() {
                provisional
                    .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::WriteChunk {
                        writer: writer.clone(),
                        chunk_index: chunk_index as u32,
                        bytes: chunk.to_vec(),
                    })
                    .await?;
            }
            let ProvisionalAttachmentArtifactStoreResponse::Finalized(owner) = provisional
                .invoke_provisional(ProvisionalAttachmentArtifactStoreRequest::Finalize {
                    writer,
                    publication_proof: proof,
                })
                .await?
            else {
                return Err(fixture_error());
            };
            retained.push(owner.artifact_id().to_owned());
            if index == 0 {
                self.fixture_mutations(
                    &self.require_snapshot(&account)?,
                    vec![PlanMutation::CheckpointAttachmentMove {
                        operation_id: operation_id.into(),
                        expected_intent_fingerprint: preparation.intent_fingerprint,
                        expected: preparation.progress[0].clone(),
                        next: AttachmentMoveProgress::Encrypted {
                            attachment_id: id.into(),
                            expected_envelope_version: 1,
                            artifact: attachment_move_artifact_ref(
                                &account,
                                operation_id,
                                id,
                                owner.ciphertext_sha256(),
                                owner.byte_length(),
                            )?,
                            payload: Box::new(fixture_metadata(
                                &target.id,
                                id,
                                &initial.user_id,
                                &[47; 32],
                                2,
                            )),
                            upload: AttachmentMoveUploadState::NeedsUpload,
                        },
                    }],
                )
                .await?;
            }
        }
        let mut garbage = Vec::new();
        let mut unrelated = Vec::new();
        for (owner_account, operation, attachment, publish) in [
            (account.clone(), operation_id, "stale-unowned", true),
            (account.clone(), "unrelated-writer", "attachment", false),
            (
                AccountId::from("account-2"),
                "unrelated-account",
                "attachment",
                true,
            ),
        ] {
            let (bytes, _) = authenticated_target_for_vaults(
                "unrelated or stale ciphertext",
                owner_account.as_str(),
                &initial.user_id,
                operation,
                attachment,
                &source.id,
                &target.id,
            );
            use sha2::Digest;
            let digest = format!("{:x}", sha2::Sha256::digest(&bytes));
            let artifact = attachment_move_artifact_ref(
                &owner_account,
                operation,
                attachment,
                &digest,
                bytes.len() as u64,
            )?;
            let owner =
                AttachmentArtifactOwner::new(owner_account, operation, attachment, artifact)?;
            artifacts
                .invoke(AttachmentArtifactStoreRequest::WriteChunk {
                    owner: owner.clone(),
                    chunk_index: 0,
                    bytes,
                })
                .await?;
            if publish {
                artifacts
                    .invoke(AttachmentArtifactStoreRequest::Publish {
                        owner: owner.clone(),
                    })
                    .await?;
            }
            if operation == operation_id {
                garbage.push(owner.artifact_id().to_owned());
            } else {
                unrelated.push(owner.artifact_id().to_owned());
            }
        }
        self.fixture_stage_authority(
            &account,
            "fixture-before-crash",
            vec![target],
            vec![],
            false,
        )
        .await?;
        // The browser kills this real Worker after the callback. Holding the existing execution
        // fence freezes a valid physical pre-promotion history without adding a Runtime toggle.
        ready(serde_json::json!({ "accountId": account.as_str(), "operationId": operation_id, "retained": retained,
            "garbage": garbage, "unrelated": unrelated, "sourceVaultId": source.id }).to_string());
        std::future::pending::<()>().await;
        Ok(())
    }

    async fn fixture_mutations(
        &self,
        snapshot: &ReplicaSnapshot,
        mutations: Vec<PlanMutation>,
    ) -> Result<(), RuntimeError> {
        match self
            .replica
            .execute_exact(GuardedCommitPlan::new(
                snapshot.account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                mutations,
            ))
            .await?
        {
            PlanResult::Applied { .. } => Ok(()),
            _ => Err(fixture_error()),
        }
    }
    async fn fixture_stage_authority(
        &self,
        account: &AccountId,
        name: &str,
        vaults: Vec<AuthorityVaultRecord>,
        items: Vec<AuthorityItemRecord>,
        promote: bool,
    ) -> Result<(), RuntimeError> {
        let generation = BootstrapGenerationId(name.into());
        self.replica
            .begin_bootstrap(BeginBootstrapPlan {
                guard: fixture_guard(&self.require_snapshot(account)?),
                generation_id: generation.clone(),
            })
            .await?;
        for (is_items, vaults, items) in [(false, vaults, vec![]), (true, vec![], items)] {
            let snapshot = self.require_snapshot(account)?;
            let staged = &snapshot.bootstrap.generations[&generation];
            let body = serde_json::to_vec(&(&vaults, &items)).map_err(|_| fixture_error())?;
            let result = self
                .replica
                .stage_bootstrap_page(StageBootstrapPagePlan {
                    guard: fixture_guard(&snapshot),
                    generation_id: generation.clone(),
                    page_identity: staged.next_page_identity,
                    request_cursor: staged.next_page_cursor.clone(),
                    raw_response_fingerprint: Sha256Fingerprint::of_bytes(&body),
                    pinned_watermark: SyncCursor::CapturedEmpty,
                    continuation: BootstrapContinuation::Final,
                    vault_key_version_included: false,
                    vaults,
                    items,
                })
                .await?;
            if result != StageBootstrapPageResult::Applied
                || (is_items
                    && !self.require_snapshot(account)?.bootstrap.generations[&generation]
                        .final_page_staged)
            {
                return Err(fixture_error());
            }
        }
        if promote {
            self.replica
                .promote_bootstrap(PromoteBootstrapPlan {
                    guard: fixture_guard(&self.require_snapshot(account)?),
                    generation_id: generation,
                    additional_retired_vault_ids: vec![],
                })
                .await?;
        }
        Ok(())
    }
}
fn fixture_guard(snapshot: &ReplicaSnapshot) -> BootstrapGuard {
    BootstrapGuard {
        account_id: snapshot.account_id.clone(),
        user_id: snapshot.user_id.clone(),
        incarnation: snapshot.incarnation.clone(),
        expected_replica_revision: snapshot.revision,
        expected_lock_epoch: snapshot.lock_epoch,
    }
}
fn fixture_metadata(
    vault: &str,
    attachment: &str,
    user: &str,
    key: &[u8; 32],
    version: u64,
) -> PreparedMoveAttachment {
    let scope = |entity_type: &str, version| AadContext {
        vault_id: vault.into(),
        entity_id: attachment.into(),
        entity_type: entity_type.into(),
        version,
        user_id: user.into(),
    };
    let name = encrypt_with_aad("fixture.txt", key, &scope("attachment_name", 1)).unwrap();
    let content_type =
        encrypt_with_aad("text/plain", key, &scope("attachment_content_type", 1)).unwrap();
    let wrapped = encrypt_with_aad(
        &BASE64.encode(key),
        &crate::test_fixtures::TEST_VAULT_KEY,
        &scope("attachment_key", version),
    )
    .unwrap();
    PreparedMoveAttachment {
        encrypted_name: name.ciphertext,
        encryption_iv: name.iv,
        encryption_algorithm: name.algorithm,
        encrypted_attachment_key: wrapped.ciphertext,
        attachment_key_iv: wrapped.iv,
        attachment_key_algorithm: wrapped.algorithm,
        encrypted_content_type: content_type.ciphertext,
        encrypted_content_type_iv: content_type.iv,
    }
}
fn fixture_error() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InvariantViolation,
        "Vault retirement binding history is invalid",
    )
}
