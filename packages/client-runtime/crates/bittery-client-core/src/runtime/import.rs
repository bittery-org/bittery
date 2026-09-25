//! Durable Import batch acceptance.
//!
//! This module is production-reachable today: a host calls `importItems` and the request lands
//! here through ordinary dispatch of `RuntimeRequest::ImportItems`. Rust mints every Item ID,
//! encrypts every draft, freezes one ordered immutable request, and accepts it atomically, so an
//! accepted batch survives a restart from the moment this returns.
//!
//! Sending and reconciling the accepted Operation is `import_executor`'s job.

use super::*;
use crate::{
    http_transport::{HttpHeader, HttpMethod},
    replica::{
        ImmutableHttpRequest, OperationKind, OperationRecord, OperationSchedulingState,
        PlanMutation, RecomputedPlanResult, ReplicaState, ResourceRef,
    },
    ImportItemDraft,
};
use bittery_crypto_core::{encrypt_with_aad, AadContext};

/// The Server's published Import request body limit, mirrored from
/// `apps/server/src/http/limits.rs::BULK_IMPORT_BYTES`.
///
/// The two crates cannot share a constant, so both sides pin the literal instead:
/// `import_batch_bytes_fit_the_server_ceiling` guards it here and
/// `import_request_bounds_match_the_runtime_batch_derivation` guards it there.
/// `CREATE_VAULT_ENCRYPTED_KEY_MAX_BYTES` in `replica/domain.rs` mirrors a Server bound the same
/// way.
///
/// `GET /api/meta` does publish this number, as `bulkImportBytes` alongside `bulkImportItems`,
/// and under ADR 0011 that document is the contract a self-hosted operator consumes. The Runtime
/// deliberately does not read it here: acceptance has to work offline, before any Server has been
/// reached, and the accepted request ceiling is a `const` so the arithmetic can fail
/// the build rather than a request. A self-hosted Server on a different release could publish a
/// smaller bound; consuming `/api/meta` to tighten the budget at run time is a separate decision,
/// not something this constant quietly assumes away.
pub(super) const SERVER_IMPORT_BODY_BYTES: usize = 16 * 1024 * 1024;

/// Mirrors the Server's `ITEM_CIPHERTEXT_BYTES` for offline acceptance. The contract test
/// compares it to the generated Import input schema, whose limit comes from that constant.
pub(super) const SERVER_ITEM_CIPHERTEXT_BYTES: usize = 1024 * 1024;

/// The existing offline Import body bound leaves one MiB below the Server's 16 MiB limit.
/// Item-count and per-Item ciphertext limits alone could admit an unsendable 200 MiB request.
/// Keep this accepted-product bound unchanged when reconciliation stops fetching old Item pages.
pub(crate) const MAX_IMPORT_REQUEST_BYTES: usize = 15 * 1024 * 1024;
const _: () = assert!(MAX_IMPORT_REQUEST_BYTES < SERVER_IMPORT_BODY_BYTES);

pub(crate) use crate::wire::import::{ImportRequestBody, ImportRequestItem};

// The Replica owns the canonical Import route and fingerprint. Runtime freezes bytes against the
// same definition the trust boundary re-derives them from.
pub(crate) use crate::replica::{import_items_fingerprint, import_items_path, MAX_IMPORT_ITEMS};

fn invalid_request(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

fn cancelled_before_acceptance() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::Cancelled,
        "caller cancelled before durable acceptance",
    )
}

pub(crate) fn decode_import_request(
    operation: &OperationRecord,
) -> Result<ImportRequestBody, RuntimeError> {
    if operation.kind != OperationKind::ImportItems
        || operation.request.method != HttpMethod::Post
        || operation.request.path != import_items_path(operation.vault_id())
    {
        return Err(invalid_request(
            "Import Operation has an invalid immutable request",
        ));
    }
    let body: ImportRequestBody = serde_json::from_slice(&operation.request.body)
        .map_err(|_| invalid_request("Import Operation body is invalid"))?;
    if body.items.len() > MAX_IMPORT_ITEMS {
        return Err(invalid_request("Import Operation exceeds its Item bound"));
    }
    if operation.request.body.len() > MAX_IMPORT_REQUEST_BYTES {
        return Err(invalid_request("Import Operation exceeds its byte bound"));
    }
    if import_items_fingerprint(operation.vault_id(), &operation.request.body)
        != operation.request_fingerprint
    {
        return Err(invalid_request("Import Operation fingerprint is invalid"));
    }
    let mut ids = std::collections::HashSet::new();
    if body
        .items
        .iter()
        .any(|item| !ids.insert(item.item_id.clone()))
    {
        return Err(invalid_request(
            "Import Operation contains duplicate Item IDs",
        ));
    }
    Ok(body)
}

