use super::attachment_move_preparation::*;
use crate::{
    attachment_artifact_store::*,
    replica::{
        attachment_move_intent_fingerprint, AttachmentMovePreparationRecord,
        AttachmentMoveProgress, AttachmentMoveUploadState, AuthorityAttachmentRecord,
        AuthorityItemCategory, AuthorityItemRecord, GuardedCommitPlan, InMemoryReplica,
        OperationSchedulingState, PlanMutation, Replica, ReplicaItemRecord, Sha256Fingerprint,
    },
    test_fixtures::personal_vault,
    AccountId, RuntimeError, RuntimeErrorCode,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{decrypt_with_aad, encrypt_with_aad, AadContext, EncryptedData};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use zeroize::Zeroizing;

const USER: &str = "user-prep";
const ORIGINAL_UPLOADER: &str = "user-original-uploader";
const OP: &str = "operation-prep";
const ITEM: &str = "item-prep";
const ATT: &str = "attachment-prep";
const SOURCE: &str = "vault-source";
const TARGET: &str = "vault-target";
const SOURCE_KEY: [u8; 32] = [31; 32];
const PLAINTEXT: &str = "never-persist-this-attachment-plaintext";

#[derive(Clone)]
struct Draft {
    writer: ProvisionalAttachmentArtifactWriter,
    chunks: BTreeMap<u32, Vec<u8>>,
    owner: Option<AttachmentArtifactOwner>,
}

#[derive(Default)]
struct Artifacts {
    drafts: Mutex<HashMap<String, Draft>>,
    bytes: Mutex<HashMap<String, Vec<u8>>>,
    writers: AtomicUsize,
    publications: AtomicUsize,
    fail_begin: AtomicBool,
    fail_write: AtomicBool,
    fail_finalize_after_publish: AtomicBool,
    fail_read: AtomicBool,
}

#[async_trait]
impl ProvisionalAttachmentArtifactStore for Artifacts {
    async fn invoke_provisional(
        &self,
        request: ProvisionalAttachmentArtifactStoreRequest,
    ) -> Result<ProvisionalAttachmentArtifactStoreResponse, RuntimeError> {
        match request {
            ProvisionalAttachmentArtifactStoreRequest::Begin { writer } => {
                if self.fail_begin.swap(false, Ordering::SeqCst) {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "injected Begin failure",
                    ));
                }
                let key = format!(
                    "{}:{}:{}",
                    writer.account_id().as_str(),
                    writer.operation_id(),
                    writer.attachment_id()
                );
                let mut drafts = self.drafts.lock().unwrap();
                if let Some(draft) = drafts.get(&key).filter(|draft| draft.owner.is_some()) {
                    return Ok(
                        ProvisionalAttachmentArtifactStoreResponse::RecoveryAvailable(
                            ProvisionalAttachmentArtifactRecovery::new(
                                ProvisionalAttachmentArtifactScope::new(
                                    writer.account_id().clone(),
                                    writer.operation_id(),
                                    writer.attachment_id(),
                                )?,
                                draft.writer.generation(),
                            )?,
                        ),
                    );
                }
                self.writers.fetch_add(1, Ordering::SeqCst);
                drafts.insert(
                    key,
                    Draft {
                        writer: writer.clone(),
                        chunks: BTreeMap::new(),
                        owner: None,
                    },
                );
                Ok(ProvisionalAttachmentArtifactStoreResponse::Begun(writer))
            }
            ProvisionalAttachmentArtifactStoreRequest::WriteChunk {
                writer,
                chunk_index,
                bytes,
            } => {
                if self.fail_write.swap(false, Ordering::SeqCst) {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "injected Write failure",
                    ));
                }
                assert!(!bytes.is_empty() && bytes.len() <= ARTIFACT_CHUNK_BYTES);
                let key = format!(
                    "{}:{}:{}",
                    writer.account_id().as_str(),
                    writer.operation_id(),
                    writer.attachment_id()
                );
                self.drafts
                    .lock()
                    .unwrap()
                    .get_mut(&key)
                    .unwrap()
                    .chunks
                    .insert(chunk_index, bytes);
                Ok(ProvisionalAttachmentArtifactStoreResponse::ChunkWritten(
                    ArtifactChunkWrite::Stored,
                ))
            }
            ProvisionalAttachmentArtifactStoreRequest::Finalize {
                writer,
                publication_proof,
            } => {
                let key = format!(
                    "{}:{}:{}",
                    writer.account_id().as_str(),
                    writer.operation_id(),
                    writer.attachment_id()
                );
                let mut drafts = self.drafts.lock().unwrap();
                let draft = drafts.get_mut(&key).unwrap();
                let bytes: Vec<u8> = draft
                    .chunks
                    .values()
                    .flat_map(|chunk| chunk.iter().copied())
                    .collect();
                assert_eq!(publication_proof.byte_length(), bytes.len() as u64);
                assert_eq!(
                    publication_proof.ciphertext_sha256(),
                    format!("{:x}", Sha256::digest(&bytes))
                );
                let owner =
                    AttachmentArtifactOwner::from_publication_proof(&writer, publication_proof)?;
                self.bytes
                    .lock()
                    .unwrap()
                    .insert(owner.artifact_id().into(), bytes);
                draft.owner = Some(owner.clone());
                self.publications.fetch_add(1, Ordering::SeqCst);
                if self
                    .fail_finalize_after_publish
                    .swap(false, Ordering::SeqCst)
                {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::InvariantViolation,
                        "injected Finalize boundary failure",
                    ));
                }
                Ok(ProvisionalAttachmentArtifactStoreResponse::Finalized(owner))
            }
            ProvisionalAttachmentArtifactStoreRequest::ResumeRecovered { recovery } => {
                let key = format!(
                    "{}:{}:{}",
                    recovery.account_id().as_str(),
                    recovery.operation_id(),
                    recovery.attachment_id()
                );
                Ok(ProvisionalAttachmentArtifactStoreResponse::Finalized(
                    self.drafts.lock().unwrap()[&key].owner.clone().unwrap(),
                ))
            }
            _ => panic!("worker must use Begin/recovery only"),
        }
    }
}

