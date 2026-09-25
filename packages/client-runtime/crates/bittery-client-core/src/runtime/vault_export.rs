//! Fixed Export plaintext lives in its existing observation until host cleanup acknowledges it.
use super::foreground_attachment_lifecycle::{
    ForegroundAttachmentGuard, ForegroundAttachmentPublication, ForegroundAttachmentTarget,
};
use super::*;
use crate::ItemDraft;

fn scrub_private_custom_fields(fields: &mut [crate::CustomField]) {
    for crate::CustomField {
        id,
        label,
        value,
        field_type: _,
    } in fields
    {
        id.zeroize();
        label.zeroize();
        value.zeroize();
    }
}

fn scrub_private_totp_fields(
    secret: &mut Option<String>,
    issuer: &mut Option<String>,
    account_name: &mut Option<String>,
) {
    secret.zeroize();
    issuer.zeroize();
    account_name.zeroize();
}

/// Exhaustive field patterns make future private Item fields a compile-time review point.
pub(super) fn scrub_private_item_draft(data: &mut ItemDraft) {
    match data {
        ItemDraft::Login(crate::LoginItemData {
            title,
            url,
            urls,
            username,
            password,
            password_history,
            passkeys,
            notes,
            note,
            custom_fields,
            tags,
            totp_secret,
            totp_issuer,
            totp_account_name,
            totp_algorithm: _,
            totp_digits: _,
            totp_period: _,
        }) => {
            title.zeroize();
            url.zeroize();
            urls.zeroize();
            username.zeroize();
            password.zeroize();
            for crate::PasswordHistoryEntry {
                password,
                changed_at,
            } in password_history
            {
                password.zeroize();
                changed_at.zeroize();
            }
            for crate::Passkey {
                credential_id,
                rp_id,
                rp_name,
                user_handle,
                user_name,
                user_display_name,
                private_key,
                public_key,
                algorithm: _,
                sign_count: _,
                transports,
                created_at,
                last_used_at,
                status: _,
                status_reason: _,
                status_updated_at,
            } in passkeys
            {
                credential_id.zeroize();
                rp_id.zeroize();
                rp_name.zeroize();
                user_handle.zeroize();
                user_name.zeroize();
                user_display_name.zeroize();
                private_key.zeroize();
                public_key.zeroize();
                transports.zeroize();
                created_at.zeroize();
                last_used_at.zeroize();
                status_updated_at.zeroize();
            }
            notes.zeroize();
            note.zeroize();
            scrub_private_custom_fields(custom_fields);
            tags.zeroize();
            scrub_private_totp_fields(totp_secret, totp_issuer, totp_account_name);
        }
        ItemDraft::SecureNote(crate::SecureNoteItemData {
            title,
            note,
            notes,
            custom_fields,
            tags,
        }) => {
            title.zeroize();
            note.zeroize();
            notes.zeroize();
            scrub_private_custom_fields(custom_fields);
            tags.zeroize();
        }
        ItemDraft::CreditCard(crate::CreditCardItemData {
            title,
            cardholder_name,
            card_number,
            cvv,
            expiry_date,
            billing_address,
            notes,
            custom_fields,
            totp_secret,
            totp_issuer,
            totp_account_name,
            totp_algorithm: _,
            totp_digits: _,
            totp_period: _,
            tags,
        }) => {
            title.zeroize();
            cardholder_name.zeroize();
            card_number.zeroize();
            cvv.zeroize();
            expiry_date.zeroize();
            billing_address.zeroize();
            notes.zeroize();
            scrub_private_custom_fields(custom_fields);
            scrub_private_totp_fields(totp_secret, totp_issuer, totp_account_name);
            tags.zeroize();
        }
        ItemDraft::Identity(crate::IdentityItemData {
            title,
            first_name,
            middle_name,
            last_name,
            email,
            addresses,
            phone_numbers,
            ssn,
            passport_number,
            drivers_license,
            date_of_birth,
            notes,
            custom_fields,
            totp_secret,
            totp_issuer,
            totp_account_name,
            totp_algorithm: _,
            totp_digits: _,
            totp_period: _,
            tags,
        }) => {
            title.zeroize();
            first_name.zeroize();
            middle_name.zeroize();
            last_name.zeroize();
            email.zeroize();
            for crate::Address {
                id,
                street,
                city,
                state,
                zip,
                country,
            } in addresses
            {
                id.zeroize();
                street.zeroize();
                city.zeroize();
                state.zeroize();
                zip.zeroize();
                country.zeroize();
            }
            for crate::PhoneNumber { id, label, number } in phone_numbers {
                id.zeroize();
                label.zeroize();
                number.zeroize();
            }
            ssn.zeroize();
            passport_number.zeroize();
            drivers_license.zeroize();
            date_of_birth.zeroize();
            notes.zeroize();
            scrub_private_custom_fields(custom_fields);
            scrub_private_totp_fields(totp_secret, totp_issuer, totp_account_name);
            tags.zeroize();
        }
        ItemDraft::Authenticator(crate::AuthenticatorItemData {
            title,
            totp_secret,
            totp_issuer,
            totp_account_name,
            totp_algorithm: _,
            totp_digits: _,
            totp_period: _,
            linked_item_id,
            notes,
            custom_fields,
            tags,
        }) => {
            title.zeroize();
            totp_secret.zeroize();
            totp_issuer.zeroize();
            totp_account_name.zeroize();
            linked_item_id.zeroize();
            notes.zeroize();
            scrub_private_custom_fields(custom_fields);
            tags.zeroize();
        }
    }
}

