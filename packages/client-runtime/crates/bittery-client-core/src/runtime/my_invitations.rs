//! Current-User Invitation reads and writes are bound to the unlocked Account and its Session.
use super::foreground_attachment_lifecycle::ForegroundAttachmentGuard;
use super::team_page::{TeamPageListKind, TeamReadLifetime};
use super::*;
use crate::{
    auth_http::{MyInvitationMutationAnswer, TeamPageHttpRoute},
    platform_storage::CurrentSessionDocument,
    protocol::{MyInvitationAction, MyTeamInvitation},
    replica::{BootstrapGuard, MarkRefreshRequiredPlan, PlanResult, ReplicaState},
    server_contract,
};
use std::collections::HashSet;

struct MyInvitationFlow<'a> {
    runtime: &'a Runtime,
    expected: ReplicaSnapshot,
    session: CurrentSessionDocument,
    http: AuthHttpClient<'a>,
    lifetime: TeamReadLifetime<'a>,
    foreground: ForegroundAttachmentGuard,
}

enum ConfirmedMutation {
    Accepted(server_contract::AcceptInvitationResponse),
    Declined(server_contract::SuccessResponse),
}

impl Runtime {
    pub(super) async fn request_my_team_invitation(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let account_id = request
            .account_id()
            .expect("current-User Invitation requests are Account scoped")
            .clone();
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(my_invitation_cancelled()),
            guard = execution.lock() => guard,
        };
        let mut flow = MyInvitationFlow::new(self, &account_id, &cancellation).await?;
        match request {
            RuntimeRequest::ListMyTeamInvitations { .. } => {
                let invitations = flow.pending().await?;
                flow.publish(RuntimeResponse::MyTeamInvitations { invitations })
                    .await
            }
            RuntimeRequest::AcceptMyTeamInvitation { invitation_id, .. } => {
                flow.mutate(&invitation_id, MyInvitationAction::Accept)
                    .await
            }
            RuntimeRequest::DeclineMyTeamInvitation { invitation_id, .. } => {
                flow.mutate(&invitation_id, MyInvitationAction::Decline)
                    .await
            }
            _ => unreachable!("only current-User Invitation requests enter this module"),
        }
    }
}

impl<'a> MyInvitationFlow<'a> {
    async fn new(
        runtime: &'a Runtime,
        account_id: &AccountId,
        cancellation: &'a RequestCancellation,
    ) -> Result<Self, RuntimeError> {
        let expected = runtime.require_snapshot(account_id)?;
        runtime.require_team_page_scope(&expected, cancellation)?;
        let foreground = runtime.foreground_attachments.register(
            account_id,
            &expected.incarnation,
            cancellation.clone(),
        )?;
        let metadata = runtime
            .platform_storage
            .load_account_metadata(account_id, &expected.incarnation)
            .await?
            .ok_or_else(my_invitation_authentication_required)?;
        runtime.require_team_page_scope(&expected, cancellation)?;
        let session = runtime
            .effective_session(account_id, &expected.incarnation)
            .await?
            .ok_or_else(my_invitation_authentication_required)?;
        let http = AuthHttpClient::new(
            &runtime.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            runtime
                .auth_client_config
                .clone()
                .ok_or_else(my_invitation_authentication_required)?,
        )?;
        Ok(Self {
            runtime,
            expected,
            session,
            http,
            lifetime: TeamReadLifetime {
                cancellation,
                renewed: false,
            },
            foreground,
        })
    }

    async fn pending(&mut self) -> Result<Vec<MyTeamInvitation>, RuntimeError> {
        let entries: Vec<server_contract::PendingInvitationResponse> = self
            .runtime
            .team_pages(
                &self.http,
                &self.expected,
                &mut self.session,
                "",
                TeamPageListKind::MyInvitations,
                &mut self.lifetime,
            )
            .await?;
        let mut seen = HashSet::new();
        entries
            .into_iter()
            .map(|entry| {
                if entry.id.is_empty() || entry.team_id.is_empty() || !seen.insert(entry.id.clone())
                {
                    return Err(my_invitation_authority_missing());
                }
                Ok(MyTeamInvitation {
                    id: entry.id,
                    team_id: entry.team_id,
                    team_name: entry.team_name,
                    role: entry.role,
                    invited_by: entry.invited_by,
                    expires_at: entry.expires_at,
                })
            })
            .collect()
    }

