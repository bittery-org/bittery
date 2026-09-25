use super::super::operation_fixtures::*;
use super::*;
use crate::replica::{GuardedCommitPlan, PlanMutation, PlanResult};
use crate::{
    test_fixtures::{personal_vault, TEST_VAULT_ID},
    Incarnation,
};

async fn retire(runtime: &Runtime, account: &AccountId, vault: &str) {
    let snapshot = runtime.replica.snapshot(account).unwrap();
    assert!(matches!(
        runtime
            .replica
            .execute_exact(GuardedCommitPlan::new(
                account.clone(),
                snapshot.incarnation,
                snapshot.revision,
                snapshot.lock_epoch,
                vec![PlanMutation::RetireVaults {
                    vault_ids: vec![vault.into()]
                }],
            ))
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));
    runtime.wake_dispatch();
}

#[tokio::test]
async fn later_account_retirement_progresses_while_another_execution_fence_is_held() {
    let harness = seeded(true).await;
    let first = harness.account_id.clone();
    let second = AccountId::from("second-retirement-account");
    harness
        .replica
        .state
        .install(
            second.clone(),
            "second-user".into(),
            Incarnation::from(INCARNATION),
        )
        .unwrap();
    harness
        .replica
        .state
        .seed_ready_authority(
            &second,
            vec![personal_vault("second-vault", "second-user")],
            vec![],
        )
        .unwrap();
    harness.runtime.replica.load(&second).await.unwrap();
    retire(&harness.runtime, &first, TEST_VAULT_ID).await;
    let execution = harness.runtime.account_execution_lock(&first).unwrap();
    let held = execution.lock().await;
    let runtime = harness.runtime.clone();
    let driver = tokio::spawn(async move { runtime.run_dispatch_loop().await });
    // Let the surviving driver begin the first Account's blocked attempt before admitting B.
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    retire(&harness.runtime, &second, "second-vault").await;
    let completed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !harness
            .runtime
            .replica
            .snapshot(&second)
            .unwrap()
            .bootstrap
            .pending_vault_retirements
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(!harness
        .runtime
        .replica
        .snapshot(&first)
        .unwrap()
        .bootstrap
        .pending_vault_retirements
        .is_empty());
    drop(held);
    driver.abort();
    let _ = driver.await;
    harness.runtime.close().await;
    assert!(
        completed.is_ok(),
        "Account A's held execution prevented later Account B retirement"
    );
}

