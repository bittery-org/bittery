use super::*;
use crate::{
    protocol::{TeamPageFieldError, TeamPageProblem},
    server_contract,
};

const TEAM_PAGE_RESPONSE_BYTES: u32 = 512 * 1024;

#[derive(Clone, Copy)]
pub(crate) enum TeamPageHttpRoute<'a> {
    User,
    CurrentTeam,
    Details(&'a str),
    Members(&'a str, Option<&'a str>),
    Invitations(&'a str, Option<&'a str>),
    MyInvitations(Option<&'a str>),
    Vaults(&'a str, Option<&'a str>),
    Entitlements,
    BillingStatus,
    SeatPreview,
    AvailableVaultMembers(&'a str, Option<&'a str>),
    VaultMembers(&'a str, Option<&'a str>),
}

pub(crate) enum TeamPageHttpAnswer<T> {
    Present(T),
    Absent,
    ReauthenticationRequired(Option<TeamPageProblem>),
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TeamPageHttpPage<T> {
    pub items: Vec<T>,
    pub has_more: bool,
    pub next_cursor: Option<String>,
}

impl AuthHttpClient<'_> {
    pub(crate) async fn read_team_page<T: DeserializeOwned>(
        &self,
        token: &str,
        route: TeamPageHttpRoute<'_>,
        cancellation: RequestCancellation,
    ) -> Result<TeamPageHttpAnswer<T>, RuntimeError> {
        let (mut url, absent_allowed, cursor) = match route {
            TeamPageHttpRoute::User => (self.endpoint(&["api", "v1", "users", "me"])?, false, None),
            TeamPageHttpRoute::CurrentTeam => (
                self.endpoint(&["api", "v1", "teams", "current"])?,
                true,
                None,
            ),
            TeamPageHttpRoute::Details(id) => {
                (self.endpoint(&["api", "v1", "teams", id])?, false, None)
            }
            TeamPageHttpRoute::Members(id, cursor) => (
                self.endpoint(&["api", "v1", "teams", id, "members"])?,
                false,
                cursor,
            ),
            TeamPageHttpRoute::Invitations(id, cursor) => (
                self.endpoint(&["api", "v1", "teams", id, "invitations"])?,
                false,
                cursor,
            ),
            TeamPageHttpRoute::MyInvitations(cursor) => (
                self.endpoint(&["api", "v1", "users", "me", "team-invitations"])?,
                false,
                cursor,
            ),
            TeamPageHttpRoute::Vaults(id, cursor) => (
                self.endpoint(&["api", "v1", "teams", id, "vaults"])?,
                false,
                cursor,
            ),
            TeamPageHttpRoute::Entitlements => (
                self.endpoint(&["api", "v1", "billing", "entitlements"])?,
                false,
                None,
            ),
            TeamPageHttpRoute::BillingStatus => (
                self.endpoint(&["api", "v1", "billing", "status"])?,
                false,
                None,
            ),
            TeamPageHttpRoute::SeatPreview => (
                self.endpoint(&["api", "v1", "billing", "team-seats", "addition-preview"])?,
                false,
                None,
            ),
            TeamPageHttpRoute::AvailableVaultMembers(id, cursor) => (
                self.endpoint(&["api", "v1", "vaults", id, "available-team-members"])?,
                false,
                cursor,
            ),
            TeamPageHttpRoute::VaultMembers(id, cursor) => (
                self.endpoint(&["api", "v1", "vaults", id, "members"])?,
                false,
                cursor,
            ),
        };
        if let Some(cursor) = cursor {
            url.query_pairs_mut().append_pair("cursor", cursor);
        }
        let answer = self
            .transport
            .execute(
                HttpDispatch::new(
                    HttpMethod::Get,
                    url.into(),
                    self.headers(Some(token))?,
                    Vec::new(),
                    TEAM_PAGE_RESPONSE_BYTES,
                ),
                cancellation,
            )
            .await?;
        match answer {
            HttpResponse::Completed {
                status: 200,
                headers,
                body,
            } => {
                require_json_content_type(&headers)?;
                let value = serde_json::from_slice(&body).map_err(|_| {
                    RuntimeError::new(
                        RuntimeErrorCode::AuthenticationUnavailable,
                        "Team page response is invalid",
                    )
                })?;
                Ok(TeamPageHttpAnswer::Present(value))
            }
            HttpResponse::Completed { status: 404, .. } if absent_allowed => {
                Ok(TeamPageHttpAnswer::Absent)
            }
            HttpResponse::Completed {
                status,
                headers,
                body,
            } => {
                let problem = if require_problem_json_content_type(&headers).is_ok() {
                    serde_json::from_slice::<server_contract::ProblemDetails>(&body)
                        .ok()
                        .map(|problem| {
                            let retry_after_seconds = headers
                                .iter()
                                .find(|header| header.name.eq_ignore_ascii_case("retry-after"))
                                .and_then(|header| header.value.parse::<u32>().ok());
                            TeamPageProblem {
                                status: problem.status,
                                code: problem.code,
                                message: problem.detail,
                                request_id: problem.request_id,
                                retryable: problem.retryable,
                                retry_after_seconds,
                                field_errors: problem
                                    .errors
                                    .unwrap_or_default()
                                    .into_iter()
                                    .map(|field| TeamPageFieldError {
                                        pointer: field.pointer,
                                        code: field.code,
                                    })
                                    .collect(),
                            }
                        })
                } else {
                    None
                };
                if status == 401 {
                    return Ok(TeamPageHttpAnswer::ReauthenticationRequired(problem));
                }
                let code = if status == 403 {
                    RuntimeErrorCode::AccessDenied
                } else if status == 404 {
                    RuntimeErrorCode::AuthorityMissing
                } else if status >= 500 || problem.as_ref().is_some_and(|problem| problem.retryable)
                {
                    RuntimeErrorCode::RetryableTransport
                } else {
                    RuntimeErrorCode::AuthenticationUnavailable
                };
                let mut error = RuntimeError::new(
                    code,
                    problem
                        .as_ref()
                        .map(|problem| problem.message.as_str())
                        .unwrap_or("Team page read failed"),
                );
                error.team_page_problem = problem.map(Box::new);
                Err(error)
            }
            HttpResponse::Cancelled => Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "Team page read cancelled",
            )),
            HttpResponse::NetworkFailure | HttpResponse::ResponseTooLarge => {
                Err(RuntimeError::new(
                    RuntimeErrorCode::RetryableTransport,
                    "Team page read is unavailable",
                ))
            }
        }
    }
}
