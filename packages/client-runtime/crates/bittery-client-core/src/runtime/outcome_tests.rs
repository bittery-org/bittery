//! Slice C: turning "the Server answered something" into local completion.
//!
//! These tests assert effects on both sides. The fake Server counts Item rows and keeps one
//! final-only outcome per `(User, Operation ID)`; the Replica is asked what a reader would see.
//! Exactly-once is the conjunction of the two: one Item row on the Server, one visible Item and
//! one completed receipt locally, however many times the bytes were sent.

use super::operation_fixtures::*;
use super::*;
use crate::replica::{
    OperationOutcomeResult, OperationRejectionCode, ReplicaItemRecord, ReplicaSnapshot,
};
use crate::test_fixtures::TEST_VAULT_ID;
use async_trait::async_trait;

#[derive(Clone, Copy, Debug)]
enum OrdinaryItemCase {
    Update,
    Favorite,
    Trash,
    Restore,
    Move,
    PermanentlyDelete,
}

impl OrdinaryItemCase {
    const ALL: [Self; 6] = [
        Self::Update,
        Self::Favorite,
        Self::Trash,
        Self::Restore,
        Self::Move,
        Self::PermanentlyDelete,
    ];

    fn kind(self) -> crate::replica::OperationKind {
        use crate::replica::OperationKind;
        match self {
            Self::Update => OperationKind::UpdateItem,
            Self::Favorite => OperationKind::SetItemFavorite,
            Self::Trash => OperationKind::TrashItem,
            Self::Restore => OperationKind::RestoreItem,
            Self::Move => OperationKind::MoveItem,
            Self::PermanentlyDelete => OperationKind::PermanentlyDeleteItem,
        }
    }

    fn wire_kind(self) -> &'static str {
        match self {
            Self::Update => "update_item",
            Self::Favorite => "set_item_favorite",
            Self::Trash => "trash_item",
            Self::Restore => "restore_item",
            Self::Move => "move_item",
            Self::PermanentlyDelete => "permanently_delete_item",
        }
    }

    fn needs_deleted_authority(self) -> bool {
        matches!(self, Self::Restore | Self::PermanentlyDelete)
    }

    fn request(self, account_id: AccountId) -> RuntimeRequest {
        match self {
            Self::Update => RuntimeRequest::UpdateItem {
                guard: crate::ItemEditGuard::test_fixture(account_id.clone(), "item-existing"),
                account_id,
                item_id: "item-existing".into(),
                draft: draft(),
            },
            Self::Favorite => RuntimeRequest::SetItemFavorite {
                account_id,
                item_id: "item-existing".into(),
                favorite: true,
            },
            Self::Trash => RuntimeRequest::TrashItem {
                account_id,
                item_id: "item-existing".into(),
            },
            Self::Restore => RuntimeRequest::RestoreItem {
                account_id,
                item_id: "item-existing".into(),
            },
            Self::Move => RuntimeRequest::MoveItem {
                account_id,
                item_id: "item-existing".into(),
                target_vault_id: "vault-2".into(),
                target_account_id: None,
            },
            Self::PermanentlyDelete => RuntimeRequest::PermanentlyDeleteItem {
                account_id,
                item_id: "item-existing".into(),
            },
        }
    }

    fn allowed_rejections(self) -> &'static [&'static str] {
        match self {
            Self::Update | Self::Trash => &[
                "invalid_ciphertext",
                "vault_access_denied",
                "vault_read_only",
                "item_not_found",
                "item_version_conflict",
            ],
            Self::Favorite => &[
                "vault_access_denied",
                "vault_read_only",
                "item_not_found",
                "item_version_conflict",
            ],
            Self::Restore | Self::PermanentlyDelete => &[
                "invalid_ciphertext",
                "vault_access_denied",
                "vault_read_only",
                "item_not_found",
                "item_not_trashed",
                "item_version_conflict",
            ],
            Self::Move => &[
                "invalid_ciphertext",
                "vault_access_denied",
                "vault_read_only",
                "item_not_found",
                "source_vault_mismatch",
                "item_trashed",
                "target_vault_access_denied",
                "target_vault_read_only",
                "item_version_conflict",
                "attachment_state_conflict",
            ],
        }
    }
}

fn ordinary_applied_body(operation_id: &str, kind: &str, version: i32) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "operationId": operation_id,
        "kind": kind,
        "result": {
            "status": "applied",
            "itemId": "item-existing",
            "version": version,
        },
    }))
    .unwrap()
}

fn ordinary_rejected_body(operation_id: &str, kind: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "operationId": operation_id,
        "kind": kind,
        "result": { "status": "rejected", "code": "item_not_found" },
    }))
    .unwrap()
}

fn attachment_authority_json(item_id: &str, vault_id: &str) -> serde_json::Value {
    serde_json::json!({
        "id": "attachment-current",
        "itemId": item_id,
        "vaultId": vault_id,
        "storageKey": format!("attachments/{item_id}/attachment-current.enc"),
        "encryptedName": "encrypted-name",
        "encryptionIv": "name-iv",
        "encryptionAlgorithm": "AES-256-GCM",
        "encryptedAttachmentKey": "encrypted-key",
        "attachmentKeyIv": "key-iv",
        "attachmentKeyAlgorithm": "AES-256-GCM",
        "encryptedContentType": "encrypted-content-type",
        "encryptedContentTypeIv": "content-type-iv",
        "envelopeVersion": 1,
        "fileSize": 17,
        "uploadedBy": USER,
        "createdAt": "2026-08-30T00:00:00Z"
    })
}

#[tokio::test]
async fn each_ordinary_item_kind_accepts_its_exact_tagged_applied_outcome() {
    for case in OrdinaryItemCase::ALL {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        let operation = harness.operation().expect("the Operation was accepted");
        let body = serde_json::to_vec(&serde_json::json!({
            "operationId": operation.operation_id,
            "kind": case.wire_kind(),
            "result": {
                "status": "applied",
                "itemId": operation.item_id(),
                "version": 2,
            },
        }))
        .unwrap();

        assert!(
            matches!(
                harness.runtime.read_dispatch_answer(&operation, 200, &body),
                super::outcome::SemanticAnswer::Outcome(crate::replica::ObservedOutcome {
                    result: OperationOutcomeResult::Applied { version: 2, .. },
                    ..
                })
            ),
            "{case:?} must read its own closed outcome kind"
        );
        assert_eq!(operation.kind, case.kind());
    }
}

#[tokio::test]
async fn retained_item_result_preserves_a_later_visible_server_version() {
    let harness = seeded_with_existing_item(false, false).await;
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Favorite.request(harness.account_id.clone()))
        .await;
    harness.server.lose_next_response();
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    assert_eq!(harness.snapshot().operations.len(), 1);
    {
        // A later client changes the unencrypted favorite flag. The Server Item revision
        // advances independently from its unchanged ciphertext/encryption revision.
        let mut items = harness.server.created_items.lock().unwrap();
        assert_eq!(items[0].version, 2);
        items[0].version = 3;
        items[0].favorite = false;
    }
    harness.clock.advance(1_000);
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let snapshot = harness.snapshot();
    assert_eq!(
        snapshot.failure, None,
        "a later edit does not contradict the old result"
    );
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.items.is_empty());
    assert_eq!(snapshot.receipts.len(), 1);
    assert_eq!(
        snapshot.receipts[0].result,
        OperationOutcomeResult::Applied {
            entity_id: "item-existing".into(),
            version: 2,
        }
    );
    let authority = harness.authority_items();
    assert_eq!(authority[0].version, 3);
    assert!(!authority[0].favorite);
    assert_eq!(
        harness.server.created_items.lock().unwrap()[0].version,
        3,
        "replay never reapplies the old edit"
    );
}

#[tokio::test]
async fn retained_item_result_preserves_a_later_move_into_another_visible_vault() {
    let harness = seeded_with_existing_item(false, false).await;
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Favorite.request(harness.account_id.clone()))
        .await;
    harness.server.lose_next_response();
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let encrypted = bittery_crypto_core::encrypt_with_aad(
        &super::create::item_plaintext(&draft()).unwrap(),
        &crate::test_fixtures::TEST_VAULT_KEY,
        &bittery_crypto_core::AadContext {
            vault_id: "vault-2".into(),
            entity_id: "item-existing".into(),
            entity_type: "item".into(),
            version: 3,
            user_id: USER.into(),
        },
    )
    .unwrap();
    {
        let mut items = harness.server.created_items.lock().unwrap();
        items[0].version = 3;
        items[0].vault_id = "vault-2".into();
        items[0].encryption_version = 3;
        items[0].encrypted_data = encrypted.ciphertext;
        items[0].encryption_iv = encrypted.iv;
        items[0].encryption_algorithm = encrypted.algorithm;
    }
    harness.clock.advance(1_000);
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let snapshot = harness.snapshot();
    assert_eq!(
        snapshot.failure, None,
        "later visible location is current authority"
    );
    assert!(snapshot.operations.is_empty());
    assert_eq!(
        snapshot.receipts[0].vault_id(),
        TEST_VAULT_ID,
        "the original accepted scope remains in the receipt"
    );
    let authority = harness.authority_items();
    assert_eq!(authority[0].version, 3);
    assert_eq!(authority[0].vault_id, "vault-2");
}

#[tokio::test]
async fn retained_item_completion_cannot_rebase_over_a_concurrent_current_authority_commit() {
    use crate::replica::{Replica, SerializedReplicaPersistence};

    struct ConcurrentAuthorityReplica {
        inner: Arc<PlainReplica>,
        item: Mutex<Option<crate::replica::AuthorityItemRecord>>,
        account_id: AccountId,
    }
    #[async_trait]
    impl crate::replica::SerializedReplicaExecutor for ConcurrentAuthorityReplica {
        async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
            let parsed: crate::replica::ReplicaPersistenceRequest =
                serde_json::from_str(&request).unwrap();
            let replacement = if matches!(
                parsed,
                crate::replica::ReplicaPersistenceRequest::Commit { .. }
            ) {
                self.item.lock().unwrap().take()
            } else {
                None
            };
            if let Some(item) = replacement {
                // Another physical writer installs a newer verified Item after this completion
                // prepared its response, but before its physical guarded commit reaches storage.
                let other = Replica::new(Arc::new(SerializedReplicaPersistence::new(
                    self.inner.clone(),
                )));
                let snapshot = other.load(&self.account_id).await?.unwrap();
                let result = other
                    .apply_sync_item_authority(
                        crate::replica::BootstrapGuard {
                            account_id: self.account_id.clone(),
                            user_id: snapshot.user_id,
                            incarnation: snapshot.incarnation,
                            expected_replica_revision: snapshot.revision,
                            expected_lock_epoch: snapshot.lock_epoch,
                        },
                        snapshot.bootstrap.active_cursor,
                        item.id.clone(),
                        Some(item),
                    )
                    .await?;
                assert!(matches!(result, PlanResult::Applied { .. }));
            }
            crate::replica::SerializedReplicaExecutor::invoke(self.inner.as_ref(), request).await
        }
    }
    for corrupt in [false, true] {
        let harness = seeded_with_existing_item(false, false).await;
        let (operation_id, _) = harness
            .accept_existing(OrdinaryItemCase::Favorite.request(harness.account_id.clone()))
            .await;
        harness.server.lose_next_response();
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        if corrupt {
            harness.server.created_items.lock().unwrap()[0].encrypted_data =
                "corrupt-current-ciphertext".into();
        } else {
            harness.server.created_items.lock().unwrap().clear();
        }
        let persistence = Arc::new(ConcurrentAuthorityReplica {
            inner: harness.replica.clone(),
            item: Mutex::new(None),
            account_id: harness.account_id.clone(),
        });
        let runtime = Runtime::with_test_dispatch_environment(
            persistence.clone(),
            harness.platform.clone(),
            harness.server.clone(),
            auth_config(),
            harness.clock.clone(),
            TestTimer::advancing(harness.clock.clone()),
        );
        runtime.replica.load(&harness.account_id).await.unwrap();
        runtime.unlock_account(&harness.account_id).await.unwrap();
        let mut newer = harness.authority_items()[0].clone();
        newer.version = 3;
        newer.favorite = false;
        *persistence.item.lock().unwrap() = Some(newer.clone());
        harness.clock.advance(1_000);
        runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        let snapshot = runtime
            .replica
            .load(&harness.account_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            snapshot.bootstrap.snapshot().visible_items,
            vec![newer],
            "a stale response never erases a newer physical commit"
        );
        assert_eq!(
            snapshot.operations.len(),
            1,
            "a stale completion remains owed"
        );
        assert!(snapshot.receipts.is_empty());
        assert_eq!(
            snapshot.failure, None,
            "a stale response cannot fail a newer head; corrupt={corrupt}"
        );
    }
}

