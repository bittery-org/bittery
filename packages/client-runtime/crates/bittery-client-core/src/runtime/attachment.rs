//! Foreground ordinary Attachment requests.
//!
//! The module keeps crypto, authenticated HTTP, authoritative probing, and guarded Replica
//! publication behind the Runtime request seam. These requests are deliberately not Operations.

use super::*;
use crate::{
    auth_http::{AttachmentDeleteAnswer, AttachmentRenameAnswer, AuthenticatedOutcome},
    platform_storage::CurrentSessionDocument,
    replica::{
        AuthorityAttachmentRecord, AuthorityItemRecord, AuthorityVaultRole,
        ForegroundAttachmentCommitPlan, ForegroundAttachmentCommitResult,
    },
    server_contract::{UpdateAttachmentBody, VaultAttachmentResponse},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{
    decrypt_vault_key_with_muk, decrypt_with_aad, encrypt_with_aad, AadContext, EncryptedData,
    WrappedVaultKeyData,
};

impl Runtime {
    pub(super) async fn delete_attachment(
        &self,
        account_id: AccountId,
        attachment_id: String,
        cancellation: RequestCancellation,
        teardown_admission: tokio::sync::RwLockReadGuard<'_, ()>,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let initial = self.require_snapshot(&account_id)?;
        if initial.failure.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountFailed,
                "the selected Account module has failed",
            ));
        }
        let (item_id, vault_id) = find_attachment_address(&initial, &attachment_id)?;
        let item_lock = self.item_mutation_lock(&account_id, &item_id);
        let item_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = item_lock.lock() => guard,
        };
        let execution_lock = self.account_execution_lock(&account_id)?;
        let execution_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution_lock.lock() => guard,
        };
        self.ensure_attachment_admission(&account_id, &cancellation)?;
        let snapshot = self.require_snapshot(&account_id)?;
        let (current_item_id, current_vault_id) =
            find_attachment_address(&snapshot, &attachment_id)?;
        if current_item_id != item_id || current_vault_id != vault_id {
            return Err(retryable("Attachment authority changed before Delete"));
        }
        if item_has_optimistic_owner(&snapshot, &item_id) {
            return Err(retryable(
                "an optimistic Item owner must reconcile before Attachment Delete",
            ));
        }
        let (_, vault) = attachment_and_vault(&snapshot, &attachment_id)?;
        if vault.role == AuthorityVaultRole::ReadOnly {
            return Err(RuntimeError::new(
                RuntimeErrorCode::ReadOnly,
                "the Attachment belongs to a read-only Vault",
            ));
        }
        let foreground_guard = self.foreground_attachments.register(
            &account_id,
            &snapshot.incarnation,
            cancellation.clone(),
        )?;
        let auth_config = self.auth_client_config.clone().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "authentication is not configured for this Runtime",
            )
        })?;
        drop(execution_guard);

        let metadata = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            result = self.platform_storage.load_account_metadata(&account_id, &snapshot.incarnation) => {
                result.map_err(|_| retryable("Account metadata could not be loaded"))?
                    .ok_or_else(authentication_required)?
            }
        };
        let mut session = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            result = self.platform_storage.load_current_session(&account_id, &snapshot.incarnation) => {
                result.map_err(|_| retryable("Session could not be loaded"))?
                    .ok_or_else(authentication_required)?
            }
        };
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        )?;
        let mut renewed = false;
        let mut deletion = http
            .delete_attachment(session.token.as_ref(), &attachment_id, cancellation.clone())
            .await?;
        if matches!(deletion, AuthenticatedOutcome::ReauthenticationRequired) {
            renew_once(
                self,
                &account_id,
                &http,
                &mut session,
                &mut renewed,
                cancellation.clone(),
            )
            .await?;
            deletion = http
                .delete_attachment(session.token.as_ref(), &attachment_id, cancellation.clone())
                .await?;
        }
        match deletion {
            AuthenticatedOutcome::Ok(
                AttachmentDeleteAnswer::Deleted
                | AttachmentDeleteAnswer::Ambiguous
                | AttachmentDeleteAnswer::Missing,
            )
            | AuthenticatedOutcome::Transient => {}
            AuthenticatedOutcome::Ok(AttachmentDeleteAnswer::AccessDenied) => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccessDenied,
                    "Attachment Delete was denied",
                ));
            }
            AuthenticatedOutcome::ReauthenticationRequired => {
                self.mark_reauthentication_required(&account_id);
                return Err(authentication_required());
            }
        }

        let item = fetch_item_authority(
            self,
            &http,
            AttachmentAuthority {
                account_id: &account_id,
                item_id: &item_id,
                attachment_id: &attachment_id,
                expectation: AttachmentAuthorityExpectation::Deleted {
                    vault_id: &vault_id,
                },
                cancellation: cancellation.clone(),
            },
            &mut session,
            &mut renewed,
        )
        .await?;
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }

        let execution_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution_lock.lock() => guard,
        };
        self.ensure_attachment_admission(&account_id, &cancellation)?;
        let current = self.require_snapshot(&account_id)?;
        if current.incarnation != snapshot.incarnation {
            return Err(retryable(
                "Account incarnation changed before Attachment Delete publication",
            ));
        }
        let result = self
            .replica
            .execute_foreground_attachment_exact(ForegroundAttachmentCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                attachment_id.clone(),
                false,
                item,
            ))
            .await?;
        match result {
            ForegroundAttachmentCommitResult::Applied { .. } => {}
            ForegroundAttachmentCommitResult::StaleReplica { .. }
            | ForegroundAttachmentCommitResult::StaleAuthority { .. } => {
                return Err(retryable(
                    "Replica authority changed before Attachment Delete publication",
                ));
            }
            ForegroundAttachmentCommitResult::Missing => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccountMissing,
                    "Account disappeared before Attachment Delete publication",
                ));
            }
        };
        let publication = self.foreground_attachments.publication(&foreground_guard);
        let prepared_publications =
            self.decrypt_visible_items_for_foreground_attachment(&account_id)?;
        let response = RuntimeResponse::AttachmentDeleted {
            account_id,
            attachment_id,
        };
        drop(execution_guard);
        drop(foreground_guard);
        drop(item_guard);
        drop(teardown_admission);
        if let Some(prepared_publications) = prepared_publications {
            prepared_publications.publish(publication);
        }
        Ok(response)
    }

    pub(super) async fn rename_attachment(
        &self,
        account_id: AccountId,
        attachment_id: String,
        name: String,
        cancellation: RequestCancellation,
        teardown_admission: tokio::sync::RwLockReadGuard<'_, ()>,
    ) -> Result<RuntimeResponse, RuntimeError> {
        validate_rename_name(&name)?;
        let initial = self.require_snapshot(&account_id)?;
        if initial.failure.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountFailed,
                "the selected Account module has failed",
            ));
        }
        let (item_id, _) = find_attachment_address(&initial, &attachment_id)?;
        let item_lock = self.item_mutation_lock(&account_id, &item_id);
        let item_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = item_lock.lock() => guard,
        };
        let execution_lock = self.account_execution_lock(&account_id)?;
        let execution_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution_lock.lock() => guard,
        };
        self.ensure_attachment_admission(&account_id, &cancellation)?;
        let snapshot = self.require_snapshot(&account_id)?;
        let (current_item_id, _) = find_attachment_address(&snapshot, &attachment_id)?;
        if current_item_id != item_id {
            return Err(retryable("Attachment authority changed before Rename"));
        }
        if item_has_optimistic_owner(&snapshot, &item_id) {
            return Err(retryable(
                "an optimistic Item owner must reconcile before Attachment Rename",
            ));
        }
        let (source_attachment, vault) = attachment_and_vault(&snapshot, &attachment_id)?;
        if vault.role == AuthorityVaultRole::ReadOnly {
            return Err(RuntimeError::new(
                RuntimeErrorCode::ReadOnly,
                "the Attachment belongs to a read-only Vault",
            ));
        }
        let foreground_guard = self.foreground_attachments.register(
            &account_id,
            &snapshot.incarnation,
            cancellation.clone(),
        )?;
        let body = encrypt_attachment_name(self, &snapshot, &source_attachment, &vault, &name)?;
        let auth_config = self.auth_client_config.clone().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "authentication is not configured for this Runtime",
            )
        })?;
        drop(execution_guard);

        let metadata = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            result = self.platform_storage.load_account_metadata(&account_id, &snapshot.incarnation) => {
                result.map_err(|_| retryable("Account metadata could not be loaded"))?
                    .ok_or_else(authentication_required)?
            }
        };
        let mut session = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            result = self.platform_storage.load_current_session(&account_id, &snapshot.incarnation) => {
                result.map_err(|_| retryable("Session could not be loaded"))?
                    .ok_or_else(authentication_required)?
            }
        };
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        )?;
        let mut renewed = false;
        let mut rename = http
            .rename_attachment(
                session.token.as_ref(),
                &attachment_id,
                &body,
                cancellation.clone(),
            )
            .await?;
        if matches!(rename, AuthenticatedOutcome::ReauthenticationRequired) {
            renew_once(
                self,
                &account_id,
                &http,
                &mut session,
                &mut renewed,
                cancellation.clone(),
            )
            .await?;
            rename = http
                .rename_attachment(
                    session.token.as_ref(),
                    &attachment_id,
                    &body,
                    cancellation.clone(),
                )
                .await?;
        }
        let ambiguous = match rename {
            AuthenticatedOutcome::Ok(AttachmentRenameAnswer::Updated) => false,
            AuthenticatedOutcome::Ok(AttachmentRenameAnswer::Ambiguous) => true,
            AuthenticatedOutcome::Ok(AttachmentRenameAnswer::Missing) => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AuthorityMissing,
                    "Attachment authority is missing",
                ));
            }
            AuthenticatedOutcome::Ok(AttachmentRenameAnswer::AccessDenied) => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccessDenied,
                    "Attachment Rename was denied",
                ));
            }
            AuthenticatedOutcome::ReauthenticationRequired => {
                self.mark_reauthentication_required(&account_id);
                return Err(authentication_required());
            }
            AuthenticatedOutcome::Transient => true,
        };

        let item = fetch_item_authority(
            self,
            &http,
            AttachmentAuthority {
                account_id: &account_id,
                item_id: &item_id,
                attachment_id: &attachment_id,
                expectation: AttachmentAuthorityExpectation::Renamed {
                    body: &body,
                    source_attachment: &source_attachment,
                },
                cancellation: cancellation.clone(),
            },
            &mut session,
            &mut renewed,
        )
        .await?;
        if cancellation.is_cancelled() {
            return Err(cancelled());
        }
        if ambiguous && !attachment_matches_rename(&item, &attachment_id, &body) {
            return Err(retryable(
                "authoritative state did not prove the ambiguous Attachment Rename",
            ));
        }

        let execution_guard = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution_lock.lock() => guard,
        };
        self.ensure_attachment_admission(&account_id, &cancellation)?;
        let current = self.require_snapshot(&account_id)?;
        if current.incarnation != snapshot.incarnation {
            return Err(retryable(
                "Account incarnation changed before Attachment Rename publication",
            ));
        }
        let result = self
            .replica
            .execute_foreground_attachment_exact(ForegroundAttachmentCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                attachment_id.clone(),
                true,
                item,
            ))
            .await?;
        match result {
            ForegroundAttachmentCommitResult::Applied { .. } => {}
            ForegroundAttachmentCommitResult::StaleReplica { .. }
            | ForegroundAttachmentCommitResult::StaleAuthority { .. } => {
                return Err(retryable(
                    "Replica authority changed before Attachment Rename publication",
                ));
            }
            ForegroundAttachmentCommitResult::Missing => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccountMissing,
                    "Account disappeared before Attachment Rename publication",
                ));
            }
        };
        let publication = self.foreground_attachments.publication(&foreground_guard);
        let prepared_publications =
            self.decrypt_visible_items_for_foreground_attachment(&account_id)?;
        let response = RuntimeResponse::AttachmentRenamed {
            account_id,
            attachment_id,
        };
        drop(execution_guard);
        drop(foreground_guard);
        drop(item_guard);
        drop(teardown_admission);
        if let Some(prepared_publications) = prepared_publications {
            prepared_publications.publish(publication);
        }
        Ok(response)
    }

    fn ensure_attachment_admission(
        &self,
        account_id: &AccountId,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled() || self.account_access_retirement_is_pending(account_id) {
            return Err(cancelled());
        }
        if self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(account_id)
            != Some(&AccountAccessState::Unlocked)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "foreground Attachment mutation requires an unlocked Account",
            ));
        }
        Ok(())
    }
}