// A caller that temporarily owns an Export projection can give it a bounded plaintext lifetime
// without a second Item wipe algorithm. Export's normal foreground loan still governs delivery.
impl Zeroize for crate::VaultExportProjection {
    fn zeroize(&mut self) {
        for item in &mut self.items {
            scrub_private_item_draft(&mut item.data);
        }
    }
}

/// Owns completed private reads until the entire selected set succeeds. A later row failure
/// cannot drop already decrypted Items without wiping them first.
#[derive(Default)]
struct PrivateVaultExportItems(Vec<crate::VaultExportItem>);

impl Drop for PrivateVaultExportItems {
    fn drop(&mut self) {
        for item in &mut self.0 {
            scrub_private_item_draft(&mut item.data);
        }
        #[cfg(test)]
        if !self.0.is_empty() {
            PRIVATE_READ_WIPE_AUDIT.with(|slot| {
                if let Some(audit) = slot.borrow_mut().take() {
                    audit(&self.0);
                }
            });
        }
    }
}

#[cfg(test)]
type PrivateReadWipeAudit = Box<dyn Fn(&[crate::VaultExportItem])>;

#[cfg(test)]
thread_local! {
    static PRIVATE_READ_WIPE_AUDIT: std::cell::RefCell<Option<PrivateReadWipeAudit>> =
        std::cell::RefCell::new(None);
}

#[cfg(test)]
pub(super) fn set_private_read_wipe_audit(audit: Option<PrivateReadWipeAudit>) {
    PRIVATE_READ_WIPE_AUDIT.with(|slot| *slot.borrow_mut() = audit);
}

pub(super) struct VaultExportLifetime {
    guard: Option<ForegroundAttachmentGuard>,
    incarnation: crate::Incarnation,
    lock_epoch: u64,
    user_id: String,
    vault_ids: Vec<String>,
    delivered: bool,
    output_lease: Option<String>,
    cancellation: RequestCancellation,
    retired: bool,
    pending: Option<QueuedDelivery>,
    runtime: Weak<Runtime>,
}