#[tokio::test]
async fn retained_item_result_receipts_hidden_authority_without_decrypting_or_reinstalling_it() {
    for rejected in [false, true] {
        let harness = seeded_with_existing_item(false, false).await;
        let (operation_id, _) = harness
            .accept_existing(OrdinaryItemCase::Favorite.request(harness.account_id.clone()))
            .await;
        if rejected {
            harness.server.reject_next("item_version_conflict");
        }
        harness.server.lose_next_response();
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        let snapshot = harness.snapshot();
        harness
            .runtime
            .replica
            .execute_exact(GuardedCommitPlan::new(
                harness.account_id.clone(),
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::RetireVaults {
                    vault_ids: vec![TEST_VAULT_ID.into()],
                }],
            ))
            .await
            .unwrap();
        // Retired ciphertext is not current key authority, even though the point endpoint still
        // returns it. The completion must not try to decrypt or install this unavailable Item.
        harness.server.created_items.lock().unwrap()[0].encrypted_data = "not-decryptable".into();
        harness.clock.advance(1_000);
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;

        let snapshot = harness.snapshot();
        assert_eq!(
            snapshot.failure, None,
            "hidden response is never decrypted using retained material"
        );
        assert!(snapshot.operations.is_empty());
        assert!(snapshot.items.is_empty());
        assert_eq!(snapshot.receipts.len(), 1);
        assert_eq!(
            snapshot.bootstrap.state,
            crate::replica::ReplicaState::RefreshRequired
        );
        assert_eq!(
            snapshot.bootstrap.pending_vault_retirements,
            vec![TEST_VAULT_ID]
        );
        assert!(harness.authority_items().is_empty());
        assert_eq!(
            snapshot.bootstrap.snapshot().visible_vaults[0].id,
            "vault-2"
        );
    }
}

#[tokio::test]
async fn all_six_ordinary_item_outcomes_reconcile_authority_overlay_and_validator_atomically() {
    for case in OrdinaryItemCase::ALL {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        let authority_before = harness.authority_items();
        let (operation_id, item_id) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;

        let snapshot = harness.snapshot();
        assert!(snapshot.operations.is_empty(), "{case:?} Operation ended");
        assert!(snapshot.items.is_empty(), "{case:?} overlay was removed");
        assert_eq!(snapshot.receipts.len(), 1, "{case:?} retained one receipt");
        let receipt = &snapshot.receipts[0];
        assert_eq!(receipt.operation_id, operation_id);
        assert_eq!(receipt.kind, case.kind());
        assert_eq!(receipt.item_id(), item_id);
        assert_eq!(
            receipt.result,
            OperationOutcomeResult::Applied {
                entity_id: "item-existing".into(),
                version: 2,
            },
            "{case:?} receipt carries the retained Item validator"
        );
        let authority = harness.authority_items();
        if matches!(case, OrdinaryItemCase::PermanentlyDelete) {
            assert_eq!(
                authority, authority_before,
                "retained deletion receipts before fresh current authority"
            );
            assert_eq!(
                snapshot.bootstrap.state,
                crate::replica::ReplicaState::RefreshRequired
            );
        } else {
            assert_eq!(authority.len(), 1, "{case:?} writes one authority");
            assert_eq!(authority[0].id, "item-existing");
            assert_eq!(authority[0].version, 2);
            if matches!(case, OrdinaryItemCase::Move) {
                assert_eq!(authority[0].vault_id, "vault-2");
            }
        }
    }
}

#[tokio::test]
async fn locked_item_outcomes_retain_work_until_authority_can_be_validated_after_unlock() {
    for (create, rejected) in [(false, false), (true, false), (false, true)] {
        let harness = if create {
            seeded(false).await
        } else {
            seeded_with_existing_item(false, false).await
        };
        if rejected {
            harness.server.reject_next("item_version_conflict");
        }
        let (operation_id, _) = if create {
            harness.accept_create().await
        } else {
            harness
                .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
                .await
        };
        let accepted = harness.operation().unwrap();
        harness
            .runtime
            .request(
                RuntimeRequest::Lock {
                    account_id: harness.account_id.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        let locked = harness.snapshot();
        assert_eq!(
            locked.failure, None,
            "missing live keys are a lifecycle state, not corruption"
        );
        assert_eq!(locked.operations.len(), 1);
        assert_eq!(locked.operations[0].request, accepted.request);
        assert!(locked.receipts.is_empty());
        harness
            .runtime
            .unlock_account(&harness.account_id)
            .await
            .unwrap();
        harness.clock.advance(1_000);
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        let completed = harness.snapshot();
        assert_eq!(completed.failure, None);
        assert!(completed.operations.is_empty());
        assert_eq!(completed.receipts[0].operation_id, operation_id);
        assert_eq!(
            harness.authority_items()[0].vault_id,
            if create || rejected {
                TEST_VAULT_ID
            } else {
                "vault-2"
            }
        );
        assert_eq!(
            matches!(
                completed.receipts[0].result,
                OperationOutcomeResult::Rejected { .. }
            ),
            rejected
        );
    }
}

#[tokio::test]
async fn every_category_dispatches_validates_and_reconciles_its_authoritative_projection() {
    use crate::{
        AuthenticatorItemData, CreditCardItemData, IdentityItemData, ItemDraft, LoginItemData,
        SecureNoteItemData,
    };
    let drafts = vec![
        ItemDraft::Login(LoginItemData {
            title: "Login".into(),
            url: None,
            urls: vec![],
            username: Some("user".into()),
            password: Some("password".into()),
            password_history: vec![],
            passkeys: vec![],
            notes: None,
            note: None,
            custom_fields: vec![],
            tags: vec![],
            totp_secret: None,
            totp_issuer: None,
            totp_account_name: None,
            totp_algorithm: None,
            totp_digits: None,
            totp_period: None,
        }),
        ItemDraft::SecureNote(SecureNoteItemData {
            title: "Note".into(),
            note: "Body".into(),
            notes: None,
            custom_fields: vec![],
            tags: vec![],
        }),
        ItemDraft::CreditCard(CreditCardItemData {
            title: "Card".into(),
            cardholder_name: Some("Holder".into()),
            card_number: Some("4111".into()),
            cvv: Some("123".into()),
            expiry_date: Some("12/30".into()),
            billing_address: None,
            notes: None,
            custom_fields: vec![],
            totp_secret: None,
            totp_issuer: None,
            totp_account_name: None,
            totp_algorithm: None,
            totp_digits: None,
            totp_period: None,
            tags: vec![],
        }),
        ItemDraft::Identity(IdentityItemData {
            title: "Identity".into(),
            first_name: Some("First".into()),
            middle_name: None,
            last_name: None,
            email: None,
            addresses: vec![],
            phone_numbers: vec![],
            ssn: None,
            passport_number: None,
            drivers_license: None,
            date_of_birth: None,
            notes: None,
            custom_fields: vec![],
            totp_secret: None,
            totp_issuer: None,
            totp_account_name: None,
            totp_algorithm: None,
            totp_digits: None,
            totp_period: None,
            tags: vec![],
        }),
        ItemDraft::Authenticator(AuthenticatorItemData {
            title: "Authenticator".into(),
            totp_secret: "secret".into(),
            totp_issuer: None,
            totp_account_name: None,
            totp_algorithm: None,
            totp_digits: Some(crate::TotpDigits::Six),
            totp_period: Some(30),
            linked_item_id: Some("login-id".into()),
            notes: None,
            custom_fields: vec![],
            tags: vec![],
        }),
    ];
    for draft in drafts {
        let harness = seeded(false).await;
        let response = harness
            .runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: harness.account_id.clone(),
                    vault_id: TEST_VAULT_ID.into(),
                    draft: draft.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let RuntimeResponse::Accepted { operation_id, .. } = response else {
            panic!("expected Accepted")
        };
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        let visible = harness.visible_items();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].data, crate::PublicItemDraft::from(&draft));
        assert_eq!(visible[0].status, ItemProjectionStatus::Authoritative);
        assert!(harness.snapshot().operations.is_empty());
        assert!(harness.snapshot().items.is_empty());
    }
}

#[tokio::test]
async fn applied_move_reconciles_authoritative_target_attachments_with_the_receipt() {
    let harness = seeded_with_existing_item(false, false).await;
    harness
        .server
        .set_attachment_authority(vec![attachment_authority_json("item-existing", "vault-2")]);
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
        .await;

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let snapshot = harness.snapshot();
    assert!(snapshot.operations.is_empty());
    assert_eq!(snapshot.receipts.len(), 1);
    let authority = harness.authority_items();
    assert_eq!(authority.len(), 1);
    assert_eq!(authority[0].vault_id, "vault-2");
    assert_eq!(authority[0].attachments.len(), 1);
    assert_eq!(authority[0].attachments[0].id, "attachment-current");
    assert_eq!(authority[0].attachments[0].item_id, "item-existing");
    assert_eq!(authority[0].attachments[0].vault_id, "vault-2");
}

#[tokio::test]
async fn every_rejected_move_reconciles_current_authoritative_attachments_with_its_receipt() {
    for &code in OrdinaryItemCase::Move.allowed_rejections() {
        let harness = seeded_with_existing_item(false, false).await;
        harness.server.reject_next(code);
        harness
            .server
            .set_attachment_authority(vec![attachment_authority_json(
                "item-existing",
                TEST_VAULT_ID,
            )]);
        let (operation_id, _) = harness
            .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
            .await;

        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;

        let snapshot = harness.snapshot();
        assert!(snapshot.operations.is_empty(), "{code}");
        assert_eq!(snapshot.receipts.len(), 1, "{code}");
        assert!(
            matches!(
                snapshot.receipts[0].result,
                OperationOutcomeResult::Rejected { .. }
            ),
            "{code}"
        );
        let authority = harness.authority_items();
        assert_eq!(authority.len(), 1, "{code}");
        assert_eq!(authority[0].vault_id, TEST_VAULT_ID, "{code}");
        assert_eq!(authority[0].attachments.len(), 1, "{code}");
        assert_eq!(
            authority[0].attachments[0].id, "attachment-current",
            "{code}"
        );
        assert_eq!(
            authority[0].attachments[0].item_id, "item-existing",
            "{code}"
        );
        assert_eq!(
            authority[0].attachments[0].vault_id, TEST_VAULT_ID,
            "{code}"
        );
    }
}

#[tokio::test]
async fn item_renewal_consumes_the_move_outcome_attempt_budget_before_attachment_authority() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.reject_next("attachment_state_conflict");
    harness
        .server
        .set_attachment_authority(vec![attachment_authority_json(
            "item-existing",
            TEST_VAULT_ID,
        )]);
    harness.server.script_item_faults([Fault::Status(401)]);
    harness
        .server
        .script_attachment_faults([Some(Fault::Status(401))]);
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
        .await;

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let retained = harness.snapshot();
    assert_eq!(retained.operations.len(), 1);
    assert_eq!(retained.operations[0].operation_id, operation_id);
    assert_eq!(retained.items.len(), 1);
    assert!(retained.receipts.is_empty());
    assert_eq!(
        harness.waiting_reason(),
        Some(AccountWaitingReason::ReauthenticationRequired)
    );
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.authority_items()[0].attachments.len(), 0);
    let stored = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &retained.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.token.as_ref(), SECOND_TOKEN);
}

#[tokio::test]
async fn dispatch_renewal_consumes_the_move_outcome_attempt_budget_before_item_authority() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.reject_next("attachment_state_conflict");
    harness.server.script([Fault::Status(401)]);
    harness.server.script_item_faults([Fault::Status(401)]);
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
        .await;

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let retained = harness.snapshot();
    assert_eq!(retained.operations.len(), 1);
    assert_eq!(retained.operations[0].operation_id, operation_id);
    assert_eq!(retained.items.len(), 1);
    assert!(retained.receipts.is_empty());
    assert_eq!(
        harness.waiting_reason(),
        Some(AccountWaitingReason::ReauthenticationRequired)
    );
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.item_calls.load(Ordering::SeqCst), 1);
    let stored = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &retained.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.token.as_ref(), SECOND_TOKEN);
}

#[tokio::test]
async fn lookup_renewal_consumes_the_move_outcome_attempt_budget_before_attachment_authority() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.reject_next("attachment_state_conflict");
    harness.server.lose_next_response();
    harness
        .server
        .set_attachment_authority(vec![attachment_authority_json(
            "item-existing",
            TEST_VAULT_ID,
        )]);
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    harness
        .server
        .outcome_faults
        .lock()
        .unwrap()
        .push_back(Fault::Status(401));
    harness
        .server
        .script_attachment_faults([Some(Fault::Status(401))]);
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let retained = harness.snapshot();
    assert_eq!(retained.operations.len(), 1);
    assert_eq!(retained.operations[0].operation_id, operation_id);
    assert!(retained.receipts.is_empty());
    assert_eq!(
        harness.waiting_reason(),
        Some(AccountWaitingReason::ReauthenticationRequired)
    );
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.outcome_lookups(), 2);
    let stored = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &retained.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.token.as_ref(), SECOND_TOKEN);
}