fn item_has_optimistic_owner(snapshot: &crate::replica::ReplicaSnapshot, item_id: &str) -> bool {
    snapshot
        .operations
        .iter()
        .any(|operation| operation.item_id == item_id)
        || snapshot
            .attachment_move_preparations
            .iter()
            .any(|preparation| preparation.item_id == item_id)
        || snapshot
            .items
            .iter()
            .any(|overlay| overlay.item_id == item_id)
}

struct AttachmentAuthority<'a> {
    account_id: &'a AccountId,
    item_id: &'a str,
    attachment_id: &'a str,
    expectation: AttachmentAuthorityExpectation<'a>,
    cancellation: RequestCancellation,
}

enum AttachmentAuthorityExpectation<'a> {
    Renamed {
        body: &'a UpdateAttachmentBody,
        source_attachment: &'a AuthorityAttachmentRecord,
    },
    Deleted {
        vault_id: &'a str,
    },
}

async fn fetch_item_authority(
    runtime: &Runtime,
    http: &AuthHttpClient<'_>,
    authority: AttachmentAuthority<'_>,
    session: &mut CurrentSessionDocument,
    renewed: &mut bool,
) -> Result<AuthorityItemRecord, RuntimeError> {
    let AttachmentAuthority {
        account_id,
        item_id,
        attachment_id,
        expectation,
        cancellation,
    } = authority;
    let mut item = http
        .fetch_item_or_absent_for_attachment(session.token.as_ref(), item_id, cancellation.clone())
        .await
        .map_err(authority_probe_error)?;
    if matches!(item, AuthenticatedOutcome::ReauthenticationRequired) {
        renew_once(
            runtime,
            account_id,
            http,
            session,
            renewed,
            cancellation.clone(),
        )
        .await?;
        item = http
            .fetch_item_or_absent_for_attachment(
                session.token.as_ref(),
                item_id,
                cancellation.clone(),
            )
            .await
            .map_err(authority_probe_error)?;
    }
    let item = classify_authority(item, runtime, account_id, "Item")?.ok_or_else(|| {
        RuntimeError::new(
            RuntimeErrorCode::AuthorityMissing,
            "Item authority is missing",
        )
    })?;
    if item.id != item_id {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Item authority returned a foreign identity",
        ));
    }
    let item_vault_id = item.vault_id.clone();

    let mut attachments = http
        .fetch_attachment_authority(session.token.as_ref(), item_id, cancellation.clone())
        .await
        .map_err(authority_probe_error)?;
    if matches!(attachments, AuthenticatedOutcome::ReauthenticationRequired) {
        renew_once(
            runtime,
            account_id,
            http,
            session,
            renewed,
            cancellation.clone(),
        )
        .await?;
        attachments = http
            .fetch_attachment_authority(session.token.as_ref(), item_id, cancellation)
            .await
            .map_err(authority_probe_error)?;
    }
    let attachments = classify_authority(attachments, runtime, account_id, "Attachment")?;
    if attachments.iter().any(|attachment| {
        attachment.id != attachment_id
            && (attachment.item_id != item.id || attachment.vault_id != item.vault_id)
    }) {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "foreign Attachment authority appeared on the Item endpoint",
        ));
    }
    if attachments
        .iter()
        .find(|attachment| attachment.id == attachment_id)
        .is_some_and(|attachment| {
            attachment.item_id != item.id || attachment.vault_id != item.vault_id
        })
    {
        return Err(retryable(
            "Attachment address authority changed during probe",
        ));
    }
    let mut authority = super::bootstrap::authority_item_from_dto(item)?;
    authority.attachments = attachments
        .into_iter()
        .map(authority_attachment_from_dto)
        .collect();
    match expectation {
        AttachmentAuthorityExpectation::Renamed {
            body,
            source_attachment,
        } => {
            if !attachment_matches_rename(&authority, attachment_id, body) {
                return Err(retryable(
                    "authoritative state did not retain the requested Attachment Rename",
                ));
            }
            let fetched_attachment = authority
                .attachments
                .iter()
                .find(|attachment| attachment.id == attachment_id)
                .expect("the requested Attachment was matched above");
            if !attachment_key_authority_is_unchanged(source_attachment, fetched_attachment) {
                return Err(retryable(
                    "Attachment key-envelope authority changed during Rename",
                ));
            }
        }
        AttachmentAuthorityExpectation::Deleted { vault_id } => {
            if item_vault_id != vault_id {
                return Err(retryable(
                    "owning Item authority changed during Attachment Delete",
                ));
            }
            if authority
                .attachments
                .iter()
                .any(|attachment| attachment.id == attachment_id)
            {
                return Err(retryable(
                    "authoritative state did not prove the Attachment Delete",
                ));
            }
        }
    }
    Ok(authority)
}