impl Runtime {
    /// One private Item read owner computes every Vault whose authority the captured effective
    /// row depends on. Native legacy delivery and foreground Export share this exact scope.
    pub(super) fn vault_export_capture_scopes(
        &self,
        snapshot: &crate::replica::ReplicaSnapshot,
        requested_vault_ids: &[String],
        captured_items: &[crate::VaultExportItem],
    ) -> Result<Vec<String>, RuntimeError> {
        let visible = visible_vaults(snapshot);
        let mut unique = HashSet::new();
        for vault_id in requested_vault_ids {
            if !unique.insert(vault_id)
                || !visible.iter().any(|vault| &vault.vault_id == vault_id)
                || self.vault_is_fenced(snapshot, vault_id)
            {
                return Err(export_retired());
            }
        }
        let mut captured_vault_ids = requested_vault_ids.to_vec();
        for item in captured_items
            .iter()
            .filter(|item| item.status != crate::ItemProjectionStatus::Authoritative)
        {
            let Some(overlay) = snapshot.items.iter().find(|overlay| {
                overlay.item_id == item.item_id && overlay.vault_id == item.vault_id
            }) else {
                return Err(export_retired());
            };
            if let Some(operation) = snapshot
                .operations
                .iter()
                .find(|operation| operation.operation_id == overlay.operation_id)
            {
                if operation.target.item_id() != Some(item.item_id.as_str())
                    || operation.vault_id() != item.vault_id
                {
                    return Err(export_retired());
                }
                captured_vault_ids.extend(operation.accepted_vault_ids()?);
            } else if let Some(preparation) =
                snapshot
                    .attachment_move_preparations
                    .iter()
                    .find(|preparation| {
                        preparation.operation_id == overlay.operation_id
                            && preparation.item_id == item.item_id
                            && preparation.target_vault_id == item.vault_id
                    })
            {
                captured_vault_ids.extend([
                    preparation.source_vault_id.clone(),
                    preparation.target_vault_id.clone(),
                ]);
            } else if item.status == crate::ItemProjectionStatus::Pending {
                return Err(export_retired());
            }
            // A Failed local overlay has no live Operation/preparation. Its current Vault
            // supplies the same scope used by ordinary projection retirement filtering.
        }
        captured_vault_ids.sort();
        captured_vault_ids.dedup();
        if captured_vault_ids.iter().any(|id| {
            !visible.iter().any(|vault| &vault.vault_id == id) || self.vault_is_fenced(snapshot, id)
        }) {
            return Err(export_retired());
        }
        Ok(captured_vault_ids)
    }

    /// Resolve a selected public frame back to the current encrypted rows while publication is
    /// held. Only VaultExport may call this; ordinary Items never receive these private drafts.
    pub(super) fn private_vault_export_items(
        &self,
        snapshot: &crate::replica::ReplicaSnapshot,
        selected: &crate::ItemsProjection,
    ) -> Result<Vec<crate::VaultExportItem>, RuntimeError> {
        if selected.account_id != snapshot.account_id
            || selected.replica_revision != snapshot.revision
        {
            return Err(export_retired());
        }
        let generation = snapshot
            .bootstrap
            .active_generation
            .as_ref()
            .ok_or_else(export_retired)?;
        let key = self
            .copy_live_vault_key_material(&snapshot.account_id, &snapshot.incarnation)
            .ok_or_else(export_retired)?;
        let mut collected = PrivateVaultExportItems::default();
        for item in &selected.items {
            let decrypted = (|| {
                if item.account_id != snapshot.account_id || item.deleted_at.is_some() {
                    return Err(export_retired());
                }
                let vault = snapshot
                    .bootstrap
                    .vaults
                    .get(&(generation.clone(), item.vault_id.clone()))
                    .ok_or_else(export_retired)?;
                let data = if item.status == crate::ItemProjectionStatus::Authoritative {
                    let row = snapshot
                        .bootstrap
                        .items
                        .get(&(generation.clone(), item.item_id.clone()))
                        .filter(|row| row.vault_id == item.vault_id)
                        .ok_or_else(export_retired)?;
                    super::bootstrap::decrypt_item(
                        &key,
                        &snapshot.user_id,
                        vault,
                        &super::bootstrap::SealedItem::from_authority(row),
                        &row.category,
                    )?
                } else {
                    let row = snapshot
                        .items
                        .iter()
                        .find(|row| row.item_id == item.item_id && row.vault_id == item.vault_id)
                        .ok_or_else(export_retired)?;
                    super::bootstrap::decrypt_item(
                        &key,
                        &snapshot.user_id,
                        vault,
                        &super::bootstrap::SealedItem::from_overlay(row),
                        &row.category,
                    )?
                };
                Ok(crate::VaultExportItem {
                    account_id: item.account_id.clone(),
                    item_id: item.item_id.clone(),
                    vault_id: item.vault_id.clone(),
                    data,
                    favorite: item.favorite,
                    deleted_at: item.deleted_at.clone(),
                    attachments: item.attachments.clone(),
                    created_at: item.created_at.clone(),
                    updated_at: item.updated_at.clone(),
                    status: item.status,
                })
            })()?;
            collected.0.push(decrypted);
        }
        Ok(std::mem::take(&mut collected.0))
    }