    async fn mutate(
        &mut self,
        invitation_id: &str,
        action: MyInvitationAction,
    ) -> Result<RuntimeResponse, RuntimeError> {
        if invitation_id.is_empty() {
            return Err(my_invitation_authority_missing());
        }
        // The list is authenticated to the current User; a host cannot submit a public token.
        let invitation = self
            .pending()
            .await?
            .into_iter()
            .find(|candidate| candidate.id == invitation_id)
            .ok_or_else(my_invitation_authority_missing)?;
        if action == MyInvitationAction::Accept {
            // The Server's accept handler emits no Sync event. Commit a full-refresh duty before
            // sending, including across caller loss after the Server applies the mutation.
            self.force_fresh_authority_duty().await?;
        }
        self.require_current().await?;
        let answer = loop {
            let answer = match action {
                MyInvitationAction::Accept => self
                    .http
                    .my_invitation_mutation::<server_contract::AcceptInvitationResponse>(
                        self.session.token.as_ref(),
                        invitation_id,
                        action,
                        self.lifetime.cancellation.clone(),
                    )
                    .await
                    .map(|answer| answer.map(ConfirmedMutation::Accepted)),
                MyInvitationAction::Decline => self
                    .http
                    .my_invitation_mutation::<server_contract::SuccessResponse>(
                        self.session.token.as_ref(),
                        invitation_id,
                        action,
                        self.lifetime.cancellation.clone(),
                    )
                    .await
                    .map(|answer| answer.map(ConfirmedMutation::Declined)),
            };
            self.require_current().await?;
            match answer {
                Ok(MyInvitationMutationAnswer::ReauthenticationRequired)
                    if !self.lifetime.renewed =>
                {
                    let refresh = self
                        .runtime
                        .request_session_refresh(
                            &self.session,
                            &self.http,
                            self.lifetime.cancellation.clone(),
                        )
                        .await?;
                    self.require_current().await?;
                    self.session = self
                        .runtime
                        .publish_session_refresh(&self.expected.account_id, &self.session, refresh)
                        .await?;
                    self.lifetime.renewed = true;
                }
                Ok(MyInvitationMutationAnswer::ReauthenticationRequired) => {
                    return Err(my_invitation_authentication_required());
                }
                other => break other?,
            }
        };
        match answer {
            MyInvitationMutationAnswer::Confirmed(ConfirmedMutation::Accepted(response)) => {
                if response.team_id != invitation.team_id || response.team_name.is_empty() {
                    return self.uncertain(invitation_id, action).await;
                }
                let refreshed = self.refresh_authority().await;
                self.publish(if refreshed {
                    RuntimeResponse::MyTeamInvitationAccepted {
                        team_id: response.team_id,
                        team_name: response.team_name,
                    }
                } else {
                    RuntimeResponse::MyTeamInvitationAcceptRefreshRequired {
                        team_id: response.team_id,
                        team_name: response.team_name,
                    }
                })
                .await
            }
            MyInvitationMutationAnswer::Confirmed(ConfirmedMutation::Declined(response)) => {
                if response.success {
                    self.publish(RuntimeResponse::MyTeamInvitationDeclined)
                        .await
                } else {
                    self.uncertain(invitation_id, action).await
                }
            }
            MyInvitationMutationAnswer::Uncertain => self.uncertain(invitation_id, action).await,
            MyInvitationMutationAnswer::ReauthenticationRequired => {
                unreachable!("reauthentication handled above")
            }
        }
    }

