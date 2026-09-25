//! Foreground Travel settings reuse the Account execution and verified-policy owners.
use super::foreground_attachment_lifecycle::ServerVerificationToken;
use super::travel_policy::VerifiedCurrentTravelPolicy;
use super::*;
use crate::{
    platform_storage::VerifiedTravelModePolicy, TravelModeCommandResult, TravelModeEnforcement,
    TravelModePolicy,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum TravelSelectionAction {
    Save,
    Enable,
}

pub(super) fn policy_projection(policy: &VerifiedTravelModePolicy) -> TravelModePolicy {
    TravelModePolicy {
        enabled: policy.enabled,
        hidden_vault_ids: policy.hidden_vault_ids.clone(),
        server_enabled_at_ms: policy.server_enabled_at_ms.map(|value| value.to_string()),
        server_updated_at_ms: policy.server_updated_at_ms.map(|value| value.to_string()),
        verified_at_ms: policy.verified_at_ms.map(|value| value.to_string()),
    }
}

impl Runtime {
    pub(super) fn travel_enforcement(
        &self,
        snapshot: &ReplicaSnapshot,
        policy: Option<&VerifiedTravelModePolicy>,
    ) -> TravelModeEnforcement {
        let Some(policy) = policy else {
            return TravelModeEnforcement::Unverified;
        };
        if self.travel_policy_verification_pending(snapshot) {
            TravelModeEnforcement::Unverified
        } else if self.has_vault_retirement_work(snapshot) {
            TravelModeEnforcement::Retiring
        } else if !policy.enabled && snapshot.bootstrap.state != crate::replica::ReplicaState::Ready
        {
            TravelModeEnforcement::Refreshing
        } else {
            TravelModeEnforcement::Ready
        }
    }

    pub(super) async fn refresh_travel_mode(
        &self,
        account_id: AccountId,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = execution.lock().await;
        let expected = self.require_snapshot(&account_id)?;
        // A settings refresh must remain available to resolve pending verification. It requires
        // established local access, not the new-work predicate that pending policy deliberately shuts.
        if !self.generation_has_current_unlocked_authority(&expected) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Travel settings require the current unlocked Account",
            ));
        }
        let metadata = self
            .platform_storage
            .load_account_metadata(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(travel_policy::pending_policy)?;
        let mut session = self
            .effective_session(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Travel settings require a Session",
                )
            })?;
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            self.auth_client_config
                .clone()
                .ok_or_else(travel_policy::pending_policy)?,
        )?;
        let mut renewal = outcome::OutcomeResolutionAuthBudget::default();
        let verified = match self
            .read_current_travel_policy_fenced(
                &expected,
                &http,
                &mut session,
                cancellation,
                Some(&mut renewal),
            )
            .await
        {
            Ok(policy) => policy,
            Err(error) if error.code == RuntimeErrorCode::RetryableTransport => {
                self.require_travel_policy_scope(&expected)?;
                return Ok(RuntimeResponse::TravelMode {
                    account_id,
                    result: TravelModeCommandResult::Uncertain {
                        last_verified_policy: metadata
                            .verified_travel_mode
                            .as_ref()
                            .map(policy_projection),
                    },
                });
            }
            Err(error) => return Err(error),
        };
        // Shared apply prunes effective and dormant Session authority. Keep no pre-prune clone
        // through that cleanup or any subsequent authority restoration.
        drop(session);
        let policy = verified.policy().clone();
        let snapshot = self
            .apply_verified_travel_policy_fenced(&expected, verified)
            .await?;
        Ok(RuntimeResponse::TravelMode {
            account_id,
            result: TravelModeCommandResult::Confirmed {
                policy: policy_projection(&policy),
                enforcement: self.travel_enforcement(&snapshot, Some(&policy)),
            },
        })
    }
}

