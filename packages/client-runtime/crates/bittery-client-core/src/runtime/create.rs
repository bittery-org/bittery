use super::*;
use crate::{
    http_transport::{HttpHeader, HttpMethod},
    replica::{
        AuthorityItemCategory, AuthorityVaultRecord, AuthorityVaultRole, AuthorityVaultType,
        ImmutableHttpRequest, OperationKind, OperationSchedulingState, ReplicaSnapshot,
        ReplicaState, Sha256Fingerprint,
    },
    server_contract::{CreateItemBody, ItemCategory},
    LoginItemDraft,
};
use bittery_crypto_core::{
    decrypt_vault_key_with_muk, encrypt_with_aad, AadContext, WrappedVaultKeyData,
};

/// The Server recomputes this same length-delimited SHA-256 for every create request it accepts,
/// so the fingerprint Rust stores is the one an outcome can be matched against.
const OPERATION_DISCRIMINATOR: &[u8] = b"bittery.operation.v1";
const CREATE_ITEM_KIND: &[u8] = b"create_item";
const CREATE_ITEM_ROUTE: &[u8] = b"PUT /api/v1/vaults/{vaultId}/items/{itemId}";

/// A newly created Item is version one, and its ciphertext is bound to that revision.
const CREATE_ITEM_ENCRYPTION_VERSION: i32 = 1;

/// The concrete route a create Operation will always send to.
pub(crate) fn create_item_path(vault_id: &str, item_id: &str) -> String {
    format!("/api/v1/vaults/{vault_id}/items/{item_id}")
}

