//! Complete verified authority retires access before durable purge, then drains the same capabilities.
use super::{
    foreground_attachment_lifecycle::{
        VaultForegroundRetirement, VaultRetirementBatch, VaultRetirementProof,
    },
    *,
};
use crate::platform_storage::SessionProvenance;
use crate::replica::{
    BootstrapGenerationId, BootstrapGuard, PlanMutation, PlanResult, PromoteBootstrapPlan,
    ReplicaSnapshot,
};

fn interrupted() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "Vault retirement scope changed",
    )
}

struct CompleteBootstrapRetirement {
    generation_id: BootstrapGenerationId,
    additional: Vec<String>,
    retired: Vec<String>,
}

impl Runtime {
    /// Caller holds Account execution. Adopt the captured selective duty before cleanup, including
    /// a physical commit whose acknowledgement was lost. Native evidence never rewrites policy.
    pub(super) async fn adopt_vault_retirement_journal(
        &self,
        expected: &ReplicaSnapshot,
        retirement: &mut VaultForegroundRetirement,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        if retirement.batch.account_id != expected.account_id
            || retirement.batch.incarnation != expected.incarnation
        {
            return Err(interrupted());
        }
        self.require_retirement_incarnation(expected)?;
        self.foreground_attachments
            .require_current_vault_retirement(retirement)?;
        let loaded = self
            .replica
            .load_uncached(&expected.account_id)
            .await?
            .ok_or_else(interrupted)?;
        {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            let current = self.require_retirement_incarnation(expected)?;
            if loaded.incarnation != current.incarnation
                || loaded.user_id != current.user_id
                || loaded.revision < current.revision
            {
                return Err(interrupted());
            }
            self.replica.cache(loaded);
        }
        let mut current = self.require_retirement_incarnation(expected)?;
        let journaled = retirement
            .batch
            .vault_ids
            .iter()
            .all(|id| current.bootstrap.pending_vault_retirements.contains(id));
        let proof = retirement.batch.proof.clone();
        self.foreground_attachments
            .require_current_vault_retirement(retirement)?;
        if !journaled {
            match &proof {
                VaultRetirementProof::VerifiedTravelPolicy { policy } => {
                    let mut metadata = self
                        .platform_storage
                        .load_account_metadata(&current.account_id, &current.incarnation)
                        .await?
                        .ok_or_else(interrupted)?;
                    self.require_retirement_incarnation(expected)?;
                    self.foreground_attachments
                        .require_current_vault_retirement(retirement)?;
                    if metadata.verified_travel_mode.as_ref() != Some(policy.as_ref()) {
                        metadata.verified_travel_mode = Some(policy.as_ref().clone());
                        self.platform_storage
                            .store_account_metadata(&metadata)
                            .await?;
                    }
                }
                VaultRetirementProof::VerifiedNativeRestriction { .. } => {}
                // A Bootstrap/journal proof cannot manufacture a fresh duty after its old rows
                // have been cleaned. Its caller must supply the observed current journal.
                VaultRetirementProof::CompleteBootstrap(_)
                | VaultRetirementProof::DurableJournal { .. } => return Err(interrupted()),
            }
            current = self.require_retirement_incarnation(expected)?;
            self.foreground_attachments
                .require_current_vault_retirement(retirement)?;
            let result = self
                .replica
                .execute_exact(GuardedCommitPlan::new(
                    current.account_id.clone(),
                    current.incarnation.clone(),
                    current.revision,
                    current.lock_epoch,
                    vec![PlanMutation::RetireVaults {
                        vault_ids: retirement.batch.vault_ids.clone(),
                    }],
                ))
                .await?;
            if !matches!(result, PlanResult::Applied { .. }) {
                return Err(interrupted());
            }
            current = self.require_retirement_incarnation(expected)?;
        }
        self.foreground_attachments
            .record_vault_retirement_journal(retirement, current.revision)?;
        if let VaultRetirementProof::VerifiedNativeRestriction { batch } = &proof {
            self.native_restriction_journal_adopted(
                &current.account_id,
                &current.incarnation,
                batch,
            );
        }
        // `proof` drops here, before any caller awaits physical/Session cleanup.
        Ok(current)
    }