#[async_trait]
impl AttachmentArtifactStore for Artifacts {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        if self.fail_read.swap(false, Ordering::SeqCst) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "injected canonical Read failure",
            ));
        }
        let AttachmentArtifactStoreRequest::ReadChunk { owner, chunk_index } = request else {
            panic!("read only")
        };
        let bytes = self.bytes.lock().unwrap();
        let bytes = &bytes[owner.artifact_id()];
        let start = chunk_index as usize * ARTIFACT_CHUNK_BYTES;
        let end = (start + ARTIFACT_CHUNK_BYTES).min(bytes.len());
        Ok(AttachmentArtifactStoreResponse::ChunkRead(
            PublishedArtifactChunk {
                bytes: bytes[start..end].to_vec(),
                is_last: end == bytes.len(),
            },
        ))
    }
}

struct Download {
    chunks: VecDeque<Vec<u8>>,
    chunks_read: usize,
    fail_after: Option<usize>,
}
#[async_trait]
impl SourceDownload for Download {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, PreparationTransportError> {
        if self.fail_after == Some(self.chunks_read) {
            self.fail_after = None;
            Err(PreparationTransportError::Transient)
        } else {
            let next = self.chunks.pop_front();
            if next.is_some() {
                self.chunks_read += 1;
            }
            Ok(next)
        }
    }
}

struct Upload {
    completed: Arc<Mutex<Vec<Vec<u8>>>>,
    bytes: Vec<u8>,
    fail_write: bool,
    writes: usize,
    fail_write_after: usize,
    fail_finish: bool,
}
#[async_trait]
impl StagingUpload for Upload {
    async fn write_chunk(&mut self, bytes: &[u8]) -> Result<(), PreparationTransportError> {
        if self.fail_write && self.writes == self.fail_write_after {
            self.fail_write = false;
            return Err(PreparationTransportError::Transient);
        }
        self.bytes.extend_from_slice(bytes);
        self.writes += 1;
        Ok(())
    }
    async fn finish(self: Box<Self>) -> Result<(), PreparationTransportError> {
        if self.fail_finish {
            Err(PreparationTransportError::Transient)
        } else {
            self.completed.lock().unwrap().push(self.bytes);
            Ok(())
        }
    }
}

struct Transfer {
    source: Mutex<Vec<u8>>,
    requests: Mutex<Vec<SourceDownloadRequest>>,
    manifests: Mutex<Vec<ManifestRequest>>,
    urls: Mutex<Vec<String>>,
    uploads: Arc<Mutex<Vec<Vec<u8>>>>,
    source_failures: AtomicUsize,
    next_chunk_failure_after: AtomicUsize,
    upload_write_failure_after: AtomicUsize,
    upload_finish_failures: AtomicUsize,
    stale: AtomicBool,
    corrupt: AtomicBool,
    manifest_fault: AtomicUsize,
}
impl Transfer {
    fn new(source: Vec<u8>) -> Self {
        Self {
            source: Mutex::new(source),
            requests: Mutex::new(vec![]),
            manifests: Mutex::new(vec![]),
            urls: Mutex::new(vec![]),
            uploads: Arc::new(Mutex::new(vec![])),
            source_failures: AtomicUsize::new(0),
            next_chunk_failure_after: AtomicUsize::new(usize::MAX),
            upload_write_failure_after: AtomicUsize::new(usize::MAX),
            upload_finish_failures: AtomicUsize::new(0),
            stale: AtomicBool::new(false),
            corrupt: AtomicBool::new(false),
            manifest_fault: AtomicUsize::new(0),
        }
    }
}
fn fail(counter: &AtomicUsize) -> bool {
    counter
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
        .is_ok()
}

