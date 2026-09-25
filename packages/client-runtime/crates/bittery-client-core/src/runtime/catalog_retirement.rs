//! Durable destination retirement uses the existing Device catalog and source Replica owners.
use super::*;
use crate::platform_storage::{AccountRetirementPurpose, PendingAccountRetirementIntent};
use crate::replica::{CrossAccountMoveBindingStatus, CrossAccountMoveEntry, PlanResult};

fn binding_retirement(record: &CrossAccountMoveEntry) -> PlanMutation {
    PlanMutation::RetireCrossAccountMoveDestination {
        operation_id: record.operation_id().to_owned(),
        expected_binding_revision: record.destination_binding().binding_revision,
        target_account_id: record.destination_binding().account_id.clone(),
        target_incarnation: record.destination_binding().incarnation.clone(),
    }
}

impl Runtime {
    /// Caller holds catalog serialization and the sorted catalog Account execution fences.
    pub(in crate::runtime) async fn mark_catalog_account_retirement(
        &self,
        catalog: &DeviceCatalogDocument,
        account_id: &AccountId,
        purpose: AccountRetirementPurpose,
    ) -> Result<DeviceCatalogDocument, RuntimeError> {
        let mut next = catalog.clone();
        let account = next
            .accounts
            .iter_mut()
            .find(|entry| &entry.account_id == account_id)
            .ok_or_else(|| startup_invariant("Account retirement lost its catalog entry"))?;
        let incarnation = account.active_incarnation.clone().ok_or_else(|| {
            startup_invariant("Account retirement requires an active incarnation")
        })?;
        let intent = PendingAccountRetirementIntent {
            incarnation,
            purpose,
        };
        if let Some(previous) = &account.pending_retirement {
            if previous == &intent {
                return Ok(next);
            }
            // Explicit removal may finish an abandoned replacement of this exact authority.
            // A removal can never be weakened back into replacement.
            if previous.incarnation != intent.incarnation
                || previous.purpose != AccountRetirementPurpose::Replace
                || purpose != AccountRetirementPurpose::Remove
            {
                return Err(startup_invariant(
                    "Account retirement has another pending purpose",
                ));
            }
        }
        account.pending_retirement = Some(intent);
        let next = catalog.with_accounts(next.accounts)?;
        self.ensure_not_closed()?;
        self.platform_storage.store_device_catalog(&next).await?;
        Ok(next)
    }

    /// Startup has privately reconciled pending installs, but publishes no Account until this
    /// durable fanout is complete. Remove remains marked until its normal cleanup detaches it.
    pub(in crate::runtime) async fn resume_catalog_account_retirements(
        &self,
        catalog: &DeviceCatalogDocument,
    ) -> Result<bool, RuntimeError> {
        let pending: Vec<_> = catalog
            .accounts
            .iter()
            .filter_map(|account| {
                account
                    .pending_retirement
                    .as_ref()
                    .map(|intent| (account, intent))
            })
            .collect();
        let mut changed = !pending.is_empty();
        let mut accounts: Vec<_> = catalog
            .accounts
            .iter()
            .map(|account| &account.account_id)
            .collect();
        accounts.sort();
        let locks = accounts
            .iter()
            .map(|account| self.account_execution_lock_internal(account))
            .collect::<Result<Vec<_>, _>>()?;
        let mut guards = Vec::with_capacity(locks.len());
        for lock in &locks {
            guards.push(lock.lock().await);
        }
        for (account, intent) in pending {
            self.gate_catalog_account_retirement(&account.account_id, intent.purpose);
            self.retire_cross_account_destination_bindings(
                catalog,
                &account.account_id,
                &intent.incarnation,
            )
            .await?;
        }
        // Restored storage may no longer contain the destination or may have completed its
        // replacement before a referring source was updated. Only the reconciled catalog owns
        // current Accounts; orphan stores cannot restore an old binding or select a replacement.
        for account in &catalog.accounts {
            let source = self.load_catalog_retirement_source(account).await?;
            let mutations = source
                .cross_account_moves
                .iter()
                .filter(|record| {
                    record.destination_binding().status == CrossAccountMoveBindingStatus::Active
                        && catalog
                            .accounts
                            .iter()
                            .find(|target| {
                                target.account_id == record.destination_binding().account_id
                            })
                            .is_none_or(|target| {
                                target.active_incarnation.as_ref()
                                    != Some(&record.destination_binding().incarnation)
                            })
                })
                .map(binding_retirement)
                .collect();
            changed |= self
                .commit_catalog_binding_retirements(&source, mutations)
                .await?;
        }
        Ok(changed)
    }

    /// Inventory every durable source; a missing/unreadable source never means no references.
    pub(in crate::runtime) async fn retire_cross_account_destination_bindings(
        &self,
        catalog: &DeviceCatalogDocument,
        target: &AccountId,
        incarnation: &crate::protocol::Incarnation,
    ) -> Result<(), RuntimeError> {
        for account in &catalog.accounts {
            if &account.account_id == target {
                continue;
            }
            let source = self.load_catalog_retirement_source(account).await?;
            let mutations = source
                .cross_account_moves
                .iter()
                .filter(|record| {
                    record.destination_binding().account_id == *target
                        && record.destination_binding().incarnation == *incarnation
                        && record.destination_binding().status
                            == CrossAccountMoveBindingStatus::Active
                })
                .map(binding_retirement)
                .collect();
            self.commit_catalog_binding_retirements(&source, mutations)
                .await?;
        }
        Ok(())
    }

    async fn load_catalog_retirement_source(
        &self,
        account: &DeviceCatalogAccount,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        self.ensure_not_closed()?;
        let source = self
            .replica
            .load_uncached(&account.account_id)
            .await?
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::StorageUnavailable,
                    "Account retirement requires every durable source Replica",
                )
            })?;
        if account.active_incarnation.as_ref() != Some(&source.incarnation)
            || account.pending_install.is_some()
        {
            return Err(startup_invariant(
                "Account retirement source catalog and Replica disagree",
            ));
        }
        Ok(source)
    }

    async fn commit_catalog_binding_retirements(
        &self,
        source: &ReplicaSnapshot,
        mutations: Vec<PlanMutation>,
    ) -> Result<bool, RuntimeError> {
        if mutations.is_empty() {
            return Ok(false);
        }
        self.ensure_not_closed()?;
        let result = self
            .replica
            .execute_exact(GuardedCommitPlan::new(
                source.account_id.clone(),
                source.incarnation.clone(),
                source.revision,
                source.lock_epoch,
                mutations,
            ))
            .await?;
        if !matches!(result, PlanResult::Applied { .. }) {
            return Err(startup_invariant(
                "Source binding retirement was not committed",
            ));
        }
        Ok(true)
    }
}