    /// Native authority and publication are held; no callback runs while installing this loan.
    pub(super) fn install_vault_export_lifetime(
        self: &Arc<Self>,
        subscription: &Arc<Subscription>,
        initial: ProjectedDelivery,
    ) -> Result<
        (
            Option<ProjectedDelivery>,
            Option<ForegroundAttachmentPublication>,
        ),
        RuntimeError,
    > {
        let ObservationRequest::VaultExport {
            account_id,
            vault_ids,
        } = &subscription.request
        else {
            return Ok((Some(initial), None));
        };
        let snapshot = self.require_snapshot(account_id)?;
        if !self.generation_is_preparation_eligible(&snapshot) {
            return Err(export_retired());
        }
        let RuntimeProjection::VaultExport(captured) = &initial.projection else {
            return Err(export_retired());
        };
        let captured_vault_ids =
            self.vault_export_capture_scopes(&snapshot, vault_ids, &captured.items)?;
        let cancellation = RequestCancellation::new();
        let weak_subscription = Arc::downgrade(subscription);
        let weak_runtime = Arc::downgrade(self);
        let on_retirement = Arc::new(move || {
            if let Some(subscription) = weak_subscription.upgrade() {
                let reason = if weak_runtime
                    .upgrade()
                    .is_none_or(|runtime| runtime.is_closed())
                {
                    crate::VaultExportRetirementReason::RuntimeClosed
                } else {
                    crate::VaultExportRetirementReason::ScopeRetired
                };
                subscription.retire_vault_export(reason);
            }
        });
        *subscription
            .vault_export
            .lock()
            .expect("Export lifetime lock poisoned") = Some(VaultExportLifetime {
            guard: None,
            incarnation: snapshot.incarnation.clone(),
            lock_epoch: snapshot.lock_epoch,
            user_id: snapshot.user_id.clone(),
            vault_ids: captured_vault_ids.clone(),
            delivered: false,
            output_lease: None,
            cancellation: cancellation.clone(),
            retired: false,
            pending: None,
            runtime: Arc::downgrade(self),
        });
        let guard = self
            .foreground_attachments
            .register_target_with_retirement(
                account_id,
                &snapshot.incarnation,
                ForegroundAttachmentTarget::VaultExport {
                    vault_ids: captured_vault_ids,
                },
                cancellation,
                on_retirement,
            )?;
        let publication = self.foreground_attachments.publication(&guard);
        let mut state = subscription
            .vault_export
            .lock()
            .expect("Export lifetime lock poisoned");
        let export = state
            .as_mut()
            .expect("Export lifetime initialized before registration");
        export.guard = Some(guard);
        if !export.retired {
            export.pending = Some(QueuedDelivery {
                generation: initial.generation,
                projection: initial.projection,
                dependency_revision: initial.dependency_revision,
                tokens: initial.tokens,
                foreground_attachment: Some(publication.clone()),
            });
        }
        Ok((None, Some(publication)))
    }
}

impl Subscription {
    pub(super) fn restore_export_delivery(&self, refused: QueuedDelivery) -> Option<Arc<Runtime>> {
        let mut state = self
            .vault_export
            .lock()
            .expect("Export lifetime lock poisoned");
        let export = state.as_mut()?;
        if export.retired || export.delivered || export.guard.is_none() {
            return None;
        }
        // Only this owned captured frame can be in flight; ordinary publications never recapture it.
        debug_assert!(export.pending.is_none());
        export.pending = Some(refused);
        export.runtime.upgrade()
    }

    pub(super) fn retire_vault_export(&self, reason: crate::VaultExportRetirementReason) {
        {
            let mut state = self
                .vault_export
                .lock()
                .expect("Export lifetime lock poisoned");
            let Some(export) = state.as_mut() else {
                return;
            };
            if export.retired {
                return;
            }
            export.retired = true;
            export.pending = None;
        }
        // A terminal control never borrows an invalidated plaintext token and cannot be trapped
        // behind a queued private frame. The host closes this handle only after its cleanup.
        {
            let mut delivery = self
                .delivery
                .lock()
                .expect("observation delivery lock poisoned");
            delivery.queue.clear();
            if delivery.closed {
                return;
            }
        }
        self.sink
            .control(crate::ObservationControl::VaultExportRetired { reason });
    }

    pub(super) fn mark_export_snapshot_delivered(&self) {
        let mut state = self
            .vault_export
            .lock()
            .expect("Export lifetime lock poisoned");
        if let Some(export) = state.as_mut().filter(|export| !export.retired) {
            export.delivered = true;
        }
    }