fn classify_authority<T>(
    result: AuthenticatedOutcome<T>,
    runtime: &Runtime,
    account_id: &AccountId,
    entity: &str,
) -> Result<T, RuntimeError> {
    match result {
        AuthenticatedOutcome::Ok(value) => Ok(value),
        AuthenticatedOutcome::Transient => Err(retryable(format!(
            "{entity} authority could not be fetched"
        ))),
        AuthenticatedOutcome::ReauthenticationRequired => {
            runtime.mark_reauthentication_required(account_id);
            Err(authentication_required())
        }
    }
}

fn authority_probe_error(error: RuntimeError) -> RuntimeError {
    if error.code == RuntimeErrorCode::AuthenticationUnavailable {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Attachment authority response violated the protocol",
        )
    } else {
        error
    }
}

async fn renew_once(
    runtime: &Runtime,
    account_id: &AccountId,
    http: &AuthHttpClient<'_>,
    session: &mut CurrentSessionDocument,
    renewed: &mut bool,
    cancellation: RequestCancellation,
) -> Result<(), RuntimeError> {
    if *renewed {
        runtime.mark_reauthentication_required(account_id);
        return Err(authentication_required());
    }
    *renewed = true;
    *session = runtime
        .renew_session(account_id, session, http, cancellation)
        .await
        .map_err(|error| {
            if error.code == RuntimeErrorCode::AuthenticationRequired {
                runtime.mark_reauthentication_required(account_id);
                error
            } else if (error.code == RuntimeErrorCode::AuthenticationUnavailable
                && error.message == "Server request failed")
                || (error.code == RuntimeErrorCode::InvariantViolation
                    && error.message == "Session refresh failed")
            {
                retryable("Session renewal failed")
            } else {
                error
            }
        })?;
    Ok(())
}

