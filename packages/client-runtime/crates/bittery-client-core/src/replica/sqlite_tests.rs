use super::{
    canonical_create_vault_request,
    persistence_contract::{
        prepare_commit, prepare_install, reconstruct_snapshot, PreparedReplicaWrite, ReplicaHead,
        ReplicaRowKey, ReplicaStore, StoredReplicaRow,
    },
    AuthorityItemCategory, AuthorityItemRecord, AuthorityVaultRecord, AuthorityVaultRole,
    AuthorityVaultType, BeginBootstrapPlan, BootstrapAuthority, BootstrapContinuation,
    BootstrapGenerationId, BootstrapGuard, BootstrapPageCursor, BootstrapPageIdentity,
    CreateVaultCheckpoint, CreateVaultCleanupObligation, CreateVaultImageRecord,
    CreateVaultOperationRecord, GuardedCommitPlan, ImmutableHttpRequest, InMemoryReplica,
    LegacyAdmissionBootstrap, LegacyAdmissionOrigin, LegacyCheckpointEvidence,
    LegacyItemCacheBaseline, LegacyItemCacheMetadata, ObservedOutcome, OperationKind,
    OperationOutcomeResult, OperationReceiptRecord, OperationRecord, OperationSchedulingState,
    PlanMutation, PlanResult, PromoteBootstrapPlan, Replica, ReplicaPersistence,
    ReplicaPersistenceRequest, ReplicaPersistenceResponse, ReplicaState, ResourceRef,
    Sha256Fingerprint, SqliteReplica, StageBootstrapPagePlan, StageBootstrapPageResult, SyncCursor,
};
use crate::{
    http_transport::{HttpHeader, HttpMethod},
    protocol::Incarnation,
    AccountId, CreateVaultType, RuntimeError,
};
use async_trait::async_trait;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

struct TestDatabase {
    path: PathBuf,
}

impl TestDatabase {
    fn new(test_name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "bittery-client-core-{test_name}-{}.sqlite3",
            std::process::id(),
        ));
        let _ = std::fs::remove_file(&path);
        Self { path }
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn operation(operation_id: &str, item_id: &str) -> super::OperationRecord {
    crate::test_fixtures::test_operation(operation_id, item_id)
}

#[test]
fn sqlite_refuses_a_future_physical_version_without_changing_the_database() {
    let database = TestDatabase::new("future-physical-version");
    let connection = rusqlite::Connection::open(&database.path).unwrap();
    connection
        .execute_batch("PRAGMA application_id = 1112822361; PRAGMA user_version = 99; CREATE TABLE future_work (payload TEXT); INSERT INTO future_work VALUES ('accepted');")
        .unwrap();
    drop(connection);
    let before = std::fs::read(&database.path).unwrap();

    let error = SqliteReplica::open(&database.path)
        .err()
        .expect("future schema must be refused");
    assert_eq!(format!("{:?}", error.code), "StorageUnavailable");
    assert_eq!(std::fs::read(&database.path).unwrap(), before);
}

#[test]
fn sqlite_refuses_foreign_or_unrecognized_unversioned_databases_without_adopting_them() {
    for (name, schema) in [
        (
            "foreign",
            "PRAGMA application_id = 123; CREATE TABLE work (payload TEXT);",
        ),
        ("unrecognized", "CREATE TABLE replica_heads (payload TEXT);"),
        ("unstamped-version", "PRAGMA user_version = 1;"),
    ] {
        let database = TestDatabase::new(name);
        rusqlite::Connection::open(&database.path)
            .unwrap()
            .execute_batch(schema)
            .unwrap();
        let before = std::fs::read(&database.path).unwrap();
        let error = SqliteReplica::open(&database.path)
            .err()
            .expect("unsupported file must be refused");
        assert_eq!(error.code, crate::RuntimeErrorCode::StorageUnavailable);
        assert_eq!(std::fs::read(&database.path).unwrap(), before);
    }
}

#[tokio::test]
async fn sqlite_migration_is_atomic_at_every_write_boundary_with_accepted_work() {
    for boundary in 1..=4 {
        let database = TestDatabase::new(&format!("migration-failure-{boundary}"));
        let replica = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        install(&replica, "account-a").await;
        install(&replica, "account-b").await;
        replica
            .execute(plan("account-a", 0, "accepted-a"))
            .await
            .unwrap();
        replica
            .execute(plan("account-b", 0, "accepted-b"))
            .await
            .unwrap();
        let before_a = replica.load(&AccountId::from("account-a")).await.unwrap();
        let before_b = replica.load(&AccountId::from("account-b")).await.unwrap();
        drop(replica);
        // Version 0 has the identical physical tables: only the new identity/version stamps differ.
        rusqlite::Connection::open(&database.path)
            .unwrap()
            .execute_batch("PRAGMA application_id = 0; PRAGMA user_version = 0;")
            .unwrap();
        let before = std::fs::read(&database.path).unwrap();
        let error = SqliteReplica::open_failing_migration_after(&database.path, boundary)
            .err()
            .expect("migration fault must fail open");
        assert_eq!(error.code, crate::RuntimeErrorCode::StorageUnavailable);
        assert_eq!(std::fs::read(&database.path).unwrap(), before);

        let replica = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        assert_eq!(
            replica.load(&AccountId::from("account-a")).await.unwrap(),
            before_a
        );
        assert_eq!(
            replica.load(&AccountId::from("account-b")).await.unwrap(),
            before_b
        );
        let connection = rusqlite::Connection::open(&database.path).unwrap();
        assert_eq!(
            connection
                .pragma_query_value(None, "application_id", |row| row.get::<_, i32>(0))
                .unwrap(),
            1112822361
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
                .unwrap(),
            1
        );
    }
}

#[test]
fn sqlite_new_database_migration_rolls_back_every_write_boundary() {
    for boundary in 1..=4 {
        let database = TestDatabase::new(&format!("new-migration-failure-{boundary}"));
        assert!(SqliteReplica::open_failing_migration_after(&database.path, boundary).is_err());
        let connection = rusqlite::Connection::open(&database.path).unwrap();
        let count: i32 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_schema WHERE type = 'table'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(
            connection
                .pragma_query_value(None, "application_id", |row| row.get::<_, i32>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i32>(0))
                .unwrap(),
            0
        );
        drop(connection);
        assert!(SqliteReplica::open(&database.path).is_ok());
    }
}

#[tokio::test]
async fn sqlite_shared_histories_survive_legacy_migration_at_every_checkpoint() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../generated/replica-conformance/history-corpus.json"
    ))
    .unwrap();
    for history in corpus["histories"].as_array().unwrap() {
        let database = TestDatabase::new(&format!(
            "migration-corpus-{}",
            history["name"].as_str().unwrap()
        ));
        for step in history["steps"].as_array().unwrap() {
            let adapter = SqliteReplica::open(&database.path).unwrap();
            let request = serde_json::from_value(step["request"].clone()).unwrap();
            let expected: ReplicaPersistenceResponse =
                serde_json::from_value(step["expectedResponse"].clone()).unwrap();
            assert_eq!(
                ReplicaPersistence::invoke(&adapter, request).await.unwrap(),
                expected
            );
            drop(adapter);
            rusqlite::Connection::open(&database.path)
                .unwrap()
                .execute_batch("PRAGMA application_id = 0; PRAGMA user_version = 0;")
                .unwrap();
            let adapter = SqliteReplica::open(&database.path).unwrap();
            for checkpoint in step["expectedLoadedState"].as_array().unwrap() {
                let account_id = AccountId::from(checkpoint["accountId"].as_str().unwrap());
                let expected: ReplicaPersistenceResponse =
                    serde_json::from_value(checkpoint["response"].clone()).unwrap();
                let actual = ReplicaPersistence::invoke(
                    &adapter,
                    ReplicaPersistenceRequest::Load { account_id },
                )
                .await
                .unwrap();
                assert_eq!(actual, expected, "{}: {}", history["name"], step["label"]);
            }
        }
    }
}

fn persisted_create_vault_operation(account_id: &str, with_image: bool) -> OperationRecord {
    let vault_id = "vault-persisted";
    let operation_id = if with_image {
        "operation-persisted-image"
    } else {
        "operation-persisted-no-image"
    };
    let digest = "0123456789abcdef".repeat(4);
    let intent = CreateVaultOperationRecord {
        account_id: AccountId::from(account_id),
        name: "Persisted Vault".into(),
        vault_type: CreateVaultType::Personal,
        icon: "lock".into(),
        encrypted_vault_key: "opaque-wrapped-key".into(),
        image: with_image.then(|| CreateVaultImageRecord {
            protected_witness: None,
            raw_cleanup_pending: false,
            byte_length: 11,
            content_type: "image/png".into(),
            sha256: digest.clone(),
            object_key: format!(
                "vaults/user-{account_id}/{vault_id}/create/{operation_id}-{digest}"
            ),
        }),
        checkpoint: CreateVaultCheckpoint::FinalRequestFrozen,
    };
    let canonical = canonical_create_vault_request(vault_id, &intent).unwrap();
    let request = ImmutableHttpRequest {
        method: HttpMethod::Put,
        path: canonical.path,
        headers: vec![HttpHeader {
            name: "Content-Type".into(),
            value: "application/json".into(),
        }],
        body: canonical.body,
    };
    OperationRecord {
        operation_id: operation_id.into(),
        kind: OperationKind::CreateVault,
        target: ResourceRef::Vault {
            vault_id: vault_id.into(),
        },
        request,
        request_fingerprint: canonical.fingerprint,
        accepted_item_category: None,
        attachment_move_recovery: None,
        update_vault: None,
        create_vault: Some(intent),
        scheduling: OperationSchedulingState::default(),
        legacy_admission: None,
    }
}