    pub(super) fn has_vault_retirement_work(&self, snapshot: &ReplicaSnapshot) -> bool {
        !self.vault_readmission_batches(snapshot).is_empty()
            || !snapshot.bootstrap.pending_vault_retirements.is_empty()
            || snapshot
                .bootstrap
                .staging_generation
                .as_ref()
                .is_some_and(|id| {
                    snapshot
                        .bootstrap
                        .generations
                        .get(id)
                        .is_some_and(|stage| stage.final_page_staged)
                })
            || self
                .foreground_attachments
                .has_pending_vault_retirement(&snapshot.account_id, &snapshot.incarnation)
    }

    fn vault_readmission_batches(&self, snapshot: &ReplicaSnapshot) -> Vec<VaultRetirementBatch> {
        let visible: Vec<_> = snapshot
            .bootstrap
            .vaults
            .keys()
            .filter(|(generation, _)| {
                snapshot.bootstrap.active_generation.as_ref() == Some(generation)
            })
            .map(|(_, id)| id.clone())
            .collect();
        self.foreground_attachments.pending_vault_readmissions(
            &snapshot.account_id,
            &snapshot.incarnation,
            &visible,
        )
    }

    pub(super) fn vault_retirement_retry_deadline(&self, snapshot: &ReplicaSnapshot) -> u64 {
        self.foreground_attachments
            .pending_vault_retirements(&snapshot.account_id, &snapshot.incarnation)
            .into_iter()
            .chain(self.vault_readmission_batches(snapshot))
            .map(|batch| batch.retry_not_before_ms)
            .max()
            .unwrap_or(0)
    }

    pub(super) fn defer_vault_retirements(&self, snapshot: &ReplicaSnapshot, deadline: u64) {
        for batch in self
            .foreground_attachments
            .pending_vault_retirements(&snapshot.account_id, &snapshot.incarnation)
        {
            if let Ok(retirement) = self.foreground_attachments.begin_vault_retirement(
                &batch.account_id,
                &batch.incarnation,
                &batch.vault_ids,
                batch.proof,
            ) {
                let _ = self
                    .foreground_attachments
                    .defer_vault_retirement(&retirement, deadline);
            }
        }
        // Host readmission can fail after physical promotion. Its old fence remains the duty.
        if let Ok(current) = self.require_retirement_incarnation(snapshot) {
            for batch in self.vault_readmission_batches(&current) {
                let _ = self
                    .foreground_attachments
                    .defer_vault_readmission(&batch, deadline);
            }
        }
    }