fn find_attachment_address(
    snapshot: &crate::replica::ReplicaSnapshot,
    attachment_id: &str,
) -> Result<(String, String), RuntimeError> {
    let bootstrap = snapshot.bootstrap.snapshot();
    let found: Vec<_> = bootstrap
        .visible_items
        .iter()
        .flat_map(|item| {
            item.attachments
                .iter()
                .filter(move |attachment| attachment.id == attachment_id)
                .map(move |attachment| (item.id.clone(), attachment.vault_id.clone()))
        })
        .collect();
    match found.as_slice() {
        [(item_id, vault_id)] => Ok((item_id.clone(), vault_id.clone())),
        [] => Err(RuntimeError::new(
            RuntimeErrorCode::AuthorityMissing,
            "Attachment authority is missing",
        )),
        _ => Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Attachment identity is duplicated in the Replica",
        )),
    }
}

fn attachment_and_vault(
    snapshot: &crate::replica::ReplicaSnapshot,
    attachment_id: &str,
) -> Result<
    (
        AuthorityAttachmentRecord,
        crate::replica::AuthorityVaultRecord,
    ),
    RuntimeError,
> {
    let bootstrap = snapshot.bootstrap.snapshot();
    let attachment = bootstrap
        .visible_items
        .iter()
        .flat_map(|item| &item.attachments)
        .find(|attachment| attachment.id == attachment_id)
        .ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AuthorityMissing, "Attachment missing")
        })?;
    let vault = bootstrap
        .visible_vaults
        .iter()
        .find(|vault| vault.id == attachment.vault_id)
        .ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Attachment Vault authority is missing",
            )
        })?;
    Ok((attachment.clone(), vault.clone()))
}