    pub(super) fn close_vault_export(&self) {
        let guard = self
            .vault_export
            .lock()
            .expect("Export lifetime lock poisoned")
            .as_mut()
            .and_then(|export| {
                export.retired = true;
                export.pending = None;
                export.cancellation.cancel();
                export.output_lease = None;
                export.guard.take()
            });
        drop(guard);
    }
}

fn export_retired() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::AccessDenied,
        "Export scope is not currently available",
    )
}

impl ObservationHandle {
    pub fn begin_vault_export_output(&self) -> Result<String, RuntimeError> {
        let runtime = self.runtime.upgrade().ok_or_else(export_retired)?;
        #[cfg(test)]
        runtime
            .foreground_attachments
            .before_finalization_admission();
        let _native = runtime.native_observation_guard();
        let _publication = runtime
            .publication
            .lock()
            .expect("publication lock poisoned");
        let ObservationRequest::VaultExport { account_id, .. } = &self.subscription.request else {
            return Err(export_retired());
        };
        let current = runtime.require_snapshot(account_id)?;
        let mut state = self
            .subscription
            .vault_export
            .lock()
            .expect("Export lifetime lock poisoned");
        let export = state.as_mut().ok_or_else(export_retired)?;
        if self.closed.load(Ordering::SeqCst)
            || export.retired
            || !export.delivered
            || export.output_lease.is_some()
            || export.incarnation != current.incarnation
            || export.lock_epoch != current.lock_epoch
            || export.user_id != current.user_id
            || !runtime.generation_is_preparation_eligible(&current)
        {
            return Err(export_retired());
        }
        let visible = visible_vaults(&current);
        if export.vault_ids.iter().any(|id| {
            !visible.iter().any(|vault| &vault.vault_id == id)
                || runtime.vault_is_fenced(&current, id)
        }) {
            return Err(export_retired());
        }
        let guard = export.guard.as_ref().ok_or_else(export_retired)?;
        if !runtime
            .foreground_attachments
            .admit_finalization(guard, &export.cancellation)
        {
            return Err(export_retired());
        }
        // Identity is meaningful only within this live connection-owned observation.
        let lease = self.id.to_string();
        export.output_lease = Some(lease.clone());
        Ok(lease)
    }

    pub fn finish_vault_export_output(&self, lease_id: &str) -> Result<(), RuntimeError> {
        {
            let mut state = self
                .subscription
                .vault_export
                .lock()
                .expect("Export lifetime lock poisoned");
            let export = state.as_mut().ok_or_else(export_retired)?;
            if export.output_lease.as_deref() != Some(lease_id) {
                return Err(export_retired());
            }
            export.output_lease = None;
            export.retired = true;
        }
        self.close();
        Ok(())
    }
}

impl Runtime {
    /// Retry only the fixed captured payload; unrelated Vault retirement may require a fresh
    /// Account delivery token, while the exact original Export guard still authorizes this scope.
    pub(super) fn publish_vault_export_snapshot(&self, subscription: &Subscription) {
        let ObservationRequest::VaultExport { account_id, .. } = &subscription.request else {
            return;
        };
        let native = self.native_observation_guard();
        let publication = self.publication.lock().expect("publication lock poisoned");
        let Ok(current) = self.require_snapshot(account_id) else {
            return;
        };
        let mut state = subscription
            .vault_export
            .lock()
            .expect("Export lifetime lock poisoned");
        let Some(export) = state.as_mut() else {
            return;
        };
        if export.retired
            || export.delivered
            || export.cancellation.is_cancelled()
            || export.incarnation != current.incarnation
            || export.lock_epoch != current.lock_epoch
            || export.user_id != current.user_id
            || !self.generation_is_preparation_eligible(&current)
        {
            return;
        }
        let visible = visible_vaults(&current);
        if export.vault_ids.iter().any(|id| {
            !visible.iter().any(|vault| &vault.vault_id == id) || self.vault_is_fenced(&current, id)
        }) {
            return;
        }
        let Some(mut captured) = export.pending.take() else {
            return;
        };
        let generation = DeliveryGeneration {
            incarnation: export.incarnation.clone(),
            epoch: export.lock_epoch,
        };
        captured.tokens = vec![self.delivery_token(&current, &generation)];
        drop(state);
        drop(publication);
        drop(native);
        subscription.publish_with_foreground_attachment(
            ProjectedDelivery {
                generation: captured.generation,
                projection: captured.projection,
                dependency_revision: captured.dependency_revision,
                tokens: captured.tokens,
            },
            captured.foreground_attachment,
        );
    }
}