#[tokio::test]
async fn applied_move_attachment_authority_renews_on_a_later_page_and_persists_the_session() {
    let harness = seeded_with_existing_item(false, false).await;
    let attachment = serde_json::json!({
        "id": "attachment-moved",
        "itemId": "item-existing",
        "vaultId": "vault-2",
        "storageKey": "attachments/item-existing/attachment-moved.enc",
        "encryptedName": "encrypted-name",
        "encryptionIv": "name-iv",
        "encryptionAlgorithm": "AES-256-GCM",
        "encryptedAttachmentKey": "encrypted-key",
        "attachmentKeyIv": "key-iv",
        "attachmentKeyAlgorithm": "AES-256-GCM",
        "encryptedContentType": "encrypted-content-type",
        "encryptedContentTypeIv": "content-type-iv",
        "envelopeVersion": 1,
        "fileSize": 17,
        "uploadedBy": USER,
        "createdAt": "2026-08-30T00:00:00Z"
    });
    harness
        .server
        .script_attachment_page(vec![attachment], Some("attachment-page-2"));
    harness.server.script_attachment_page(Vec::new(), None);
    harness
        .server
        .script_attachment_faults([None, Some(Fault::Status(401)), None]);
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
        .await;

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let snapshot = harness.snapshot();
    assert!(snapshot.operations.is_empty());
    assert_eq!(snapshot.receipts.len(), 1);
    assert_eq!(harness.authority_items()[0].attachments.len(), 1);
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    let attachment_requests: Vec<_> = harness
        .server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.url.contains("/attachments?"))
        .cloned()
        .collect();
    assert_eq!(attachment_requests.len(), 3);
    assert_eq!(
        attachment_requests[0].url,
        "https://vault.example.test/api/v1/items/item-existing/attachments?limit=500"
    );
    assert_eq!(
        attachment_requests[1].url,
        "https://vault.example.test/api/v1/items/item-existing/attachments?limit=500&cursor=attachment-page-2"
    );
    assert_eq!(attachment_requests[1].url, attachment_requests[2].url);
    assert_eq!(attachment_requests[1].method, attachment_requests[2].method);
    assert_eq!(attachment_requests[1].body, attachment_requests[2].body);
    let headers_without_authorization = |request: &RecordedRequest| {
        request
            .headers
            .iter()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(
        headers_without_authorization(&attachment_requests[1]),
        headers_without_authorization(&attachment_requests[2])
    );
    assert_eq!(
        attachment_requests[1].header("authorization"),
        Some("Bearer session-token-1")
    );
    assert_eq!(
        attachment_requests[2].header("authorization"),
        Some("Bearer session-token-2")
    );
    let stored = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.token.as_ref(), SECOND_TOKEN);
}

#[tokio::test]
async fn applied_move_attachment_authority_second_401_retains_durable_work() {
    let harness = seeded_with_existing_item(false, false).await;
    harness
        .server
        .script_attachment_faults([Some(Fault::Status(401)), Some(Fault::Status(401))]);
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
        .await;

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let retained = harness.snapshot();
    assert_eq!(retained.operations.len(), 1);
    assert_eq!(retained.operations[0].operation_id, operation_id);
    assert_eq!(retained.items.len(), 1);
    assert!(retained.receipts.is_empty());
    assert_eq!(
        harness.waiting_reason(),
        Some(AccountWaitingReason::ReauthenticationRequired)
    );
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    let stored = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &retained.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.token.as_ref(), SECOND_TOKEN);
}

#[tokio::test]
async fn every_allowed_ordinary_item_rejection_reconciles_current_authority_and_stops_retry() {
    for case in OrdinaryItemCase::ALL {
        for &code in case.allowed_rejections() {
            let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
            harness.server.reject_next(code);
            let (operation_id, _) = harness
                .accept_existing(case.request(harness.account_id.clone()))
                .await;
            harness
                .runtime
                .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
                .await;

            let snapshot = harness.snapshot();
            assert!(
                snapshot.operations.is_empty(),
                "{case:?}/{code} must stop retry"
            );
            assert!(
                snapshot.items.is_empty(),
                "{case:?}/{code} must remove its overlay only with the receipt"
            );
            assert_eq!(snapshot.receipts.len(), 1, "{case:?}/{code}");
            assert!(
                matches!(
                    snapshot.receipts[0].result,
                    OperationOutcomeResult::Rejected { .. }
                ),
                "{case:?}/{code} retained the rejection"
            );
            assert_eq!(
                harness.authority_items()[0].version,
                1,
                "{case:?}/{code} restored current Server authority"
            );
        }
    }
}

#[tokio::test]
async fn unknown_outcomes_retry_but_parsable_cross_kind_and_invalid_kind_rejections_fail_closed() {
    let harness = seeded_with_existing_item(false, false).await;
    harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    let operation = harness.operation().unwrap();
    let unknown = serde_json::to_vec(&serde_json::json!({
        "operationId": operation.operation_id,
        "kind": "future_item_kind",
        "result": { "status": "rejected", "code": "item_not_found" },
    }))
    .unwrap();
    assert!(matches!(
        harness
            .runtime
            .read_dispatch_answer(&operation, 200, &unknown),
        super::outcome::SemanticAnswer::Transient
    ));

    let cross_kind = serde_json::to_vec(&serde_json::json!({
        "operationId": operation.operation_id,
        "kind": "trash_item",
        "result": { "status": "rejected", "code": "item_not_found" },
    }))
    .unwrap();
    assert!(matches!(
        harness
            .runtime
            .read_dispatch_answer(&operation, 200, &cross_kind),
        super::outcome::SemanticAnswer::IdentityReused
    ));

    let impossible_rejection = serde_json::to_vec(&serde_json::json!({
        "operationId": operation.operation_id,
        "kind": "update_item",
        "result": { "status": "rejected", "code": "target_vault_read_only" },
    }))
    .unwrap();
    assert!(matches!(
        harness
            .runtime
            .read_dispatch_answer(&operation, 200, &impossible_rejection),
        super::outcome::SemanticAnswer::IdentityReused
    ));
}

#[tokio::test]
async fn exact_team_leave_start_answer_retains_the_authoritative_empty_plan_set() {
    let harness = seeded_with_existing_item(false, false).await;
    let operation: crate::replica::OperationRecord = serde_json::from_value(serde_json::json!({
        "operationId": "rotation-start-outcome",
        "kind": "create_team_leave_rotation_plans",
        "target": {"type": "team", "teamId": "team-1"},
        "request": {
            "method": "POST",
            "path": "/api/v1/teams/team-1/leave-rotation-plans",
            "headers": [],
            "body": []
        },
        "requestFingerprint": "7a6deb2215d2e2f11538109abe9d6195e32123b831bebc09a9140b975c20106a",
        "scheduling": {"attemptCount": "0", "notBeforeMs": "0"}
    }))
    .unwrap();
    let answer = serde_json::to_vec(&serde_json::json!({
        "operationId": "rotation-start-outcome",
        "kind": "create_team_leave_rotation_plans",
        "result": {"status": "applied", "plans": []}
    }))
    .unwrap();
    assert!(matches!(
        harness.runtime.read_dispatch_answer(&operation, 200, &answer),
        super::outcome::SemanticAnswer::Outcome(observed)
            if observed.operation_id == operation.operation_id
                && observed.request_fingerprint == operation.request_fingerprint
                && matches!(&observed.result,
                    OperationOutcomeResult::RotationStartApplied { plans } if plans.is_empty())
    ));

    let changed_operation = serde_json::to_vec(&serde_json::json!({
        "operationId": "another-rotation-start",
        "kind": "create_team_leave_rotation_plans",
        "result": {"status": "applied", "plans": []}
    }))
    .unwrap();
    assert!(matches!(
        harness
            .runtime
            .read_dispatch_answer(&operation, 200, &changed_operation),
        super::outcome::SemanticAnswer::IdentityReused
    ));

    let plan = serde_json::json!({
        "id": "plan-1", "vaultId": "vault-1", "initiatorUserId": "user-1",
        "expectedKeyVersion": 1, "state": "preparing",
        "idleExpiresAt": "2026-09-23T12:00:00Z",
        "absoluteExpiresAt": "2026-09-23T12:00:00Z"
    });
    let repeated_plan = serde_json::to_vec(&serde_json::json!({
        "operationId": "rotation-start-outcome",
        "kind": "create_team_leave_rotation_plans",
        "result": {"status": "applied", "plans": [plan.clone(), plan]}
    }))
    .unwrap();
    assert!(matches!(
        harness
            .runtime
            .read_dispatch_answer(&operation, 200, &repeated_plan),
        super::outcome::SemanticAnswer::IdentityReused
    ));
}

#[tokio::test]
async fn create_vault_outcomes_parse_closed_but_cannot_match_an_accepted_runtime_operation() {
    let harness = seeded_with_existing_item(false, false).await;
    harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    let operation = harness.operation().unwrap();

    for body in [
        serde_json::json!({
            "operationId": operation.operation_id,
            "kind": "create_vault",
            "result": { "status": "applied", "vaultId": "vault_1" },
        }),
        serde_json::json!({
            "operationId": operation.operation_id,
            "kind": "create_vault",
            "result": {
                "status": "rejected",
                "code": "vault_sharing_entitlement_denied"
            },
        }),
    ] {
        let bytes = serde_json::to_vec(&body).unwrap();
        assert!(matches!(
            harness
                .runtime
                .read_dispatch_answer(&operation, 200, &bytes),
            super::outcome::SemanticAnswer::IdentityReused
        ));
    }

    for malformed in [
        serde_json::json!({
            "operationId": operation.operation_id,
            "kind": "create_vault",
            "result": { "status": "applied", "itemId": "item_1", "version": 1 },
        }),
        serde_json::json!({
            "operationId": operation.operation_id,
            "kind": "create_vault",
            "result": { "status": "rejected", "code": "vault_read_only" },
        }),
    ] {
        let bytes = serde_json::to_vec(&malformed).unwrap();
        assert!(matches!(
            harness
                .runtime
                .read_dispatch_answer(&operation, 200, &bytes),
            super::outcome::SemanticAnswer::Transient
        ));
    }
}

#[tokio::test]
async fn import_outcomes_parse_closed_but_cannot_make_runtime_import_dispatch_eligible() {
    let harness = seeded_with_existing_item(false, false).await;
    harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    let operation = harness.operation().unwrap();

    for body in [
        serde_json::json!({
            "operationId": operation.operation_id,
            "kind": "import_items",
            "result": { "status": "applied", "vaultId": "vault_1", "importedCount": 0 },
        }),
        serde_json::json!({
            "operationId": operation.operation_id,
            "kind": "import_items",
            "result": { "status": "rejected", "code": "vault_read_only" },
        }),
    ] {
        let bytes = serde_json::to_vec(&body).unwrap();
        assert!(matches!(
            harness
                .runtime
                .read_dispatch_answer(&operation, 200, &bytes),
            super::outcome::SemanticAnswer::IdentityReused
        ));
    }

    for malformed in [
        serde_json::json!({
            "operationId": operation.operation_id,
            "kind": "import_items",
            "result": { "status": "applied", "vaultId": "vault_1" },
        }),
        serde_json::json!({
            "operationId": operation.operation_id,
            "kind": "import_items",
            "result": { "status": "rejected", "code": "item_not_found" },
        }),
        serde_json::json!({
            "operationId": operation.operation_id,
            "kind": "import_items",
            "result": { "status": "applied", "vaultId": "vault_1", "importedCount": -1 },
        }),
        serde_json::json!({
            "operationId": operation.operation_id,
            "kind": "import_items",
            "result": { "status": "applied", "vaultId": "vault_1", "importedCount": 201 },
        }),
    ] {
        let bytes = serde_json::to_vec(&malformed).unwrap();
        assert!(matches!(
            harness
                .runtime
                .read_dispatch_answer(&operation, 200, &bytes),
            super::outcome::SemanticAnswer::Transient
        ));
    }
}

#[tokio::test]
async fn foreign_operation_id_from_dispatch_or_lookup_fails_without_discard_or_effect() {
    for lookup in [false, true] {
        let harness = seeded_with_existing_item(false, false).await;
        if lookup {
            harness.server.script([Fault::Status(503)]);
        }
        let (operation_id, _) = harness
            .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
            .await;
        if lookup {
            harness
                .runtime
                .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
                .await;
            harness
                .server
                .answer_next_lookup_with(ordinary_rejected_body(
                    "foreign-operation",
                    "update_item",
                ));
            harness.clock.advance(1_000);
        } else {
            harness
                .server
                .answer_next_mutation_with(ordinary_rejected_body(
                    "foreign-operation",
                    "update_item",
                ));
        }
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;

        let snapshot = harness.snapshot();
        assert_eq!(snapshot.failure, Some(RuntimeErrorCode::InvariantViolation));
        assert_eq!(snapshot.operations.len(), 1);
        assert_eq!(snapshot.items.len(), 1);
        assert!(snapshot.receipts.is_empty());
        let server_items = harness.server.created_items.lock().unwrap();
        assert_eq!(server_items.len(), 1);
        assert_eq!(
            server_items[0].version, 1,
            "foreign answers apply no effect"
        );
    }
}

#[tokio::test]
async fn applied_permanent_deletion_with_present_authority_remains_an_invariant_failure() {
    let case = OrdinaryItemCase::PermanentlyDelete;
    let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
    let (operation_id, _) = harness
        .accept_existing(case.request(harness.account_id.clone()))
        .await;
    harness
        .server
        .answer_next_mutation_with(ordinary_applied_body(&operation_id, case.wire_kind(), 2));
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let snapshot = harness.snapshot();
    assert_eq!(snapshot.failure, Some(RuntimeErrorCode::InvariantViolation));
    assert_eq!(snapshot.operations.len(), 1);
    assert_eq!(snapshot.items.len(), 1);
    assert!(snapshot.receipts.is_empty());
    assert_eq!(
        harness.authority_items().len(),
        1,
        "mismatched Server authority cannot move local authority"
    );
}

