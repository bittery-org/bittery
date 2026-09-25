//! Verified Travel policy and pending admission share the existing Account and retirement owners.
use super::foreground_attachment_lifecycle::ServerVerificationToken;
use super::outcome::OutcomeResolutionAuthBudget;
use super::*;
use crate::{
    platform_storage::{CurrentSessionDocument, VerifiedTravelModePolicy},
    replica::{
        AbandonBootstrapPlan, BootstrapGuard, MarkRefreshRequiredPlan, PlanResult, ReplicaSnapshot,
        ReplicaState,
    },
};

const POLICY_READ_TIMEOUT_MS: u64 = 15_000;

pub(super) fn pending_policy() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AuthorityMissing,
        "Current Travel policy verification is pending",
    )
}

fn guard(snapshot: &ReplicaSnapshot) -> BootstrapGuard {
    BootstrapGuard {
        account_id: snapshot.account_id.clone(),
        user_id: snapshot.user_id.clone(),
        incarnation: snapshot.incarnation.clone(),
        expected_replica_revision: snapshot.revision,
        expected_lock_epoch: snapshot.lock_epoch,
    }
}

/// A fresh response and exactly the Server episode captured before its request. This witness
/// is call-local; it cannot clear a later invalidation Server verification episode.
#[derive(Clone)]
pub(super) struct VerifiedCurrentTravelPolicy {
    policy: VerifiedTravelModePolicy,
    verification: Option<ServerVerificationToken>,
}
impl VerifiedCurrentTravelPolicy {
    pub(super) fn policy(&self) -> &VerifiedTravelModePolicy {
        &self.policy
    }
    pub(super) fn from_server_verification(
        policy: VerifiedTravelModePolicy,
        token: ServerVerificationToken,
    ) -> Self {
        Self {
            policy,
            verification: Some(token),
        }
    }
}