fn recanonicalize_create_vault_operation(operation: &mut OperationRecord) {
    let canonical = canonical_create_vault_request(
        operation.vault_id(),
        operation.create_vault.as_ref().unwrap(),
    )
    .unwrap();
    operation.request.path = canonical.path;
    operation.request.body = canonical.body;
    operation.request_fingerprint = canonical.fingerprint;
}

fn item(account_id: &str, item_id: &str, operation_id: &str) -> super::ReplicaItemRecord {
    crate::test_fixtures::test_overlay(AccountId::from(account_id), item_id, operation_id)
}

async fn install(replica: &Replica, account_id: &str) {
    replica
        .install_or_replace(
            AccountId::from(account_id),
            format!("user-{account_id}"),
            Incarnation::from(format!("incarnation-{account_id}")),
        )
        .await
        .unwrap();
}

fn admitted_cache(account_id: &str, cursor: Option<&str>) -> BootstrapAuthority {
    let captured = cursor.map_or(SyncCursor::Cold, |id| SyncCursor::CapturedValue {
        id: id.to_owned(),
    });
    let checkpoint = cursor.map_or(LegacyCheckpointEvidence::Missing {}, |id| {
        LegacyCheckpointEvidence::CapturedValue { id: id.to_owned() }
    });
    let normalized_server_url = "https://example.test".to_owned();
    let metadata = Some(LegacyItemCacheMetadata {
        last_full_sync_at: 1,
        item_count: 1,
        cache_version: 1,
        sync_baseline: cursor.map(|id| LegacyItemCacheBaseline {
            server_url: "https://example.test/".to_owned(),
            normalized_server_url: normalized_server_url.clone(),
            cursor: SyncCursor::CapturedValue { id: id.to_owned() },
        }),
    });
    BootstrapAuthority::admit_legacy(LegacyAdmissionBootstrap {
        origin: LegacyAdmissionOrigin {
            manifest_entries_sha256: "ab".repeat(32),
            account_id: AccountId::from(account_id),
            user_id: format!("user-{account_id}"),
            incarnation: Incarnation::from(format!("incarnation-{account_id}")),
            normalized_server_url,
            source_active_generation: Some("source-generation".to_owned()),
            state_key: format!("record:{account_id}:meta:meta"),
            items_key_prefix: format!(
                "record:item-cache-stage:{account_id}:source-generation:items:"
            ),
            vaults_key_prefix: format!(
                "record:item-cache-stage:{account_id}:source-generation:vaults:"
            ),
            items_primed: true,
            vaults_primed: true,
            metadata,
            source_id: format!("account:{account_id}:server:https%3A%2F%2Fexample.test"),
            sync_baseline: checkpoint.clone(),
            last_sync_cursor: checkpoint,
            refresh_reason: None,
        },
        cursor: captured,
        vaults: vec![AuthorityVaultRecord {
            id: "vault-1".to_owned(),
            name: "Vault".to_owned(),
            vault_type: AuthorityVaultType::Personal,
            icon: None,
            image_url: None,
            encrypted_vault_key: "wrapped-vault-key".to_owned(),
            role: AuthorityVaultRole::Owner,
            key_version: None,
        }],
        items: vec![authority_item(account_id, "item-offline", 7)],
    })
    .unwrap()
}

#[tokio::test]
async fn admitted_offline_cache_and_baseline_state_survive_sqlite_restart() {
    for (name, cursor, expected_state) in [
        ("verified", Some("evt-1"), ReplicaState::Ready),
        ("missing", None, ReplicaState::RefreshRequired),
    ] {
        let database = TestDatabase::new(&format!("legacy-cache-{name}"));
        let persistence = Arc::new(SqliteReplica::open(&database.path).unwrap());
        let replica = Replica::new(persistence.clone());
        let account_id = AccountId::from(format!("account-{name}"));
        install(&replica, account_id.as_str()).await;
        let before = replica.load(&account_id).await.unwrap().unwrap();
        let mut admitted = before.clone();
        admitted.revision = 1;
        admitted.bootstrap = admitted_cache(account_id.as_str(), cursor);
        replica
            .commit_bootstrap_snapshot(before, admitted.clone(), true)
            .await
            .unwrap();
        drop(replica);
        drop(persistence);

        let reopened = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        let loaded = reopened.load(&account_id).await.unwrap().unwrap();
        assert_eq!(loaded.bootstrap.state, expected_state);
        assert_eq!(
            loaded.bootstrap.active_cursor,
            admitted.bootstrap.active_cursor
        );
        assert!(loaded.bootstrap.pages.is_empty());
        let visible = loaded.bootstrap.snapshot();
        assert_eq!(visible.visible_items.len(), 1);
        assert_eq!(
            visible.visible_items[0].encrypted_data,
            "authoritative-sealed-item-offline"
        );
        assert_eq!(
            visible.visible_vaults[0].encrypted_vault_key,
            "wrapped-vault-key"
        );
    }
}

fn plan(account_id: &str, revision: u64, operation_id: &str) -> GuardedCommitPlan {
    GuardedCommitPlan::new(
        AccountId::from(account_id),
        Incarnation::from(format!("incarnation-{account_id}")),
        revision,
        0,
        vec![
            PlanMutation::AcceptOperation(operation(operation_id, "item-1")),
            PlanMutation::PutOptimisticItem(item(account_id, "item-1", operation_id)),
        ],
    )
}

