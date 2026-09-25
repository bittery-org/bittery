//! A closed authenticated foreground read for the existing Web Team page.
use super::*;
use crate::{
    auth_http::{TeamPageHttpAnswer, TeamPageHttpPage, TeamPageHttpRoute},
    platform_storage::CurrentSessionDocument,
    protocol::{
        TeamPageData, TeamPageDetails, TeamPageInvitation, TeamPageMember, TeamPageRole,
        TeamPageUser,
    },
    server_contract,
};
use serde::de::DeserializeOwned;
use std::collections::HashSet;

const MAX_TEAM_PAGE_PAGES: usize = 64;
const MAX_TEAM_PAGE_ITEMS: usize = 5_000;

pub(super) struct TeamReadLifetime<'a> {
    pub(super) cancellation: &'a RequestCancellation,
    pub(super) renewed: bool,
}

#[derive(Clone, Copy)]
pub(super) enum TeamPageListKind {
    Members,
    Invitations,
    MyInvitations,
    Vaults,
    AvailableVaultMembers,
    VaultMembers,
}

impl Runtime {
    pub(super) async fn read_team_page(
        &self,
        account_id: AccountId,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution.lock() => guard,
        };
        let expected = self.require_snapshot(&account_id)?;
        self.require_team_page_scope(&expected, &cancellation)?;
        let foreground = self.foreground_attachments.register(
            &account_id,
            &expected.incarnation,
            cancellation.clone(),
        )?;
        let metadata = self
            .platform_storage
            .load_account_metadata(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(authentication_required)?;
        self.require_team_page_scope(&expected, &cancellation)?;
        let mut session = self
            .effective_session(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(authentication_required)?;
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            self.auth_client_config
                .clone()
                .ok_or_else(authentication_required)?,
        )?;
        let mut lifetime = TeamReadLifetime {
            cancellation: &cancellation,
            renewed: false,
        };
        let user: server_contract::MeResponse = self
            .team_read(
                &http,
                &expected,
                &mut session,
                TeamPageHttpRoute::User,
                &mut lifetime,
            )
            .await?
            .ok_or_else(authentication_required)?;
        if user.id != expected.user_id {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationUnavailable,
                "Team page returned another User",
            ));
        }
        let team: Option<server_contract::TeamSummaryResponse> = self
            .team_read(
                &http,
                &expected,
                &mut session,
                TeamPageHttpRoute::CurrentTeam,
                &mut lifetime,
            )
            .await?;
        let result = if let Some(team) = team {
            let details: server_contract::TeamDetailsResponse = self
                .team_read(
                    &http,
                    &expected,
                    &mut session,
                    TeamPageHttpRoute::Details(&team.id),
                    &mut lifetime,
                )
                .await?
                .ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::AuthorityMissing,
                        "Team details are missing",
                    )
                })?;
            if details.id != team.id || details.owner_id != team.owner_id {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AuthenticationUnavailable,
                    "Team page returned inconsistent Team authority",
                ));
            }
            let billing: server_contract::BillingEntitlementsResponse = self
                .team_read(
                    &http,
                    &expected,
                    &mut session,
                    TeamPageHttpRoute::Entitlements,
                    &mut lifetime,
                )
                .await?
                .ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::AuthorityMissing,
                        "Team entitlements are missing",
                    )
                })?;
            let can_view_invitations = matches!(
                details.user_role,
                server_contract::TeamRole::Owner | server_contract::TeamRole::Admin
            ) && billing.entitlements.team_management;
            let members = self
                .team_pages::<server_contract::TeamMemberResponse>(
                    &http,
                    &expected,
                    &mut session,
                    &team.id,
                    TeamPageListKind::Members,
                    &mut lifetime,
                )
                .await?;
            let invitations = if can_view_invitations {
                self.team_pages::<server_contract::InvitationListResponse>(
                    &http,
                    &expected,
                    &mut session,
                    &team.id,
                    TeamPageListKind::Invitations,
                    &mut lifetime,
                )
                .await?
                .into_iter()
                .map(|item| TeamPageInvitation {
                    id: item.id,
                    email: item.email,
                    role: role(item.role),
                    status: item.status,
                    invited_by: item.invited_by,
                    created_at: item.created_at,
                    expires_at: item.expires_at,
                })
                .collect()
            } else {
                Vec::new()
            };
            TeamPageData {
                user: TeamPageUser {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                },
                team: Some(TeamPageDetails {
                    id: details.id,
                    name: details.name,
                    image_url: details.image_url,
                    owner_id: details.owner_id,
                    owner_name: details.owner_name,
                    user_role: role(details.user_role),
                    member_count: details.member_count,
                    member_limit: details.member_limit,
                    created_at: details.created_at,
                    updated_at: details.updated_at,
                }),
                members: members
                    .into_iter()
                    .map(|item| TeamPageMember {
                        user_id: item.user_id,
                        name: item.name,
                        email: item.email,
                        role: role(item.role),
                        joined_at: item.joined_at,
                    })
                    .collect(),
                invitations,
                team_management_enabled: billing.entitlements.team_management,
            }
        } else {
            TeamPageData {
                user: TeamPageUser {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                },
                team: None,
                members: Vec::new(),
                invitations: Vec::new(),
                team_management_enabled: false,
            }
        };
        self.require_team_page_session(&expected, &session, &cancellation)
            .await?;
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.require_team_page_scope(&expected, &cancellation)?;
        if !self.foreground_attachments.publication(&foreground).begin() {
            return Err(cancelled());
        }
        Ok(RuntimeResponse::TeamPage {
            page: Box::new(result),
        })
    }

    pub(super) async fn team_read<T: DeserializeOwned>(
        &self,
        http: &AuthHttpClient<'_>,
        expected: &ReplicaSnapshot,
        session: &mut CurrentSessionDocument,
        route: TeamPageHttpRoute<'_>,
        lifetime: &mut TeamReadLifetime<'_>,
    ) -> Result<Option<T>, RuntimeError> {
        loop {
            self.require_team_page_session(expected, session, lifetime.cancellation)
                .await?;
            let answer = http
                .read_team_page(session.token.as_ref(), route, lifetime.cancellation.clone())
                .await?;
            self.require_team_page_session(expected, session, lifetime.cancellation)
                .await?;
            match answer {
                TeamPageHttpAnswer::Present(value) => return Ok(Some(value)),
                TeamPageHttpAnswer::Absent => return Ok(None),
                TeamPageHttpAnswer::ReauthenticationRequired(problem) if !lifetime.renewed => {
                    let refresh = self
                        .request_session_refresh(session, http, lifetime.cancellation.clone())
                        .await
                        .map_err(|mut error| {
                            error.team_page_problem = problem.map(Box::new);
                            error
                        })?;
                    self.require_team_page_session(expected, session, lifetime.cancellation)
                        .await?;
                    *session = self
                        .publish_session_refresh(&expected.account_id, session, refresh)
                        .await?;
                    lifetime.renewed = true;
                }
                TeamPageHttpAnswer::ReauthenticationRequired(problem) => {
                    let mut error = authentication_required();
                    error.team_page_problem = problem.map(Box::new);
                    return Err(error);
                }
            }
        }
    }

    pub(super) async fn team_pages<T: DeserializeOwned>(
        &self,
        http: &AuthHttpClient<'_>,
        expected: &ReplicaSnapshot,
        session: &mut CurrentSessionDocument,
        team_id: &str,
        kind: TeamPageListKind,
        lifetime: &mut TeamReadLifetime<'_>,
    ) -> Result<Vec<T>, RuntimeError> {
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen = HashSet::new();
        for _ in 0..MAX_TEAM_PAGE_PAGES {
            let route = match kind {
                TeamPageListKind::Members => TeamPageHttpRoute::Members(team_id, cursor.as_deref()),
                TeamPageListKind::Invitations => {
                    TeamPageHttpRoute::Invitations(team_id, cursor.as_deref())
                }
                TeamPageListKind::MyInvitations => {
                    TeamPageHttpRoute::MyInvitations(cursor.as_deref())
                }
                TeamPageListKind::Vaults => TeamPageHttpRoute::Vaults(team_id, cursor.as_deref()),
                TeamPageListKind::AvailableVaultMembers => {
                    TeamPageHttpRoute::AvailableVaultMembers(team_id, cursor.as_deref())
                }
                TeamPageListKind::VaultMembers => {
                    TeamPageHttpRoute::VaultMembers(team_id, cursor.as_deref())
                }
            };
            let page: TeamPageHttpPage<T> = self
                .team_read(http, expected, session, route, lifetime)
                .await?
                .ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::AuthorityMissing,
                        "Team page list is missing",
                    )
                })?;
            if items.len().saturating_add(page.items.len()) > MAX_TEAM_PAGE_ITEMS {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AuthenticationUnavailable,
                    "Team page list exceeded its bound",
                ));
            }
            items.extend(page.items);
            if !page.has_more {
                return Ok(items);
            }
            let next = page
                .next_cursor
                .filter(|value| !value.is_empty() && value.len() <= 1_024)
                .ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::AuthenticationUnavailable,
                        "Team page cursor is invalid",
                    )
                })?;
            if !seen.insert(next.clone()) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AuthenticationUnavailable,
                    "Team page cursor repeated",
                ));
            }
            cursor = Some(next);
        }
        Err(RuntimeError::new(
            RuntimeErrorCode::AuthenticationUnavailable,
            "Team page pagination exceeded its bound",
        ))
    }

    pub(super) fn require_team_page_scope(
        &self,
        expected: &ReplicaSnapshot,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled()
            || self.account_access_retirement_is_pending(&expected.account_id)
            || self.account_teardown_is_pending(&expected.account_id)
        {
            return Err(cancelled());
        }
        let current = self.require_snapshot(&expected.account_id)?;
        if current.incarnation != expected.incarnation || current.lock_epoch != expected.lock_epoch
        {
            return Err(cancelled());
        }
        if !self.generation_has_current_unlocked_authority(&current) {
            return Err(authentication_required());
        }
        Ok(())
    }

    pub(super) async fn require_team_page_session(
        &self,
        expected: &ReplicaSnapshot,
        session: &CurrentSessionDocument,
        cancellation: &RequestCancellation,
    ) -> Result<(), RuntimeError> {
        self.require_team_page_scope(expected, cancellation)?;
        let current = self
            .effective_session(&expected.account_id, &expected.incarnation)
            .await?;
        self.require_team_page_scope(expected, cancellation)?;
        if current.as_ref() != Some(session) {
            return Err(cancelled());
        }
        Ok(())
    }
}

fn role(role: server_contract::TeamRole) -> TeamPageRole {
    match role {
        server_contract::TeamRole::Owner => TeamPageRole::Owner,
        server_contract::TeamRole::Admin => TeamPageRole::Admin,
        server_contract::TeamRole::Member => TeamPageRole::Member,
    }
}
fn cancelled() -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::Cancelled, "Team page read cancelled")
}
fn authentication_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Team page requires an unlocked Account and Session",
    )
}
