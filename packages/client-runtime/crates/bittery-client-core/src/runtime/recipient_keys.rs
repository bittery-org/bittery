//! All hosts use the same mandatory recipient-key policy; no Server read creates verification.
use super::*;
use bittery_crypto_core::{
    decrypt,
    rsa::{rsa_public_key_fingerprint, rsa_public_key_from_private},
    EncryptedData,
};

impl Runtime {
    pub(super) async fn request_recipient_key(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let account_id = request
            .account_id()
            .expect("recipient requests are Account scoped")
            .clone();
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(recipient_cancelled()),
            guard = execution.lock() => guard,
        };
        let snapshot = self.require_snapshot(&account_id)?;
        self.require_recipient_admission(&snapshot, &cancellation)?;
        let current_scope = serde_json::to_string(&(
            snapshot.account_id.as_str(),
            snapshot.incarnation.as_str(),
            snapshot.lock_epoch,
        ))
        .expect("scope serialization is infallible");
        match &request {
            RuntimeRequest::VerifyRecipientKey { scope, .. }
            | RuntimeRequest::VerifiedRecipientKey { scope, .. }
                if scope != &current_scope =>
            {
                return Err(recipient_cancelled());
            }
            _ => {}
        }
        let metadata = self
            .platform_storage
            .load_account_metadata(&account_id, &snapshot.incarnation)
            .await?
            .ok_or_else(recipient_unavailable)?;
        self.require_recipient_admission(&snapshot, &cancellation)?;
        let result = match request {
            RuntimeRequest::RecipientKeyScope { .. } => RuntimeResponse::RecipientKeyScope {
                scope: current_scope,
            },
            RuntimeRequest::OwnKeyFingerprint { .. } => {
                let material = self
                    .copy_live_vault_key_material(&account_id, &snapshot.incarnation)
                    .ok_or_else(recipient_unavailable)?;
                let envelope: EncryptedData = serde_json::from_str(
                    material
                        .encrypted_private_key
                        .as_deref()
                        .ok_or_else(recipient_unavailable)?,
                )
                .map_err(|_| recipient_unavailable())?;
                let private = Zeroizing::new(
                    decrypt(&envelope, &*material.master_unlock_key)
                        .map_err(|_| recipient_unavailable())?,
                );
                let public =
                    rsa_public_key_from_private(&private).map_err(|_| recipient_unavailable())?;
                RuntimeResponse::OwnKeyFingerprint {
                    user_id: metadata.user_id,
                    fingerprint: rsa_public_key_fingerprint(&public)
                        .map_err(|_| recipient_unavailable())?,
                }
            }
            RuntimeRequest::VerifyRecipientKey {
                recipient_user_id,
                public_key,
                expected_fingerprint,
                ..
            } => {
                if expected_fingerprint.len() > 256 {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::RecipientFingerprintMismatch,
                        "Recipient fingerprint is invalid",
                    ));
                }
                let mut verified = self
                    .platform_storage
                    .load_verified_recipient_keys(&metadata)
                    .await?;
                verified.verify(&recipient_user_id, &public_key, &expected_fingerprint)?;
                self.require_recipient_admission(&snapshot, &cancellation)?;
                self.platform_storage
                    .store_verified_recipient_keys(&verified)
                    .await?;
                RuntimeResponse::RecipientKeyVerified
            }
            RuntimeRequest::VerifiedRecipientKey {
                recipient_user_id,
                public_key,
                ..
            } => {
                let verified = self
                    .platform_storage
                    .load_verified_recipient_keys(&metadata)
                    .await?;
                RuntimeResponse::VerifiedRecipientKey {
                    public_key: verified.approved_key(&recipient_user_id, public_key)?,
                }
            }
            _ => unreachable!("only recipient requests enter this module"),
        };
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.require_recipient_admission(&snapshot, &cancellation)?;
        Ok(result)
    }

    fn require_recipient_admission(
        &self,
        snapshot: &ReplicaSnapshot,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled()
            || self.account_access_retirement_is_pending(&snapshot.account_id)
            || self.account_teardown_is_pending(&snapshot.account_id)
        {
            return Err(recipient_cancelled());
        }
        if !self.generation_is_preparation_eligible(snapshot) {
            return Err(recipient_unavailable());
        }
        Ok(())
    }
}

fn recipient_unavailable() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Recipient verification requires the unlocked Account",
    )
}
fn recipient_cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Recipient verification was cancelled",
    )
}