fn encrypt_attachment_name(
    runtime: &Runtime,
    snapshot: &crate::replica::ReplicaSnapshot,
    attachment: &AuthorityAttachmentRecord,
    vault: &crate::replica::AuthorityVaultRecord,
    name: &str,
) -> Result<UpdateAttachmentBody, RuntimeError> {
    let muk = runtime
        .copy_live_master_unlock_key(&snapshot.account_id, &snapshot.incarnation)
        .ok_or_else(authentication_required)?;
    let wrapped: WrappedVaultKeyData =
        serde_json::from_str(&vault.encrypted_vault_key).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Vault key authority is malformed",
            )
        })?;
    if wrapped.context.vault_id != vault.id || wrapped.context.user_id != snapshot.user_id {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Vault key authority scope does not match the Account",
        ));
    }
    let vault_key = Zeroizing::new(
        decrypt_vault_key_with_muk(&vault.encrypted_vault_key, muk.as_slice(), &wrapped.context)
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "Vault key could not be opened",
                )
            })?,
    );
    let scope = |entity_type: &str, version: u64| AadContext {
        vault_id: attachment.vault_id.clone(),
        entity_id: attachment.id.clone(),
        entity_type: entity_type.to_owned(),
        version,
        user_id: attachment.uploaded_by.clone(),
    };
    let mut encoded_key = decrypt_with_aad(
        &EncryptedData {
            ciphertext: attachment.encrypted_attachment_key.clone(),
            iv: attachment.attachment_key_iv.clone(),
            algorithm: attachment.attachment_key_algorithm.clone(),
        },
        &vault_key,
        &scope("attachment_key", attachment.envelope_version as u64),
    )
    .map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Attachment key could not be opened",
        )
    })?;
    let attachment_key = Zeroizing::new(BASE64.decode(encoded_key.as_bytes()).map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Attachment key is malformed",
        )
    })?);
    encoded_key.zeroize();
    if attachment_key.len() != 32 {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "Attachment key has an invalid length",
        ));
    }
    let encrypted =
        encrypt_with_aad(name, &attachment_key, &scope("attachment_name", 1)).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Attachment name could not be encrypted",
            )
        })?;
    Ok(UpdateAttachmentBody {
        encrypted_name: encrypted.ciphertext,
        encryption_iv: encrypted.iv,
        encryption_algorithm: encrypted.algorithm,
    })
}

