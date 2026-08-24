use crate::protocol::Incarnation;
use crate::{AccountId, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

mod domain;
mod persistence_contract;
#[cfg(not(target_arch = "wasm32"))]
mod sqlite;
#[cfg(all(test, not(target_arch = "wasm32")))]
mod sqlite_tests;

#[cfg(not(target_arch = "wasm32"))]
pub use sqlite::SqliteReplica;

#[cfg(test)]
use domain::apply_plan;
use domain::AccountReplica;
#[allow(
    unused_imports,
    reason = "closed Replica types are re-exported for Runtime"
)]
pub(crate) use domain::{
    AbandonBootstrapPlan, AuthorityItemCategory, AuthorityItemRecord, AuthorityVaultRecord,
    AuthorityVaultRole, AuthorityVaultType, BeginBootstrapPlan, BootstrapAuthority,
    BootstrapAuthoritySnapshot, BootstrapContinuation, BootstrapGenerationId, BootstrapGuard,
    BootstrapPageCursor, BootstrapPageIdentity, CleanupBootstrapGenerationPlan,
    CleanupBootstrapGenerationResult, CursorAdvance, GuardedCommitPlan, ImmutableHttpRequest,
    MarkRefreshRequiredPlan, ObservedOutcome, OperationKind, OperationOutcomeResult,
    OperationReceiptRecord, OperationRecord, OperationRejectionCode, OperationSchedulingState,
    PlanMutation, PlanResult, PromoteBootstrapPlan, RecomputedPlanResult, ReplicaItemRecord,
    ReplicaSnapshot, ReplicaState, Sha256Fingerprint, StageBootstrapPagePlan,
    StageBootstrapPageResult, SyncCursor,
};

#[cfg(feature = "persistence-contract-schema")]
#[doc(hidden)]
pub use persistence_contract::persistence_contract_schema;
pub(crate) use persistence_contract::ReplicaPersistenceRequest;
use persistence_contract::{
    apply_prepared_writes_to_rows, prepare_bootstrap_commit, prepare_commit, prepare_install,
    reconstruct_snapshot, replica_invariant, snapshot_rows, ExpectedReplicaInstall,
    LockEpochAdvanceResult, PreparedCommitOutcome, PreparedLockEpochAdvance, ReplicaInstallResult,
};
use persistence_contract::{ReplicaHead, ReplicaPersistenceResponse};
#[cfg(test)]
use persistence_contract::{ReplicaRowKey, ReplicaStore, StoredReplicaRow};

#[cfg(not(target_arch = "wasm32"))]
pub(crate) trait PersistenceRequirements: Send + Sync {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync> PersistenceRequirements for T {}

#[cfg(target_arch = "wasm32")]
pub(crate) trait PersistenceRequirements {}
#[cfg(target_arch = "wasm32")]
impl<T> PersistenceRequirements for T {}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub(crate) trait ReplicaPersistence: PersistenceRequirements {
    async fn invoke(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError>;
}

#[cfg(test)]
mod bootstrap_authority_tests {
    use super::*;

    fn installed() -> (InMemoryReplica, AccountId) {
        let replica = InMemoryReplica::default();
        let account_id = AccountId::from("account-bootstrap");
        replica
            .install(
                account_id.clone(),
                "user-bootstrap".into(),
                Incarnation::from("incarnation-bootstrap"),
            )
            .unwrap();
        (replica, account_id)
    }

    fn guard(account_id: &AccountId, revision: u64) -> BootstrapGuard {
        BootstrapGuard {
            account_id: account_id.clone(),
            user_id: "user-bootstrap".into(),
            incarnation: Incarnation::from("incarnation-bootstrap"),
            expected_replica_revision: revision,
            expected_lock_epoch: 0,
        }
    }

    fn generation(value: &str) -> BootstrapGenerationId {
        BootstrapGenerationId(value.into())
    }

    fn vault(value: &str) -> AuthorityVaultRecord {
        AuthorityVaultRecord {
            id: value.into(),
            name: format!("Vault {value}"),
            vault_type: AuthorityVaultType::Personal,
            icon: None,
            image_url: None,
            encrypted_vault_key: format!("wrapped-{value}"),
            role: AuthorityVaultRole::Owner,
        }
    }

    fn item(value: &str, vault_id: &str) -> AuthorityItemRecord {
        AuthorityItemRecord {
            id: value.into(),
            vault_id: vault_id.into(),
            category: AuthorityItemCategory::Login,
            favorite: false,
            encrypted_data: format!("ciphertext-{value}"),
            encryption_iv: format!("iv-{value}"),
            encryption_algorithm: "AES-GCM".into(),
            version: 1,
            encryption_version: 1,
            encrypted_by_user_id: "user-bootstrap".into(),
            last_modified_by: "user-bootstrap".into(),
            created_at: "2026-08-23T00:00:00Z".into(),
            updated_at: "2026-08-23T00:00:00Z".into(),
            deleted_at: None,
            attachments: vec![],
        }
    }

    fn begin(
        replica: &InMemoryReplica,
        account_id: &AccountId,
        revision: u64,
        generation_id: &str,
    ) -> PlanResult {
        replica
            .begin_bootstrap(BeginBootstrapPlan {
                guard: guard(account_id, revision),
                generation_id: generation(generation_id),
            })
            .unwrap()
    }

    #[allow(clippy::too_many_arguments, reason = "test plan fields stay explicit")]
    fn page(
        account_id: &AccountId,
        revision: u64,
        generation_id: &str,
        page_identity: u64,
        request_cursor: BootstrapPageCursor,
        fingerprint_byte: u8,
        watermark: SyncCursor,
        continuation: BootstrapContinuation,
        item_id: &str,
    ) -> StageBootstrapPagePlan {
        StageBootstrapPagePlan {
            guard: guard(account_id, revision),
            generation_id: generation(generation_id),
            page_identity: BootstrapPageIdentity(page_identity),
            request_cursor,
            raw_response_fingerprint: Sha256Fingerprint([fingerprint_byte; 32]),
            pinned_watermark: watermark,
            continuation,
            vaults: vec![vault("vault-1")],
            items: vec![item(item_id, "vault-1")],
        }
    }

    fn promote(
        replica: &InMemoryReplica,
        account_id: &AccountId,
        revision: u64,
        generation_id: &str,
    ) -> PlanResult {
        replica
            .promote_bootstrap(PromoteBootstrapPlan {
                guard: guard(account_id, revision),
                generation_id: generation(generation_id),
            })
            .unwrap()
    }

    #[test]
    fn bootstrap_is_cold_then_promotes_only_a_complete_captured_generation() {
        let (replica, account_id) = installed();
        let cold = replica.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(cold.state, ReplicaState::Cold);
        assert_eq!(cold.active_cursor, SyncCursor::Cold);
        assert!(cold.active_generation.is_none());

        assert_eq!(
            begin(&replica, &account_id, 0, "generation-1"),
            PlanResult::Applied {
                replica_revision: 1
            }
        );
        assert!(replica
            .promote_bootstrap(PromoteBootstrapPlan {
                guard: guard(&account_id, 1),
                generation_id: generation("generation-1"),
            })
            .is_err());
        assert_eq!(replica.snapshot(&account_id).unwrap().revision, 1);

        assert_eq!(
            replica
                .stage_bootstrap_page(page(
                    &account_id,
                    1,
                    "generation-1",
                    0,
                    BootstrapPageCursor::Initial,
                    1,
                    SyncCursor::CapturedEmpty,
                    BootstrapContinuation::Final,
                    "item-1",
                ))
                .unwrap(),
            StageBootstrapPageResult::Applied
        );
        assert_eq!(replica.snapshot(&account_id).unwrap().revision, 1);
        let staged = replica.bootstrap_snapshot(&account_id).unwrap();
        assert!(staged.visible_items.is_empty());
        assert_eq!(staged.staged_item_count, 1);

        assert_eq!(
            promote(&replica, &account_id, 1, "generation-1"),
            PlanResult::Applied {
                replica_revision: 2
            }
        );
        let ready = replica.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(ready.state, ReplicaState::Ready);
        assert_eq!(ready.active_cursor, SyncCursor::CapturedEmpty);
        assert_eq!(ready.visible_items, vec![item("item-1", "vault-1")]);
    }

    #[test]
    fn old_ready_authority_remains_visible_until_the_new_generation_promotes() {
        let (replica, account_id) = installed();
        begin(&replica, &account_id, 0, "old");
        replica
            .stage_bootstrap_page(page(
                &account_id,
                1,
                "old",
                0,
                BootstrapPageCursor::Initial,
                1,
                SyncCursor::CapturedValue {
                    id: "event-1".into(),
                },
                BootstrapContinuation::Final,
                "old-item",
            ))
            .unwrap();
        promote(&replica, &account_id, 1, "old");

        begin(&replica, &account_id, 2, "new");
        replica
            .stage_bootstrap_page(page(
                &account_id,
                3,
                "new",
                0,
                BootstrapPageCursor::Initial,
                2,
                SyncCursor::CapturedValue {
                    id: "event-2".into(),
                },
                BootstrapContinuation::Final,
                "new-item",
            ))
            .unwrap();
        let staging = replica.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(staging.state, ReplicaState::Bootstrapping);
        assert_eq!(staging.visible_items, vec![item("old-item", "vault-1")]);

        promote(&replica, &account_id, 3, "new");
        let promoted = replica.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(promoted.visible_items, vec![item("new-item", "vault-1")]);
        assert_eq!(
            promoted.active_cursor,
            SyncCursor::CapturedValue {
                id: "event-2".into()
            }
        );
    }

    #[test]
    fn refresh_required_keeps_the_active_generation_readable() {
        let (replica, account_id) = installed();
        begin(&replica, &account_id, 0, "old");
        replica
            .stage_bootstrap_page(page(
                &account_id,
                1,
                "old",
                0,
                BootstrapPageCursor::Initial,
                1,
                SyncCursor::CapturedValue {
                    id: "event-1".into(),
                },
                BootstrapContinuation::Final,
                "old-item",
            ))
            .unwrap();
        promote(&replica, &account_id, 1, "old");

        assert_eq!(
            replica
                .mark_refresh_required(MarkRefreshRequiredPlan {
                    guard: guard(&account_id, 2),
                })
                .unwrap(),
            PlanResult::Applied {
                replica_revision: 3
            }
        );
        let refresh = replica.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(refresh.state, ReplicaState::RefreshRequired);
        assert_eq!(refresh.visible_items, vec![item("old-item", "vault-1")]);

        begin(&replica, &account_id, 3, "new");
        let staging = replica.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(staging.state, ReplicaState::Bootstrapping);
        assert_eq!(staging.visible_items, vec![item("old-item", "vault-1")]);
        assert_eq!(
            replica
                .snapshot(&account_id)
                .unwrap()
                .bootstrap
                .generations
                .get(&generation("new"))
                .unwrap()
                .fallback_state,
            ReplicaState::RefreshRequired
        );

        let cold = InMemoryReplica::default();
        let cold_account = AccountId::from("account-cold");
        cold.install(
            cold_account.clone(),
            "user-bootstrap".into(),
            Incarnation::from("incarnation-bootstrap"),
        )
        .unwrap();
        assert_eq!(
            cold.mark_refresh_required(MarkRefreshRequiredPlan {
                guard: guard(&cold_account, 0),
            })
            .unwrap_err()
            .code,
            RuntimeErrorCode::InvariantViolation
        );
    }

