//! Nonsecret restoration uses the existing native challenge and ordinary fresh Bootstrap authority.
use super::*;
use crate::replica::{BootstrapGuard, MarkRefreshRequiredPlan, PlanResult};

type RequestedExclusions<'a> = (&'a [String], (u64, [u8; 32]));

pub(super) fn require_transfer(challenge: &NativeImportChallenge) -> Result<(), RuntimeError> {
    if matches!(challenge.purpose, NativeChallengePurpose::Transfer) {
        Ok(())
    } else {
        Err(native_retired())
    }
}

fn requested(challenge: &NativeImportChallenge) -> Result<RequestedExclusions<'_>, RuntimeError> {
    let NativeChallengePurpose::RevalidateIndependentRestrictions {
        restriction_frontier,
        restriction_chain_digest,
        excluded_vault_ids,
    } = &challenge.purpose
    else {
        return Err(native_retired());
    };
    if challenge.new_destination
        || excluded_vault_ids.is_empty()
        || excluded_vault_ids.len() > 1_600
        || excluded_vault_ids.windows(2).any(|pair| pair[0] >= pair[1])
        || excluded_vault_ids
            .iter()
            .any(|id| id.is_empty() || id.len() > 1024)
        // The native source carries an opaque JSON string: count the second escaping and
        // reserve the existing envelope plus maximum 128-byte ASCII request ID.
        || serde_json::to_vec(&serde_json::to_string(challenge).map_err(|_| native_retired())?)
            .map_err(|_| native_retired())?.len() + 512 > 64 * 1024
    {
        return Err(native_retired());
    }
    Ok((
        excluded_vault_ids,
        (*restriction_frontier, *restriction_chain_digest),
    ))
}

