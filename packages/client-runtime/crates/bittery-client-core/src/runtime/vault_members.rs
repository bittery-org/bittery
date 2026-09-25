//! Closed Vault membership reads and one exact-key Add-Member gesture.
use super::foreground_attachment_lifecycle::ForegroundAttachmentGuard;
use super::team_page::{TeamPageListKind, TeamReadLifetime};
use super::*;
use crate::{
    auth_http::{InvitationMutationAnswer, TeamPageHttpRoute},
    platform_storage::{AccountMetadataDocument, CurrentSessionDocument},
    protocol::{AvailableVaultMember, CurrentVaultMember},
    replica::{AuthorityVaultRecord, AuthorityVaultRole, AuthorityVaultType},
    server_contract,
};
use bittery_crypto_core::encrypt_vault_key_for_member;
use std::collections::HashSet;

struct VaultMemberFlow<'a> {
    runtime: &'a Runtime,
    expected: ReplicaSnapshot,
    metadata: AccountMetadataDocument,
    session: CurrentSessionDocument,
    http: AuthHttpClient<'a>,
    lifetime: TeamReadLifetime<'a>,
    foreground: ForegroundAttachmentGuard,
}

impl Runtime {
    pub(super) async fn request_vault_membership(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let account_id = request
            .account_id()
            .expect("Vault member request is Account scoped")
            .clone();
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(cancelled()),
            guard = execution.lock() => guard,
        };
        let mut flow = VaultMemberFlow::new(self, &account_id, &cancellation).await?;
        match request {
            RuntimeRequest::ListAvailableVaultMembers { vault_id, .. } => {
                flow.current_vault(&vault_id).await?;
                let members = flow.available(&vault_id).await?;
                flow.publish(RuntimeResponse::AvailableVaultMembers { members })
                    .await
            }
            RuntimeRequest::ListVaultMembers { vault_id, .. } => {
                if !flow
                    .runtime
                    .require_snapshot(&flow.expected.account_id)?
                    .bootstrap
                    .snapshot()
                    .visible_vaults
                    .iter()
                    .any(|vault| vault.id == vault_id)
                {
                    return Err(authority_missing());
                }
                let members = flow.members(&vault_id).await?;
                flow.publish(RuntimeResponse::VaultMembers { members })
                    .await
            }
            RuntimeRequest::AddVaultMember {
                vault_id,
                user_id,
                role,
                ..
            } => flow.add(&vault_id, &user_id, role).await,
            _ => unreachable!("only Vault member requests enter this module"),
        }
    }
}