#[async_trait]
impl AttachmentMoveTransfer for Transfer {
    async fn open_source(
        &self,
        request: SourceDownloadRequest,
    ) -> Result<Box<dyn SourceDownload>, PreparationTransportError> {
        self.requests.lock().unwrap().push(request.clone());
        if fail(&self.source_failures) {
            return Err(PreparationTransportError::Transient);
        }
        let mut bytes = self.source.lock().unwrap().clone();
        if request.pass == DownloadPass::Transcrypt && self.corrupt.load(Ordering::SeqCst) {
            let i = bytes.len() / 2;
            bytes[i] ^= 1;
        }
        Ok(Box::new(Download {
            chunks: bytes.chunks(17).map(<[u8]>::to_vec).collect(),
            chunks_read: 0,
            fail_after: (request.pass == DownloadPass::Transcrypt)
                .then(|| {
                    self.next_chunk_failure_after
                        .swap(usize::MAX, Ordering::SeqCst)
                })
                .filter(|after| *after != usize::MAX),
        }))
    }
    async fn renew_manifest(
        &self,
        request: ManifestRequest,
    ) -> Result<Manifest, PreparationTransportError> {
        self.manifests.lock().unwrap().push(request.clone());
        if self.stale.load(Ordering::SeqCst) {
            return Err(PreparationTransportError::StaleAuthority);
        }
        let renewal = self.manifests.lock().unwrap().len();
        let mut manifest = Manifest {
            operation_id: request.operation_id,
            uploads: request
                .attachments
                .into_iter()
                .map(|a| UploadGrant {
                    attachment_id: a.attachment_id,
                    storage_key: "stable-generation".into(),
                    upload_url: format!("https://upload.invalid/credential-{renewal}"),
                })
                .collect(),
        };
        match self.manifest_fault.swap(0, Ordering::SeqCst) {
            1 => manifest.operation_id = "wrong-operation".into(),
            2 => manifest.uploads.clear(),
            3 => manifest.uploads.push(UploadGrant {
                attachment_id: "foreign".into(),
                storage_key: "extra".into(),
                upload_url: "https://upload.invalid/extra".into(),
            }),
            4 => manifest.uploads.push(manifest.uploads[0].clone()),
            5 => manifest.uploads[0].upload_url.clear(),
            _ => {}
        }
        Ok(manifest)
    }
    async fn open_upload(
        &self,
        account: &AccountId,
        operation: &str,
        grant: &UploadGrant,
        owner: &AttachmentArtifactOwner,
    ) -> Result<Box<dyn StagingUpload>, PreparationTransportError> {
        assert_eq!(account, owner.account_id());
        assert_eq!(operation, owner.operation_id());
        assert_eq!(grant.attachment_id, owner.attachment_id());
        self.urls.lock().unwrap().push(grant.upload_url.clone());
        Ok(Box::new(Upload {
            completed: self.uploads.clone(),
            bytes: vec![],
            fail_write: self.upload_write_failure_after.load(Ordering::SeqCst) != usize::MAX,
            writes: 0,
            fail_write_after: self
                .upload_write_failure_after
                .swap(usize::MAX, Ordering::SeqCst),
            fail_finish: fail(&self.upload_finish_failures),
        }))
    }
}