    #[test]
    fn page_replay_is_exact_and_mismatch_has_no_effect() {
        let (replica, account_id) = installed();
        begin(&replica, &account_id, 0, "generation-1");
        let first = page(
            &account_id,
            1,
            "generation-1",
            0,
            BootstrapPageCursor::Initial,
            7,
            SyncCursor::CapturedValue {
                id: "event-1".into(),
            },
            BootstrapContinuation::More {
                next_cursor: "page-2".into(),
            },
            "item-1",
        );
        assert_eq!(
            replica.stage_bootstrap_page(first.clone()).unwrap(),
            StageBootstrapPageResult::Applied
        );
        let after_apply = replica.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(
            replica.stage_bootstrap_page(first.clone()).unwrap(),
            StageBootstrapPageResult::Replayed
        );
        assert_eq!(
            replica.bootstrap_snapshot(&account_id).unwrap(),
            after_apply
        );

        let mut mismatch = first;
        mismatch.raw_response_fingerprint = Sha256Fingerprint([8; 32]);
        assert_eq!(
            replica.stage_bootstrap_page(mismatch).unwrap(),
            StageBootstrapPageResult::ReplayMismatch
        );
        assert_eq!(
            replica.bootstrap_snapshot(&account_id).unwrap(),
            after_apply
        );

        assert_eq!(
            replica
                .stage_bootstrap_page(page(
                    &account_id,
                    1,
                    "generation-1",
                    1,
                    BootstrapPageCursor::After {
                        cursor: "page-2".into()
                    },
                    9,
                    SyncCursor::CapturedValue {
                        id: "event-1".into()
                    },
                    BootstrapContinuation::Final,
                    "item-2",
                ))
                .unwrap(),
            StageBootstrapPageResult::Applied
        );
    }

    #[test]
    fn every_bootstrap_command_obeys_identity_revision_and_lock_guards() {
        let (replica, account_id) = installed();
        let mut wrong = guard(&account_id, 0);
        wrong.user_id = "another-user".into();
        assert_eq!(
            replica
                .begin_bootstrap(BeginBootstrapPlan {
                    guard: wrong,
                    generation_id: generation("stale"),
                })
                .unwrap(),
            PlanResult::Stale { actual_revision: 0 }
        );
        let mut wrong = guard(&account_id, 0);
        wrong.incarnation = Incarnation::from("another-incarnation");
        assert_eq!(
            replica
                .begin_bootstrap(BeginBootstrapPlan {
                    guard: wrong,
                    generation_id: generation("stale"),
                })
                .unwrap(),
            PlanResult::Stale { actual_revision: 0 }
        );
        let mut wrong = guard(&account_id, 0);
        wrong.expected_lock_epoch = 1;
        assert_eq!(
            replica
                .begin_bootstrap(BeginBootstrapPlan {
                    guard: wrong,
                    generation_id: generation("stale"),
                })
                .unwrap(),
            PlanResult::Stale { actual_revision: 0 }
        );
        assert_eq!(
            begin(&replica, &account_id, 1, "wrong-revision"),
            PlanResult::Stale { actual_revision: 0 }
        );

        assert_eq!(
            replica
                .begin_bootstrap(BeginBootstrapPlan {
                    guard: BootstrapGuard {
                        account_id: AccountId::from("missing"),
                        ..guard(&account_id, 0)
                    },
                    generation_id: generation("missing"),
                })
                .unwrap(),
            PlanResult::Missing
        );

        begin(&replica, &account_id, 0, "guarded");
        let unchanged = replica.bootstrap_snapshot(&account_id).unwrap();
        let mut stale_page = page(
            &account_id,
            1,
            "guarded",
            0,
            BootstrapPageCursor::Initial,
            1,
            SyncCursor::CapturedEmpty,
            BootstrapContinuation::Final,
            "item-1",
        );
        stale_page.guard.user_id = "another-user".into();
        assert_eq!(
            replica.stage_bootstrap_page(stale_page).unwrap(),
            StageBootstrapPageResult::Stale { actual_revision: 1 }
        );
        let mut stale_promote = guard(&account_id, 1);
        stale_promote.incarnation = Incarnation::from("another-incarnation");
        assert_eq!(
            replica
                .promote_bootstrap(PromoteBootstrapPlan {
                    guard: stale_promote,
                    generation_id: generation("guarded"),
                })
                .unwrap(),
            PlanResult::Stale { actual_revision: 1 }
        );
        assert_eq!(
            replica
                .abandon_bootstrap(AbandonBootstrapPlan {
                    guard: guard(&account_id, 2),
                    generation_id: generation("guarded"),
                })
                .unwrap(),
            PlanResult::Stale { actual_revision: 1 }
        );
        let mut stale_cleanup = guard(&account_id, 1);
        stale_cleanup.expected_lock_epoch = 1;
        assert_eq!(
            replica
                .cleanup_bootstrap_generation(CleanupBootstrapGenerationPlan {
                    guard: stale_cleanup,
                    generation_id: generation("guarded"),
                })
                .unwrap(),
            CleanupBootstrapGenerationResult::Stale { actual_revision: 1 }
        );
        assert_eq!(replica.bootstrap_snapshot(&account_id).unwrap(), unchanged);
    }

    #[test]
    fn abandon_and_cleanup_restore_visibility_and_protect_reachable_generations() {
        let (replica, account_id) = installed();
        begin(&replica, &account_id, 0, "active");
        replica
            .stage_bootstrap_page(page(
                &account_id,
                1,
                "active",
                0,
                BootstrapPageCursor::Initial,
                1,
                SyncCursor::CapturedEmpty,
                BootstrapContinuation::Final,
                "kept-item",
            ))
            .unwrap();
        promote(&replica, &account_id, 1, "active");
        assert_eq!(
            replica
                .cleanup_bootstrap_generation(CleanupBootstrapGenerationPlan {
                    guard: guard(&account_id, 2),
                    generation_id: generation("active"),
                })
                .unwrap(),
            CleanupBootstrapGenerationResult::Protected
        );

        begin(&replica, &account_id, 2, "abandoned");
        assert_eq!(
            replica
                .cleanup_bootstrap_generation(CleanupBootstrapGenerationPlan {
                    guard: guard(&account_id, 3),
                    generation_id: generation("abandoned"),
                })
                .unwrap(),
            CleanupBootstrapGenerationResult::Protected
        );
        assert_eq!(
            replica
                .abandon_bootstrap(AbandonBootstrapPlan {
                    guard: guard(&account_id, 3),
                    generation_id: generation("abandoned"),
                })
                .unwrap(),
            PlanResult::Applied {
                replica_revision: 4
            }
        );
        let ready = replica.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(ready.state, ReplicaState::Ready);
        assert_eq!(ready.visible_items, vec![item("kept-item", "vault-1")]);

        let cleanup = CleanupBootstrapGenerationPlan {
            guard: guard(&account_id, 4),
            generation_id: generation("abandoned"),
        };
        assert_eq!(
            replica
                .cleanup_bootstrap_generation(cleanup.clone())
                .unwrap(),
            CleanupBootstrapGenerationResult::Applied
        );
        assert_eq!(
            replica.cleanup_bootstrap_generation(cleanup).unwrap(),
            CleanupBootstrapGenerationResult::Applied
        );
        assert_eq!(replica.snapshot(&account_id).unwrap().revision, 4);
        assert_eq!(
            replica
                .bootstrap_snapshot(&account_id)
                .unwrap()
                .generation_ids,
            vec![generation("active")]
        );
    }

    #[test]
    fn abandoning_the_first_generation_restores_cold_without_exposing_rows() {
        let (replica, account_id) = installed();
        begin(&replica, &account_id, 0, "abandoned-cold");
        replica
            .stage_bootstrap_page(page(
                &account_id,
                1,
                "abandoned-cold",
                0,
                BootstrapPageCursor::Initial,
                1,
                SyncCursor::CapturedEmpty,
                BootstrapContinuation::Final,
                "never-visible",
            ))
            .unwrap();
        assert_eq!(
            replica
                .abandon_bootstrap(AbandonBootstrapPlan {
                    guard: guard(&account_id, 1),
                    generation_id: generation("abandoned-cold"),
                })
                .unwrap(),
            PlanResult::Applied {
                replica_revision: 2
            }
        );
        let snapshot = replica.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(snapshot.state, ReplicaState::Cold);
        assert_eq!(snapshot.active_cursor, SyncCursor::Cold);
        assert!(snapshot.visible_items.is_empty());
        assert_eq!(snapshot.staged_item_count, 0);
    }

