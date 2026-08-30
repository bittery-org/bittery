//! Shared Replica readiness for tests that exercise local writes.
//!
//! A create needs the state a real Sign-in plus Bootstrap leaves behind: a live master unlock key,
//! a ready Replica, and one personal Vault whose key that MUK opens. These fixtures build exactly
//! that, with the real wrapped-key format, so no test invents a second crypto shape.

use crate::replica::{AuthorityVaultRecord, AuthorityVaultRole, AuthorityVaultType};
#[cfg(any(test, feature = "binding-test-harness"))]
use crate::{
    http_transport::{HttpHeader, HttpMethod},
    replica::{
        ImmutableHttpRequest, OperationKind, OperationRecord, OperationSchedulingState,
        Sha256Fingerprint,
    },
};
#[cfg(test)]
use crate::{
    replica::{AuthorityItemCategory, InMemoryReplica, ReplicaItemRecord},
    AccountId, RuntimeError,
};
use bittery_crypto_core::{encrypt_vault_key_with_muk, VaultKeyWrapContext};

pub(crate) const TEST_MASTER_UNLOCK_KEY: [u8; 32] = [7u8; 32];
pub(crate) const TEST_VAULT_KEY: [u8; 32] = [11u8; 32];
pub(crate) const TEST_VAULT_ID: &str = "vault-1";

pub(crate) fn personal_vault(vault_id: &str, user_id: &str) -> AuthorityVaultRecord {
    let encrypted_vault_key = encrypt_vault_key_with_muk(
        &TEST_VAULT_KEY,
        &TEST_MASTER_UNLOCK_KEY,
        &VaultKeyWrapContext::new(vault_id, user_id, 1),
    )
    .expect("test Vault key wraps");
    AuthorityVaultRecord {
        id: vault_id.to_owned(),
        name: "Personal".to_owned(),
        vault_type: AuthorityVaultType::Personal,
        icon: None,
        image_url: None,
        encrypted_vault_key,
        role: AuthorityVaultRole::Owner,
    }
}

/// Leaves `account_id` ready with one writable personal Vault at `TEST_VAULT_ID`.
#[cfg(test)]
pub(crate) fn seed_ready_personal_vault(
    state: &InMemoryReplica,
    account_id: &AccountId,
) -> Result<(), RuntimeError> {
    let user_id = state
        .snapshot(account_id)
        .expect("seeded Account is installed")
        .user_id;
    state.seed_ready_personal_vault(account_id, personal_vault(TEST_VAULT_ID, &user_id))
}

/// One structurally valid accepted Operation, for tests about plan mechanics rather than crypto.
#[cfg(any(test, feature = "binding-test-harness"))]
pub(crate) fn test_operation(operation_id: &str, item_id: &str) -> OperationRecord {
    let body = format!(r#"{{"itemId":"{item_id}"}}"#).into_bytes();
    OperationRecord {
        operation_id: operation_id.to_owned(),
        kind: OperationKind::CreateItem,
        item_id: item_id.to_owned(),
        vault_id: TEST_VAULT_ID.to_owned(),
        request: ImmutableHttpRequest {
            method: HttpMethod::Put,
            path: format!("/api/v1/vaults/{TEST_VAULT_ID}/items/{item_id}"),
            headers: vec![HttpHeader {
                name: "Content-Type".to_owned(),
                value: "application/json".to_owned(),
            }],
            body: body.clone(),
        },
        request_fingerprint: Sha256Fingerprint::of_bytes(&body),
        attachment_move_recovery: None,
        scheduling: OperationSchedulingState::default(),
    }
}

/// The encrypted overlay half of `test_operation`. The ciphertext is opaque to plan mechanics.
#[cfg(test)]
pub(crate) fn test_overlay(
    account_id: AccountId,
    item_id: &str,
    operation_id: &str,
) -> ReplicaItemRecord {
    ReplicaItemRecord {
        account_id,
        item_id: item_id.to_owned(),
        vault_id: TEST_VAULT_ID.to_owned(),
        operation_id: operation_id.to_owned(),
        category: AuthorityItemCategory::Login,
        encrypted_data: format!("sealed-{item_id}"),
        encryption_iv: "AAAAAAAAAAAAAAAA".to_owned(),
        encryption_algorithm: "AES-GCM-AAD-V1".to_owned(),
        encryption_version: 1,
        encrypted_by_user_id: "user-1".to_owned(),
        favorite: false,
        version: 1,
        created_at: "2026-08-23T00:00:00Z".to_owned(),
        updated_at: "2026-08-23T00:00:00Z".to_owned(),
        deleted_at: None,
        attachments: Vec::new(),
        permanently_deleted: false,
    }
}