#[tokio::test]
async fn fetched_authority_with_category_invalid_plaintext_fails_closed_before_reconciliation() {
    let harness = seeded_with_existing_item(false, false).await;
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Favorite.request(harness.account_id.clone()))
        .await;
    let malformed = bittery_crypto_core::encrypt_with_aad(
        r#"{"title":"Login","cardNumber":"field-not-allowed-on-login"}"#,
        &crate::test_fixtures::TEST_VAULT_KEY,
        &bittery_crypto_core::AadContext {
            vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
            entity_id: "item-existing".into(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    {
        let mut items = harness.server.created_items.lock().unwrap();
        items[0].encrypted_data = malformed.ciphertext;
        items[0].encryption_iv = malformed.iv;
        items[0].encryption_algorithm = malformed.algorithm;
    }
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let snapshot = harness.snapshot();
    assert_eq!(snapshot.failure, Some(RuntimeErrorCode::InvariantViolation));
    assert_eq!(snapshot.operations.len(), 1);
    assert_eq!(snapshot.items.len(), 1);
    assert!(snapshot.receipts.is_empty());
}

#[tokio::test]
async fn same_kind_lookup_identity_reuse_is_proved_by_exact_replay_and_fails_the_account() {
    for case in OrdinaryItemCase::ALL {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        harness.server.script([Fault::Status(503)]);
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        harness.server.outcomes.lock().unwrap().insert(
            operation_id.clone(),
            StoredOutcome {
                fingerprint: [99; 32],
                result: StoredResult::ExistingItemRejected {
                    kind: case.wire_kind(),
                    code: "item_not_found",
                },
            },
        );
        harness.clock.advance(1_000);
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;

        let snapshot = harness.snapshot();
        assert_eq!(
            snapshot.failure,
            Some(RuntimeErrorCode::InvariantViolation),
            "{case:?} must fail on same-kind ID reuse"
        );
        assert_eq!(snapshot.operations.len(), 1, "{case:?} keeps accepted work");
        assert_eq!(snapshot.items.len(), 1, "{case:?} keeps its overlay");
        assert!(snapshot.receipts.is_empty(), "{case:?} invents no receipt");
        assert_eq!(harness.server.outcome_lookups(), 1);
    }
}

#[tokio::test]
async fn all_six_dropped_mutation_responses_recover_through_lookup_and_exact_replay() {
    for case in OrdinaryItemCase::ALL {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        harness.server.lose_next_response();
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        assert_eq!(harness.snapshot().operations.len(), 1, "{case:?}");
        harness.clock.advance(1_000);
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;

        let snapshot = harness.snapshot();
        assert!(snapshot.operations.is_empty(), "{case:?} recovered");
        assert_eq!(snapshot.receipts.len(), 1, "{case:?} retained one receipt");
        assert_eq!(harness.server.outcome_lookups(), 1, "{case:?} used lookup");
        assert_eq!(
            harness.server.existing_item_mutation_requests().len(),
            2,
            "{case:?} replayed exact accepted bytes once to prove identity"
        );
        let server_items = harness.server.created_items.lock().unwrap();
        if matches!(case, OrdinaryItemCase::PermanentlyDelete) {
            assert!(server_items.is_empty());
        } else {
            assert_eq!(server_items[0].version, 2, "{case:?} applied only once");
        }
    }
}

struct TwoRuntimeBarrierHttp {
    server: Arc<FakeServer>,
    mutation_barrier: tokio::sync::Barrier,
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for TwoRuntimeBarrierHttp {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<String, RuntimeError> {
        let request: serde_json::Value = serde_json::from_str(&request_json).unwrap();
        if (request["method"] == "PUT"
            && request["url"]
                .as_str()
                .is_some_and(|url| url.contains("/api/v1/vaults/")))
            || (request["method"] != "GET"
                && request["url"]
                    .as_str()
                    .is_some_and(|url| url.contains("/api/v1/items/item-existing")))
        {
            self.mutation_barrier.wait().await;
        }
        crate::http_transport::SerializedHttpExecutor::invoke(&*self.server, request_json).await
    }

    fn cancel(&self, dispatch_id: &str) {
        crate::http_transport::SerializedHttpExecutor::cancel(&*self.server, dispatch_id);
    }
}

#[test]
fn attachment_state_conflict_remains_a_terminal_rejection_across_the_server_contract() {
    assert_eq!(
        super::outcome::rejection_code(
            crate::server_contract::OperationRejectionCode::AttachmentStateConflict,
        ),
        OperationRejectionCode::AttachmentStateConflict
    );
}

impl Harness {
    fn snapshot(&self) -> ReplicaSnapshot {
        self.runtime
            .replica()
            .snapshot(&self.account_id)
            .expect("the Account is installed")
    }

    fn overlay(&self) -> Option<ReplicaItemRecord> {
        self.snapshot().items.first().cloned()
    }

    fn authority_items(&self) -> Vec<crate::replica::AuthorityItemRecord> {
        self.snapshot().bootstrap.snapshot().visible_items
    }

    fn visible_items(&self) -> Vec<ItemProjection> {
        match self
            .runtime
            .projection(&ObservationRequest::Items {
                account_id: self.account_id.clone(),
            })
            .expect("an unlocked Account projects Items")
            .projection
        {
            RuntimeProjection::Items(items) => items.items,
            other => panic!("expected an Items projection, got {other:?}"),
        }
    }

    fn active_cursor(&self) -> crate::replica::SyncCursor {
        self.snapshot().bootstrap.active_cursor.clone()
    }
}

/// Everything one completed create owes locally, asserted in one place.
fn assert_reconciled(harness: &Harness, operation_id: &str, item_id: &str) {
    let snapshot = harness.snapshot();
    assert!(
        snapshot.operations.is_empty(),
        "an authoritative outcome ends the Operation"
    );
    assert!(
        snapshot.items.is_empty(),
        "reconciliation removes the optimistic overlay"
    );
    let authority = harness.authority_items();
    assert_eq!(authority.len(), 1, "exactly one authoritative Item");
    assert_eq!(authority[0].id, item_id);
    assert_eq!(authority[0].version, 1);
    let visible = harness.visible_items();
    assert_eq!(visible.len(), 1, "exactly one visible Item");
    assert_eq!(visible[0].item_id, item_id);
    assert_eq!(visible[0].status, ItemProjectionStatus::Authoritative);
    assert_eq!(
        harness.server.created_items(),
        vec![item_id.to_owned()],
        "one Server effect"
    );

    // One compact completed receipt: identity, fingerprint, terminal result, entity version, and
    // the revision that completed it — and none of the request ciphertext.
    assert_eq!(snapshot.receipts.len(), 1, "exactly one completed receipt");
    let receipt = &snapshot.receipts[0];
    assert_eq!(receipt.operation_id, operation_id);
    assert_eq!(receipt.item_id(), item_id);
    assert_eq!(
        receipt.result,
        OperationOutcomeResult::Applied {
            entity_id: item_id.to_owned(),
            version: 1,
        }
    );
    assert!(
        receipt.completed_at_revision == snapshot.revision
            || receipt.completed_at_revision.checked_add(1) == Some(snapshot.revision),
        "only the page-terminal Cursor commit may follow semantic completion"
    );
    let serialized = serde_json::to_string(receipt).expect("a receipt serializes");
    assert!(
        !serialized.contains(&authority[0].encrypted_data),
        "the receipt keeps no request ciphertext"
    );
}

#[tokio::test]
async fn a_forced_duplicate_dispatch_leaves_one_server_effect_and_one_item() {
    let harness = seeded(false).await;
    let (operation_id, item_id) = harness.accept_create().await;
    let shared_http = Arc::new(TwoRuntimeBarrierHttp {
        server: harness.server.clone(),
        mutation_barrier: tokio::sync::Barrier::new(2),
    });
    let first = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        shared_http.clone(),
        auth_config(),
        harness.clock.clone(),
        TestTimer::advancing(harness.clock.clone()),
    );
    let second = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        shared_http,
        auth_config(),
        harness.clock.clone(),
        TestTimer::advancing(harness.clock.clone()),
    );
    first.replica().load(&harness.account_id).await.unwrap();
    second.replica().load(&harness.account_id).await.unwrap();
    first.unlock_account(&harness.account_id).await.unwrap();
    second.unlock_account(&harness.account_id).await.unwrap();
    // Each independent Runtime has its own Account fence and captured the same durable Operation
    // before either Server response. The barrier proves both identical sends reach the Server;
    // only the retained outcome contract can deduplicate across processes.
    let first_snapshot = first.replica().snapshot(&harness.account_id).unwrap();
    let second_snapshot = second.replica().snapshot(&harness.account_id).unwrap();
    let first_accepted = first_snapshot.operations[0].clone();
    let second_accepted = second_snapshot.operations[0].clone();
    tokio::join!(
        first.dispatch_captured_ignoring_lease(&first_snapshot, &first_accepted),
        second.dispatch_captured_ignoring_lease(&second_snapshot, &second_accepted),
    );

    assert_eq!(harness.server.creates(), 2, "both sends reached the Server");
    harness
        .runtime
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap();
    harness
        .runtime
        .decrypt_visible_items(&harness.account_id)
        .unwrap();
    assert_reconciled(&harness, &operation_id, &item_id);
}

#[tokio::test]
async fn forced_duplicate_dispatch_has_one_semantic_effect_and_one_receipt_for_every_ordinary_kind()
{
    for case in OrdinaryItemCase::ALL {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        let shared_http = Arc::new(TwoRuntimeBarrierHttp {
            server: harness.server.clone(),
            mutation_barrier: tokio::sync::Barrier::new(2),
        });
        let first = Runtime::with_test_dispatch_environment(
            harness.replica.clone(),
            harness.platform.clone(),
            shared_http.clone(),
            auth_config(),
            harness.clock.clone(),
            TestTimer::advancing(harness.clock.clone()),
        );
        let second = Runtime::with_test_dispatch_environment(
            harness.replica.clone(),
            harness.platform.clone(),
            shared_http,
            auth_config(),
            harness.clock.clone(),
            TestTimer::advancing(harness.clock.clone()),
        );
        first.replica().load(&harness.account_id).await.unwrap();
        second.replica().load(&harness.account_id).await.unwrap();
        first.unlock_account(&harness.account_id).await.unwrap();
        second.unlock_account(&harness.account_id).await.unwrap();
        let first_snapshot = first.replica().snapshot(&harness.account_id).unwrap();
        let second_snapshot = second.replica().snapshot(&harness.account_id).unwrap();
        let first_operation = first_snapshot.operations[0].clone();
        let second_operation = second_snapshot.operations[0].clone();
        tokio::join!(
            first.dispatch_captured_ignoring_lease(&first_snapshot, &first_operation),
            second.dispatch_captured_ignoring_lease(&second_snapshot, &second_operation),
        );

        harness
            .runtime
            .replica()
            .load(&harness.account_id)
            .await
            .unwrap();
        let snapshot = harness.snapshot();
        assert!(snapshot.operations.is_empty(), "{case:?}");
        assert_eq!(snapshot.receipts.len(), 1, "{case:?}");
        assert_eq!(snapshot.receipts[0].operation_id, operation_id);
        assert_eq!(
            harness.server.existing_item_mutation_requests().len(),
            2,
            "{case:?} both transports reached the Server"
        );
        let server_items = harness.server.created_items.lock().unwrap();
        if matches!(case, OrdinaryItemCase::PermanentlyDelete) {
            assert!(server_items.is_empty());
        } else {
            assert_eq!(server_items[0].version, 2, "{case:?} effect happened once");
        }
    }
}

#[tokio::test]
async fn ordinary_item_fetch_and_commit_failures_preserve_accepted_work_until_retry() {
    for fail_commit in [false, true] {
        let harness = seeded_with_existing_item(false, false).await;
        let (operation_id, _) = harness
            .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
            .await;
        let accepted = harness.snapshot();
        if fail_commit {
            harness.replica.fail_next_commits(1);
        } else {
            harness.server.script_item_faults([Fault::NetworkFailure]);
        }
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;

        let stalled = harness.snapshot();
        assert_eq!(stalled.operations.len(), 1);
        assert_eq!(
            stalled.operations[0].scheduling.attempt_count,
            1,
            "{} failure must durably back off",
            if fail_commit { "commit" } else { "fetch" }
        );
        assert_eq!(
            stalled.operations[0].request,
            accepted.operations[0].request
        );
        assert_eq!(stalled.items, accepted.items);
        assert!(stalled.receipts.is_empty());
        assert_eq!(harness.authority_items()[0].version, 1);
        assert_eq!(
            stalled.bootstrap.active_cursor,
            accepted.bootstrap.active_cursor
        );

        harness.clock.advance(1_000);
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        let completed = harness.snapshot();
        assert!(
            completed.operations.is_empty(),
            "retry after {} failure did not complete: {:?}",
            if fail_commit { "commit" } else { "fetch" },
            completed.operations[0].scheduling
        );
        assert!(completed.items.is_empty());
        assert_eq!(completed.receipts.len(), 1);
        assert_eq!(harness.authority_items()[0].version, 2);
    }
}

#[tokio::test]
async fn item_not_found_rejection_receipts_and_refreshes_without_rewriting_current_authority() {
    for case in OrdinaryItemCase::ALL {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        let authority_before = harness.authority_items();
        harness.server.reject_next("item_not_found");
        harness.server.created_items.lock().unwrap().clear();
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;

        let snapshot = harness.snapshot();
        assert!(snapshot.operations.is_empty(), "{case:?}");
        assert!(snapshot.items.is_empty(), "{case:?}");
        assert_eq!(harness.authority_items(), authority_before, "{case:?}");
        assert_eq!(
            snapshot.bootstrap.state,
            crate::replica::ReplicaState::RefreshRequired
        );
        assert_eq!(snapshot.receipts.len(), 1, "{case:?}");
        assert_eq!(
            snapshot.receipts[0].result,
            OperationOutcomeResult::Rejected {
                code: OperationRejectionCode::ItemNotFound,
            }
        );
    }
}

#[tokio::test]
async fn a_lost_first_success_response_is_recovered_by_lookup_and_exact_replay() {
    let harness = seeded(false).await;
    // The Server commits the Item and the client never sees the answer.
    harness.server.lose_next_response();
    let (operation_id, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the lost response is recovered", || {
        harness.snapshot().operations.is_empty()
    })
    .await;
    settle().await;

    assert_eq!(
        harness.server.creates(),
        2,
        "the retained hint is proved by exact replay without a second Item effect"
    );
    assert!(
        harness.server.outcome_lookups() >= 1,
        "recovery asks the Server what it already decided"
    );
    assert_reconciled(&harness, &operation_id, &item_id);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn lookup_401_then_refresh_401_parks_without_timed_retries_or_losing_work() {
    let harness = seeded(true).await;
    harness.server.lose_next_response();
    let (operation_id, item_id) = harness.accept_create().await;

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    let accepted = harness.snapshot();
    harness.server.accepted_tokens.lock().unwrap().clear();

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the failed lookup renewal parks the Account", || {
        harness.waiting_reason() == Some(AccountWaitingReason::ReauthenticationRequired)
    })
    .await;
    settle().await;

    let parked = harness.snapshot();
    assert_eq!(parked.operations, accepted.operations);
    assert_eq!(parked.items, accepted.items);
    assert_eq!(harness.overlay().map(|item| item.item_id), Some(item_id));
    assert!(parked.receipts.is_empty());
    assert_eq!(harness.server.outcome_lookups(), 1);
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert!(
        harness.timer.requested().is_empty(),
        "reauthentication parks on an event instead of scheduling a timed lookup"
    );

    settle().await;
    assert_eq!(harness.server.outcome_lookups(), 1);
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn the_same_operation_id_with_other_request_bytes_fails_the_account() {
    let harness = seeded(false).await;
    let (operation_id, item_id) = harness.accept_create().await;

    // Someone else already used this Operation ID for different immutable bytes.
    harness.server.outcomes.lock().unwrap().insert(
        operation_id.clone(),
        StoredOutcome {
            fingerprint: [9u8; 32],
            result: StoredResult::Applied {
                item_id: "another-item".to_owned(),
                version: 1,
            },
        },
    );

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Account fails", || harness.snapshot().failure.is_some()).await;
    settle().await;

    assert_eq!(
        harness.snapshot().failure,
        Some(RuntimeErrorCode::InvariantViolation),
        "identity reuse is a fatal invariant violation, not a retry"
    );
    assert!(
        harness.server.created_items().is_empty(),
        "no Item was ever created for these bytes"
    );
    assert!(
        harness.authority_items().is_empty(),
        "nothing authoritative was guessed"
    );
    assert!(
        harness.snapshot().receipts.is_empty(),
        "identity reuse records no outcome"
    );
    assert!(
        harness.snapshot().operations.len() == 1,
        "failing keeps the accepted Operation"
    );
    assert_eq!(
        harness.overlay().map(|item| item.item_id),
        Some(item_id),
        "the user's ciphertext is preserved"
    );

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn a_failed_authoritative_fetch_leaves_the_prior_state_and_cursor_unchanged() {
    // Time is held, so the Runtime stops in the state a failed reconciliation leaves behind.
    let harness = seeded(true).await;
    harness.server.script_item_faults([Fault::NetworkFailure]);
    let (operation_id, item_id) = harness.accept_create().await;
    let before = harness.snapshot();

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Server applied the create", || {
        !harness.server.created_items().is_empty()
    })
    .await;
    until("the failed fetch reschedules the Operation", || {
        harness
            .snapshot()
            .operations
            .first()
            .is_some_and(|operation| operation.scheduling.attempt_count >= 1)
    })
    .await;
    settle().await;

    // An HTTP success without an applied reconciliation plan is not local completion.
    let stalled = harness.snapshot();
    assert_eq!(
        stalled.operations[0].request, before.operations[0].request,
        "the immutable bytes never moved"
    );
    assert_eq!(
        stalled.items, before.items,
        "the encrypted overlay is untouched"
    );
    assert!(
        harness.authority_items().is_empty(),
        "no authority was written"
    );
    assert_eq!(
        harness.active_cursor(),
        before.bootstrap.active_cursor,
        "a failed fetch leaves the Cursor unchanged"
    );
    assert_eq!(
        harness.snapshot().bootstrap.active_generation,
        before.bootstrap.active_generation,
        "the Bootstrap generation this Replica reads is unchanged"
    );

    // The same durable work reconciles as soon as the Item can be read.
    harness.clock.advance(1_000);
    harness.timer.hold.store(false, Ordering::SeqCst);
    harness.timer.released.notify_waiters();
    until("the retry reconciles", || {
        harness.snapshot().operations.is_empty()
    })
    .await;
    settle().await;
    assert_reconciled(&harness, &operation_id, &item_id);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn a_retained_rejection_stops_retry_and_keeps_the_users_ciphertext() {
    let harness = seeded(false).await;
    harness.server.reject_next("vault_read_only");
    let (_, item_id) = harness.accept_create().await;
    let accepted_overlay = harness.overlay().expect("accept wrote an overlay");

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the rejection is retained locally", || {
        harness.snapshot().operations.is_empty()
    })
    .await;
    let sent = harness.server.creates();
    settle().await;

    assert_eq!(
        harness.server.creates(),
        sent,
        "a retained rejection stops retry"
    );
    assert!(
        harness.server.created_items().is_empty(),
        "a rejection created no Item"
    );
    let failed = harness
        .overlay()
        .expect("a rejection never destroys the user's ciphertext");
    assert_eq!(failed, accepted_overlay);
    let receipts = harness.snapshot().receipts;
    assert_eq!(receipts.len(), 1, "the rejection is retained once");
    assert_eq!(
        receipts[0].result,
        OperationOutcomeResult::Rejected {
            code: OperationRejectionCode::VaultReadOnly,
        }
    );
    let visible = harness.visible_items();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].item_id, item_id);
    assert_eq!(visible[0].status, ItemProjectionStatus::Failed);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn a_single_operation_sync_page_reconciles_then_advances_its_terminal_cursor() {
    let harness = seeded(false).await;
    harness.server.lose_next_response();
    let (operation_id, item_id) = harness.accept_create().await;

    // One dispatch attempt reaches the Server, and its answer is lost.
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    assert!(harness.snapshot().operations.len() == 1);

    // The Sync feed then reports the Operation as resolved, ending one exact page.
    harness
        .server
        .script_operation_event(&operation_id, "sync-7");
    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    assert_eq!(harness.snapshot().operations.len(), 1);
    assert!(harness.snapshot().receipts.is_empty());
    assert_eq!(
        harness.active_cursor(),
        crate::replica::SyncCursor::CapturedEmpty,
        "a lookup hint cannot bypass the exact replay's persisted backoff"
    );
    harness.clock.advance(1_000);
    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    assert_reconciled(&harness, &operation_id, &item_id);
    assert_eq!(
        harness.active_cursor(),
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-7".to_owned()
        },
        "Bootstrap advances the terminal page Cursor only after reconciliation completes"
    );
}