    #[test]
    fn invalid_page_watermark_cursor_and_duplicates_leave_staging_unchanged() {
        let (replica, account_id) = installed();
        begin(&replica, &account_id, 0, "generation-1");
        let before = replica.bootstrap_snapshot(&account_id).unwrap();

        let mut cold = page(
            &account_id,
            1,
            "generation-1",
            0,
            BootstrapPageCursor::Initial,
            1,
            SyncCursor::Cold,
            BootstrapContinuation::Final,
            "item-1",
        );
        assert_eq!(
            replica.stage_bootstrap_page(cold.clone()).unwrap_err().code,
            RuntimeErrorCode::InvariantViolation
        );
        cold.pinned_watermark = SyncCursor::CapturedEmpty;
        cold.request_cursor = BootstrapPageCursor::After {
            cursor: "wrong".into(),
        };
        assert_eq!(
            replica.stage_bootstrap_page(cold.clone()).unwrap_err().code,
            RuntimeErrorCode::InvariantViolation
        );
        cold.request_cursor = BootstrapPageCursor::Initial;
        cold.items.push(cold.items[0].clone());
        assert_eq!(
            replica.stage_bootstrap_page(cold).unwrap_err().code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(replica.bootstrap_snapshot(&account_id).unwrap(), before);
    }

    #[test]
    fn later_pages_must_preserve_the_pinned_nullable_watermark_and_page_position() {
        let (replica, account_id) = installed();
        begin(&replica, &account_id, 0, "generation-1");
        replica
            .stage_bootstrap_page(page(
                &account_id,
                1,
                "generation-1",
                0,
                BootstrapPageCursor::Initial,
                1,
                SyncCursor::CapturedEmpty,
                BootstrapContinuation::More {
                    next_cursor: "page-2".into(),
                },
                "item-1",
            ))
            .unwrap();
        let before = replica.bootstrap_snapshot(&account_id).unwrap();
        let changed_watermark = page(
            &account_id,
            1,
            "generation-1",
            1,
            BootstrapPageCursor::After {
                cursor: "page-2".into(),
            },
            2,
            SyncCursor::CapturedValue {
                id: "unexpected".into(),
            },
            BootstrapContinuation::Final,
            "item-2",
        );
        assert_eq!(
            replica
                .stage_bootstrap_page(changed_watermark)
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        let wrong_identity = page(
            &account_id,
            1,
            "generation-1",
            2,
            BootstrapPageCursor::After {
                cursor: "page-2".into(),
            },
            2,
            SyncCursor::CapturedEmpty,
            BootstrapContinuation::Final,
            "item-2",
        );
        assert_eq!(
            replica
                .stage_bootstrap_page(wrong_identity)
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(replica.bootstrap_snapshot(&account_id).unwrap(), before);
    }

    #[test]
    fn optimistic_commits_preserve_bootstrap_authority() {
        let (replica, account_id) = installed();
        begin(&replica, &account_id, 0, "generation-1");
        replica
            .stage_bootstrap_page(page(
                &account_id,
                1,
                "generation-1",
                0,
                BootstrapPageCursor::Initial,
                1,
                SyncCursor::CapturedEmpty,
                BootstrapContinuation::Final,
                "item-1",
            ))
            .unwrap();
        promote(&replica, &account_id, 1, "generation-1");
        let authority = replica.bootstrap_snapshot(&account_id).unwrap();

        assert_eq!(
            replica
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    Incarnation::from("incarnation-bootstrap"),
                    2,
                    0,
                    vec![PlanMutation::AcceptOperation(
                        crate::test_fixtures::test_operation("operation-1", "item-new",)
                    )],
                ))
                .unwrap(),
            PlanResult::Applied {
                replica_revision: 3
            }
        );
        assert_eq!(replica.bootstrap_snapshot(&account_id).unwrap(), authority);
    }

    #[tokio::test]
    async fn a_replacement_incarnation_starts_with_cold_bootstrap_authority() {
        let persistence = Arc::new(InMemoryReplica::default());
        let account_id = AccountId::from("account-bootstrap");
        persistence
            .install(
                account_id.clone(),
                "user-bootstrap".into(),
                Incarnation::from("incarnation-bootstrap"),
            )
            .unwrap();
        begin(&persistence, &account_id, 0, "generation-1");
        persistence
            .stage_bootstrap_page(page(
                &account_id,
                1,
                "generation-1",
                0,
                BootstrapPageCursor::Initial,
                1,
                SyncCursor::CapturedEmpty,
                BootstrapContinuation::Final,
                "item-1",
            ))
            .unwrap();
        promote(&persistence, &account_id, 1, "generation-1");

        Replica::new(persistence.clone())
            .install_or_replace(
                account_id.clone(),
                "user-bootstrap".into(),
                Incarnation::from("replacement-incarnation"),
            )
            .await
            .unwrap();
        let bootstrap = persistence.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(bootstrap.state, ReplicaState::Cold);
        assert_eq!(bootstrap.active_cursor, SyncCursor::Cold);
        assert!(bootstrap.generation_ids.is_empty());
        assert!(bootstrap.visible_items.is_empty());
    }

    #[tokio::test]
    async fn a_stale_server_version_cannot_overwrite_newer_ciphertext() {
        let persistence = Arc::new(InMemoryReplica::default());
        let account_id = AccountId::from("account-bootstrap");
        persistence
            .install(
                account_id.clone(),
                "user-bootstrap".into(),
                Incarnation::from("incarnation-bootstrap"),
            )
            .unwrap();
        begin(&persistence, &account_id, 0, "generation-1");
        persistence
            .stage_bootstrap_page(page(
                &account_id,
                1,
                "generation-1",
                0,
                BootstrapPageCursor::Initial,
                1,
                SyncCursor::CapturedValue {
                    id: "event-1".into(),
                },
                BootstrapContinuation::Final,
                "item-1",
            ))
            .unwrap();
        promote(&persistence, &account_id, 1, "generation-1");
        let replica = Replica::new(persistence.clone());
        replica.load(&account_id).await.unwrap();
        let mut older = item("item-1", "vault-1");
        older.version = 0;
        older.encrypted_data = "stale-ciphertext".into();
        let error = replica
            .apply_authoritative_item(
                &account_id,
                SyncCursor::CapturedValue {
                    id: "event-1".into(),
                },
                SyncCursor::CapturedValue {
                    id: "event-2".into(),
                },
                older,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        let snapshot = persistence.bootstrap_snapshot(&account_id).unwrap();
        assert_eq!(
            snapshot.active_cursor,
            SyncCursor::CapturedValue {
                id: "event-1".into()
            }
        );
        assert_eq!(
            snapshot.visible_items[0].encrypted_data,
            "ciphertext-item-1"
        );
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
#[doc(hidden)]
pub trait SerializedReplicaExecutor: Send + Sync {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError>;
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
#[doc(hidden)]
pub trait SerializedReplicaExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError>;
}

pub(crate) struct SerializedReplicaPersistence {
    executor: Arc<dyn SerializedReplicaExecutor>,
}

impl SerializedReplicaPersistence {
    pub(crate) fn new(executor: Arc<dyn SerializedReplicaExecutor>) -> Self {
        Self { executor }
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl ReplicaPersistence for SerializedReplicaPersistence {
    async fn invoke(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
        let request_json = serde_json::to_string(&request).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica persistence request could not be serialized",
            )
        })?;
        let response_json = self.executor.invoke(request_json).await?;
        serde_json::from_str(&response_json).map_err(|_| {
            RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica persistence returned an invalid response",
            )
        })
    }
}

pub(crate) struct Replica {
    persistence: Arc<dyn ReplicaPersistence>,
    snapshots: Mutex<HashMap<AccountId, ReplicaSnapshot>>,
}

impl Replica {
    pub(crate) fn new(persistence: Arc<dyn ReplicaPersistence>) -> Self {
        Self {
            persistence,
            snapshots: Mutex::new(HashMap::new()),
        }
    }

    #[allow(
        dead_code,
        reason = "used by the guarded persistence conformance surface"
    )]
    pub(crate) async fn load(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<ReplicaSnapshot>, RuntimeError> {
        let snapshot = self.load_uncached(account_id).await?;
        let mut snapshots = self.snapshots.lock().expect("Replica cache lock poisoned");
        match &snapshot {
            Some(value) => {
                snapshots.insert(account_id.clone(), value.clone());
            }
            None => {
                snapshots.remove(account_id);
            }
        }
        Ok(snapshot)
    }

    pub(crate) async fn load_uncached(
        &self,
        account_id: &AccountId,
    ) -> Result<Option<ReplicaSnapshot>, RuntimeError> {
        let response = self
            .persistence
            .invoke(ReplicaPersistenceRequest::Load {
                account_id: account_id.clone(),
            })
            .await?;
        let ReplicaPersistenceResponse::Loaded { head, rows } = response else {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica persistence returned a commit response for a load",
            ));
        };
        reconstruct_snapshot(account_id, head, rows)
    }

