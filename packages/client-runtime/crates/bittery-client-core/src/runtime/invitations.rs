//! Authenticated Team Invitation work stays inside one foreground Account lifetime.
use super::foreground_attachment_lifecycle::{ForegroundAttachmentGuard, InvitationLeaseBinding};
use super::team_page::{TeamPageListKind, TeamReadLifetime};
use super::*;
use crate::{
    auth_http::{InvitationMutationAnswer, TeamPageHttpRoute},
    platform_storage::{AccountMetadataDocument, CurrentSessionDocument},
    protocol::{
        InvitationAdminAction, InvitationCandidate, InvitationComposerData,
        InvitationComposerVault, InvitationSeatPreview, InvitationSeatPreviewLine, InvitationToken,
        InvitationUncertainPhase,
    },
    replica::{AuthorityVaultRecord, AuthorityVaultType},
    server_contract,
};
use bittery_crypto_core::{encrypt_vault_key_for_member, rsa::rsa_public_key_fingerprint};
use serde::de::DeserializeOwned;
use std::collections::{HashMap, HashSet};

struct InvitationFlow<'a> {
    runtime: &'a Runtime,
    expected: ReplicaSnapshot,
    metadata: AccountMetadataDocument,
    session: CurrentSessionDocument,
    http: AuthHttpClient<'a>,
    lifetime: TeamReadLifetime<'a>,
    foreground: ForegroundAttachmentGuard,
}

const MAX_PENDING_VAULT_KEYS: usize = 100;

struct InvitationReservation<'a> {
    runtime: &'a Runtime,
    id: String,
    reserved_at_ms: u64,
    consumed: bool,
}

impl InvitationReservation<'_> {
    fn consume(&mut self) {
        self.runtime.foreground_attachments.finish_invitation_lease(
            &self.id,
            false,
            self.reserved_at_ms,
        );
        self.consumed = true;
    }
}

impl Drop for InvitationReservation<'_> {
    fn drop(&mut self) {
        if !self.consumed {
            self.runtime.foreground_attachments.finish_invitation_lease(
                &self.id,
                true,
                self.reserved_at_ms,
            );
        }
    }
}

impl Runtime {
    pub(super) async fn request_team_invitation(
        &self,
        request: RuntimeRequest,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let account_id = request
            .account_id()
            .expect("Invitation requests are Account scoped")
            .clone();
        if let RuntimeRequest::ReleaseInvitationContinuation {
            continuation_id, ..
        } = request
        {
            if let Some(snapshot) = self.replica.snapshot(&account_id) {
                self.foreground_attachments.release_invitation_lease(
                    &account_id,
                    &snapshot.incarnation,
                    snapshot.lock_epoch,
                    &continuation_id,
                );
            }
            return Ok(RuntimeResponse::InvitationContinuationReleased);
        }
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(invitation_cancelled()),
            guard = execution.lock() => guard,
        };
        let mut flow = InvitationFlow::new(self, &account_id, &cancellation).await?;
        match request {
            RuntimeRequest::ReadInvitationComposer { team_id, .. } => {
                let composer = flow.read_composer(&team_id).await?;
                flow.publish(RuntimeResponse::InvitationComposer {
                    composer: Box::new(composer),
                })
                .await
            }
            RuntimeRequest::CreateTeamInvitation {
                team_id,
                email,
                role,
                ..
            } => flow.create(&team_id, &email, role).await,
            RuntimeRequest::ProvisionTeamInvitation {
                continuation_id, ..
            } => flow.provision(&continuation_id).await,
            RuntimeRequest::CancelTeamInvitation {
                team_id,
                invitation_id,
                ..
            } => flow.cancel_admin(&team_id, &invitation_id).await,
            RuntimeRequest::ResendTeamInvitation {
                team_id,
                invitation_id,
                ..
            } => flow.resend_admin(&team_id, &invitation_id).await,
            _ => unreachable!("only Invitation requests enter this module"),
        }
    }
}