#[tokio::test]
async fn ordinary_operation_sync_hint_proves_identity_before_terminal_page_progress() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    harness
        .server
        .script_operation_event(&operation_id, "sync-ordinary-1");

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    let snapshot = harness.snapshot();
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.items.is_empty());
    assert_eq!(snapshot.receipts.len(), 1);
    assert_eq!(
        snapshot.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-ordinary-1".into(),
        }
    );
    assert_eq!(harness.server.outcome_lookups(), 1);
    assert_eq!(
        harness.server.existing_item_mutation_requests().len(),
        2,
        "the lookup hint is proved by one exact replay before completion"
    );

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        harness.snapshot().bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-ordinary-1".into(),
        },
        "a repeated page cannot pin or move the completed cursor"
    );
}

#[tokio::test]
async fn refresh_cannot_pass_a_later_unresolved_operation_event() {
    for requires_full_refresh in [false, true] {
        let harness = seeded_with_existing_item(false, false).await;
        let (operation_id, _) = harness
            .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
            .await;
        let before = harness.snapshot();
        harness
            .server
            .outcome_faults
            .lock()
            .unwrap()
            .push_back(Fault::NetworkFailure);
        harness
            .server
            .sync_pages
            .lock()
            .unwrap()
            .push_back(serde_json::json!({
                "events": [
                    {
                        "id": "refresh-vault-event",
                        "type": "vault_updated",
                        "entityType": "vault",
                        "entityId": TEST_VAULT_ID,
                        "userId": USER,
                        "vaultId": TEST_VAULT_ID,
                        "clientId": null,
                        "metadata": null,
                        "timestamp": "1700000000000",
                        "version": 1
                    },
                    {
                        "id": "refresh-operation-event",
                        "type": "operation_resolved",
                        "entityType": "operation",
                        "entityId": operation_id,
                        "userId": USER,
                        "vaultId": null,
                        "clientId": null,
                        "metadata": null,
                        "timestamp": "1700000000000",
                        "version": 1
                    }
                ],
                "cursor": { "id": "refresh-operation-event" },
                "hasMore": false,
                "requiresFullRefresh": requires_full_refresh
            }));
        let request_start = harness.server.requests.lock().unwrap().len();

        harness
            .runtime
            .bootstrap_account(&harness.account_id, RequestCancellation::new())
            .await
            .unwrap();

        assert_eq!(harness.server.outcome_lookups(), 1);
        assert_eq!(
            harness.snapshot(),
            before,
            "a structural refresh cannot pass later accepted work, even when history expired"
        );
        let requests = harness.server.requests.lock().unwrap();
        let paths: Vec<_> = requests[request_start..]
            .iter()
            .map(|request| url::Url::parse(&request.url).unwrap().path().to_owned())
            .collect();
        assert_eq!(
            paths,
            vec![
                "/api/v1/sync/changes".to_owned(),
                format!("/api/v1/operations/{operation_id}")
            ],
            "no fresh Bootstrap may be requested before exact outcome reconciliation"
        );
    }
}

#[tokio::test]
async fn ordinary_sync_replay_commit_failure_moves_neither_work_nor_page_cursor() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    harness
        .server
        .script_operation_event(&operation_id, "sync-ordinary-fenced");
    let before = harness.snapshot();
    harness.replica.fail_next_commits(1);

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    let stalled = harness.snapshot();
    assert_eq!(stalled.operations.len(), 1);
    assert_eq!(stalled.items, before.items);
    assert!(stalled.receipts.is_empty());
    assert_eq!(
        stalled.bootstrap.active_cursor,
        before.bootstrap.active_cursor
    );

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    let completed = harness.snapshot();
    assert!(completed.operations.is_empty());
    assert!(completed.items.is_empty());
    assert_eq!(completed.receipts.len(), 1);
    assert_eq!(
        completed.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-ordinary-fenced".into(),
        }
    );
}

#[tokio::test]
async fn ordinary_sync_exact_replay_renews_once_and_completes_with_the_fresh_session() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    harness
        .server
        .script_operation_event(&operation_id, "sync-renewed-replay");
    harness.server.script([Fault::Status(401)]);
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    let snapshot = harness.snapshot();
    assert!(snapshot.operations.is_empty());
    assert_eq!(snapshot.receipts.len(), 1);
    assert_eq!(
        snapshot.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-renewed-replay".into(),
        }
    );
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    let mutation_authorizations: Vec<_> = harness
        .server
        .existing_item_mutation_requests()
        .into_iter()
        .map(|request| request.header("authorization").unwrap().to_owned())
        .collect();
    assert_eq!(
        mutation_authorizations,
        vec![
            format!("Bearer {FIRST_TOKEN}"),
            format!("Bearer {FIRST_TOKEN}"),
            format!("Bearer {SECOND_TOKEN}"),
        ],
        "the exact replay gets the canonical one-renewal policy without changing its bytes"
    );
}

#[tokio::test]
async fn ordinary_sync_transport_failure_persists_and_honors_the_operation_backoff() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    harness
        .server
        .script_operation_event(&operation_id, "sync-transport-backoff");
    harness.server.script([Fault::NetworkFailure]);

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    let scheduled = harness.snapshot();
    assert_eq!(scheduled.operations[0].scheduling.attempt_count, 2);
    assert_eq!(
        scheduled.operations[0].scheduling.not_before_ms,
        START_MS + 3_000
    );
    assert_eq!(
        scheduled.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedEmpty,
        "a failed replay cannot advance past its accepted Operation"
    );
    let mutation_count = harness.server.existing_item_mutation_requests().len();

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        harness.server.existing_item_mutation_requests().len(),
        mutation_count,
        "catch-up honors not_before instead of hot-looping the exact replay"
    );
    assert_eq!(
        harness.snapshot().operations[0].scheduling,
        scheduled.operations[0].scheduling
    );

    harness.clock.advance(2_000);
    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    let completed = harness.snapshot();
    assert!(completed.operations.is_empty());
    assert_eq!(completed.receipts.len(), 1);
    assert_eq!(
        completed.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-transport-backoff".into(),
        }
    );
}