    pub(crate) async fn restore_known_accounts(
        &self,
        account_ids: &[AccountId],
    ) -> Result<Vec<ReplicaSnapshot>, RuntimeError> {
        let mut restored = Vec::with_capacity(account_ids.len());
        for account_id in account_ids {
            let snapshot = self.load_uncached(account_id).await?.ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AccountMissing,
                    "known Account has no durable Replica installation",
                )
            })?;
            restored.push(snapshot);
        }
        Ok(restored)
    }

    pub(crate) async fn install_or_replace(
        &self,
        account_id: AccountId,
        user_id: String,
        incarnation: Incarnation,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        if account_id.as_str().is_empty() || user_id.is_empty() || incarnation.as_str().is_empty() {
            return Err(RuntimeError::new(
                RuntimeErrorCode::InvariantViolation,
                "Replica installation identities must not be empty",
            ));
        }
        loop {
            let current = self.load_uncached(&account_id).await?;
            if let Some(current) = &current {
                if current.user_id != user_id {
                    return Err(replica_invariant(
                        "installed Account identity cannot change User",
                    ));
                }
                if current.incarnation == incarnation {
                    if current.failure.is_some() {
                        return Err(replica_invariant(
                            "replayed Replica installation did not restore a clean head",
                        ));
                    }
                    return Ok(current.clone());
                }
            }
            let prepared = prepare_install(
                current.as_ref(),
                account_id.clone(),
                user_id.clone(),
                incarnation.clone(),
            )?;
            let response = self
                .persistence
                .invoke(ReplicaPersistenceRequest::Install {
                    prepared: prepared.clone(),
                })
                .await?;
            let ReplicaPersistenceResponse::Installed { result } = response else {
                return Err(replica_invariant(
                    "Replica persistence returned a non-install response for an install",
                ));
            };
            match result {
                ReplicaInstallResult::Applied => {
                    let snapshot = self.load_uncached(&account_id).await?.ok_or_else(|| {
                        replica_invariant("Replica persistence lost an applied installation")
                    })?;
                    if snapshot.account_id != prepared.next_head.account_id
                        || snapshot.user_id != prepared.next_head.user_id
                        || snapshot.incarnation != prepared.next_head.incarnation
                        || snapshot.revision != prepared.next_head.replica_revision
                        || snapshot.lock_epoch != prepared.next_head.lock_epoch
                        || snapshot.failure != prepared.next_head.failure
                        || !same_replica_rows(current.as_ref(), &snapshot)
                    {
                        return Err(replica_invariant(
                            "Replica persistence applied a different installation head",
                        ));
                    }
                    return Ok(snapshot);
                }
                ReplicaInstallResult::Stale => continue,
            }
        }
    }

    pub(crate) async fn advance_lock_epoch(
        &self,
        account_id: &AccountId,
        user_id: &str,
        incarnation: &Incarnation,
        desired_epoch: u64,
    ) -> Result<ReplicaSnapshot, RuntimeError> {
        loop {
            let current = self.load_uncached(account_id).await?.ok_or_else(|| {
                RuntimeError::new(
                    RuntimeErrorCode::AccountMissing,
                    "Account disappeared while advancing its lock epoch",
                )
            })?;
            if current.user_id != user_id || current.incarnation != *incarnation {
                return Err(replica_invariant(
                    "Account identity changed while advancing its lock epoch",
                ));
            }
            if current.lock_epoch == desired_epoch {
                return Ok(current);
            }
            if current.lock_epoch.checked_add(1) != Some(desired_epoch) {
                return Err(replica_invariant(
                    "durable Account lock epoch made unexpected progress",
                ));
            }
            let next_head = ReplicaHead {
                account_id: current.account_id.clone(),
                user_id: current.user_id.clone(),
                incarnation: current.incarnation.clone(),
                replica_revision: current.revision,
                lock_epoch: desired_epoch,
                failure: current.failure,
            };
            let prepared = PreparedLockEpochAdvance {
                expected: persistence_contract::ExpectedReplicaHead {
                    account_id: current.account_id.clone(),
                    user_id: current.user_id.clone(),
                    incarnation: current.incarnation.clone(),
                    replica_revision: current.revision,
                    lock_epoch: current.lock_epoch,
                },
                next_head: next_head.clone(),
            };
            let expected_rows = current.clone();
            let response = self
                .persistence
                .invoke(ReplicaPersistenceRequest::AdvanceLockEpoch { prepared })
                .await?;
            let ReplicaPersistenceResponse::LockEpochAdvanced { result } = response else {
                return Err(replica_invariant(
                    "Replica persistence returned a non-lock-epoch response",
                ));
            };
            match result {
                LockEpochAdvanceResult::Applied { lock_epoch } if lock_epoch == desired_epoch => {
                    let snapshot = self.load_uncached(account_id).await?.ok_or_else(|| {
                        replica_invariant("Replica lost an applied Account lock epoch")
                    })?;
                    if snapshot.account_id != next_head.account_id
                        || snapshot.user_id != next_head.user_id
                        || snapshot.incarnation != next_head.incarnation
                        || snapshot.revision != next_head.replica_revision
                        || snapshot.lock_epoch != next_head.lock_epoch
                        || snapshot.failure != next_head.failure
                        || !same_replica_rows(Some(&expected_rows), &snapshot)
                    {
                        return Err(replica_invariant(
                            "Replica applied a different Account lock epoch head",
                        ));
                    }
                    return Ok(snapshot);
                }
                LockEpochAdvanceResult::Applied { .. } => {
                    return Err(replica_invariant(
                        "Replica applied an unexpected Account lock epoch",
                    ));
                }
                LockEpochAdvanceResult::Stale => continue,
                LockEpochAdvanceResult::Missing => {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::AccountMissing,
                        "Account disappeared while advancing its lock epoch",
                    ));
                }
            }
        }
    }

    #[allow(
        dead_code,
        reason = "used by the guarded persistence conformance surface"
    )]
    pub(crate) async fn execute(
        &self,
        mut plan: GuardedCommitPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let account_id = plan.account_id.clone();
        let expected_incarnation = plan.expected_incarnation.clone();
        let Some(mut current) = self.load(&account_id).await? else {
            return Ok(PlanResult::Missing);
        };
        if current.incarnation != plan.expected_incarnation
            || current.revision != plan.expected_replica_revision
        {
            return Ok(PlanResult::Stale {
                actual_revision: current.revision,
            });
        }
        if current.lock_epoch != plan.expected_lock_epoch {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AuthenticationRequired,
                "Replica work was fenced by Account lock",
            ));
        }

        loop {
            let PreparedCommitOutcome {
                wire: prepared,
                next_snapshot: next,
            } = prepare_commit(current.clone(), plan.clone())?;
            let response = self
                .persistence
                .invoke(ReplicaPersistenceRequest::Commit { prepared })
                .await?;
            let ReplicaPersistenceResponse::Committed { result } = response else {
                return Err(RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "Replica persistence returned a load response for a commit",
                ));
            };
            match result {
                PlanResult::Applied { replica_revision } => {
                    if replica_revision != next.revision {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::InvariantViolation,
                            "Replica persistence committed an unexpected revision",
                        ));
                    }
                    self.snapshots
                        .lock()
                        .expect("Replica cache lock poisoned")
                        .insert(next.account_id.clone(), next);
                    return Ok(PlanResult::Applied { replica_revision });
                }
                PlanResult::Missing => {
                    self.load(&account_id).await?;
                    return Ok(PlanResult::Missing);
                }
                PlanResult::Stale { actual_revision } => {
                    let attempted_revision = plan.expected_replica_revision;
                    let latest = self.load(&account_id).await?;
                    let Some(latest) = latest else {
                        return Ok(PlanResult::Missing);
                    };
                    if latest.incarnation != expected_incarnation {
                        return Ok(PlanResult::Missing);
                    }
                    if latest.lock_epoch != plan.expected_lock_epoch {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::AuthenticationRequired,
                            "Replica work was fenced by Account lock",
                        ));
                    }
                    if latest.revision <= attempted_revision {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::InvariantViolation,
                            format!(
                                "Replica persistence reported stale revision {actual_revision} without durable progress"
                            ),
                        ));
                    }
                    plan.expected_replica_revision = latest.revision;
                    current = latest;
                }
            }
        }
    }

    pub(crate) async fn execute_recomputing(
        &self,
        mut plan: GuardedCommitPlan,
    ) -> Result<RecomputedPlanResult, RuntimeError> {
        let account_id = plan.account_id.clone();
        let expected_incarnation = plan.expected_incarnation.clone();
        loop {
            let attempted_revision = plan.expected_replica_revision;
            let Some(current) = self.load_uncached(&account_id).await? else {
                return Ok(RecomputedPlanResult::Missing);
            };
            if current.incarnation != expected_incarnation {
                return Ok(RecomputedPlanResult::Missing);
            }
            if current.lock_epoch != plan.expected_lock_epoch {
                return Ok(RecomputedPlanResult::Fenced { snapshot: current });
            }
            if current.revision != attempted_revision {
                if current.revision < attempted_revision {
                    return Err(replica_invariant(
                        "Replica revision moved backwards while recomputing",
                    ));
                }
                plan.expected_replica_revision = current.revision;
            }
            let PreparedCommitOutcome {
                wire: prepared,
                next_snapshot,
            } = prepare_commit(current, plan.clone())?;
            let response = self
                .persistence
                .invoke(ReplicaPersistenceRequest::Commit { prepared })
                .await?;
            let ReplicaPersistenceResponse::Committed { result } = response else {
                return Err(replica_invariant(
                    "Replica persistence returned a non-commit response for a commit",
                ));
            };
            match result {
                PlanResult::Applied { replica_revision }
                    if replica_revision == next_snapshot.revision =>
                {
                    return Ok(RecomputedPlanResult::Applied {
                        snapshot: next_snapshot,
                    });
                }
                PlanResult::Applied { .. } => {
                    return Err(replica_invariant(
                        "Replica persistence committed an unexpected revision",
                    ));
                }
                PlanResult::Missing => return Ok(RecomputedPlanResult::Missing),
                PlanResult::Stale { actual_revision } => {
                    let Some(latest) = self.load_uncached(&account_id).await? else {
                        return Ok(RecomputedPlanResult::Missing);
                    };
                    if latest.incarnation != expected_incarnation {
                        return Ok(RecomputedPlanResult::Missing);
                    }
                    if latest.lock_epoch != plan.expected_lock_epoch {
                        return Ok(RecomputedPlanResult::Fenced { snapshot: latest });
                    }
                    if actual_revision <= attempted_revision {
                        return Err(replica_invariant(
                            "Replica persistence reported stale without durable progress",
                        ));
                    }
                    plan.expected_replica_revision = actual_revision;
                }
            }
        }
    }

    pub(crate) async fn begin_bootstrap(
        &self,
        plan: BeginBootstrapPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let account_id = plan.guard.account_id.clone();
        self.persist_applied_bootstrap(&account_id, true, |account| account.begin_bootstrap(plan))
            .await
    }

    pub(crate) async fn mark_refresh_required(
        &self,
        plan: MarkRefreshRequiredPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let account_id = plan.guard.account_id.clone();
        let Some(current) = self.load_uncached(&account_id).await? else {
            return Ok(PlanResult::Missing);
        };
        let mut account = AccountReplica::from_snapshot(current.clone());
        let result = account.mark_refresh_required(plan)?;
        if !matches!(result, PlanResult::Applied { replica_revision } if replica_revision != current.revision)
        {
            return Ok(result);
        }
        self.commit_bootstrap_snapshot(current, account.snapshot(), true)
            .await
    }

    pub(crate) async fn stage_bootstrap_page(
        &self,
        plan: StageBootstrapPagePlan,
    ) -> Result<StageBootstrapPageResult, RuntimeError> {
        let account_id = plan.guard.account_id.clone();
        let Some(current) = self.load_uncached(&account_id).await? else {
            return Ok(StageBootstrapPageResult::Missing);
        };
        let mut account = AccountReplica::from_snapshot(current.clone());
        let result = account.stage_bootstrap_page(plan)?;
        if result != StageBootstrapPageResult::Applied {
            return Ok(result);
        }
        self.commit_bootstrap_snapshot(current, account.snapshot(), false)
            .await?;
        Ok(result)
    }

    pub(crate) async fn promote_bootstrap(
        &self,
        plan: PromoteBootstrapPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let account_id = plan.guard.account_id.clone();
        self.persist_applied_bootstrap(&account_id, true, |account| account.promote_bootstrap(plan))
            .await
    }

    pub(crate) async fn abandon_bootstrap(
        &self,
        plan: AbandonBootstrapPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let account_id = plan.guard.account_id.clone();
        self.persist_applied_bootstrap(&account_id, true, |account| account.abandon_bootstrap(plan))
            .await
    }

    #[allow(
        dead_code,
        reason = "cleanup runs after a later generation is abandoned"
    )]
    pub(crate) async fn cleanup_bootstrap_generation(
        &self,
        plan: CleanupBootstrapGenerationPlan,
    ) -> Result<CleanupBootstrapGenerationResult, RuntimeError> {
        let account_id = plan.guard.account_id.clone();
        let Some(current) = self.load_uncached(&account_id).await? else {
            return Ok(CleanupBootstrapGenerationResult::Missing);
        };
        let mut account = AccountReplica::from_snapshot(current.clone());
        let result = account.cleanup_bootstrap_generation(plan)?;
        if result != CleanupBootstrapGenerationResult::Applied {
            return Ok(result);
        }
        self.commit_bootstrap_snapshot(current, account.snapshot(), false)
            .await?;
        Ok(result)
    }

    pub(crate) async fn apply_authoritative_item(
        &self,
        account_id: &AccountId,
        expected_cursor: SyncCursor,
        next_cursor: SyncCursor,
        item: AuthorityItemRecord,
    ) -> Result<PlanResult, RuntimeError> {
        self.persist_applied_bootstrap(account_id, true, |account| {
            account.apply_authoritative_item(&expected_cursor, next_cursor, item)
        })
        .await
    }

    async fn persist_applied_bootstrap(
        &self,
        account_id: &AccountId,
        increment_revision: bool,
        apply: impl FnOnce(&mut AccountReplica) -> Result<PlanResult, RuntimeError>,
    ) -> Result<PlanResult, RuntimeError> {
        let Some(current) = self.load_uncached(account_id).await? else {
            return Ok(PlanResult::Missing);
        };
        let mut account = AccountReplica::from_snapshot(current.clone());
        let result = apply(&mut account)?;
        if !matches!(result, PlanResult::Applied { .. }) {
            return Ok(result);
        }
        self.commit_bootstrap_snapshot(current, account.snapshot(), increment_revision)
            .await
    }

    async fn commit_bootstrap_snapshot(
        &self,
        current: ReplicaSnapshot,
        next: ReplicaSnapshot,
        increment_revision: bool,
    ) -> Result<PlanResult, RuntimeError> {
        let account_id = current.account_id.clone();
        let prepared = prepare_bootstrap_commit(current, next.clone(), increment_revision)?;
        let response = self
            .persistence
            .invoke(ReplicaPersistenceRequest::Commit {
                prepared: prepared.wire,
            })
            .await?;
        let ReplicaPersistenceResponse::Committed { result } = response else {
            return Err(replica_invariant(
                "Replica persistence returned a non-commit response for Bootstrap",
            ));
        };
        if let PlanResult::Applied { replica_revision } = result {
            if replica_revision != next.revision {
                return Err(replica_invariant(
                    "Replica persistence committed an unexpected Bootstrap revision",
                ));
            }
            self.snapshots
                .lock()
                .expect("Replica cache lock poisoned")
                .insert(next.account_id.clone(), next);
        } else {
            self.load(&account_id).await?;
        }
        Ok(result)
    }

    pub(crate) fn snapshot(&self, account_id: &AccountId) -> Option<ReplicaSnapshot> {
        self.snapshots
            .lock()
            .expect("Replica cache lock poisoned")
            .get(account_id)
            .cloned()
    }

    pub(crate) fn snapshots(&self) -> Vec<ReplicaSnapshot> {
        let mut values: Vec<_> = self
            .snapshots
            .lock()
            .expect("Replica cache lock poisoned")
            .values()
            .cloned()
            .collect();
        values.sort_by(|a, b| a.account_id.as_str().cmp(b.account_id.as_str()));
        values
    }

    pub(crate) fn cache(&self, snapshot: ReplicaSnapshot) {
        self.snapshots
            .lock()
            .expect("Replica cache lock poisoned")
            .insert(snapshot.account_id.clone(), snapshot);
    }

    pub(crate) fn replace_cache(&self, snapshots: &[ReplicaSnapshot]) {
        *self.snapshots.lock().expect("Replica cache lock poisoned") = snapshots
            .iter()
            .cloned()
            .map(|snapshot| (snapshot.account_id.clone(), snapshot))
            .collect();
    }

    pub(crate) fn remove_cached(&self, account_id: &AccountId) {
        self.snapshots
            .lock()
            .expect("Replica cache lock poisoned")
            .remove(account_id);
    }
}