impl NativeAuthorityFacade {
    pub async fn prepare_independent_revalidation(
        &self,
        channel: &str,
        source_account: &AccountId,
    ) -> Result<NativeImportChallenge, RuntimeError> {
        let destination = {
            let state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let Some(Channel::Desktop {
                source,
                restrictions,
                ..
            }) = state.channels.get(channel)
            else {
                return Err(native_retired());
            };
            let source_account = source
                .accounts
                .iter()
                .find(|account| &account.scope.account_id == source_account)
                .ok_or_else(native_retired)?;
            restrictions
                .independent_revalidation_target(&source_account.scope)
                .cloned()
                .ok_or_else(native_retired)?
        };
        let lock = self
            .runtime
            .account_execution_lock(&destination.account_id)?;
        let _execution = lock.lock().await;
        let current = self.runtime.native_account_scope(&destination.account_id)?;
        if current.incarnation != destination.incarnation || !same_identity(&current, &destination)
        {
            return Err(native_retired());
        }
        self.runtime.require_native_scope(&current, true)?;
        let session = self
            .runtime
            .effective_session(&current.account_id, &current.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        if !matches!(session.provenance, SessionProvenance::Independent) {
            return Err(native_retired());
        }
        require_usable_session(&session, self.runtime.clock.now_ms()?)?;
        let mut state = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let _publication = self
            .runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        self.runtime.require_native_scope(&current, true)?;
        if state.grants.contains_key(&current.account_id) {
            return Err(native_retired());
        }
        let Some(Channel::Desktop {
            source,
            transport_id,
            restrictions,
        }) = state.channels.get(channel)
        else {
            return Err(native_retired());
        };
        let authority = source
            .accounts
            .iter()
            .find(|account| &account.scope.account_id == source_account)
            .ok_or_else(native_retired)?;
        let (_, exclusions) = restrictions
            .independent_exclusions
            .get(&current.account_id)
            .filter(|(incarnation, _)| incarnation == &current.incarnation)
            .ok_or_else(native_retired)?;
        let mut ids: Vec<_> = exclusions.iter().cloned().collect();
        ids.sort();
        let challenge = NativeImportChallenge {
            purpose: NativeChallengePurpose::RevalidateIndependentRestrictions {
                restriction_frontier: source.restriction_frontier,
                restriction_chain_digest: source.restriction_chain_digest,
                excluded_vault_ids: ids,
            },
            version: 1,
            challenge_id: bittery_crypto_core::generate_uuid(),
            extension_id: source.extension_id.clone(),
            source_owner: source.owner_id.clone(),
            source_channel: source.channel_id.clone(),
            source_transport: source.transport_id.clone(),
            destination_owner: self.runtime.native_authority.owner.clone(),
            destination_channel: channel.into(),
            destination_transport: transport_id.clone(),
            source: authority.scope.clone(),
            source_key_generation: authority.key_generation,
            destination: current,
            new_destination: false,
            destination_insecure_transport_confirmed: false,
        };
        self.require_independent_destination_in(&state, &challenge)?;
        // Replace only this Account's previous challenge in the existing bounded owner.
        state
            .challenges
            .retain(|_, old| old.destination.account_id != challenge.destination.account_id);
        for ceremony in state.ceremonies.values() {
            if ceremony.direction == NativeCeremonyDirection::Destination
                && ceremony.scope().account_id == challenge.destination.account_id
            {
                ceremony.cancellation.cancel();
            }
        }
        state
            .challenges
            .insert(challenge.challenge_id.clone(), challenge.clone());
        Ok(challenge)
    }

    fn require_independent_source_in(
        &self,
        state: &AuthorityState,
        challenge: &NativeImportChallenge,
    ) -> Result<(), RuntimeError> {
        let (_, frontier) = requested(challenge)?;
        self.runtime.require_native_scope(&challenge.source, true)?;
        self.require_source_channel_in(state, challenge)?;
        let Some(Channel::Source { restrictions, .. }) =
            state.channels.get(&challenge.source_channel)
        else {
            return Err(native_retired());
        };
        if restrictions.last_frontier() != frontier {
            return Err(native_retired());
        }
        Ok(())
    }

    fn require_independent_destination_in(
        &self,
        state: &AuthorityState,
        challenge: &NativeImportChallenge,
    ) -> Result<(), RuntimeError> {
        let (requested, frontier) = requested(challenge)?;
        if challenge.destination_owner != self.runtime.native_authority.owner
            || state.grants.contains_key(&challenge.destination.account_id)
        {
            return Err(native_retired());
        }
        self.runtime
            .require_native_scope(&challenge.destination, true)?;
        require_destination_channel(state, challenge)?;
        let Some(Channel::Desktop {
            source,
            restrictions,
            ..
        }) = state.channels.get(&challenge.destination_channel)
        else {
            return Err(native_retired());
        };
        if (source.restriction_frontier, source.restriction_chain_digest) != frontier
            || !restrictions.has_adopted_frontier(frontier)
            || restrictions
                .independent_revalidation_target(&challenge.source)
                .is_none_or(|target| {
                    target.account_id != challenge.destination.account_id
                        || target.incarnation != challenge.destination.incarnation
                })
            || !restrictions
                .independent_exclusions
                .get(&challenge.destination.account_id)
                .is_some_and(|(incarnation, ids)| {
                    incarnation == &challenge.destination.incarnation
                        && requested.iter().all(|id| ids.contains(id))
                })
        {
            return Err(native_retired());
        }
        Ok(())
    }

    async fn fresh_independent_visibility(
        &self,
        scope: &NativeAccountScope,
        requested: &[String],
        cancellation: RequestCancellation,
    ) -> Result<(Vec<String>, CurrentSessionDocument), RuntimeError> {
        self.runtime.require_native_scope(scope, true)?;
        let session = self
            .runtime
            .effective_session(&scope.account_id, &scope.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        if !matches!(session.provenance, SessionProvenance::Independent) {
            return Err(native_retired());
        }
        require_usable_session(&session, self.runtime.clock.now_ms()?)?;
        let metadata = self
            .runtime
            .platform_storage
            .load_account_metadata(&scope.account_id, &scope.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        let http = AuthHttpClient::new(
            &self.runtime.http_transport,
            &metadata.normalized_server_url,
            metadata.insecure_transport_confirmed,
            self.runtime
                .auth_client_config
                .clone()
                .ok_or_else(native_retired)?,
        )?;
        let key = super::super::vault_key::VaultKeyMaterial {
            master_unlock_key: self
                .runtime
                .copy_live_master_unlock_key(&scope.account_id, &scope.incarnation)
                .ok_or_else(native_retired)?,
            encrypted_private_key: Some(session.encrypted_private_key.clone()),
        };
        let mut visible = super::super::bootstrap::fresh_readable_vault_ids(
            &http,
            &session,
            &scope.user_id,
            &key,
            requested,
            cancellation.clone(),
        )
        .await?;
        // Verify policy after the captured membership watermark, as ordinary Bootstrap does.
        let (policy, fresh) = self
            .runtime
            .verify_local_travel_policy(&metadata, &session, cancellation.clone())
            .await
            .map_err(|failure| match failure {
                super::super::local_access::LocalTravelFailure::Runtime(error) => error,
                _ => native_retired(),
            })?;
        if !fresh || cancellation.is_cancelled() {
            return Err(native_retired());
        }
        visible.retain(|id| !policy.enabled || !policy.hidden_vault_ids.contains(id));
        self.runtime.require_native_scope(scope, true)?;
        let stored = self
            .runtime
            .effective_session(&scope.account_id, &scope.incarnation)
            .await?
            .ok_or_else(native_retired)?;
        if stored != session {
            return Err(native_retired());
        }
        require_usable_session(&session, self.runtime.clock.now_ms()?)?;
        Ok((visible, session))
    }

    pub async fn revalidate_independent_restrictions(
        &self,
        challenge: NativeImportChallenge,
    ) -> Result<NativeIndependentRevalidationReply, RuntimeError> {
        requested(&challenge)?;
        let cancellation = RequestCancellation::new();
        {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            self.require_independent_source_in(&state, &challenge)?;
            if state.ceremonies.contains_key(&challenge.challenge_id) {
                return Err(native_retired());
            }
            state.ceremonies.insert(
                challenge.challenge_id.clone(),
                PendingNativeCeremony {
                    challenge: challenge.clone(),
                    direction: NativeCeremonyDirection::Source,
                    cancellation: cancellation.clone(),
                },
            );
        }
        let _ceremony = NativeCeremonyLease {
            owner: &self.runtime.native_authority,
            id: challenge.challenge_id.clone(),
        };
        let lock = self
            .runtime
            .account_execution_lock(&challenge.source.account_id)?;
        let _execution = tokio::select! { _ = cancellation.cancelled() => return Err(native_retired()), guard = lock.lock() => guard };
        let (ids, session) = tokio::select! {
            _ = cancellation.cancelled() => return Err(native_retired()),
            result = self.fresh_independent_visibility(&challenge.source, requested(&challenge)?.0, cancellation.clone()) => result?,
        };
        let reply = NativeIndependentRevalidationReply {
            challenge,
            source_session_expires_at_ms: session
                .server_expires_at_ms
                .unwrap_or(session.expires_at_ms),
            visible_vault_ids: ids,
        };
        self.deliver_independent_revalidation_reply(&reply, || ())?;
        Ok(reply)
    }

    pub(super) fn deliver_independent_revalidation_reply<T>(
        &self,
        reply: &NativeIndependentRevalidationReply,
        deliver: impl FnOnce() -> T,
    ) -> Result<T, RuntimeError> {
        let state = self
            .runtime
            .native_authority
            .state
            .lock()
            .expect("native authority lock poisoned");
        let _publication = self
            .runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        self.require_independent_source_in(&state, &reply.challenge)?;
        if self.runtime.clock.now_ms()? >= reply.source_session_expires_at_ms {
            return Err(native_retired());
        }
        let (ids, _) = requested(&reply.challenge)?;
        if reply
            .visible_vault_ids
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
            || reply.visible_vault_ids.iter().any(|id| !ids.contains(id))
        {
            return Err(native_retired());
        }
        Ok(deliver())
    }

    pub async fn complete_independent_revalidation(
        &self,
        reply: NativeIndependentRevalidationReply,
    ) -> Result<(), RuntimeError> {
        let _admission = self.runtime.teardown_admission.read().await;
        let challenge = &reply.challenge;
        if self.runtime.clock.now_ms()? >= reply.source_session_expires_at_ms {
            return Err(native_retired());
        }
        let (ids, _) = requested(challenge)?;
        if reply
            .visible_vault_ids
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
            || reply.visible_vault_ids.iter().any(|id| !ids.contains(id))
        {
            return Err(native_retired());
        }
        let cancellation = RequestCancellation::new();
        {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let pending = state
                .challenges
                .remove(&challenge.challenge_id)
                .ok_or_else(native_retired)?;
            if pending != *challenge {
                return Err(native_retired());
            }
            self.require_independent_destination_in(&state, challenge)?;
            state.ceremonies.insert(
                challenge.challenge_id.clone(),
                PendingNativeCeremony {
                    challenge: challenge.clone(),
                    direction: NativeCeremonyDirection::Destination,
                    cancellation: cancellation.clone(),
                },
            );
        }
        let _ceremony = NativeCeremonyLease {
            owner: &self.runtime.native_authority,
            id: challenge.challenge_id.clone(),
        };
        let lock = self
            .runtime
            .account_execution_lock(&challenge.destination.account_id)?;
        let _execution = tokio::select! { _ = cancellation.cancelled() => return Err(native_retired()), guard = lock.lock() => guard };
        let (mut visible, session) = tokio::select! {
            _ = cancellation.cancelled() => return Err(native_retired()),
            result = self.fresh_independent_visibility(&challenge.destination, ids, cancellation.clone()) => result?,
        };
        visible.retain(|id| reply.visible_vault_ids.contains(id));
        if !visible.is_empty() {
            let current = self
                .runtime
                .require_native_scope(&challenge.destination, true)?;
            if !matches!(
                self.runtime
                    .replica
                    .mark_refresh_required(MarkRefreshRequiredPlan {
                        guard: BootstrapGuard {
                            account_id: current.account_id,
                            user_id: current.user_id,
                            incarnation: current.incarnation,
                            expected_replica_revision: current.revision,
                            expected_lock_epoch: current.lock_epoch
                        },
                    })
                    .await?,
                PlanResult::Applied { .. }
            ) {
                return Err(native_retired());
            }
        }
        {
            let mut state = self
                .runtime
                .native_authority
                .state
                .lock()
                .expect("native authority lock poisoned");
            let _publication = self
                .runtime
                .publication
                .lock()
                .expect("publication lock poisoned");
            if cancellation.is_cancelled()
                || self.runtime.clock.now_ms()? >= reply.source_session_expires_at_ms
            {
                return Err(native_retired());
            }
            require_usable_session(&session, self.runtime.clock.now_ms()?)?;
            self.require_independent_destination_in(&state, challenge)?;
            let Some(Channel::Desktop { restrictions, .. }) =
                state.channels.get_mut(&challenge.destination_channel)
            else {
                return Err(native_retired());
            };
            let (_, excluded) = restrictions
                .independent_exclusions
                .get_mut(&challenge.destination.account_id)
                .ok_or_else(native_retired)?;
            excluded.retain(|id| !visible.contains(id));
        }
        self.runtime.live_sync_wake.notify_waiters();
        self.runtime.publish_all_unless_closed();
        Ok(())
    }
}
