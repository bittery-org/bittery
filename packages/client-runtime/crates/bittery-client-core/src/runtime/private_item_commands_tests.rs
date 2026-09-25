use super::*;
use crate::protocol::{DuplicateSourceGuard, PublicItemDraft};

fn real_credential(credential_byte: u8) -> crate::Passkey {
    let pair = bittery_crypto_core::generate_passkey_keypair().unwrap();
    crate::Passkey {
        credential_id: BASE64.encode([credential_byte; 32]),
        rp_id: "example.test".into(),
        rp_name: "Example".into(),
        user_handle: BASE64.encode(b"user-1"),
        user_name: "alice".into(),
        user_display_name: "Alice".into(),
        private_key: BASE64.encode(pair.private_key),
        public_key: BASE64.encode(&pair.public_key_cose),
        algorithm: -7,
        sign_count: 7,
        transports: vec!["internal".into()],
        created_at: "2026-09-22T00:00:00Z".into(),
        last_used_at: Some("2026-09-23T00:00:00Z".into()),
        status: Some(crate::PasskeyStatus::Active),
        status_reason: None,
        status_updated_at: None,
    }
}

fn seeded_login(passkeys: Vec<crate::Passkey>) -> Arc<RecordingExecutor> {
    let mut source = draft();
    let ItemDraft::Login(login) = &mut source else {
        unreachable!()
    };
    login.passkeys = passkeys;
    login.notes = Some("concurrent private metadata".into());
    RecordingExecutor::seeded_share_item(
        AuthorityItemCategory::Login,
        serde_json::to_value(login).unwrap(),
    )
}

fn remove_request(
    account_id: AccountId,
    item: &ItemProjection,
    passkey_index: usize,
) -> RuntimeRequest {
    let PublicItemDraft::Login(login) = &item.data else {
        unreachable!()
    };
    let selected = &login.passkeys[passkey_index];
    RuntimeRequest::RemovePasskey {
        account_id,
        item_id: item.item_id.clone(),
        guard: item.edit_guard.clone().unwrap(),
        rp_id: selected.rp_id.clone(),
        credential_id: selected.credential_id.clone(),
        public_key_fingerprint: selected.public_key_fingerprint.clone(),
    }
}

fn duplicate_request(account_id: AccountId, item: &ItemProjection, title: &str) -> RuntimeRequest {
    RuntimeRequest::DuplicateItem {
        account_id,
        source_item_id: item.item_id.clone(),
        source_guard: item.duplicate_source_guard.clone().unwrap(),
        title: title.into(),
    }
}

fn decrypted_overlay(runtime: &Runtime, account_id: &AccountId, item_id: &str) -> ItemDraft {
    let snapshot = runtime.replica().snapshot(account_id).unwrap();
    let overlay = snapshot
        .items
        .iter()
        .find(|row| row.item_id == item_id)
        .unwrap();
    let plaintext = decrypt_with_aad(
        &EncryptedData {
            ciphertext: overlay.encrypted_data.clone(),
            iv: overlay.encryption_iv.clone(),
            algorithm: overlay.encryption_algorithm.clone(),
        },
        &TEST_VAULT_KEY,
        &AadContext {
            vault_id: overlay.vault_id.clone(),
            entity_id: overlay.item_id.clone(),
            entity_type: "item".into(),
            version: overlay.encryption_version as u64,
            user_id: USER.into(),
        },
    )
    .unwrap();
    bootstrap::decode_item_plaintext(&plaintext, &overlay.category).unwrap()
}