struct HeldItemHttp {
    server: Arc<FakeServer>,
    reached: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
    first: std::sync::atomic::AtomicBool,
    dropped: Arc<std::sync::atomic::AtomicBool>,
}
struct HeldHttpLifetime {
    dropped: Arc<std::sync::atomic::AtomicBool>,
    completed: bool,
}
impl Drop for HeldHttpLifetime {
    fn drop(&mut self) {
        if !self.completed {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }
}
#[async_trait]
impl SerializedHttpExecutor for HeldItemHttp {
    async fn invoke(&self, text: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: serde_json::Value = serde_json::from_str(&text).unwrap();
        if request["method"] == "PUT" && self.first.swap(false, Ordering::SeqCst) {
            let mut lifetime = HeldHttpLifetime {
                dropped: self.dropped.clone(),
                completed: false,
            };
            self.reached.add_permits(1);
            self.release.acquire().await.unwrap().forget();
            let response = self.server.invoke(text).await;
            lifetime.completed = true;
            response
        } else {
            self.server.invoke(text).await
        }
    }
    fn cancel(&self, id: &str) {
        self.server.cancel(id);
    }
}

#[tokio::test]
async fn retirement_wakes_preserve_an_ordinary_http_dispatch_already_in_flight() {
    let mut harness = seeded(true).await;
    harness.runtime.close().await;
    let http = Arc::new(HeldItemHttp {
        server: harness.server.clone(),
        reached: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
        first: std::sync::atomic::AtomicBool::new(true),
        dropped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    });
    harness.runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        http.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    harness
        .runtime
        .replica
        .load(&harness.account_id)
        .await
        .unwrap();
    harness
        .runtime
        .unlock_account(&harness.account_id)
        .await
        .unwrap();
    let second = AccountId::from("later-cleanup-account");
    harness
        .replica
        .state
        .install(
            second.clone(),
            "other-user".into(),
            Incarnation::from(INCARNATION),
        )
        .unwrap();
    harness
        .replica
        .state
        .seed_ready_authority(
            &second,
            vec![personal_vault("cleanup-vault", "other-user")],
            vec![],
        )
        .unwrap();
    harness.runtime.replica.load(&second).await.unwrap();
    harness.accept_create().await;
    let runtime = harness.runtime.clone();
    let driver = tokio::spawn(async move { runtime.run_dispatch_loop().await });
    tokio::time::timeout(std::time::Duration::from_secs(2), http.reached.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    retire(&harness.runtime, &second, "cleanup-vault").await;
    let completed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !harness
            .runtime
            .replica
            .snapshot(&second)
            .unwrap()
            .bootstrap
            .pending_vault_retirements
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(
        !http.dropped.load(Ordering::SeqCst),
        "A retirement wake dropped the in-flight HTTP request"
    );
    http.release.add_permits(1);
    let dispatched = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap()
            .operations
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    driver.abort();
    let _ = driver.await;
    harness.runtime.close().await;
    assert!(
        completed.is_ok(),
        "In-flight Account A HTTP prevented Account B retirement"
    );
    assert!(
        dispatched.is_ok(),
        "The original HTTP request did not finish"
    );
    assert!(!http.dropped.load(Ordering::SeqCst));
    assert_eq!(harness.server.create_requests().len(), 1);
}

#[tokio::test]
async fn a_held_retirement_does_not_delay_later_ordinary_work_for_another_account() {
    let harness = seeded(true).await;
    let blocked = AccountId::from("blocked-cleanup-account");
    harness
        .replica
        .state
        .install(
            blocked.clone(),
            "blocked-user".into(),
            Incarnation::from(INCARNATION),
        )
        .unwrap();
    harness
        .replica
        .state
        .seed_ready_authority(
            &blocked,
            vec![personal_vault("blocked-vault", "blocked-user")],
            vec![],
        )
        .unwrap();
    harness.runtime.replica.load(&blocked).await.unwrap();
    retire(&harness.runtime, &blocked, "blocked-vault").await;
    let execution = harness.runtime.account_execution_lock(&blocked).unwrap();
    let held = execution.lock().await;
    let runtime = harness.runtime.clone();
    let driver = tokio::spawn(async move { runtime.run_dispatch_loop().await });
    tokio::task::yield_now().await;
    tokio::task::yield_now().await;
    harness.accept_create().await;
    let completed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !harness
            .runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap()
            .operations
            .is_empty()
        {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(!harness
        .runtime
        .replica
        .snapshot(&blocked)
        .unwrap()
        .bootstrap
        .pending_vault_retirements
        .is_empty());
    drop(held);
    driver.abort();
    let _ = driver.await;
    harness.runtime.close().await;
    assert!(
        completed.is_ok(),
        "A held retirement prevented another Account's accepted write"
    );
    assert_eq!(harness.server.create_requests().len(), 1);
}

struct RetirementInterleavedHttp {
    ordinary: HeldItemHttp,
    images: super::super::dispatch_tests::ProductionVaultImageHttp,
}

#[async_trait]
impl SerializedHttpExecutor for RetirementInterleavedHttp {
    async fn invoke(&self, text: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: serde_json::Value = serde_json::from_str(&text).unwrap();
        if request["url"]
            .as_str()
            .unwrap()
            .contains("/vault-image-staging/")
        {
            self.images.invoke(text).await
        } else {
            self.ordinary.invoke(text).await
        }
    }

    fn cancel(&self, id: &str) {
        self.ordinary.cancel(id);
    }
}

async fn poll_dispatch_to_wait(driver: std::pin::Pin<&mut impl std::future::Future<Output = ()>>) {
    let mut driver = driver;
    std::future::poll_fn(|context| {
        assert!(driver.as_mut().poll(context).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn a_completed_stale_retirement_rechecks_accounts_excluded_from_the_current_scan() {
    use super::super::{
        dispatch_tests::DispatchImageSourcePort,
        foreground_attachment_lifecycle::VaultRetirementProof,
    };
    use crate::{CreateVaultType, VaultImageSourceInput};

    let mut harness = seeded_with_existing_item(true, false).await;
    harness.runtime.close().await;
    let http = Arc::new(RetirementInterleavedHttp {
        ordinary: HeldItemHttp {
            server: harness.server.clone(),
            reached: tokio::sync::Semaphore::new(0),
            release: tokio::sync::Semaphore::new(0),
            first: std::sync::atomic::AtomicBool::new(true),
            dropped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        },
        images: Default::default(),
    });
    harness.runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        http.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    let first = harness.account_id.clone();
    let second = AccountId::from("account-2");
    let third = AccountId::from("account-3");
    for account in [&second, &third] {
        harness
            .replica
            .state
            .install(account.clone(), USER.into(), Incarnation::from(INCARNATION))
            .unwrap();
        crate::test_fixtures::seed_ready_personal_vault(&harness.replica.state, account).unwrap();
    }
    for account in [&first, &second, &third] {
        harness.runtime.replica.load(account).await.unwrap();
        harness.runtime.unlock_account(account).await.unwrap();
        store_session(&harness.runtime, account, FIRST_TOKEN).await;
    }
    harness
        .runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    harness.runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "retirement-driver-image-source",
            Arc::new(DispatchImageSourcePort),
            Arc::new(crate::MemoryVaultImageArtifactStore::default()),
        )
        .unwrap(),
    );
    let (first_operation, _) = harness.accept_create().await;
    for account in [&second, &third] {
        let request = if account == &second {
            RuntimeRequest::CreateVault {
                account_id: account.clone(),
                name: "Selectively parked image".into(),
                vault_type: CreateVaultType::Personal,
                icon: "image".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "selected-image".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            }
        } else {
            RuntimeRequest::CreateItem {
                account_id: account.clone(),
                vault_id: TEST_VAULT_ID.into(),
                draft: draft(),
            }
        };
        assert!(matches!(
            harness
                .runtime
                .request(request, RequestCancellation::new())
                .await
                .unwrap(),
            RuntimeResponse::Accepted { .. } | RuntimeResponse::VaultCreationAccepted { .. }
        ));
    }
    let second_before = harness.runtime.replica.snapshot(&second).unwrap();
    let image = second_before.operations[0].clone();
    let selective = harness
        .runtime
        .foreground_attachments
        .begin_vault_retirement(
            &second,
            &second_before.incarnation,
            &[image.vault_id().to_owned()],
            VaultRetirementProof::DurableJournal {
                revision: second_before.revision,
            },
        )
        .unwrap();
    selective.drain().await;
    harness
        .runtime
        .foreground_attachments
        .acknowledge_vault_retirement(&selective)
        .unwrap();
    assert!(!harness.runtime.has_vault_retirement_work(&second_before));
    // The existing fixture's second Vault can retire without fencing the accepted Item.
    retire(&harness.runtime, &first, "vault-2").await;
    let first_before = harness.runtime.replica.snapshot(&first).unwrap();
    let original = first_before.operations[0].clone();
    let first_execution = harness.runtime.account_execution_lock(&first).unwrap();
    let first_held = first_execution.lock().await;
    let second_execution = harness.runtime.account_execution_lock(&second).unwrap();
    let second_held = second_execution.lock().await;
    let mut driver = std::pin::pin!(harness.runtime.run_dispatch_loop());

    // The surviving driver captures A as active, then waits on B's execution fence.
    poll_dispatch_to_wait(driver.as_mut()).await;
    assert_eq!(http.ordinary.reached.available_permits(), 0);
    // Another existing caller completes the same local duty under A's execution fence.
    harness
        .runtime
        .resume_vault_retirements(&first_before)
        .await
        .unwrap();
    assert!(!harness
        .runtime
        .has_vault_retirement_work(&harness.runtime.replica.snapshot(&first).unwrap()));
    drop(second_held);
    poll_dispatch_to_wait(driver.as_mut()).await;
    assert_eq!(http.ordinary.reached.available_permits(), 1);
    assert!(harness.server.create_requests().is_empty());

    // C's real response forces a new scan and consumes the earlier cleanup wake. A's stale
    // retirement future survives that scan; B's existing selective fence still parks its image.
    let second_held = second_execution.lock().await;
    http.ordinary.release.add_permits(1);
    poll_dispatch_to_wait(driver.as_mut()).await;
    assert_eq!(harness.server.create_requests().len(), 1);
    assert!(harness
        .runtime
        .replica
        .snapshot(&third)
        .unwrap()
        .operations
        .is_empty());
    assert_eq!(
        harness.runtime.replica.snapshot(&first).unwrap().operations,
        vec![original.clone()]
    );
    assert!(!http.ordinary.dropped.load(Ordering::SeqCst));
    drop(first_held);
    poll_dispatch_to_wait(driver.as_mut()).await;
    // Completing the already-acknowledged attempt does not publish another authority wake.
    assert_eq!(harness.server.create_requests().len(), 1);
    drop(second_held);
    poll_dispatch_to_wait(driver.as_mut()).await;

    let after = harness.runtime.replica.snapshot(&first).unwrap();
    assert!(
        after
            .receipts
            .iter()
            .any(|receipt| receipt.operation_id == first_operation),
        "completed retirement was discarded while the current scan still excluded its Account"
    );
    assert!(after.operations.is_empty());
    assert_eq!(
        harness
            .runtime
            .replica
            .snapshot(&second)
            .unwrap()
            .operations,
        vec![image]
    );
    let requests = harness.server.create_requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].header("idempotency-key"),
        Some(first_operation.as_str())
    );
    assert_eq!(requests[1].body, original.request.body);
    assert!(harness.timer.requested().is_empty());
    assert!(!http.ordinary.dropped.load(Ordering::SeqCst));
    harness.runtime.close().await;
}
