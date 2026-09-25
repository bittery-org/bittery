//! A transient target lock is visible without retiring the accepted destination binding.
use super::*;

#[tokio::test]
async fn source_lock_drains_committed_trash_and_unlock_replays_the_original_child() {
    let fixture = AdmittedMoveFixture::new().await;
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture.http.resumed.store(true, Ordering::SeqCst);
    let runner = tokio::spawn(fixture.runtime.clone().run_operation_dispatch());
    fixture
        .http
        .trash_result
        .wait("committed source trash before delivery")
        .await;
    let before = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    let children = before["children"].as_array().unwrap();
    assert_eq!(children.len(), 2);
    assert_eq!(children[0]["result"]["result"]["type"], "applied");
    assert_eq!(children[1]["step"]["type"], "sourceTrash");
    assert!(children[1]["result"].is_null());
    let original_trash = fixture.http.mutations(SOURCE_ORIGIN)[0].clone();
    let target_effects = fixture.http.target.server.created_items();
    assert_eq!(target_effects.len(), 1);

    let lock = tokio::time::timeout(
        Duration::from_secs(3),
        fixture.runtime.request(
            RuntimeRequest::Lock {
                account_id: fixture.source.clone(),
            },
            RequestCancellation::new(),
        ),
    )
    .await;
    if lock.is_err() {
        runner.abort();
        let _ = runner.await;
        panic!("source Lock must cancel and drain the held cross-Account dispatch");
    }
    lock.unwrap().unwrap();
    assert_eq!(
        fixture.runtime.account_access_state(&fixture.source),
        Some(AccountAccessState::Locked)
    );
    assert_eq!(
        workflow(
            &durable_rows(&fixture.database.0, &fixture.source).await,
            &fixture.operation_id
        ),
        before,
        "cancelled response cannot checkpoint a proof or decide source deletion",
    );
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 1);
    assert_eq!(fixture.http.target.server.created_items(), target_effects);
    {
        let remote = fixture.http.source.server.created_items.lock().unwrap();
        assert_eq!(remote.len(), 1);
        assert_eq!(remote[0].version, 2);
        assert!(remote[0].deleted_at.is_some());
    }

    // The cancelled delivery consumed no permit. Its original result can be proved by replay
    // only after public unlock restores the source scope; the destination stays untouched.
    fixture.http.trash_result.release.add_permits(1);
    fixture
        .runtime
        .request(
            quick_unlock_request(fixture.source.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    fixture
        .http
        .delete_result
        .wait("source deletion after the original trash is proved")
        .await;
    let replayed = fixture.http.mutations(SOURCE_ORIGIN);
    assert_eq!(replayed.len(), 3);
    assert_exact_retry(&replayed[1], &original_trash);
    assert_eq!(replayed[2].header("if-match"), Some("\"2\""));
    assert_ne!(
        replayed[2].header("idempotency-key"),
        original_trash.header("idempotency-key")
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    let after = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    for field in [
        "operationId",
        "source",
        "sourceIdentity",
        "destinationIdentity",
        "destinationBinding",
        "target",
        "attachments",
    ] {
        assert_eq!(after[field], before[field]);
    }
    assert_eq!(after["children"][0], children[0]);
    let mut proved_trash = after["children"][1].clone();
    assert_eq!(
        proved_trash["result"]["result"],
        json!({"type":"applied", "entityId":SOURCE_ITEM, "version":2})
    );
    proved_trash["result"] = Value::Null;
    assert_eq!(proved_trash, children[1]);
    assert!(after["children"][2]["result"].is_null());
    fixture.http.delete_result.release.add_permits(1);
    let completed = tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&fixture.runtime, &fixture.source, &fixture.operation_id)
            != OperationResolution::Applied
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    close_move_runtime(fixture.runtime, runner).await;
    completed.expect("unlock must converge through the original accepted children");
    assert_eq!(fixture.http.mutations(SOURCE_ORIGIN).len(), 3);
    assert_eq!(fixture.http.mutations(TARGET_ORIGIN).len(), 1);
    assert_eq!(fixture.http.target.server.created_items(), target_effects);
    let final_row = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    assert_eq!(
        final_row["children"][2]["result"]["result"],
        json!({"type":"applied", "entityId":SOURCE_ITEM, "version":3})
    );
    assert_eq!(final_row["stage"]["type"], "completed");
}

#[tokio::test]
async fn target_lock_projects_move_waiting_and_unlock_keeps_the_same_active_binding() {
    async fn wait_for_move(
        sink: &Sink,
        after: usize,
        operation_id: &str,
        expected: crate::CrossAccountMoveDisposition,
    ) -> crate::OperationsProjection {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let observed = {
                    let frames = sink.0.lock().unwrap();
                    frames
                        .get(after..)
                        .and_then(|frames| frames.last())
                        .and_then(|frame| {
                            let RuntimeProjection::Operations(projection) = frame else {
                                panic!("expected Operations from the retained source observer");
                            };
                            projection
                                .operations
                                .iter()
                                .any(|operation| {
                                    operation.operation_id == operation_id
                                        && operation.cross_account_move.as_ref().is_some_and(
                                            |movement| movement.disposition == expected,
                                        )
                                })
                                .then(|| projection.clone())
                        })
                };
                if let Some(observed) = observed {
                    return observed;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("source Operations observer did not publish {expected:?}"))
    }

    let fixture = AdmittedMoveFixture::new().await;
    let before = durable_rows(&fixture.database.0, &fixture.source).await;
    let sink = Arc::new(Sink::default());
    let _observation = fixture
        .runtime
        .observe(
            ObservationRequest::Operations {
                account_id: fixture.source.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let initial = wait_for_move(
        &sink,
        0,
        &fixture.operation_id,
        crate::CrossAccountMoveDisposition::Ready,
    )
    .await;
    let before_lock = sink.0.lock().unwrap().len();
    fixture
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: fixture.target.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let operations = wait_for_move(
        &sink,
        before_lock,
        &fixture.operation_id,
        crate::CrossAccountMoveDisposition::Waiting {
            reason: crate::CrossAccountMoveWaitingReason::AccountLocked,
        },
    )
    .await;
    assert_eq!(operations.replica_revision, initial.replica_revision);
    let operation = operations
        .operations
        .iter()
        .find(|operation| operation.operation_id == fixture.operation_id)
        .unwrap();
    assert_eq!(operation.resolution, OperationResolution::Pending);
    assert!(
        operation
            .cross_account_move
            .as_ref()
            .unwrap()
            .source_visible
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        before,
        "target lock must not rewrite any source Replica row"
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    let before_unlock = sink.0.lock().unwrap().len();
    fixture.http.offline.store(false, Ordering::SeqCst);
    fixture
        .runtime
        .request(
            quick_unlock_request(fixture.target.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let operations = wait_for_move(
        &sink,
        before_unlock,
        &fixture.operation_id,
        crate::CrossAccountMoveDisposition::Ready,
    )
    .await;
    assert_eq!(operations.replica_revision, initial.replica_revision);
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        before,
        "target unlock must not rewrite any source Replica row"
    );
    for frame in sink.0.lock().unwrap().iter() {
        let RuntimeProjection::Operations(projection) = frame else {
            panic!("expected only Operations from the retained source observer");
        };
        assert_eq!(projection.account_id, fixture.source);
        assert_eq!(projection.replica_revision, initial.replica_revision);
    }
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    fixture.runtime.close().await;
}

#[tokio::test]
async fn older_captured_operations_cannot_replace_newer_target_lock_availability() {
    let fixture = AdmittedMoveFixture::new().await;
    let before = durable_rows(&fixture.database.0, &fixture.source).await;
    let request = ObservationRequest::Operations {
        account_id: fixture.source.clone(),
    };
    let sink = Arc::new(Sink::default());
    let observation = fixture
        .runtime
        .observe(request.clone(), sink.clone())
        .unwrap();

    // Hold a real projection at the existing capture-before-queue boundary. Its source
    // revision will remain current even after a newer destination availability is published.
    let captured = fixture.runtime.projection(&request).unwrap();
    let original_revision = match &captured.projection {
        RuntimeProjection::Operations(projection) => {
            let operation = projection
                .operations
                .iter()
                .find(|operation| operation.operation_id == fixture.operation_id)
                .unwrap();
            assert_eq!(
                operation.cross_account_move.as_ref().unwrap().disposition,
                crate::CrossAccountMoveDisposition::Ready
            );
            projection.replica_revision
        }
        _ => panic!("expected captured source Operations"),
    };
    fixture
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: fixture.target.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let publications_after_lock = {
        let frames = sink.0.lock().unwrap();
        let RuntimeProjection::Operations(projection) = frames.last().unwrap() else {
            panic!("expected source Operations after target Lock");
        };
        let operation = projection
            .operations
            .iter()
            .find(|operation| operation.operation_id == fixture.operation_id)
            .unwrap();
        assert_eq!(
            operation.cross_account_move.as_ref().unwrap().disposition,
            crate::CrossAccountMoveDisposition::Waiting {
                reason: crate::CrossAccountMoveWaitingReason::AccountLocked,
            }
        );
        assert_eq!(projection.replica_revision, original_revision);
        frames.len()
    };

    observation.subscription.publish(captured);
    assert_eq!(
        sink.0.lock().unwrap().len(),
        publications_after_lock,
        "the older Ready capture must not publish after target Lock's Waiting frame"
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        before,
        "delivery ordering must not rewrite any accepted source row"
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    fixture.runtime.close().await;
}

#[tokio::test]
async fn refused_older_operations_frame_cannot_forget_newer_target_availability() {
    let fixture = AdmittedMoveFixture::new().await;
    let before = durable_rows(&fixture.database.0, &fixture.source).await;
    let request = ObservationRequest::Operations {
        account_id: fixture.source.clone(),
    };
    let sink = Arc::new(Sink::default());
    let _observation = fixture.runtime.observe(request, sink.clone()).unwrap();
    let (initial_count, original_revision) = {
        let frames = sink.0.lock().unwrap();
        let RuntimeProjection::Operations(projection) = frames.last().unwrap() else {
            panic!("expected initial source Operations");
        };
        let movement = projection
            .operations
            .iter()
            .find(|operation| operation.operation_id == fixture.operation_id)
            .unwrap()
            .cross_account_move
            .as_ref()
            .unwrap();
        assert_eq!(
            movement.disposition,
            crate::CrossAccountMoveDisposition::Ready
        );
        (frames.len(), projection.replica_revision)
    };
    let source = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let movement = source
        .cross_account_moves
        .iter()
        .filter_map(|entry| entry.captured())
        .find(|movement| movement.operation_id == fixture.operation_id)
        .unwrap();
    let registration = fixture
        .runtime
        .foreground_attachments
        .register_target(
            &fixture.target,
            &target.incarnation,
            crate::runtime::foreground_attachment_lifecycle::ForegroundAttachmentTarget::Item {
                vault_id: movement.target.vault_id.clone(),
                item_id: movement.target.id.clone(),
            },
            RequestCancellation::new(),
        )
        .unwrap();
    let publication = fixture
        .runtime
        .foreground_attachments
        .publication(&registration);
    // Only the copied publication remains: target Lock must fence it without waiting for
    // an invented live Attachment request. The existing decryption owner prepares real frames.
    drop(registration);
    let prepared = fixture
        .runtime
        .decrypt_visible_items_for_foreground_attachment(&fixture.target)
        .unwrap()
        .expect("unlocked target prepares its foreground publication");
    let reached = Arc::new(tokio::sync::Notify::new());
    let (release, held) = std::sync::mpsc::sync_channel(1);
    let held = Mutex::new(held);
    fixture
        .runtime
        .foreground_attachments
        .set_before_publication_admission_hook(Some(Arc::new({
            let reached = reached.clone();
            move || {
                reached.notify_one();
                held.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(15))
                    .expect("held Operations publication must be released");
            }
        })));
    let publishing = std::thread::spawn(move || prepared.publish(publication));
    tokio::time::timeout(Duration::from_secs(5), reached.notified())
        .await
        .expect("old Ready frame must reach foreground admission");
    tokio::time::timeout(
        Duration::from_secs(5),
        fixture.runtime.request(
            RuntimeRequest::Lock {
                account_id: fixture.target.clone(),
            },
            RequestCancellation::new(),
        ),
    )
    .await
    .expect("target Lock must finish while copied publication is held")
    .unwrap();
    assert_eq!(
        sink.0.lock().unwrap().len(),
        initial_count,
        "new target availability queues behind the held old frame"
    );
    release.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !publishing.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("refused frame and newer queued availability must finish delivery");
    publishing.join().unwrap();
    fixture
        .runtime
        .foreground_attachments
        .set_before_publication_admission_hook(None);
    let delivered = {
        let frames = sink.0.lock().unwrap();
        assert!(frames.len() > initial_count);
        for frame in &frames[initial_count..] {
            let RuntimeProjection::Operations(projection) = frame else {
                panic!("expected source Operations after target Lock");
            };
            assert_eq!(projection.replica_revision, original_revision);
            let movement = projection
                .operations
                .iter()
                .find(|operation| operation.operation_id == fixture.operation_id)
                .unwrap()
                .cross_account_move
                .as_ref()
                .unwrap();
            assert_eq!(
                movement.disposition,
                crate::CrossAccountMoveDisposition::Waiting {
                    reason: crate::CrossAccountMoveWaitingReason::AccountLocked,
                },
                "the fenced old Ready frame must never reach the sink"
            );
        }
        frames.len()
    };

    fixture.runtime.publish_all();
    assert_eq!(
        sink.0.lock().unwrap().len(),
        delivered,
        "refusing the older frame must not forget the newer delivery identity"
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        before
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    fixture.runtime.close().await;
}

#[tokio::test]
async fn failed_target_retirement_marker_projects_unavailable_without_rewriting_source_work() {
    let fixture = AdmittedMoveFixture::new().await;
    let source_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let target_rows = durable_rows(&fixture.database.0, &fixture.target).await;
    let catalog = fixture.platform.catalog().unwrap();
    let admitted = workflow(&source_rows, &fixture.operation_id);
    let observed = Arc::new(Sink::default());
    let request = ObservationRequest::Operations {
        account_id: fixture.source.clone(),
    };
    let _handle = fixture
        .runtime
        .observe(request.clone(), observed.clone())
        .unwrap();
    let source_revision = match observed.0.lock().unwrap().last().unwrap() {
        RuntimeProjection::Operations(projection) => projection.replica_revision,
        _ => panic!("expected source Operations"),
    };

    // A catalog without pending installation uses this existing fixture write class. Remove's
    // first such write is its retirement marker; fail it before storage changes or host cleanup.
    fixture.platform.fail_at(PersistenceStep::PromotedCatalog);
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
            failures: vec![crate::TeardownPhase::PlatformStorage],
        }
    );
    assert_eq!(fixture.platform.catalog().unwrap(), catalog);
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.source).await,
        source_rows
    );
    assert_eq!(
        durable_rows(&fixture.database.0, &fixture.target).await,
        target_rows
    );
    let expected = crate::CrossAccountMoveDisposition::Waiting {
        reason: crate::CrossAccountMoveWaitingReason::AccessUnavailable,
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let delivered = observed.0.lock().unwrap().last().is_some_and(|frame| {
                let RuntimeProjection::Operations(projection) = frame else {
                    return false;
                };
                projection.operations.iter().any(|operation| {
                    operation.operation_id == fixture.operation_id
                        && operation
                            .cross_account_move
                            .as_ref()
                            .is_some_and(|movement| movement.disposition == expected)
                })
            });
            if delivered {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("a failed marker write must publish the retained target retirement gate");
    let fresh = Arc::new(Sink::default());
    let _fresh_handle = fixture.runtime.observe(request, fresh.clone()).unwrap();
    {
        let frames = fresh.0.lock().unwrap();
        let RuntimeProjection::Operations(projection) = frames.last().unwrap() else {
            panic!("expected fresh source Operations");
        };
        assert_eq!(projection.replica_revision, source_revision);
        let movement = projection
            .operations
            .iter()
            .find(|operation| operation.operation_id == fixture.operation_id)
            .unwrap()
            .cross_account_move
            .as_ref()
            .unwrap();
        assert_eq!(movement.disposition, expected);
        assert!(movement.source_visible);
    }
    for frame in observed.0.lock().unwrap().iter() {
        let RuntimeProjection::Operations(projection) = frame else {
            panic!("expected source Operations");
        };
        assert_eq!(projection.replica_revision, source_revision);
    }
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());

    let _artifacts = super::retirement_tests::remove_target(&fixture).await;
    let retired = workflow(
        &durable_rows(&fixture.database.0, &fixture.source).await,
        &fixture.operation_id,
    );
    let mut expected_retired = admitted;
    expected_retired["destinationBinding"]["status"] = json!("retired");
    expected_retired["destinationBinding"]["bindingRevision"] = json!("1");
    expected_retired["disposition"] = json!({"type":"blocked", "reason":"destinationRetired"});
    assert_eq!(
        retired, expected_retired,
        "retry retires only the original binding"
    );
    assert_source_visible(
        &fixture.runtime,
        &fixture.source,
        crate::ItemProjectionStatus::Pending,
    );
    fixture.runtime.close().await;
}

#[tokio::test]
async fn incoming_destination_read_only_projects_unavailability_without_changing_source_work() {
    let mut http = MoveHttp::new();
    Arc::get_mut(&mut http)
        .unwrap()
        .target
        .use_shared_member(&TARGET_KEY);
    let fixture = AdmittedMoveFixture::with_http(http).await;
    let original_rows = durable_rows(&fixture.database.0, &fixture.source).await;
    let observed = Arc::new(Sink::default());
    let request = ObservationRequest::Operations {
        account_id: fixture.source.clone(),
    };
    let _handle = fixture
        .runtime
        .observe(request.clone(), observed.clone())
        .unwrap();
    let original_revision = match observed.0.lock().unwrap().last().unwrap() {
        RuntimeProjection::Operations(projection) => projection.replica_revision,
        _ => panic!("expected source Operations"),
    };
    let original_target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let target_items = Arc::new(Sink::default());
    let _target_observer = fixture
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: fixture.target.clone(),
            },
            target_items.clone(),
        )
        .unwrap();

    for (role, stored_role, public_role, cursor, expected) in [
        (
            crate::server_contract::VaultRole::ReadOnly,
            "readOnly",
            crate::VaultProjectionRole::ReadOnly,
            "move-target-read-only",
            json!({"type":"waiting", "reason":"accessUnavailable"}),
        ),
        (
            crate::server_contract::VaultRole::Member,
            "member",
            crate::VaultProjectionRole::Member,
            "move-target-member-restored",
            json!({"type":"ready"}),
        ),
    ] {
        fixture.http.target.set_vault_role(role);
        *fixture.http.target.server.sync_cursor.lock().unwrap() = Some(cursor.into());
        fixture.http.target.server.script_sync_page(
            vec![json!({
                "id":cursor, "type":"vault_updated", "entityType":"vault",
                "entityId":"vault-1", "userId":"user-1", "vaultId":"vault-1",
                "clientId":null, "metadata":null, "timestamp":"1700000000000", "version":1
            })],
            cursor,
            false,
        );
        fixture.http.offline.store(false, Ordering::SeqCst);
        let syncing = tokio::spawn(fixture.runtime.clone().run_live_sync());
        let ready = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let rows = durable_rows(&fixture.database.0, &fixture.target).await;
                let has_role = rows.iter().any(|row| {
                    row["store"] == "authorityVaults"
                        && serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap())
                            .unwrap()["role"]
                            == stored_role
                });
                let ready_at_cursor = rows.iter().any(|row| {
                    if row["store"] != "replicaMetadata" || row["key"]["recordId"] != "bootstrap" {
                        return false;
                    }
                    let metadata: Value =
                        serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap();
                    metadata["state"] == "ready" && metadata["activeCursor"]["id"] == cursor
                });
                let published_role = target_items.0.lock().unwrap().last().is_some_and(|frame| {
                    let RuntimeProjection::Items(items) = frame else {
                        return false;
                    };
                    items
                        .vaults
                        .iter()
                        .any(|vault| vault.vault_id == "vault-1" && vault.role == public_role)
                });
                let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
                let cached_ready = target.bootstrap.state == crate::replica::ReplicaState::Ready
                    && target.bootstrap.active_cursor
                        == crate::replica::SyncCursor::CapturedValue { id: cursor.into() };
                if has_role && ready_at_cursor && published_role && cached_ready {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        if ready.is_err() {
            syncing.abort();
            let _ = syncing.await;
            panic!("public Sync must install and publish the current destination role and cursor");
        }

        let fresh = Arc::new(Sink::default());
        let _fresh_handle = fixture
            .runtime
            .observe(request.clone(), fresh.clone())
            .unwrap();
        let projection = {
            let frames = fresh.0.lock().unwrap();
            let RuntimeProjection::Operations(projection) = frames.last().unwrap() else {
                panic!("expected source Operations");
            };
            projection.clone()
        };
        let delivery = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let delivered = observed.0.lock().unwrap().last().is_some_and(|frame| {
                    let RuntimeProjection::Operations(projection) = frame else {
                        return false;
                    };
                    projection.operations.iter().any(|operation| {
                        operation.operation_id == fixture.operation_id
                            && operation
                                .cross_account_move
                                .as_ref()
                                .is_some_and(|movement| {
                                    serde_json::to_value(&movement.disposition).unwrap() == expected
                                })
                    })
                });
                if delivered {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        syncing.abort();
        let _ = syncing.await;
        fixture.http.offline.store(true, Ordering::SeqCst);
        assert_eq!(projection.replica_revision, original_revision);
        let movement = projection
            .operations
            .iter()
            .find(|operation| operation.operation_id == fixture.operation_id)
            .unwrap()
            .cross_account_move
            .as_ref()
            .unwrap();
        assert!(movement.source_visible);
        assert_eq!(
            serde_json::to_value(&movement.disposition).unwrap(),
            expected
        );
        delivery.expect("the original subscriber must receive destination-only role changes");
        for frame in observed.0.lock().unwrap().iter() {
            let RuntimeProjection::Operations(projection) = frame else {
                panic!("expected source Operations");
            };
            assert_eq!(projection.replica_revision, original_revision);
        }
        assert_eq!(
            durable_rows(&fixture.database.0, &fixture.source).await,
            original_rows
        );
        let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
        assert_eq!(target.incarnation, original_target.incarnation);
        assert_eq!(target.lock_epoch, original_target.lock_epoch);
        assert_source_visible(
            &fixture.runtime,
            &fixture.source,
            crate::ItemProjectionStatus::Pending,
        );
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
    }
    fixture.runtime.close().await;
}
