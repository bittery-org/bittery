//! Public fixed Export observation; host retains zero-Attachment plaintext until cleanup ACK.
use super::*;

#[tokio::test]
async fn private_export_partial_read_wipes_earlier_decrypted_item() {
    use crate::ItemDraft;

    let setup = setup().await;
    let RuntimeProjection::Items(mut selected) = setup
        .runtime
        .projection(&ObservationRequest::Items {
            account_id: setup.account.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("fixture must expose the authoritative Item");
    };
    assert_eq!(selected.items.len(), 1);
    assert_eq!(selected.items[0].item_id, "item-existing");
    let mut missing = selected.items[0].clone();
    missing.item_id = "selected-row-not-in-replica".into();
    selected.items.push(missing);

    // This selected frame is seam fault injection: the normal projection owner cannot produce
    // a missing second row, but a failed private read must still retire its first plaintext.
    let wiped = Arc::new(AtomicBool::new(false));
    crate::runtime::vault_export::set_private_read_wipe_audit(Some(Box::new({
        let wiped = wiped.clone();
        move |items| {
            assert_eq!(items.len(), 1);
            let ItemDraft::Login(login) = &items[0].data else {
                panic!("fixture must decrypt a Login");
            };
            assert!(login.title.is_empty());
            assert!(login.password.is_none());
            wiped.store(true, Ordering::SeqCst);
        }
    })));
    {
        let _native = setup.runtime.native_observation_guard();
        let _publication = setup.runtime.publication.lock().unwrap();
        let snapshot = setup.runtime.require_snapshot(&setup.account).unwrap();
        assert!(setup
            .runtime
            .private_vault_export_items(&snapshot, &selected)
            .is_err());
    }
    crate::runtime::vault_export::set_private_read_wipe_audit(None);
    assert!(wiped.load(Ordering::SeqCst));
    setup.runtime.close().await;
}

struct ExportSink {
    snapshots: Mutex<Vec<RuntimeProjection>>,
    controls: Mutex<Vec<crate::ObservationControl>>,
    retired: Semaphore,
}
impl Default for ExportSink {
    fn default() -> Self {
        Self {
            snapshots: Mutex::new(Vec::new()),
            controls: Mutex::new(Vec::new()),
            retired: Semaphore::new(0),
        }
    }
}
impl crate::ObservationSink for ExportSink {
    fn publish(&self, value: RuntimeProjection) {
        self.snapshots.lock().unwrap().push(value);
    }
    fn control(&self, value: crate::ObservationControl) {
        self.controls.lock().unwrap().push(value);
        self.retired.add_permits(1);
    }
}

#[tokio::test]
async fn export_retirement_notifies_before_waiting_for_zero_attachment_host_cleanup() {
    let setup = setup().await;
    let sink = Arc::new(ExportSink::default());
    let handle = setup
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: setup.account.clone(),
                vault_ids: vec![TEST_VAULT_ID.into()],
            },
            sink.clone(),
        )
        .expect("Export must capture its fixed current Vault scope before plaintext delivery");
    {
        let frames = sink.snapshots.lock().unwrap();
        let [RuntimeProjection::VaultExport(snapshot)] = frames.as_slice() else {
            panic!("Export must deliver exactly one fixed snapshot");
        };
        assert_eq!(snapshot.account_id, setup.account);
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].item_id, "item-existing");
        assert!(snapshot.items[0].attachments.is_empty());
        assert_eq!(snapshot.vaults.len(), 1);
    }
    *setup.server.policy_read.lock().unwrap() = Some(Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                    "enabled": true, "hiddenVaultIds": [TEST_VAULT_ID],
                    "enabledAt": "2023-11-14T22:13:20Z",
                    "updatedAt": "2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    }));
    let runtime = setup.runtime.clone();
    let account = setup.account.clone();
    let mut refresh = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::RefreshTravelMode {
                    account_id: account,
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::select! {
        () = permit(&sink.retired) => {},
        result = &mut refresh => panic!("retirement completed before Export cleanup ACK: {result:?}"),
    }
    assert_eq!(
        *sink.controls.lock().unwrap(),
        vec![crate::ObservationControl::VaultExportRetired {
            reason: crate::VaultExportRetirementReason::ScopeRetired,
        }]
    );
    assert!(
        !refresh.is_finished(),
        "the captured host plaintext still owns a foreground loan"
    );
    assert!(
        handle.begin_vault_export_output().is_err(),
        "retired Export cannot acquire final output"
    );
    let unaffected = Arc::new(ItemsSink::default());
    let _other = setup
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: setup.account.clone(),
            },
            unaffected.clone(),
        )
        .unwrap();
    assert!(unaffected.0.lock().unwrap().iter().any(|projection| matches!(projection,
        RuntimeProjection::Items(items) if items.vaults.iter().any(|vault| vault.vault_id == "vault-2"))));
    // Real host ACK follows disposal of the frozen snapshot, ZIP builder and ready output.
    sink.snapshots.lock().unwrap().clear();
    handle.close();
    refresh.await.unwrap().unwrap();
    assert_eq!(sink.controls.lock().unwrap().len(), 1);
    assert!(handle.begin_vault_export_output().is_err());
    setup.runtime.close().await;
}
#[tokio::test]
async fn admitted_export_output_holds_retirement_until_its_exact_finish() {
    let setup = setup().await;
    let sink = Arc::new(ExportSink::default());
    let handle = setup
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: setup.account.clone(),
                vault_ids: vec![TEST_VAULT_ID.into()],
            },
            sink.clone(),
        )
        .unwrap();
    let lease = handle
        .begin_vault_export_output()
        .expect("current Export must admit one final output on the same observation");
    assert!(
        handle.begin_vault_export_output().is_err(),
        "output admission is single-use"
    );
    let runtime = setup.runtime.clone();
    let account_id = setup.account.clone();
    let mut locking = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::Lock { account_id },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::select! {
        () = permit(&sink.retired) => {},
        result = &mut locking => panic!("Lock passed an admitted output: {result:?}"),
    }
    // The host still owns the admitted output. Its cleanup ACK cannot precede that work;
    // exact Finish releases the finalization loan and closes this observation.
    sink.snapshots.lock().unwrap().clear();
    assert!(!locking.is_finished());
    assert!(handle.finish_vault_export_output("stale-lease").is_err());
    assert!(
        !locking.is_finished(),
        "a stale finish cannot release this output"
    );
    handle.finish_vault_export_output(&lease).unwrap();
    locking.await.unwrap().unwrap();
    assert!(handle.finish_vault_export_output(&lease).is_err());
    assert_eq!(sink.controls.lock().unwrap().len(), 1);
    setup.runtime.close().await;
}
#[cfg(not(target_arch = "wasm32"))]
#[tokio::test]
async fn concurrent_item_publication_cannot_replace_the_captured_export_snapshot() {
    use crate::ItemDraft;
    let setup = setup().await;
    let sink = Arc::new(ExportSink::default());
    let entered = Arc::new(Semaphore::new(0));
    let released = Arc::new(AtomicBool::new(false));
    struct ReleaseOnDrop(Arc<AtomicBool>);
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let _release_on_failure = ReleaseOnDrop(released.clone());
    let once = Arc::new(AtomicBool::new(false));
    setup
        .runtime
        .foreground_attachments
        .set_before_publication_admission_hook(Some(Arc::new({
            let entered = entered.clone();
            let released = released.clone();
            move || {
                if !once.swap(true, Ordering::SeqCst) {
                    entered.add_permits(1);
                    while !released.load(Ordering::SeqCst) {
                        std::thread::yield_now();
                    }
                }
            }
        })));
    let observing = std::thread::spawn({
        let runtime = setup.runtime.clone();
        let account_id = setup.account.clone();
        let sink = sink.clone();
        move || {
            runtime
                .observe(
                    ObservationRequest::VaultExport {
                        account_id,
                        vault_ids: vec![TEST_VAULT_ID.into()],
                    },
                    sink,
                )
                .unwrap()
        }
    });
    permit(&entered).await;
    let ItemDraft::Login(mut changed) = draft() else {
        unreachable!()
    };
    changed.title = "Edited after Export captured Bank".into();
    changed.password = Some("new-secret-after-export".into());
    setup
        .runtime
        .request(
            RuntimeRequest::UpdateItem {
                guard: crate::ItemEditGuard::test_fixture(setup.account.clone(), "item-existing"),
                account_id: setup.account.clone(),
                item_id: "item-existing".into(),
                draft: ItemDraft::Login(changed),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    released.store(true, Ordering::SeqCst);
    let handle = observing.join().unwrap();
    {
        let frames = sink.snapshots.lock().unwrap();
        let [RuntimeProjection::VaultExport(snapshot)] = frames.as_slice() else {
            panic!("Export must deliver exactly one captured snapshot");
        };
        let ItemDraft::Login(original) = &snapshot.items[0].data else {
            unreachable!()
        };
        assert_eq!(original.title, "Bank");
        assert_eq!(original.password.as_deref(), Some("secret"));
    }
    handle.close();
    setup.runtime.close().await;
}
#[cfg(not(target_arch = "wasm32"))]
#[tokio::test]
async fn paused_export_resumes_its_original_frame_after_policy_verification() {
    for hide_unrelated_vault in [false, true] {
        let setup = setup().await;
        let runner = tokio::spawn(setup.runtime.clone().run_live_sync());
        permit(&setup.server.changes).await;
        until(|| setup.server.stream_reads.load(Ordering::SeqCst) == 1).await;
        let sink = Arc::new(ExportSink::default());
        let entered = Arc::new(Semaphore::new(0));
        let released = Arc::new(AtomicBool::new(false));
        struct ReleaseOnDrop(Arc<AtomicBool>);
        impl Drop for ReleaseOnDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let _release_on_failure = ReleaseOnDrop(released.clone());
        let once = AtomicBool::new(false);
        setup
            .runtime
            .foreground_attachments
            .set_before_publication_admission_hook(Some(Arc::new({
                let entered = entered.clone();
                let released = released.clone();
                move || {
                    if !once.swap(true, Ordering::SeqCst) {
                        entered.add_permits(1);
                        while !released.load(Ordering::SeqCst) {
                            std::thread::yield_now();
                        }
                    }
                }
            })));
        let observing = std::thread::spawn({
            let runtime = setup.runtime.clone();
            let account_id = setup.account.clone();
            let sink = sink.clone();
            move || {
                runtime
                    .observe(
                        ObservationRequest::VaultExport {
                            account_id,
                            vault_ids: vec![TEST_VAULT_ID.into()],
                        },
                        sink,
                    )
                    .unwrap()
            }
        });
        permit(&entered).await;
        let hidden = if hide_unrelated_vault {
            vec!["vault-2"]
        } else {
            vec![]
        };
        let gate = Arc::new(PolicyReadGate {
            entered: Semaphore::new(0), release: Semaphore::new(0),
            response: completed(200, serde_json::to_vec(&json!({
                "enabled": hide_unrelated_vault, "hiddenVaultIds": hidden,
                "enabledAt": if hide_unrelated_vault { Some("2023-11-14T22:13:20Z") } else { None },
                "updatedAt": "2023-11-14T22:13:20Z"
            })).unwrap()),
        });
        *setup.server.policy_read.lock().unwrap() = Some(gate.clone());
        let authority = setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .bootstrap
            .snapshot();
        setup.server.bootstrap_pages.lock().unwrap().extend([
            json!({"phase":"vaults","vaults":authority.visible_vaults,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"export-policy"}}),
            json!({"phase":"items","items":authority.visible_items,"hasMore":false,"nextCursor":null,"syncCursor":{"id":"export-policy"}}),
        ]);
        setup.server.finite.script_sync_page(
            vec![json!({
                "id":"export-policy","type":"travel_mode_updated","entityType":"user",
                "entityId":USER,"userId":USER,"vaultId":null,"clientId":null,
                "metadata":{"enabled":hide_unrelated_vault,"hiddenVaultIds":hidden},
                "timestamp":"1700000000001","version":1
            })],
            "export-policy",
            false,
        );
        setup.server.hint(b"event: sync\ndata: {}\n\n");
        permit(&gate.entered).await;
        released.store(true, Ordering::SeqCst);
        let handle = observing.join().unwrap();
        assert!(
            sink.snapshots.lock().unwrap().is_empty(),
            "pending verification pauses captured plaintext"
        );
        assert!(
            handle.begin_vault_export_output().is_err(),
            "capture alone does not admit output before snapshot delivery"
        );
        // Incoming verification and the post-Bootstrap-watermark verification must both
        // observe this same current policy before cursor promotion.
        gate.release.add_permits(2);
        until(|| {
            cursor(&setup)
                == SyncCursor::CapturedValue {
                    id: "export-policy".into(),
                }
        })
        .await;
        {
            let frames = sink.snapshots.lock().unwrap();
            let [RuntimeProjection::VaultExport(snapshot)] = frames.as_slice() else {
                panic!(
                    "the original paused frame must resume exactly once; unrelated hide={hide_unrelated_vault}"
                );
            };
            let crate::ItemDraft::Login(original) = &snapshot.items[0].data else {
                unreachable!()
            };
            assert_eq!(original.title, "Bank");
            assert_eq!(original.password.as_deref(), Some("secret"));
            assert_eq!(snapshot.vaults.len(), 1);
            assert_eq!(snapshot.vaults[0].vault_id, TEST_VAULT_ID);
        }
        assert!(
            sink.controls.lock().unwrap().is_empty(),
            "unrelated Vault retirement cannot retire this exact Export scope"
        );
        let lease = handle.begin_vault_export_output().unwrap();
        sink.snapshots.lock().unwrap().clear();
        handle.finish_vault_export_output(&lease).unwrap();
        setup.runtime.close().await;
        runner.await.unwrap();
    }
}
#[cfg(not(target_arch = "wasm32"))]
#[tokio::test]
async fn export_of_pending_move_retires_with_its_exact_source_vault() {
    let setup = setup().await;
    // Even a zero-Attachment Move retains its exact Operation artifact-cleanup scope.
    // Supply the actual SQLite primitive so retirement can prove that scope has no artifacts.
    *setup.runtime.attachment_move_lifecycle.lock().unwrap() =
        Some(Arc::new(AttachmentMoveLifecycle::new(
            Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
            Arc::new(
                crate::attachment_artifact_store::SqliteAttachmentArtifactStore::open(":memory:")
                    .unwrap(),
            ),
        )));
    setup
        .runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: setup.account.clone(),
                item_id: "item-existing".into(),
                target_vault_id: "vault-2".into(),
                target_account_id: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let original_operations = setup
        .runtime
        .replica
        .snapshot(&setup.account)
        .unwrap()
        .operations;
    let sink = Arc::new(ExportSink::default());
    let handle = setup
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: setup.account.clone(),
                vault_ids: vec!["vault-2".into()],
            },
            sink.clone(),
        )
        .unwrap();
    {
        let frames = sink.snapshots.lock().unwrap();
        let [RuntimeProjection::VaultExport(snapshot)] = frames.as_slice() else {
            panic!("fixed Export snapshot");
        };
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].vault_id, "vault-2");
        assert_eq!(snapshot.items[0].status, ItemProjectionStatus::Pending);
    }
    *setup.server.policy_read.lock().unwrap() = Some(Arc::new(PolicyReadGate {
        entered: Semaphore::new(0),
        release: Semaphore::new(1),
        response: completed(
            200,
            serde_json::to_vec(&json!({
                "enabled":true,"hiddenVaultIds":[TEST_VAULT_ID],
                "enabledAt":"2023-11-14T22:13:20Z", "updatedAt":"2023-11-14T22:13:20Z"
            }))
            .unwrap(),
        ),
    }));
    let mut refresh = tokio::spawn({
        let runtime = setup.runtime.clone();
        let account_id = setup.account.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::RefreshTravelMode { account_id },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    tokio::select! {
        () = permit(&sink.retired) => {},
        result = &mut refresh => panic!("source retirement passed Export of its pending Move payload: {result:?}"),
    }
    assert!(handle.begin_vault_export_output().is_err());
    assert!(!refresh.is_finished());
    sink.snapshots.lock().unwrap().clear();
    handle.close();
    refresh.await.unwrap().unwrap();
    assert_eq!(
        setup
            .runtime
            .replica
            .snapshot(&setup.account)
            .unwrap()
            .operations,
        original_operations,
        "retirement preserves exact accepted Move evidence"
    );
    setup.runtime.close().await;
}
#[tokio::test]
async fn export_receives_lock_retirement_before_unrelated_account_execution_releases() {
    let setup = setup().await;
    let sink = Arc::new(ExportSink::default());
    let handle = setup
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: setup.account.clone(),
                vault_ids: vec![TEST_VAULT_ID.into()],
            },
            sink.clone(),
        )
        .unwrap();
    let execution = setup
        .runtime
        .account_execution_lock(&setup.account)
        .unwrap()
        .lock_owned()
        .await;
    let mut locking = Box::pin(setup.runtime.request(
        RuntimeRequest::Lock {
            account_id: setup.account.clone(),
        },
        RequestCancellation::new(),
    ));
    std::future::poll_fn(|context| {
        assert!(
            std::future::Future::poll(locking.as_mut(), context).is_pending(),
            "held Account execution must prevent Lock completion"
        );
        std::task::Poll::Ready(())
    })
    .await;
    let controls_before_execution_release = sink.controls.lock().unwrap().clone();
    // A truthful host cleanup ACK can complete independently of the unrelated execution owner.
    sink.snapshots.lock().unwrap().clear();
    handle.close();
    drop(execution);
    locking.await.unwrap();
    setup.runtime.close().await;
    assert_eq!(
        controls_before_execution_release,
        vec![crate::ObservationControl::VaultExportRetired {
            reason: crate::VaultExportRetirementReason::ScopeRetired,
        }],
        "first-fence retirement notification must not wait behind Account execution"
    );
}