#[tokio::test]
async fn sqlite_deletes_one_explicit_account_and_preserves_another_after_reopen() {
    let database = TestDatabase::new("delete-account-reopen");
    let persistence = Arc::new(SqliteReplica::open(&database.path).unwrap());
    let replica = Replica::new(persistence.clone());
    install(&replica, "account-target").await;
    install(&replica, "account-kept").await;
    replica
        .execute(plan("account-target", 0, "operation-target"))
        .await
        .unwrap();
    replica
        .execute(plan("account-kept", 0, "operation-kept"))
        .await
        .unwrap();
    drop(replica);
    drop(persistence);

    let raw = rusqlite::Connection::open(&database.path).unwrap();
    for store in 0..=9 {
        raw.execute(
            "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params!["account-target", store, format!("exhaustive-{store}"), "opaque"],
        )
        .unwrap();
    }
    raw.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    raw.execute(
        "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES ('account-orphan', 9, 'orphan-capability', 'opaque')",
        [],
    )
    .unwrap();
    drop(raw);

    let persistence = Arc::new(SqliteReplica::open(&database.path).unwrap());

    assert_eq!(
        super::SerializedReplicaExecutor::invoke(
            persistence.as_ref(),
            r#"{"type":"deleteAccount","accountId":"account-target"}"#.into(),
        )
        .await
        .unwrap(),
        r#"{"type":"accountDeleted"}"#,
    );
    drop(persistence);

    let raw = rusqlite::Connection::open(&database.path).unwrap();
    let target_rows: i64 = raw
        .query_row(
            "SELECT COUNT(*) FROM replica_rows WHERE account_id = 'account-target'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let kept_rows: i64 = raw
        .query_row(
            "SELECT COUNT(*) FROM replica_rows WHERE account_id = 'account-kept'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(target_rows, 0);
    assert!(kept_rows > 0);
    let orphan_rows: i64 = raw
        .query_row(
            "SELECT COUNT(*) FROM replica_rows WHERE account_id = 'account-orphan'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(orphan_rows, 1);
    drop(raw);

    let persistence = SqliteReplica::open(&database.path).unwrap();
    super::SerializedReplicaExecutor::invoke(
        &persistence,
        r#"{"type":"deleteAccount","accountId":"account-orphan"}"#.into(),
    )
    .await
    .unwrap();
    drop(persistence);
    let raw = rusqlite::Connection::open(&database.path).unwrap();
    let orphan_rows: i64 = raw
        .query_row(
            "SELECT COUNT(*) FROM replica_rows WHERE account_id = 'account-orphan'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(orphan_rows, 0);
    drop(raw);

    let reopened = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
    assert_eq!(
        reopened
            .load(&AccountId::from("account-target"))
            .await
            .unwrap(),
        None
    );
    assert!(reopened
        .load(&AccountId::from("account-kept"))
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn sqlite_wipe_removes_orphan_rows_and_is_idempotent_after_reopen() {
    let database = TestDatabase::new("wipe-orphans-reopen");
    let persistence = Arc::new(SqliteReplica::open(&database.path).unwrap());
    let replica = Replica::new(persistence.clone());
    install(&replica, "account-headed").await;
    drop(replica);
    drop(persistence);

    let raw = rusqlite::Connection::open(&database.path).unwrap();
    raw.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    raw.execute(
        "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES ('orphan-account', 9, 'orphan-capability', 'opaque')",
        [],
    )
    .unwrap();
    drop(raw);

    for _ in 0..2 {
        let persistence = SqliteReplica::open(&database.path).unwrap();
        assert_eq!(
            super::SerializedReplicaExecutor::invoke(
                &persistence,
                r#"{"type":"wipeDevice"}"#.into(),
            )
            .await
            .unwrap(),
            r#"{"type":"deviceWiped"}"#,
        );
    }

    let raw = rusqlite::Connection::open(&database.path).unwrap();
    let heads: i64 = raw
        .query_row("SELECT COUNT(*) FROM replica_heads", [], |row| row.get(0))
        .unwrap();
    let rows: i64 = raw
        .query_row("SELECT COUNT(*) FROM replica_rows", [], |row| row.get(0))
        .unwrap();
    assert_eq!((heads, rows), (0, 0));
}

#[tokio::test]
async fn sqlite_account_delete_and_device_wipe_roll_back_at_every_write_boundary() {
    for (name, request) in [
        (
            "delete-account",
            r#"{"type":"deleteAccount","accountId":"account-target"}"#,
        ),
        ("wipe-device", r#"{"type":"wipeDevice"}"#),
    ] {
        for boundary in 1..=2 {
            let database = TestDatabase::new(&format!("{name}-atomic-{boundary}"));
            let initial = Arc::new(SqliteReplica::open(&database.path).unwrap());
            let replica = Replica::new(initial.clone());
            install(&replica, "account-target").await;
            replica
                .execute(plan("account-target", 0, "operation-target"))
                .await
                .unwrap();
            let before = replica
                .load(&AccountId::from("account-target"))
                .await
                .unwrap();
            drop(replica);
            drop(initial);

            let failing = SqliteReplica::open_failing_after(&database.path, boundary).unwrap();
            let error = super::SerializedReplicaExecutor::invoke(&failing, request.into())
                .await
                .unwrap_err();
            assert_eq!(error.message, "injected SQLite Replica write failure");
            drop(failing);

            let reopened = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
            assert_eq!(
                reopened
                    .load(&AccountId::from("account-target"))
                    .await
                    .unwrap(),
                before,
            );
        }
    }
}

#[tokio::test]
async fn sqlite_loads_a_missing_account_without_rows() {
    let database = TestDatabase::new("missing-account");
    let replica = SqliteReplica::open(&database.path).unwrap();

    let response = replica
        .invoke(ReplicaPersistenceRequest::Load {
            account_id: AccountId::from("account-missing"),
        })
        .await
        .unwrap();

    assert_eq!(
        response,
        ReplicaPersistenceResponse::Loaded {
            head: None,
            rows: vec![],
        }
    );
}

#[tokio::test]
async fn sqlite_load_rejects_receipts_whose_kind_and_resource_target_disagree() {
    let cleanup = CreateVaultCleanupObligation {
        image: CreateVaultImageRecord {
            protected_witness: None,
            raw_cleanup_pending: false,
            byte_length: 8,
            content_type: "image/png".into(),
            sha256: "ab".repeat(32),
            object_key: format!(
                "vaults/user-account-corrupt/vault-1/create/operation-cleanup-{}",
                "ab".repeat(32)
            ),
        },
        local_artifact_pending: true,
        remote_staging_pending: false,
    };
    let foreign_user_cleanup = CreateVaultCleanupObligation {
        image: CreateVaultImageRecord {
            protected_witness: None,
            raw_cleanup_pending: false,
            byte_length: 8,
            content_type: "image/png".into(),
            sha256: "ab".repeat(32),
            object_key: format!(
                "vaults/user-foreign/vault-1/create/operation-create-vault-foreign-cleanup-binding-{}",
                "ab".repeat(32)
            ),
        },
        local_artifact_pending: true,
        remote_staging_pending: true,
    };
    for (name, kind, target, result, create_vault_cleanup) in [
        (
            "create-share-vault-target",
            OperationKind::CreateShare,
            ResourceRef::Vault {
                vault_id: "vault-1".into(),
            },
            OperationOutcomeResult::ShareApplied {
                share_link_id: "share-1".into(),
                base_share_url: "https://share.example/".into(),
                expires_at: "2026-09-01T00:00:00Z".into(),
            },
            None,
        ),
        (
            "create-vault-item-target",
            OperationKind::CreateVault,
            ResourceRef::Item {
                item_id: "item-1".into(),
                vault_id: "vault-1".into(),
            },
            OperationOutcomeResult::VaultApplied {
                vault_id: "vault-1".into(),
            },
            None,
        ),
        (
            "create-item-vault-target",
            OperationKind::CreateItem,
            ResourceRef::Vault {
                vault_id: "vault-1".into(),
            },
            OperationOutcomeResult::Applied {
                entity_id: "item-1".into(),
                version: 1,
            },
            None,
        ),
        (
            "update-item-vault-result",
            OperationKind::UpdateItem,
            ResourceRef::Item {
                item_id: "item-1".into(),
                vault_id: "vault-1".into(),
            },
            OperationOutcomeResult::VaultApplied {
                vault_id: "vault-1".into(),
            },
            None,
        ),
        (
            "create-share-vault-result",
            OperationKind::CreateShare,
            ResourceRef::Item {
                item_id: "item-1".into(),
                vault_id: "vault-1".into(),
            },
            OperationOutcomeResult::VaultRejected {
                code: super::CreateVaultOperationRejectionCode::VaultIdConflict,
            },
            None,
        ),
        (
            "create-item-wrong-entity",
            OperationKind::CreateItem,
            ResourceRef::Item {
                item_id: "item-1".into(),
                vault_id: "vault-1".into(),
            },
            OperationOutcomeResult::Applied {
                entity_id: "item-other".into(),
                version: 1,
            },
            None,
        ),
        (
            "non-vault-cleanup",
            OperationKind::CreateShare,
            ResourceRef::Item {
                item_id: "item-1".into(),
                vault_id: "vault-1".into(),
            },
            OperationOutcomeResult::ShareApplied {
                share_link_id: "share-1".into(),
                base_share_url: "https://share.example/".into(),
                expires_at: "2026-09-01T00:00:00Z".into(),
            },
            Some(cleanup.clone()),
        ),
        (
            "create-vault-foreign-cleanup-binding",
            OperationKind::CreateVault,
            ResourceRef::Vault {
                vault_id: "vault-1".into(),
            },
            OperationOutcomeResult::VaultRejected {
                code: super::CreateVaultOperationRejectionCode::VaultIdConflict,
            },
            Some(foreign_user_cleanup),
        ),
    ] {
        let database = TestDatabase::new(name);
        let replica = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        install(&replica, "account-corrupt").await;
        drop(replica);
        let receipt = OperationReceiptRecord {
            operation_id: format!("operation-{name}"),
            kind,
            target,
            request_fingerprint: Sha256Fingerprint::of_bytes(b"fixed-request"),
            result,
            completed_at_revision: 1,
            create_vault_cleanup,
            legacy_lineage: None,
        };
        let raw = rusqlite::Connection::open(&database.path).unwrap();
        raw.execute(
            "UPDATE replica_heads SET replica_revision = '1' WHERE account_id = 'account-corrupt'",
            [],
        )
        .unwrap();
        raw.execute(
            "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES (?1, 2, ?2, ?3)",
            rusqlite::params![
                "account-corrupt",
                receipt.operation_id,
                serde_json::to_string(&receipt).unwrap()
            ],
        )
        .unwrap();
        drop(raw);

        let reopened = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        let error = reopened
            .load(&AccountId::from("account-corrupt"))
            .await
            .unwrap_err();
        assert_eq!(error.code, crate::RuntimeErrorCode::StorageUnavailable);
    }
}

#[tokio::test]
async fn sqlite_load_preserves_a_valid_create_vault_receipt() {
    let database = TestDatabase::new("valid-create-vault-receipt");
    let replica = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
    install(&replica, "account-valid").await;
    drop(replica);
    let receipt = OperationReceiptRecord {
        operation_id: "operation-valid-vault".into(),
        kind: OperationKind::CreateVault,
        target: ResourceRef::Vault {
            vault_id: "vault-valid".into(),
        },
        request_fingerprint: Sha256Fingerprint::of_bytes(b"valid-request"),
        result: OperationOutcomeResult::VaultApplied {
            vault_id: "vault-valid".into(),
        },
        completed_at_revision: 1,
        legacy_lineage: None,
        create_vault_cleanup: None,
    };
    let raw = rusqlite::Connection::open(&database.path).unwrap();
    raw.execute(
        "UPDATE replica_heads SET replica_revision = '1' WHERE account_id = 'account-valid'",
        [],
    )
    .unwrap();
    raw.execute(
        "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES (?1, 2, ?2, ?3)",
        rusqlite::params![
            "account-valid",
            receipt.operation_id,
            serde_json::to_string(&receipt).unwrap()
        ],
    )
    .unwrap();
    drop(raw);

    let reopened = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
    let snapshot = reopened
        .load(&AccountId::from("account-valid"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.receipts, vec![receipt]);
}

#[tokio::test]
async fn sqlite_reopen_rejects_each_create_vault_cleanup_authority_mismatch() {
    let digest = "fedcba9876543210".repeat(4);
    let valid = OperationReceiptRecord {
        operation_id: "operation-sqlite-image".into(),
        kind: OperationKind::CreateVault,
        target: ResourceRef::Vault {
            vault_id: "vault-sqlite-image".into(),
        },
        request_fingerprint: Sha256Fingerprint::of_bytes(b"sqlite-image-request"),
        result: OperationOutcomeResult::VaultRejected {
            code: super::CreateVaultOperationRejectionCode::TeamMembershipRequired,
        },
        completed_at_revision: 1,
        legacy_lineage: None,
        create_vault_cleanup: Some(CreateVaultCleanupObligation {
            image: CreateVaultImageRecord {
                protected_witness: None,
                raw_cleanup_pending: false,
                byte_length: 1,
                content_type: "image/jpeg".into(),
                sha256: digest.clone(),
                object_key: format!(
                    "vaults/user-account-sqlite-image/vault-sqlite-image/create/operation-sqlite-image-{digest}"
                ),
            },
            local_artifact_pending: false,
            remote_staging_pending: true,
        }),
    };
    let mut cases = Vec::new();
    for (label, key) in [
        (
            "user",
            format!("vaults/user-else/vault-sqlite-image/create/operation-sqlite-image-{digest}"),
        ),
        (
            "vault",
            format!(
                "vaults/user-account-sqlite-image/vault-else/create/operation-sqlite-image-{digest}"
            ),
        ),
        (
            "operation",
            format!(
                "vaults/user-account-sqlite-image/vault-sqlite-image/create/operation-else-{digest}"
            ),
        ),
        (
            "sha-key",
            format!(
                "vaults/user-account-sqlite-image/vault-sqlite-image/create/operation-sqlite-image-{}",
                "0".repeat(64)
            ),
        ),
    ] {
        let mut receipt = valid.clone();
        receipt
            .create_vault_cleanup
            .as_mut()
            .unwrap()
            .image
            .object_key = key;
        cases.push((label, receipt));
    }
    for (label, length) in [("empty", 0), ("oversized", 2_097_153)] {
        let mut receipt = valid.clone();
        receipt
            .create_vault_cleanup
            .as_mut()
            .unwrap()
            .image
            .byte_length = length;
        cases.push((label, receipt));
    }
    let mut bad_mime = valid.clone();
    bad_mime
        .create_vault_cleanup
        .as_mut()
        .unwrap()
        .image
        .content_type = "image/PNG".into();
    cases.push(("mime", bad_mime));
    let mut bad_sha = valid.clone();
    bad_sha.create_vault_cleanup.as_mut().unwrap().image.sha256 = "A".repeat(64);
    cases.push(("sha-shape", bad_sha));
    let mut bad_result = valid.clone();
    bad_result.result = OperationOutcomeResult::VaultApplied {
        vault_id: "vault-sqlite-image".into(),
    };
    cases.push(("result", bad_result));
    let mut bad_state = valid.clone();
    bad_state
        .create_vault_cleanup
        .as_mut()
        .unwrap()
        .remote_staging_pending = false;
    cases.push(("cleanup-state", bad_state));

    for (label, receipt) in cases {
        let database = TestDatabase::new(&format!("cleanup-authority-{label}"));
        let replica = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        install(&replica, "account-sqlite-image").await;
        drop(replica);
        let raw = rusqlite::Connection::open(&database.path).unwrap();
        raw.execute(
            "UPDATE replica_heads SET replica_revision = '1' WHERE account_id = 'account-sqlite-image'",
            [],
        )
        .unwrap();
        raw.execute(
            "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES (?1, 2, ?2, ?3)",
            rusqlite::params!["account-sqlite-image", receipt.operation_id, serde_json::to_string(&receipt).unwrap()],
        )
        .unwrap();
        drop(raw);
        let reopened = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        let error = reopened
            .load(&AccountId::from("account-sqlite-image"))
            .await
            .unwrap_err();
        assert_eq!(
            error.code,
            crate::RuntimeErrorCode::StorageUnavailable,
            "{label}"
        );
    }
}

#[test]
fn serialized_receipt_rows_fail_closed_before_projection() {
    let account_id = AccountId::from("account-serialized-corrupt");
    let head = ReplicaHead {
        account_id: account_id.clone(),
        user_id: "user-serialized-corrupt".into(),
        incarnation: Incarnation::from("incarnation-serialized-corrupt"),
        replica_revision: 1,
        lock_epoch: 0,
        failure: None,
    };
    let payload = serde_json::json!({
        "operationId": "operation-serialized-corrupt",
        "kind": "create_vault",
        "target": { "type": "vault", "vaultId": "vault-1" },
        "requestFingerprint": Sha256Fingerprint::of_bytes(b"serialized-corrupt"),
        "result": {
            "type": "shareApplied",
            "shareLinkId": "share-1",
            "baseShareUrl": "https://share.example/",
            "expiresAt": "2026-09-01T00:00:00Z"
        },
        "completedAtRevision": "1"
    });
    let rows = vec![StoredReplicaRow {
        store: ReplicaStore::OperationReceipts,
        key: ReplicaRowKey {
            account_id: account_id.clone(),
            record_id: "operation-serialized-corrupt".into(),
        },
        payload_json: serde_json::to_string(&payload).unwrap(),
    }];

    let error = reconstruct_snapshot(&account_id, Some(head), rows).unwrap_err();
    assert_eq!(error.code, crate::RuntimeErrorCode::InvariantViolation);
}

#[tokio::test]
async fn serialized_and_sqlite_create_vault_rows_validate_exact_final_request_before_replay() {
    let account_id = AccountId::from("account-persisted");
    let head = ReplicaHead {
        account_id: account_id.clone(),
        user_id: "user-account-persisted".into(),
        incarnation: Incarnation::from("incarnation-account-persisted"),
        replica_revision: 1,
        lock_epoch: 0,
        failure: None,
    };

    for with_image in [false, true] {
        let operation = persisted_create_vault_operation("account-persisted", with_image);
        let row = StoredReplicaRow {
            store: ReplicaStore::Operations,
            key: ReplicaRowKey {
                account_id: account_id.clone(),
                record_id: operation.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&operation).unwrap(),
        };
        let reconstructed = reconstruct_snapshot(&account_id, Some(head.clone()), vec![row])
            .unwrap()
            .unwrap();
        assert_eq!(reconstructed.operations, vec![operation]);
    }

    let operation = persisted_create_vault_operation("account-persisted", true);
    let mut corruptions = Vec::new();
    let base = serde_json::to_value(&operation).unwrap();
    for (label, path) in [
        ("relative-path", "api/v1/vaults/vault-persisted"),
        ("wrong-vault-path", "/api/v1/vaults/vault-other"),
        (
            "absolute-url",
            "https://example.invalid/api/v1/vaults/vault-persisted",
        ),
    ] {
        let mut value = base.clone();
        value["request"]["path"] = serde_json::Value::String(path.into());
        corruptions.push((label, value));
    }
    let mut method = base.clone();
    method["request"]["method"] = serde_json::Value::String("post".into());
    corruptions.push(("wrong-method", method));
    let mut headers = base.clone();
    headers["request"]["headers"] = serde_json::json!([]);
    corruptions.push(("wrong-headers", headers));
    for (label, bytes) in [
        ("whitespace", b" {\"name\":\"Persisted Vault\"}".as_slice()),
        (
            "property-order",
            b"{\"icon\":\"lock\",\"name\":\"Persisted Vault\"}",
        ),
        ("escaping", b"{\"name\":\"Persisted\\u0020Vault\"}"),
        ("changed-field", b"{\"name\":\"Changed Vault\"}"),
    ] {
        let mut value = base.clone();
        value["request"]["body"] = serde_json::to_value(bytes).unwrap();
        corruptions.push((label, value));
    }
    let mut raw_sha = base.clone();
    raw_sha["requestFingerprint"] =
        serde_json::to_value(Sha256Fingerprint::of_bytes(&operation.request.body)).unwrap();
    corruptions.push(("raw-sha-fingerprint", raw_sha));
    let mut wrong_fingerprint = base.clone();
    wrong_fingerprint["requestFingerprint"] =
        serde_json::to_value(Sha256Fingerprint([0x5a; 32])).unwrap();
    corruptions.push(("wrong-fingerprint", wrong_fingerprint));
    let mut premature_checkpoint = base.clone();
    premature_checkpoint["createVault"]["checkpoint"] =
        serde_json::Value::String("artifact_ready".into());
    corruptions.push(("final-body-before-checkpoint", premature_checkpoint));
    let mut wrong_image_key = base.clone();
    wrong_image_key["createVault"]["image"]["objectKey"] =
        serde_json::Value::String("vaults/wrong/image-key".into());
    corruptions.push(("image-object-key-disagreement", wrong_image_key));
    let mut missing_image = base.clone();
    missing_image["createVault"]["image"] = serde_json::Value::Null;
    corruptions.push(("image-body-without-image-intent", missing_image));
    let mut no_image_staging =
        serde_json::to_value(persisted_create_vault_operation("account-persisted", false)).unwrap();
    no_image_staging["createVault"]["checkpoint"] =
        serde_json::Value::String("remote_upload_confirmed".into());
    corruptions.push(("no-image-staging-checkpoint", no_image_staging));

    for (label, value) in corruptions {
        let record_id = value["operationId"].as_str().unwrap().to_owned();
        let row = StoredReplicaRow {
            store: ReplicaStore::Operations,
            key: ReplicaRowKey {
                account_id: account_id.clone(),
                record_id: record_id.clone(),
            },
            payload_json: serde_json::to_string(&value).unwrap(),
        };
        let error = reconstruct_snapshot(&account_id, Some(head.clone()), vec![row]).unwrap_err();
        assert_eq!(
            error.code,
            crate::RuntimeErrorCode::InvariantViolation,
            "{label}"
        );

        let database = TestDatabase::new(label);
        let replica = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        install(&replica, "account-persisted").await;
        drop(replica);
        let raw = rusqlite::Connection::open(&database.path).unwrap();
        raw.execute(
            "UPDATE replica_heads SET replica_revision = '1' WHERE account_id = 'account-persisted'",
            [],
        )
        .unwrap();
        raw.execute(
            "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES (?1, 1, ?2, ?3)",
            rusqlite::params![
                "account-persisted",
                record_id,
                serde_json::to_string(&value).unwrap()
            ],
        )
        .unwrap();
        drop(raw);
        let reopened = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        let error = reopened.load(&account_id).await.unwrap_err();
        assert_eq!(
            error.code,
            crate::RuntimeErrorCode::StorageUnavailable,
            "{label}"
        );
    }
}

#[tokio::test]
async fn guarded_serialized_and_sqlite_create_vault_reject_self_consistent_invalid_intent() {
    let mut cases = Vec::new();
    for (label, value) in [
        ("one-character-name", "x".into()),
        ("whitespace-name", "  ".into()),
        ("padded-name", " Persisted Vault".into()),
        ("oversized-name", "n".repeat(201)),
    ] {
        let mut operation = persisted_create_vault_operation("account-persisted", false);
        operation.create_vault.as_mut().unwrap().name = value;
        cases.push((label, AccountId::from("account-persisted"), operation));
    }
    for (label, value) in [
        ("empty-icon", String::new()),
        ("padded-icon", " lock".into()),
        ("oversized-icon", "i".repeat(129)),
    ] {
        let mut operation = persisted_create_vault_operation("account-persisted", false);
        operation.create_vault.as_mut().unwrap().icon = value;
        cases.push((label, AccountId::from("account-persisted"), operation));
    }
    for (label, value) in [
        ("blank-wrapped-key", "  ".into()),
        ("oversized-wrapped-key", "k".repeat(65_537)),
    ] {
        let mut operation = persisted_create_vault_operation("account-persisted", false);
        operation.create_vault.as_mut().unwrap().encrypted_vault_key = value;
        cases.push((label, AccountId::from("account-persisted"), operation));
    }
    for (label, value) in [
        ("unsafe-operation", "operation/path".into()),
        ("oversized-operation", "o".repeat(129)),
    ] {
        let mut operation = persisted_create_vault_operation("account-persisted", false);
        operation.operation_id = value;
        cases.push((label, AccountId::from("account-persisted"), operation));
    }
    for (label, value) in [
        ("unsafe-vault", "vault/path".into()),
        ("oversized-vault", "v".repeat(129)),
    ] {
        let mut operation = persisted_create_vault_operation("account-persisted", false);
        operation.target = ResourceRef::Vault { vault_id: value };
        cases.push((label, AccountId::from("account-persisted"), operation));
    }
    for (label, value) in [
        ("unsafe-account", "account/path".into()),
        ("oversized-account", "a".repeat(129)),
    ] {
        let account_id = AccountId::from(value);
        let mut operation = persisted_create_vault_operation(account_id.as_str(), false);
        operation.create_vault.as_mut().unwrap().account_id = account_id.clone();
        cases.push((label, account_id, operation));
    }

    for (label, account_id, mut operation) in cases {
        recanonicalize_create_vault_operation(&mut operation);
        let head = ReplicaHead {
            account_id: account_id.clone(),
            user_id: format!("user-{}", account_id.as_str()),
            incarnation: Incarnation::from("incarnation-persisted"),
            replica_revision: 1,
            lock_epoch: 0,
            failure: None,
        };
        let row = StoredReplicaRow {
            store: ReplicaStore::Operations,
            key: ReplicaRowKey {
                account_id: account_id.clone(),
                record_id: operation.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&operation).unwrap(),
        };
        let error = reconstruct_snapshot(&account_id, Some(head), vec![row]).unwrap_err();
        assert_eq!(
            error.code,
            crate::RuntimeErrorCode::InvariantViolation,
            "{label}"
        );

        let replica = InMemoryReplica::default();
        replica
            .install(
                account_id.clone(),
                format!("user-{}", account_id.as_str()),
                Incarnation::from("incarnation-persisted"),
            )
            .unwrap();
        let snapshot = replica.snapshot(&account_id).unwrap();
        let error = replica
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::AcceptOperation(operation.clone())],
            ))
            .unwrap_err();
        assert_eq!(
            error.code,
            crate::RuntimeErrorCode::InvariantViolation,
            "{label}"
        );

        let database = TestDatabase::new(label);
        let sqlite = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        sqlite
            .install_or_replace(
                account_id.clone(),
                format!("user-{}", account_id.as_str()),
                Incarnation::from("incarnation-persisted"),
            )
            .await
            .unwrap();
        drop(sqlite);
        let raw = rusqlite::Connection::open(&database.path).unwrap();
        raw.execute(
            "UPDATE replica_heads SET replica_revision = '1' WHERE account_id = ?1",
            [account_id.as_str()],
        )
        .unwrap();
        raw.execute(
            "INSERT INTO replica_rows (account_id, store, record_id, payload_json) VALUES (?1, 1, ?2, ?3)",
            rusqlite::params![
                account_id.as_str(),
                operation.operation_id,
                serde_json::to_string(&operation).unwrap()
            ],
        )
        .unwrap();
        drop(raw);
        let reopened = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        let error = reopened.load(&account_id).await.unwrap_err();
        assert_eq!(
            error.code,
            crate::RuntimeErrorCode::StorageUnavailable,
            "{label}"
        );
    }
}

#[tokio::test]
async fn create_vault_exact_immutable_boundaries_survive_guarded_acceptance_and_sqlite_restart() {
    for (label, account, operation_id, vault_id, name, icon, wrapped_key) in [
        (
            "minimums",
            "a".to_owned(),
            "o".to_owned(),
            "v".to_owned(),
            "ab".to_owned(),
            "i".to_owned(),
            "k".to_owned(),
        ),
        (
            "maximums",
            "a".repeat(128),
            "o".repeat(128),
            "v".repeat(128),
            "n".repeat(200),
            "i".repeat(128),
            "k".repeat(65_536),
        ),
    ] {
        let account_id = AccountId::from(account);
        let mut operation = persisted_create_vault_operation(account_id.as_str(), false);
        operation.operation_id = operation_id;
        operation.target = ResourceRef::Vault { vault_id };
        let intent = operation.create_vault.as_mut().unwrap();
        intent.account_id = account_id.clone();
        intent.name = name;
        intent.icon = icon;
        intent.encrypted_vault_key = wrapped_key;
        recanonicalize_create_vault_operation(&mut operation);

        let database = TestDatabase::new(label);
        let replica = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        let snapshot = replica
            .install_or_replace(
                account_id.clone(),
                "user-boundary".into(),
                Incarnation::from("incarnation-boundary"),
            )
            .await
            .unwrap();
        let result = replica
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::AcceptOperation(operation.clone())],
            ))
            .await
            .unwrap();
        assert!(matches!(result, PlanResult::Applied { .. }), "{label}");
        drop(replica);

        let reopened = Replica::new(Arc::new(SqliteReplica::open(&database.path).unwrap()));
        let loaded = reopened.load(&account_id).await.unwrap().unwrap();
        assert_eq!(loaded.operations, vec![operation], "{label}");
    }
}

fn valid_rejected_image_receipt() -> OperationReceiptRecord {
    let sha = "0123456789abcdef".repeat(4);
    OperationReceiptRecord {
        operation_id: "operation-image".into(),
        kind: OperationKind::CreateVault,
        target: ResourceRef::Vault {
            vault_id: "vault-image".into(),
        },
        request_fingerprint: Sha256Fingerprint::of_bytes(b"image-request"),
        result: OperationOutcomeResult::VaultRejected {
            code: super::CreateVaultOperationRejectionCode::VaultIdConflict,
        },
        completed_at_revision: 1,
        legacy_lineage: None,
        create_vault_cleanup: Some(CreateVaultCleanupObligation {
            image: CreateVaultImageRecord {
                protected_witness: None,
                raw_cleanup_pending: false,
                byte_length: 2_097_152,
                content_type: "image/avif".into(),
                sha256: sha.clone(),
                object_key: format!(
                    "vaults/user-account-image/vault-image/create/operation-image-{sha}"
                ),
            },
            local_artifact_pending: true,
            remote_staging_pending: true,
        }),
    }
}

#[test]
fn serialized_create_vault_receipt_image_authority_cross_product_fails_closed() {
    let account_id = AccountId::from("account-image");
    let head = ReplicaHead {
        account_id: account_id.clone(),
        user_id: "user-account-image".into(),
        incarnation: Incarnation::from("incarnation-account-image"),
        replica_revision: 1,
        lock_epoch: 0,
        failure: None,
    };
    let valid = serde_json::to_value(valid_rejected_image_receipt()).unwrap();
    let mut corruptions = Vec::new();
    for (label, pointer, value) in [
        (
            "foreign-user",
            "/createVaultCleanup/image/objectKey",
            serde_json::json!(format!(
                "vaults/user-foreign/vault-image/create/operation-image-{}",
                "0123456789abcdef".repeat(4)
            )),
        ),
        (
            "foreign-vault",
            "/target/vaultId",
            serde_json::json!("vault-other"),
        ),
        (
            "foreign-operation",
            "/operationId",
            serde_json::json!("operation-other"),
        ),
        (
            "zero-length",
            "/createVaultCleanup/image/byteLength",
            serde_json::json!(0),
        ),
        (
            "oversize",
            "/createVaultCleanup/image/byteLength",
            serde_json::json!(2_097_153),
        ),
        (
            "wrong-mime",
            "/createVaultCleanup/image/contentType",
            serde_json::json!("image/svg+xml"),
        ),
        (
            "wrong-sha",
            "/createVaultCleanup/image/sha256",
            serde_json::json!("f".repeat(64)),
        ),
        (
            "empty-sha",
            "/createVaultCleanup/image/sha256",
            serde_json::json!(""),
        ),
        (
            "local-only-rejected",
            "/createVaultCleanup/remoteStagingPending",
            serde_json::json!(false),
        ),
    ] {
        let mut payload = valid.clone();
        *payload.pointer_mut(pointer).unwrap() = value;
        corruptions.push((label, payload));
    }
    let mut applied_remote = valid.clone();
    applied_remote["result"] = serde_json::json!({"type":"vaultApplied","vaultId":"vault-image"});
    corruptions.push(("applied-remote-cleanup", applied_remote));

    for (label, payload) in corruptions {
        let rows = vec![StoredReplicaRow {
            store: ReplicaStore::OperationReceipts,
            key: ReplicaRowKey {
                account_id: account_id.clone(),
                record_id: payload["operationId"].as_str().unwrap().to_owned(),
            },
            payload_json: serde_json::to_string(&payload).unwrap(),
        }];
        let error = reconstruct_snapshot(&account_id, Some(head.clone()), rows).unwrap_err();
        assert_eq!(
            error.code,
            crate::RuntimeErrorCode::InvariantViolation,
            "{label}"
        );
    }

    for (label, receipt) in [
        (
            "no-image-rejected",
            OperationReceiptRecord {
                legacy_lineage: None,
                create_vault_cleanup: None,
                ..valid_rejected_image_receipt()
            },
        ),
        (
            "rejected-local-complete",
            OperationReceiptRecord {
                legacy_lineage: None,
                create_vault_cleanup: Some(CreateVaultCleanupObligation {
                    local_artifact_pending: false,
                    ..valid_rejected_image_receipt().create_vault_cleanup.unwrap()
                }),
                ..valid_rejected_image_receipt()
            },
        ),
        (
            "no-image-applied",
            OperationReceiptRecord {
                result: OperationOutcomeResult::VaultApplied {
                    vault_id: "vault-image".into(),
                },
                legacy_lineage: None,
                create_vault_cleanup: None,
                ..valid_rejected_image_receipt()
            },
        ),
        (
            "applied-local-pending",
            OperationReceiptRecord {
                result: OperationOutcomeResult::VaultApplied {
                    vault_id: "vault-image".into(),
                },
                legacy_lineage: None,
                create_vault_cleanup: Some(CreateVaultCleanupObligation {
                    remote_staging_pending: false,
                    ..valid_rejected_image_receipt().create_vault_cleanup.unwrap()
                }),
                ..valid_rejected_image_receipt()
            },
        ),
    ] {
        let rows = vec![StoredReplicaRow {
            store: ReplicaStore::OperationReceipts,
            key: ReplicaRowKey {
                account_id: account_id.clone(),
                record_id: receipt.operation_id.clone(),
            },
            payload_json: serde_json::to_string(&receipt).unwrap(),
        }];
        assert!(
            reconstruct_snapshot(&account_id, Some(head.clone()), rows).is_ok(),
            "{label}"
        );
    }
}

#[tokio::test]
async fn sqlite_matches_in_memory_for_install_commit_replay_lock_and_account_scope() {
    let database = TestDatabase::new("representative-history");
    let sqlite_persistence: Arc<dyn ReplicaPersistence> =
        Arc::new(SqliteReplica::open(&database.path).unwrap());
    let memory_persistence: Arc<dyn ReplicaPersistence> = Arc::new(InMemoryReplica::default());
    let sqlite = Replica::new(sqlite_persistence);
    let memory = Replica::new(memory_persistence);

    for replica in [&memory, &sqlite] {
        install(replica, "account-1").await;
        install(replica, "account-2").await;
    }
    for account_id in ["account-1", "account-2"] {
        assert_eq!(
            memory.load(&AccountId::from(account_id)).await.unwrap(),
            sqlite.load(&AccountId::from(account_id)).await.unwrap()
        );
    }

    let missing = GuardedCommitPlan::new(
        AccountId::from("account-missing"),
        Incarnation::from("incarnation-account-missing"),
        0,
        0,
        vec![],
    );
    assert_eq!(
        memory.execute(missing.clone()).await.unwrap(),
        PlanResult::Missing
    );
    assert_eq!(sqlite.execute(missing).await.unwrap(), PlanResult::Missing);

    let accepted = plan("account-1", 0, "operation-1");
    assert_eq!(
        memory.execute(accepted.clone()).await.unwrap(),
        sqlite.execute(accepted.clone()).await.unwrap()
    );
    assert_eq!(
        memory.load(&AccountId::from("account-1")).await.unwrap(),
        sqlite.load(&AccountId::from("account-1")).await.unwrap()
    );
    assert_eq!(
        memory.load(&AccountId::from("account-2")).await.unwrap(),
        sqlite.load(&AccountId::from("account-2")).await.unwrap()
    );

    assert_eq!(
        memory.execute(accepted.clone()).await.unwrap(),
        PlanResult::Stale { actual_revision: 1 }
    );
    assert_eq!(
        sqlite.execute(accepted).await.unwrap(),
        PlanResult::Stale { actual_revision: 1 }
    );
    assert_eq!(
        sqlite
            .load(&AccountId::from("account-1"))
            .await
            .unwrap()
            .unwrap()
            .revision,
        1
    );

    for replica in [&memory, &sqlite] {
        let advanced = replica
            .advance_lock_epoch(
                &AccountId::from("account-1"),
                "user-account-1",
                &Incarnation::from("incarnation-account-1"),
                1,
            )
            .await
            .unwrap();
        assert_eq!(advanced.lock_epoch, 1);
        assert_eq!(advanced.revision, 1);
    }
    assert_eq!(
        memory.load(&AccountId::from("account-1")).await.unwrap(),
        sqlite.load(&AccountId::from("account-1")).await.unwrap()
    );

    let cross_scope = GuardedCommitPlan::new(
        AccountId::from("account-2"),
        Incarnation::from("incarnation-account-2"),
        0,
        0,
        vec![PlanMutation::PutOptimisticItem(item(
            "account-1",
            "cross-account-item",
            "cross-account-operation",
        ))],
    );
    let memory_error = memory.execute(cross_scope.clone()).await.unwrap_err();
    let sqlite_error = sqlite.execute(cross_scope).await.unwrap_err();
    assert_eq!(memory_error.code, sqlite_error.code);
    assert_eq!(
        memory.load(&AccountId::from("account-2")).await.unwrap(),
        sqlite.load(&AccountId::from("account-2")).await.unwrap()
    );
}

#[tokio::test]
async fn sqlite_rolls_back_every_write_when_a_commit_boundary_fails() {
    let database = TestDatabase::new("atomic-failure");
    let initial: Arc<dyn ReplicaPersistence> =
        Arc::new(SqliteReplica::open(&database.path).unwrap());
    let initial_replica = Replica::new(initial);
    install(&initial_replica, "account-1").await;
    drop(initial_replica);

    let untouched = Replica::new(Arc::new(InMemoryReplica::default()));
    install(&untouched, "account-1").await;
    let expected = untouched.load(&AccountId::from("account-1")).await.unwrap();

    // Head, Operation, and optimistic overlay are three separate SQLite statements inside one
    // transaction. Failure after each boundary must expose exactly the old in-memory state.
    for boundary in 1..=3 {
        let failing: Arc<dyn ReplicaPersistence> =
            Arc::new(SqliteReplica::open_failing_after(&database.path, boundary).unwrap());
        let sqlite = Replica::new(failing);
        let failure: RuntimeError = sqlite
            .execute(plan("account-1", 0, "operation-failed"))
            .await
            .unwrap_err();
        assert!(failure
            .message
            .contains("injected SQLite Replica write failure"));
        assert_eq!(
            sqlite.load(&AccountId::from("account-1")).await.unwrap(),
            expected
        );
    }
}

struct RecordingPersistence {
    inner: InMemoryReplica,
    writes: Mutex<Vec<ReplicaPersistenceRequest>>,
}

impl RecordingPersistence {
    fn new() -> Self {
        Self {
            inner: InMemoryReplica::default(),
            writes: Mutex::new(Vec::new()),
        }
    }

    fn recorded(&self) -> Vec<ReplicaPersistenceRequest> {
        self.writes.lock().unwrap().clone()
    }
}

#[async_trait]
impl ReplicaPersistence for RecordingPersistence {
    async fn invoke(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
        if !matches!(
            request,
            ReplicaPersistenceRequest::Load { .. } | ReplicaPersistenceRequest::Inventory { .. }
        ) {
            self.writes.lock().unwrap().push(request.clone());
        }
        self.inner.invoke(request).await
    }
}

struct FailureScenario {
    name: &'static str,
    setup: Vec<ReplicaPersistenceRequest>,
    request: ReplicaPersistenceRequest,
    before: Vec<u8>,
    after: Vec<u8>,
}

async fn canonical_account_bytes(
    persistence: &dyn ReplicaPersistence,
    account_id: &AccountId,
) -> Vec<u8> {
    let response = persistence
        .invoke(ReplicaPersistenceRequest::Load {
            account_id: account_id.clone(),
        })
        .await
        .unwrap();
    let ReplicaPersistenceResponse::Loaded { head, mut rows } = response else {
        panic!("load returned a write response");
    };
    rows.sort_by(|left, right| {
        serde_json::to_vec(left)
            .unwrap()
            .cmp(&serde_json::to_vec(right).unwrap())
    });
    serde_json::to_vec(&ReplicaPersistenceResponse::Loaded { head, rows }).unwrap()
}

fn authority_item(account_id: &str, item_id: &str, version: i32) -> AuthorityItemRecord {
    AuthorityItemRecord {
        id: item_id.to_owned(),
        vault_id: "vault-1".to_owned(),
        category: AuthorityItemCategory::Login,
        favorite: false,
        encrypted_data: format!("authoritative-sealed-{item_id}"),
        encryption_iv: "BBBBBBBBBBBBBBBB".to_owned(),
        encryption_algorithm: "AES-GCM-AAD-V1".to_owned(),
        version,
        encryption_version: 1,
        encrypted_by_user_id: format!("user-{account_id}"),
        last_modified_by: format!("user-{account_id}"),
        created_at: "2026-08-24T00:00:00Z".to_owned(),
        updated_at: "2026-08-24T00:01:00Z".to_owned(),
        deleted_at: None,
        attachments: Vec::new(),
    }
}

fn bootstrap_guard(account_id: &str, revision: u64) -> BootstrapGuard {
    BootstrapGuard {
        account_id: AccountId::from(account_id),
        user_id: format!("user-{account_id}"),
        incarnation: Incarnation::from(format!("incarnation-{account_id}")),
        expected_replica_revision: revision,
        expected_lock_epoch: 0,
    }
}

async fn ready_recording_replica() -> (Arc<RecordingPersistence>, Replica, AccountId) {
    let account_id = AccountId::from("account-matrix");
    let persistence = Arc::new(RecordingPersistence::new());
    let replica = Replica::new(persistence.clone());
    install(&replica, account_id.as_str()).await;
    assert_eq!(
        replica
            .begin_bootstrap(BeginBootstrapPlan {
                guard: bootstrap_guard(account_id.as_str(), 0),
                generation_id: BootstrapGenerationId("generation-matrix".to_owned()),
            })
            .await
            .unwrap(),
        PlanResult::Applied {
            replica_revision: 1
        }
    );
    let watermark = SyncCursor::CapturedValue {
        id: "cursor-matrix".to_owned(),
    };
    assert_eq!(
        replica
            .stage_bootstrap_page(StageBootstrapPagePlan {
                guard: bootstrap_guard(account_id.as_str(), 1),
                generation_id: BootstrapGenerationId("generation-matrix".to_owned()),
                page_identity: BootstrapPageIdentity::vaults(0),
                request_cursor: BootstrapPageCursor::VaultsInitial,
                raw_response_fingerprint: Sha256Fingerprint::of_bytes(b"vault-page"),
                pinned_watermark: watermark.clone(),
                continuation: BootstrapContinuation::Final,
                vault_key_version_included: false,
                vaults: vec![crate::test_fixtures::personal_vault(
                    "vault-1",
                    "user-account-matrix",
                )],
                items: Vec::new(),
            })
            .await
            .unwrap(),
        StageBootstrapPageResult::Applied
    );
    assert_eq!(
        replica
            .stage_bootstrap_page(StageBootstrapPagePlan {
                guard: bootstrap_guard(account_id.as_str(), 1),
                generation_id: BootstrapGenerationId("generation-matrix".to_owned()),
                page_identity: BootstrapPageIdentity::items(0),
                request_cursor: BootstrapPageCursor::ItemsInitial,
                raw_response_fingerprint: Sha256Fingerprint::of_bytes(b"item-page"),
                pinned_watermark: watermark,
                continuation: BootstrapContinuation::Final,
                vault_key_version_included: false,
                vaults: Vec::new(),
                items: vec![authority_item(account_id.as_str(), "item-existing", 1)],
            })
            .await
            .unwrap(),
        StageBootstrapPageResult::Applied
    );
    assert_eq!(
        replica
            .promote_bootstrap(PromoteBootstrapPlan {
                additional_retired_vault_ids: Vec::new(),
                guard: bootstrap_guard(account_id.as_str(), 1),
                generation_id: BootstrapGenerationId("generation-matrix".to_owned()),
            })
            .await
            .unwrap(),
        PlanResult::Applied {
            replica_revision: 2
        }
    );
    (persistence, replica, account_id)
}

async fn finish_scenario(
    name: &'static str,
    persistence: Arc<RecordingPersistence>,
    account_id: &AccountId,
    before: Vec<u8>,
) -> FailureScenario {
    let after = canonical_account_bytes(&persistence.inner, account_id).await;
    let mut requests = persistence.recorded();
    let request = requests.pop().expect("scenario records its target request");
    FailureScenario {
        name,
        setup: requests,
        request,
        before,
        after,
    }
}

async fn failure_scenarios() -> [FailureScenario; 4] {
    let (persistence, replica, account_id) = ready_recording_replica().await;
    let before = canonical_account_bytes(&persistence.inner, &account_id).await;
    replica
        .install_or_replace(
            account_id.clone(),
            "user-account-matrix".to_owned(),
            Incarnation::from("replacement-account-matrix"),
        )
        .await
        .unwrap();
    let replacement =
        finish_scenario("replacement Install", persistence, &account_id, before).await;

    let (persistence, replica, account_id) = ready_recording_replica().await;
    let before = canonical_account_bytes(&persistence.inner, &account_id).await;
    assert_eq!(
        replica
            .execute(plan(account_id.as_str(), 2, "operation-accepted"))
            .await
            .unwrap(),
        PlanResult::Applied {
            replica_revision: 3
        }
    );
    let accepted = finish_scenario(
        "accepted Operation Commit",
        persistence,
        &account_id,
        before,
    )
    .await;

    let (persistence, replica, account_id) = ready_recording_replica().await;
    assert_eq!(
        replica
            .execute(plan(account_id.as_str(), 2, "operation-reconciled"))
            .await
            .unwrap(),
        PlanResult::Applied {
            replica_revision: 3
        }
    );
    let before = canonical_account_bytes(&persistence.inner, &account_id).await;
    let accepted_operation = operation("operation-reconciled", "item-1");
    assert_eq!(
        replica
            .execute(GuardedCommitPlan::new(
                account_id.clone(),
                Incarnation::from("incarnation-account-matrix"),
                3,
                0,
                vec![PlanMutation::ReconcileAppliedCreate {
                    outcome: ObservedOutcome {
                        operation_id: accepted_operation.operation_id.clone(),
                        request_fingerprint: accepted_operation.request_fingerprint,
                        result: OperationOutcomeResult::Applied {
                            entity_id: accepted_operation.item_id().to_owned(),
                            version: 1,
                        },
                    },
                    item: Box::new(authority_item(account_id.as_str(), "item-1", 1)),
                    cursor: None,
                }],
            ))
            .await
            .unwrap(),
        PlanResult::Applied {
            replica_revision: 4
        }
    );
    let reconciliation = finish_scenario(
        "authoritative reconciliation Commit",
        persistence,
        &account_id,
        before,
    )
    .await;

    let (persistence, replica, account_id) = ready_recording_replica().await;
    let before = canonical_account_bytes(&persistence.inner, &account_id).await;
    replica
        .advance_lock_epoch(
            &account_id,
            "user-account-matrix",
            &Incarnation::from("incarnation-account-matrix"),
            1,
        )
        .await
        .unwrap();
    let lock = finish_scenario("Lock", persistence, &account_id, before).await;

    [replacement, accepted, reconciliation, lock]
}

fn sqlite_write_boundaries(request: &ReplicaPersistenceRequest) -> usize {
    match request {
        ReplicaPersistenceRequest::Install { prepared } => 1 + prepared.writes.len(),
        ReplicaPersistenceRequest::Commit { prepared } => 1 + prepared.writes.len(),
        ReplicaPersistenceRequest::AdvanceLockEpoch { .. } => 1,
        ReplicaPersistenceRequest::DeleteAccountIfUnchanged { .. }
        | ReplicaPersistenceRequest::DeleteAccount { .. }
        | ReplicaPersistenceRequest::WipeDevice => 2,
        ReplicaPersistenceRequest::Load { .. } | ReplicaPersistenceRequest::Inventory { .. } => {
            panic!("a read has no SQLite write boundary")
        }
    }
}

#[tokio::test]
async fn sqlite_failure_matrix_covers_every_replica_write_boundary() {
    let scenarios = failure_scenarios().await;
    for scenario in scenarios {
        let account_id = AccountId::from("account-matrix");
        for boundary in 1..=sqlite_write_boundaries(&scenario.request) {
            let database = TestDatabase::new(&format!(
                "complete-failure-{}-{boundary}",
                scenario.name.replace(' ', "-")
            ));
            let initial = SqliteReplica::open(&database.path).unwrap();
            for request in &scenario.setup {
                initial.invoke(request.clone()).await.unwrap();
            }
            assert_eq!(
                canonical_account_bytes(&initial, &account_id).await,
                scenario.before,
                "{} boundary {boundary} did not start from the Domain pre-state",
                scenario.name
            );
            drop(initial);

            let failing = SqliteReplica::open_failing_after(&database.path, boundary).unwrap();
            let error = failing.invoke(scenario.request.clone()).await.unwrap_err();
            assert!(error
                .message
                .contains("injected SQLite Replica write failure"));
            drop(failing);

            let reopened = SqliteReplica::open(&database.path).unwrap();
            assert_eq!(
                canonical_account_bytes(&reopened, &account_id).await,
                scenario.before,
                "{} boundary {boundary} exposed a partial Account",
                scenario.name
            );
            reopened.invoke(scenario.request.clone()).await.unwrap();
            drop(reopened);

            let completed = SqliteReplica::open(&database.path).unwrap();
            assert_eq!(
                canonical_account_bytes(&completed, &account_id).await,
                scenario.after,
                "{} boundary {boundary} did not reach the complete Domain post-state",
                scenario.name
            );
        }
    }
}

#[tokio::test]
async fn sqlite_rejects_commit_and_install_writes_outside_the_guarded_account() {
    let database = TestDatabase::new("cross-account-delete");
    let persistence = Arc::new(SqliteReplica::open(&database.path).unwrap());
    let replica = Replica::new(persistence.clone());
    install(&replica, "account-1").await;
    install(&replica, "account-2").await;
    replica
        .execute(plan("account-2", 0, "operation-account-2"))
        .await
        .unwrap();
    let account_2_before = replica.load(&AccountId::from("account-2")).await.unwrap();

    let account_1 = replica
        .load(&AccountId::from("account-1"))
        .await
        .unwrap()
        .unwrap();
    let mut prepared = prepare_commit(
        account_1,
        GuardedCommitPlan::new(
            AccountId::from("account-1"),
            Incarnation::from("incarnation-account-1"),
            0,
            0,
            vec![],
        ),
    )
    .unwrap()
    .wire;
    prepared.writes.push(PreparedReplicaWrite::Delete {
        store: ReplicaStore::Operations,
        key: ReplicaRowKey {
            account_id: AccountId::from("account-2"),
            record_id: "operation-account-2".into(),
        },
    });

    persistence
        .invoke(ReplicaPersistenceRequest::Commit { prepared })
        .await
        .unwrap_err();
    assert_eq!(
        replica.load(&AccountId::from("account-2")).await.unwrap(),
        account_2_before
    );

    let account_1 = replica
        .load(&AccountId::from("account-1"))
        .await
        .unwrap()
        .unwrap();
    let mut replacement = prepare_install(
        Some(&account_1),
        AccountId::from("account-1"),
        "user-account-1".into(),
        Incarnation::from("replacement-account-1"),
    )
    .unwrap();
    replacement.writes.push(PreparedReplicaWrite::Delete {
        store: ReplicaStore::Operations,
        key: ReplicaRowKey {
            account_id: AccountId::from("account-2"),
            record_id: "operation-account-2".into(),
        },
    });
    persistence
        .invoke(ReplicaPersistenceRequest::Install {
            prepared: replacement,
        })
        .await
        .unwrap_err();
    assert_eq!(
        replica.load(&AccountId::from("account-2")).await.unwrap(),
        account_2_before
    );
}

#[tokio::test]
async fn admission_abort_guard_preserves_a_same_head_changed_row() {
    use super::persistence_contract::snapshot_rows;
    let database = TestDatabase::new("admission-abort-same-head-race");
    let store = Arc::new(SqliteReplica::open(&database.path).unwrap());
    let replica = Replica::new(store.clone());
    let prepared = prepare_install(
        None,
        "abort-account".into(),
        "abort-user".into(),
        "abort-generation".into(),
    )
    .unwrap();
    let account_id = prepared.next_head.account_id.clone();
    let mut expected = reconstruct_snapshot(&account_id, Some(prepared.next_head.clone()), vec![])
        .unwrap()
        .unwrap();
    expected.bootstrap.policy_verification_pending = true;
    replica
        .stage_profile_admission_snapshot(&expected)
        .await
        .unwrap();
    let loaded = replica.load_uncached(&account_id).await.unwrap().unwrap();
    let expected_rows = snapshot_rows(loaded.clone()).unwrap();
    assert!(!expected_rows.is_empty());
    let mut changed = loaded;
    changed.bootstrap.policy_verification_pending = false;
    let row = &expected_rows[0];
    let mut payload: serde_json::Value = serde_json::from_str(&row.payload_json).unwrap();
    assert_eq!(payload["policyVerificationPending"], true);
    payload["policyVerificationPending"] = serde_json::json!(false);
    let connection = rusqlite::Connection::open(&database.path).unwrap();
    assert_eq!(connection.execute("UPDATE replica_rows SET payload_json=?1 WHERE account_id=?2 AND store=?3 AND record_id=?4", rusqlite::params![payload.to_string(), account_id.as_str(), row.store.physical_id(), row.key.record_id]).unwrap(), 1);
    let response = super::SerializedReplicaExecutor::invoke(store.as_ref(), serde_json::json!({"type":"deleteAccountIfUnchanged","accountId":account_id.as_str(),"expectedHead":prepared.next_head,"expectedRows":expected_rows}).to_string()).await.unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&response).unwrap(),
        serde_json::json!({"type":"accountDeletion","result":{"type":"conflict"}})
    );
    assert_eq!(
        replica.load_uncached(&account_id).await.unwrap(),
        Some(changed)
    );
}

