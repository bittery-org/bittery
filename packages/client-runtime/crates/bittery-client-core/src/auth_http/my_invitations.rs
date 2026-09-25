//! Fixed current-User Invitation mutations; ambiguous effects are never replayed.
use super::*;

const MY_INVITATION_RESPONSE_BYTES: u32 = 64 * 1024;

pub(crate) enum MyInvitationMutationAnswer<T> {
    Confirmed(T),
    ReauthenticationRequired,
    Uncertain,
}

impl<T> MyInvitationMutationAnswer<T> {
    pub(crate) fn map<U>(self, map: impl FnOnce(T) -> U) -> MyInvitationMutationAnswer<U> {
        match self {
            Self::Confirmed(value) => MyInvitationMutationAnswer::Confirmed(map(value)),
            Self::ReauthenticationRequired => MyInvitationMutationAnswer::ReauthenticationRequired,
            Self::Uncertain => MyInvitationMutationAnswer::Uncertain,
        }
    }
}

impl AuthHttpClient<'_> {
    pub(crate) async fn my_invitation_mutation<T: DeserializeOwned>(
        &self,
        token: &str,
        invitation_id: &str,
        action: crate::protocol::MyInvitationAction,
        cancellation: RequestCancellation,
    ) -> Result<MyInvitationMutationAnswer<T>, RuntimeError> {
        let action_segment = match action {
            crate::protocol::MyInvitationAction::Accept => "accept",
            crate::protocol::MyInvitationAction::Decline => "decline",
        };
        let url = self.endpoint(&[
            "api",
            "v1",
            "users",
            "me",
            "team-invitations",
            invitation_id,
            action_segment,
        ])?;
        let answer = match self
            .transport
            .execute(
                HttpDispatch::new(
                    HttpMethod::Post,
                    url.into(),
                    self.headers(Some(token))?,
                    Vec::new(),
                    MY_INVITATION_RESPONSE_BYTES,
                ),
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
            Err(_) => return Ok(MyInvitationMutationAnswer::Uncertain),
        };
        match answer {
            HttpResponse::Completed {
                status: 200,
                headers,
                body,
            } => {
                if require_json_content_type(&headers).is_err() {
                    return Ok(MyInvitationMutationAnswer::Uncertain);
                }
                match serde_json::from_slice(&body) {
                    Ok(result) => Ok(MyInvitationMutationAnswer::Confirmed(result)),
                    Err(_) => Ok(MyInvitationMutationAnswer::Uncertain),
                }
            }
            HttpResponse::Completed { status: 401, .. } => {
                Ok(MyInvitationMutationAnswer::ReauthenticationRequired)
            }
            HttpResponse::Completed {
                status: 500..=599, ..
            }
            | HttpResponse::NetworkFailure
            | HttpResponse::ResponseTooLarge => Ok(MyInvitationMutationAnswer::Uncertain),
            HttpResponse::Completed { status, .. } => {
                let code = match status {
                    403 => RuntimeErrorCode::AccessDenied,
                    404 => RuntimeErrorCode::AuthorityMissing,
                    _ => RuntimeErrorCode::AuthenticationUnavailable,
                };
                Err(RuntimeError::new(code, "Invitation request was refused"))
            }
            HttpResponse::Cancelled if cancellation.is_cancelled() => Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Invitation request was cancelled",
            )),
            HttpResponse::Cancelled => Ok(MyInvitationMutationAnswer::Uncertain),
        }
    }
}
