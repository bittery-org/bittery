use super::*;

pub(in crate::replica) fn validate_retired_vault_ids(ids: &[String]) -> Result<(), RuntimeError> {
    if ids.iter().any(String::is_empty) || ids.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(replica_invariant(
            "Vault retirement identities must be sorted and unique",
        ));
    }
    Ok(())
}

impl OperationRecord {
    pub(crate) fn touches_vaults(&self, vault_ids: &[String]) -> Result<bool, RuntimeError> {
        if vault_ids.is_empty() {
            return Ok(false);
        }
        Ok(self
            .accepted_vault_ids()?
            .iter()
            .any(|id| vault_ids.contains(id)))
    }

    /// The accepted request owns its immutable Vault scope, including both sides of a Move.
    pub(crate) fn accepted_vault_ids(&self) -> Result<Vec<String>, RuntimeError> {
        if matches!(self.target, ResourceRef::Team { .. }) {
            return Ok(Vec::new());
        }
        if self.kind != OperationKind::MoveItem {
            return Ok(vec![self.vault_id().to_owned()]);
        }
        use crate::server_contract::MoveItemBody;
        let body: MoveItemBody = serde_json::from_slice(&self.request.body)
            .map_err(|_| replica_invariant("accepted Move request has no exact Vault scope"))?;
        let (source, target) = match body {
            MoveItemBody::Prepared {
                source_vault_id,
                target_vault_id,
                ..
            }
            | MoveItemBody::RejectStaleAuthority {
                source_vault_id,
                target_vault_id,
                ..
            } => (source_vault_id, target_vault_id),
        };
        if target != self.vault_id() {
            return Err(replica_invariant(
                "accepted Move target differs from its request",
            ));
        }
        Ok(vec![source, target])
    }
}

impl AccountReplica {
    pub(in crate::replica) fn retire_vault_authority(
        &mut self,
        vault_ids: &[String],
    ) -> Result<(), RuntimeError> {
        validate_retired_vault_ids(vault_ids)?;
        if vault_ids.is_empty() {
            return Ok(());
        }
        let mut affected = HashSet::new();
        for operation in self.operations.values_mut() {
            if !operation.touches_vaults(vault_ids)? {
                continue;
            }
            affected.insert(operation.operation_id.clone());
            if operation.target.item_id().is_none() || operation.kind == OperationKind::CreateShare
            {
                continue;
            }
            if let Some(overlay) = self
                .items
                .values()
                .find(|item| item.operation_id == operation.operation_id)
            {
                if operation.target.item_id() != Some(overlay.item_id.as_str())
                    || operation.vault_id() != overlay.vault_id
                {
                    return Err(replica_invariant(
                        "category witness has no exact owned overlay",
                    ));
                }
                validate_category(operation.accepted_item_category.as_ref(), &overlay.category)?;
                operation.accepted_item_category = Some(overlay.category.clone());
                if let Some(recovery) = &mut operation.attachment_move_recovery {
                    recovery.preparation_mut().accepted_item_category =
                        operation.accepted_item_category.clone();
                }
            }
        }
        // Destination IDs belong to another Account and cannot retire local evidence.
        for record in self.cross_account_moves.values() {
            if vault_ids.iter().any(|id| id == record.source_vault_id()) {
                affected.insert(record.operation_id().to_owned());
            }
        }
        for preparation in self.attachment_move_preparations.values_mut() {
            if !vault_ids.contains(&preparation.source_vault_id)
                && !vault_ids.contains(&preparation.target_vault_id)
            {
                continue;
            }
            affected.insert(preparation.operation_id.clone());
            if let Some(overlay) = self
                .items
                .values()
                .find(|item| item.operation_id == preparation.operation_id)
            {
                if preparation.item_id != overlay.item_id
                    || preparation.target_vault_id != overlay.vault_id
                {
                    return Err(replica_invariant(
                        "Move category witness has no exact owned overlay",
                    ));
                }
                validate_category(
                    preparation.accepted_item_category.as_ref(),
                    &overlay.category,
                )?;
                preparation.accepted_item_category = Some(overlay.category.clone());
            }
        }
        self.items.retain(|_, item| {
            !vault_ids.contains(&item.vault_id) && !affected.contains(&item.operation_id)
        });
        self.share_capabilities.retain(|operation_id, _| {
            !affected.contains(operation_id)
                && !self
                    .receipts
                    .get(operation_id)
                    .is_some_and(|receipt| vault_ids.iter().any(|id| id == receipt.vault_id()))
        });
        self.bootstrap.abandon_staging_authority()?;
        self.bootstrap
            .vaults
            .retain(|_, vault| !vault_ids.contains(&vault.id));
        self.bootstrap
            .items
            .retain(|_, item| !vault_ids.contains(&item.vault_id));
        self.bootstrap
            .pending_vault_retirements
            .extend_from_slice(vault_ids);
        self.bootstrap.pending_vault_retirements.sort();
        self.bootstrap.pending_vault_retirements.dedup();
        self.bootstrap.validate()
    }
}

pub(super) fn validate_category(
    witness: Option<&AuthorityItemCategory>,
    category: &AuthorityItemCategory,
) -> Result<(), RuntimeError> {
    if witness.is_some_and(|witness| witness != category) {
        return Err(replica_invariant(
            "accepted Item category differs from its owned overlay",
        ));
    }
    Ok(())
}

/// The witness is local evidence only: never part of the immutable HTTP fingerprint.
pub(super) fn validate_operation_category(operation: &OperationRecord) -> Result<(), RuntimeError> {
    let Some(witness) = &operation.accepted_item_category else {
        return Ok(());
    };
    if !matches!(
        operation.kind,
        OperationKind::CreateItem
            | OperationKind::UpdateItem
            | OperationKind::SetItemFavorite
            | OperationKind::TrashItem
            | OperationKind::RestoreItem
            | OperationKind::MoveItem
            | OperationKind::PermanentlyDeleteItem
    ) {
        return Err(replica_invariant(
            "non-Item Operation carries an Item category",
        ));
    }
    if operation.kind == OperationKind::CreateItem {
        let body: serde_json::Value = serde_json::from_slice(&operation.request.body)
            .map_err(|_| replica_invariant("accepted Create request is not valid JSON"))?;
        if let Some(category) = body.get("category") {
            let category: crate::server_contract::ItemCategory =
                serde_json::from_value(category.clone())
                    .map_err(|_| replica_invariant("accepted Create category is invalid"))?;
            validate_category(Some(witness), &category.into())?;
        }
    }
    Ok(())
}

impl BootstrapAuthority {
    /// Pages read before a retained result or authority retirement cannot become current later.
    pub(in crate::replica) fn abandon_staging_authority(&mut self) -> Result<(), RuntimeError> {
        if let Some(staging) = self.staging_generation.take() {
            let generation = self
                .generations
                .remove(&staging)
                .ok_or_else(|| replica_invariant("staging generation is missing"))?;
            self.state = generation.fallback_state;
            self.pages.retain(|(id, _), _| id != &staging);
            self.vaults.retain(|(id, _), _| id != &staging);
            self.items.retain(|(id, _), _| id != &staging);
        }
        Ok(())
    }
}