#[tokio::test]
async fn ordinary_sync_transient_response_persists_the_same_operation_backoff() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    harness
        .server
        .script_operation_event(&operation_id, "sync-transient-backoff");
    harness.server.script([Fault::Status(503)]);

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    let scheduled = harness.snapshot();
    assert_eq!(scheduled.operations[0].scheduling.attempt_count, 2);
    assert_eq!(
        scheduled.operations[0].scheduling.not_before_ms,
        START_MS + 3_000
    );
    assert_eq!(
        scheduled.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedEmpty
    );
    assert!(scheduled.receipts.is_empty());
}

#[tokio::test]
async fn ordinary_sync_second_401_parks_with_backoff_without_moving_work_or_cursor() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    harness
        .server
        .script_operation_event(&operation_id, "sync-second-401");
    harness
        .server
        .script([Fault::Status(401), Fault::Status(401)]);
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);

    let error = harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    let parked = harness.snapshot();
    assert_eq!(parked.operations.len(), 1);
    assert_eq!(parked.operations[0].scheduling.attempt_count, 2);
    assert_eq!(
        parked.operations[0].scheduling.not_before_ms,
        START_MS + 3_000
    );
    assert_eq!(parked.items.len(), 1);
    assert!(parked.receipts.is_empty());
    assert_eq!(
        parked.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedEmpty
    );
    assert_eq!(
        harness.waiting_reason(),
        Some(AccountWaitingReason::ReauthenticationRequired)
    );
}

#[tokio::test]
async fn sync_lookup_401_then_refresh_401_marks_once_and_keeps_work_and_cursor() {
    let harness = seeded(false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness.accept_create().await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    let before_page = harness.snapshot();
    let revision_before = harness.runtime.device_revision.load(Ordering::SeqCst);
    harness
        .server
        .script_operation_event(&operation_id, "sync-lookup-refresh-401");
    harness
        .server
        .outcome_faults
        .lock()
        .unwrap()
        .push_back(Fault::Status(401));

    let error = harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    let parked = harness.snapshot();
    assert_eq!(parked.operations, before_page.operations);
    assert_eq!(parked.items, before_page.items);
    assert!(parked.receipts.is_empty());
    assert_eq!(
        parked.bootstrap.active_cursor, before_page.bootstrap.active_cursor,
        "the Sync page cannot advance past an unrenewable outcome lookup"
    );
    assert_eq!(
        harness.waiting_reason(),
        Some(AccountWaitingReason::ReauthenticationRequired)
    );
    assert_eq!(harness.server.outcome_lookups(), 1);
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.runtime.device_revision.load(Ordering::SeqCst),
        revision_before + 1,
        "lookup and Bootstrap share one observable reauthentication transition"
    );
}

#[tokio::test]
async fn sync_page_cursor_does_not_advance_past_move_attachment_authority_second_401() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    let before_page = harness.snapshot();
    harness
        .server
        .script_operation_event(&operation_id, "sync-move-attachment-second-401");
    harness
        .server
        .script_attachment_faults([Some(Fault::Status(401)), Some(Fault::Status(401))]);
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);

    let error = harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    let retained = harness.snapshot();
    assert_eq!(retained.operations.len(), 1);
    assert_eq!(retained.operations[0].operation_id, operation_id);
    assert_eq!(retained.items, before_page.items);
    assert!(retained.receipts.is_empty());
    assert_eq!(
        retained.bootstrap.active_cursor, before_page.bootstrap.active_cursor,
        "the Sync page cannot advance past unresolved Move authority"
    );
    assert_eq!(
        harness.waiting_reason(),
        Some(AccountWaitingReason::ReauthenticationRequired)
    );
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    let attachment_requests: Vec<_> = harness
        .server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.url.contains("/attachments?"))
        .cloned()
        .collect();
    assert_eq!(attachment_requests.len(), 2);
    assert_eq!(attachment_requests[0].url, attachment_requests[1].url);
    assert_eq!(attachment_requests[0].method, attachment_requests[1].method);
    assert_eq!(attachment_requests[0].body, attachment_requests[1].body);
    let headers_without_authorization = |request: &RecordedRequest| {
        request
            .headers
            .iter()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
            .cloned()
            .collect::<Vec<_>>()
    };
    assert_eq!(
        headers_without_authorization(&attachment_requests[0]),
        headers_without_authorization(&attachment_requests[1])
    );
    assert_eq!(
        attachment_requests[0].header("authorization"),
        Some("Bearer session-token-1")
    );
    assert_eq!(
        attachment_requests[1].header("authorization"),
        Some("Bearer session-token-2")
    );
    let stored = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &retained.incarnation)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.token.as_ref(), SECOND_TOKEN);
}

#[tokio::test]
async fn rejected_move_malformed_foreign_or_transient_attachment_authority_moves_no_work_or_cursor()
{
    enum AuthorityFailure {
        Malformed,
        Foreign,
        Transient,
    }

    for failure in [
        AuthorityFailure::Malformed,
        AuthorityFailure::Foreign,
        AuthorityFailure::Transient,
    ] {
        let harness = seeded_with_existing_item(false, false).await;
        harness.server.reject_next("attachment_state_conflict");
        harness.server.lose_next_response();
        let (operation_id, _) = harness
            .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
            .await;
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        harness.clock.advance(1_000);
        let before_page = harness.snapshot();
        harness
            .server
            .script_operation_event(&operation_id, "sync-rejected-move-authority-failure");
        match failure {
            AuthorityFailure::Malformed => harness
                .server
                .script_attachment_page(vec![serde_json::json!({ "id": "incomplete" })], None),
            AuthorityFailure::Foreign => harness.server.script_attachment_page(
                vec![attachment_authority_json("foreign-item", TEST_VAULT_ID)],
                None,
            ),
            AuthorityFailure::Transient => harness
                .server
                .script_attachment_faults([Some(Fault::NetworkFailure)]),
        }

        let _ = harness
            .runtime
            .bootstrap_account(&harness.account_id, RequestCancellation::new())
            .await;

        let retained = harness.snapshot();
        assert_eq!(retained.operations.len(), 1);
        assert_eq!(retained.operations[0].operation_id, operation_id);
        assert_eq!(retained.items, before_page.items);
        assert!(retained.receipts.is_empty());
        assert_eq!(
            retained.bootstrap.active_cursor, before_page.bootstrap.active_cursor,
            "invalid Attachment authority cannot advance the terminal Sync page"
        );
        assert_eq!(
            harness.authority_items(),
            before_page.bootstrap.snapshot().visible_items,
            "invalid Attachment authority cannot replace current Item authority"
        );
    }
}

#[tokio::test]
async fn operation_page_advances_after_background_dispatch_already_retained_the_receipt() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let completed_before_event = harness.snapshot();
    assert!(completed_before_event.operations.is_empty());
    assert_eq!(completed_before_event.receipts.len(), 1);
    assert_eq!(
        completed_before_event.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedEmpty
    );
    let effects = harness.server.existing_item_mutation_requests().len();

    harness
        .server
        .script_operation_event(&operation_id, "sync-background-won");
    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    let after_event = harness.snapshot();
    assert!(after_event.operations.is_empty());
    assert_eq!(after_event.receipts, completed_before_event.receipts);
    assert_eq!(
        after_event.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-background-won".into(),
        }
    );
    assert_eq!(
        harness.server.existing_item_mutation_requests().len(),
        effects,
        "a receipt-proved Operation event advances no second semantic effect"
    );

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        harness.snapshot(),
        after_event,
        "the repeated page-boundary event is an exact no-op"
    );
}

#[tokio::test]
async fn sync_page_terminal_cursor_commit_failure_retries_exactly() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let completed_before_event = harness.snapshot();
    assert!(completed_before_event.operations.is_empty());
    assert_eq!(completed_before_event.receipts.len(), 1);
    harness
        .server
        .script_operation_event(&operation_id, "sync-cursor-retry");
    harness.replica.fail_next_commits(1);

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(harness.snapshot(), completed_before_event);
    assert_eq!(harness.replica.failed_commits(), 1);

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    let converged = harness.snapshot();
    assert!(converged.operations.is_empty());
    assert_eq!(converged.receipts, completed_before_event.receipts);
    assert_eq!(
        converged.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-cursor-retry".into(),
        }
    );
}

#[tokio::test]
async fn a_foreign_operation_page_advances_cursor_without_inventing_local_work() {
    let harness = seeded(false).await;
    let before = harness.snapshot();
    harness
        .server
        .script_operation_event("another-device-operation", "sync-foreign-operation");

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    let advanced = harness.snapshot();
    assert!(advanced.operations.is_empty());
    assert!(advanced.receipts.is_empty());
    assert_eq!(advanced.items, before.items);
    assert_eq!(
        advanced.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-foreign-operation".into(),
        }
    );
}

#[tokio::test]
async fn sync_has_more_fetches_the_next_page_from_the_committed_page_cursor() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);

    let item_event = |event_id: &str| {
        serde_json::json!({
            "clientId": null,
            "entityId": "item-existing",
            "entityType": "item",
            "id": event_id,
            "metadata": null,
            "timestamp": "1700000000000",
            "type": "item_updated",
            "userId": USER,
            "vaultId": "vault-1",
            "version": 1,
        })
    };
    let operation_event = |event_id: &str, entity_id: &str| {
        serde_json::json!({
            "clientId": null,
            "entityId": entity_id,
            "entityType": "operation",
            "id": event_id,
            "metadata": null,
            "timestamp": "1700000000000",
            "type": "operation_resolved",
            "userId": USER,
            "vaultId": null,
            "version": 1,
        })
    };
    harness.server.script_sync_page(
        vec![
            item_event("page-1-item"),
            operation_event("C1", "another-device-operation"),
        ],
        "C1",
        true,
    );
    harness.server.script_sync_page(
        vec![
            item_event("page-2-item"),
            operation_event("C2", &operation_id),
        ],
        "C2",
        false,
    );
    let request_start = harness.server.requests.lock().unwrap().len();
    let item_calls_before = harness.server.item_calls.load(Ordering::SeqCst);
    let outcomes_before = harness.server.outcome_lookups();

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    let converged = harness.snapshot();
    assert!(converged.operations.is_empty());
    assert_eq!(converged.receipts.len(), 1);
    assert_eq!(
        converged.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue { id: "C2".into() }
    );
    assert_eq!(
        harness.server.item_calls.load(Ordering::SeqCst) - item_calls_before,
        3,
        "both ordered Item events and final operation authority reconcile in one catch-up"
    );
    assert_eq!(harness.server.outcome_lookups() - outcomes_before, 1);
    let requests = harness.server.requests.lock().unwrap().clone();
    let catch_up_requests = &requests[request_start..];
    let changes: Vec<_> = catch_up_requests
        .iter()
        .filter(|request| request.url.contains("/api/v1/sync/changes"))
        .collect();
    assert_eq!(changes.len(), 2);
    assert_eq!(
        changes[0].url,
        "https://vault.example.test/api/v1/sync/changes?limit=100"
    );
    assert_eq!(
        changes[1].url,
        "https://vault.example.test/api/v1/sync/changes?limit=100&sinceId=C1"
    );
    let page_two_changes = catch_up_requests
        .iter()
        .position(|request| request.url == changes[1].url)
        .unwrap();
    let page_two_requests = &catch_up_requests[page_two_changes + 1..];
    let page_two_item_gets: Vec<_> = page_two_requests
        .iter()
        .enumerate()
        .filter(|(_, request)| {
            request.method == "GET"
                && (request.url.ends_with("/api/v1/items/item-existing")
                    || request
                        .url
                        .ends_with("/api/v1/items/item-existing/authority"))
        })
        .map(|(index, _)| index)
        .collect();
    let page_two_outcome_get = page_two_requests
        .iter()
        .position(|request| {
            request.method == "GET"
                && request
                    .url
                    .ends_with(&format!("/api/v1/operations/{operation_id}"))
        })
        .unwrap();
    assert_eq!(page_two_item_gets.len(), 2);
    assert!(page_two_requests[page_two_item_gets[0]]
        .url
        .ends_with("/api/v1/items/item-existing/authority"));
    assert!(page_two_requests[page_two_item_gets[1]]
        .url
        .ends_with("/api/v1/items/item-existing"));
    assert!(page_two_item_gets[0] < page_two_outcome_get);
    assert!(page_two_outcome_get < page_two_item_gets[1]);

    let successful_request_count = requests.len();
    let effects_before_repeat = (
        harness.server.create_calls.load(Ordering::SeqCst),
        harness.server.item_calls.load(Ordering::SeqCst),
        harness.server.outcome_lookups(),
    );
    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(harness.snapshot(), converged);
    assert_eq!(
        (
            harness.server.create_calls.load(Ordering::SeqCst),
            harness.server.item_calls.load(Ordering::SeqCst),
            harness.server.outcome_lookups(),
        ),
        effects_before_repeat
    );
    let repeated_requests = harness.server.requests.lock().unwrap().clone();
    assert_eq!(repeated_requests.len(), successful_request_count + 1);
    assert_eq!(
        repeated_requests.last().unwrap().url,
        "https://vault.example.test/api/v1/sync/changes?limit=100&sinceId=C2"
    );
}

#[tokio::test]
async fn sync_page_terminal_cursor_waits_for_every_operation_event() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let before_page = harness.snapshot();
    harness
        .server
        .script_operation_event("another-device-operation", "sync-first");
    harness
        .server
        .script_operation_event(&operation_id, "sync-second");

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    let blocked = harness.snapshot();
    assert_eq!(blocked.operations.len(), 1);
    assert_eq!(
        blocked.bootstrap.active_cursor, before_page.bootstrap.active_cursor,
        "the foreign first event cannot commit the page watermark past later owed work"
    );

    harness.clock.advance(1_000);
    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    let completed = harness.snapshot();
    assert!(completed.operations.is_empty());
    assert_eq!(completed.receipts.len(), 1);
    assert_eq!(
        completed.bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-second".into(),
        }
    );
}

