use super::Runtime;
use crate::{
    auth_http::{AuthHttpClient, AuthenticatedOutcome, ServerAccountDeletionAnswer},
    protocol::ServerAccountDeletionOutcome,
    AccountId, RequestCancellation, RuntimeError, RuntimeErrorCode, RuntimeResponse,
};

impl Runtime {
    pub(super) async fn delete_server_account(
        &self,
        account_id: AccountId,
        confirm_email: String,
        request_id: String,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        let normalized_email = crate::normalize_account_email(&confirm_email)?;
        let auth_config = self.auth_client_config.clone().ok_or_else(|| {
            RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "authentication is not configured for this Runtime",
            )
        })?;
        let expected_incarnation = self
            .replica
            .snapshot(&account_id)
            .ok_or_else(account_missing)?
            .incarnation;
        let execution_lock = self.account_execution_lock(&account_id)?;
        let _execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let snapshot = self
            .replica
            .snapshot(&account_id)
            .ok_or_else(account_missing)?;
        if snapshot.incarnation != expected_incarnation {
            return Err(account_missing());
        }
        let metadata = self
            .platform_storage
            .load_account_metadata(&account_id, &snapshot.incarnation)
            .await?
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Account metadata is missing",
                )
            })?;
        let mut session = self
            .platform_storage
            .load_current_session(&account_id, &snapshot.incarnation)
            .await?
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Current Session is missing",
                )
            })?;
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            auth_config,
        )?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before Account deletion dispatch",
            ));
        }

        let answer = match http
            .delete_server_account(
                session.token.as_ref(),
                &request_id,
                normalized_email.as_str(),
                RequestCancellation::new(),
            )
            .await?
        {
            AuthenticatedOutcome::Ok(answer) => answer,
            AuthenticatedOutcome::Transient => return Err(unconfirmed()),
            AuthenticatedOutcome::ReauthenticationRequired => {
                session = self
                    .renew_session(&account_id, &session, &http, RequestCancellation::new())
                    .await?;
                match http
                    .delete_server_account(
                        session.token.as_ref(),
                        &request_id,
                        normalized_email.as_str(),
                        RequestCancellation::new(),
                    )
                    .await?
                {
                    AuthenticatedOutcome::Ok(answer) => answer,
                    AuthenticatedOutcome::ReauthenticationRequired => {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AuthenticationRequired,
                            "Account deletion authentication is no longer usable",
                        ));
                    }
                    AuthenticatedOutcome::Transient => return Err(unconfirmed()),
                }
            }
        };
        let (echoed_request_id, outcome) = match answer {
            ServerAccountDeletionAnswer::Deleted { request_id } => {
                (request_id, ServerAccountDeletionOutcome::Deleted)
            }
            ServerAccountDeletionAnswer::ConfirmationEmailMismatch { request_id } => (
                request_id,
                ServerAccountDeletionOutcome::ConfirmationEmailMismatch,
            ),
            ServerAccountDeletionAnswer::Blocked { request_id } => {
                (request_id, ServerAccountDeletionOutcome::Blocked)
            }
        };
        if echoed_request_id != request_id {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account deletion response request identity does not match",
            ));
        }
        Ok(RuntimeResponse::ServerAccountDeletion {
            account_id,
            request_id,
            outcome,
        })
    }
}

fn account_missing() -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
}

fn unconfirmed() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationUnavailable,
        "Account deletion is not confirmed",
    )
}
