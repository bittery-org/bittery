//! Public destination lifecycle must preserve accepted source-owned Move evidence.
use super::*;
#[path = "cross_account_move_fanout_tests.rs"]
mod fanout_tests;
use crate::runtime::attachment_move_lifecycle::{AttachmentMoveLifecycle, TestAccountLeasePort};
use crate::runtime::{
    TeardownHostCleanup, TeardownHostCleanupRequest, TeardownHostCleanupResponse,
};

async fn saved_replica_image(sqlite: &SqliteReplica, account_id: &AccountId) -> Value {
    let response = SerializedReplicaExecutor::invoke(
        sqlite,
        json!({"type":"load", "accountId":account_id}).to_string(),
    )
    .await
    .unwrap();
    let image: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(image["type"], "loaded");
    assert!(image["head"].is_object());
    assert!(image["rows"].is_array());
    image
}

async fn restore_replica_image(sqlite: &SqliteReplica, image: &Value) {
    let writes = image["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| json!({"type":"put", "row":row}))
        .collect::<Vec<_>>();
    let response = SerializedReplicaExecutor::invoke(
        sqlite,
        json!({
            "type":"install",
            "prepared":{
                "expected":{"type":"missing", "accountId":image["head"]["accountId"]},
                "nextHead":image["head"],
                "writes":writes
            }
        })
        .to_string(),
    )
    .await
    .expect("captured durable input must pass normal SQLite reconstruction validation");
    assert_eq!(
        serde_json::from_str::<Value>(&response).unwrap(),
        json!({"type":"installed", "result":{"type":"applied"}})
    );
}

#[tokio::test]
async fn restored_replacement_destination_retires_original_binding_without_retargeting() {
    let fixture = AdmittedMoveFixture::new().await;
    let source_image = saved_replica_image(&fixture.sqlite.sqlite, &fixture.source).await;
    let admitted_rows = source_image["rows"].as_array().unwrap();
    let admitted = workflow(admitted_rows, &fixture.operation_id);
    assert_eq!(admitted["destinationBinding"]["status"], "active");
    let old_destination_incarnation = admitted["destinationBinding"]["incarnation"].clone();

    fixture.http.offline.store(false, Ordering::SeqCst);
    let response = fixture
        .runtime
        .request(
            sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .expect("public verified replacement must install a consistent destination generation");
    assert!(
        matches!(response, RuntimeResponse::SignedIn { account_id, .. } if account_id == fixture.target)
    );
    let target_image = saved_replica_image(&fixture.sqlite.sqlite, &fixture.target).await;
    assert_ne!(
        target_image["head"]["incarnation"],
        old_destination_incarnation
    );
    let catalog = fixture.platform.catalog().unwrap();
    assert!(catalog
        .accounts
        .iter()
        .all(|entry| { entry.pending_install.is_none() && entry.pending_retirement.is_none() }));
    let destination = catalog
        .accounts
        .iter()
        .find(|entry| entry.account_id == fixture.target)
        .unwrap();
    assert_eq!(
        json!(destination.active_incarnation),
        target_image["head"]["incarnation"]
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        )["destinationBinding"]["status"],
        "retired",
        "normal verified replacement already enforces its durable retirement barrier"
    );

    let AdmittedMoveFixture {
        database: _original_database,
        platform,
        http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    } = fixture;
    let old_owner = Arc::downgrade(&runtime);
    drop(runtime);
    drop(sqlite);
    assert!(old_owner.upgrade().is_none());

    // Restore two captured, independently valid Replica images: the original admitted source
    // and the verified newer destination. This is an explicit recovery-input boundary, not a
    // claim that public replacement can skip its source writes. The actual newer catalog and
    // generation metadata stay intact; no accepted request, proof or incarnation is synthesized.
    let database = MoveDatabase::new();
    let sqlite = MoveSqlite::open(&database.0);
    restore_replica_image(&sqlite.sqlite, &source_image).await;
    restore_replica_image(&sqlite.sqlite, &target_image).await;
    assert_eq!(
        saved_replica_image(&sqlite.sqlite, &source).await,
        source_image
    );
    assert_eq!(
        saved_replica_image(&sqlite.sqlite, &target).await,
        target_image
    );
    let runtime = open_move_runtime(sqlite.clone(), platform.clone(), http.clone()).await;
    let rows = durable_rows(&database.0, &source).await;
    let retired = workflow(&rows, &operation_id);
    let mut expected = admitted;
    expected["destinationBinding"]["status"] = json!("retired");
    expected["destinationBinding"]["bindingRevision"] = json!("1");
    expected["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
    assert_eq!(
        retired, expected,
        "startup retires the exact old binding without adopting the new destination generation"
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row["store"] != "crossAccountMoves")
            .collect::<Vec<_>>(),
        admitted_rows
            .iter()
            .filter(|row| row["store"] != "crossAccountMoves")
            .collect::<Vec<_>>(),
        "source authority and optimistic overlay remain exact"
    );
    assert_eq!(
        saved_replica_image(&sqlite.sqlite, &target).await,
        target_image
    );
    assert_eq!(platform.catalog().unwrap(), catalog);
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::Operations {
                account_id: source.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Operations(operations) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("expected Operations after public open");
    };
    observation.close();
    assert_eq!(operations.operations.len(), 1);
    assert_eq!(operations.operations[0].operation_id, operation_id);
    assert_eq!(
        operations.operations[0].resolution,
        OperationResolution::Pending
    );
    assert_eq!(
        operations.operations[0]
            .cross_account_move
            .as_ref()
            .unwrap()
            .disposition,
        crate::CrossAccountMoveDisposition::Blocked {
            reason: crate::CrossAccountMoveBlockedReason::DestinationRetired,
        }
    );
    for account_id in [&source, &target] {
        runtime
            .request(
                quick_unlock_request(account_id.as_str()),
                RequestCancellation::new(),
            )
            .await
            .expect("both restored generations retain their own valid authentication material");
    }
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    assert_eq!(
        workflow(&durable_rows(&database.0, &source).await, &operation_id),
        expected
    );
    assert!(http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(http.mutations(TARGET_ORIGIN).is_empty());
    runtime.close().await;
}

#[tokio::test]
async fn restored_absent_destination_retires_active_move_before_ready_and_is_idempotent() {
    let AdmittedMoveFixture {
        database,
        platform,
        http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    } = AdmittedMoveFixture::new().await;
    let admitted_rows = durable_rows(&database.0, &source).await;
    let admitted = workflow(&admitted_rows, &operation_id);
    assert_eq!(admitted["destinationBinding"]["status"], "active");
    assert_eq!(admitted["destinationBinding"]["bindingRevision"], "0");
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    let target_rows = durable_rows(&database.0, &target).await;

    let old_owner = Arc::downgrade(&runtime);
    drop(runtime);
    drop(sqlite);
    assert!(old_owner.upgrade().is_none());

    // This is restored storage input, not a claim that current public Remove can bypass its
    // durable retirement barrier. Preserve the actual accepted source Replica and its generation
    // metadata, but restore a valid catalog with no destination entry or retirement marker.
    // Uncatalogued destination rows may remain after interrupted cleanup; they confer no authority.
    let mut restored_catalog = platform.catalog().unwrap();
    restored_catalog
        .accounts
        .retain(|entry| entry.account_id != target);
    let restored_catalog = DeviceCatalogDocument::new(restored_catalog.accounts).unwrap();
    assert_eq!(restored_catalog.accounts.len(), 1);
    assert_eq!(restored_catalog.accounts[0].account_id, source);
    assert!(restored_catalog.accounts[0].pending_install.is_none());
    assert!(restored_catalog.accounts[0].pending_retirement.is_none());
    platform.put_document(
        "devicePlain",
        "bittery:runtime:platform-storage:device-catalog".into(),
        &restored_catalog,
    );
    assert_eq!(durable_rows(&database.0, &source).await, admitted_rows);

    let mut expected = admitted.clone();
    expected["destinationBinding"]["status"] = json!("retired");
    expected["destinationBinding"]["bindingRevision"] = json!("1");
    expected["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
    let ordinary_rows = |rows: &[Value]| {
        rows.iter()
            .filter(|row| row["store"] != "crossAccountMoves")
            .cloned()
            .collect::<Vec<_>>()
    };
    let mut first_projection = None;
    for reopen in 0..2 {
        let sqlite = MoveSqlite::open(&database.0);
        let runtime = open_move_runtime(sqlite.clone(), platform.clone(), http.clone()).await;
        let rows = durable_rows(&database.0, &source).await;
        let retired = workflow(&rows, &operation_id);
        assert_eq!(
            retired["destinationBinding"]["status"], "retired",
            "public open must retire an absent destination before admitting observation"
        );
        assert_eq!(
            retired, expected,
            "recovery changes only the original binding and disposition, retaining all children"
        );
        assert_eq!(
            ordinary_rows(&rows),
            ordinary_rows(&admitted_rows),
            "source authority and its accepted visible overlay survive destination retirement"
        );
        assert_eq!(platform.catalog().unwrap(), restored_catalog);
        assert_eq!(
            durable_rows(&database.0, &target).await,
            target_rows,
            "source recovery does not erase or adopt uncatalogued destination storage"
        );

        let sink = Arc::new(Sink::default());
        let observation = runtime
            .observe(
                ObservationRequest::Operations {
                    account_id: source.clone(),
                },
                sink.clone(),
            )
            .expect("successful open must expose the already retired workflow");
        let RuntimeProjection::Operations(operations) =
            sink.0.lock().unwrap().last().cloned().unwrap()
        else {
            panic!("expected Operations after public open");
        };
        observation.close();
        assert_eq!(operations.operations.len(), 1);
        assert_eq!(operations.operations[0].operation_id, operation_id);
        assert_eq!(
            operations.operations[0].resolution,
            OperationResolution::Pending
        );
        assert_eq!(
            operations.operations[0]
                .cross_account_move
                .as_ref()
                .unwrap()
                .disposition,
            crate::CrossAccountMoveDisposition::Blocked {
                reason: crate::CrossAccountMoveBlockedReason::DestinationRetired,
            }
        );
        if let Some(first) = &first_projection {
            assert_eq!(
                &operations, first,
                "second open must not advance the binding or public source Replica revision"
            );
        } else {
            first_projection = Some(operations);
        }

        if reopen == 1 {
            http.offline.store(false, Ordering::SeqCst);
            runtime
                .request(
                    quick_unlock_request(source.as_str()),
                    RequestCancellation::new(),
                )
                .await
                .expect("the surviving source can still unlock independently");
            assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
            assert_eq!(
                workflow(&durable_rows(&database.0, &source).await, &operation_id),
                expected
            );
        }
        assert!(http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(http.mutations(TARGET_ORIGIN).is_empty());
        let old_owner = Arc::downgrade(&runtime);
        drop(runtime);
        drop(sqlite);
        assert!(old_owner.upgrade().is_none());
    }
}

#[tokio::test]
async fn actual_owner_loss_during_replacement_restores_retirement_before_old_authority_reuse() {
    let fixture = AdmittedMoveFixture::new().await;
    let original_target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let pause = Pause::new(PersistenceStep::PendingCatalog);
    fixture.platform.pause_at(pause.clone());
    fixture.http.offline.store(false, Ordering::SeqCst);
    let installer = fixture.runtime.clone();
    let request = tokio::spawn(async move {
        installer
            .request(
                sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        pause.wait_until_reached(),
    )
    .await
    .expect("verified replacement must reach the held pending catalog acknowledgement");
    let staged_catalog = fixture.platform.catalog().unwrap();
    let staged = staged_catalog
        .accounts
        .iter()
        .find(|entry| entry.account_id == fixture.target)
        .unwrap();
    let pending = staged.pending_install.as_ref().unwrap();
    assert_eq!(
        pending.expected_active_incarnation.as_ref(),
        Some(&original_target.incarnation)
    );
    assert!(staged.pending_retirement.is_none());
    assert!(!fixture.platform.has_document(
        fixture.target.as_str(),
        pending.incarnation.as_str(),
        "metadata"
    ));
    assert_eq!(
        fixture
            .runtime
            .replica
            .load_uncached(&fixture.target)
            .await
            .unwrap()
            .unwrap()
            .incarnation,
        original_target.incarnation
    );
    let retired = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(retired["destinationBinding"]["status"], "retired");

    // Dropping the actual owner skips the installer's asynchronous rollback. The durable
    // pending install is the sole remaining witness that the old authority was retired.
    request.abort();
    assert!(request.await.unwrap_err().is_cancelled());
    fixture.platform.pause.lock().unwrap().take();
    let AdmittedMoveFixture {
        database,
        platform,
        http,
        sqlite,
        runtime,
        source,
        target,
        operation_id,
    } = fixture;
    let old_owner = Arc::downgrade(&runtime);
    drop(runtime);
    drop(sqlite);
    assert!(old_owner.upgrade().is_none());
    let sqlite = MoveSqlite::open(&database.0);
    let runtime = open_move_runtime(sqlite.clone(), platform.clone(), http.clone()).await;
    let rejected = runtime
        .request(
            RuntimeRequest::QuickUnlock {
                account_id: target.clone(),
                master_password: MASTER_PASSWORD.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect_err("startup rollback must not reopen retired destination authority");
    assert_eq!(rejected.code, RuntimeErrorCode::AccountMissing);
    let recovered_catalog = platform.catalog().unwrap();
    let recovered = recovered_catalog
        .accounts
        .iter()
        .find(|entry| entry.account_id == target)
        .unwrap();
    assert!(recovered.pending_install.is_none());
    let marker = recovered.pending_retirement.as_ref().unwrap();
    assert_eq!(marker.incarnation, original_target.incarnation);
    assert_eq!(
        marker.purpose,
        crate::platform_storage::AccountRetirementPurpose::Replace
    );
    assert_eq!(
        workflow(&durable_rows(&database.0, &source).await, &operation_id),
        retired
    );
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        runtime.request(
            sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        ),
    )
    .await
    .expect("recovered replacement retry must finish without the consumed fixture pause")
    .expect("fresh verified Sign-in must finish the recovered replacement");
    assert!(
        matches!(response, RuntimeResponse::SignedIn { account_id, .. } if account_id == target)
    );
    assert_ne!(
        runtime.require_snapshot(&target).unwrap().incarnation,
        original_target.incarnation
    );
    assert!(!runtime.account_teardown_is_pending(&target));
    assert_eq!(
        workflow(&durable_rows(&database.0, &source).await, &operation_id),
        retired
    );
    assert!(http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(http.mutations(TARGET_ORIGIN).is_empty());
    runtime.close().await;
}

struct ScopedCleanup(AccountId);

#[async_trait]
impl TeardownHostCleanup for ScopedCleanup {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        assert_eq!(
            request,
            TeardownHostCleanupRequest::DeleteAccount {
                account_id: self.0.clone()
            }
        );
        Ok(TeardownHostCleanupResponse::AccountDeleted)
    }
}

fn install_target_cleanup(fixture: &AdmittedMoveFixture) -> MoveDatabase {
    let artifacts = MoveDatabase::new();
    *fixture.runtime.attachment_move_lifecycle.lock().unwrap() =
        Some(Arc::new(AttachmentMoveLifecycle::new(
            Arc::new(TestAccountLeasePort),
            Arc::new(crate::SqliteAttachmentArtifactStore::open(&artifacts.0).unwrap()),
        )));
    fixture
        .platform
        .allow_teardown_prefixes
        .store(true, Ordering::SeqCst);
    fixture
        .runtime
        .install_teardown_host_cleanup(Arc::new(ScopedCleanup(fixture.target.clone())));
    artifacts
}

pub(super) async fn remove_target(fixture: &AdmittedMoveFixture) -> MoveDatabase {
    let artifacts = install_target_cleanup(fixture);
    let response = fixture
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: fixture.target.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(
        matches!(
            response,
            RuntimeResponse::Teardown {
                status: crate::TeardownStatus::Complete,
                ..
            }
        ),
        "target Remove must complete: {response:?}"
    );
    artifacts
}

#[tokio::test]
async fn removed_destination_readd_keeps_original_move_retired_without_dispatch() {
    let fixture = AdmittedMoveFixture::new().await;
    let admitted = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    let _artifacts = remove_target(&fixture).await;
    let retired = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(
        retired["destinationBinding"]["status"], "retired",
        "successful target Remove must retire the durable source binding"
    );
    assert_eq!(retired["destinationBinding"]["bindingRevision"], "1");
    let mut expected = admitted.clone();
    expected["destinationBinding"]["status"] = json!("retired");
    expected["destinationBinding"]["bindingRevision"] = json!("1");
    expected["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
    assert_eq!(
        retired, expected,
        "retirement must preserve accepted identity, ciphertext, children and schedule"
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    fixture.http.offline.store(false, Ordering::SeqCst);
    let RuntimeResponse::SignedIn {
        account_id: replacement,
        ..
    } = fixture
        .runtime
        .request(
            sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("same Server/User Sign-in failed")
    };
    assert_ne!(replacement, fixture.target);
    let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let pass = fixture
        .runtime
        .dispatch_cross_account_move(&snapshot, &fixture.operation_id)
        .await;
    assert!(matches!(
        pass,
        crate::runtime::dispatch::DispatchPass::Parked
    ));
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        retired
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn failed_source_retirement_is_drained_before_sqlite_reopen_admits_target_work() {
    let mut fixture = AdmittedMoveFixture::new().await;
    let _artifacts = install_target_cleanup(&fixture);
    let admitted = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    fixture
        .sqlite
        .fail_next_commit
        .store(true, Ordering::SeqCst);
    let response = fixture
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: fixture.target.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        response,
        RuntimeResponse::Teardown {
            scope: crate::TeardownScope::Account {
                account_id: fixture.target.clone()
            },
            status: crate::TeardownStatus::Incomplete,
            failures: vec![crate::TeardownPhase::Replica],
        }
    );
    let marked_catalog = fixture.platform.catalog().unwrap();
    let marker = marked_catalog
        .accounts
        .iter()
        .find(|entry| entry.account_id == fixture.target)
        .unwrap()
        .pending_retirement
        .as_ref()
        .expect("failed fanout must retain durable Remove intent");
    assert_eq!(
        marker.incarnation.as_str(),
        admitted["destinationBinding"]["incarnation"]
            .as_str()
            .unwrap()
    );
    assert_eq!(
        marker.purpose,
        crate::platform_storage::AccountRetirementPurpose::Remove
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        admitted,
        "failure before the source write changes no accepted evidence"
    );
    assert!(fixture.runtime.account_teardown_is_pending(&fixture.target));
    assert!(fixture
        .runtime
        .replica
        .load_uncached(&fixture.target)
        .await
        .unwrap()
        .is_some());
    fixture.runtime.close().await;
    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    fixture.runtime = open_move_runtime(
        fixture.sqlite.clone(),
        fixture.platform.clone(),
        fixture.http.clone(),
    )
    .await;
    let retired = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(
        retired["destinationBinding"]["status"], "retired",
        "startup must drain persisted retirement before admitting target work"
    );
    let mut expected = admitted;
    expected["destinationBinding"]["status"] = json!("retired");
    expected["destinationBinding"]["bindingRevision"] = json!("1");
    expected["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
    assert_eq!(retired, expected);
    assert_eq!(
        fixture.platform.catalog().unwrap(),
        marked_catalog,
        "startup preserves Remove until catalog deletion consumes it"
    );
    let rejected = fixture
        .runtime
        .request(
            RuntimeRequest::QuickUnlock {
                account_id: fixture.target.clone(),
                master_password: MASTER_PASSWORD.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(rejected.code, RuntimeErrorCode::AccountMissing);
    let _retry_artifacts = remove_target(&fixture).await;
    assert!(!fixture
        .platform
        .catalog()
        .unwrap()
        .accounts
        .iter()
        .any(|entry| entry.account_id == fixture.target));
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        retired,
        "retry must not increment an already retired binding"
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    fixture.runtime.close().await;
}

#[tokio::test]
async fn full_sign_in_replacement_retires_original_destination_before_authority_reuse() {
    let fixture = AdmittedMoveFixture::new().await;
    let original_target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let admitted = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    fixture.http.offline.store(false, Ordering::SeqCst);
    let response = fixture
        .runtime
        .request(
            sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(
        matches!(response, RuntimeResponse::SignedIn { account_id, .. } if account_id == fixture.target)
    );
    let replacement = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    assert_ne!(replacement.incarnation, original_target.incarnation);
    let retired = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(
        retired["destinationBinding"]["status"], "retired",
        "Full Sign-in must retire old destination bindings before publishing replacement authority"
    );
    let mut expected = admitted;
    expected["destinationBinding"]["status"] = json!("retired");
    expected["destinationBinding"]["bindingRevision"] = json!("1");
    expected["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
    assert_eq!(
        retired, expected,
        "replacement preserves all accepted source evidence"
    );
    let catalog = fixture.platform.catalog().unwrap();
    let target = catalog
        .accounts
        .iter()
        .find(|entry| entry.account_id == fixture.target)
        .unwrap();
    assert_eq!(
        target.active_incarnation.as_ref(),
        Some(&replacement.incarnation)
    );
    assert!(target.pending_install.is_none());
    assert!(target.pending_retirement.is_none());
    assert!(!fixture.runtime.account_teardown_is_pending(&fixture.target));
    let source = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert!(matches!(
        fixture
            .runtime
            .dispatch_cross_account_move(&source, &fixture.operation_id)
            .await,
        crate::runtime::dispatch::DispatchPass::Parked
    ));
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn failed_replacement_keeps_marked_rollback_through_reopen_and_verified_retry() {
    let mut fixture = AdmittedMoveFixture::new().await;
    let operations = Arc::new(Sink::default());
    let _operations_handle = fixture
        .runtime
        .observe(
            ObservationRequest::Operations {
                account_id: fixture.source.clone(),
            },
            operations.clone(),
        )
        .unwrap();
    let original_target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let admitted = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.platform.fail_at(PersistenceStep::Metadata);
    fixture
        .runtime
        .request(
            sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .expect_err("replacement metadata write must fail after retirement and staging");
    let published_retired =
        operations
            .0
            .lock()
            .unwrap()
            .last()
            .is_some_and(|projection| {
                let RuntimeProjection::Operations(projection) = projection else {
                    return false;
                };
                projection.operations.iter().any(|operation| {
                    operation.operation_id == fixture.operation_id
                && operation.cross_account_move.as_ref().is_some_and(|movement| {
                    movement.disposition
                        == crate::CrossAccountMoveDisposition::Blocked {
                            reason: crate::CrossAccountMoveBlockedReason::DestinationRetired,
                        }
                })
                })
            });
    let writable = Arc::new(Sink::default());
    let _writable_handle = fixture
        .runtime
        .observe(ObservationRequest::WritableVaultCatalog, writable.clone())
        .unwrap();
    let target_still_writable = match writable.0.lock().unwrap().last() {
        Some(RuntimeProjection::WritableVaultCatalog(catalog)) => catalog
            .vaults
            .iter()
            .any(|vault| vault.account_id == fixture.target),
        _ => panic!("expected initial writable Vault catalog"),
    };
    assert_eq!(
        (published_retired, target_still_writable),
        (true, false),
        "failed replacement must publish source retirement and stop offering the gated target"
    );
    let marked_catalog = fixture.platform.catalog().unwrap();
    let target = marked_catalog
        .accounts
        .iter()
        .find(|entry| entry.account_id == fixture.target)
        .unwrap();
    assert_eq!(
        target.active_incarnation.as_ref(),
        Some(&original_target.incarnation)
    );
    assert!(
        target.pending_install.is_none(),
        "rollback returns to the marked pre-install catalog"
    );
    let marker = target
        .pending_retirement
        .as_ref()
        .expect("rollback must preserve Replace intent");
    assert_eq!(marker.incarnation, original_target.incarnation);
    assert_eq!(
        marker.purpose,
        crate::platform_storage::AccountRetirementPurpose::Replace
    );
    assert_eq!(
        fixture
            .runtime
            .require_snapshot(&fixture.target)
            .unwrap()
            .incarnation,
        original_target.incarnation
    );
    let mut retired = admitted;
    retired["destinationBinding"]["status"] = json!("retired");
    retired["destinationBinding"]["bindingRevision"] = json!("1");
    retired["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        retired
    );
    let rejected = fixture
        .runtime
        .request(
            RuntimeRequest::QuickUnlock {
                account_id: fixture.target.clone(),
                master_password: MASTER_PASSWORD.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(rejected.code, RuntimeErrorCode::AccountMissing);
    fixture.runtime.close().await;

    fixture.sqlite = MoveSqlite::open(&fixture.database.0);
    fixture.runtime = open_move_runtime(
        fixture.sqlite.clone(),
        fixture.platform.clone(),
        fixture.http.clone(),
    )
    .await;
    assert_eq!(
        fixture.platform.catalog().unwrap(),
        marked_catalog,
        "opening must retain Replace until verified installation consumes it"
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        retired
    );
    let rejected = fixture
        .runtime
        .request(
            RuntimeRequest::QuickUnlock {
                account_id: fixture.target.clone(),
                master_password: MASTER_PASSWORD.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(rejected.code, RuntimeErrorCode::AccountMissing);
    let response = fixture
        .runtime
        .request(
            sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .expect("fresh verified Sign-in may finish a pending replacement");
    assert!(
        matches!(response, RuntimeResponse::SignedIn { account_id, .. } if account_id == fixture.target)
    );
    let replacement = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    assert_ne!(replacement.incarnation, original_target.incarnation);
    assert!(!fixture.runtime.account_teardown_is_pending(&fixture.target));
    let catalog = fixture.platform.catalog().unwrap();
    let target = catalog
        .accounts
        .iter()
        .find(|entry| entry.account_id == fixture.target)
        .unwrap();
    assert_eq!(
        target.active_incarnation.as_ref(),
        Some(&replacement.incarnation)
    );
    assert!(target.pending_retirement.is_none());
    assert!(target.pending_install.is_none());
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        retired,
        "verified retry must not reauthorize or rewrite accepted evidence"
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    fixture.runtime.close().await;
}

#[tokio::test]
async fn remove_supersedes_failed_replacement_without_rewriting_source_workflow() {
    let fixture = AdmittedMoveFixture::new().await;
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.platform.fail_at(PersistenceStep::Metadata);
    fixture
        .runtime
        .request(
            sign_in_request_to(TARGET_ORIGIN, NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .expect_err("replacement must fail after the source binding was retired");
    let marked = fixture.platform.catalog().unwrap();
    let marker = marked
        .accounts
        .iter()
        .find(|entry| entry.account_id == fixture.target)
        .unwrap()
        .pending_retirement
        .as_ref()
        .unwrap();
    assert_eq!(
        marker.purpose,
        crate::platform_storage::AccountRetirementPurpose::Replace
    );
    let retired = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(retired["destinationBinding"]["status"], "retired");
    let _artifacts = remove_target(&fixture).await;
    assert!(!fixture
        .platform
        .catalog()
        .unwrap()
        .accounts
        .iter()
        .any(|entry| entry.account_id == fixture.target));
    assert!(fixture
        .runtime
        .replica
        .load_uncached(&fixture.target)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        retired,
        "Remove must not revise an already retired binding or any accepted evidence"
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    fixture.runtime.close().await;
}