impl Runtime {
    pub(super) async fn change_travel_mode_selection(
        &self,
        account_id: AccountId,
        hidden_vault_ids: Vec<String>,
        action: TravelSelectionAction,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        crate::platform_storage::validate_travel_hidden_vault_ids(&hidden_vault_ids).map_err(
            |_| {
                RuntimeError::new(
                    RuntimeErrorCode::AccessDenied,
                    "Travel Vault selection is invalid",
                )
            },
        )?;
        if action == TravelSelectionAction::Enable && hidden_vault_ids.is_empty() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccessDenied,
                "Enabling Travel mode requires a selected Vault",
            ));
        }
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = execution.lock().await;
        let expected = self.require_snapshot(&account_id)?;
        if self.travel_policy_verification_pending(&expected) {
            return Err(travel_policy::pending_policy());
        }
        if !self.generation_has_current_unlocked_authority(&expected) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Travel settings require the current unlocked Account",
            ));
        }
        let metadata = self
            .platform_storage
            .load_account_metadata(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(travel_policy::pending_policy)?;
        let previous = metadata
            .verified_travel_mode
            .as_ref()
            .ok_or_else(travel_policy::pending_policy)?;
        if action == TravelSelectionAction::Save && previous.enabled {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccessDenied,
                "Travel Vault selection can be saved only while Travel mode is disabled",
            ));
        }
        let visible = visible_vaults(&expected);
        for vault_id in &hidden_vault_ids {
            if !visible.iter().any(|vault| &vault.vault_id == vault_id) {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccessDenied,
                    "Travel Vault selection requires current Account-visible authority",
                ));
            }
            self.require_vault_accepting_work(&expected, vault_id)?;
        }
        let mut session = self
            .effective_session(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Travel settings require a Session",
                )
            })?;
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            self.auth_client_config
                .clone()
                .ok_or_else(travel_policy::pending_policy)?,
        )?;
        self.require_travel_policy_scope(&expected)?;
        if !self.generation_is_preparation_eligible(&expected) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Travel settings require the current unlocked Account",
            ));
        }
        let selection = crate::server_contract::HiddenVaultsRequest {
            hidden_vault_ids: hidden_vault_ids.clone(),
        };
        // This existing Server verification episode outlives caller/transport loss. Only a
        // successful marker acknowledgement permits first polling of the mutation request.
        let verification = self
            .begin_travel_mutation_verification_fenced(&expected)
            .await?;
        self.require_travel_mutation_dispatch_scope(&expected, &verification)?;
        let response = match action {
            TravelSelectionAction::Save => {
                http.set_travel_mode_hidden_vaults(&session.token, &selection, cancellation.clone())
                    .await
            }
            TravelSelectionAction::Enable => {
                http.enable_travel_mode(&session.token, &selection, cancellation.clone())
                    .await
            }
        };
        let verified = match self
            .resolve_travel_settings_policy(
                &expected,
                &http,
                &mut session,
                response,
                verification,
                cancellation,
            )
            .await
        {
            Ok(policy) => policy,
            Err(error) if error.code == RuntimeErrorCode::RetryableTransport => {
                self.require_travel_policy_scope(&expected)?;
                return Ok(RuntimeResponse::TravelMode {
                    account_id,
                    result: TravelModeCommandResult::Uncertain {
                        last_verified_policy: metadata
                            .verified_travel_mode
                            .as_ref()
                            .map(policy_projection),
                    },
                });
            }
            Err(error) => return Err(error),
        };
        drop(session);
        let policy = verified.policy().clone();
        let snapshot = self
            .apply_verified_travel_policy_fenced(&expected, verified)
            .await?;
        let matches_selection = policy.hidden_vault_ids.len() == hidden_vault_ids.len()
            && hidden_vault_ids
                .iter()
                .all(|id| policy.hidden_vault_ids.contains(id));
        let result =
            if policy.enabled == (action == TravelSelectionAction::Enable) && matches_selection {
                TravelModeCommandResult::Confirmed {
                    policy: policy_projection(&policy),
                    enforcement: self.travel_enforcement(&snapshot, Some(&policy)),
                }
            } else {
                TravelModeCommandResult::RetryRequired {
                    policy: policy_projection(&policy),
                }
            };
        Ok(RuntimeResponse::TravelMode { account_id, result })
    }
}