#[tokio::test]
async fn admission_abort_guard_rolls_back_and_replays_only_complete_absence() {
    use super::persistence_contract::{snapshot_rows, ReplicaAccountDeletionResult};
    for boundary in [1, 2] {
        let database = TestDatabase::new(&format!("admission-abort-rollback-{boundary}"));
        let store = Arc::new(SqliteReplica::open(&database.path).unwrap());
        let replica = Replica::new(store.clone());
        let prepared = prepare_install(
            None,
            "abort-account".into(),
            "abort-user".into(),
            "abort-generation".into(),
        )
        .unwrap();
        let account_id = prepared.next_head.account_id.clone();
        let mut expected =
            reconstruct_snapshot(&account_id, Some(prepared.next_head.clone()), vec![])
                .unwrap()
                .unwrap();
        expected.bootstrap.policy_verification_pending = true;
        replica
            .stage_profile_admission_snapshot(&expected)
            .await
            .unwrap();
        let request = ReplicaPersistenceRequest::DeleteAccountIfUnchanged {
            account_id: account_id.clone(),
            expected_head: prepared.next_head,
            expected_rows: snapshot_rows(expected.clone()).unwrap(),
        };
        let failing = SqliteReplica::open_failing_after(&database.path, boundary).unwrap();
        assert!(ReplicaPersistence::invoke(&failing, request.clone())
            .await
            .is_err());
        assert_eq!(
            replica.load_uncached(&account_id).await.unwrap(),
            Some(expected)
        );
        assert_eq!(
            ReplicaPersistence::invoke(store.as_ref(), request.clone())
                .await
                .unwrap(),
            ReplicaPersistenceResponse::AccountDeletion {
                result: ReplicaAccountDeletionResult::Deleted {}
            }
        );
        assert_eq!(
            ReplicaPersistence::invoke(store.as_ref(), request.clone())
                .await
                .unwrap(),
            ReplicaPersistenceResponse::AccountDeletion {
                result: ReplicaAccountDeletionResult::AlreadyAbsent {}
            }
        );
        let mut duplicate = request.clone();
        if let ReplicaPersistenceRequest::DeleteAccountIfUnchanged { expected_rows, .. } =
            &mut duplicate
        {
            expected_rows.push(expected_rows[0].clone());
        }
        assert!(ReplicaPersistence::invoke(store.as_ref(), duplicate)
            .await
            .is_err());
        let mut foreign = request.clone();
        if let ReplicaPersistenceRequest::DeleteAccountIfUnchanged { expected_head, .. } =
            &mut foreign
        {
            expected_head.account_id = "foreign-account".into();
        }
        assert!(ReplicaPersistence::invoke(store.as_ref(), foreign)
            .await
            .is_err());
        let connection = rusqlite::Connection::open(&database.path).unwrap();
        connection.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        connection
            .execute(
                "INSERT INTO replica_rows VALUES (?1,999,'orphan','{bad')",
                [account_id.as_str()],
            )
            .unwrap();
        assert_eq!(
            ReplicaPersistence::invoke(store.as_ref(), request)
                .await
                .unwrap(),
            ReplicaPersistenceResponse::AccountDeletion {
                result: ReplicaAccountDeletionResult::Conflict {}
            }
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM replica_rows", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
}

#[tokio::test]
async fn admission_abort_adapter_compares_payload_bytes_without_domain_decoding() {
    use super::persistence_contract::ReplicaAccountDeletionResult;
    let database = TestDatabase::new("admission-abort-opaque-payload");
    let store = SqliteReplica::open(&database.path).unwrap();
    let head = ReplicaHead {
        account_id: "opaque-account".into(),
        user_id: "user".into(),
        incarnation: "incarnation".into(),
        replica_revision: 0,
        lock_epoch: 0,
        failure: None,
    };
    let row = StoredReplicaRow {
        store: ReplicaStore::Operations,
        key: ReplicaRowKey {
            account_id: head.account_id.clone(),
            record_id: "opaque-operation".into(),
        },
        payload_json: "expected".into(),
    };
    let connection = rusqlite::Connection::open(&database.path).unwrap();
    connection
        .execute(
            "INSERT INTO replica_heads VALUES ('opaque-account','user','incarnation','0','0',NULL)",
            [],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO replica_rows VALUES (?1,?2,?3,?4)",
            rusqlite::params![
                head.account_id.as_str(),
                row.store.physical_id(),
                row.key.record_id,
                row.payload_json
            ],
        )
        .unwrap();
    let response = ReplicaPersistence::invoke(
        &store,
        ReplicaPersistenceRequest::DeleteAccountIfUnchanged {
            account_id: head.account_id.clone(),
            expected_head: head,
            expected_rows: vec![row],
        },
    )
    .await
    .unwrap();
    assert_eq!(
        response,
        ReplicaPersistenceResponse::AccountDeletion {
            result: ReplicaAccountDeletionResult::Deleted {}
        }
    );
}