struct Secrets {
    calls: AtomicUsize,
    fail_on_call: AtomicUsize,
}
impl Default for Secrets {
    fn default() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            fail_on_call: AtomicUsize::new(usize::MAX),
        }
    }
}
impl AttachmentMoveSecretProvider for Secrets {
    fn resolve(
        &self,
        _: &AttachmentMovePreparationRecord,
        _: &AuthorityAttachmentRecord,
    ) -> Result<AttachmentMoveSecrets, RuntimeError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if call == self.fail_on_call.load(Ordering::SeqCst) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "injected post-publication secret loss",
            ));
        }
        let target_key = stable_attachment_key();
        let prepared_metadata = prepared_metadata(format!("bundle-{call}"));
        Ok(AttachmentMoveSecrets {
            source_key: Zeroizing::new(SOURCE_KEY),
            target_key: Zeroizing::new(target_key),
            prepared_metadata,
        })
    }

    fn recover_published_metadata(
        &self,
        preparation: &AttachmentMovePreparationRecord,
        source: &AuthorityAttachmentRecord,
        owner: &AttachmentArtifactOwner,
    ) -> Result<crate::replica::PreparedMoveAttachment, RuntimeError> {
        if owner.account_id() != &preparation.account_id
            || owner.operation_id() != preparation.operation_id
            || owner.attachment_id() != source.id
            || source.item_id != preparation.item_id
            || source.vault_id != preparation.source_vault_id
            || owner.ciphertext_sha256().len() != 64
            || owner.byte_length() == 0
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "published metadata recovery owner is foreign",
            ));
        }
        Ok(prepared_metadata(format!(
            "recovered-{}",
            &owner.ciphertext_sha256()[..8]
        )))
    }
}

fn stable_attachment_key() -> [u8; 32] {
    [47; 32]
}

fn prepared_metadata(encrypted_name: String) -> crate::replica::PreparedMoveAttachment {
    crate::replica::PreparedMoveAttachment {
        encrypted_name,
        encryption_iv: "name-iv".into(),
        encryption_algorithm: "AES-GCM-AAD-V1".into(),
        // This fixture models the durable wrapped key as hex so a recreated provider can recover
        // it from immutable authority without retaining any pre-crash process memory.
        encrypted_attachment_key: BASE64.encode(stable_attachment_key()),
        attachment_key_iv: "key-iv".into(),
        attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_content_type: "target-type".into(),
        encrypted_content_type_iv: "type-iv".into(),
    }
}