    async fn readmit_current_vault_authority(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<(), RuntimeError> {
        for batch in self.vault_readmission_batches(expected) {
            let current = self.require_retirement_incarnation(expected)?;
            let account = &current.account_id;
            let ids = &batch.vault_ids;
            let upload = self
                .attachment_upload
                .lock()
                .expect("Attachment Upload facade lock poisoned")
                .clone();
            let download = self
                .attachment_download
                .lock()
                .expect("Attachment Download facade lock poisoned")
                .clone();
            let image = self
                .vault_image_ingress
                .lock()
                .expect("Vault image ingress lock poisoned")
                .clone();
            let (upload, download, image) = tokio::join!(
                async {
                    match upload {
                        Some(port) => port
                            .complete_vault_retirement(account, ids)
                            .await
                            .map_err(|_| interrupted()),
                        None => Ok(()),
                    }
                },
                async {
                    match download {
                        Some(port) => port
                            .complete_vault_retirement(account, ids)
                            .await
                            .map_err(|_| interrupted()),
                        None => Ok(()),
                    }
                },
                async {
                    match image {
                        Some(port) => port.complete_vault_retirement(account, ids).await,
                        None => Ok(()),
                    }
                },
            );
            upload?;
            download?;
            image?;
            let token = {
                let _publication = self.publication.lock().expect("publication lock poisoned");
                let fresh = self.require_retirement_incarnation(&current)?;
                if fresh.revision != current.revision
                    || fresh.lock_epoch != current.lock_epoch
                    || ids
                        .iter()
                        .any(|id| fresh.bootstrap.pending_vault_retirements.contains(id))
                {
                    return Err(interrupted());
                }
                self.foreground_attachments
                    .complete_vault_readmission(&batch)?;
                self.invalidate_delivery(account)
            };
            if let Some(token) = token {
                token.wait_for_other_threads();
            }
            self.advance_native_retirement_authority(&current, ids)?;
            self.publish_all_unless_closed();
        }
        Ok(())
    }

    /// Resume local duties even while signed out. The caller holds Account execution; a physical
    /// reload distinguishes a rejected commit from a commit whose acknowledgement was lost.
    pub(super) async fn resume_vault_retirements(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<(), RuntimeError> {
        self.require_retirement_incarnation(expected)?;
        let loaded = self
            .replica
            .load_uncached(&expected.account_id)
            .await?
            .ok_or_else(interrupted)?;
        {
            let _publication = self.publication.lock().expect("publication lock poisoned");
            let current = self.require_retirement_incarnation(expected)?;
            if loaded.incarnation != current.incarnation
                || loaded.user_id != current.user_id
                || loaded.revision < current.revision
            {
                return Err(interrupted());
            }
            self.replica.cache(loaded);
        }
        let snapshot = self.require_retirement_incarnation(expected)?;
        let policy_pending = self.travel_policy_verification_pending(&snapshot);
        let pending = self
            .foreground_attachments
            .pending_vault_retirements(&snapshot.account_id, &snapshot.incarnation);
        let mut different_omitted_proof = false;
        let retirement_stage = snapshot.bootstrap.staging_generation.as_ref().filter(|stage| {
            let complete = snapshot.bootstrap.generations.get(*stage)
                .is_some_and(|generation| generation.final_page_staged);
            different_omitted_proof = complete && pending.iter().any(|batch| {
                batch.proof != VaultRetirementProof::CompleteBootstrap((*stage).clone())
                    && batch.vault_ids.iter().any(|id| {
                        !snapshot.bootstrap.vaults.contains_key(&((*stage).clone(), id.clone()))
                    })
            });
            // Public open reconstructs an uncaptured durable omission before ready. During
            // live verification, only an already captured duty selects this early path, so
            // ordinary first-hide publication still precedes its own cleanup wait.
            (!self.ready.load(Ordering::SeqCst) && policy_pending && complete)
                || different_omitted_proof
                || pending.iter().any(|batch| {
                    matches!(&batch.proof, VaultRetirementProof::CompleteBootstrap(id) if id == *stage)
                })
        });
        drop(pending);
        if let Some(stage) = retirement_stage {
            if !snapshot
                .bootstrap
                .generations
                .get(stage)
                .is_some_and(|generation| generation.final_page_staged)
            {
                return Err(interrupted());
            }
            // Preserve the older absence proof before any later policy purge can abandon it.
            // Pending policy permits retirement-only adoption, never authority/cursor promotion.
            if policy_pending || different_omitted_proof {
                self.adopt_complete_bootstrap_retirement_only(&snapshot)
                    .await?;
            } else {
                self.promote_bootstrap_with_retirement(&snapshot.account_id)
                    .await?;
            }
        }
        let snapshot = self.require_retirement_incarnation(expected)?;
        let pending = self
            .foreground_attachments
            .pending_vault_retirements(&snapshot.account_id, &snapshot.incarnation);
        for batch in pending {
            let mut snapshot = self.require_retirement_incarnation(expected)?;
            // A failed promotion still has its complete staging generation. Retry that exact
            // promotion below; Session-only IDs remain captured by its existing registry proof.
            if matches!(&batch.proof, VaultRetirementProof::CompleteBootstrap(id)
                if snapshot.bootstrap.staging_generation.as_ref() == Some(id))
            {
                continue;
            }
            let (mut retirement, token) = self.begin_vault_retirement_publication(
                &snapshot,
                &batch.vault_ids,
                batch.proof.clone(),
            )?;
            if let Some(token) = token {
                token.wait_for_other_threads();
            }
            if matches!(
                batch.proof,
                VaultRetirementProof::VerifiedTravelPolicy { .. }
                    | VaultRetirementProof::VerifiedNativeRestriction { .. }
                    | VaultRetirementProof::CompleteBootstrap(_)
            ) {
                snapshot = self
                    .adopt_vault_retirement_journal(&snapshot, &mut retirement)
                    .await?;
            }
            // The handle now owns only the durable journal. Release the loop's original proof
            // before any physical/Session cleanup can wait on another admitted capability.
            drop(batch);
            self.advance_native_retirement_authority(&snapshot, &retirement.batch.vault_ids)?;
            self.publish_all_unless_closed();
            self.finish_vault_retirement(&retirement).await?;
        }
        let snapshot = self.require_retirement_incarnation(expected)?;
        if !snapshot.bootstrap.pending_vault_retirements.is_empty() {
            let (retirement, token) = self.begin_vault_retirement_publication(
                &snapshot,
                &snapshot.bootstrap.pending_vault_retirements,
                VaultRetirementProof::DurableJournal {
                    revision: snapshot.revision,
                },
            )?;
            if let Some(token) = token {
                token.wait_for_other_threads();
            }
            self.advance_native_retirement_authority(&snapshot, &retirement.batch.vault_ids)?;
            self.publish_all_unless_closed();
            self.finish_vault_retirement(&retirement).await?;
        }
        let snapshot = self.require_retirement_incarnation(expected)?;
        if !self.travel_policy_verification_pending(&snapshot)
            && snapshot
                .bootstrap
                .staging_generation
                .as_ref()
                .is_some_and(|id| {
                    snapshot
                        .bootstrap
                        .generations
                        .get(id)
                        .is_some_and(|stage| stage.final_page_staged)
                })
        {
            self.promote_bootstrap_with_retirement(&snapshot.account_id)
                .await?;
        }
        let current = self.require_retirement_incarnation(expected)?;
        if !self.travel_policy_verification_pending(&current) {
            self.readmit_current_vault_authority(&current).await?;
        }
        Ok(())
    }

    /// Both authority promotion and retirement-only retry consume exactly this complete proof.
    /// Caller holds Account execution; no captured Session survives this selector.
    async fn complete_bootstrap_retirement(
        &self,
        snapshot: &ReplicaSnapshot,
    ) -> Result<CompleteBootstrapRetirement, RuntimeError> {
        let generation_id = snapshot
            .bootstrap
            .staging_generation
            .clone()
            .ok_or_else(interrupted)?;
        let generation = snapshot
            .bootstrap
            .generations
            .get(&generation_id)
            .ok_or_else(interrupted)?;
        if !generation.final_page_staged {
            return Err(interrupted());
        }
        let visible: HashSet<_> = snapshot
            .bootstrap
            .vaults
            .keys()
            .filter(|(generation, _)| generation == &generation_id)
            .map(|(_, id)| id.clone())
            .collect();
        let independent = self
            .platform_storage
            .load_current_session(&snapshot.account_id, &snapshot.incarnation)
            .await?;
        let effective = if self.ready.load(Ordering::SeqCst) {
            self.effective_session(&snapshot.account_id, &snapshot.incarnation)
                .await?
        } else {
            None
        };
        let current = self.require_retirement_incarnation(snapshot)?;
        if current.revision != snapshot.revision || current.lock_epoch != snapshot.lock_epoch {
            return Err(interrupted());
        }
        let mut additional: Vec<_> = independent
            .iter()
            .chain(effective.iter())
            .flat_map(|session| session.vault_keys.iter())
            .map(|key| key.vault_id.clone())
            .filter(|id| !visible.contains(id))
            .collect();
        // Only the selected IDs belong to the retirement proof. Release both Session documents
        // before fencing/purging can wait on an admitted foreground capability.
        drop(independent);
        drop(effective);
        // A prior attempt may have captured keys before sign-out removed the Session. Preserve
        // those exact IDs when replaying the same complete authority proof.
        for batch in self
            .foreground_attachments
            .pending_vault_retirements(&snapshot.account_id, &snapshot.incarnation)
        {
            if batch.proof == VaultRetirementProof::CompleteBootstrap(generation_id.clone()) {
                additional.extend(batch.vault_ids);
            }
        }
        additional.sort();
        additional.dedup();
        if additional.iter().any(|id| visible.contains(id)) {
            return Err(interrupted());
        }
        let mut retired: Vec<_> = snapshot
            .bootstrap
            .vaults
            .keys()
            .map(|(_, id)| id.clone())
            .filter(|id| !visible.contains(id))
            .chain(additional.iter().cloned())
            .collect();
        retired.sort();
        retired.dedup();
        Ok(CompleteBootstrapRetirement {
            generation_id,
            additional,
            retired,
        })
    }

    /// Pending policy forbids promotion. Replace the exact complete-stage absence proof with
    /// its full purge/journal atomically, retaining the active cursor and pending marker.
    async fn adopt_complete_bootstrap_retirement_only(
        &self,
        snapshot: &ReplicaSnapshot,
    ) -> Result<(), RuntimeError> {
        let CompleteBootstrapRetirement {
            generation_id,
            retired,
            ..
        } = self.complete_bootstrap_retirement(snapshot).await?;
        if retired.is_empty() {
            // No omission means no retirement proof to replace. Keep the stage and pending
            // gate intact for ordinary fresh verification; never manufacture an empty purge.
            return Ok(());
        }
        // The complete stage proves the whole omitted union independently of any older
        // selected policy proof. Preserve those existing scopes and proof lifetimes; only
        // missing scopes receive the stage proof. Present scopes of an older batch stay with
        // their original owner for normal resume.
        let mut missing = retired.clone();
        let mut groups = Vec::new();
        for batch in self
            .foreground_attachments
            .pending_vault_retirements(&snapshot.account_id, &snapshot.incarnation)
        {
            let ids: Vec<_> = batch
                .vault_ids
                .iter()
                .filter(|id| missing.contains(id))
                .cloned()
                .collect();
            if !ids.is_empty() {
                missing.retain(|id| !ids.contains(id));
                groups.push((ids, batch.proof));
            }
        }
        if !missing.is_empty() {
            groups.push((
                missing,
                VaultRetirementProof::CompleteBootstrap(generation_id),
            ));
        }
        let (publications, capture_error) = {
            let publication = self.publication.lock().expect("publication lock poisoned");
            let mut publications = Vec::new();
            let mut capture_error = None;
            for (ids, proof) in groups {
                match self.begin_vault_retirement_under_publication(
                    &publication,
                    snapshot,
                    &ids,
                    proof,
                ) {
                    Ok(captured) => {
                        let error = captured.projection_error.clone();
                        publications.push(captured);
                        if error.is_some() {
                            capture_error = error;
                            break;
                        }
                    }
                    Err(error) => {
                        capture_error = Some(error);
                        break;
                    }
                }
            }
            (publications, capture_error)
        };
        // Even a later group's error cannot strand an earlier irreversible first fence.
        for captured in &publications {
            captured.retirement.notify_retirement();
        }
        self.wake_dispatch();
        for captured in &publications {
            if let Some(token) = &captured.token {
                token.wait_for_other_threads();
            }
        }
        if let Some(error) = capture_error {
            return Err(error);
        }
        self.advance_native_retirement_authority(snapshot, &retired)?;
        self.publish_all_unless_closed();
        for captured in &publications {
            self.foreground_attachments
                .require_current_vault_retirement(&captured.retirement)?;
        }
        let result = self
            .replica
            .execute_exact(GuardedCommitPlan::new(
                snapshot.account_id.clone(),
                snapshot.incarnation.clone(),
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::RetireVaults { vault_ids: retired }],
            ))
            .await?;
        if !matches!(result, PlanResult::Applied { .. }) {
            return Err(interrupted());
        }
        let current = self.require_retirement_incarnation(snapshot)?;
        for mut captured in publications {
            // Journal-first adoption preserves each original proof/lifetime and notifies the
            // existing native owner if relevant. No transient policy metadata is rewritten:
            // the exact complete stage already durably proved all committed omitted scopes.
            self.adopt_vault_retirement_journal(&current, &mut captured.retirement)
                .await?;
        }
        // Existing resume owns cleanup, including recovery from a lost physical acknowledgement.
        Ok(())
    }

    /// Caller holds the existing Account execution fence. Complete staging is the durable proof.
    pub(super) async fn promote_bootstrap_with_retirement(
        &self,
        account_id: &AccountId,
    ) -> Result<Vec<String>, RuntimeError> {
        self.ensure_not_closed()?;
        let snapshot = self.require_snapshot(account_id)?;
        let CompleteBootstrapRetirement {
            generation_id,
            additional,
            retired,
        } = self.complete_bootstrap_retirement(&snapshot).await?;
        let mut retirement = if retired.is_empty() {
            None
        } else {
            let (retirement, token) = self.begin_vault_retirement_publication(
                &snapshot,
                &retired,
                VaultRetirementProof::CompleteBootstrap(generation_id.clone()),
            )?;
            if let Some(token) = token {
                token.wait_for_other_threads();
            }
            self.advance_native_retirement_authority(&snapshot, &retired)?;
            self.publish_all_unless_closed();
            Some(retirement)
        };
        let result = self
            .replica
            .promote_bootstrap(PromoteBootstrapPlan {
                guard: BootstrapGuard {
                    account_id: snapshot.account_id.clone(),
                    user_id: snapshot.user_id.clone(),
                    incarnation: snapshot.incarnation.clone(),
                    expected_replica_revision: snapshot.revision,
                    expected_lock_epoch: snapshot.lock_epoch,
                },
                generation_id,
                additional_retired_vault_ids: additional,
            })
            .await?;
        if !matches!(result, PlanResult::Applied { .. }) {
            return Err(interrupted());
        }
        let current = self.require_retirement_incarnation(&snapshot)?;
        if let Some(retirement) = retirement.as_mut() {
            self.foreground_attachments
                .record_vault_retirement_journal(retirement, current.revision)?;
            self.finish_vault_retirement(retirement).await?;
        }
        self.readmit_current_vault_authority(&self.require_retirement_incarnation(&snapshot)?)
            .await?;
        Ok(retired)
    }

    fn require_retirement_incarnation(
        &self,
        expected: &ReplicaSnapshot,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        self.ensure_not_closed()?;
        let current = self.require_snapshot(&expected.account_id)?;
        if current.incarnation != expected.incarnation
            || current.user_id != expected.user_id
            || self.account_teardown_is_pending(&expected.account_id)
        {
            return Err(interrupted());
        }
        Ok(current)
    }

    /// Capability retirement and Core loans start together: either can release the other's waiter.
    pub(super) async fn finish_vault_retirement(
        &self,
        retirement: &VaultForegroundRetirement,
    ) -> Result<(), RuntimeError> {
        let account = &retirement.batch.account_id;
        let incarnation = &retirement.batch.incarnation;
        let ids = &retirement.batch.vault_ids;
        let expected = self.require_snapshot(account)?;
        if &expected.incarnation != incarnation {
            return Err(interrupted());
        }
        let journal_present = ids
            .iter()
            .all(|id| expected.bootstrap.pending_vault_retirements.contains(id));
        let acknowledged = matches!(retirement.batch.proof, VaultRetirementProof::DurableJournal { revision }
            if expected.revision > revision)
            && ids
                .iter()
                .all(|id| !expected.bootstrap.pending_vault_retirements.contains(id))
            && expected
                .bootstrap
                .vaults
                .keys()
                .all(|(_, id)| !ids.contains(id));
        if !journal_present && !acknowledged {
            return Err(interrupted());
        }
        let upload = self
            .attachment_upload
            .lock()
            .expect("Attachment Upload facade lock poisoned")
            .clone();
        let download = self
            .attachment_download
            .lock()
            .expect("Attachment Download facade lock poisoned")
            .clone();
        let image = self
            .vault_image_ingress
            .lock()
            .expect("Vault image ingress lock poisoned")
            .clone();
        let ((), upload_result, download_result, image_result) = tokio::join!(
            retirement.drain(),
            async {
                match upload {
                    Some(port) => port
                        .retire_vaults(account, ids)
                        .await
                        .map_err(|_| interrupted()),
                    None => Ok(()),
                }
            },
            async {
                match download {
                    Some(port) => port
                        .retire_vaults(account, ids)
                        .await
                        .map_err(|_| interrupted()),
                    None => Ok(()),
                }
            },
            async {
                match image {
                    Some(port) => port.retire_vaults(account, ids).await,
                    None => Ok(()),
                }
            },
        );
        upload_result?;
        download_result?;
        image_result?;
        self.require_retirement_incarnation(&expected)?;
        // A borrowed document and a dormant independent document are separate key-retirement duties.
        if self.ready.load(Ordering::SeqCst) {
            if let Some(session) = self.effective_session(account, incarnation).await? {
                if matches!(session.provenance, SessionProvenance::Borrowed { .. }) {
                    let mut replacement = session.clone();
                    replacement
                        .vault_keys
                        .retain(|key| !ids.contains(&key.vault_id));
                    if replacement != session {
                        self.replace_borrowed_session(&session, replacement)?;
                    }
                }
            }
        }
        if let Some(session) = self
            .platform_storage
            .load_current_session(account, incarnation)
            .await?
        {
            let mut replacement = session.clone();
            replacement
                .vault_keys
                .retain(|key| !ids.contains(&key.vault_id));
            if replacement != session {
                self.replace_independent_session(&session, replacement)
                    .await?;
            }
        }
        let current = self.require_retirement_incarnation(&expected)?;
        self.sweep_retired_vault_images(&current, ids).await?;
        let current = self.require_retirement_incarnation(&expected)?;
        self.sweep_retired_move_artifacts(&current, ids).await?;
        let current = self.require_retirement_incarnation(&expected)?;
        if journal_present {
            let result = self
                .replica
                .execute_exact(GuardedCommitPlan::new(
                    current.account_id.clone(),
                    current.incarnation.clone(),
                    current.revision,
                    current.lock_epoch,
                    vec![PlanMutation::CompleteVaultRetirements {
                        vault_ids: ids.clone(),
                    }],
                ))
                .await?;
            if !matches!(result, PlanResult::Applied { .. }) {
                return Err(interrupted());
            }
        }
        let current = self.require_retirement_incarnation(&expected)?;
        self.advance_native_retirement_authority(&current, ids)?;
        self.foreground_attachments
            .acknowledge_vault_retirement(retirement)?;
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        self.publish_all_unless_closed();
        Ok(())
    }
}
