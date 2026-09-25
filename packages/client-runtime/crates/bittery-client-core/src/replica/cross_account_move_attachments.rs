//! Fixed Attachment intent and registration evidence, separate from retained Item outcomes.
use super::*;
use crate::server_contract::{
    AttachmentUploadBody, CreateAttachmentBody, DurableAttachmentUploadBody,
};

pub(crate) fn attachment_registration_matches(
    attachment: &AuthorityAttachmentRecord,
    body: &CreateAttachmentBody,
    item_id: &str,
    vault_id: &str,
    uploaded_by: &str,
) -> bool {
    attachment.id == body.attachment_id
        && attachment.item_id == item_id
        && attachment.vault_id == vault_id
        && attachment.storage_key == body.storage_key
        && attachment.encrypted_attachment_key == body.encrypted_attachment_key
        && attachment.attachment_key_iv == body.attachment_key_iv
        && attachment.attachment_key_algorithm == body.attachment_key_algorithm
        && attachment.envelope_version == body.envelope_version
        && attachment.encrypted_name == body.encrypted_name
        && attachment.encrypted_content_type == body.encrypted_content_type
        && attachment.encryption_iv == body.encryption_iv
        && attachment.encrypted_content_type_iv == body.encrypted_content_type_iv
        && attachment.encryption_algorithm == body.encryption_algorithm
        && attachment.file_size == body.file_size
        && attachment.uploaded_by == uploaded_by
}

fn json_post<T: Serialize>(path: String, body: &T) -> Result<ImmutableHttpRequest, RuntimeError> {
    Ok(ImmutableHttpRequest {
        method: HttpMethod::Post,
        path,
        headers: vec![HttpHeader {
            name: "Content-Type".into(),
            value: "application/json".into(),
        }],
        body: serde_json::to_vec(body)
            .map_err(|_| replica_invariant("Move Attachment request could not be serialized"))?,
    })
}

impl CrossAccountMoveRecord {
    pub(crate) fn registration(
        &self,
        index: usize,
    ) -> Option<&CrossAccountMoveAttachmentRegistration> {
        match self.children.get(index.checked_add(1)?)? {
            CrossAccountMoveChild::AttachmentRegistration(registration) => Some(registration),
            CrossAccountMoveChild::ItemOperation(_) => None,
        }
    }

    pub(crate) fn attachment_grant_request(
        &self,
        index: usize,
        artifact: &AttachmentMoveArtifactRef,
    ) -> Result<ImmutableHttpRequest, RuntimeError> {
        let checkpoint = self
            .attachments
            .get(index)
            .ok_or_else(|| replica_invariant("Move Attachment checkpoint is missing"))?;
        let source = self
            .source
            .attachments
            .get(index)
            .ok_or_else(|| replica_invariant("Move source Attachment is missing"))?;
        json_post(
            format!("/api/v1/items/{}/attachment-uploads", self.target.id),
            &AttachmentUploadBody {
                file_name: format!("{}.enc", checkpoint.target_attachment_id),
                content_type: "application/octet-stream".into(),
                file_size: source.file_size,
                durable_upload: Some(DurableAttachmentUploadBody {
                    attachment_id: checkpoint.target_attachment_id.clone(),
                    ciphertext_sha256: artifact.ciphertext_sha256.clone(),
                }),
            },
        )
    }

    pub(crate) fn attachment_registration(
        &self,
        index: usize,
        storage_key: &str,
    ) -> Result<CrossAccountMoveAttachmentRegistration, RuntimeError> {
        let checkpoint = self
            .attachments
            .get(index)
            .ok_or_else(|| replica_invariant("Move Attachment checkpoint is missing"))?;
        let source = self
            .source
            .attachments
            .get(index)
            .ok_or_else(|| replica_invariant("Move source Attachment is missing"))?;
        if storage_key.is_empty() {
            return Err(replica_invariant(
                "Move registration has no target storage key",
            ));
        }
        let metadata = &checkpoint.target_metadata;
        let request = json_post(
            format!("/api/v1/items/{}/attachments", self.target.id),
            &CreateAttachmentBody {
                attachment_id: checkpoint.target_attachment_id.clone(),
                storage_key: storage_key.into(),
                encrypted_name: metadata.encrypted_name.clone(),
                encryption_iv: metadata.encryption_iv.clone(),
                encryption_algorithm: metadata.encryption_algorithm.clone(),
                encrypted_attachment_key: metadata.encrypted_attachment_key.clone(),
                attachment_key_iv: metadata.attachment_key_iv.clone(),
                attachment_key_algorithm: metadata.attachment_key_algorithm.clone(),
                encrypted_content_type: metadata.encrypted_content_type.clone(),
                encrypted_content_type_iv: metadata.encrypted_content_type_iv.clone(),
                envelope_version: 1,
                file_size: source.file_size,
            },
        )?;
        let fingerprint_bytes =
            serde_json::to_vec(&("bittery.cross-account-attachment-registration.v1", &request))
                .map_err(|_| {
                    replica_invariant("Move registration fingerprint could not be serialized")
                })?;
        Ok(CrossAccountMoveAttachmentRegistration {
            source_attachment_id: checkpoint.source_attachment_id.clone(),
            request,
            request_fingerprint: Sha256Fingerprint::of_bytes(&fingerprint_bytes),
            result: None,
        })
    }