fn authority_attachment_from_dto(attachment: VaultAttachmentResponse) -> AuthorityAttachmentRecord {
    AuthorityAttachmentRecord {
        id: attachment.id,
        item_id: attachment.item_id,
        vault_id: attachment.vault_id,
        storage_key: attachment.storage_key,
        encrypted_name: attachment.encrypted_name,
        encryption_iv: attachment.encryption_iv,
        encryption_algorithm: attachment.encryption_algorithm,
        encrypted_attachment_key: attachment.encrypted_attachment_key,
        attachment_key_iv: attachment.attachment_key_iv,
        attachment_key_algorithm: attachment.attachment_key_algorithm,
        encrypted_content_type: attachment.encrypted_content_type,
        encrypted_content_type_iv: attachment.encrypted_content_type_iv,
        envelope_version: attachment.envelope_version,
        file_size: attachment.file_size,
        uploaded_by: attachment.uploaded_by,
        created_at: attachment.created_at,
    }
}

fn attachment_matches_rename(
    item: &AuthorityItemRecord,
    attachment_id: &str,
    body: &UpdateAttachmentBody,
) -> bool {
    item.attachments.iter().any(|attachment| {
        attachment.id == attachment_id
            && attachment.item_id == item.id
            && attachment.vault_id == item.vault_id
            && attachment.encrypted_name == body.encrypted_name
            && attachment.encryption_iv == body.encryption_iv
            && attachment.encryption_algorithm == body.encryption_algorithm
    })
}

fn attachment_key_authority_is_unchanged(
    source: &AuthorityAttachmentRecord,
    fetched: &AuthorityAttachmentRecord,
) -> bool {
    source.id == fetched.id
        && source.item_id == fetched.item_id
        && source.vault_id == fetched.vault_id
        && source.uploaded_by == fetched.uploaded_by
        && source.envelope_version == fetched.envelope_version
        && source.encrypted_attachment_key == fetched.encrypted_attachment_key
        && source.attachment_key_iv == fetched.attachment_key_iv
        && source.attachment_key_algorithm == fetched.attachment_key_algorithm
}

fn validate_rename_name(name: &str) -> Result<(), RuntimeError> {
    if name.trim().is_empty() || name.len() > 255 {
        return Err(RuntimeError::new(
            RuntimeErrorCode::SizeRejected,
            "Attachment name must contain between 1 and 255 UTF-8 bytes",
        ));
    }
    Ok(())
}

fn retryable(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::RetryableTransport, message)
}

fn authentication_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Session is missing or expired",
    )
}

fn cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Attachment Rename was cancelled",
    )
}