impl<'a> InvitationFlow<'a> {
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
            .ok_or_else(invitation_authentication_required)?;
        runtime.require_team_page_scope(&expected, cancellation)?;
        let session = runtime
            .effective_session(account_id, &expected.incarnation)
            .await?
            .ok_or_else(invitation_authentication_required)?;
        let http = AuthHttpClient::new(
            &runtime.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            runtime
                .auth_client_config
                .clone()
                .ok_or_else(invitation_authentication_required)?,
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

    async fn read<T: DeserializeOwned>(
        &mut self,
        route: TeamPageHttpRoute<'_>,
    ) -> Result<Option<T>, RuntimeError> {
        self.runtime
            .team_read(
                &self.http,
                &self.expected,
                &mut self.session,
                route,
                &mut self.lifetime,
            )
            .await
    }

    async fn pages<T: DeserializeOwned>(
        &mut self,
        team_id: &str,
        kind: TeamPageListKind,
    ) -> Result<Vec<T>, RuntimeError> {
        self.runtime
            .team_pages(
                &self.http,
                &self.expected,
                &mut self.session,
                team_id,
                kind,
                &mut self.lifetime,
            )
            .await
    }

    async fn require_team_authority(&mut self, team_id: &str) -> Result<(), RuntimeError> {
        let user: server_contract::MeResponse = self
            .read(TeamPageHttpRoute::User)
            .await?
            .ok_or_else(invitation_authority_missing)?;
        if user.id != self.expected.user_id {
            return Err(invitation_authority_missing());
        }
        let current: server_contract::TeamSummaryResponse = self
            .read(TeamPageHttpRoute::CurrentTeam)
            .await?
            .ok_or_else(invitation_authority_missing)?;
        if current.id != team_id {
            return Err(invitation_authority_missing());
        }
        let details: server_contract::TeamDetailsResponse = self
            .read(TeamPageHttpRoute::Details(team_id))
            .await?
            .ok_or_else(invitation_authority_missing)?;
        if details.id != current.id || details.owner_id != current.owner_id {
            return Err(invitation_authority_missing());
        }
        if !matches!(
            details.user_role,
            server_contract::TeamRole::Owner | server_contract::TeamRole::Admin
        ) {
            return Err(invitation_access_denied());
        }
        let billing: server_contract::BillingEntitlementsResponse = self
            .read(TeamPageHttpRoute::Entitlements)
            .await?
            .ok_or_else(invitation_authority_missing)?;
        if !billing.entitlements.team_management {
            return Err(invitation_access_denied());
        }
        Ok(())
    }

    async fn read_composer(
        &mut self,
        team_id: &str,
    ) -> Result<InvitationComposerData, RuntimeError> {
        self.require_team_authority(team_id).await?;
        let vaults: Vec<server_contract::TeamVaultResponse> =
            self.pages(team_id, TeamPageListKind::Vaults).await?;
        let billing: server_contract::BillingStatusResponse = self
            .read(TeamPageHttpRoute::BillingStatus)
            .await?
            .ok_or_else(invitation_authority_missing)?;
        let team_plan_active = billing.enabled
            && billing.is_active
            && billing.plan == server_contract::BillingPlan::Team;
        let seat_preview: Option<server_contract::TeamSeatInvoicePreviewResponse> =
            if team_plan_active {
                self.read(TeamPageHttpRoute::SeatPreview)
                    .await?
                    .ok_or_else(invitation_authority_missing)?
            } else {
                None
            };
        let mut seen = HashSet::new();
        let vaults = vaults
            .into_iter()
            .map(|vault| {
                if !seen.insert(vault.id.clone()) {
                    return Err(invitation_authority_missing());
                }
                Ok(InvitationComposerVault {
                    id: vault.id,
                    name: vault.name,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(InvitationComposerData {
            team_id: team_id.to_owned(),
            vaults,
            billing_enabled: billing.enabled,
            team_plan_active,
            seat_preview: seat_preview.map(map_seat_preview),
        })
    }

    async fn require_admin_invitation(
        &mut self,
        team_id: &str,
        invitation_id: &str,
    ) -> Result<(), RuntimeError> {
        if invitation_id.is_empty() {
            return Err(invitation_authority_missing());
        }
        self.require_team_authority(team_id).await?;
        let invitations: Vec<server_contract::InvitationListResponse> =
            self.pages(team_id, TeamPageListKind::Invitations).await?;
        if invitations
            .iter()
            .filter(|invitation| {
                invitation.id == invitation_id
                    && invitation.status == server_contract::InvitationStatus::Pending
            })
            .count()
            != 1
        {
            return Err(invitation_authority_missing());
        }
        self.require_current().await
    }

    async fn cancel_admin(
        &mut self,
        team_id: &str,
        invitation_id: &str,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.require_admin_invitation(team_id, invitation_id)
            .await?;
        let answer = self
            .http
            .cancel_team_invitation(
                self.session.token.as_ref(),
                team_id,
                invitation_id,
                self.lifetime.cancellation.clone(),
            )
            .await?;
        match answer {
            InvitationMutationAnswer::Confirmed(result) if result.success => {
                self.publish(RuntimeResponse::TeamInvitationCancelled {
                    invitation_id: invitation_id.to_owned(),
                })
                .await
            }
            _ => {
                self.admin_uncertain(team_id, invitation_id, InvitationAdminAction::Cancel)
                    .await
            }
        }
    }

    async fn resend_admin(
        &mut self,
        team_id: &str,
        invitation_id: &str,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.require_admin_invitation(team_id, invitation_id)
            .await?;
        let answer = self
            .http
            .resend_team_invitation(
                self.session.token.as_ref(),
                team_id,
                invitation_id,
                self.lifetime.cancellation.clone(),
            )
            .await?;
        match answer {
            InvitationMutationAnswer::Confirmed(result) => {
                let token = InvitationToken::from(result.token);
                if result.invitation_id != invitation_id || token.is_empty() {
                    return self
                        .admin_uncertain(team_id, invitation_id, InvitationAdminAction::Resend)
                        .await;
                }
                self.publish(RuntimeResponse::TeamInvitationResent {
                    invitation_id: result.invitation_id,
                    token,
                })
                .await
            }
            InvitationMutationAnswer::Uncertain => {
                self.admin_uncertain(team_id, invitation_id, InvitationAdminAction::Resend)
                    .await
            }
        }
    }

    async fn admin_uncertain(
        &mut self,
        team_id: &str,
        invitation_id: &str,
        action: InvitationAdminAction,
    ) -> Result<RuntimeResponse, RuntimeError> {
        let pending = self
            .pages::<server_contract::InvitationListResponse>(
                team_id,
                TeamPageListKind::Invitations,
            )
            .await
            .ok()
            .map(|invitations| {
                invitations
                    .iter()
                    .any(|invitation| invitation.id == invitation_id)
            });
        self.publish(RuntimeResponse::TeamInvitationAdminUncertain {
            action,
            invitation_id: invitation_id.to_owned(),
            pending,
        })
        .await
    }

    async fn create(
        &mut self,
        team_id: &str,
        email: &str,
        role: server_contract::TeamRole,
    ) -> Result<RuntimeResponse, RuntimeError> {
        // The Server stores and compares Invitation email verbatim. Use the same
        // identity normalization as Account registration before the first send.
        let email = bittery_crypto_core::normalize_email(email);
        if email.is_empty() || email.len() > 320 || matches!(role, server_contract::TeamRole::Owner)
        {
            return Err(invitation_invalid_input());
        }
        self.require_team_authority(team_id).await?;
        self.require_current().await?;
        self.runtime
            .foreground_attachments
            .require_invitation_lease_capacity(
                &self.expected.account_id,
                self.runtime.clock.now_ms()?,
            )?;
        let answer = self
            .http
            .send_team_invitation(
                self.session.token.as_ref(),
                team_id,
                &server_contract::SendInvitationRequest {
                    email: email.to_owned(),
                    role: Some(role.clone()),
                    pending_vault_keys: None,
                },
                self.lifetime.cancellation.clone(),
            )
            .await?;
        let InvitationMutationAnswer::Confirmed(created) = answer else {
            return self
                .publish(RuntimeResponse::TeamInvitationUncertain {
                    phase: InvitationUncertainPhase::FirstSend,
                    original_invitation_id: None,
                })
                .await;
        };
        let token = InvitationToken::from(created.token);
        if created.invitation_id.is_empty() || token.is_empty() {
            return self
                .publish(RuntimeResponse::TeamInvitationUncertain {
                    phase: InvitationUncertainPhase::FirstSend,
                    original_invitation_id: None,
                })
                .await;
        }
        let candidate = match (created.existing_user_id, created.existing_user_public_key) {
            (Some(recipient_user_id), Some(public_key))
                if !recipient_user_id.is_empty() && !public_key.is_empty() =>
            {
                let Ok(fingerprint) = rsa_public_key_fingerprint(&public_key) else {
                    return self
                        .publish(RuntimeResponse::TeamInvitationUncertain {
                            phase: InvitationUncertainPhase::FirstSend,
                            original_invitation_id: None,
                        })
                        .await;
                };
                Some(InvitationCandidate {
                    recipient_user_id,
                    public_key,
                    fingerprint,
                })
            }
            (None, None) => None,
            _ => {
                return self
                    .publish(RuntimeResponse::TeamInvitationUncertain {
                        phase: InvitationUncertainPhase::FirstSend,
                        original_invitation_id: None,
                    })
                    .await;
            }
        };
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
            return Err(invitation_cancelled());
        }
        let continuation_id = if let Some(candidate) = &candidate {
            Some(self.runtime.foreground_attachments.issue_invitation_lease(
                InvitationLeaseBinding {
                    account_id: self.expected.account_id.clone(),
                    incarnation: self.expected.incarnation.clone(),
                    lock_epoch: self.expected.lock_epoch,
                    team_id: team_id.to_owned(),
                    invitation_id: created.invitation_id.clone(),
                    email: email.to_owned(),
                    role,
                    recipient_user_id: candidate.recipient_user_id.clone(),
                    public_key: candidate.public_key.clone(),
                },
                self.runtime.clock.now_ms()?,
            )?)
        } else {
            None
        };
        Ok(RuntimeResponse::TeamInvitationCreated {
            invitation_id: created.invitation_id,
            token,
            candidate,
            continuation_id,
        })
    }

    async fn provision(&mut self, continuation_id: &str) -> Result<RuntimeResponse, RuntimeError> {
        let reserved_at_ms = self.runtime.clock.now_ms()?;
        let binding = self
            .runtime
            .foreground_attachments
            .reserve_invitation_lease(
                &self.expected.account_id,
                &self.expected.incarnation,
                self.expected.lock_epoch,
                continuation_id,
                reserved_at_ms,
                self.lifetime.cancellation.clone(),
            )?;
        let mut reservation = InvitationReservation {
            runtime: self.runtime,
            id: continuation_id.to_owned(),
            reserved_at_ms,
            consumed: false,
        };
        self.require_team_authority(&binding.team_id).await?;
        let invitations: Vec<server_contract::InvitationListResponse> = self
            .pages(&binding.team_id, TeamPageListKind::Invitations)
            .await?;
        let matching = invitations
            .iter()
            .filter(|invitation| invitation.id == binding.invitation_id)
            .collect::<Vec<_>>();
        if matching.len() != 1
            || matching[0].status != server_contract::InvitationStatus::Pending
            || matching[0].email != binding.email
            || matching[0].role != binding.role
        {
            return Err(invitation_authority_missing());
        }
        let verified = self
            .runtime
            .platform_storage
            .load_verified_recipient_keys(&self.metadata)
            .await?;
        let approved_key =
            verified.approved_key(&binding.recipient_user_id, binding.public_key.clone())?;
        if approved_key != binding.public_key {
            return Err(invitation_authority_missing());
        }
        let vaults: Vec<server_contract::TeamVaultResponse> = self
            .pages(&binding.team_id, TeamPageListKind::Vaults)
            .await?;
        let evidence = vault_evidence(&vaults)?;
        let pending_vault_keys = self.seal_current_team_vaults(&vaults, &approved_key)?;
        if pending_vault_keys.is_empty() {
            reservation.consume();
            return self
                .publish(RuntimeResponse::TeamInvitationProvisioningNotRequired {
                    invitation_id: binding.invitation_id,
                })
                .await;
        }
        self.require_team_authority(&binding.team_id).await?;
        let latest: Vec<server_contract::TeamVaultResponse> = self
            .pages(&binding.team_id, TeamPageListKind::Vaults)
            .await?;
        if vault_evidence(&latest)? != evidence {
            return Err(invitation_authority_missing());
        }
        self.require_current().await?;
        self.runtime
            .foreground_attachments
            .invitation_lease_reserved(
                &self.expected.account_id,
                &self.expected.incarnation,
                self.expected.lock_epoch,
                continuation_id,
                self.runtime.clock.now_ms()?,
            )?;
        reservation.consume();
        let cancelled = self
            .http
            .cancel_team_invitation(
                self.session.token.as_ref(),
                &binding.team_id,
                &binding.invitation_id,
                self.lifetime.cancellation.clone(),
            )
            .await?;
        let InvitationMutationAnswer::Confirmed(cancelled) = cancelled else {
            return self
                .publish(RuntimeResponse::TeamInvitationUncertain {
                    phase: InvitationUncertainPhase::CancelOriginal,
                    original_invitation_id: Some(binding.invitation_id),
                })
                .await;
        };
        if !cancelled.success {
            return self.incomplete_after_cancel(&binding.invitation_id).await;
        }
        if self.require_team_authority(&binding.team_id).await.is_err() {
            return self.incomplete_after_cancel(&binding.invitation_id).await;
        }
        let latest: Vec<server_contract::TeamVaultResponse> =
            match self.pages(&binding.team_id, TeamPageListKind::Vaults).await {
                Ok(vaults) => vaults,
                Err(_) => return self.incomplete_after_cancel(&binding.invitation_id).await,
            };
        if vault_evidence(&latest).ok().as_ref() != Some(&evidence) {
            return self.incomplete_after_cancel(&binding.invitation_id).await;
        }
        if self.require_current().await.is_err() {
            return self.incomplete_after_cancel(&binding.invitation_id).await;
        }
        let replacement = self
            .http
            .send_team_invitation(
                self.session.token.as_ref(),
                &binding.team_id,
                &server_contract::SendInvitationRequest {
                    email: binding.email,
                    role: Some(binding.role),
                    pending_vault_keys: Some(pending_vault_keys),
                },
                self.lifetime.cancellation.clone(),
            )
            .await;
        let Ok(replacement) = replacement else {
            return self.incomplete_after_cancel(&binding.invitation_id).await;
        };
        match replacement {
            InvitationMutationAnswer::Confirmed(replacement) => {
                let token = InvitationToken::from(replacement.token);
                if replacement.invitation_id.is_empty()
                    || token.is_empty()
                    || replacement.existing_user_id.as_deref()
                        != Some(binding.recipient_user_id.as_str())
                    || replacement.existing_user_public_key.as_deref()
                        != Some(binding.public_key.as_str())
                {
                    return self.incomplete_after_cancel(&binding.invitation_id).await;
                }
                self.publish(RuntimeResponse::TeamInvitationProvisioned {
                    invitation_id: replacement.invitation_id,
                    token,
                })
                .await
            }
            _ => self.incomplete_after_cancel(&binding.invitation_id).await,
        }
    }

    async fn incomplete_after_cancel(
        &self,
        invitation_id: &str,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.publish(RuntimeResponse::TeamInvitationUncertain {
            phase: InvitationUncertainPhase::ReplacementSend,
            original_invitation_id: Some(invitation_id.to_owned()),
        })
        .await
    }

    fn seal_current_team_vaults(
        &self,
        vaults: &[server_contract::TeamVaultResponse],
        public_key: &str,
    ) -> Result<Vec<server_contract::PendingVaultKeyRequest>, RuntimeError> {
        let accessible_count = vaults
            .iter()
            .filter(|vault| vault.encrypted_vault_key.is_some())
            .count();
        if accessible_count > MAX_PENDING_VAULT_KEYS {
            return Err(RuntimeError::new(
                RuntimeErrorCode::QuotaExceeded,
                "Invitation exceeds the Server Vault wrapper limit",
            ));
        }
        let mut current = self
            .runtime
            .require_snapshot(&self.expected.account_id)?
            .bootstrap
            .snapshot()
            .visible_vaults
            .into_iter()
            .filter(|vault| vault.vault_type == AuthorityVaultType::Team)
            .map(|vault| (vault.id.clone(), vault))
            .collect::<HashMap<String, AuthorityVaultRecord>>();
        let material = self
            .runtime
            .copy_live_vault_key_material(&self.expected.account_id, &self.expected.incarnation)
            .ok_or_else(invitation_authentication_required)?;
        let mut pending = Vec::with_capacity(accessible_count);
        for vault in vaults {
            // The Team list includes Vaults this admin has not joined. Only a
            // current member wrapper grants access to provision that Vault.
            let Some(wrapped) = &vault.encrypted_vault_key else {
                if current.contains_key(&vault.id) {
                    return Err(invitation_authority_missing());
                }
                continue;
            };
            let local = current
                .remove(&vault.id)
                .ok_or_else(invitation_authority_missing)?;
            if wrapped != &local.encrypted_vault_key {
                return Err(invitation_authority_missing());
            }
            let key = Zeroizing::new(super::vault_key::unwrap_vault_key(
                &local,
                &self.expected.user_id,
                &material,
            )?);
            let encrypted_vault_key = encrypt_vault_key_for_member(&key, public_key)
                .map_err(|_| invitation_authority_missing())?;
            pending.push(server_contract::PendingVaultKeyRequest {
                vault_id: vault.id.clone(),
                encrypted_vault_key,
            });
        }
        if !current.is_empty() {
            return Err(invitation_authority_missing());
        }
        Ok(pending)
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
            return Err(invitation_cancelled());
        }
        Ok(response)
    }
}

fn vault_evidence(
    vaults: &[server_contract::TeamVaultResponse],
) -> Result<Vec<(String, Option<String>)>, RuntimeError> {
    let mut seen = HashSet::new();
    let mut result = vaults
        .iter()
        .map(|vault| {
            if !seen.insert(vault.id.clone()) {
                return Err(invitation_authority_missing());
            }
            Ok((vault.id.clone(), vault.encrypted_vault_key.clone()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    result.sort();
    Ok(result)
}

fn map_seat_preview(
    source: server_contract::TeamSeatInvoicePreviewResponse,
) -> InvitationSeatPreview {
    InvitationSeatPreview {
        currency: source.currency,
        current_quantity: source.current_quantity,
        next_quantity: source.next_quantity,
        estimated_next_payment_cents: source.estimated_next_payment_cents,
        total_line_items_cents: source.total_line_items_cents,
        lines: source
            .lines
            .into_iter()
            .map(|line| InvitationSeatPreviewLine {
                id: line.id,
                description: line.description,
                amount_cents: line.amount_cents,
                currency: line.currency,
                period_start: line.period_start,
                period_end: line.period_end,
                quantity: line.quantity,
                unit_amount_cents: line.unit_amount_cents,
                is_proration: line.is_proration,
            })
            .collect(),
    }
}

fn invitation_cancelled() -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::Cancelled, "Invitation request cancelled")
}
fn invitation_authentication_required() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthenticationRequired,
        "Invitation requires an unlocked Account and Session",
    )
}
fn invitation_authority_missing() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthorityMissing,
        "Invitation authority changed or is incomplete",
    )
}
fn invitation_access_denied() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AccessDenied,
        "Team Invitation access is unavailable",
    )
}
fn invitation_invalid_input() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InvariantViolation,
        "Invitation email or role is invalid",
    )
}