fn same_replica_rows(current: Option<&ReplicaSnapshot>, next: &ReplicaSnapshot) -> bool {
    let Some(current) = current else {
        return next.items.is_empty() && next.operations.is_empty() && next.receipts.is_empty();
    };
    let current_items: HashMap<_, _> = current
        .items
        .iter()
        .map(|item| (&item.item_id, item))
        .collect();
    let next_items: HashMap<_, _> = next
        .items
        .iter()
        .map(|item| (&item.item_id, item))
        .collect();
    let current_operations: HashMap<_, _> = current
        .operations
        .iter()
        .map(|operation| (&operation.operation_id, operation))
        .collect();
    let next_operations: HashMap<_, _> = next
        .operations
        .iter()
        .map(|operation| (&operation.operation_id, operation))
        .collect();
    let current_receipts: HashMap<_, _> = current
        .receipts
        .iter()
        .map(|receipt| (&receipt.operation_id, receipt))
        .collect();
    let next_receipts: HashMap<_, _> = next
        .receipts
        .iter()
        .map(|receipt| (&receipt.operation_id, receipt))
        .collect();
    current_items == next_items
        && current_operations == next_operations
        && current_receipts == next_receipts
}

#[derive(Default)]
pub(crate) struct InMemoryReplica {
    state: Mutex<InMemoryReplicaState>,
}

#[derive(Default)]
struct InMemoryReplicaState {
    accounts: HashMap<AccountId, AccountReplica>,
}

impl InMemoryReplica {
    #[cfg(test)]
    pub(crate) fn install(
        &self,
        account_id: AccountId,
        user_id: String,
        incarnation: Incarnation,
    ) -> Result<(), RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        if state.accounts.contains_key(&account_id) {
            return Err(RuntimeError::new(
                RuntimeErrorCode::AccountAlreadyInstalled,
                "account is already installed",
            ));
        }
        state.accounts.insert(
            account_id.clone(),
            AccountReplica {
                account_id,
                user_id,
                incarnation,
                revision: 0,
                lock_epoch: 0,
                items: HashMap::new(),
                operations: HashMap::new(),
                receipts: HashMap::new(),
                failure: None,
                bootstrap: domain::BootstrapAuthority::default(),
            },
        );
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn execute(&self, plan: GuardedCommitPlan) -> Result<PlanResult, RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        let Some(current) = state.accounts.get(&plan.account_id) else {
            return Ok(PlanResult::Missing);
        };
        if current.incarnation != plan.expected_incarnation
            || current.revision != plan.expected_replica_revision
            || current.lock_epoch != plan.expected_lock_epoch
        {
            return Ok(PlanResult::Stale {
                actual_revision: current.revision,
            });
        }