#[tokio::test]
async fn sync_page_cursor_waits_for_a_later_undecided_operation_lookup() {
    let harness = seeded_with_existing_item(false, false).await;
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    let before_page = harness.snapshot();
    harness
        .server
        .script_operation_event("another-device-operation", "sync-lookup-first");
    harness
        .server
        .script_operation_event(&operation_id, "sync-lookup-second");

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        harness.snapshot().bootstrap.active_cursor,
        before_page.bootstrap.active_cursor
    );
    assert_eq!(harness.snapshot().operations.len(), 1);

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    assert!(harness.snapshot().operations.is_empty());
    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        harness.snapshot().bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-lookup-second".into(),
        }
    );
}

#[tokio::test]
async fn sync_page_cursor_waits_for_a_later_exact_replay_transport_failure() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    let before_page = harness.snapshot();
    harness
        .server
        .script_operation_event("another-device-operation", "sync-replay-first");
    harness
        .server
        .script_operation_event(&operation_id, "sync-replay-second");
    harness.server.script([Fault::NetworkFailure]);

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    let scheduled = harness.snapshot();
    assert_eq!(
        scheduled.bootstrap.active_cursor,
        before_page.bootstrap.active_cursor
    );
    assert_eq!(scheduled.operations[0].scheduling.attempt_count, 2);

    harness.clock.advance(2_000);
    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    assert!(harness.snapshot().operations.is_empty());
    assert_eq!(
        harness.snapshot().bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-replay-second".into(),
        }
    );
}

#[tokio::test]
async fn mixed_sync_page_cursor_waits_for_a_later_authority_fetch_failure() {
    let harness = seeded_with_existing_item(false, false).await;
    let before_page = harness.snapshot();
    harness
        .server
        .script_operation_event("another-device-operation", "sync-mixed-authority");
    harness
        .server
        .sync_events
        .lock()
        .unwrap()
        .push(serde_json::json!({
            "clientId": null,
            "entityId": "item-existing",
            "entityType": "item",
            "id": "sync-mixed-authority",
            "metadata": null,
            "timestamp": "1700000000000",
            "type": "item_updated",
            "userId": USER,
            "vaultId": "vault-1",
            "version": 1,
        }));
    harness.server.script_item_faults([Fault::NetworkFailure]);

    assert!(harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .is_err());
    assert_eq!(
        harness.snapshot().bootstrap.active_cursor,
        before_page.bootstrap.active_cursor
    );

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    assert_eq!(
        harness.snapshot().bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-mixed-authority".into(),
        }
    );
}

#[tokio::test]
async fn sync_page_cursor_waits_for_a_later_reconciliation_commit_failure() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness.clock.advance(1_000);
    let before_page = harness.snapshot();
    harness
        .server
        .script_operation_event("another-device-operation", "sync-commit-first");
    harness
        .server
        .script_operation_event(&operation_id, "sync-commit-second");
    harness.replica.fail_next_commits(1);

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    let stalled = harness.snapshot();
    assert_eq!(
        stalled.bootstrap.active_cursor,
        before_page.bootstrap.active_cursor
    );
    assert_eq!(stalled.operations.len(), 1);
    assert!(stalled.receipts.is_empty());

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();
    assert!(harness.snapshot().operations.is_empty());
    assert_eq!(harness.snapshot().receipts.len(), 1);
    assert_eq!(
        harness.snapshot().bootstrap.active_cursor,
        crate::replica::SyncCursor::CapturedValue {
            id: "sync-commit-second".into(),
        }
    );
}

#[tokio::test]
async fn sync_reconciliation_keeps_the_session_renewed_by_an_authoritative_fetch() {
    let harness = seeded(false).await;
    harness.server.lose_next_response();
    let (operation_id, item_id) = harness.accept_create().await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    assert_eq!(harness.server.created_items(), vec![item_id.clone()]);

    harness.clock.advance(1_000);
    harness.server.script_item_faults([Fault::Status(401)]);
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
    harness
        .server
        .script_operation_event(&operation_id, "sync-8");
    harness
        .server
        .sync_events
        .lock()
        .unwrap()
        .push(serde_json::json!({
            "clientId": null,
            "entityId": item_id,
            "entityType": "item",
            "id": "sync-8",
            "metadata": null,
            "timestamp": "1700000000000",
            "type": "item_updated",
            "userId": USER,
            "vaultId": "vault-1",
            "version": 1,
        }));

    harness
        .runtime
        .bootstrap_account(&harness.account_id, RequestCancellation::new())
        .await
        .unwrap();

    let item_authorizations: Vec<_> = harness
        .server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.url.contains("/api/v1/items/"))
        .map(|request| request.header("authorization").unwrap().to_owned())
        .collect();
    assert_eq!(
        item_authorizations,
        vec![
            format!("Bearer {FIRST_TOKEN}"),
            format!("Bearer {SECOND_TOKEN}"),
            format!("Bearer {SECOND_TOKEN}"),
        ],
        "the next Sync event must use the Session renewed during reconciliation"
    );
    assert!(
        harness
            .server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.url.ends_with("/authority")
                && request.header("authorization")
                    == Some(format!("Bearer {SECOND_TOKEN}").as_str())),
        "the complete Item authority read also uses the renewed Session"
    );
    assert_eq!(
        harness.server.refresh_calls.load(Ordering::SeqCst),
        1,
        "one catch-up flow must not refresh the stale credential again"
    );
}

#[tokio::test]
async fn reconciliation_is_one_transaction_and_a_failed_commit_changes_nothing() {
    // Time is held, so the Runtime stops in the state a rejected commit leaves behind.
    let harness = seeded(true).await;
    let (operation_id, item_id) = harness.accept_create().await;
    let before = harness.snapshot();
    harness.replica.fail_next_commits(1);

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the reconciliation commit was attempted and failed", || {
        harness.replica.failed_commits() == 1
    })
    .await;
    until(
        "the failed reconciliation reschedules the Operation",
        || {
            harness
                .snapshot()
                .operations
                .first()
                .is_some_and(|operation| operation.scheduling.attempt_count >= 1)
        },
    )
    .await;
    settle().await;

    let stalled = harness.snapshot();
    assert_eq!(
        stalled.operations[0].request, before.operations[0].request,
        "the immutable bytes never moved"
    );
    assert_eq!(
        stalled.operations[0].request_fingerprint,
        before.operations[0].request_fingerprint
    );
    assert_eq!(stalled.items, before.items);
    assert!(
        stalled.receipts.is_empty(),
        "a failed commit inserts no receipt"
    );
    assert!(harness.authority_items().is_empty());
    assert_eq!(harness.active_cursor(), before.bootstrap.active_cursor);
    assert_eq!(
        harness.snapshot().bootstrap.active_generation,
        before.bootstrap.active_generation,
        "the Bootstrap generation this Replica reads is unchanged"
    );

    // The retry commits the identical plan, and one Server effect stays one Item.
    harness.clock.advance(1_000);
    harness.timer.hold.store(false, Ordering::SeqCst);
    harness.timer.released.notify_waiters();
    until("the retry reconciles", || {
        harness.snapshot().operations.is_empty()
    })
    .await;
    settle().await;
    assert_reconciled(&harness, &operation_id, &item_id);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn rotation_outcomes_never_resolve_an_accepted_item_operation() {
    let harness = seeded_with_existing_item(false, false).await;
    harness
        .accept_existing(OrdinaryItemCase::Update.request(harness.account_id.clone()))
        .await;
    let operation = harness.operation().unwrap();
    for (kind, code) in [
        (
            "create_vault_member_removal_rotation_plans",
            "vault_member_not_found",
        ),
        (
            "finalize_vault_member_removal_rotation_plans",
            "vault_membership_changed",
        ),
        ("create_team_leave_rotation_plans", "team_member_not_found"),
        (
            "finalize_team_leave_rotation_plans",
            "team_membership_changed",
        ),
        (
            "create_team_member_removal_rotation_plans",
            "team_member_not_found",
        ),
        (
            "finalize_team_member_removal_rotation_plans",
            "team_membership_changed",
        ),
    ] {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "operationId": operation.operation_id,
            "kind": kind,
            "result": {"status": "rejected", "code": code},
        }))
        .unwrap();
        assert!(
            matches!(
                harness
                    .runtime
                    .read_dispatch_answer(&operation, 200, &bytes),
                super::outcome::SemanticAnswer::IdentityReused
            ),
            "known Rotation kind {kind} is another operation, not a transient parse failure"
        );
    }
}

#[tokio::test]
async fn remote_rotation_resolution_events_advance_sync_without_lookup_or_account_failure() {
    let harness = seeded(false).await;
    let before = harness.snapshot();
    let lookups_before = harness.server.outcome_lookups();
    for (index, kind) in [
        "create_vault_member_removal_rotation_plans",
        "finalize_vault_member_removal_rotation_plans",
        "create_team_leave_rotation_plans",
        "finalize_team_leave_rotation_plans",
        "create_team_member_removal_rotation_plans",
        "finalize_team_member_removal_rotation_plans",
    ]
    .iter()
    .enumerate()
    {
        // The Server's Sync event carries the Operation ID, not its retained kind. A
        // nonpending remote ID is consumed before any outcome lookup/deserialization.
        let cursor = format!("rotation-sync-{index}");
        harness
            .server
            .script_operation_event(&format!("remote-{kind}"), &cursor);
        harness
            .runtime
            .bootstrap_account(&harness.account_id, RequestCancellation::new())
            .await
            .unwrap();
        let advanced = harness.snapshot();
        assert_eq!(advanced.failure, None);
        assert_eq!(advanced.items, before.items);
        assert_eq!(advanced.operations, before.operations);
        assert_eq!(advanced.receipts, before.receipts);
        assert_eq!(
            advanced.bootstrap.active_cursor,
            crate::replica::SyncCursor::CapturedValue { id: cursor }
        );
    }
    assert_eq!(harness.server.outcome_lookups(), lookups_before);
}

/// The retained action and current Item visibility are separate Server facts. The fake transport
/// applies/retains the actual command before response loss, then removes the Item or refuses its read.
async fn assert_retained_applied_item_completes_without_current_authority(
    case: Option<OrdinaryItemCase>,
    unavailable: bool,
) {
    let harness = seeded_with_existing_item(
        false,
        case.is_some_and(OrdinaryItemCase::needs_deleted_authority),
    )
    .await;
    let before = harness.snapshot();
    let vaults = before.bootstrap.snapshot().visible_vaults;
    harness.server.lose_next_response();
    let (operation_id, item_id) = match case {
        Some(case) => {
            harness
                .accept_existing(case.request(harness.account_id.clone()))
                .await
        }
        None => harness.accept_create().await,
    };
    let accepted = harness.operation().unwrap();
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    assert_eq!(
        harness.snapshot().operations.len(),
        1,
        "lost response leaves accepted work"
    );
    assert!(
        harness
            .server
            .outcomes
            .lock()
            .unwrap()
            .contains_key(&operation_id),
        "the Server retained the actual applied action before the Item disappeared"
    );
    if unavailable {
        harness.server.script_item_faults([Fault::Status(403)]);
    } else {
        harness
            .server
            .created_items
            .lock()
            .unwrap()
            .retain(|item| item.id != item_id);
    }
    harness.clock.advance(1_000);
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let completed = harness.snapshot();
    assert_eq!(
        completed.failure, None,
        "{case:?}: unavailable current authority must not fail the Account"
    );
    assert!(
        completed.operations.is_empty(),
        "{case:?}: exact retained action must finish despite unavailable current authority"
    );
    assert!(
        completed.items.is_empty(),
        "{case:?}: the completed overlay must not resurrect the Item"
    );
    assert_eq!(completed.receipts.len(), 1);
    let receipt = &completed.receipts[0];
    assert_eq!(receipt.operation_id, operation_id);
    assert_eq!(receipt.kind, accepted.kind);
    assert_eq!(receipt.request_fingerprint, accepted.request_fingerprint);
    assert_eq!(
        receipt.result,
        OperationOutcomeResult::Applied {
            entity_id: item_id.clone(),
            version: if case.is_some() { 2 } else { 1 }
        }
    );
    assert_eq!(
        harness.authority_items(),
        before.bootstrap.snapshot().visible_items,
        "receipt-only completion preserves cached authority until fresh Bootstrap"
    );
    assert_eq!(
        completed.bootstrap.state,
        crate::replica::ReplicaState::RefreshRequired
    );
    assert_eq!(
        completed.bootstrap.snapshot().visible_vaults,
        vaults,
        "a current Item read failure makes no Vault-wide authority claim"
    );
    if case.is_none() {
        assert!(
            harness
                .authority_items()
                .iter()
                .any(|item| item.id == "item-existing"),
            "another Item in the same Vault retains its authority"
        );
    }
    assert!(
        harness.server.outcome_lookups() >= 1,
        "completion uses the retained outcome after response loss"
    );
    let requests = if case.is_some() {
        harness.server.existing_item_mutation_requests()
    } else {
        harness.server.create_requests()
    };
    assert_eq!(
        requests.len(),
        2,
        "the lost answer is recovered through exact immutable replay"
    );
    harness.runtime.close().await;
}