impl Runtime {
    pub(super) async fn accept_import_items(
        &self,
        account_id: AccountId,
        vault_id: String,
        drafts: Vec<ImportItemDraft>,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(cancelled_before_acceptance());
        }
        // Two bounds refuse a batch that could never be sent and reconciled: the Item count here,
        // and the frozen request bytes once encryption has produced them.
        if drafts.len() > MAX_IMPORT_ITEMS {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SizeRejected,
                "an Import batch exceeds its Item bound",
            ));
        }
        let execution_lock = self.account_execution_lock(&account_id)?;
        let execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(cancelled_before_acceptance());
        }
        if self.account_access_retirement_is_pending(&account_id) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Account lifecycle retirement is pending",
            ));
        }
        let snapshot = self.replica.snapshot(&account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        if snapshot.failure.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountFailed,
                "the selected Account module has failed",
            ));
        }
        if snapshot.bootstrap.state != ReplicaState::Ready {
            return Err(invalid_request(
                "Import requires ready authoritative Vault state",
            ));
        }
        if self
            .account_access
            .lock()
            .expect("Account access lock poisoned")
            .get(&account_id)
            != Some(&AccountAccessState::Unlocked)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "the selected Account is signed out or locked",
            ));
        }
        self.require_vault_accepting_work(&snapshot, &vault_id)?;
        let vault_key = if drafts.is_empty() {
            // Empty Import still reaches Server authority: an inaccessible or read-only Vault is
            // a retained semantic rejection, while an accessible writable one applies zero.
            None
        } else {
            let generation = snapshot
                .bootstrap
                .active_generation
                .clone()
                .ok_or_else(|| invalid_request("ready Replica has no active generation"))?;
            let vault = snapshot
                .bootstrap
                .vaults
                .get(&(generation, vault_id.clone()))
                .ok_or_else(|| invalid_request("the selected Vault is not visible"))?;
            let master_unlock_key = self
                .copy_live_vault_key_material(&account_id, &snapshot.incarnation)
                .ok_or_else(|| {
                    RuntimeError::new(
                        RuntimeErrorCode::AuthenticationRequired,
                        "the selected Account has no live key authority",
                    )
                })?;
            let key = Zeroizing::new(super::vault_key::unwrap_vault_key(
                vault,
                &snapshot.user_id,
                &master_unlock_key,
            )?);
            drop(master_unlock_key);
            Some(key)
        };

        let operation_id = bittery_crypto_core::generate_uuid();
        let mut items = Vec::with_capacity(drafts.len());
        let mut item_ids = Vec::with_capacity(drafts.len());
        for draft in drafts {
            let item_id = bittery_crypto_core::generate_uuid();
            let plaintext = Zeroizing::new(
                super::create::item_plaintext(&draft.draft)
                    .map_err(|_| invalid_request("Import Item draft could not be serialized"))?,
            );
            let sealed = encrypt_with_aad(
                &plaintext,
                vault_key
                    .as_deref()
                    .expect("nonempty Import prepared a Vault key"),
                &AadContext {
                    vault_id: vault_id.clone(),
                    entity_id: item_id.clone(),
                    entity_type: "item".into(),
                    version: 1,
                    user_id: snapshot.user_id.clone(),
                },
            )
            .map_err(|_| invalid_request("Import Item draft could not be encrypted"))?;
            // The Server refuses the whole batch if any individual ciphertext is oversized.
            // Refuse before acceptance so the host can split out that Item and retain siblings.
            if sealed.ciphertext.len() > SERVER_ITEM_CIPHERTEXT_BYTES {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::SizeRejected,
                    "an Import Item exceeds its ciphertext byte bound",
                ));
            }
            items.push(ImportRequestItem {
                item_id: item_id.clone(),
                category: super::create::server_item_category(draft.draft.category()),
                favorite: draft.favorite,
                encrypted_data: sealed.ciphertext,
                encryption_iv: sealed.iv,
                encryption_algorithm: sealed.algorithm,
            });
            item_ids.push(item_id);
        }
        drop(vault_key);
        let body = serde_json::to_vec(&ImportRequestBody { items })
            .map_err(|_| invalid_request("Import request could not be serialized"))?;
        // The exact bytes are the only honest measure, so the bound is checked on them rather
        // than estimated from the drafts. This is still accept time: nothing durable exists yet,
        // so a batch neither ceiling can carry is refused instead of stranded.
        if body.len() > MAX_IMPORT_REQUEST_BYTES {
            return Err(RuntimeError::new(
                RuntimeErrorCode::SizeRejected,
                "an Import batch exceeds its byte bound",
            ));
        }
        let request_fingerprint = import_items_fingerprint(&vault_id, &body);
        let operation = OperationRecord {
            operation_id: operation_id.clone(),
            kind: OperationKind::ImportItems,
            target: ResourceRef::ImportBatch {
                vault_id: vault_id.clone(),
            },
            request: ImmutableHttpRequest {
                method: HttpMethod::Post,
                path: import_items_path(&vault_id),
                headers: vec![HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/json".into(),
                }],
                body,
            },
            request_fingerprint,
            accepted_item_category: None,
            attachment_move_recovery: None,
            update_vault: None,
            create_vault: None,
            scheduling: OperationSchedulingState::default(),
            legacy_admission: None,
        };
        // This one mutation is the whole local progress effect Ticket 56 owes.
        //
        // The accepted Operation record *is* the progress: while it exists the batch is in
        // flight, and reconciliation removes it in the same commit that writes the receipt, so
        // progress can never outlive or contradict the outcome. A second durable progress row
        // would be derived state with its own way of going stale.
        //
        // Import also has no optimistic projection to carry progress: Rust mints the Item IDs but
        // nothing may show an imported Item before authority confirms it, which is why acceptance
        // writes no overlay the way an ordinary create does. A host renders progress from the
        // Operation, and Ticket 57 assigns that display to the Web hook.
        let result = self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::AcceptOperation(operation)],
            ))
            .await?;
        let (replica_revision, next_snapshot) = match result {
            RecomputedPlanResult::Applied { snapshot } => (snapshot.revision, snapshot),
            // A refused commit is authority this Device has to converge on. Leaving the Account
            // Unlocked with the live key still copied would keep offering work the Replica has
            // already fenced, so both arms drop local access exactly like an ordinary create.
            RecomputedPlanResult::Fenced { snapshot } => {
                let publication = self.publication.lock().expect("publication lock poisoned");
                let invalidated_delivery = self.invalidate_delivery(&account_id);
                self.replica.cache(snapshot.clone());
                self.unlocked_items
                    .lock()
                    .expect("unlocked projection lock poisoned")
                    .remove(&account_id);
                self.clear_live_master_unlock_keys_for_account(&account_id);
                self.account_access
                    .lock()
                    .expect("Account access lock poisoned")
                    .insert(account_id.clone(), AccountAccessState::Locked);
                self.account_lock_epochs
                    .lock()
                    .expect("Account lock epoch lock poisoned")
                    .insert(account_id.clone(), snapshot.lock_epoch);
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                drop(publication);
                drop(execution_guard);
                if let Some(token) = invalidated_delivery {
                    token.wait_for_other_threads();
                }
                self.publish_all();
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Account was locked while accepting Import work",
                ));
            }
            RecomputedPlanResult::Missing => {
                let publication = self.publication.lock().expect("publication lock poisoned");
                self.replica.remove_cached(&account_id);
                self.recovery_accounts
                    .lock()
                    .expect("recovery Account lock poisoned")
                    .remove(&account_id);
                self.unlocked_items
                    .lock()
                    .expect("unlocked projection lock poisoned")
                    .remove(&account_id);
                self.clear_live_master_unlock_keys_for_account(&account_id);
                self.device_revision.fetch_add(1, Ordering::SeqCst);
                drop(publication);
                drop(execution_guard);
                self.publish_all();
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccountMissing,
                    "account was removed during Import acceptance",
                ));
            }
        };
        self.replica.cache(next_snapshot);
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        accepted();
        drop(execution_guard);
        self.wake_dispatch();
        self.publish_all();
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled after durable Import acceptance",
            ));
        }
        Ok(RuntimeResponse::ImportBatchAccepted {
            operation_id,
            vault_id,
            item_ids,
            replica_revision,
        })
    }
}