#[tokio::test]
async fn removal_uses_exact_public_selection_and_keeps_sibling_private_metadata() {
    let removed = real_credential(42);
    let sibling = real_credential(43);
    let executor = seeded_login(vec![removed.clone(), sibling.clone()]);
    let (runtime, account_id) = unlocked_runtime(executor).await;
    let before = visible(&runtime, &account_id);
    let selection = &before.items[0];
    let PublicItemDraft::Login(public) = &selection.data else {
        unreachable!()
    };
    assert_eq!(public.passkeys.len(), 2);
    assert!(!serde_json::to_string(selection)
        .unwrap()
        .contains(&removed.private_key));
    assert_eq!(public.passkeys[0].public_key_fingerprint.len(), 64);

    let (operation_id, item_id, _) = accepted(
        runtime
            .request(
                remove_request(account_id.clone(), selection, 0),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    assert_eq!(item_id, "item-existing");
    let snapshot = runtime.replica().snapshot(&account_id).unwrap();
    let operation = snapshot
        .operations
        .iter()
        .find(|op| op.operation_id == operation_id)
        .unwrap();
    assert_eq!(operation.kind, OperationKind::UpdateItem);
    assert!(operation
        .request
        .headers
        .iter()
        .any(|header| header.name == "If-Match" && header.value == "\"1\""));
    let ItemDraft::Login(updated) = decrypted_overlay(&runtime, &account_id, &item_id) else {
        unreachable!()
    };
    assert!(updated.passkeys == vec![sibling.clone()]);
    assert_eq!(
        updated.notes.as_deref(),
        Some("concurrent private metadata")
    );
    assert_eq!(updated.title, TITLE);
    let key = BASE64.decode(&updated.passkeys[0].private_key).unwrap();
    let signature =
        bittery_crypto_core::sign_passkey_assertion(&key, &sibling.rp_id, &[23u8; 32], 8).unwrap();
    assert!(!signature.signature_der.is_empty());
    let remaining = visible(&runtime, &account_id);
    let PublicItemDraft::Login(login) = &remaining.items[0].data else {
        unreachable!()
    };
    assert_eq!(login.passkeys.len(), 1);
    assert_eq!(login.passkeys[0].credential_id, sibling.credential_id);
}

#[tokio::test]
async fn removal_refuses_replacement_stale_scope_ambiguity_and_pending_conflict() {
    let stored = real_credential(42);
    let executor = seeded_login(vec![stored.clone()]);
    let (runtime, account_id) = unlocked_runtime(executor).await;
    let selection = visible(&runtime, &account_id).items.remove(0);
    let base = remove_request(account_id.clone(), &selection, 0);
    let mut wrong_scope = base.clone();
    if let RuntimeRequest::RemovePasskey { rp_id, .. } = &mut wrong_scope {
        *rp_id = "other.test".into();
    }
    let mut replaced = base.clone();
    if let RuntimeRequest::RemovePasskey {
        public_key_fingerprint,
        ..
    } = &mut replaced
    {
        *public_key_fingerprint = "0".repeat(64);
    }
    let mut stale = base.clone();
    if let RuntimeRequest::RemovePasskey { guard, .. } = &mut stale {
        guard.item_version += 1;
    }
    let mut foreign = base.clone();
    if let RuntimeRequest::RemovePasskey { guard, .. } = &mut foreign {
        guard.vault_id = "vault-2".into();
    }
    let mut wrong_account = base.clone();
    if let RuntimeRequest::RemovePasskey { account_id, .. } = &mut wrong_account {
        *account_id = AccountId::from("other-account");
    }
    for request in [wrong_scope, replaced, stale, foreign, wrong_account] {
        assert!(runtime
            .request(request, RequestCancellation::new())
            .await
            .is_err());
        let snapshot = runtime.replica().snapshot(&account_id).unwrap();
        assert!(snapshot.operations.is_empty());
        assert!(snapshot.items.is_empty());
    }

    // An accepted same-Item owner cannot be rewritten by a stale removal selection.
    runtime
        .request(
            RuntimeRequest::SetItemFavorite {
                account_id: account_id.clone(),
                item_id: "item-existing".into(),
                favorite: true,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let before = runtime.replica().snapshot(&account_id).unwrap();
    assert!(runtime
        .request(base, RequestCancellation::new())
        .await
        .is_err());
    assert_eq!(runtime.replica().snapshot(&account_id).unwrap(), before);

    // Duplicate persisted identities are ambiguous even when all public selection fields match.
    let duplicate_executor = seeded_login(vec![stored.clone(), stored]);
    let (duplicate_runtime, duplicate_account) = unlocked_runtime(duplicate_executor).await;
    let duplicate_selection = visible(&duplicate_runtime, &duplicate_account)
        .items
        .remove(0);
    assert!(duplicate_runtime
        .request(
            remove_request(duplicate_account.clone(), &duplicate_selection, 0),
            RequestCancellation::new(),
        )
        .await
        .is_err());
    assert!(duplicate_runtime
        .replica()
        .snapshot(&duplicate_account)
        .unwrap()
        .operations
        .is_empty());
}

#[tokio::test]
async fn duplicate_keeps_real_credential_and_all_categories_in_same_vault() {
    let credential = real_credential(51);
    let mut login = draft();
    let ItemDraft::Login(data) = &mut login else {
        unreachable!()
    };
    data.passkeys.push(credential.clone());
    let cases = [
        (
            AuthorityItemCategory::Login,
            serde_json::to_value(data).unwrap(),
        ),
        (
            AuthorityItemCategory::SecureNote,
            serde_json::json!({"title":"Source","note":"private note","notes":"extra","tags":["tag"]}),
        ),
        (
            AuthorityItemCategory::CreditCard,
            serde_json::json!({"title":"Source","cardholderName":"Holder","cardNumber":"4111111111111111","cvv":"123","tags":["tag"]}),
        ),
        (
            AuthorityItemCategory::Identity,
            serde_json::json!({"title":"Source","firstName":"Ada","addresses":[{"id":"a","street":"Main","city":"X","state":"Y","zip":"123","country":"Z"}]}),
        ),
        (
            AuthorityItemCategory::Totp,
            serde_json::json!({"title":"Source","totpSecret":"secret","linkedItemId":"other-item","tags":["tag"]}),
        ),
    ];
    for (category, plaintext) in cases {
        let executor = RecordingExecutor::seeded_share_item(category.clone(), plaintext.clone());
        let (runtime, account_id) = unlocked_runtime(executor).await;
        let selection = visible(&runtime, &account_id).items.remove(0);
        let source_guard = selection.duplicate_source_guard.clone().unwrap();
        assert!(matches!(
            source_guard.source,
            DuplicateSourceGuard::Authoritative { item_version: 1 }
        ));
        let (_, new_id, _) = accepted(
            runtime
                .request(
                    duplicate_request(account_id.clone(), &selection, "Source copy"),
                    RequestCancellation::new(),
                )
                .await
                .unwrap(),
        );
        assert_ne!(new_id, "item-existing");
        let snapshot = runtime.replica().snapshot(&account_id).unwrap();
        let operation = snapshot
            .operations
            .iter()
            .find(|op| op.item_id() == new_id)
            .unwrap();
        assert_eq!(operation.kind, OperationKind::CreateItem);
        assert_eq!(operation.target.vault_id(), TEST_VAULT_ID);
        let overlay = snapshot
            .items
            .iter()
            .find(|row| row.item_id == new_id)
            .unwrap();
        assert!(overlay.attachments.is_empty());
        assert!(overlay.deleted_at.is_none());
        let duplicated = decrypted_overlay(&runtime, &account_id, &new_id);
        let mut expected = plaintext.clone();
        expected["title"] = serde_json::json!("Source copy");
        assert!(
            serde_json::to_value(&duplicated).unwrap()["data"] == expected,
            "Duplicate changed private Item data for {category:?}"
        );
        if let ItemDraft::Login(duplicated_login) = duplicated {
            assert!(duplicated_login.passkeys == vec![credential.clone()]);
            let key = BASE64
                .decode(&duplicated_login.passkeys[0].private_key)
                .unwrap();
            assert!(!bittery_crypto_core::sign_passkey_assertion(
                &key,
                &credential.rp_id,
                &[3u8; 32],
                8
            )
            .unwrap()
            .signature_der
            .is_empty());
        }
    }
}

#[tokio::test]
async fn duplicate_uses_exact_readable_overlay_owner_and_refuses_stale_source() {
    let credential = real_credential(52);
    let executor = seeded_login(vec![credential.clone()]);
    let (runtime, account_id) = unlocked_runtime(executor.clone()).await;
    let original = visible(&runtime, &account_id).items.remove(0);
    let stale_authoritative = duplicate_request(account_id.clone(), &original, "Old copy");
    let mut edited = draft();
    let ItemDraft::Login(edited_login) = &mut edited else {
        unreachable!()
    };
    edited_login.title = "New source title".into();
    runtime
        .request(
            RuntimeRequest::UpdateItem {
                account_id: account_id.clone(),
                item_id: "item-existing".into(),
                guard: original.edit_guard.clone().unwrap(),
                draft: edited,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let pending = visible(&runtime, &account_id).items.remove(0);
    assert_eq!(pending.status, ItemProjectionStatus::Pending);
    let pending_guard = pending.duplicate_source_guard.clone().unwrap();
    assert!(matches!(
        &pending_guard.source,
        DuplicateSourceGuard::AcceptedOverlay { .. }
    ));
    let before = runtime.replica().snapshot(&account_id).unwrap();
    assert!(runtime
        .request(stale_authoritative, RequestCancellation::new())
        .await
        .is_err());
    assert_eq!(runtime.replica().snapshot(&account_id).unwrap(), before);

    let (_, new_id, _) = accepted(
        runtime
            .request(
                duplicate_request(account_id.clone(), &pending, "Pending copy"),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    let ItemDraft::Login(copy) = decrypted_overlay(&runtime, &account_id, &new_id) else {
        unreachable!()
    };
    assert_eq!(copy.title, "Pending copy");
    assert!(copy.passkeys == vec![credential]);

    // Any intervening Replica revision or overlay owner substitution invalidates the old guard.
    let current = runtime.replica().snapshot(&account_id).unwrap();
    assert!(runtime
        .request(
            duplicate_request(account_id.clone(), &pending, "Stale copy"),
            RequestCancellation::new(),
        )
        .await
        .is_err());
    assert_eq!(runtime.replica().snapshot(&account_id).unwrap(), current);
}

#[tokio::test]
async fn duplicate_reads_a_failed_overlay_without_inventing_confirmed_authority() {
    let credential = real_credential(53);
    let executor = seeded_login(vec![credential.clone()]);
    let (runtime, account_id) = unlocked_runtime(executor).await;
    let original = visible(&runtime, &account_id).items.remove(0);
    let mut edited = draft();
    let ItemDraft::Login(edited_login) = &mut edited else {
        unreachable!()
    };
    edited_login.title = "Failed local title".into();
    let (operation_id, _, _) = accepted(
        runtime
            .request(
                RuntimeRequest::UpdateItem {
                    account_id: account_id.clone(),
                    item_id: "item-existing".into(),
                    guard: original.edit_guard.clone().unwrap(),
                    draft: edited,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    commit_move_mutation(
        &runtime,
        &account_id,
        PlanMutation::RemoveOperation { operation_id },
    )
    .await
    .unwrap();
    runtime.decrypt_visible_items(&account_id).unwrap();
    let failed = visible(&runtime, &account_id).items.remove(0);
    assert_eq!(failed.status, ItemProjectionStatus::Failed);
    assert!(failed.edit_guard.is_none());
    assert!(matches!(
        failed.duplicate_source_guard.as_ref().unwrap().source,
        DuplicateSourceGuard::AcceptedOverlay { .. }
    ));
    let before_refused_edit = runtime.replica().snapshot(&account_id).unwrap();
    assert!(runtime
        .request(
            RuntimeRequest::UpdateItem {
                account_id: account_id.clone(),
                item_id: "item-existing".into(),
                guard: original.edit_guard.clone().unwrap(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .is_err());
    assert_eq!(
        runtime.replica().snapshot(&account_id).unwrap(),
        before_refused_edit
    );
    let mut foreign_owner = duplicate_request(account_id.clone(), &failed, "Wrong");
    if let RuntimeRequest::DuplicateItem { source_guard, .. } = &mut foreign_owner {
        source_guard.source = DuplicateSourceGuard::AcceptedOverlay {
            operation_id: "other-operation".into(),
        };
    }
    assert!(runtime
        .request(foreign_owner, RequestCancellation::new())
        .await
        .is_err());
    let (_, new_id, _) = accepted(
        runtime
            .request(
                duplicate_request(account_id.clone(), &failed, "Failed copy"),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    let ItemDraft::Login(copy) = decrypted_overlay(&runtime, &account_id, &new_id) else {
        unreachable!()
    };
    assert_eq!(copy.title, "Failed copy");
    assert!(copy.passkeys == vec![credential]);
}

#[tokio::test]
async fn duplicate_accepts_readable_trashed_source_and_refuses_wrong_guard_scope() {
    let executor = RecordingExecutor::seeded_category_item(
        AuthorityItemCategory::SecureNote,
        serde_json::json!({"title":"Deleted","note":"preserve"}),
        true,
    );
    let (runtime, account_id) = unlocked_runtime(executor).await;
    let selection = visible(&runtime, &account_id).items.remove(0);
    assert!(selection.deleted_at.is_some());
    let guard = selection.duplicate_source_guard.clone().unwrap();
    let mut wrong_account = guard.clone();
    wrong_account.account_id = "other-account".into();
    let mut wrong_incarnation = guard.clone();
    wrong_incarnation.incarnation_id = "other-incarnation".into();
    let mut wrong_epoch = guard.clone();
    wrong_epoch.lock_epoch += 1;
    let mut wrong_item = guard.clone();
    wrong_item.source_item_id = "other-item".into();
    let mut wrong_vault = guard.clone();
    wrong_vault.vault_id = "vault-2".into();
    let mut wrong_version = guard.clone();
    let DuplicateSourceGuard::Authoritative { item_version } = &mut wrong_version.source else {
        unreachable!()
    };
    *item_version += 1;
    for changed in [
        wrong_account,
        wrong_incarnation,
        wrong_epoch,
        wrong_item,
        wrong_vault,
        wrong_version,
    ] {
        let mut request = duplicate_request(account_id.clone(), &selection, "Wrong");
        let RuntimeRequest::DuplicateItem { source_guard, .. } = &mut request else {
            unreachable!()
        };
        *source_guard = changed;
        let before = runtime.replica().snapshot(&account_id).unwrap();
        assert!(runtime
            .request(request, RequestCancellation::new())
            .await
            .is_err());
        assert_eq!(runtime.replica().snapshot(&account_id).unwrap(), before);
    }
    let mut wrong_request_item = duplicate_request(account_id.clone(), &selection, "Wrong");
    let RuntimeRequest::DuplicateItem { source_item_id, .. } = &mut wrong_request_item else {
        unreachable!()
    };
    *source_item_id = "other-item".into();
    assert!(runtime
        .request(wrong_request_item, RequestCancellation::new())
        .await
        .is_err());
    let (_, new_id, _) = accepted(
        runtime
            .request(
                duplicate_request(account_id.clone(), &selection, "Copy"),
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
    );
    let copy = decrypted_overlay(&runtime, &account_id, &new_id);
    assert_eq!(copy.title(), "Copy");
    assert!(runtime
        .replica()
        .snapshot(&account_id)
        .unwrap()
        .items
        .iter()
        .find(|row| row.item_id == new_id)
        .unwrap()
        .deleted_at
        .is_none());
}