    pub(super) fn validate_attachments(
        &self,
        source_account: &AccountId,
    ) -> Result<(), RuntimeError> {
        if self.attachments.len() != self.source.attachments.len()
            || !self.target.attachments.is_empty()
        {
            return Err(replica_invariant(
                "Move Attachment checkpoints must match the full source manifest",
            ));
        }
        validate_authority_page(&[], std::slice::from_ref(&self.source))?;
        let source_ids: HashSet<_> = self
            .source
            .attachments
            .iter()
            .map(|source| source.id.as_str())
            .collect();
        let mut target_ids = HashSet::new();
        for (index, (source, checkpoint)) in self
            .source
            .attachments
            .iter()
            .zip(&self.attachments)
            .enumerate()
        {
            validate_identifier(&checkpoint.target_attachment_id, "Move target Attachment")?;
            if source.id != checkpoint.source_attachment_id
                || source.envelope_version < 1
                || source.file_size < 0
                || source.uploaded_by.is_empty()
                || source.storage_key.is_empty()
                || !valid_prepared_attachment(&checkpoint.target_metadata)
                || source_ids.contains(checkpoint.target_attachment_id.as_str())
                || !target_ids.insert(checkpoint.target_attachment_id.as_str())
            {
                return Err(replica_invariant(
                    "Move Attachment metadata or identity differs from accepted intent",
                ));
            }
            if let CrossAccountMoveAttachmentProgress::Encrypted {
                artifact,
                grant_request,
            } = &checkpoint.progress
            {
                validate_artifact_ref(
                    artifact,
                    source_account,
                    &self.operation_id,
                    &checkpoint.target_attachment_id,
                )?;
                if *grant_request != self.attachment_grant_request(index, artifact)?
                    || !self
                        .children
                        .first()
                        .is_some_and(CrossAccountMoveChild::proved)
                {
                    return Err(replica_invariant(
                        "Move artifact has no exact grant intent or target proof",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn validate_registration(
        &self,
        index: usize,
        registration: &CrossAccountMoveAttachmentRegistration,
    ) -> Result<(), RuntimeError> {
        let body: CreateAttachmentBody = serde_json::from_slice(&registration.request.body)
            .map_err(|_| {
                replica_invariant("Move registration is not a closed Attachment request")
            })?;
        let mut expected = self.attachment_registration(index, &body.storage_key)?;
        expected.result = registration.result.clone();
        if expected != *registration
            || !matches!(
                self.attachments[index].progress,
                CrossAccountMoveAttachmentProgress::Encrypted { .. }
            )
        {
            return Err(replica_invariant(
                "Move registration differs from fixed metadata or sealed artifact",
            ));
        }
        let valid = match &registration.result {
            None => true,
            Some(CrossAccountMoveAttachmentEvidence::Acknowledged { attachment_id }) => {
                attachment_id == &body.attachment_id
            }
            Some(CrossAccountMoveAttachmentEvidence::VerifiedPresent { attachment }) => {
                attachment_registration_matches(
                    attachment,
                    &body,
                    &self.target.id,
                    &self.target.vault_id,
                    &self.destination_identity.user_id,
                )
            }
        };
        if !valid {
            return Err(replica_invariant(
                "Move registration evidence does not prove its exact target Attachment",
            ));
        }
        Ok(())
    }

    pub(super) fn validate_attachment_advance(&self, next: &Self) -> Result<(), RuntimeError> {
        if self.attachments.len() != next.attachments.len() {
            return Err(replica_invariant("Move Attachment manifest changed"));
        }
        let mut changed = false;
        for (index, (old, new)) in self.attachments.iter().zip(&next.attachments).enumerate() {
            if old.source_attachment_id != new.source_attachment_id
                || old.target_attachment_id != new.target_attachment_id
                || old.target_metadata != new.target_metadata
            {
                return Err(replica_invariant(
                    "Move accepted Attachment metadata changed",
                ));
            }
            if old.progress == new.progress {
                continue;
            }
            if changed
                || self.stage != next.stage
                || self.children != next.children
                || self.stage
                    != (CrossAccountMoveStage::Attachments {
                        next_index: index as u32,
                    })
                || !matches!(old.progress, CrossAccountMoveAttachmentProgress::Pending)
                || !matches!(
                    new.progress,
                    CrossAccountMoveAttachmentProgress::Encrypted { .. }
                )
            {
                return Err(replica_invariant(
                    "Move Attachment checkpoint advanced outside its current preparation",
                ));
            }
            changed = true;
        }
        Ok(())
    }
}