impl Runtime {
    /// Caller holds Account execution and discards every captured Session before this call:
    /// selective retirement replaces both effective and dormant documents while draining cleanup.
    pub(super) async fn apply_verified_travel_policy_fenced(
        &self,
        expected: &ReplicaSnapshot,
        verified: VerifiedCurrentTravelPolicy,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        let VerifiedCurrentTravelPolicy {
            policy,
            verification,
        } = verified;
        if verification.as_ref().is_some_and(|token| {
            token.account_id != expected.account_id || token.incarnation != expected.incarnation
        }) {
            return Err(pending_policy());
        }
        crate::platform_storage::validate_travel_hidden_vault_ids(&policy.hidden_vault_ids)?;
        let current = self.require_travel_policy_scope(expected)?;
        // An older durable duty must finish before a later policy can replace its metadata proof.
        if self.has_vault_retirement_work(&current) {
            let promote_known_stage_first = policy.enabled
                && !self.travel_policy_verification_pending(&current)
                && current
                    .bootstrap
                    .staging_generation
                    .as_ref()
                    .is_some_and(|stage_id| {
                        current
                            .bootstrap
                            .generations
                            .get(stage_id)
                            .is_some_and(|stage| stage.final_page_staged)
                            && policy.hidden_vault_ids.iter().all(|vault| {
                                current.bootstrap.vaults.keys().any(|(_, id)| id == vault)
                                    && !self.foreground_attachments.is_vault_fenced(
                                        &current.account_id,
                                        &current.incarnation,
                                        vault,
                                    )
                            })
                            && policy.hidden_vault_ids.iter().any(|vault| {
                                current
                                    .bootstrap
                                    .vaults
                                    .contains_key(&(stage_id.clone(), vault.clone()))
                            })
                    });
            let mut publication_tokens = Vec::new();
            if promote_known_stage_first {
                let stage = current
                    .bootstrap
                    .staging_generation
                    .as_ref()
                    .expect("eligible complete stage");
                let retirements = self.begin_native_travel_stage_retirement_publication(
                    &current,
                    stage,
                    Arc::new(policy.clone()),
                )?;
                for (_, token) in retirements {
                    if let Some(token) = token {
                        publication_tokens.push(token);
                    }
                }
            }
            if policy.enabled
                && !promote_known_stage_first
                && (!current.bootstrap.pending_vault_retirements.is_empty()
                    || self
                        .foreground_attachments
                        .has_pending_vault_retirement(&current.account_id, &current.incarnation))
            {
                // Selected cleanup may await host disposal.
                // Retain new restrictive evidence before that await, without replacing any
                // older overlapping proof. The existing resume owner adopts and drains it.
                // A pending post-watermark verification cannot promote its stage, so normal
                // first-hide application still journals and clears admission before cleanup.
                let mut additional = policy
                    .hidden_vault_ids
                    .iter()
                    .filter(|id| {
                        !current.bootstrap.pending_vault_retirements.contains(id)
                            && !self.foreground_attachments.is_vault_fenced(
                                &current.account_id,
                                &current.incarnation,
                                id,
                            )
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                additional.sort();
                if !additional.is_empty() {
                    let (retirement, token) = self.begin_native_travel_retirement_publication(
                        &current,
                        &additional,
                        Arc::new(policy.clone()),
                    )?;
                    if let Some(token) = token {
                        publication_tokens.push(token);
                    }
                    // Resume may upgrade or complete this proof. Do not retain a stale handle
                    // and attempt to adopt its old proof again after that owner returns.
                    drop(retirement);
                }
            }
            for token in publication_tokens {
                token.wait_for_other_threads();
            }
            if promote_known_stage_first {
                // Every selected ID is known in these authority generations. This exact
                // stage proves absence for omitted IDs, while a newly fenced present ID owns
                // the full policy. Promote before standalone purge can abandon that older
                // proof, including when the policy also selects its omitted Vault.
                self.promote_bootstrap_with_retirement(&current.account_id)
                    .await?;
            }
            self.resume_vault_retirements(&current).await?;
        }
        let current = self.require_travel_policy_scope(expected)?;
        let mut hidden = if policy.enabled {
            policy.hidden_vault_ids.clone()
        } else {
            Vec::new()
        };
        hidden.sort();
        hidden.dedup();
        // A completed exclusion lifetime stays fenced until actual fresh authority readmission.
        // Re-verification alone must not restart its cleanup or abandon an already filtered stage.
        // Still retire authority found in any generation, including a stage filtered by older policy.
        hidden.retain(|id| {
            !self.foreground_attachments.is_vault_fenced(
                &current.account_id,
                &current.incarnation,
                id,
            ) || current
                .bootstrap
                .vaults
                .keys()
                .any(|(_, vault)| vault == id)
                || current
                    .bootstrap
                    .items
                    .values()
                    .any(|item| &item.vault_id == id)
                || current.items.iter().any(|item| &item.vault_id == id)
        });
        let mut retirement = if hidden.is_empty() {
            None
        } else {
            let (retirement, token) = self.begin_native_travel_retirement_publication(
                &current,
                &hidden,
                Arc::new(policy.clone()),
            )?;
            if let Some(token) = token {
                token.wait_for_other_threads();
            }
            Some(retirement)
        };
        let mut metadata = self
            .platform_storage
            .load_account_metadata(&current.account_id, &current.incarnation)
            .await?
            .ok_or_else(pending_policy)?;
        let current = self.require_travel_policy_scope(expected)?;
        let mut previous_hidden = metadata
            .verified_travel_mode
            .as_ref()
            .filter(|policy| policy.enabled)
            .map(|policy| policy.hidden_vault_ids.clone())
            .unwrap_or_default();
        let mut next_hidden = if policy.enabled {
            policy.hidden_vault_ids.clone()
        } else {
            Vec::new()
        };
        previous_hidden.sort();
        next_hidden.sort();
        let selection_changed = previous_hidden != next_hidden;
        let expands_visibility = previous_hidden.iter().any(|id| !next_hidden.contains(id));
        let needs_fresh_authority = expands_visibility
            || (selection_changed && current.bootstrap.staging_generation.is_some());
        if selection_changed {
            if let Some(stage) = current.bootstrap.staging_generation.clone() {
                // A stage filtered under older policy is not proof of the new visible set.
                // Invalidate it durably before replacing policy metadata or clearing pending,
                // including expansion where no selective purge would abandon the stage for us.
                if !matches!(
                    self.replica
                        .abandon_bootstrap(AbandonBootstrapPlan {
                            guard: guard(&current),
                            generation_id: stage,
                        })
                        .await?,
                    PlanResult::Applied { .. }
                ) {
                    return Err(pending_policy());
                }
            }
        }
        let current = self.require_travel_policy_scope(expected)?;
        if needs_fresh_authority && current.bootstrap.state == ReplicaState::Ready {
            // Persist readmission's ordinary hydration duty before newer metadata can survive a
            // crash. Disabled policy alone never restores the previously erased authority.
            if !matches!(
                self.replica
                    .mark_refresh_required(MarkRefreshRequiredPlan {
                        guard: guard(&current),
                    })
                    .await?,
                PlanResult::Applied { .. }
            ) {
                return Err(pending_policy());
            }
        }
        if let Some(retirement) = retirement.as_ref() {
            self.foreground_attachments
                .require_current_vault_retirement(retirement)?;
        }
        metadata.verified_travel_mode = Some(policy.clone());
        self.platform_storage
            .store_account_metadata(&metadata)
            .await?;
        let current = self.require_travel_policy_scope(expected)?;
        if let Some(retirement) = retirement.as_mut() {
            self.adopt_vault_retirement_journal(&current, retirement)
                .await?;
        }
        // The verified selective fences/journal own cleanup. Resolve only the exact captured
        // Server reason; a newer Server episode keeps admission paused.
        {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            let current = self.require_travel_policy_scope(expected)?;
            // Metadata and any selected journal are durable. Preserve their display even if
            // the following admission-marker acknowledgement is lost; display grants no access.
            self.update_travel_policy_presentation(&current, &policy);
            self.device_revision.fetch_add(1, Ordering::SeqCst);
            if let Some(token) = verification.as_ref() {
                self.foreground_attachments
                    .resolve_server_policy_verification(token);
            }
        }
        self.publish_all_unless_closed();
        self.persist_travel_policy_pending_fenced(expected).await?;
        if let Some(retirement) = retirement.as_ref() {
            self.finish_vault_retirement(retirement).await?;
        }
        self.require_travel_policy_scope(expected)
    }

    /// Local verified policy and the existing connected-native grant jointly exclude authority.
    /// Server Bootstrap may return complete membership; its raw fingerprint remains unchanged.
    pub(super) async fn verified_hidden_vault_ids(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<Vec<String>, RuntimeError> {
        let metadata = self
            .platform_storage
            .load_account_metadata(&expected.account_id, &expected.incarnation)
            .await?
            .ok_or_else(pending_policy)?;
        self.require_travel_policy_scope(expected)?;
        let mut hidden = metadata
            .verified_travel_mode
            .filter(|policy| policy.enabled)
            .map(|policy| policy.hidden_vault_ids)
            .unwrap_or_default();
        hidden.extend(self.native_excluded_vault_ids(expected)?);
        hidden.sort();
        hidden.dedup();
        Ok(hidden)
    }

    pub(super) fn travel_policy_verification_pending(&self, snapshot: &ReplicaSnapshot) -> bool {
        snapshot.bootstrap.policy_verification_pending
            || self
                .foreground_attachments
                .policy_verification_pending(&snapshot.account_id, &snapshot.incarnation)
    }

    /// A Server read is due only for an attributed Server episode or unattributed restart duty.
    pub(super) fn travel_policy_server_verification_due(&self, snapshot: &ReplicaSnapshot) -> bool {
        self.foreground_attachments
            .capture_server_policy_verification(&snapshot.account_id, &snapshot.incarnation)
            .is_some()
            || (snapshot.bootstrap.policy_verification_pending
                && !self
                    .foreground_attachments
                    .has_policy_verification_entry(&snapshot.account_id, &snapshot.incarnation))
    }

    pub(super) fn travel_policy_sync_work_due(&self, snapshot: &ReplicaSnapshot) -> bool {
        self.travel_policy_server_verification_due(snapshot)
            || snapshot.bootstrap.policy_verification_pending
                != self
                    .foreground_attachments
                    .policy_verification_pending(&snapshot.account_id, &snapshot.incarnation)
    }

    /// Caller owns Account execution. Preserve the live reason through ambiguous storage ACKs;
    /// retry derives its aggregate from this same entry instead of manufacturing a new episode.
    pub(super) async fn persist_travel_policy_pending_fenced(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        let was_pending = {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            let current = self.require_travel_policy_scope(expected)?;
            self.travel_policy_verification_pending(&current)
        };
        let loaded = self
            .replica
            .load_uncached(&expected.account_id)
            .await?
            .ok_or_else(pending_policy)?;
        {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            let current = self.require_travel_policy_scope(expected)?;
            if loaded.account_id != current.account_id
                || loaded.incarnation != current.incarnation
                || loaded.user_id != current.user_id
                || loaded.lock_epoch != current.lock_epoch
                || loaded.revision < current.revision
            {
                return Err(pending_policy());
            }
            // A committed marker can outlive its lost ACK. Reload that exact current head
            // before deriving the next guard; never roll back another lifetime or revision.
            self.replica.cache(loaded);
        }
        loop {
            let (current, pending) = {
                let _publication = self.publication.lock().expect("publication lock poisoned");
                let current = self.require_travel_policy_scope(expected)?;
                if current.bootstrap.policy_verification_pending {
                    self.foreground_attachments
                        .restore_policy_verification_pending(
                            &current.account_id,
                            &current.incarnation,
                        )?;
                }
                let pending = self
                    .foreground_attachments
                    .policy_verification_pending(&current.account_id, &current.incarnation);
                // Keep queued/new delivery paused until an acknowledged false matches every reason.
                self.pause_travel_plaintext_delivery(
                    &current.account_id,
                    pending || current.bootstrap.policy_verification_pending,
                );
                (current, pending)
            };
            if !matches!(
                self.replica
                    .set_policy_verification_pending(guard(&current), pending)
                    .await?,
                PlanResult::Applied { .. }
            ) {
                return Err(pending_policy());
            }
            let complete = {
                let _publication = self.publication.lock().expect("publication lock poisoned");
                let current = self.require_travel_policy_scope(expected)?;
                let aggregate = self
                    .foreground_attachments
                    .policy_verification_pending(&current.account_id, &current.incarnation);
                if current.bootstrap.policy_verification_pending == aggregate {
                    self.pause_travel_plaintext_delivery(&current.account_id, aggregate);
                    let restored_admission = was_pending && !aggregate;
                    if restored_admission {
                        self.device_revision.fetch_add(1, Ordering::SeqCst);
                    }
                    Some((current, restored_admission))
                } else {
                    // A successor reason may arrive while the guarded physical write awaits.
                    // Its admission fence remains live and the same owner persists that aggregate.
                    self.pause_travel_plaintext_delivery(&current.account_id, true);
                    None
                }
            };
            if let Some((current, restored_admission)) = complete {
                if restored_admission {
                    self.publish_all_unless_closed();
                }
                return Ok(current);
            }
        }
    }

    /// Caller holds Account execution. Only admission closes; established loans remain live.
    pub(super) async fn begin_travel_policy_refresh_fenced(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        self.begin_travel_server_verification_fenced(expected, false)
            .await?;
        self.require_travel_policy_scope(expected)
    }

    /// The prepared mutation is never polled until this exact Server episode is durable.
    pub(super) async fn begin_travel_mutation_verification_fenced(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<ServerVerificationToken, RuntimeError> {
        self.begin_travel_policy_invalidation_fenced(expected).await
    }

    pub(super) async fn begin_travel_policy_invalidation_fenced(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<ServerVerificationToken, RuntimeError> {
        self.begin_travel_server_verification_fenced(expected, true)
            .await
    }

    async fn begin_travel_server_verification_fenced(
        &self,
        expected: &ReplicaSnapshot,
        invalidate: bool,
    ) -> Result<ServerVerificationToken, RuntimeError> {
        let token = {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            self.require_travel_policy_scope(expected)?;
            let token = if invalidate {
                self.foreground_attachments
                    .invalidate_server_policy_verification(
                        &expected.account_id,
                        &expected.incarnation,
                    )?
            } else {
                self.foreground_attachments
                    .ensure_server_policy_verification(
                        &expected.account_id,
                        &expected.incarnation,
                    )?
            };
            self.pause_travel_plaintext_delivery(&expected.account_id, true);
            self.device_revision.fetch_add(1, Ordering::SeqCst);
            token
        };
        // Wake the existing Sync owner before awaiting marker I/O: a dropped caller or lost ACK
        // cannot lose the live verification duty. Sync takes this same Account execution next.
        self.live_sync_wake.notify_waiters();
        self.publish_all_unless_closed();
        self.persist_travel_policy_pending_fenced(expected).await?;
        Ok(token)
    }

    /// This exemption authorizes only the already prepared request's own acknowledged episode.
    /// It grants no fresh plaintext/read authority and cannot ignore a successor episode.
    pub(super) fn require_travel_mutation_dispatch_scope(
        &self,
        expected: &ReplicaSnapshot,
        token: &ServerVerificationToken,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        let _publication = self.publication.lock().expect("publication lock poisoned");
        let current = self.require_travel_policy_scope(expected)?;
        if token.account_id != current.account_id
            || token.incarnation != current.incarnation
            || !current.bootstrap.policy_verification_pending
            || !self.generation_has_current_unlocked_authority(&current)
            || !self
                .foreground_attachments
                .is_only_server_policy_verification(token)
        {
            return Err(pending_policy());
        }
        Ok(current)
    }

    pub(super) fn require_travel_policy_scope(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        self.ensure_not_closed()?;
        let current = self.require_snapshot(&expected.account_id)?;
        if current.incarnation != expected.incarnation
            || current.user_id != expected.user_id
            || current.lock_epoch != expected.lock_epoch
            || self.account_teardown_is_pending(&expected.account_id)
        {
            return Err(pending_policy());
        }
        Ok(current)
    }

    pub(super) async fn read_current_travel_policy_fenced(
        &self,
        expected: &ReplicaSnapshot,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        cancellation: RequestCancellation,
        renewal: Option<&mut OutcomeResolutionAuthBudget>,
    ) -> Result<VerifiedCurrentTravelPolicy, RuntimeError> {
        let verification = {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            let current = self.require_travel_policy_scope(expected)?;
            if current.bootstrap.policy_verification_pending {
                self.foreground_attachments
                    .restore_policy_verification_pending(
                        &current.account_id,
                        &current.incarnation,
                    )?;
            }
            self.foreground_attachments
                .capture_server_policy_verification(&current.account_id, &current.incarnation)
        };
        self.read_current_travel_policy_with_capture_fenced(
            expected,
            http,
            session,
            cancellation,
            renewal,
            verification,
        )
        .await
    }

    pub(super) async fn read_current_travel_policy_for_episode_fenced(
        &self,
        expected: &ReplicaSnapshot,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        cancellation: RequestCancellation,
        renewal: Option<&mut OutcomeResolutionAuthBudget>,
        verification: ServerVerificationToken,
    ) -> Result<VerifiedCurrentTravelPolicy, RuntimeError> {
        if verification.account_id != expected.account_id
            || verification.incarnation != expected.incarnation
        {
            return Err(pending_policy());
        }
        self.read_current_travel_policy_with_capture_fenced(
            expected,
            http,
            session,
            cancellation,
            renewal,
            Some(verification),
        )
        .await
    }

    /// Caller holds Account execution. None preserves retained-Session local/native ceremonies.
    /// A known invalidation never receives cached-policy fallback from this fresh read.
    async fn read_current_travel_policy_with_capture_fenced(
        &self,
        expected: &ReplicaSnapshot,
        http: &AuthHttpClient<'_>,
        session: &mut CurrentSessionDocument,
        cancellation: RequestCancellation,
        mut renewal: Option<&mut OutcomeResolutionAuthBudget>,
        verification: Option<ServerVerificationToken>,
    ) -> Result<VerifiedCurrentTravelPolicy, RuntimeError> {
        self.require_travel_policy_scope(expected)?;
        let attempt = RequestCancellation::new();
        let exchange = async {
            loop {
                let reply = http.get_travel_mode(&session.token, attempt.clone()).await;
                self.require_travel_policy_scope(expected)?;
                match reply {
                    Ok(response) => {
                        return crate::authentication_installation::prepare_verified_travel_policy(
                            &response,
                            self.clock.now_ms()?,
                        );
                    }
                    Err(error)
                        if error.code == RuntimeErrorCode::AuthenticationRequired
                            && renewal
                                .as_deref_mut()
                                .is_some_and(|budget| budget.consume_renewal()) =>
                    {
                        *session = self
                            .renew_session(&expected.account_id, session, http, attempt.clone())
                            .await?;
                    }
                    Err(error) => return Err(error),
                }
            }
        };
        let result = tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled, "Travel policy verification cancelled")),
            result = exchange => result,
            () = self.device_timer.sleep_ms(POLICY_READ_TIMEOUT_MS) => Err(RuntimeError::new(
                RuntimeErrorCode::RetryableTransport, "Travel policy verification timed out")),
        };
        attempt.cancel();
        result.map(|policy| VerifiedCurrentTravelPolicy {
            policy,
            verification,
        })
    }
}