/// Covers the route identity and the exact body bytes, and deliberately not the Operation ID.
///
/// Fingerprint and identity have to be able to disagree: slice C reads the same ID arriving with
/// another fingerprint as identity reuse, which is only detectable while the two are independent.
pub(crate) fn create_item_fingerprint(
    vault_id: &str,
    item_id: &str,
    body: &[u8],
) -> Sha256Fingerprint {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for part in [
        OPERATION_DISCRIMINATOR,
        CREATE_ITEM_KIND,
        CREATE_ITEM_ROUTE,
        vault_id.as_bytes(),
        item_id.as_bytes(),
        body,
        // The Server hashes normalized concurrency preconditions here. A create has none.
        b"" as &[u8],
    ] {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
    Sha256Fingerprint(hasher.finalize().into())
}

/// Everything one accepted create owes, computed before any durable write.
struct PreparedCreate {
    operation: OperationRecord,
    overlay: ReplicaItemRecord,
    projection: LoginItemProjection,
}

impl Runtime {
    pub(super) async fn accept_create_login_item(
        &self,
        account_id: AccountId,
        vault_id: String,
        draft: LoginItemDraft,
        cancellation: RequestCancellation,
        accepted: impl FnOnce(),
    ) -> Result<RuntimeResponse, RuntimeError> {
        self.ensure_open()?;
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled before durable acceptance",
            ));
        }
        let execution_lock = self.account_execution_lock(&account_id)?;
        let _execution_guard = execution_lock.lock().await;
        self.ensure_open()?;
        let snapshot = self.replica.snapshot(&account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        if snapshot.failure.is_some() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountFailed,
                "the selected Account module has failed",
            ));
        }
        if snapshot.lock_epoch == u64::MAX {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Account lock epoch is exhausted",
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
        if self
            .lock_epoch_pending
            .lock()
            .expect("pending lock epoch lock poisoned")
            .contains_key(&account_id)
        {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Account lock epoch persistence is pending",
            ));
        }
        let lock_epoch = *self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .entry(account_id.clone())
            .or_insert(0);

        let prepared = self.prepare_create(&snapshot, &vault_id, draft)?;
        let PreparedCreate {
            operation,
            overlay,
            projection,
        } = prepared;
        let operation_id = operation.operation_id.clone();
        let item_id = operation.item_id.clone();

        // One transaction carries the Operation, its immutable bytes and fingerprint, its
        // scheduling state, and the encrypted overlay. `Accepted` is answered only after it
        // commits, so a partial write can never be reported as accepted work.
        let result = self
            .replica
            .execute_recomputing(GuardedCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation,
                snapshot.revision,
                lock_epoch,
                vec![
                    PlanMutation::AcceptOperation(operation),
                    PlanMutation::PutOptimisticItem(overlay),
                ],
            ))
            .await?;
        let (replica_revision, next_snapshot) = match result {
            RecomputedPlanResult::Applied { snapshot } => (snapshot.revision, snapshot),
            RecomputedPlanResult::Fenced { snapshot } => {
                let _publication = self.publication.lock().expect("publication lock poisoned");
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
                drop(_publication);
                drop(_execution_guard);
                if let Some(token) = invalidated_delivery {
                    token.wait_for_other_threads();
                }
                self.publish_all();
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "Account was locked while accepting work",
                ));
            }
            RecomputedPlanResult::Missing => {
                let _publication = self.publication.lock().expect("publication lock poisoned");
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
                drop(_publication);
                drop(_execution_guard);
                self.publish_all();
                return Err(RuntimeError::new(
                    RuntimeErrorCode::AccountMissing,
                    "account was removed during durable acceptance",
                ));
            }
        };
        let _publication = self.publication.lock().expect("publication lock poisoned");
        self.replica.cache(next_snapshot);
        if self
            .account_lock_epochs
            .lock()
            .expect("Account lock epoch lock poisoned")
            .get(&account_id)
            == Some(&lock_epoch)
        {
            self.unlocked_items
                .lock()
                .expect("unlocked projection lock poisoned")
                .entry(account_id)
                .or_default()
                .push(projection);
        }
        self.device_revision.fetch_add(1, Ordering::SeqCst);
        drop(_publication);
        accepted();
        drop(_execution_guard);
        self.publish_all();
        if cancellation.is_cancelled() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::Cancelled,
                "caller cancelled after durable acceptance",
            ));
        }
        Ok(RuntimeResponse::Accepted {
            operation_id,
            item_id,
            replica_revision,
        })
    }

    /// Leaves the in-memory test Runtime as ready for local writes as a real Bootstrap would.
    #[cfg(test)]
    pub(crate) fn seed_ready_personal_vault_in_memory(&self, account_id: &AccountId) {
        let persistence = self
            .test_persistence
            .as_ref()
            .expect("in-memory seeding requires in-memory persistence");
        crate::test_fixtures::seed_ready_personal_vault(persistence, account_id)
            .expect("the seeded Vault promotes");
        self.replica.cache(
            persistence
                .snapshot(account_id)
                .expect("seeded Account has a snapshot"),
        );
        self.device_revision.fetch_add(1, Ordering::SeqCst);
    }

    /// Mints the final Item ID, seals the draft under the existing Item AAD, and builds the exact
    /// bytes the Operation will replay. Nothing here writes; a failure leaves no durable trace.
    fn prepare_create(
        &self,
        snapshot: &ReplicaSnapshot,
        vault_id: &str,
        draft: LoginItemDraft,
    ) -> Result<PreparedCreate, RuntimeError> {
        if snapshot.bootstrap.state != ReplicaState::Ready {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "the Replica is not ready for local writes",
            ));
        }
        let generation = snapshot
            .bootstrap
            .active_generation
            .clone()
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "a ready Replica has no active Bootstrap generation",
                )
            })?;
        let vault = snapshot
            .bootstrap
            .vaults
            .get(&(generation, vault_id.to_owned()))
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "the selected Vault is not visible in this Replica",
                )
            })?;
        if vault.vault_type != AuthorityVaultType::Personal {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "the first create slice writes only to a personal Vault",
            ));
        }
        if vault.role == AuthorityVaultRole::ReadOnly {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "the selected Vault is read only",
            ));
        }
        let master_unlock_key = self
            .copy_live_master_unlock_key(&snapshot.account_id, &snapshot.incarnation)
            .ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AuthenticationRequired,
                    "the selected Account is signed out or locked",
                )
            })?;

        // Rust mints the final Item ID before encryption. The same value binds the AAD, the route
        // path, the overlay, the Server row, and reconciliation, so no remapping ever exists.
        let item_id = bittery_crypto_core::generate_uuid();
        let operation_id = bittery_crypto_core::generate_uuid();

        let vault_key = Zeroizing::new(unwrap_vault_key(
            vault,
            &snapshot.user_id,
            &master_unlock_key,
        )?);
        drop(master_unlock_key);
        let plaintext = Zeroizing::new(serde_json::to_string(&draft).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Login draft could not be serialized",
            )
        })?);
        let sealed = encrypt_with_aad(
            &plaintext,
            &vault_key,
            &AadContext {
                vault_id: vault_id.to_owned(),
                entity_id: item_id.clone(),
                entity_type: "item".into(),
                version: CREATE_ITEM_ENCRYPTION_VERSION as u64,
                user_id: snapshot.user_id.clone(),
            },
        )
        .map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Login draft could not be encrypted",
            )
        })?;
        drop(plaintext);
        drop(vault_key);

        let body = serde_json::to_vec(&CreateItemBody {
            category: ItemCategory::Login,
            encrypted_data: sealed.ciphertext.clone(),
            encryption_algorithm: sealed.algorithm.clone(),
            encryption_iv: sealed.iv.clone(),
        })
        .map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "create Item request body could not be serialized",
            )
        })?;
        let path = create_item_path(vault_id, &item_id);
        let request_fingerprint = create_item_fingerprint(vault_id, &item_id, &body);

        Ok(PreparedCreate {
            operation: OperationRecord {
                operation_id: operation_id.clone(),
                kind: OperationKind::CreateItem,
                item_id: item_id.clone(),
                vault_id: vault_id.to_owned(),
                request: ImmutableHttpRequest {
                    method: HttpMethod::Put,
                    path,
                    // Content headers only. Authorization arrives from the current Session at
                    // dispatch, and the Idempotency-Key is this Operation's own stored ID.
                    headers: vec![HttpHeader {
                        name: "Content-Type".to_owned(),
                        value: "application/json".to_owned(),
                    }],
                    body,
                },
                request_fingerprint,
                scheduling: OperationSchedulingState::default(),
            },
            overlay: ReplicaItemRecord {
                account_id: snapshot.account_id.clone(),
                item_id: item_id.clone(),
                vault_id: vault_id.to_owned(),
                operation_id,
                category: AuthorityItemCategory::Login,
                encrypted_data: sealed.ciphertext,
                encryption_iv: sealed.iv,
                encryption_algorithm: sealed.algorithm,
                encryption_version: CREATE_ITEM_ENCRYPTION_VERSION,
                encrypted_by_user_id: snapshot.user_id.clone(),
            },
            projection: LoginItemProjection {
                account_id: snapshot.account_id.clone(),
                item_id,
                vault_id: vault_id.to_owned(),
                title: draft.title,
                url: draft.url,
                urls: draft.urls,
                username: draft.username,
                password: draft.password,
                notes: draft.notes,
                note: draft.note,
                custom_fields: draft.custom_fields,
                tags: draft.tags,
                favorite: false,
                created_at: String::new(),
                updated_at: String::new(),
                status: ItemProjectionStatus::Pending,
            },
        })
    }
}

/// Opens the Vault key exactly the way the Bootstrap read path opens it, including the wrap-context
/// equality that stops another Vault's or another User's key from being accepted.
fn unwrap_vault_key(
    vault: &AuthorityVaultRecord,
    user_id: &str,
    master_unlock_key: &[u8; 32],
) -> Result<Vec<u8>, RuntimeError> {
    let wrapped: WrappedVaultKeyData =
        serde_json::from_str(&vault.encrypted_vault_key).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "wrapped Vault key is invalid",
            )
        })?;
    if wrapped.context.vault_id != vault.id || wrapped.context.user_id != user_id {
        return Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "wrapped Vault key context does not match",
        ));
    }
    decrypt_vault_key_with_muk(
        &vault.encrypted_vault_key,
        master_unlock_key,
        &wrapped.context,
    )
    .map_err(|_| {
        RuntimeError::new(
            RuntimeErrorCode::AuthenticationRequired,
            "Vault key could not be unwrapped",
        )
    })
}