#[tokio::test]
async fn retained_applied_create_completes_after_current_item_absence() {
    assert_retained_applied_item_completes_without_current_authority(None, false).await;
}

#[tokio::test]
async fn retained_applied_ordinary_items_complete_after_current_item_absence() {
    for case in OrdinaryItemCase::ALL {
        assert_retained_applied_item_completes_without_current_authority(Some(case), false).await;
    }
}

async fn assert_create_hint_cannot_complete_other_request_bytes(sync: bool, unavailable: bool) {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, item_id) = harness.accept_create().await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness
        .server
        .outcomes
        .lock()
        .unwrap()
        .get_mut(&operation_id)
        .unwrap()
        .fingerprint = [99; 32];
    if unavailable {
        harness.server.script_item_faults([Fault::Status(403)]);
    } else {
        harness
            .server
            .created_items
            .lock()
            .unwrap()
            .retain(|item| item.id != item_id);
    }
    harness.clock.advance(1_000);
    harness
        .server
        .script_operation_event(&operation_id, "must-not-pass-unproved-create");
    let before = harness.snapshot();
    let reads_before = harness
        .server
        .item_calls
        .load(std::sync::atomic::Ordering::SeqCst);
    if sync {
        let _ = harness
            .runtime
            .bootstrap_account(&harness.account_id, RequestCancellation::new())
            .await;
    } else {
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
    }
    let after = harness.snapshot();
    assert_eq!(
        after.failure,
        Some(RuntimeErrorCode::InvariantViolation),
        "lookup supplies no request fingerprint; only exact replay proves identity"
    );
    assert_eq!(after.operations, before.operations);
    assert_eq!(after.items, before.items);
    assert!(after.receipts.is_empty());
    assert_eq!(
        after.bootstrap.active_cursor,
        before.bootstrap.active_cursor
    );
    assert_eq!(
        harness
            .server
            .item_calls
            .load(std::sync::atomic::Ordering::SeqCst),
        reads_before,
        "unproved request identity cannot be rescued by any current read"
    );
    harness.runtime.close().await;
}

#[tokio::test]
async fn absent_create_sync_hint_cannot_complete_other_request_bytes() {
    assert_create_hint_cannot_complete_other_request_bytes(true, false).await;
}

#[tokio::test]
async fn absent_create_dispatch_hint_cannot_complete_other_request_bytes() {
    assert_create_hint_cannot_complete_other_request_bytes(false, false).await;
}

#[tokio::test]
async fn retired_move_source_uses_current_category_witness_for_a_pre_retirement_clone() {
    let harness = seeded_with_existing_item(false, false).await;
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Move.request(harness.account_id.clone()))
        .await;
    let mut old_clone = harness.operation().unwrap();
    old_clone.accepted_item_category = None;
    harness.server.lose_next_response();
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let snapshot = harness.snapshot();
    assert_eq!(
        snapshot.operations.len(),
        1,
        "Server effect survived its lost answer"
    );
    harness
        .runtime
        .replica
        .execute_exact(GuardedCommitPlan::new(
            harness.account_id.clone(),
            snapshot.incarnation.clone(),
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::RetireVaults {
                vault_ids: vec![TEST_VAULT_ID.into()],
            }],
        ))
        .await
        .unwrap();
    assert!(harness.snapshot().items.is_empty());
    assert_eq!(
        harness.snapshot().operations[0].accepted_item_category,
        Some(crate::replica::AuthorityItemCategory::Login)
    );
    let mut session = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    let http = AuthHttpClient::new(
        &harness.runtime.http_transport,
        SERVER_URL,
        false,
        auth_config(),
    )
    .unwrap();
    let result = harness
        .runtime
        .complete_operation(
            &harness.account_id,
            &old_clone,
            crate::replica::ObservedOutcome {
                operation_id: operation_id.clone(),
                request_fingerprint: old_clone.request_fingerprint,
                result: OperationOutcomeResult::Applied {
                    entity_id: "item-existing".into(),
                    version: 2,
                },
            },
            &http,
            &mut session,
            None,
        )
        .await;
    assert!(matches!(
        result,
        super::outcome::CompletionResult::Completed
    ));
    let snapshot = harness.snapshot();
    assert!(snapshot.operations.is_empty());
    assert!(snapshot.failure.is_none());
    assert_eq!(snapshot.receipts[0].operation_id, operation_id);
    assert_eq!(harness.authority_items()[0].vault_id, "vault-2");
}

#[tokio::test]
async fn retained_item_absence_receipts_without_deleting_cached_current_authority() {
    let harness = seeded_with_existing_item(false, false).await;
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Favorite.request(harness.account_id.clone()))
        .await;
    harness.server.lose_next_response();
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let before = harness.authority_items();
    harness.server.created_items.lock().unwrap().clear();
    harness.clock.advance(1_000);
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let after = harness.snapshot();
    assert!(after.operations.is_empty());
    assert_eq!(after.receipts.len(), 1);
    assert_eq!(
        harness.authority_items(),
        before,
        "a retained receipt installs no absence into current authority"
    );
    assert_eq!(
        after.bootstrap.state,
        crate::replica::ReplicaState::RefreshRequired
    );
}

#[tokio::test]
async fn retained_duplicate_completion_uses_existing_receipt_without_a_current_authority_fetch() {
    let harness = seeded_with_existing_item(false, false).await;
    let (operation_id, _) = harness
        .accept_existing(OrdinaryItemCase::Favorite.request(harness.account_id.clone()))
        .await;
    let operation = harness.operation().unwrap();
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let snapshot = harness.snapshot();
    let receipt = &snapshot.receipts[0];
    let mut session = harness
        .runtime
        .platform_storage
        .load_current_session(&harness.account_id, &snapshot.incarnation)
        .await
        .unwrap()
        .unwrap();
    let http = AuthHttpClient::new(
        &harness.runtime.http_transport,
        SERVER_URL,
        false,
        auth_config(),
    )
    .unwrap();
    let request_count = harness.server.requests.lock().unwrap().len();
    let completed = harness
        .runtime
        .complete_operation(
            &harness.account_id,
            &operation,
            crate::replica::ObservedOutcome {
                operation_id: receipt.operation_id.clone(),
                request_fingerprint: receipt.request_fingerprint,
                result: receipt.result.clone(),
            },
            &http,
            &mut session,
            None,
        )
        .await;
    assert!(matches!(
        completed,
        super::outcome::CompletionResult::Completed
    ));
    assert_eq!(harness.snapshot(), snapshot);
    assert_eq!(harness.server.requests.lock().unwrap().len(), request_count);
}

async fn assert_retained_sync_result_reaches_refresh_with_one_renewal_budget(unavailable: bool) {
    use crate::http_transport::SerializedHttpExecutor;
    struct BootstrapBoundary {
        server: std::sync::Arc<FakeServer>,
        calls: std::sync::atomic::AtomicUsize,
    }
    #[async_trait::async_trait]
    impl SerializedHttpExecutor for BootstrapBoundary {
        async fn invoke(
            &self,
            request: zeroize::Zeroizing<String>,
        ) -> Result<String, RuntimeError> {
            let value: serde_json::Value = serde_json::from_str(&request).unwrap();
            if value["url"].as_str().unwrap().contains("/sync/bootstrap") {
                self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return Ok(completed(401, b"{}".to_vec()).to_string());
            }
            self.server.invoke(request).await
        }
        fn cancel(&self, id: &str) {
            self.server.cancel(id);
        }
    }
    for structural in [false, true] {
        let harness = seeded_with_existing_item(false, false).await;
        let (operation_id, _) = harness
            .accept_existing(OrdinaryItemCase::Favorite.request(harness.account_id.clone()))
            .await;
        harness.server.lose_next_response();
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        if unavailable {
            harness.server.script_item_faults([Fault::Status(403)]);
        } else {
            let before = harness.snapshot();
            harness
                .runtime
                .replica
                .execute_exact(GuardedCommitPlan::new(
                    harness.account_id.clone(),
                    before.incarnation,
                    before.revision,
                    before.lock_epoch,
                    vec![PlanMutation::RetireVaults {
                        vault_ids: vec![TEST_VAULT_ID.into()],
                    }],
                ))
                .await
                .unwrap();
        }
        harness
            .server
            .script_operation_event(&operation_id, "resolved-before-refresh");
        let events = harness.server.sync_events.lock().unwrap().clone();
        harness.server.sync_pages.lock().unwrap().push_back(serde_json::json!({"events":events,"cursor":{"id":"resolved-before-refresh"},"hasMore":false,"requiresFullRefresh":structural}));
        *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
        harness
            .server
            .outcome_faults
            .lock()
            .unwrap()
            .push_back(Fault::Status(401));
        let http = std::sync::Arc::new(BootstrapBoundary {
            server: harness.server.clone(),
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let runtime = Runtime::with_test_dispatch_environment(
            harness.replica.clone(),
            harness.platform.clone(),
            http.clone(),
            auth_config(),
            harness.clock.clone(),
            harness.timer.clone(),
        );
        runtime.replica.load(&harness.account_id).await.unwrap();
        runtime.unlock_account(&harness.account_id).await.unwrap();
        harness.clock.advance(1_000);
        let result = runtime
            .bootstrap_account(&harness.account_id, RequestCancellation::new())
            .await;
        assert_eq!(
            http.calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "receipt refresh must reach fresh Bootstrap in this pass; structural={structural}"
        );
        assert!(matches!(
            result,
            Err(RuntimeError {
                code: RuntimeErrorCode::AuthenticationRequired,
                ..
            })
        ));
        assert_eq!(
            harness
                .server
                .refresh_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the same bounded pass cannot renew again after replay consumed its budget"
        );
        let after = runtime.replica.snapshot(&harness.account_id).unwrap();
        assert!(after.operations.is_empty());
        assert_eq!(after.receipts.len(), 1);
    }
}

#[tokio::test]
async fn retained_identity_failure_commit_error_keeps_a_durable_retry_schedule() {
    let harness = seeded_with_existing_item(false, false).await;
    harness.server.lose_next_response();
    let (operation_id, _) = harness.accept_create().await;
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    harness
        .server
        .outcomes
        .lock()
        .unwrap()
        .get_mut(&operation_id)
        .unwrap()
        .fingerprint = [99; 32];
    harness.clock.advance(1_000);
    let before = harness.operation().unwrap();
    harness.replica.fail_next_commits(1);
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    let after = harness.snapshot();
    assert!(after.failure.is_none());
    assert_eq!(after.operations.len(), 1);
    assert!(
        after.operations[0].scheduling.attempt_count > before.scheduling.attempt_count,
        "a failed failure commit needs the existing bounded retry wake"
    );
    harness.clock.advance(10_000);
    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    assert_eq!(
        harness.snapshot().failure,
        Some(RuntimeErrorCode::InvariantViolation)
    );
}

#[tokio::test]
async fn retained_applied_create_completes_after_current_item_access_refusal() {
    assert_retained_applied_item_completes_without_current_authority(None, true).await;
}

#[tokio::test]
async fn retained_applied_ordinary_items_complete_after_current_item_access_refusal() {
    for case in OrdinaryItemCase::ALL {
        assert_retained_applied_item_completes_without_current_authority(Some(case), true).await;
    }
}

#[tokio::test]
async fn retained_rejected_items_complete_after_current_item_access_refusal() {
    for case in OrdinaryItemCase::ALL {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        let before = harness.snapshot();
        harness.server.reject_next("vault_access_denied");
        harness.server.lose_next_response();
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        let accepted = harness.operation().unwrap();
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        assert_eq!(harness.snapshot().operations.len(), 1);
        harness.server.script_item_faults([Fault::Status(403)]);
        harness.clock.advance(1_000);
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        let after = harness.snapshot();
        assert_eq!(after.failure, None, "{case:?}");
        assert!(after.operations.is_empty(), "{case:?}");
        assert!(after.items.is_empty(), "{case:?}");
        assert_eq!(
            after.bootstrap.snapshot().visible_items,
            before.bootstrap.snapshot().visible_items
        );
        assert_eq!(
            after.bootstrap.snapshot().visible_vaults,
            before.bootstrap.snapshot().visible_vaults
        );
        assert_eq!(
            after.bootstrap.state,
            crate::replica::ReplicaState::RefreshRequired
        );
        assert_eq!(after.receipts.len(), 1);
        assert_eq!(after.receipts[0].operation_id, operation_id);
        assert_eq!(
            after.receipts[0].request_fingerprint,
            accepted.request_fingerprint
        );
        assert_eq!(
            after.receipts[0].result,
            OperationOutcomeResult::Rejected {
                code: OperationRejectionCode::VaultAccessDenied,
            }
        );
        assert_eq!(harness.server.existing_item_mutation_requests().len(), 2);
        harness.runtime.close().await;
    }
}

#[tokio::test]
async fn retained_sync_result_refreshes_in_the_same_pass_with_one_renewal_budget() {
    assert_retained_sync_result_reaches_refresh_with_one_renewal_budget(false).await;
}

#[tokio::test]
async fn retained_item_access_refusal_reaches_sync_refresh_with_one_renewal_budget() {
    assert_retained_sync_result_reaches_refresh_with_one_renewal_budget(true).await;
}

#[tokio::test]
async fn unavailable_item_cannot_rescue_an_unproved_retained_create_hint() {
    for sync in [false, true] {
        assert_create_hint_cannot_complete_other_request_bytes(sync, true).await;
    }
}