    async fn force_fresh_authority_duty(&mut self) -> Result<(), RuntimeError> {
        self.require_current().await?;
        let current = self.runtime.require_snapshot(&self.expected.account_id)?;
        if current.bootstrap.staging_generation.is_some() {
            self.runtime
                .abandon_staging(&self.expected.account_id)
                .await?;
        }
        let current = self.runtime.require_snapshot(&self.expected.account_id)?;
        if current.bootstrap.state == ReplicaState::Ready
            || current.bootstrap.state == ReplicaState::RefreshRequired
        {
            match self
                .runtime
                .replica
                .mark_refresh_required(MarkRefreshRequiredPlan {
                    guard: BootstrapGuard {
                        account_id: current.account_id.clone(),
                        user_id: current.user_id.clone(),
                        incarnation: current.incarnation.clone(),
                        expected_replica_revision: current.revision,
                        expected_lock_epoch: current.lock_epoch,
                    },
                })
                .await?
            {
                PlanResult::Applied { .. } => {}
                PlanResult::Stale { .. } => return Err(my_invitation_authority_missing()),
                PlanResult::Missing => return Err(my_invitation_authority_missing()),
            }
        }
        self.require_current().await
    }

    async fn refresh_authority(&mut self) -> bool {
        let result = self
            .runtime
            .run_bootstrap(
                &self.expected.account_id,
                &self.http,
                self.session.clone(),
                self.lifetime.cancellation.clone(),
            )
            .await;
        // Bootstrap may renew the Session through its own owner.
        if let Ok(Some(current)) = self
            .runtime
            .effective_session(&self.expected.account_id, &self.expected.incarnation)
            .await
        {
            self.session = current;
        }
        matches!(result, Ok(true))
            && self
                .runtime
                .replica
                .snapshot(&self.expected.account_id)
                .is_some_and(|snapshot| {
                    snapshot.incarnation == self.expected.incarnation
                        && snapshot.lock_epoch == self.expected.lock_epoch
                        && snapshot.bootstrap.state == ReplicaState::Ready
                })
    }

    async fn uncertain(
        &mut self,
        invitation_id: &str,
        action: MyInvitationAction,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let pending = self
            .pending()
            .await
            .ok()
            .map(|entries| entries.iter().any(|entry| entry.id == invitation_id));
        let current_team_id = match self
            .runtime
            .team_read::<server_contract::MeResponse>(
                &self.http,
                &self.expected,
                &mut self.session,
                TeamPageHttpRoute::User,
                &mut self.lifetime,
            )
            .await
        {
            Ok(Some(user)) if user.id == self.expected.user_id => user.team_id,
            _ => None,
        };
        if action == MyInvitationAction::Accept {
            let _ = self.refresh_authority().await;
        }
        self.publish(RuntimeResponse::MyTeamInvitationUncertain {
            action,
            invitation_id: invitation_id.to_owned(),
            pending,
            current_team_id,
        })
        .await
    }

    async fn require_current(&self) -> Result<(), RuntimeError> {
        self.runtime
            .require_team_page_session(&self.expected, &self.session, self.lifetime.cancellation)
            .await
    }

    async fn publish(&self, response: RuntimeResponse) -> Result<RuntimeResponse, RuntimeError> {
        self.require_current().await?;
        let _publication = self
            .runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        self.runtime
            .require_team_page_scope(&self.expected, self.lifetime.cancellation)?;
        let publication = self
            .runtime
            .foreground_attachments
            .publication(&self.foreground);
        let admitted = match &response {
            RuntimeResponse::MyTeamInvitations { .. } => publication.begin(),
            RuntimeResponse::MyTeamInvitationAccepted { .. }
            | RuntimeResponse::MyTeamInvitationAcceptRefreshRequired { .. }
            | RuntimeResponse::MyTeamInvitationDeclined
            | RuntimeResponse::MyTeamInvitationUncertain { .. } => {
                publication.begin_control_result()
            }
            _ => unreachable!("only current-User Invitation results enter this module"),
        };
        if !admitted {
            return Err(my_invitation_cancelled());
        }
        Ok(response)
    }
}

fn my_invitation_cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Invitation request was cancelled",
    )
}

fn my_invitation_authentication_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Invitation Session is unavailable",
    )
}

fn my_invitation_authority_missing() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthorityMissing,
        "Invitation authority is unavailable",
    )
}