#[tokio::test]
async fn one_coherent_secret_bundle_owns_target_ciphertext_and_checkpointed_metadata() {
    let f = Fixture::new().await;
    assert_eq!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    let snapshot = f.snapshot();
    let AttachmentMoveProgress::Encrypted {
        artifact, payload, ..
    } = &snapshot.attachment_move_preparations[0].progress[0]
    else {
        panic!("the target artifact must be checkpointed")
    };
    assert_eq!(payload.encrypted_name, "bundle-1");
    let target_key: [u8; 32] = BASE64
        .decode(&payload.encrypted_attachment_key)
        .unwrap()
        .try_into()
        .unwrap();
    let bytes = f.artifacts.bytes.lock().unwrap()[&artifact.artifact_id].clone();
    let envelope: EncryptedData = serde_json::from_slice(&bytes).unwrap();
    let plaintext = decrypt_with_aad(
        &envelope,
        &target_key,
        &AadContext {
            vault_id: TARGET.into(),
            entity_id: ATT.into(),
            entity_type: "attachment_blob".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .expect("checkpointed metadata names the exact key bundle that produced the artifact");
    assert_eq!(plaintext, PLAINTEXT);
    assert_eq!(f.secrets.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn shared_attachment_move_retains_the_original_uploader_blob_scope() {
    let f = Fixture::new_with_uploader(ORIGINAL_UPLOADER).await;

    assert_eq!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    let snapshot = f.snapshot();
    let AttachmentMoveProgress::Encrypted {
        artifact, payload, ..
    } = &snapshot.attachment_move_preparations[0].progress[0]
    else {
        panic!("the original uploader scope must authenticate the source")
    };
    let target_key: [u8; 32] = BASE64
        .decode(&payload.encrypted_attachment_key)
        .unwrap()
        .try_into()
        .unwrap();
    let bytes = f.artifacts.bytes.lock().unwrap()[&artifact.artifact_id].clone();
    let envelope: EncryptedData = serde_json::from_slice(&bytes).unwrap();
    let uploader_scope = AadContext {
        vault_id: TARGET.into(),
        entity_id: ATT.into(),
        entity_type: "attachment_blob".into(),
        version: 1,
        user_id: ORIGINAL_UPLOADER.into(),
    };
    let mover_scope = AadContext {
        user_id: USER.into(),
        ..uploader_scope.clone()
    };

    assert_eq!(
        decrypt_with_aad(&envelope, &target_key, &uploader_scope).unwrap(),
        PLAINTEXT
    );
    assert!(decrypt_with_aad(&envelope, &target_key, &mover_scope).is_err());
}

#[tokio::test]
async fn published_metadata_recovery_rejects_a_foreign_canonical_owner() {
    let f = Fixture::new().await;
    assert_eq!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    let snapshot = f.snapshot();
    let preparation = &snapshot.attachment_move_preparations[0];
    let AttachmentMoveProgress::Encrypted { artifact, .. } = &preparation.progress[0] else {
        unreachable!()
    };
    let foreign_account = AccountId::from("account-foreign");
    let foreign_ref = crate::replica::attachment_move_artifact_ref(
        &foreign_account,
        OP,
        ATT,
        &artifact.ciphertext_sha256,
        artifact.byte_length,
    )
    .unwrap();
    let foreign = AttachmentArtifactOwner::from_reference_parts(
        foreign_account,
        OP,
        ATT,
        foreign_ref.artifact_id,
        foreign_ref.ciphertext_sha256,
        foreign_ref.byte_length,
    )
    .unwrap();
    let error = f
        .secrets
        .recover_published_metadata(preparation, &preparation.source_attachments[0], &foreign)
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
}

struct Fixture {
    persistence: Arc<InMemoryReplica>,
    replica: Arc<Replica>,
    artifacts: Arc<Artifacts>,
    transfer: Arc<Transfer>,
    secrets: Arc<Secrets>,
    worker: AttachmentMovePreparationWorker,
    account: AccountId,
}
impl Fixture {
    async fn new() -> Self {
        Self::new_with_uploader(USER).await
    }

    async fn new_with_uploader(uploaded_by: &str) -> Self {
        let account = AccountId::from("account-main");
        let persistence = Arc::new(InMemoryReplica::default());
        seed_with_uploader(&persistence, account.clone(), OP, uploaded_by);
        let replica = Arc::new(Replica::new(persistence.clone()));
        replica.load(&account).await.unwrap();
        let artifacts = Arc::new(Artifacts::default());
        let transfer = Arc::new(Transfer::new(envelope_for_uploader(PLAINTEXT, uploaded_by)));
        let secrets = Arc::new(Secrets::default());
        let worker = AttachmentMovePreparationWorker::new(
            replica.clone(),
            artifacts.clone(),
            artifacts.clone(),
            transfer.clone(),
            secrets.clone(),
        );
        Self {
            persistence,
            replica,
            artifacts,
            transfer,
            secrets,
            worker,
            account,
        }
    }
    async fn restart(&mut self) {
        self.replica = Arc::new(Replica::new(self.persistence.clone()));
        self.replica.load(&self.account).await.unwrap();
        self.secrets = Arc::new(Secrets::default());
        self.worker = AttachmentMovePreparationWorker::new(
            self.replica.clone(),
            self.artifacts.clone(),
            self.artifacts.clone(),
            self.transfer.clone(),
            self.secrets.clone(),
        );
    }
    async fn drive(&self, now_ms: u64) -> Result<PreparationDriveResult, RuntimeError> {
        self.worker
            .drive(PreparationDriveRequest::Advance {
                account_id: self.account.clone(),
                operation_id: OP.into(),
                now_ms,
            })
            .await
    }
    fn snapshot(&self) -> crate::replica::ReplicaSnapshot {
        self.replica.snapshot(&self.account).unwrap()
    }
}

fn envelope_for(plaintext: &str) -> Vec<u8> {
    envelope_for_uploader(plaintext, USER)
}

fn envelope_for_uploader(plaintext: &str, uploaded_by: &str) -> Vec<u8> {
    serde_json::to_vec(
        &encrypt_with_aad(
            plaintext,
            &SOURCE_KEY,
            &AadContext {
                vault_id: SOURCE.into(),
                entity_id: ATT.into(),
                entity_type: "attachment_blob".into(),
                version: 1,
                user_id: uploaded_by.into(),
            },
        )
        .unwrap(),
    )
    .unwrap()
}
fn attachment_with_uploader(uploaded_by: &str) -> AuthorityAttachmentRecord {
    AuthorityAttachmentRecord {
        id: ATT.into(),
        item_id: ITEM.into(),
        vault_id: SOURCE.into(),
        storage_key: "source-key".into(),
        encrypted_name: "source-name".into(),
        encryption_iv: "name-iv".into(),
        encryption_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_attachment_key: "wrapped-key".into(),
        attachment_key_iv: "key-iv".into(),
        attachment_key_algorithm: "AES-GCM-AAD-V1".into(),
        encrypted_content_type: "source-type".into(),
        encrypted_content_type_iv: "type-iv".into(),
        envelope_version: 1,
        file_size: 73,
        uploaded_by: uploaded_by.into(),
        created_at: "2026-08-25T00:00:00Z".into(),
    }
}
fn seed(inner: &InMemoryReplica, account: AccountId, operation: &str) {
    seed_with_uploader(inner, account, operation, USER)
}

fn seed_with_uploader(
    inner: &InMemoryReplica,
    account: AccountId,
    operation: &str,
    uploaded_by: &str,
) {
    inner
        .install(
            account.clone(),
            USER.into(),
            crate::protocol::Incarnation::from(format!("incarnation-{}", account.as_str())),
        )
        .unwrap();
    let source = attachment_with_uploader(uploaded_by);
    inner
        .seed_ready_authority(
            &account,
            vec![personal_vault(SOURCE, USER), personal_vault(TARGET, USER)],
            vec![AuthorityItemRecord {
                id: ITEM.into(),
                vault_id: SOURCE.into(),
                category: AuthorityItemCategory::Login,
                favorite: false,
                encrypted_data: "item-source".into(),
                encryption_iv: "item-iv".into(),
                encryption_algorithm: "AES-GCM-AAD-V1".into(),
                version: 1,
                encryption_version: 1,
                encrypted_by_user_id: USER.into(),
                last_modified_by: USER.into(),
                created_at: "2026-08-25T00:00:00Z".into(),
                updated_at: "2026-08-25T00:00:00Z".into(),
                deleted_at: None,
                attachments: vec![source.clone()],
            }],
        )
        .unwrap();
    let s = inner.snapshot(&account).unwrap();
    let mut p = AttachmentMovePreparationRecord {
        account_id: account.clone(),
        operation_id: operation.into(),
        item_id: ITEM.into(),
        source_vault_id: SOURCE.into(),
        target_vault_id: TARGET.into(),
        expected_item_version: 1,
        target_encrypted_data: "item-target".into(),
        target_encryption_algorithm: "AES-GCM-AAD-V1".into(),
        target_encryption_iv: "item-target-iv".into(),
        source_attachments: vec![source],
        progress: vec![AttachmentMoveProgress::Pending {
            attachment_id: ATT.into(),
            expected_envelope_version: 1,
        }],
        intent_fingerprint: Sha256Fingerprint([0; 32]),
        scheduling: OperationSchedulingState::default(),
    };
    p.intent_fingerprint = attachment_move_intent_fingerprint(&p).unwrap();
    inner
        .execute(GuardedCommitPlan::new(
            account.clone(),
            s.incarnation,
            s.revision,
            s.lock_epoch,
            vec![
                PlanMutation::AcceptAttachmentMovePreparation(p),
                PlanMutation::PutOptimisticItem(ReplicaItemRecord {
                    account_id: account,
                    item_id: ITEM.into(),
                    vault_id: TARGET.into(),
                    operation_id: operation.into(),
                    category: AuthorityItemCategory::Login,
                    encrypted_data: "item-target".into(),
                    encryption_iv: "item-target-iv".into(),
                    encryption_algorithm: "AES-GCM-AAD-V1".into(),
                    encryption_version: 1,
                    encrypted_by_user_id: USER.into(),
                    favorite: false,
                    version: 1,
                    created_at: "2026-08-25T00:00:00Z".into(),
                    updated_at: "2026-08-25T00:00:00Z".into(),
                    deleted_at: None,
                    attachments: vec![],
                    permanently_deleted: false,
                }),
            ],
        ))
        .unwrap();
}

#[tokio::test]
async fn restart_boundaries_publish_before_checkpoint_and_keep_one_writer() {
    let mut f = Fixture::new().await;
    f.artifacts
        .fail_finalize_after_publish
        .store(true, Ordering::SeqCst);
    let error = f.drive(0).await.unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(f.artifacts.publications.load(Ordering::SeqCst), 1);
    assert!(matches!(
        f.snapshot().attachment_move_preparations[0].progress[0],
        AttachmentMoveProgress::Pending { .. }
    ));
    assert_eq!(
        f.transfer
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.pass)
            .collect::<Vec<_>>(),
        vec![DownloadPass::Scan, DownloadPass::Transcrypt]
    );
    f.restart().await;
    assert_eq!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    assert_eq!(f.artifacts.writers.load(Ordering::SeqCst), 1);
    assert_eq!(f.transfer.requests.lock().unwrap().len(), 2);
    assert_eq!(f.secrets.calls.load(Ordering::SeqCst), 0);
    let AttachmentMoveProgress::Encrypted { payload, .. } =
        &f.snapshot().attachment_move_preparations[0].progress[0]
    else {
        unreachable!()
    };
    assert!(payload.encrypted_name.starts_with("recovered-"));
    let target_key: [u8; 32] = BASE64
        .decode(&payload.encrypted_attachment_key)
        .unwrap()
        .try_into()
        .unwrap();
    let AttachmentMoveProgress::Encrypted { artifact, .. } =
        &f.snapshot().attachment_move_preparations[0].progress[0]
    else {
        unreachable!()
    };
    let envelope: EncryptedData =
        serde_json::from_slice(&f.artifacts.bytes.lock().unwrap()[&artifact.artifact_id]).unwrap();
    assert_eq!(
        decrypt_with_aad(
            &envelope,
            &target_key,
            &AadContext {
                vault_id: TARGET.into(),
                entity_id: ATT.into(),
                entity_type: "attachment_blob".into(),
                version: 1,
                user_id: USER.into(),
            }
        )
        .unwrap(),
        PLAINTEXT
    );
    f.restart().await;
    assert_eq!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    assert!(matches!(
        f.snapshot().attachment_move_preparations[0].progress[0],
        AttachmentMoveProgress::Encrypted {
            upload: AttachmentMoveUploadState::Uploaded,
            ..
        }
    ));
    let uploaded = f.transfer.uploads.lock().unwrap()[0].clone();
    let AttachmentMoveProgress::Encrypted { artifact, .. } =
        &f.snapshot().attachment_move_preparations[0].progress[0]
    else {
        unreachable!()
    };
    assert_eq!(
        uploaded,
        f.artifacts.bytes.lock().unwrap()[&artifact.artifact_id]
    );
    assert_eq!(uploaded.len() as u64, artifact.byte_length);
    assert_eq!(
        format!("{:x}", Sha256::digest(&uploaded)),
        artifact.ciphertext_sha256
    );
    f.restart().await;
    assert_eq!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::ReadyForDispatch
    );
    let promoted = f.snapshot();
    assert!(promoted.attachment_move_preparations.is_empty());
    assert_eq!(promoted.operations.len(), 1);
    assert!(!String::from_utf8_lossy(&promoted.operations[0].request.body).contains(PLAINTEXT));
    let fp = promoted.operations[0].request_fingerprint;
    f.restart().await;
    assert_eq!(
        f.worker
            .drive(PreparationDriveRequest::ReactivateStagingIncomplete {
                account_id: f.account.clone(),
                operation_id: OP.into(),
                expected_request_fingerprint: fp
            })
            .await
            .unwrap(),
        PreparationDriveResult::Progressed
    );
    assert_eq!(f.snapshot().attachment_move_preparations.len(), 1);
}

#[tokio::test]
async fn more_than_five_failures_persist_unbounded_backoff_and_renew_credentials() {
    let mut f = Fixture::new().await;
    f.transfer.source_failures.store(7, Ordering::SeqCst);
    let mut now = 0;
    for attempt in 1..=7 {
        let PreparationDriveResult::BackingOff { not_before_ms } = f.drive(now).await.unwrap()
        else {
            panic!()
        };
        assert_eq!(
            f.snapshot().attachment_move_preparations[0]
                .scheduling
                .attempt_count,
            attempt
        );
        now = not_before_ms;
        f.restart().await;
    }
    assert_eq!(
        f.drive(now).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    f.transfer.upload_finish_failures.store(1, Ordering::SeqCst);
    let PreparationDriveResult::BackingOff { not_before_ms } = f.drive(now).await.unwrap() else {
        panic!()
    };
    f.restart().await;
    assert_eq!(
        f.drive(not_before_ms).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    let manifests = f.transfer.manifests.lock().unwrap();
    assert_eq!(manifests.len(), 2);
    assert_eq!(manifests[0], manifests[1]);
    let urls = f.transfer.urls.lock().unwrap();
    assert_ne!(urls[0], urls[1]);
}

#[tokio::test]
async fn corruption_never_publishes_and_stale_authority_freezes_terminal_request() {
    let f = Fixture::new().await;
    f.transfer.corrupt.store(true, Ordering::SeqCst);
    assert!(matches!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::BackingOff { .. }
    ));
    assert_eq!(f.artifacts.publications.load(Ordering::SeqCst), 0);
    assert!(matches!(
        f.snapshot().attachment_move_preparations[0].progress[0],
        AttachmentMoveProgress::Pending { .. }
    ));
    let f = Fixture::new().await;
    assert_eq!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    f.transfer.stale.store(true, Ordering::SeqCst);
    assert_eq!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::FrozenStaleAuthority
    );
    let body: serde_json::Value =
        serde_json::from_slice(&f.snapshot().operations[0].request.body).unwrap();
    assert_eq!(body["mode"], "reject_stale_authority");
    assert!(body.get("encryptedData").is_none());
}

#[tokio::test]
async fn account_scope_is_explicit_and_cannot_select_foreign_work() {
    let f = Fixture::new().await;
    let other = AccountId::from("account-other");
    seed(&f.persistence, other.clone(), OP);
    f.replica.load(&other).await.unwrap();
    let error = f
        .worker
        .drive(PreparationDriveRequest::Advance {
            account_id: AccountId::from("account-missing"),
            operation_id: OP.into(),
            now_ms: 0,
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AccountMissing);
    assert_eq!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    assert!(matches!(
        f.replica
            .snapshot(&other)
            .unwrap()
            .attachment_move_preparations[0]
            .progress[0],
        AttachmentMoveProgress::Pending { .. }
    ));
}

#[tokio::test]
async fn malformed_manifests_never_upload_checkpoint_or_back_off() {
    for fault in 1..=5 {
        let f = Fixture::new().await;
        assert_eq!(
            f.drive(0).await.unwrap(),
            PreparationDriveResult::Progressed
        );
        f.transfer.manifest_fault.store(fault, Ordering::SeqCst);
        let error = f.drive(0).await.unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        let preparation = &f.snapshot().attachment_move_preparations[0];
        assert_eq!(preparation.scheduling, OperationSchedulingState::default());
        assert!(matches!(
            preparation.progress[0],
            AttachmentMoveProgress::Encrypted {
                upload: AttachmentMoveUploadState::NeedsUpload,
                ..
            }
        ));
        assert!(f.transfer.uploads.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn local_secret_and_artifact_failures_propagate_without_transport_backoff() {
    let f = Fixture::new().await;
    f.secrets.fail_on_call.store(1, Ordering::SeqCst);
    assert_eq!(
        f.drive(0).await.unwrap_err().code,
        RuntimeErrorCode::InvariantViolation
    );
    assert_eq!(
        f.snapshot().attachment_move_preparations[0].scheduling,
        OperationSchedulingState::default()
    );

    for fault in ["begin", "write"] {
        let f = Fixture::new().await;
        match fault {
            "begin" => f.artifacts.fail_begin.store(true, Ordering::SeqCst),
            _ => f.artifacts.fail_write.store(true, Ordering::SeqCst),
        }
        assert_eq!(
            f.drive(0).await.unwrap_err().code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(
            f.snapshot().attachment_move_preparations[0].scheduling,
            OperationSchedulingState::default()
        );
    }

    let f = Fixture::new().await;
    assert_eq!(
        f.drive(0).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    f.artifacts.fail_read.store(true, Ordering::SeqCst);
    assert_eq!(
        f.drive(0).await.unwrap_err().code,
        RuntimeErrorCode::InvariantViolation
    );
    assert_eq!(
        f.snapshot().attachment_move_preparations[0].scheduling,
        OperationSchedulingState::default()
    );
}

#[tokio::test]
async fn streaming_and_upload_failures_remain_retryable_across_restart() {
    let mut f = Fixture::new().await;
    *f.transfer.source.lock().unwrap() = envelope_for(&"x".repeat(300_000));
    f.transfer
        .next_chunk_failure_after
        .store(1, Ordering::SeqCst);
    let PreparationDriveResult::BackingOff { not_before_ms } = f.drive(0).await.unwrap() else {
        panic!()
    };
    assert_eq!(f.artifacts.publications.load(Ordering::SeqCst), 0);
    assert!(matches!(
        f.snapshot().attachment_move_preparations[0].progress[0],
        AttachmentMoveProgress::Pending { .. }
    ));
    f.restart().await;
    assert_eq!(
        f.drive(not_before_ms).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    assert_eq!(f.artifacts.drafts.lock().unwrap().len(), 1);
    f.transfer
        .upload_write_failure_after
        .store(1, Ordering::SeqCst);
    let PreparationDriveResult::BackingOff { not_before_ms } =
        f.drive(not_before_ms).await.unwrap()
    else {
        panic!()
    };
    assert!(f.transfer.uploads.lock().unwrap().is_empty());
    assert!(matches!(
        f.snapshot().attachment_move_preparations[0].progress[0],
        AttachmentMoveProgress::Encrypted {
            upload: AttachmentMoveUploadState::NeedsUpload,
            ..
        }
    ));
    f.restart().await;
    assert_eq!(
        f.drive(not_before_ms).await.unwrap(),
        PreparationDriveResult::Progressed
    );
    let snapshot = f.snapshot();
    let AttachmentMoveProgress::Encrypted {
        artifact,
        upload: AttachmentMoveUploadState::Uploaded,
        ..
    } = &snapshot.attachment_move_preparations[0].progress[0]
    else {
        panic!()
    };
    assert_eq!(
        f.transfer.uploads.lock().unwrap()[0],
        f.artifacts.bytes.lock().unwrap()[&artifact.artifact_id]
    );
}
