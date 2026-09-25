//! Fixed authenticated Invitation mutations. A one-time-token send is never replayed here.
use super::*;
use crate::server_contract::{
    ResendInvitationResponse, SendInvitationRequest, SendInvitationResponse, SuccessResponse,
};
use zeroize::Zeroizing;

const INVITATION_RESPONSE_BYTES: u32 = 128 * 1024;

pub(crate) enum InvitationMutationAnswer<T> {
    Confirmed(T),
    Uncertain,
}

impl AuthHttpClient<'_> {
    pub(crate) async fn send_team_invitation(
        &self,
        token: &str,
        team_id: &str,
        request: &SendInvitationRequest,
        cancellation: RequestCancellation,
    ) -> Result<InvitationMutationAnswer<SendInvitationResponse>, RuntimeError> {
        let url = self.endpoint(&["api", "v1", "teams", team_id, "invitations"])?;
        let body = serde_json::to_vec(request).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Invitation body is invalid",
            )
        })?;
        self.non_idempotent_mutation(HttpMethod::Post, url, body, token, cancellation)
            .await
    }

    pub(crate) async fn cancel_team_invitation(
        &self,
        token: &str,
        team_id: &str,
        invitation_id: &str,
        cancellation: RequestCancellation,
    ) -> Result<InvitationMutationAnswer<SuccessResponse>, RuntimeError> {
        let url = self.endpoint(&["api", "v1", "teams", team_id, "invitations", invitation_id])?;
        self.non_idempotent_mutation(HttpMethod::Delete, url, Vec::new(), token, cancellation)
            .await
    }

    pub(crate) async fn resend_team_invitation(
        &self,
        token: &str,
        team_id: &str,
        invitation_id: &str,
        cancellation: RequestCancellation,
    ) -> Result<InvitationMutationAnswer<ResendInvitationResponse>, RuntimeError> {
        let url = self.endpoint(&[
            "api",
            "v1",
            "teams",
            team_id,
            "invitations",
            invitation_id,
            "resend",
        ])?;
        self.non_idempotent_mutation(HttpMethod::Post, url, Vec::new(), token, cancellation)
            .await
    }

    pub(crate) async fn non_idempotent_mutation<T: DeserializeOwned>(
        &self,
        method: HttpMethod,
        url: Url,
        body: Vec<u8>,
        token: &str,
        cancellation: RequestCancellation,
    ) -> Result<InvitationMutationAnswer<T>, RuntimeError> {
        let mut headers = self.headers(Some(token))?;
        if !body.is_empty() {
            headers.push(HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            });
        }
        let answer = match self
            .transport
            .execute(
                HttpDispatch::new(method, url.into(), headers, body, INVITATION_RESPONSE_BYTES),
                cancellation.clone(),
            )
            .await
        {
            Ok(answer) => answer,
            Err(_) if cancellation.is_cancelled() => {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::Cancelled,
                    "Invitation request was cancelled",
                ));
            }
            // The host may fail after sending the mutation but before its reply
            // reaches Core. There is no safe token-producing replay at this seam.
            Err(_) => return Ok(InvitationMutationAnswer::Uncertain),
        };
        match answer {
            HttpResponse::Completed {
                status: 200,
                headers,
                body,
            } => {
                let body = Zeroizing::new(body);
                if require_json_content_type(&headers).is_err() {
                    return Ok(InvitationMutationAnswer::Uncertain);
                }
                match serde_json::from_slice(&body) {
                    Ok(result) => Ok(InvitationMutationAnswer::Confirmed(result)),
                    Err(_) => Ok(InvitationMutationAnswer::Uncertain),
                }
            }
            HttpResponse::Completed {
                status: 500..=599, ..
            } => Ok(InvitationMutationAnswer::Uncertain),
            HttpResponse::Completed { status, .. } => {
                let code = match status {
                    401 => RuntimeErrorCode::AuthenticationRequired,
                    403 => RuntimeErrorCode::AccessDenied,
                    404 => RuntimeErrorCode::AuthorityMissing,
                    _ => RuntimeErrorCode::AuthenticationUnavailable,
                };
                Err(RuntimeError::new(code, "Invitation request was refused"))
            }
            HttpResponse::NetworkFailure | HttpResponse::ResponseTooLarge => {
                Ok(InvitationMutationAnswer::Uncertain)
            }
            HttpResponse::Cancelled if cancellation.is_cancelled() => Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Invitation request was cancelled",
            )),
            // A host may report cancellation after it dispatched the mutation;
            // absent caller cancellation, its one-time reply is ambiguous.
            HttpResponse::Cancelled => Ok(InvitationMutationAnswer::Uncertain),
        }
    }
}