impl Runtime {
    pub(super) async fn disable_travel_mode(
        &self,
        account_id: AccountId,
        master_password: crate::SecretString,
        cancellation: RequestCancellation,
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        let execution = self.account_execution_lock(&account_id)?;
        let _execution = execution.lock().await;
        let expected = self.require_snapshot(&account_id)?;
        if self.travel_policy_verification_pending(&expected) {
            return Err(travel_policy::pending_policy());
        }
        if !self.generation_has_current_unlocked_authority(&expected) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Travel settings require the current unlocked Account",
            ));
        }
        let metadata = self
            .platform_storage
            .load_account_metadata(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(travel_policy::pending_policy)?;
        let quick = self
            .platform_storage
            .load_quick_unlock(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::CredentialUnavailable,
                    "Travel disable requires existing local password-proof credentials",
                )
            })?;
        let mut session = self
            .effective_session(&account_id, &expected.incarnation)
            .await?
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Travel settings require a Session",
                )
            })?;
        let http = AuthHttpClient::new(
            &self.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            self.auth_client_config
                .clone()
                .ok_or_else(travel_policy::pending_policy)?,
        )?;
        self.require_travel_policy_scope(&expected)?;
        if !self.generation_is_preparation_eligible(&expected) {
            return Err(travel_policy::pending_policy());
        }
        let proof = crate::authentication::prepare_password_proof(
            &http,
            crate::authentication::AuthenticationInput {
                email: &metadata.email,
                master_password: &master_password,
                secret_key: &quick.secret_key,
                pinned_kdf_profile: Some(&metadata.pinned_kdf_profile),
            },
            cancellation.clone(),
        )
        .await?;
        self.require_travel_policy_scope(&expected)?;
        if !self.generation_is_preparation_eligible(&expected) {
            return Err(travel_policy::pending_policy());
        }
        // Serialize once before the first POST poll; no proof or local unlock material remains
        // in this invocation while transport/reconciliation can suspend it.
        let dispatch = http.disable_travel_mode(
            &session.token,
            crate::server_contract::DisableTravelModeRequest {
                attempt_id: proof.attempt_id.clone(),
                client_public_key: proof.client_public_key.clone(),
                client_proof: proof.client_proof().to_owned(),
            },
            cancellation.clone(),
        );
        drop(proof);
        drop(quick);
        drop(master_password);
        // Only the existing zeroizing HTTP body retains proof bytes across this handoff wait.
        // Caller loss after the marker leaves a current GET duty, never a proof-replay duty.
        let verification = self
            .begin_travel_mutation_verification_fenced(&expected)
            .await?;
        self.require_travel_mutation_dispatch_scope(&expected, &verification)?;
        let response = dispatch.await;
        let verified = match self
            .resolve_travel_settings_policy(
                &expected,
                &http,
                &mut session,
                response,
                verification,
                cancellation,
            )
            .await
        {
            Ok(policy) => policy,
            Err(error) if error.code == RuntimeErrorCode::RetryableTransport => {
                self.require_travel_policy_scope(&expected)?;
                return Ok(RuntimeResponse::TravelMode {
                    account_id,
                    result: TravelModeCommandResult::Uncertain {
                        last_verified_policy: metadata
                            .verified_travel_mode
                            .as_ref()
                            .map(policy_projection),
                    },
                });
            }
            Err(error) => return Err(error),
        };
        drop(session);
        let policy = verified.policy().clone();
        let snapshot = self
            .apply_verified_travel_policy_fenced(&expected, verified)
            .await?;
        let result = if policy.enabled {
            TravelModeCommandResult::RetryRequired {
                policy: policy_projection(&policy),
            }
        } else {
            TravelModeCommandResult::Confirmed {
                policy: policy_projection(&policy),
                enforcement: self.travel_enforcement(&snapshot, Some(&policy)),
            }
        };
        Ok(RuntimeResponse::TravelMode { account_id, result })
    }

    /// Account execution is already held. A settings mutation is sent once; only a current
    /// authenticated read resolves an ambiguous response, including invalid policy semantics.
    async fn resolve_travel_settings_policy(
        &self,
        expected: &ReplicaSnapshot,
        http: &AuthHttpClient<'_>,
        session: &mut crate::platform_storage::CurrentSessionDocument,
        response: Result<crate::server_contract::TravelModeResponse, RuntimeError>,
        verification: ServerVerificationToken,
        cancellation: RequestCancellation,
    ) -> Result<VerifiedCurrentTravelPolicy, RuntimeError> {
        let response = response.and_then(|response| {
            let verified_at_ms = self.clock.now_ms()?;
            crate::authentication_installation::prepare_verified_travel_policy(
                &response,
                verified_at_ms,
            )
            .map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::RetryableTransport,
                    "Travel settings response requires current-policy reconciliation",
                )
            })
        });
        match response {
            Ok(policy) => Ok(VerifiedCurrentTravelPolicy::from_server_verification(
                policy,
                verification,
            )),
            Err(error) if error.code == RuntimeErrorCode::RetryableTransport => {
                let mut renewal = outcome::OutcomeResolutionAuthBudget::default();
                self.read_current_travel_policy_for_episode_fenced(
                    expected,
                    http,
                    session,
                    cancellation,
                    Some(&mut renewal),
                    verification,
                )
                .await
            }
            Err(error) => Err(error),
        }
    }
}