        let account_id = plan.account_id.clone();
        let next = AccountReplica::from_snapshot(apply_plan(current.snapshot(), plan)?);
        let revision = next.revision;
        state.accounts.insert(account_id, next);
        Ok(PlanResult::Applied {
            replica_revision: revision,
        })
    }

    #[cfg(test)]
    pub(crate) fn remove(&self, account_id: &AccountId) {
        self.state
            .lock()
            .expect("replica lock poisoned")
            .accounts
            .remove(account_id);
    }

    pub(crate) fn snapshot(&self, account_id: &AccountId) -> Option<ReplicaSnapshot> {
        self.state
            .lock()
            .expect("replica lock poisoned")
            .accounts
            .get(account_id)
            .map(AccountReplica::snapshot)
    }

    #[cfg(test)]
    pub(crate) fn bootstrap_snapshot(
        &self,
        account_id: &AccountId,
    ) -> Option<BootstrapAuthoritySnapshot> {
        self.state
            .lock()
            .expect("replica lock poisoned")
            .accounts
            .get(account_id)
            .map(|account| account.bootstrap.snapshot())
    }

    #[cfg(test)]
    pub(crate) fn begin_bootstrap(
        &self,
        plan: BeginBootstrapPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        let Some(account) = state.accounts.get_mut(&plan.guard.account_id) else {
            return Ok(PlanResult::Missing);
        };
        account.begin_bootstrap(plan)
    }

    #[cfg(test)]
    pub(crate) fn mark_refresh_required(
        &self,
        plan: MarkRefreshRequiredPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        let Some(account) = state.accounts.get_mut(&plan.guard.account_id) else {
            return Ok(PlanResult::Missing);
        };
        account.mark_refresh_required(plan)
    }

    #[cfg(test)]
    pub(crate) fn stage_bootstrap_page(
        &self,
        plan: StageBootstrapPagePlan,
    ) -> Result<StageBootstrapPageResult, RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        let Some(account) = state.accounts.get_mut(&plan.guard.account_id) else {
            return Ok(StageBootstrapPageResult::Missing);
        };
        account.stage_bootstrap_page(plan)
    }

    #[cfg(test)]
    pub(crate) fn promote_bootstrap(
        &self,
        plan: PromoteBootstrapPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        let Some(account) = state.accounts.get_mut(&plan.guard.account_id) else {
            return Ok(PlanResult::Missing);
        };
        account.promote_bootstrap(plan)
    }

    #[cfg(test)]
    pub(crate) fn abandon_bootstrap(
        &self,
        plan: AbandonBootstrapPlan,
    ) -> Result<PlanResult, RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        let Some(account) = state.accounts.get_mut(&plan.guard.account_id) else {
            return Ok(PlanResult::Missing);
        };
        account.abandon_bootstrap(plan)
    }

    #[cfg(test)]
    pub(crate) fn cleanup_bootstrap_generation(
        &self,
        plan: CleanupBootstrapGenerationPlan,
    ) -> Result<CleanupBootstrapGenerationResult, RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        let Some(account) = state.accounts.get_mut(&plan.guard.account_id) else {
            return Ok(CleanupBootstrapGenerationResult::Missing);
        };
        account.cleanup_bootstrap_generation(plan)
    }

    /// Promotes one complete Bootstrap generation holding a single personal Vault.
    ///
    /// Tests that exercise local writes need the same readiness a real Bootstrap leaves behind:
    /// a ready Replica, an active generation, and a Vault whose key the live MUK can open.
    ///
    /// The two Bootstrap plans this replays are prehistory, so the fixture restores the revision
    /// it started from. A test's revision arithmetic then counts only the writes it performs.
    #[cfg(test)]
    pub(crate) fn seed_ready_personal_vault(
        &self,
        account_id: &AccountId,
        vault: AuthorityVaultRecord,
    ) -> Result<(), RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        let account = state.accounts.get_mut(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        let seeded_from_revision = account.revision;
        let generation_id = BootstrapGenerationId(format!("seed-{}", account.revision));
        let guard = |account: &AccountReplica| BootstrapGuard {
            account_id: account.account_id.clone(),
            user_id: account.user_id.clone(),
            incarnation: account.incarnation.clone(),
            expected_replica_revision: account.revision,
            expected_lock_epoch: account.lock_epoch,
        };
        account.begin_bootstrap(BeginBootstrapPlan {
            guard: guard(account),
            generation_id: generation_id.clone(),
        })?;
        account.stage_bootstrap_page(StageBootstrapPagePlan {
            guard: guard(account),
            generation_id: generation_id.clone(),
            page_identity: BootstrapPageIdentity(0),
            request_cursor: BootstrapPageCursor::Initial,
            raw_response_fingerprint: Sha256Fingerprint::of_bytes(b"seeded-page"),
            pinned_watermark: SyncCursor::CapturedEmpty,
            continuation: BootstrapContinuation::Final,
            vaults: vec![vault],
            items: Vec::new(),
        })?;
        account.promote_bootstrap(PromoteBootstrapPlan {
            guard: guard(account),
            generation_id,
        })?;
        account.reset_revision_for_seeding(seeded_from_revision);
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn fail(
        &self,
        account_id: &AccountId,
        code: RuntimeErrorCode,
    ) -> Result<(), RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        let account = state.accounts.get_mut(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        account.failure = Some(code);
        account.revision += 1;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn set_lock_epoch(
        &self,
        account_id: &AccountId,
        lock_epoch: u64,
    ) -> Result<(), RuntimeError> {
        let mut state = self.state.lock().expect("replica lock poisoned");
        let account = state.accounts.get_mut(account_id).ok_or_else(|| {
            RuntimeError::new(RuntimeErrorCode::AccountMissing, "account is not installed")
        })?;
        account.lock_epoch = lock_epoch;
        Ok(())
    }
}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
impl ReplicaPersistence for InMemoryReplica {
    async fn invoke(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
        match request {
            ReplicaPersistenceRequest::Load { account_id } => {
                let snapshot = self.snapshot(&account_id);
                let (head, rows) = match snapshot {
                    Some(snapshot) => (
                        Some(ReplicaHead {
                            account_id: snapshot.account_id.clone(),
                            user_id: snapshot.user_id.clone(),
                            incarnation: snapshot.incarnation.clone(),
                            replica_revision: snapshot.revision,
                            lock_epoch: snapshot.lock_epoch,
                            failure: snapshot.failure,
                        }),
                        snapshot_rows(snapshot)?,
                    ),
                    None => (None, vec![]),
                };
                Ok(ReplicaPersistenceResponse::Loaded { head, rows })
            }
            ReplicaPersistenceRequest::Install { prepared } => {
                let mut state = self.state.lock().expect("replica lock poisoned");
                let account_id = prepared.next_head.account_id.clone();
                let matches = match (&prepared.expected, state.accounts.get(&account_id)) {
                    (
                        ExpectedReplicaInstall::Missing {
                            account_id: expected,
                        },
                        None,
                    ) => expected == &account_id,
                    (
                        ExpectedReplicaInstall::Present {
                            account_id: expected_account,
                            user_id,
                            incarnation,
                            replica_revision,
                            lock_epoch,
                        },
                        Some(current),
                    ) => {
                        expected_account == &account_id
                            && current.user_id == *user_id
                            && current.incarnation == *incarnation
                            && current.revision == *replica_revision
                            && current.lock_epoch == *lock_epoch
                    }
                    _ => false,
                };
                if !matches {
                    return Ok(ReplicaPersistenceResponse::Installed {
                        result: ReplicaInstallResult::Stale,
                    });
                }
                match state.accounts.get_mut(&account_id) {
                    Some(current) => {
                        current.user_id = prepared.next_head.user_id;
                        current.incarnation = prepared.next_head.incarnation;
                        current.revision = prepared.next_head.replica_revision;
                        current.lock_epoch = prepared.next_head.lock_epoch;
                        current.failure = prepared.next_head.failure;
                    }
                    None => {
                        let head = prepared.next_head;
                        state.accounts.insert(
                            account_id.clone(),
                            AccountReplica {
                                account_id: head.account_id,
                                user_id: head.user_id,
                                incarnation: head.incarnation,
                                revision: head.replica_revision,
                                lock_epoch: head.lock_epoch,
                                items: HashMap::new(),
                                operations: HashMap::new(),
                                receipts: HashMap::new(),
                                failure: head.failure,
                                bootstrap: domain::BootstrapAuthority::default(),
                            },
                        );
                    }
                }
                if let Some(current) = state.accounts.get_mut(&account_id) {
                    current.bootstrap = domain::BootstrapAuthority::default();
                    let rows = apply_prepared_writes_to_rows(
                        snapshot_rows(current.snapshot())?,
                        &prepared.writes,
                    );
                    let restored = reconstruct_snapshot(
                        &account_id,
                        Some(ReplicaHead {
                            account_id: current.account_id.clone(),
                            user_id: current.user_id.clone(),
                            incarnation: current.incarnation.clone(),
                            replica_revision: current.revision,
                            lock_epoch: current.lock_epoch,
                            failure: current.failure,
                        }),
                        rows,
                    )?
                    .ok_or_else(|| replica_invariant("prepared Replica install lost its head"))?;
                    *current = AccountReplica::from_snapshot(restored);
                }
                Ok(ReplicaPersistenceResponse::Installed {
                    result: ReplicaInstallResult::Applied,
                })
            }
            ReplicaPersistenceRequest::Commit { prepared } => {
                let mut state = self.state.lock().expect("replica lock poisoned");
                let Some(current) = state.accounts.get(&prepared.expected.account_id) else {
                    return Ok(ReplicaPersistenceResponse::Committed {
                        result: PlanResult::Missing,
                    });
                };
                if current.incarnation != prepared.expected.incarnation
                    || current.user_id != prepared.expected.user_id
                    || current.revision != prepared.expected.replica_revision
                    || current.lock_epoch != prepared.expected.lock_epoch
                {
                    return Ok(ReplicaPersistenceResponse::Committed {
                        result: PlanResult::Stale {
                            actual_revision: current.revision,
                        },
                    });
                }
                let expected_same_revision = current.revision;
                let expected_next_revision = current
                    .revision
                    .checked_add(1)
                    .ok_or_else(|| replica_invariant("Replica revision overflowed"))?;
                if prepared.next_head.account_id != prepared.expected.account_id
                    || prepared.next_head.user_id != current.user_id
                    || prepared.next_head.incarnation != prepared.expected.incarnation
                    || (prepared.next_head.replica_revision != expected_same_revision
                        && prepared.next_head.replica_revision != expected_next_revision)
                    || prepared.next_head.lock_epoch != current.lock_epoch
                {
                    return Err(replica_invariant(
                        "prepared Replica head transition is invalid",
                    ));
                }
                let rows = apply_prepared_writes_to_rows(
                    snapshot_rows(current.snapshot())?,
                    &prepared.writes,
                );
                let replica_revision = prepared.next_head.replica_revision;
                let next = reconstruct_snapshot(
                    &prepared.expected.account_id,
                    Some(prepared.next_head),
                    rows,
                )?
                .ok_or_else(|| replica_invariant("prepared Replica commit lost its head"))?;
                let next = AccountReplica::from_snapshot(next);
                state.accounts.insert(next.account_id.clone(), next);
                Ok(ReplicaPersistenceResponse::Committed {
                    result: PlanResult::Applied { replica_revision },
                })
            }
            ReplicaPersistenceRequest::AdvanceLockEpoch { prepared } => {
                let mut state = self.state.lock().expect("replica lock poisoned");
                let Some(current) = state.accounts.get_mut(&prepared.expected.account_id) else {
                    return Ok(ReplicaPersistenceResponse::LockEpochAdvanced {
                        result: LockEpochAdvanceResult::Missing,
                    });
                };
                if current.user_id != prepared.expected.user_id
                    || current.incarnation != prepared.expected.incarnation
                    || current.revision != prepared.expected.replica_revision
                    || current.lock_epoch != prepared.expected.lock_epoch
                {
                    return Ok(ReplicaPersistenceResponse::LockEpochAdvanced {
                        result: LockEpochAdvanceResult::Stale,
                    });
                }
                let expected_epoch = current
                    .lock_epoch
                    .checked_add(1)
                    .ok_or_else(|| replica_invariant("Account lock epoch overflowed"))?;
                if prepared.next_head.account_id != current.account_id
                    || prepared.next_head.user_id != current.user_id
                    || prepared.next_head.incarnation != current.incarnation
                    || prepared.next_head.replica_revision != current.revision
                    || prepared.next_head.lock_epoch != expected_epoch
                    || prepared.next_head.failure != current.failure
                {
                    return Err(replica_invariant(
                        "prepared Account lock epoch transition is invalid",
                    ));
                }
                current.lock_epoch = expected_epoch;
                Ok(ReplicaPersistenceResponse::LockEpochAdvanced {
                    result: LockEpochAdvanceResult::Applied {
                        lock_epoch: expected_epoch,
                    },
                })
            }
        }
    }
}

#[cfg(test)]
mod persistence_contract_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct HostileCrossUserExecutor {
        install_called: AtomicBool,
    }

    #[async_trait]
    impl ReplicaPersistence for HostileCrossUserExecutor {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            match request {
                ReplicaPersistenceRequest::Load { account_id } => {
                    Ok(ReplicaPersistenceResponse::Loaded {
                        head: Some(ReplicaHead {
                            account_id,
                            user_id: "hostile-user".into(),
                            incarnation: Incarnation::from("hostile-incarnation"),
                            replica_revision: 7,
                            lock_epoch: 0,
                            failure: None,
                        }),
                        rows: vec![],
                    })
                }
                ReplicaPersistenceRequest::Install { .. } => {
                    self.install_called.store(true, Ordering::SeqCst);
                    Ok(ReplicaPersistenceResponse::Installed {
                        result: ReplicaInstallResult::Applied,
                    })
                }
                ReplicaPersistenceRequest::Commit { .. }
                | ReplicaPersistenceRequest::AdvanceLockEpoch { .. } => unreachable!(),
            }
        }
    }

    struct InstallRaceExecutor {
        state: InMemoryReplica,
        raced: AtomicBool,
        install_calls: AtomicUsize,
    }

    struct LockEpochRaceExecutor {
        state: InMemoryReplica,
        raced: AtomicBool,
        advance_calls: AtomicUsize,
    }

    struct LyingAppliedExecutor {
        state: InMemoryReplica,
    }

    #[derive(Clone, Copy)]
    enum RowCorruption {
        Delete,
        Add,
        Change,
        LockEpoch,
    }

    struct LyingRowsExecutor {
        current: ReplicaSnapshot,
        next_head: Mutex<Option<ReplicaHead>>,
        corruption: RowCorruption,
    }

    #[async_trait]
    impl ReplicaPersistence for LyingRowsExecutor {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            match request {
                ReplicaPersistenceRequest::Load { .. } => {
                    let next_head = self.next_head.lock().unwrap().clone();
                    let applied = next_head.is_some();
                    let mut snapshot = self.current.clone();
                    let mut head = next_head.unwrap_or_else(|| ReplicaHead {
                        account_id: snapshot.account_id.clone(),
                        user_id: snapshot.user_id.clone(),
                        incarnation: snapshot.incarnation.clone(),
                        replica_revision: snapshot.revision,
                        lock_epoch: snapshot.lock_epoch,
                        failure: snapshot.failure,
                    });
                    if applied {
                        snapshot.incarnation = head.incarnation.clone();
                        snapshot.revision = head.replica_revision;
                        snapshot.lock_epoch = head.lock_epoch;
                        match self.corruption {
                            RowCorruption::Delete => {
                                snapshot.items.clear();
                                snapshot.operations.clear();
                            }
                            RowCorruption::Add => {
                                snapshot.items.push(item(
                                    "account-1",
                                    "hostile-item",
                                    "hostile-operation",
                                ));
                                snapshot
                                    .operations
                                    .push(operation("hostile-operation", "hostile-item"));
                            }
                            RowCorruption::Change => {
                                snapshot.items[0].encrypted_data = "hostile-ciphertext".to_owned();
                                snapshot.operations[0].request.body = b"hostile-request".to_vec();
                            }
                            RowCorruption::LockEpoch => {
                                head.lock_epoch = head.lock_epoch.checked_add(1).unwrap();
                                snapshot.lock_epoch = head.lock_epoch;
                            }
                        }
                    }
                    Ok(ReplicaPersistenceResponse::Loaded {
                        head: Some(head),
                        rows: snapshot_rows(snapshot)?,
                    })
                }
                ReplicaPersistenceRequest::Install { prepared } => {
                    *self.next_head.lock().unwrap() = Some(prepared.next_head);
                    Ok(ReplicaPersistenceResponse::Installed {
                        result: ReplicaInstallResult::Applied,
                    })
                }
                ReplicaPersistenceRequest::AdvanceLockEpoch { prepared } => {
                    let lock_epoch = prepared.next_head.lock_epoch;
                    *self.next_head.lock().unwrap() = Some(prepared.next_head);
                    Ok(ReplicaPersistenceResponse::LockEpochAdvanced {
                        result: LockEpochAdvanceResult::Applied { lock_epoch },
                    })
                }
                ReplicaPersistenceRequest::Commit { .. } => unreachable!(),
            }
        }
    }

    #[async_trait]
    impl ReplicaPersistence for LyingAppliedExecutor {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            match request {
                ReplicaPersistenceRequest::Install { prepared } => {
                    self.state
                        .install(
                            prepared.next_head.account_id,
                            "hostile-user".into(),
                            Incarnation::from("hostile-incarnation"),
                        )
                        .unwrap();
                    Ok(ReplicaPersistenceResponse::Installed {
                        result: ReplicaInstallResult::Applied,
                    })
                }
                other => self.state.invoke(other).await,
            }
        }
    }

    #[async_trait]
    impl ReplicaPersistence for InstallRaceExecutor {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            if let ReplicaPersistenceRequest::Install { prepared } = &request {
                self.install_calls.fetch_add(1, Ordering::SeqCst);
                if !self.raced.swap(true, Ordering::SeqCst) {
                    self.state
                        .install(
                            prepared.next_head.account_id.clone(),
                            prepared.next_head.user_id.clone(),
                            Incarnation::from("competing-incarnation"),
                        )
                        .unwrap();
                }
            }
            self.state.invoke(request).await
        }
    }

    #[async_trait]
    impl ReplicaPersistence for LockEpochRaceExecutor {
        async fn invoke(
            &self,
            request: ReplicaPersistenceRequest,
        ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
            if matches!(request, ReplicaPersistenceRequest::AdvanceLockEpoch { .. }) {
                self.advance_calls.fetch_add(1, Ordering::SeqCst);
                if !self.raced.swap(true, Ordering::SeqCst) {
                    let _ = self.state.invoke(request.clone()).await?;
                }
            }
            self.state.invoke(request).await
        }
    }

    struct SerializedFakeExecutor {
        state: InMemoryReplica,
        commit_calls: AtomicUsize,
    }

    impl SerializedFakeExecutor {
        fn seeded() -> Self {
            let state = InMemoryReplica::default();
            state
                .install(
                    AccountId::from("account-1"),
                    "user-1".into(),
                    Incarnation::from("incarnation-1"),
                )
                .unwrap();
            Self {
                state,
                commit_calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl SerializedReplicaExecutor for SerializedFakeExecutor {
        async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
            let request: ReplicaPersistenceRequest = serde_json::from_str(&request_json).unwrap();
            if matches!(request, ReplicaPersistenceRequest::Commit { .. }) {
                self.commit_calls.fetch_add(1, Ordering::SeqCst);
            }
            serde_json::to_string(&self.state.invoke(request).await?).map_err(|_| {
                RuntimeError::new(
                    RuntimeErrorCode::InvariantViolation,
                    "fake response could not be serialized",
                )
            })
        }
    }

    fn item(account_id: &str, item_id: &str, operation_id: &str) -> ReplicaItemRecord {
        crate::test_fixtures::test_overlay(AccountId::from(account_id), item_id, operation_id)
    }

    fn operation(operation_id: &str, item_id: &str) -> OperationRecord {
        crate::test_fixtures::test_operation(operation_id, item_id)
    }

    #[tokio::test]
    async fn rust_rejects_cross_user_install_before_a_hostile_executor_can_apply_it() {
        let persistence = Arc::new(HostileCrossUserExecutor {
            install_called: AtomicBool::new(false),
        });
        let replica = Replica::new(persistence.clone());
        let error = replica
            .install_or_replace(
                AccountId::from("account-1"),
                "desired-user".into(),
                Incarnation::from("desired-incarnation"),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(!persistence.install_called.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn install_rereads_and_retries_after_a_stale_compare_and_swap() {
        let persistence = Arc::new(InstallRaceExecutor {
            state: InMemoryReplica::default(),
            raced: AtomicBool::new(false),
            install_calls: AtomicUsize::new(0),
        });
        let replica = Replica::new(persistence.clone());
        let snapshot = replica
            .install_or_replace(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("desired-incarnation"),
            )
            .await
            .unwrap();
        assert_eq!(persistence.install_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            snapshot.incarnation,
            Incarnation::from("desired-incarnation")
        );
        assert_eq!(snapshot.revision, 1);
    }

    #[tokio::test]
    async fn rust_rejects_an_applied_response_when_authoritative_head_differs() {
        let replica = Replica::new(Arc::new(LyingAppliedExecutor {
            state: InMemoryReplica::default(),
        }));
        let error = replica
            .install_or_replace(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("desired-incarnation"),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(replica.snapshot(&AccountId::from("account-1")).is_none());
    }

    #[tokio::test]
    async fn rust_rejects_applied_when_preserved_rows_or_install_epoch_change() {
        for corruption in [
            RowCorruption::Delete,
            RowCorruption::Add,
            RowCorruption::Change,
            RowCorruption::LockEpoch,
        ] {
            let replica = Replica::new(Arc::new(LyingRowsExecutor {
                current: ReplicaSnapshot {
                    account_id: AccountId::from("account-1"),
                    user_id: "user-1".into(),
                    incarnation: Incarnation::from("old-incarnation"),
                    revision: 1,
                    lock_epoch: 0,
                    items: vec![item("account-1", "item-1", "operation-1")],
                    operations: vec![operation("operation-1", "item-1")],
                    receipts: vec![],
                    failure: None,
                    bootstrap: BootstrapAuthority::default(),
                },
                next_head: Mutex::new(None),
                corruption,
            }));
            assert_eq!(
                replica
                    .install_or_replace(
                        AccountId::from("account-1"),
                        "user-1".into(),
                        Incarnation::from("new-incarnation"),
                    )
                    .await
                    .unwrap_err()
                    .code,
                RuntimeErrorCode::InvariantViolation
            );
            assert!(replica.snapshot(&AccountId::from("account-1")).is_none());
        }
    }

    #[tokio::test]
    async fn lock_epoch_advance_rejects_applied_when_rows_change() {
        let replica = Replica::new(Arc::new(LyingRowsExecutor {
            current: ReplicaSnapshot {
                account_id: AccountId::from("account-1"),
                user_id: "user-1".into(),
                incarnation: Incarnation::from("incarnation-1"),
                revision: 1,
                lock_epoch: 0,
                items: vec![item("account-1", "item-1", "operation-1")],
                operations: vec![operation("operation-1", "item-1")],
                receipts: vec![],
                failure: None,
                bootstrap: BootstrapAuthority::default(),
            },
            next_head: Mutex::new(None),
            corruption: RowCorruption::Change,
        }));
        assert_eq!(
            replica
                .advance_lock_epoch(
                    &AccountId::from("account-1"),
                    "user-1",
                    &Incarnation::from("incarnation-1"),
                    1,
                )
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
    }

    #[tokio::test]
    async fn lock_epoch_advance_rereads_stale_progress_and_accepts_the_desired_epoch() {
        let state = InMemoryReplica::default();
        state
            .install(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .unwrap();
        let persistence = Arc::new(LockEpochRaceExecutor {
            state,
            raced: AtomicBool::new(false),
            advance_calls: AtomicUsize::new(0),
        });
        let replica = Replica::new(persistence.clone());

        let snapshot = replica
            .advance_lock_epoch(
                &AccountId::from("account-1"),
                "user-1",
                &Incarnation::from("incarnation-1"),
                1,
            )
            .await
            .unwrap();

        assert_eq!(snapshot.lock_epoch, 1);
        assert_eq!(snapshot.revision, 0);
        assert_eq!(persistence.advance_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn recomputing_plan_is_fenced_instead_of_retagged_after_lock() {
        let state = Arc::new(InMemoryReplica::default());
        state
            .install(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .unwrap();
        let replica = Replica::new(state.clone());
        let plan = GuardedCommitPlan::new(
            AccountId::from("account-1"),
            Incarnation::from("incarnation-1"),
            0,
            0,
            vec![PlanMutation::AcceptOperation(operation(
                "operation-1",
                "item-1",
            ))],
        );
        state
            .set_lock_epoch(&AccountId::from("account-1"), 1)
            .unwrap();

        let RecomputedPlanResult::Fenced { snapshot } =
            replica.execute_recomputing(plan).await.unwrap()
        else {
            panic!("an old-epoch plan must be fenced");
        };
        assert_eq!(snapshot.lock_epoch, 1);
        assert!(snapshot.operations.is_empty());
    }

    async fn assert_replica_conformance(replica: &Replica) {
        let account_id = AccountId::from("account-1");
        let incarnation = Incarnation::from("incarnation-1");
        assert_eq!(
            replica.load(&account_id).await.unwrap().unwrap().revision,
            0
        );

        assert_eq!(
            replica
                .execute(GuardedCommitPlan::new(
                    AccountId::from("missing-account"),
                    incarnation.clone(),
                    0,
                    0,
                    vec![],
                ))
                .await
                .unwrap(),
            PlanResult::Missing
        );
        assert_eq!(
            replica
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    incarnation.clone(),
                    7,
                    0,
                    vec![],
                ))
                .await
                .unwrap(),
            PlanResult::Stale { actual_revision: 0 }
        );

        let invalid = replica
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                incarnation.clone(),
                0,
                0,
                vec![
                    PlanMutation::PutOptimisticItem(item(
                        "account-1",
                        "item-invalid",
                        "operation-1",
                    )),
                    PlanMutation::RemoveOperation {
                        operation_id: "unknown-operation".into(),
                    },
                ],
            ))
            .await
            .unwrap_err();
        assert_eq!(invalid.code, RuntimeErrorCode::InvariantViolation);
        let unchanged = replica.load(&account_id).await.unwrap().unwrap();
        assert_eq!(unchanged.revision, 0);
        assert!(unchanged.items.is_empty());

        let wrong_scope = replica
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                incarnation.clone(),
                0,
                0,
                vec![PlanMutation::PutOptimisticItem(item(
                    "account-2",
                    "item-cross-account",
                    "operation-1",
                ))],
            ))
            .await
            .unwrap_err();
        assert_eq!(wrong_scope.code, RuntimeErrorCode::InvariantViolation);

        assert_eq!(
            replica
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    incarnation.clone(),
                    0,
                    0,
                    vec![
                        PlanMutation::AcceptOperation(operation("operation-1", "item-1")),
                        PlanMutation::PutOptimisticItem(item("account-1", "item-1", "operation-1")),
                    ],
                ))
                .await
                .unwrap(),
            PlanResult::Applied {
                replica_revision: 1,
            }
        );
        let committed = replica.load(&account_id).await.unwrap().unwrap();
        assert_eq!(committed.revision, 1);
        assert_eq!(committed.items.len(), 1);
        assert_eq!(committed.operations.len(), 1);

        assert_eq!(
            replica
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    incarnation.clone(),
                    1,
                    0,
                    vec![PlanMutation::RemoveOperation {
                        operation_id: "operation-1".into(),
                    }],
                ))
                .await
                .unwrap(),
            PlanResult::Applied {
                replica_revision: 2,
            }
        );
        assert_eq!(
            replica.load(&account_id).await.unwrap().unwrap().revision,
            2
        );

        // One completion is one transaction: the receipt appears, the Operation goes, and the
        // rejected user's ciphertext stays.
        let accepted = operation("operation-2", "item-2");
        assert!(matches!(
            replica
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    incarnation.clone(),
                    2,
                    0,
                    vec![
                        PlanMutation::AcceptOperation(accepted.clone()),
                        PlanMutation::PutOptimisticItem(item("account-1", "item-2", "operation-2")),
                    ],
                ))
                .await
                .unwrap(),
            PlanResult::Applied { .. }
        ));
        let rejected = ObservedOutcome {
            operation_id: "operation-2".into(),
            request_fingerprint: accepted.request_fingerprint,
            result: OperationOutcomeResult::Rejected {
                code: OperationRejectionCode::VaultReadOnly,
            },
        };

        // The same Operation ID answered for other bytes is identity reuse, and it moves nothing.
        let reused = replica
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                incarnation.clone(),
                3,
                0,
                vec![PlanMutation::RetainRejection {
                    outcome: ObservedOutcome {
                        request_fingerprint: Sha256Fingerprint([3; 32]),
                        ..rejected.clone()
                    },
                    cursor: None,
                }],
            ))
            .await
            .unwrap_err();
        assert_eq!(reused.code, RuntimeErrorCode::InvariantViolation);
        let untouched = replica.load(&account_id).await.unwrap().unwrap();
        assert_eq!(untouched.revision, 3);
        assert_eq!(untouched.operations.len(), 1);
        assert!(untouched.receipts.is_empty());

        assert!(matches!(
            replica
                .execute(GuardedCommitPlan::new(
                    account_id.clone(),
                    incarnation.clone(),
                    3,
                    0,
                    vec![PlanMutation::RetainRejection {
                        outcome: rejected,
                        cursor: None,
                    }],
                ))
                .await
                .unwrap(),
            PlanResult::Applied { .. }
        ));
        let completed = replica.load(&account_id).await.unwrap().unwrap();
        assert!(completed.operations.is_empty());
        assert!(completed
            .items
            .iter()
            .any(|overlay| overlay.item_id == "item-2"));
        assert_eq!(completed.receipts.len(), 1);
        assert_eq!(completed.receipts[0].operation_id, "operation-2");
        assert_eq!(completed.receipts[0].completed_at_revision, 4);

        // The compact receipt outlives the Operation, so its identity cannot be accepted again.
        let replayed = replica
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                incarnation,
                4,
                0,
                vec![PlanMutation::AcceptOperation(accepted)],
            ))
            .await
            .unwrap_err();
        assert_eq!(replayed.code, RuntimeErrorCode::InvariantViolation);
        assert_eq!(
            replica.load(&account_id).await.unwrap().unwrap().revision,
            4
        );
    }

    #[test]
    fn persistence_wire_uses_closed_tags_and_decimal_revision_strings() {
        assert_eq!(
            serde_json::to_value(ReplicaPersistenceRequest::Load {
                account_id: AccountId::from("account-1"),
            })
            .unwrap(),
            serde_json::json!({ "type": "load", "accountId": "account-1" })
        );
        let prepared = prepare_commit(
            ReplicaSnapshot {
                account_id: AccountId::from("account-1"),
                user_id: "user-1".into(),
                incarnation: Incarnation::from("incarnation-1"),
                revision: 41,
                lock_epoch: 0,
                items: vec![],
                operations: vec![operation("operation-1", "item-1")],
                receipts: vec![],
                failure: None,
                bootstrap: BootstrapAuthority::default(),
            },
            GuardedCommitPlan::new(
                AccountId::from("account-1"),
                Incarnation::from("incarnation-1"),
                41,
                0,
                vec![PlanMutation::RemoveOperation {
                    operation_id: "operation-1".into(),
                }],
            ),
        )
        .unwrap()
        .wire;
        let request = ReplicaPersistenceRequest::Commit { prepared };

        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "type": "commit",
                "prepared": {
                    "expected": {
                        "accountId": "account-1",
                        "userId": "user-1",
                        "incarnation": "incarnation-1",
                        "replicaRevision": "41",
                        "lockEpoch": "0"
                    },
                    "nextHead": {
                        "accountId": "account-1",
                        "userId": "user-1",
                        "incarnation": "incarnation-1",
                        "replicaRevision": "42",
                        "lockEpoch": "0",
                        "failure": null
                    },
                    "writes": [{
                        "type": "delete",
                        "store": "operations",
                        "key": { "accountId": "account-1", "recordId": "operation-1" }
                    }]
                }
            })
        );
        assert_eq!(
            serde_json::to_value(ReplicaPersistenceResponse::Loaded {
                head: None,
                rows: vec![],
            })
            .unwrap(),
            serde_json::json!({ "type": "loaded", "head": null, "rows": [] })
        );
        assert_eq!(
            serde_json::to_value(ReplicaPersistenceResponse::Committed {
                result: PlanResult::Applied {
                    replica_revision: 42,
                },
            })
            .unwrap(),
            serde_json::json!({
                "type": "committed",
                "result": { "type": "applied", "replicaRevision": "42" }
            })
        );
        assert!(
            serde_json::from_value::<ReplicaPersistenceResponse>(serde_json::json!({
                "type": "committed",
                "result": { "type": "stale", "actualRevision": 42 }
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ReplicaPersistenceResponse>(serde_json::json!({
                "type": "loaded",
                "rows": []
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ReplicaPersistenceResponse>(serde_json::json!({
                "type": "loaded",
                "head": {
                    "accountId": "account-1",
                    "incarnation": "incarnation-1",
                    "replicaRevision": "0"
                },
                "rows": []
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ReplicaPersistenceResponse>(serde_json::json!({
                "type": "committed",
                "result": { "type": "missing" },
                "unexpected": true
            }))
            .is_err()
        );
    }

    #[test]
    fn valid_domain_plan_becomes_an_opaque_primitive_commit() {
        let current = ReplicaSnapshot {
            account_id: AccountId::from("account-1"),
            user_id: "user-1".into(),
            incarnation: Incarnation::from("incarnation-1"),
            revision: 4,
            lock_epoch: 0,
            items: vec![],
            operations: vec![operation("operation-old", "item-old")],
            receipts: vec![],
            failure: None,
            bootstrap: BootstrapAuthority::default(),
        };
        let prepared = prepare_commit(
            current,
            GuardedCommitPlan::new(
                AccountId::from("account-1"),
                Incarnation::from("incarnation-1"),
                4,
                0,
                vec![
                    PlanMutation::AcceptOperation(operation("operation-new", "item-new")),
                    PlanMutation::PutOptimisticItem(item("account-1", "item-new", "operation-new")),
                    PlanMutation::RemoveOperation {
                        operation_id: "operation-old".into(),
                    },
                ],
            ),
        )
        .unwrap()
        .wire;

        let wire = serde_json::to_value(prepared).unwrap();
        assert_eq!(wire["expected"]["replicaRevision"], "4");
        assert_eq!(wire["nextHead"]["replicaRevision"], "5");
        assert_eq!(wire["writes"].as_array().unwrap().len(), 3);
        assert_eq!(wire["writes"][0]["type"], "put");
        assert_eq!(wire["writes"][0]["row"]["store"], "operations");
        assert!(wire["writes"][0]["row"]["payloadJson"].is_string());
        assert_eq!(wire["writes"][2]["type"], "delete");
        assert_eq!(wire["writes"][2]["store"], "operations");
        assert!(wire.to_string().find("acceptOperation").is_none());
        assert!(wire.to_string().find("removeOperation").is_none());
    }

    #[test]
    fn persisted_rows_are_reconstructed_and_validated_fail_closed() {
        let account_id = AccountId::from("account-1");
        let head = ReplicaHead {
            account_id: account_id.clone(),
            user_id: "user-1".into(),
            incarnation: Incarnation::from("incarnation-1"),
            replica_revision: 7,
            lock_epoch: 0,
            failure: None,
        };
        let mismatched = StoredReplicaRow {
            store: ReplicaStore::Operations,
            key: ReplicaRowKey {
                account_id: account_id.clone(),
                record_id: "operation-key".into(),
            },
            payload_json: serde_json::to_string(&operation("operation-payload", "item-1")).unwrap(),
        };

        let error = reconstruct_snapshot(&account_id, Some(head), vec![mismatched]).unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(reconstruct_snapshot(
            &account_id,
            Some(ReplicaHead {
                account_id: account_id.clone(),
                user_id: String::new(),
                incarnation: Incarnation::from("incarnation-1"),
                replica_revision: 0,
                lock_epoch: 0,
                failure: None,
            }),
            vec![],
        )
        .is_err());
        assert!(reconstruct_snapshot(&account_id, None, vec![])
            .unwrap()
            .is_none());
        assert!(reconstruct_snapshot(
            &account_id,
            None,
            vec![StoredReplicaRow {
                store: ReplicaStore::Operations,
                key: ReplicaRowKey {
                    account_id: account_id.clone(),
                    record_id: "orphan".into(),
                },
                payload_json: "{}".into(),
            }],
        )
        .is_err());
    }

    #[tokio::test]
    async fn in_memory_replica_satisfies_the_guarded_plan_contract() {
        let persistence = Arc::new(InMemoryReplica::default());
        persistence
            .install(
                AccountId::from("account-1"),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .unwrap();
        let persistence: Arc<dyn ReplicaPersistence> = persistence;
        assert_replica_conformance(&Replica::new(persistence)).await;
    }

    #[tokio::test]
    async fn installation_and_commit_cannot_change_the_account_user_identity() {
        let persistence = Arc::new(InMemoryReplica::default());
        let replica = Replica::new(persistence.clone());
        let account_id = AccountId::from("account-1");
        replica
            .install_or_replace(
                account_id.clone(),
                "user-1".into(),
                Incarnation::from("incarnation-1"),
            )
            .await
            .unwrap();
        assert!(replica
            .install_or_replace(
                account_id.clone(),
                "user-2".into(),
                Incarnation::from("incarnation-2"),
            )
            .await
            .is_err());
        let current = replica.load(&account_id).await.unwrap().unwrap();
        assert_eq!(current.user_id, "user-1");
        assert_eq!(current.incarnation, Incarnation::from("incarnation-1"));

        let mut prepared = prepare_commit(
            current,
            GuardedCommitPlan::new(
                account_id.clone(),
                Incarnation::from("incarnation-1"),
                0,
                0,
                vec![],
            ),
        )
        .unwrap()
        .wire;
        prepared.next_head.user_id = "user-2".into();
        assert!(persistence
            .invoke(ReplicaPersistenceRequest::Commit { prepared })
            .await
            .is_err());
        assert_eq!(
            replica.load(&account_id).await.unwrap().unwrap().user_id,
            "user-1"
        );
    }

    #[tokio::test]
    async fn serialized_executor_satisfies_the_same_guarded_plan_contract() {
        let executor = Arc::new(SerializedFakeExecutor::seeded());
        let persistence: Arc<dyn ReplicaPersistence> =
            Arc::new(SerializedReplicaPersistence::new(executor.clone()));
        assert_replica_conformance(&Replica::new(persistence)).await;
        // Accept, remove, accept, and complete: four commits, and one round trip each.
        assert_eq!(executor.commit_calls.load(Ordering::SeqCst), 4);
    }
}
