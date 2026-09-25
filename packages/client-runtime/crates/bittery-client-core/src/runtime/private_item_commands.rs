use super::bootstrap::{decrypt_item, SealedItem};
use super::create::ExistingItemIntent;
use super::*;
use crate::protocol::{DuplicateSourceGuard, ItemDuplicateGuard, ItemEditGuard};
use crate::ItemDraft;

fn stale_duplicate_source() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::InvariantViolation,
        "the selected Duplicate source is stale or unavailable",
    )
}

/// The public credential identity selected for one semantic removal.
pub(super) struct PasskeyRemovalSelection {
    pub rp_id: String,
    pub credential_id: String,
    pub public_key_fingerprint: String,
}

impl Runtime {
    pub(super) async fn accept_remove_passkey(
        &self,
        account_id: AccountId,
        item_id: String,
        guard: ItemEditGuard,
        selection: PasskeyRemovalSelection,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.accept_existing_item_operation(
            account_id,
            item_id,
            ExistingItemIntent::RemovePasskey {
                guard,
                rp_id: selection.rp_id,
                credential_id: selection.credential_id,
                public_key_fingerprint: selection.public_key_fingerprint,
            },
            cancellation,
            accepted,
        )
        .await
    }

    pub(super) async fn accept_duplicate_item(
        &self,
        account_id: AccountId,
        source_item_id: String,
        source_guard: ItemDuplicateGuard,
        title: String,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.accept_create_from_current_snapshot(
            account_id,
            cancellation,
            accepted,
            move |runtime, snapshot| {
                runtime.select_private_duplicate_source(
                    snapshot,
                    &source_item_id,
                    &source_guard,
                    title,
                )
            },
        )
        .await
    }

    /// Called only under the Account execution fence owned by Create acceptance. The public
    /// selection and the exact ciphertext source must still describe the same Replica revision.
    fn select_private_duplicate_source(
        &self,
        snapshot: &ReplicaSnapshot,
        source_item_id: &str,
        guard: &ItemDuplicateGuard,
        title: String,
    ) -> Result<(String, ItemDraft), RuntimeError> {
        if guard.account_id != snapshot.account_id
            || guard.incarnation_id != snapshot.incarnation
            || guard.lock_epoch != snapshot.lock_epoch
            || guard.replica_revision != snapshot.revision
            || guard.source_item_id != source_item_id
        {
            return Err(stale_duplicate_source());
        }

        // A current public projection is the only source of this guard. Recheck its live
        // visibility, including foreground Vault retirement, before opening private bytes.
        let mut visible = self
            .unlocked_items
            .lock()
            .expect("unlocked projection lock poisoned")
            .get(&snapshot.account_id)
            .cloned()
            .unwrap_or_default();
        self.filter_vault_item_projections(snapshot, &mut visible)?;
        let selected = visible
            .iter()
            .find(|item| item.item_id == source_item_id)
            .filter(|item| {
                item.account_id == snapshot.account_id
                    && item.vault_id == guard.vault_id
                    && item.duplicate_source_guard.as_ref() == Some(guard)
            })
            .ok_or_else(stale_duplicate_source)?;

        let generation = snapshot
            .bootstrap
            .active_generation
            .clone()
            .ok_or_else(stale_duplicate_source)?;
        let vault = snapshot
            .bootstrap
            .vaults
            .get(&(generation.clone(), guard.vault_id.clone()))
            .ok_or_else(stale_duplicate_source)?;
        let master_unlock_key = self
            .copy_live_vault_key_material(&snapshot.account_id, &snapshot.incarnation)
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "the selected Account is signed out or locked",
                )
            })?;

        let mut draft = match &guard.source {
            DuplicateSourceGuard::Authoritative { item_version } => {
                if selected.status != ItemProjectionStatus::Authoritative
                    || snapshot
                        .items
                        .iter()
                        .any(|row| row.item_id == source_item_id)
                {
                    return Err(stale_duplicate_source());
                }
                let source = snapshot
                    .bootstrap
                    .items
                    .get(&(generation, source_item_id.to_owned()))
                    .filter(|row| row.vault_id == guard.vault_id && row.version == *item_version)
                    .ok_or_else(stale_duplicate_source)?;
                decrypt_item(
                    &master_unlock_key,
                    &snapshot.user_id,
                    vault,
                    &SealedItem::from_authority(source),
                    &source.category,
                )?
            }
            DuplicateSourceGuard::AcceptedOverlay { operation_id } => {
                if selected.status == ItemProjectionStatus::Authoritative {
                    return Err(stale_duplicate_source());
                }
                let source = snapshot
                    .items
                    .iter()
                    .find(|row| {
                        row.account_id == snapshot.account_id
                            && row.item_id == source_item_id
                            && row.vault_id == guard.vault_id
                            && row.operation_id == *operation_id
                            && !row.permanently_deleted
                    })
                    .ok_or_else(stale_duplicate_source)?;
                decrypt_item(
                    &master_unlock_key,
                    &snapshot.user_id,
                    vault,
                    &SealedItem::from_overlay(source),
                    &source.category,
                )?
            }
        };
        match &mut draft {
            ItemDraft::Login(data) => data.title = title,
            ItemDraft::SecureNote(data) => data.title = title,
            ItemDraft::CreditCard(data) => data.title = title,
            ItemDraft::Identity(data) => data.title = title,
            ItemDraft::Authenticator(data) => data.title = title,
        }
        Ok((guard.vault_id.clone(), draft))
    }
}