impl<'a> VaultMemberFlow<'a> {
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
            .ok_or_else(authentication_required)?;
        runtime.require_team_page_scope(&expected, cancellation)?;
        let session = runtime
            .effective_session(account_id, &expected.incarnation)
            .await?
            .ok_or_else(authentication_required)?;
        let http = AuthHttpClient::new(
            &runtime.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            runtime
                .auth_client_config
                .clone()
                .ok_or_else(authentication_required)?,
        )?;
        Ok(Self {
            runtime,
            expected,
            metadata,
            session,
            http,
            lifetime: TeamReadLifetime {
                cancellation,
                renewed: false,
            },
            foreground,
        })
    }

    async fn available(
        &mut self,
        vault_id: &str,
    ) -> Result<Vec<AvailableVaultMember>, RuntimeError> {
        let rows: Vec<server_contract::VaultAvailableMemberResponse> = self
            .runtime
            .team_pages(
                &self.http,
                &self.expected,
                &mut self.session,
                vault_id,
                TeamPageListKind::AvailableVaultMembers,
                &mut self.lifetime,
            )
            .await?;
        let mut seen = HashSet::new();
        rows.into_iter()
            .map(|row| {
                if row.user_id.is_empty()
                    || row.public_key.is_empty()
                    || !seen.insert(row.user_id.clone())
                {
                    return Err(authority_missing());
                }
                Ok(AvailableVaultMember {
                    user_id: row.user_id,
                    name: row.name,
                    email: row.email,
                    public_key: row.public_key,
                })
            })
            .collect()
    }

    async fn members(&mut self, vault_id: &str) -> Result<Vec<CurrentVaultMember>, RuntimeError> {
        let rows: Vec<server_contract::VaultMemberResponse> = self
            .runtime
            .team_pages(
                &self.http,
                &self.expected,
                &mut self.session,
                vault_id,
                TeamPageListKind::VaultMembers,
                &mut self.lifetime,
            )
            .await?;
        let mut seen = HashSet::new();
        rows.into_iter()
            .map(|row| {
                if row.user_id.is_empty() || !seen.insert(row.user_id.clone()) {
                    return Err(authority_missing());
                }
                Ok(CurrentVaultMember {
                    user_id: row.user_id,
                    name: row.name,
                    email: row.email,
                    role: row.role,
                })
            })
            .collect()
    }

    async fn current_vault(
        &mut self,
        vault_id: &str,
    ) -> Result<AuthorityVaultRecord, RuntimeError> {
        if vault_id.is_empty() {
            return Err(authority_missing());
        }
        let user: server_contract::MeResponse = self
            .runtime
            .team_read(
                &self.http,
                &self.expected,
                &mut self.session,
                TeamPageHttpRoute::User,
                &mut self.lifetime,
            )
            .await?
            .ok_or_else(authority_missing)?;
        if user.id != self.expected.user_id {
            return Err(authority_missing());
        }
        let team: server_contract::TeamSummaryResponse = self
            .runtime
            .team_read(
                &self.http,
                &self.expected,
                &mut self.session,
                TeamPageHttpRoute::CurrentTeam,
                &mut self.lifetime,
            )
            .await?
            .ok_or_else(authority_missing)?;
        let vaults: Vec<server_contract::TeamVaultResponse> = self
            .runtime
            .team_pages(
                &self.http,
                &self.expected,
                &mut self.session,
                &team.id,
                TeamPageListKind::Vaults,
                &mut self.lifetime,
            )
            .await?;
        let mut matching = vaults.iter().filter(|v| v.id == vault_id);
        let server = matching.next().ok_or_else(authority_missing)?;
        if matching.next().is_some() {
            return Err(authority_missing());
        }
        let wrapped = server
            .encrypted_vault_key
            .as_deref()
            .ok_or_else(authority_missing)?;
        let visible = self
            .runtime
            .require_snapshot(&self.expected.account_id)?
            .bootstrap
            .snapshot()
            .visible_vaults;
        let mut matching = visible.into_iter().filter(|v| v.id == vault_id);
        let local = matching.next().ok_or_else(authority_missing)?;
        if matching.next().is_some()
            || local.vault_type != AuthorityVaultType::Team
            || !matches!(
                local.role,
                AuthorityVaultRole::Owner | AuthorityVaultRole::Admin
            )
            || local.encrypted_vault_key != wrapped
        {
            return Err(authority_missing());
        }
        Ok(local)
    }

    async fn add(
        &mut self,
        vault_id: &str,
        user_id: &str,
        role: server_contract::VaultRole,
    ) -> Result<RuntimeResponse, RuntimeError> {
        if user_id.is_empty()
            || !matches!(
                role,
                server_contract::VaultRole::Admin
                    | server_contract::VaultRole::Member
                    | server_contract::VaultRole::ReadOnly
            )
        {
            return Err(authority_missing());
        }
        let candidate = self
            .available(vault_id)
            .await?
            .into_iter()
            .find(|member| member.user_id == user_id)
            .ok_or_else(authority_missing)?;
        let verified = self
            .runtime
            .platform_storage
            .load_verified_recipient_keys(&self.metadata)
            .await?;
        let approved = verified.approved_key(user_id, candidate.public_key.clone())?;
        if approved != candidate.public_key {
            return Err(authority_missing());
        }
        let vault = self.current_vault(vault_id).await?;
        let material = self
            .runtime
            .copy_live_vault_key_material(&self.expected.account_id, &self.expected.incarnation)
            .ok_or_else(authentication_required)?;
        let key = Zeroizing::new(super::vault_key::unwrap_vault_key(
            &vault,
            &self.expected.user_id,
            &material,
        )?);
        let encrypted =
            encrypt_vault_key_for_member(&key, &approved).map_err(|_| authority_missing())?;
        drop(key);
        drop(material);
        let current_candidate = self
            .available(vault_id)
            .await?
            .into_iter()
            .find(|member| member.user_id == user_id)
            .ok_or_else(authority_missing)?;
        if current_candidate != candidate || self.current_vault(vault_id).await? != vault {
            return Err(authority_missing());
        }
        self.require_current().await?;
        let answer = self
            .http
            .add_vault_member(
                self.session.token.as_ref(),
                vault_id,
                user_id,
                &server_contract::AddVaultMemberBody {
                    role,
                    encrypted_vault_key: encrypted,
                },
                self.lifetime.cancellation.clone(),
            )
            .await?;
        match answer {
            InvitationMutationAnswer::Confirmed(result) if result.success => {
                self.publish(RuntimeResponse::VaultMemberAdded {
                    vault_id: vault_id.into(),
                    user_id: user_id.into(),
                })
                .await
            }
            _ => self.uncertain(vault_id, user_id).await,
        }
    }

    async fn uncertain(
        &mut self,
        vault_id: &str,
        user_id: &str,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let current_role = self.members(vault_id).await.ok().and_then(|members| {
            members
                .into_iter()
                .find(|member| member.user_id == user_id)
                .map(|member| member.role)
        });
        self.publish(RuntimeResponse::VaultMemberAddUncertain {
            vault_id: vault_id.into(),
            user_id: user_id.into(),
            current_role,
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
        if !self
            .runtime
            .foreground_attachments
            .publication(&self.foreground)
            .begin()
        {
            return Err(cancelled());
        }
        Ok(response)
    }
}

fn cancelled() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Vault member request cancelled",
    )
}
fn authentication_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Vault membership requires an unlocked Account and Session",
    )
}
fn authority_missing() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthorityMissing,
        "Vault member authority changed or is incomplete",
    )
}
