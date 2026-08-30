use super::operation_fixtures::*;
use super::*;
use crate::{
    attachment_artifact_store::{
        AttachmentArtifactStore, AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse,
    },
    http_transport::SerializedHttpExecutor,
    protocol::Incarnation,
    replica::{
        AuthorityAttachmentRecord, AuthorityItemCategory, AuthorityItemRecord, GuardedCommitPlan,
        InMemoryReplica, PlanMutation, PlanResult, Replica, SerializedReplicaPersistence,
    },
    server_contract::{UpdateAttachmentBody, VaultAttachmentResponse},
    test_fixtures::{personal_vault, TEST_VAULT_ID, TEST_VAULT_KEY},
    CreateShareDraft, ShareAccessMode, ShareExpiration,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use bittery_crypto_core::{encrypt_with_aad, AadContext};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use tokio::sync::Semaphore;

struct SuccessfulAttachmentTeardown;

#[async_trait]
impl AttachmentArtifactStore for SuccessfulAttachmentTeardown {
    async fn invoke(
        &self,
        request: AttachmentArtifactStoreRequest,
    ) -> Result<AttachmentArtifactStoreResponse, RuntimeError> {
        match request {
            AttachmentArtifactStoreRequest::DeleteAccount { .. } => {
                Ok(AttachmentArtifactStoreResponse::AccountDeleted)
            }
            AttachmentArtifactStoreRequest::WipeDevice => {
                Ok(AttachmentArtifactStoreResponse::DeviceWiped)
            }
            _ => panic!("Attachment Rename teardown fixture received non-destructive work"),
        }
    }
}

struct SuccessfulHostTeardown;

#[async_trait]
impl TeardownHostCleanup for SuccessfulHostTeardown {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        Ok(match request {
            TeardownHostCleanupRequest::DeleteAccount { .. } => {
                TeardownHostCleanupResponse::AccountDeleted
            }
            TeardownHostCleanupRequest::WipeDevice => TeardownHostCleanupResponse::DeviceWiped,
        })
    }
}

struct FailingHostTeardown;

#[async_trait]
impl TeardownHostCleanup for FailingHostTeardown {
    async fn invoke(
        &self,
        _request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        Err(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            "injected host teardown failure",
        ))
    }
}

struct FenceInspectingHostTeardown {
    sink: Arc<Mutex<DownloadSinkState>>,
    inspected: Arc<AtomicBool>,
}

#[async_trait]
impl TeardownHostCleanup for FenceInspectingHostTeardown {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        let TeardownHostCleanupRequest::DeleteAccount { account_id } = request else {
            panic!("Account fence inspection received Device teardown")
        };
        let state = self.sink.lock().unwrap();
        assert!(state.fenced_accounts.contains(account_id.as_str()));
        assert!(state.account_retirement_completions.is_empty());
        self.inspected.store(true, Ordering::SeqCst);
        Ok(TeardownHostCleanupResponse::AccountDeleted)
    }
}

#[derive(Default)]
struct AttachmentSink(Mutex<Vec<RuntimeProjection>>);

impl ObservationSink for AttachmentSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.0.lock().unwrap().push(projection);
    }
}

struct ReentrantAttachmentSink {
    publications: Mutex<Vec<RuntimeProjection>>,
    callback: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl ObservationSink for ReentrantAttachmentSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.publications.lock().unwrap().push(projection);
        if let Some(callback) = self.callback.lock().unwrap().take() {
            callback();
        }
    }
}

fn create_share(account_id: &AccountId) -> RuntimeRequest {
    RuntimeRequest::CreateShare {
        account_id: account_id.clone(),
        item_id: ITEM_ID.into(),
        draft: CreateShareDraft {
            access_mode: ShareAccessMode::Anyone,
            expires_in: ShareExpiration::SevenDays,
            is_one_time_use: false,
            allowed_emails: Vec::new(),
        },
    }
}

#[test]
fn rename_attachment_request_carries_only_account_attachment_and_name() {
    let request = RuntimeRequest::RenameAttachment {
        account_id: AccountId::from("account-1"),
        attachment_id: "attachment-1".into(),
        name: "renamed.txt".into(),
    };

    assert_eq!(
        serde_json::to_value(request).expect("Rename request should serialize"),
        serde_json::json!({
            "type": "renameAttachment",
            "accountId": "account-1",
            "attachmentId": "attachment-1",
            "name": "renamed.txt",
        })
    );
    assert_eq!(
        serde_json::to_value(RuntimeResponse::AttachmentRenamed {
            account_id: AccountId::from("account-1"),
            attachment_id: "attachment-1".into(),
        })
        .expect("Rename result should serialize"),
        serde_json::json!({
            "type": "attachmentRenamed",
            "accountId": "account-1",
            "attachmentId": "attachment-1",
        })
    );
}

#[test]
fn delete_attachment_request_carries_only_account_and_attachment() {
    let request = RuntimeRequest::DeleteAttachment {
        account_id: AccountId::from("account-1"),
        attachment_id: "attachment-1".into(),
    };

    assert_eq!(
        serde_json::to_value(request).expect("Delete request should serialize"),
        serde_json::json!({
            "type": "deleteAttachment",
            "accountId": "account-1",
            "attachmentId": "attachment-1",
        })
    );
    assert_eq!(
        serde_json::to_value(RuntimeResponse::AttachmentDeleted {
            account_id: AccountId::from("account-1"),
            attachment_id: "attachment-1".into(),
        })
        .expect("Delete result should serialize"),
        serde_json::json!({
            "type": "attachmentDeleted",
            "accountId": "account-1",
            "attachmentId": "attachment-1",
        })
    );
}

#[test]
fn download_attachment_request_carries_only_account_attachment_and_sink_capability() {
    let request = RuntimeRequest::DownloadAttachment {
        account_id: AccountId::from("account-a"),
        attachment_id: "attachment-a".into(),
        sink_capability_id: "sink-a".into(),
    };

    assert_eq!(
        serde_json::to_value(request).expect("serialize Download request"),
        serde_json::json!({
            "type": "downloadAttachment",
            "accountId": "account-a",
            "attachmentId": "attachment-a",
            "sinkCapabilityId": "sink-a",
        })
    );
    assert_eq!(
        serde_json::to_value(RuntimeResponse::AttachmentDownloaded {
            account_id: AccountId::from("account-a"),
            attachment_id: "attachment-a".into(),
        })
        .expect("serialize Download result"),
        serde_json::json!({
            "type": "attachmentDownloaded",
            "accountId": "account-a",
            "attachmentId": "attachment-a",
        })
    );
}

#[tokio::test]
async fn download_rejects_noncanonical_sink_capabilities_before_host_or_network() {
    assert!(super::attachment::is_canonical_sink_capability_id("x"));
    assert!(super::attachment::is_canonical_sink_capability_id(
        &"x".repeat(128)
    ));
    for capability in [
        String::new(),
        "x".repeat(129),
        "not canonical".into(),
        "café".into(),
    ] {
        let harness = seeded_attachment().await;
        let (transfer, sink) =
            install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
        let error = harness
            .runtime
            .request(
                RuntimeRequest::DownloadAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    sink_capability_id: capability,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert_eq!(
            harness.server.download_grant_calls.load(Ordering::SeqCst),
            0
        );
        assert_eq!(transfer.opens.load(Ordering::SeqCst), 0);
        assert_eq!(sink.lock().unwrap().begins.len(), 0);
    }
}

#[tokio::test]
async fn download_claims_then_discards_the_capability_for_every_pre_authority_exit() {
    for failure in [
        "cancelled",
        "account-missing",
        "attachment-missing",
        "locked",
        "key-missing",
    ] {
        let harness = seeded_attachment().await;
        let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
        let cancellation = RequestCancellation::new();
        let account_id = if failure == "account-missing" {
            AccountId::from("missing-account")
        } else {
            harness.account_id.clone()
        };
        let attachment_id = if failure == "attachment-missing" {
            "missing-attachment".to_owned()
        } else {
            ATTACHMENT_ID.to_owned()
        };
        if failure == "cancelled" {
            cancellation.cancel();
        }
        if failure == "locked" {
            harness
                .runtime
                .mark_account_locked(&harness.account_id)
                .await
                .unwrap();
        }
        if failure == "key-missing" {
            harness
                .runtime
                .live_master_unlock_keys
                .lock()
                .unwrap()
                .clear();
        }

        let error = harness
            .runtime
            .request(
                RuntimeRequest::DownloadAttachment {
                    account_id: account_id.clone(),
                    attachment_id: attachment_id.clone(),
                    sink_capability_id: format!("sink-{failure}"),
                },
                cancellation,
            )
            .await
            .unwrap_err();

        let sink = sink.lock().unwrap();
        assert_eq!(
            sink.claims,
            [(
                account_id.as_str().to_owned(),
                attachment_id.clone(),
                format!("sink-{failure}")
            )],
            "{failure}"
        );
        assert_eq!(
            sink.begins,
            if failure == "cancelled" {
                Vec::new()
            } else {
                vec![(
                    account_id.as_str().to_owned(),
                    attachment_id,
                    format!("sink-{failure}"),
                )]
            },
            "{failure}"
        );
        assert_eq!(sink.discards, 1, "{failure}");
        assert!(sink.provisional.is_empty(), "{failure}");
        assert_eq!(
            harness.server.download_grant_calls.load(Ordering::SeqCst),
            0,
            "{failure}: {error:?}"
        );
    }
}

#[tokio::test]
async fn download_claim_and_lifecycle_registration_precede_outer_teardown_admission_wait() {
    let harness = seeded_attachment().await;
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    let outer_writer = harness.runtime.teardown_admission.write().await;
    let request = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "outer-admission".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });

    for _ in 0..100 {
        if !sink.lock().unwrap().claims.is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(
        sink.lock().unwrap().claims.len(),
        1,
        "capability ownership must be lifecycle-visible before awaiting outer admission"
    );

    request.abort();
    drop(outer_writer);
    let _ = request.await;
}

#[tokio::test]
async fn close_drains_download_cleanup_while_request_is_suspended_at_outer_admission() {
    let harness = seeded_attachment().await;
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    let (discard_started, discard_release) = {
        let mut state = sink.lock().unwrap();
        state.hold_discard = true;
        (
            Arc::clone(&state.discard_started),
            Arc::clone(&state.discard_release),
        )
    };
    let outer_writer = harness.runtime.teardown_admission.write().await;
    let request = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "outer-close".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    until("Download claims before outer admission", || {
        sink.lock().unwrap().claims.len() == 1
    })
    .await;
    let close = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        async move { runtime.close().await }
    });
    until(
        "close cancellation reaches provisional sink cleanup",
        || discard_started.load(Ordering::SeqCst),
    )
    .await;
    assert!(!close.is_finished());
    discard_release.add_permits(1);
    close.await.unwrap();
    drop(outer_writer);
    assert_eq!(
        request.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    assert_eq!(sink.lock().unwrap().discards, 1);
}

#[tokio::test]
async fn account_and_runtime_lifecycle_sweep_unbegun_download_grants() {
    for lifecycle in ["lock", "signout", "remove", "wipe", "close"] {
        let harness = seeded_attachment().await;
        *harness.runtime.attachment_move_lifecycle.lock().unwrap() =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                Arc::new(SuccessfulAttachmentTeardown),
            )));
        harness
            .runtime
            .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
        let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
        match lifecycle {
            "lock" => {
                harness
                    .runtime
                    .mark_account_locked(&harness.account_id)
                    .await
                    .unwrap();
            }
            "signout" => {
                harness
                    .runtime
                    .request(
                        RuntimeRequest::SignOut {
                            account_id: harness.account_id.clone(),
                        },
                        RequestCancellation::new(),
                    )
                    .await
                    .unwrap();
            }
            "remove" => {
                harness
                    .runtime
                    .request(
                        RuntimeRequest::RemoveAccount {
                            account_id: harness.account_id.clone(),
                        },
                        RequestCancellation::new(),
                    )
                    .await
                    .unwrap();
            }
            "wipe" => {
                harness
                    .runtime
                    .request(RuntimeRequest::Wipe, RequestCancellation::new())
                    .await
                    .unwrap();
            }
            "close" => harness.runtime.close().await,
            _ => unreachable!(),
        }
        let sink = sink.lock().unwrap();
        if matches!(lifecycle, "wipe" | "close") {
            assert_eq!(sink.runtime_retirements, 1, "{lifecycle}");
        } else {
            assert_eq!(
                sink.account_retirements,
                [harness.account_id.as_str()],
                "{lifecycle}"
            );
            assert_eq!(
                sink.account_retirement_completions,
                [harness.account_id.as_str()],
                "{lifecycle}"
            );
        }
    }
}

#[tokio::test]
async fn account_lifecycle_retries_registry_cleanup_and_keeps_keys_until_it_converges() {
    let harness = seeded_attachment().await;
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    let release = {
        let mut state = sink.lock().unwrap();
        state.hold_account_retirement = true;
        state.account_retirement_failures_remaining = 2;
        Arc::clone(&state.account_retirement_release)
    };
    let locking = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move { runtime.mark_account_locked(&account_id).await }
    });
    until("Account sink registry cleanup starts", || {
        !sink.lock().unwrap().account_retirements.is_empty()
    })
    .await;
    assert!(harness
        .runtime
        .has_live_master_unlock_key(&harness.account_id, &Incarnation::from(INCARNATION),));
    let ordinary = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(create_share(&account_id), RequestCancellation::new())
                .await
        }
    });
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert!(
        !ordinary.is_finished(),
        "ordinary Item work must wait behind lifecycle host cleanup and backoff"
    );
    assert!(harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .operations
        .is_empty());
    release.add_permits(3);
    locking.await.unwrap().unwrap();
    let ordinary = ordinary.await.unwrap().unwrap_err();
    assert_eq!(ordinary.code, RuntimeErrorCode::AuthenticationRequired);
    let state = sink.lock().unwrap();
    assert_eq!(state.account_retirements.len(), 3);
    assert!(!harness
        .runtime
        .has_live_master_unlock_key(&harness.account_id, &Incarnation::from(INCARNATION),));
}

#[tokio::test]
async fn lock_signout_and_remove_serialize_one_account_retirement_through_exact_completion() {
    let harness = seeded_attachment().await;
    *harness.runtime.attachment_move_lifecycle.lock().unwrap() =
        Some(Arc::new(AttachmentMoveLifecycle::new(
            Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
            Arc::new(SuccessfulAttachmentTeardown),
        )));
    harness
        .runtime
        .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    let release = {
        let mut state = sink.lock().unwrap();
        state.hold_account_retirement = true;
        Arc::clone(&state.account_retirement_release)
    };

    let locking = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move { runtime.mark_account_locked(&account_id).await }
    });
    until("Lock owns the first Account retirement", || {
        sink.lock().unwrap().account_retirements.len() == 1
    })
    .await;
    let signing_out = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .retire_account_access(&account_id, AccessRetirement::SignOut)
                .await
        }
    });
    let removing = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::RemoveAccount { account_id },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    for _ in 0..32 {
        tokio::task::yield_now().await;
    }
    assert_eq!(sink.lock().unwrap().account_retirements.len(), 1);

    release.add_permits(1);
    until("Sign-out owns the second Account retirement", || {
        sink.lock().unwrap().account_retirements.len() == 2
    })
    .await;
    assert!(locking.is_finished());
    assert!(!signing_out.is_finished());
    assert!(!removing.is_finished());

    release.add_permits(1);
    until("Remove owns the third Account retirement", || {
        sink.lock().unwrap().account_retirements.len() == 3
    })
    .await;
    assert!(signing_out.is_finished());
    assert!(!removing.is_finished());
    release.add_permits(1);

    locking.await.unwrap().unwrap();
    assert_eq!(
        signing_out.await.unwrap().unwrap(),
        AccountAccessState::SignedOut
    );
    assert!(matches!(
        removing.await.unwrap().unwrap(),
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
    let state = sink.lock().unwrap();
    assert_eq!(state.account_retirements.len(), 3);
    assert_eq!(state.account_retirement_completions.len(), 3);
    assert!(!state.fenced_accounts.contains(harness.account_id.as_str()));
}

#[tokio::test]
async fn empty_account_access_retirement_reopens_its_download_grant_fence_after_convergence() {
    let harness = seeded_attachment().await;
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    let missing = AccountId::from("missing-account");

    assert_eq!(
        harness
            .runtime
            .retire_account_access(&missing, AccessRetirement::Lock)
            .await
            .unwrap(),
        AccountAccessState::SignedOut
    );

    let state = sink.lock().unwrap();
    assert_eq!(state.account_retirements, [missing.as_str()]);
    assert_eq!(state.account_retirement_completions, [missing.as_str()]);
    assert!(!state.fenced_accounts.contains(missing.as_str()));
}

#[tokio::test]
async fn remove_keeps_the_download_grant_fence_past_host_cleanup_until_core_converges() {
    let harness = seeded_attachment().await;
    *harness.runtime.attachment_move_lifecycle.lock().unwrap() =
        Some(Arc::new(AttachmentMoveLifecycle::new(
            Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
            Arc::new(SuccessfulAttachmentTeardown),
        )));
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    let inspected = Arc::new(AtomicBool::new(false));
    harness
        .runtime
        .install_teardown_host_cleanup(Arc::new(FenceInspectingHostTeardown {
            sink: Arc::clone(&sink),
            inspected: Arc::clone(&inspected),
        }));

    let response = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: harness.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert!(matches!(
        response,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
    assert!(inspected.load(Ordering::SeqCst));
    let state = sink.lock().unwrap();
    assert_eq!(
        state.account_retirement_completions,
        [harness.account_id.as_str()]
    );
    assert!(!state.fenced_accounts.contains(harness.account_id.as_str()));
}

#[tokio::test]
async fn incomplete_remove_keeps_the_download_grant_fence_until_a_converged_retry() {
    let harness = seeded_attachment().await;
    *harness.runtime.attachment_move_lifecycle.lock().unwrap() =
        Some(Arc::new(AttachmentMoveLifecycle::new(
            Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
            Arc::new(SuccessfulAttachmentTeardown),
        )));
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    harness
        .runtime
        .install_teardown_host_cleanup(Arc::new(FailingHostTeardown));

    let first = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: harness.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        first,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Incomplete,
            ..
        }
    ));
    {
        let state = sink.lock().unwrap();
        assert!(state.fenced_accounts.contains(harness.account_id.as_str()));
        assert!(state.account_retirement_completions.is_empty());
    }

    harness
        .runtime
        .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
    let retry = harness
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: harness.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        retry,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
    let state = sink.lock().unwrap();
    assert_eq!(state.account_retirements.len(), 2);
    assert_eq!(state.account_retirement_completions.len(), 1);
    assert!(!state.fenced_accounts.contains(harness.account_id.as_str()));
}

const ATTACHMENT_ID: &str = "attachment-1";
const ITEM_ID: &str = "item-existing";

struct AttachmentServer {
    requests: Mutex<Vec<RecordedRequest>>,
    item: StoredItem,
    attachment: Mutex<VaultAttachmentResponse>,
    additional_owning_attachments: Mutex<Vec<VaultAttachmentResponse>>,
    attachment_deleted: AtomicBool,
    delete_not_found: AtomicBool,
    lose_next_delete_response: AtomicBool,
    discard_next_delete: AtomicBool,
    lose_next_patch_response: AtomicBool,
    discard_next_patch: AtomicBool,
    unauthorized_patches: AtomicUsize,
    patch_calls: AtomicUsize,
    delete_calls: AtomicUsize,
    download_grant_calls: AtomicUsize,
    unauthorized_download_grants: AtomicUsize,
    denied_download_grants: AtomicUsize,
    download_grant_failure: AtomicBool,
    unauthorized_deletes: AtomicUsize,
    denied_deletes: AtomicUsize,
    refresh_calls: AtomicUsize,
    refresh_mode: AtomicUsize,
    refresh_release: Semaphore,
    hold_patch: AtomicBool,
    patch_release: Semaphore,
    hold_delete: AtomicBool,
    delete_release: Semaphore,
    hold_attachment_get: AtomicBool,
    attachment_get_calls: AtomicUsize,
    item_get_calls: AtomicUsize,
    attachment_get_release: Semaphore,
    item_get_failure: AtomicUsize,
    attachment_get_failure: AtomicUsize,
    attachment_page_mode: AtomicUsize,
    key_authority_drift_after_patch: AtomicUsize,
    address_authority_drift_after_patch: AtomicUsize,
    cancel_calls: AtomicUsize,
}

impl AttachmentServer {
    fn patches(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == "PATCH")
            .cloned()
            .collect()
    }

    fn deletes(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method == "DELETE")
            .cloned()
            .collect()
    }
}

#[async_trait]
impl SerializedHttpExecutor for AttachmentServer {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request_json).unwrap();
        let request = RecordedRequest {
            method: value["method"].as_str().unwrap().to_owned(),
            url: value["url"].as_str().unwrap().to_owned(),
            headers: value["headers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|header| {
                    (
                        header["name"].as_str().unwrap().to_owned(),
                        header["value"].as_str().unwrap().to_owned(),
                    )
                })
                .collect(),
            body: value["body"]
                .as_array()
                .unwrap()
                .iter()
                .map(|byte| byte.as_u64().unwrap() as u8)
                .collect(),
        };
        self.requests.lock().unwrap().push(request.clone());
        let response = if request.url.ends_with("/api/v1/sessions/current/refresh") {
            self.refresh_calls.fetch_add(1, Ordering::SeqCst);
            match self.refresh_mode.load(Ordering::SeqCst) {
                1 => {
                    self.refresh_release.acquire().await.unwrap().forget();
                    unreachable!("a held refresh is released only to clean up a failed test")
                }
                2 => return Ok(json!({ "type": "networkFailure" }).to_string()),
                3 => completed(200, b"{".to_vec()),
                _ => completed(
                    200,
                    serde_json::to_vec(&json!({
                        "token": SECOND_TOKEN,
                        "sessionId": "session-1",
                        "expiresAt": "2099-01-01T00:00:00Z",
                    }))
                    .unwrap(),
                ),
            }
        } else if request.method == "POST" && request.url.ends_with("/download-urls") {
            self.download_grant_calls.fetch_add(1, Ordering::SeqCst);
            if self.download_grant_failure.swap(false, Ordering::SeqCst) {
                return Ok(json!({ "type": "networkFailure" }).to_string());
            }
            if self
                .unauthorized_download_grants
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Ok(completed(401, b"{}".to_vec()).to_string());
            }
            if self
                .denied_download_grants
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Ok(completed(403, b"{}".to_vec()).to_string());
            }
            let attachment = self.attachment.lock().unwrap().clone();
            completed(
                200,
                serde_json::to_vec(&json!({
                    "attachmentId": attachment.id,
                    "itemId": attachment.item_id,
                    "vaultId": attachment.vault_id,
                    "storageKey": attachment.storage_key,
                    "envelopeVersion": attachment.envelope_version,
                    "uploadedBy": attachment.uploaded_by,
                    "downloadUrl": "https://objects.example.test/attachment",
                    "encryptedName": attachment.encrypted_name,
                    "encryptedContentType": attachment.encrypted_content_type,
                    "encryptionIv": attachment.encryption_iv,
                    "encryptedContentTypeIv": attachment.encrypted_content_type_iv,
                    "encryptionAlgorithm": attachment.encryption_algorithm,
                    "fileSize": attachment.file_size,
                }))
                .unwrap(),
            )
        } else if request.method == "DELETE" {
            self.delete_calls.fetch_add(1, Ordering::SeqCst);
            if self
                .unauthorized_deletes
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Ok(completed(401, b"{}".to_vec()).to_string());
            }
            if self
                .denied_deletes
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Ok(completed(403, b"{}".to_vec()).to_string());
            }
            if self.hold_delete.load(Ordering::SeqCst) {
                self.delete_release.acquire().await.unwrap().forget();
            }
            if self.delete_not_found.load(Ordering::SeqCst) {
                return Ok(completed(404, b"{}".to_vec()).to_string());
            }
            if !self.discard_next_delete.swap(false, Ordering::SeqCst) {
                self.attachment_deleted.store(true, Ordering::SeqCst);
            }
            if self.lose_next_delete_response.swap(false, Ordering::SeqCst) {
                json!({ "type": "networkFailure" })
            } else {
                completed(200, br#"{"success":true}"#.to_vec())
            }
        } else if request.method == "PATCH" {
            self.patch_calls.fetch_add(1, Ordering::SeqCst);
            if self
                .unauthorized_patches
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Ok(completed(401, b"{}".to_vec()).to_string());
            }
            if self.hold_patch.load(Ordering::SeqCst) {
                self.patch_release.acquire().await.unwrap().forget();
            }
            let body: UpdateAttachmentBody = serde_json::from_slice(&request.body).unwrap();
            if !self.discard_next_patch.swap(false, Ordering::SeqCst) {
                let mut attachment = self.attachment.lock().unwrap();
                attachment.encrypted_name = body.encrypted_name;
                attachment.encryption_iv = body.encryption_iv;
                attachment.encryption_algorithm = body.encryption_algorithm;
                match self
                    .key_authority_drift_after_patch
                    .swap(0, Ordering::SeqCst)
                {
                    1 => attachment.envelope_version += 1,
                    2 => attachment.encrypted_attachment_key = BASE64.encode([7u8; 60]),
                    3 => attachment.attachment_key_iv = BASE64.encode([8u8; 12]),
                    4 => attachment.attachment_key_algorithm = "AES-GCM-AAD-V2".into(),
                    _ => {}
                }
                match self
                    .address_authority_drift_after_patch
                    .swap(0, Ordering::SeqCst)
                {
                    1 => attachment.uploaded_by = "different-uploader".into(),
                    2 => attachment.id = "replacement-attachment".into(),
                    3 => attachment.item_id = "replacement-item".into(),
                    4 => attachment.vault_id = "replacement-vault".into(),
                    _ => {}
                }
            }
            if self.lose_next_patch_response.swap(false, Ordering::SeqCst) {
                json!({ "type": "networkFailure" })
            } else {
                completed(200, br#"{"success":true}"#.to_vec())
            }
        } else if request.method == "GET"
            && request
                .url
                .contains(&format!("/api/v1/items/{ITEM_ID}/attachments"))
        {
            self.attachment_get_calls.fetch_add(1, Ordering::SeqCst);
            let attachment_failure = self.attachment_get_failure.swap(0, Ordering::SeqCst);
            match attachment_failure {
                1 => return Ok(json!({ "type": "networkFailure" }).to_string()),
                2 => return Ok(json!({ "type": "responseTooLarge" }).to_string()),
                3 => return Ok(completed(200, b"{".to_vec()).to_string()),
                4 | 5 => {
                    let mut attachment = self.attachment.lock().unwrap().clone();
                    if attachment_failure == 4 {
                        attachment.id = "foreign-attachment".into();
                        attachment.item_id = "foreign-item".into();
                    } else {
                        attachment.id = "foreign-attachment".into();
                        attachment.vault_id = "foreign-vault".into();
                    }
                    return Ok(completed(
                        200,
                        serde_json::to_vec(&json!({
                            "items": [attachment],
                            "hasMore": false,
                            "nextCursor": null,
                        }))
                        .unwrap(),
                    )
                    .to_string());
                }
                _ => {}
            }
            if self.hold_attachment_get.load(Ordering::SeqCst) {
                self.attachment_get_release
                    .acquire()
                    .await
                    .unwrap()
                    .forget();
            }
            attachment_page_response(self, &request.url)
        } else if request.method == "GET"
            && request.url.ends_with(&format!("/api/v1/items/{ITEM_ID}"))
        {
            self.item_get_calls.fetch_add(1, Ordering::SeqCst);
            match self.item_get_failure.swap(0, Ordering::SeqCst) {
                1 => return Ok(json!({ "type": "networkFailure" }).to_string()),
                2 => return Ok(json!({ "type": "responseTooLarge" }).to_string()),
                3 => return Ok(completed(200, b"{".to_vec()).to_string()),
                4 => {
                    let mut foreign = self.item.clone();
                    foreign.id = "foreign-item".into();
                    return Ok(completed(200, item_body(&foreign)).to_string());
                }
                5 => return Ok(completed(404, b"{}".to_vec()).to_string()),
                _ => {}
            }
            completed(200, item_body(&self.item))
        } else {
            panic!(
                "unexpected Attachment test request {} {}",
                request.method, request.url
            );
        };
        Ok(response.to_string())
    }

    fn cancel(&self, _dispatch_id: &str) {
        self.cancel_calls.fetch_add(1, Ordering::SeqCst);
    }
}

struct AttachmentHarness {
    runtime: Arc<Runtime>,
    account_id: AccountId,
    server: Arc<AttachmentServer>,
    replica: Arc<PlainReplica>,
    timer: Arc<TestTimer>,
}

struct DownloadChunks {
    chunks: Vec<Vec<u8>>,
    index: usize,
    fail_first: bool,
}

#[async_trait]
impl AttachmentMoveDownload for DownloadChunks {
    async fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, AttachmentMoveTransferError> {
        if self.fail_first {
            self.fail_first = false;
            return Err(AttachmentMoveTransferError::Transient);
        }
        let chunk = self.chunks.get(self.index).cloned();
        self.index += usize::from(chunk.is_some());
        Ok(chunk)
    }
}

struct DownloadTransfer {
    envelope: Mutex<Vec<u8>>,
    opens: AtomicUsize,
    hold_open: AtomicBool,
    fail_open: AtomicBool,
    fail_chunk: AtomicBool,
    open_release: Semaphore,
}

#[async_trait]
impl AttachmentMoveTransferPort for DownloadTransfer {
    async fn open_source(
        &self,
        request: AttachmentMoveDownloadRequest,
    ) -> Result<Box<dyn AttachmentMoveDownload>, AttachmentMoveTransferError> {
        assert_eq!(
            request.download_url,
            "https://objects.example.test/attachment"
        );
        assert!(request.headers.is_empty());
        self.opens.fetch_add(1, Ordering::SeqCst);
        if self.fail_open.swap(false, Ordering::SeqCst) {
            return Err(AttachmentMoveTransferError::Transient);
        }
        if self.hold_open.load(Ordering::SeqCst) {
            self.open_release.acquire().await.unwrap().forget();
        }
        let envelope = self.envelope.lock().unwrap().clone();
        let split = (envelope.len() / 3).max(1);
        Ok(Box::new(DownloadChunks {
            chunks: envelope.chunks(split).map(<[u8]>::to_vec).collect(),
            index: 0,
            fail_first: self.fail_chunk.swap(false, Ordering::SeqCst),
        }))
    }

    async fn open_upload(
        &self,
        _account_id: &AccountId,
        _operation_id: &str,
        _grant: &AttachmentMoveUploadGrant,
        _owner: &crate::AttachmentArtifactOwner,
    ) -> Result<Box<dyn AttachmentMoveUpload>, AttachmentMoveTransferError> {
        Err(AttachmentMoveTransferError::Invariant)
    }
}

struct DownloadSinkState {
    provisional: Vec<u8>,
    published: Option<Vec<u8>>,
    discards: usize,
    claims: Vec<(String, String, String)>,
    account_retirements: Vec<String>,
    account_retirement_completions: Vec<String>,
    fenced_accounts: HashSet<String>,
    runtime_retirements: usize,
    account_retirement_failures_remaining: usize,
    hold_account_retirement: bool,
    account_retirement_release: Arc<Semaphore>,
    discard_failures_remaining: usize,
    hold_discard: bool,
    discard_started: Arc<AtomicBool>,
    discard_release: Arc<Semaphore>,
    begins: Vec<(String, String, String)>,
    fail_write: bool,
    fail_commit: bool,
    fail_begin: bool,
    hold_begin: bool,
    begin_started: Arc<AtomicBool>,
    begin_release: Arc<Semaphore>,
    hold_commit: bool,
    commit_started: Arc<AtomicBool>,
    commit_release: Arc<Semaphore>,
}

impl Default for DownloadSinkState {
    fn default() -> Self {
        Self {
            provisional: Vec::new(),
            published: None,
            discards: 0,
            claims: Vec::new(),
            account_retirements: Vec::new(),
            account_retirement_completions: Vec::new(),
            fenced_accounts: HashSet::new(),
            runtime_retirements: 0,
            account_retirement_failures_remaining: 0,
            hold_account_retirement: false,
            account_retirement_release: Arc::new(Semaphore::new(0)),
            discard_failures_remaining: 0,
            hold_discard: false,
            discard_started: Arc::new(AtomicBool::new(false)),
            discard_release: Arc::new(Semaphore::new(0)),
            begins: Vec::new(),
            fail_write: false,
            fail_commit: false,
            fail_begin: false,
            hold_begin: false,
            begin_started: Arc::new(AtomicBool::new(false)),
            begin_release: Arc::new(Semaphore::new(0)),
            hold_commit: false,
            commit_started: Arc::new(AtomicBool::new(false)),
            commit_release: Arc::new(Semaphore::new(0)),
        }
    }
}

struct TestDownloadSink {
    state: Arc<Mutex<DownloadSinkState>>,
    identity: (String, String, String),
}

#[async_trait]
impl AttachmentDownloadSink for TestDownloadSink {
    async fn begin(&mut self) -> Result<(), AttachmentDownloadSinkError> {
        let (fail, hold, started, release) = {
            let mut state = self.state.lock().unwrap();
            state.begins.push(self.identity.clone());
            (
                state.fail_begin,
                state.hold_begin,
                Arc::clone(&state.begin_started),
                Arc::clone(&state.begin_release),
            )
        };
        if hold {
            started.store(true, Ordering::SeqCst);
            release.acquire().await.unwrap().forget();
        }
        if fail {
            return Err(AttachmentDownloadSinkError::Sink);
        }
        Ok(())
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), AttachmentDownloadSinkError> {
        let mut state = self.state.lock().unwrap();
        if state.fail_write {
            return Err(AttachmentDownloadSinkError::Sink);
        }
        state.provisional.extend_from_slice(bytes);
        Ok(())
    }

    async fn commit(&mut self) -> Result<(), AttachmentDownloadSinkError> {
        let (hold, started, release) = {
            let state = self.state.lock().unwrap();
            (
                state.hold_commit,
                Arc::clone(&state.commit_started),
                Arc::clone(&state.commit_release),
            )
        };
        if hold {
            started.store(true, Ordering::SeqCst);
            release.acquire().await.unwrap().forget();
        }
        let mut state = self.state.lock().unwrap();
        if state.fail_commit {
            return Err(AttachmentDownloadSinkError::Sink);
        }
        state.published = Some(std::mem::take(&mut state.provisional));
        Ok(())
    }

    async fn discard(&mut self) -> Result<(), AttachmentDownloadSinkError> {
        let (hold, started, release) = {
            let state = self.state.lock().unwrap();
            (
                state.hold_discard,
                Arc::clone(&state.discard_started),
                Arc::clone(&state.discard_release),
            )
        };
        if hold {
            started.store(true, Ordering::SeqCst);
            release.acquire().await.unwrap().forget();
        }
        let mut state = self.state.lock().unwrap();
        state.discards += 1;
        if state.discard_failures_remaining > 0 {
            state.discard_failures_remaining -= 1;
            return Err(AttachmentDownloadSinkError::Sink);
        }
        state.provisional.clear();
        Ok(())
    }
}

struct TestDownloadSinkPort {
    state: Arc<Mutex<DownloadSinkState>>,
}

#[async_trait]
impl AttachmentDownloadSinkPort for TestDownloadSinkPort {
    fn claim(
        &self,
        account_id: &AccountId,
        attachment_id: &str,
        capability_id: &str,
    ) -> Result<Box<dyn AttachmentDownloadSink>, AttachmentDownloadSinkError> {
        if self
            .state
            .lock()
            .unwrap()
            .fenced_accounts
            .contains(account_id.as_str())
        {
            return Err(AttachmentDownloadSinkError::Cancelled);
        }
        let identity = (
            account_id.as_str().into(),
            attachment_id.into(),
            capability_id.into(),
        );
        self.state.lock().unwrap().claims.push(identity.clone());
        Ok(Box::new(TestDownloadSink {
            state: Arc::clone(&self.state),
            identity,
        }))
    }

    async fn retire_account(
        &self,
        account_id: &AccountId,
    ) -> Result<(), AttachmentDownloadSinkError> {
        let (hold, release) = {
            let mut state = self.state.lock().unwrap();
            state
                .account_retirements
                .push(account_id.as_str().to_owned());
            state.fenced_accounts.insert(account_id.as_str().to_owned());
            (
                state.hold_account_retirement,
                Arc::clone(&state.account_retirement_release),
            )
        };
        if hold {
            release.acquire().await.unwrap().forget();
        }
        let mut state = self.state.lock().unwrap();
        if state.account_retirement_failures_remaining > 0 {
            state.account_retirement_failures_remaining -= 1;
            return Err(AttachmentDownloadSinkError::Sink);
        }
        Ok(())
    }

    async fn retire_runtime(&self) -> Result<(), AttachmentDownloadSinkError> {
        self.state.lock().unwrap().runtime_retirements += 1;
        Ok(())
    }

    async fn complete_account_retirement(
        &self,
        account_id: &AccountId,
    ) -> Result<(), AttachmentDownloadSinkError> {
        self.state
            .lock()
            .unwrap()
            .account_retirement_completions
            .push(account_id.as_str().to_owned());
        self.state
            .lock()
            .unwrap()
            .fenced_accounts
            .remove(account_id.as_str());
        Ok(())
    }
}

fn install_download(
    harness: &AttachmentHarness,
    plaintext: &[u8],
) -> (Arc<DownloadTransfer>, Arc<Mutex<DownloadSinkState>>) {
    assert_eq!(plaintext.len(), 42);
    let encrypted = encrypt_with_aad(
        &BASE64.encode(plaintext),
        &[13_u8; 32],
        &AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: ATTACHMENT_ID.into(),
            entity_type: "attachment_blob".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    let transfer = Arc::new(DownloadTransfer {
        envelope: Mutex::new(serde_json::to_vec(&encrypted).unwrap()),
        opens: AtomicUsize::new(0),
        hold_open: AtomicBool::new(false),
        fail_open: AtomicBool::new(false),
        fail_chunk: AtomicBool::new(false),
        open_release: Semaphore::new(0),
    });
    let state = Arc::new(Mutex::new(DownloadSinkState::default()));
    harness
        .runtime
        .install_attachment_download(AttachmentDownloadFacade::new(
            transfer.clone(),
            Arc::new(TestDownloadSinkPort {
                state: Arc::clone(&state),
            }),
        ));
    (transfer, state)
}

async fn seeded_attachment() -> AttachmentHarness {
    seeded_attachment_with_role(AuthorityVaultRole::Owner).await
}

async fn seeded_attachment_with_role(role: AuthorityVaultRole) -> AttachmentHarness {
    let account_id = AccountId::from(ACCOUNT);
    let state = InMemoryReplica::default();
    state
        .install(
            account_id.clone(),
            USER.to_owned(),
            Incarnation::from(INCARNATION),
        )
        .unwrap();
    let item_ciphertext = encrypt_with_aad(
        &serde_json::to_string(&draft()).unwrap(),
        &TEST_VAULT_KEY,
        &AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: ITEM_ID.into(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    let attachment = attachment_authority();
    let mut source_vault = personal_vault(TEST_VAULT_ID, USER);
    source_vault.role = role;
    state
        .seed_ready_authority(
            &account_id,
            vec![source_vault, personal_vault("vault-2", USER)],
            vec![AuthorityItemRecord {
                id: ITEM_ID.into(),
                vault_id: TEST_VAULT_ID.into(),
                category: AuthorityItemCategory::Login,
                favorite: false,
                encrypted_data: item_ciphertext.ciphertext.clone(),
                encryption_iv: item_ciphertext.iv.clone(),
                encryption_algorithm: item_ciphertext.algorithm.clone(),
                version: 1,
                encryption_version: 1,
                encrypted_by_user_id: USER.into(),
                last_modified_by: USER.into(),
                created_at: "2026-08-23T00:00:00Z".into(),
                updated_at: "2026-08-23T00:00:00Z".into(),
                deleted_at: None,
                attachments: vec![attachment.clone()],
            }],
        )
        .unwrap();
    let server = Arc::new(AttachmentServer {
        requests: Mutex::new(Vec::new()),
        item: StoredItem {
            id: ITEM_ID.into(),
            vault_id: TEST_VAULT_ID.into(),
            encrypted_data: item_ciphertext.ciphertext,
            encryption_iv: item_ciphertext.iv,
            encryption_algorithm: item_ciphertext.algorithm,
            version: 1,
            favorite: false,
            deleted_at: None,
        },
        attachment: Mutex::new(attachment_dto(attachment)),
        additional_owning_attachments: Mutex::new(Vec::new()),
        attachment_deleted: AtomicBool::new(false),
        delete_not_found: AtomicBool::new(false),
        lose_next_delete_response: AtomicBool::new(false),
        discard_next_delete: AtomicBool::new(false),
        lose_next_patch_response: AtomicBool::new(false),
        discard_next_patch: AtomicBool::new(false),
        unauthorized_patches: AtomicUsize::new(0),
        patch_calls: AtomicUsize::new(0),
        delete_calls: AtomicUsize::new(0),
        download_grant_calls: AtomicUsize::new(0),
        unauthorized_download_grants: AtomicUsize::new(0),
        denied_download_grants: AtomicUsize::new(0),
        download_grant_failure: AtomicBool::new(false),
        unauthorized_deletes: AtomicUsize::new(0),
        denied_deletes: AtomicUsize::new(0),
        refresh_calls: AtomicUsize::new(0),
        refresh_mode: AtomicUsize::new(0),
        refresh_release: Semaphore::new(0),
        hold_patch: AtomicBool::new(false),
        patch_release: Semaphore::new(0),
        hold_delete: AtomicBool::new(false),
        delete_release: Semaphore::new(0),
        hold_attachment_get: AtomicBool::new(false),
        attachment_get_calls: AtomicUsize::new(0),
        item_get_calls: AtomicUsize::new(0),
        attachment_get_release: Semaphore::new(0),
        item_get_failure: AtomicUsize::new(0),
        attachment_get_failure: AtomicUsize::new(0),
        attachment_page_mode: AtomicUsize::new(0),
        key_authority_drift_after_patch: AtomicUsize::new(0),
        address_authority_drift_after_patch: AtomicUsize::new(0),
        cancel_calls: AtomicUsize::new(0),
    });
    let replica = PlainReplica::new(state);
    let platform = MemoryPlatform::new();
    let clock = TestClock::new();
    let timer = TestTimer::advancing(Arc::clone(&clock));
    let runtime = Runtime::with_test_dispatch_environment(
        replica.clone(),
        platform,
        server.clone(),
        auth_config(),
        clock.clone(),
        timer.clone(),
    );
    runtime.replica().load(&account_id).await.unwrap().unwrap();
    runtime.unlock_account(&account_id).await.unwrap();
    store_session(&runtime, &account_id, FIRST_TOKEN).await;
    AttachmentHarness {
        runtime,
        account_id,
        server,
        replica,
        timer,
    }
}

#[tokio::test]
async fn download_publishes_only_after_complete_authenticated_multichunk_transfer() {
    let harness = seeded_attachment().await;
    let plaintext = b"forty-two plaintext bytes for atomic sink!";
    assert_eq!(plaintext.len(), 42);
    let (transfer, sink) = install_download(&harness, plaintext);

    let response = harness
        .runtime
        .request(
            RuntimeRequest::DownloadAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                sink_capability_id: "sink-one".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert_eq!(
        response,
        RuntimeResponse::AttachmentDownloaded {
            account_id: harness.account_id.clone(),
            attachment_id: ATTACHMENT_ID.into(),
        }
    );
    assert_eq!(transfer.opens.load(Ordering::SeqCst), 2);
    assert_eq!(
        harness.server.download_grant_calls.load(Ordering::SeqCst),
        1
    );
    let sink = sink.lock().unwrap();
    assert_eq!(sink.published.as_deref(), Some(plaintext.as_slice()));
    assert!(sink.provisional.is_empty());
    assert_eq!(sink.discards, 0);
    assert_eq!(
        sink.begins,
        [(ACCOUNT.into(), ATTACHMENT_ID.into(), "sink-one".into(),)]
    );
}

#[tokio::test]
async fn download_discards_every_provisional_byte_when_ciphertext_is_corrupted() {
    let harness = seeded_attachment().await;
    let plaintext = b"forty-two plaintext bytes for atomic sink!";
    let (transfer, sink) = install_download(&harness, plaintext);
    {
        let mut envelope = transfer.envelope.lock().unwrap();
        let position = envelope.iter().position(|byte| *byte == b'A').unwrap_or(20);
        envelope[position] = if envelope[position] == b'A' {
            b'B'
        } else {
            b'A'
        };
    }

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DownloadAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                sink_capability_id: "sink-corrupt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    let sink = sink.lock().unwrap();
    assert_eq!(sink.published, None);
    assert!(sink.provisional.is_empty());
    assert_eq!(sink.discards, 1);
}

#[tokio::test]
async fn download_discards_truncated_and_oversized_ciphertext_without_publication() {
    for shape in ["truncated", "oversized"] {
        let harness = seeded_attachment().await;
        let plaintext = b"forty-two plaintext bytes for atomic sink!";
        let (transfer, sink) = install_download(&harness, plaintext);
        {
            let mut envelope = transfer.envelope.lock().unwrap();
            if shape == "truncated" {
                let truncated_length = envelope.len() / 2;
                envelope.truncate(truncated_length);
            } else {
                envelope.extend(std::iter::repeat_n(b'X', 1_024));
            }
        }

        let error = harness
            .runtime
            .request(
                RuntimeRequest::DownloadAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    sink_capability_id: format!("sink-{shape}"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
        let sink = sink.lock().unwrap();
        assert_eq!(sink.published, None);
        assert!(sink.provisional.is_empty());
        assert_eq!(sink.discards, 1);
    }
}

#[tokio::test]
async fn download_renews_once_then_fetches_one_authoritative_grant_without_replaying_bytes() {
    let harness = seeded_attachment().await;
    let plaintext = b"forty-two plaintext bytes for atomic sink!";
    let (transfer, sink) = install_download(&harness, plaintext);
    harness
        .server
        .unauthorized_download_grants
        .store(1, Ordering::SeqCst);

    harness
        .runtime
        .request(
            RuntimeRequest::DownloadAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                sink_capability_id: "sink-renewed".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert_eq!(
        harness.server.download_grant_calls.load(Ordering::SeqCst),
        2
    );
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(transfer.opens.load(Ordering::SeqCst), 2);
    assert_eq!(
        sink.lock().unwrap().published.as_deref(),
        Some(plaintext.as_slice())
    );
    let grants = harness
        .server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.url.ends_with("/download-urls"))
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(grants.len(), 2);
    assert!(grants
        .iter()
        .all(|request| request.method == "POST" && request.body.is_empty()));
    assert!(grants[0]
        .headers
        .iter()
        .any(|(name, value)| name == "Authorization" && value == &format!("Bearer {FIRST_TOKEN}")));
    assert!(
        grants[1]
            .headers
            .iter()
            .any(|(name, value)| name == "Authorization"
                && value == &format!("Bearer {SECOND_TOKEN}"))
    );
}

#[tokio::test]
async fn download_sink_write_and_commit_failures_never_publish_partial_plaintext() {
    for failure in ["begin", "write", "commit"] {
        let harness = seeded_attachment().await;
        let plaintext = b"forty-two plaintext bytes for atomic sink!";
        let (_, sink) = install_download(&harness, plaintext);
        if failure == "begin" {
            sink.lock().unwrap().fail_begin = true;
        } else if failure == "write" {
            sink.lock().unwrap().fail_write = true;
        } else {
            sink.lock().unwrap().fail_commit = true;
        }
        let error = harness
            .runtime
            .request(
                RuntimeRequest::DownloadAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    sink_capability_id: format!("sink-{failure}"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::SinkFailure);
        let sink = sink.lock().unwrap();
        assert_eq!(sink.published, None);
        assert!(sink.provisional.is_empty());
        assert_eq!(sink.discards, 1);
    }
}

#[tokio::test]
async fn lock_and_close_cancel_and_drain_a_download_while_sink_begin_is_held() {
    for lifecycle in ["lock", "close"] {
        let harness = seeded_attachment().await;
        let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
        let begin_started = {
            let mut state = sink.lock().unwrap();
            state.hold_begin = true;
            Arc::clone(&state.begin_started)
        };
        let download = {
            let runtime = Arc::clone(&harness.runtime);
            let account_id = harness.account_id.clone();
            tokio::spawn(async move {
                runtime
                    .request(
                        RuntimeRequest::DownloadAttachment {
                            account_id,
                            attachment_id: ATTACHMENT_ID.into(),
                            sink_capability_id: format!("sink-held-begin-{lifecycle}"),
                        },
                        RequestCancellation::new(),
                    )
                    .await
            })
        };
        until("Download sink begin is held", || {
            begin_started.load(Ordering::SeqCst)
        })
        .await;
        if lifecycle == "lock" {
            harness
                .runtime
                .mark_account_locked(&harness.account_id)
                .await
                .unwrap();
        } else {
            harness.runtime.close().await;
        }
        assert_eq!(
            download.await.unwrap().unwrap_err().code,
            RuntimeErrorCode::Cancelled,
            "lifecycle={lifecycle}"
        );
        let sink = sink.lock().unwrap();
        assert_eq!(sink.discards, 1, "lifecycle={lifecycle}");
        assert!(sink.published.is_none(), "lifecycle={lifecycle}");
    }
}

#[tokio::test]
async fn close_cancels_and_drains_a_held_sink_begin_for_an_uninstalled_account() {
    let harness = seeded_attachment().await;
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    let begin_started = {
        let mut state = sink.lock().unwrap();
        state.hold_begin = true;
        Arc::clone(&state.begin_started)
    };
    let download = {
        let runtime = Arc::clone(&harness.runtime);
        tokio::spawn(async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id: AccountId::from("missing-account"),
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "sink-missing-held-begin".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        })
    };
    until("missing Account sink begin is held", || {
        begin_started.load(Ordering::SeqCst)
    })
    .await;
    harness.runtime.close().await;
    assert_eq!(
        download.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    assert_eq!(sink.lock().unwrap().discards, 1);
}

#[tokio::test]
async fn wipe_globally_drains_a_held_missing_account_sink_before_host_retirement() {
    let harness = seeded_attachment().await;
    *harness.runtime.attachment_move_lifecycle.lock().unwrap() =
        Some(Arc::new(AttachmentMoveLifecycle::new(
            Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
            Arc::new(SuccessfulAttachmentTeardown),
        )));
    harness
        .runtime
        .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    let (begin_started, discard_started, discard_release) = {
        let mut state = sink.lock().unwrap();
        state.hold_begin = true;
        state.hold_discard = true;
        (
            Arc::clone(&state.begin_started),
            Arc::clone(&state.discard_started),
            Arc::clone(&state.discard_release),
        )
    };
    let download = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id: AccountId::from("arbitrary-missing-account"),
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "sink-wipe-missing-held-begin".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    until("missing Account sink begin is held", || {
        begin_started.load(Ordering::SeqCst)
    })
    .await;
    let wipe = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        async move {
            runtime
                .request(RuntimeRequest::Wipe, RequestCancellation::new())
                .await
        }
    });
    until("Wipe cancellation reaches missing Account discard", || {
        discard_started.load(Ordering::SeqCst)
    })
    .await;
    assert_eq!(sink.lock().unwrap().runtime_retirements, 0);
    assert!(!wipe.is_finished());
    discard_release.add_permits(1);
    assert_eq!(
        download.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    wipe.await.unwrap().unwrap();
    let sink = sink.lock().unwrap();
    assert_eq!(sink.discards, 1);
    assert_eq!(sink.runtime_retirements, 1);
}

#[test]
fn idle_unresolved_foreground_scopes_are_collected_without_weakening_a_live_guard() {
    let registry = super::foreground_attachment_lifecycle::ForegroundAttachmentRegistry::default();
    let live = registry
        .register_unresolved(&AccountId::from("live-account"), RequestCancellation::new())
        .unwrap();
    for index in 0..4_096 {
        let guard = registry
            .register_unresolved(
                &AccountId::from(format!("arbitrary-{index}")),
                RequestCancellation::new(),
            )
            .unwrap();
        drop(guard);
        assert_eq!(registry.scope_count(), 1);
    }
    let retirement = registry.begin_account_retirement(&AccountId::from("live-account"));
    assert_eq!(registry.scope_count(), 1);
    drop(live);
    drop(retirement);
    assert_eq!(registry.scope_count(), 0);
}

#[tokio::test]
async fn download_http_and_binary_failures_discard_without_publication() {
    for failure in ["http", "binary-open", "binary-chunk"] {
        let harness = seeded_attachment().await;
        let plaintext = b"forty-two plaintext bytes for atomic sink!";
        let (transfer, sink) = install_download(&harness, plaintext);
        match failure {
            "http" => harness
                .server
                .download_grant_failure
                .store(true, Ordering::SeqCst),
            "binary-open" => transfer.fail_open.store(true, Ordering::SeqCst),
            "binary-chunk" => transfer.fail_chunk.store(true, Ordering::SeqCst),
            _ => unreachable!(),
        }

        let error = harness
            .runtime
            .request(
                RuntimeRequest::DownloadAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    sink_capability_id: format!("sink-{failure}"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
        let sink = sink.lock().unwrap();
        assert_eq!(sink.published, None);
        assert!(sink.provisional.is_empty());
        assert_eq!(sink.discards, 1);
    }
}

#[tokio::test]
async fn download_grant_forbidden_is_closed_access_denied_and_still_discards_the_sink() {
    let harness = seeded_attachment().await;
    let (transfer, sink) =
        install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    harness
        .server
        .denied_download_grants
        .store(1, Ordering::SeqCst);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DownloadAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                sink_capability_id: "grant-denied".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(transfer.opens.load(Ordering::SeqCst), 0);
    assert_eq!(sink.lock().unwrap().discards, 1);
}

#[tokio::test]
async fn download_rejects_wrong_grant_authority_before_binary_or_plaintext_output() {
    let harness = seeded_attachment().await;
    let plaintext = b"forty-two plaintext bytes for atomic sink!";
    let (transfer, sink) = install_download(&harness, plaintext);
    harness.server.attachment.lock().unwrap().storage_key = "foreign-storage".into();

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DownloadAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                sink_capability_id: "sink-stale".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(transfer.opens.load(Ordering::SeqCst), 0);
    let sink = sink.lock().unwrap();
    assert_eq!(sink.published, None);
    assert_eq!(sink.discards, 1);
}

#[tokio::test]
async fn download_cancellation_discards_the_atomic_sink_while_binary_open_is_pending() {
    let harness = seeded_attachment().await;
    let plaintext = b"forty-two plaintext bytes for atomic sink!";
    let (transfer, sink) = install_download(&harness, plaintext);
    transfer.hold_open.store(true, Ordering::SeqCst);
    let cancellation = RequestCancellation::new();
    let task = {
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        let cancellation = cancellation.clone();
        tokio::spawn(async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "sink-cancelled".into(),
                    },
                    cancellation,
                )
                .await
        })
    };
    while transfer.opens.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    cancellation.cancel();
    let error = task.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    let sink = sink.lock().unwrap();
    assert_eq!(sink.published, None);
    assert!(sink.provisional.is_empty());
    assert_eq!(sink.discards, 1);
}

#[tokio::test]
async fn download_discard_failure_retries_the_identical_owned_sink_until_cleanup_is_confirmed() {
    let harness = seeded_attachment().await;
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    sink.lock().unwrap().discard_failures_remaining = 2;
    let cancellation = RequestCancellation::new();
    cancellation.cancel();

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DownloadAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                sink_capability_id: "discard-retry-identity".into(),
            },
            cancellation,
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    let sink = sink.lock().unwrap();
    assert_eq!(sink.claims.len(), 1);
    assert_eq!(sink.discards, 3);
    assert!(sink.provisional.is_empty());
}

#[tokio::test]
async fn failed_download_cleanup_backs_off_instead_of_hot_polling() {
    let harness = seeded_attachment().await;
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    sink.lock().unwrap().discard_failures_remaining = 1;
    harness.timer.hold.store(true, Ordering::SeqCst);
    let cancellation = RequestCancellation::new();
    cancellation.cancel();
    let request = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "cleanup-backoff".into(),
                    },
                    cancellation,
                )
                .await
        }
    });
    until("first Download cleanup attempt fails", || {
        sink.lock().unwrap().discards == 1
    })
    .await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    assert_eq!(
        sink.lock().unwrap().discards,
        1,
        "cleanup failure must wait on a timer rather than hot-poll"
    );
    assert_eq!(harness.timer.requested(), [10]);
    harness.timer.hold.store(false, Ordering::SeqCst);
    harness.timer.released.notify_waiters();
    assert_eq!(
        request.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    assert_eq!(sink.lock().unwrap().discards, 2);
}

#[tokio::test]
async fn aborted_download_future_promptly_abandons_the_begun_atomic_sink_once() {
    let harness = seeded_attachment().await;
    let (transfer, sink) =
        install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    transfer.hold_open.store(true, Ordering::SeqCst);
    let download = {
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        tokio::spawn(async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "sink-aborted-task".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        })
    };
    until("Download sink begins before task abort", || {
        sink.lock().unwrap().begins.len() == 1
    })
    .await;
    download.abort();
    assert!(download.await.unwrap_err().is_cancelled());
    let sink = sink.lock().unwrap();
    assert!(sink.published.is_none());
    assert!(sink.provisional.is_empty());
    assert_eq!(sink.discards, 1);
}

#[tokio::test]
async fn caller_cancellation_winning_finalization_admission_discards_without_publication() {
    let harness = seeded_attachment().await;
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    let cancellation = RequestCancellation::new();
    harness
        .runtime
        .foreground_attachments
        .set_before_finalization_admission_hook(Some(Arc::new({
            let cancellation = cancellation.clone();
            move || cancellation.cancel()
        })));
    let error = harness
        .runtime
        .request(
            RuntimeRequest::DownloadAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                sink_capability_id: "sink-cancelled-at-admission".into(),
            },
            cancellation,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    let sink = sink.lock().unwrap();
    assert!(sink.published.is_none());
    assert_eq!(sink.discards, 1);
}

#[tokio::test]
async fn downloads_for_one_item_run_in_parallel_without_holding_the_account_execution_fence() {
    let harness = seeded_attachment().await;
    let plaintext = b"forty-two plaintext bytes for atomic sink!";
    let (transfer, _) = install_download(&harness, plaintext);
    transfer.hold_open.store(true, Ordering::SeqCst);
    let first = {
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        tokio::spawn(async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "sink-parallel-one".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        })
    };
    let second = {
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        tokio::spawn(async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "sink-parallel-two".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        })
    };
    while transfer.opens.load(Ordering::SeqCst) < 2 {
        tokio::task::yield_now().await;
    }
    transfer.hold_open.store(false, Ordering::SeqCst);
    transfer.open_release.add_permits(2);
    assert!(first.await.unwrap().is_ok());
    assert!(second.await.unwrap().is_ok());
}

#[tokio::test]
async fn lock_cancels_download_and_waits_for_atomic_sink_discard_before_retiring_keys() {
    let harness = seeded_attachment().await;
    let plaintext = b"forty-two plaintext bytes for atomic sink!";
    let (transfer, sink) = install_download(&harness, plaintext);
    transfer.hold_open.store(true, Ordering::SeqCst);
    let download = {
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        tokio::spawn(async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "sink-lock".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        })
    };
    while transfer.opens.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }
    let lock = harness
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: harness.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        lock,
        RuntimeResponse::AccessChanged {
            account_id: harness.account_id.clone(),
            access: AccountAccessState::Locked,
        }
    );
    assert_eq!(
        download.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    let sink = sink.lock().unwrap();
    assert_eq!(sink.published, None);
    assert!(sink.provisional.is_empty());
    assert_eq!(sink.discards, 1);
    assert!(!harness
        .runtime
        .has_live_master_unlock_key(&harness.account_id, &Incarnation::from(INCARNATION),));
}

#[tokio::test]
async fn aborted_download_transfers_cleanup_ownership_that_lock_remove_and_wipe_must_drain() {
    for lifecycle in ["lock", "remove", "wipe"] {
        let harness = seeded_attachment().await;
        *harness.runtime.attachment_move_lifecycle.lock().unwrap() =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                Arc::new(SuccessfulAttachmentTeardown),
            )));
        harness
            .runtime
            .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
        let (transfer, sink) =
            install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
        transfer.hold_open.store(true, Ordering::SeqCst);
        let (discard_started, discard_release) = {
            let mut state = sink.lock().unwrap();
            state.hold_discard = true;
            (
                Arc::clone(&state.discard_started),
                Arc::clone(&state.discard_release),
            )
        };
        let download = tokio::spawn({
            let runtime = Arc::clone(&harness.runtime);
            let account_id = harness.account_id.clone();
            async move {
                runtime
                    .request(
                        RuntimeRequest::DownloadAttachment {
                            account_id,
                            attachment_id: ATTACHMENT_ID.into(),
                            sink_capability_id: format!("aborted-{lifecycle}"),
                        },
                        RequestCancellation::new(),
                    )
                    .await
            }
        });
        until("Download reaches held binary open", || {
            transfer.opens.load(Ordering::SeqCst) > 0
        })
        .await;
        download.abort();
        let _ = download.await;
        until("aborted Download cleanup reaches the sink", || {
            discard_started.load(Ordering::SeqCst)
        })
        .await;

        let retirement = tokio::spawn({
            let runtime = Arc::clone(&harness.runtime);
            let account_id = harness.account_id.clone();
            async move {
                match lifecycle {
                    "lock" => runtime
                        .request(
                            RuntimeRequest::Lock { account_id },
                            RequestCancellation::new(),
                        )
                        .await
                        .map(|_| ()),
                    "remove" => runtime
                        .request(
                            RuntimeRequest::RemoveAccount { account_id },
                            RequestCancellation::new(),
                        )
                        .await
                        .map(|_| ()),
                    "wipe" => runtime
                        .request(RuntimeRequest::Wipe, RequestCancellation::new())
                        .await
                        .map(|_| ()),
                    _ => unreachable!(),
                }
            }
        });
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert!(
            !retirement.is_finished(),
            "{lifecycle} retired authority before abandoned sink cleanup"
        );
        discard_release.add_permits(1);
        retirement.await.unwrap().unwrap();
        assert_eq!(sink.lock().unwrap().discards, 1, "{lifecycle}");
    }
}

#[tokio::test]
async fn every_lifecycle_wins_precommit_admission_and_discards_without_publication() {
    for lifecycle in 0..5 {
        let harness = seeded_attachment().await;
        *harness.runtime.attachment_move_lifecycle.lock().unwrap() =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                Arc::new(SuccessfulAttachmentTeardown),
            )));
        harness
            .runtime
            .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
        let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
        let reached = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        harness
            .runtime
            .foreground_attachments
            .set_before_finalization_admission_hook(Some(Arc::new({
                let reached = Arc::clone(&reached);
                let release = Arc::clone(&release);
                move || {
                    reached.store(true, Ordering::SeqCst);
                    while !release.load(Ordering::SeqCst) {
                        std::thread::yield_now();
                    }
                }
            })));
        let cancellation = RequestCancellation::new();
        let download = std::thread::spawn({
            let runtime = Arc::clone(&harness.runtime);
            let account_id = harness.account_id.clone();
            let cancellation = cancellation.clone();
            move || {
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap()
                    .block_on(runtime.request(
                        RuntimeRequest::DownloadAttachment {
                            account_id,
                            attachment_id: ATTACHMENT_ID.into(),
                            sink_capability_id: format!("sink-precommit-{lifecycle}"),
                        },
                        cancellation,
                    ))
            }
        });
        until("Download reaches finalization admission", || {
            reached.load(Ordering::SeqCst)
        })
        .await;
        let lifecycle_task = {
            let runtime = Arc::clone(&harness.runtime);
            let account_id = harness.account_id.clone();
            tokio::spawn(async move {
                match lifecycle {
                    0 => runtime
                        .request(
                            RuntimeRequest::Lock { account_id },
                            RequestCancellation::new(),
                        )
                        .await
                        .map(|_| ()),
                    1 => runtime
                        .request(
                            RuntimeRequest::SignOut { account_id },
                            RequestCancellation::new(),
                        )
                        .await
                        .map(|_| ()),
                    2 => runtime
                        .request(
                            RuntimeRequest::RemoveAccount { account_id },
                            RequestCancellation::new(),
                        )
                        .await
                        .map(|_| ()),
                    3 => runtime
                        .request(RuntimeRequest::Wipe, RequestCancellation::new())
                        .await
                        .map(|_| ()),
                    _ => {
                        runtime.close().await;
                        Ok(())
                    }
                }
            })
        };
        until("lifecycle cancels before finalization", || {
            cancellation.is_cancelled()
        })
        .await;
        release.store(true, Ordering::SeqCst);
        assert_eq!(
            download.join().unwrap().unwrap_err().code,
            RuntimeErrorCode::Cancelled,
            "lifecycle={lifecycle}"
        );
        lifecycle_task.await.unwrap().unwrap();
        let sink = sink.lock().unwrap();
        assert!(sink.published.is_none(), "lifecycle={lifecycle}");
        assert!(sink.provisional.is_empty(), "lifecycle={lifecycle}");
        assert_eq!(sink.discards, 1, "lifecycle={lifecycle}");
    }
}

#[tokio::test]
async fn admitted_commit_is_drained_by_lock_before_key_retirement() {
    let harness = seeded_attachment().await;
    let (_, sink) = install_download(&harness, b"forty-two plaintext bytes for atomic sink!");
    {
        let mut state = sink.lock().unwrap();
        state.hold_commit = true;
    }
    let (commit_started, commit_release) = {
        let state = sink.lock().unwrap();
        (
            Arc::clone(&state.commit_started),
            Arc::clone(&state.commit_release),
        )
    };
    let download = {
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        tokio::spawn(async move {
            runtime
                .request(
                    RuntimeRequest::DownloadAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        sink_capability_id: "sink-admitted-commit".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        })
    };
    until("sink commit begins", || {
        commit_started.load(Ordering::SeqCst)
    })
    .await;
    let lock = {
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        tokio::spawn(async move {
            runtime
                .request(
                    RuntimeRequest::Lock { account_id },
                    RequestCancellation::new(),
                )
                .await
        })
    };
    tokio::task::yield_now().await;
    assert!(
        !lock.is_finished(),
        "Lock must drain an admitted sink commit"
    );
    assert!(harness
        .runtime
        .has_live_master_unlock_key(&harness.account_id, &Incarnation::from(INCARNATION)));
    commit_release.add_permits(1);
    assert!(download.await.unwrap().is_ok());
    lock.await.unwrap().unwrap();
    assert!(sink.lock().unwrap().published.is_some());
    assert!(!harness
        .runtime
        .has_live_master_unlock_key(&harness.account_id, &Incarnation::from(INCARNATION)));
}

async fn seeded_attachment_with_unrelated_authority() -> AttachmentHarness {
    let harness = seeded_attachment().await;
    let observed = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let mut owning_item = observed.bootstrap.snapshot().visible_items[0].clone();
    let owning_attachment = attachment_authority_for(
        "attachment-sibling",
        ITEM_ID,
        "sibling.txt",
        "attachments/item-existing/sibling.enc",
    );
    owning_item.attachments.push(owning_attachment.clone());

    let other_item_id = "item-unrelated";
    let other_item_ciphertext = encrypt_with_aad(
        &serde_json::to_string(&draft()).unwrap(),
        &TEST_VAULT_KEY,
        &AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: other_item_id.into(),
            entity_type: "item".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    let other_attachment = attachment_authority_for(
        "attachment-unrelated",
        other_item_id,
        "unrelated.txt",
        "attachments/item-unrelated/unrelated.enc",
    );
    let other_item = AuthorityItemRecord {
        id: other_item_id.into(),
        vault_id: TEST_VAULT_ID.into(),
        category: AuthorityItemCategory::Login,
        favorite: false,
        encrypted_data: other_item_ciphertext.ciphertext,
        encryption_iv: other_item_ciphertext.iv,
        encryption_algorithm: other_item_ciphertext.algorithm,
        version: 1,
        encryption_version: 1,
        encrypted_by_user_id: USER.into(),
        last_modified_by: USER.into(),
        created_at: "2026-08-23T00:00:00Z".into(),
        updated_at: "2026-08-23T00:00:00Z".into(),
        deleted_at: None,
        attachments: vec![other_attachment.clone()],
    };
    assert!(matches!(
        harness
            .runtime
            .execute_plan(GuardedCommitPlan::new(
                harness.account_id.clone(),
                observed.incarnation,
                observed.revision,
                observed.lock_epoch,
                vec![
                    PlanMutation::CommitAttachmentAuthority {
                        attachment_id: owning_attachment.id.clone(),
                        attachment_present: true,
                        item: Box::new(owning_item),
                    },
                    PlanMutation::CommitAttachmentAuthority {
                        attachment_id: other_attachment.id.clone(),
                        attachment_present: true,
                        item: Box::new(other_item),
                    },
                ],
            ))
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));
    harness
        .server
        .additional_owning_attachments
        .lock()
        .unwrap()
        .push(attachment_dto(owning_attachment));
    harness
        .runtime
        .decrypt_visible_items(&harness.account_id)
        .unwrap();
    harness
}

#[tokio::test]
async fn successful_delete_uses_exact_bodyless_route_and_publishes_authoritative_absence() {
    let harness = seeded_attachment().await;

    let response = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert_eq!(
        response,
        RuntimeResponse::AttachmentDeleted {
            account_id: harness.account_id.clone(),
            attachment_id: ATTACHMENT_ID.into(),
        }
    );
    let deletes = harness.server.deletes();
    assert_eq!(deletes.len(), 1);
    assert_eq!(
        deletes[0].url,
        format!("{SERVER_URL}/api/v1/attachments/{ATTACHMENT_ID}")
    );
    assert_eq!(
        deletes[0].header("authorization"),
        Some("Bearer session-token-1")
    );
    assert_eq!(deletes[0].header("content-type"), None);
    assert!(deletes[0].body.is_empty());
    assert!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0]
            .attachments
            .is_empty()
    );
}

#[tokio::test]
async fn lost_delete_response_converges_only_after_authoritative_absence_without_resend() {
    let harness = seeded_attachment().await;
    harness
        .server
        .lose_next_delete_response
        .store(true, Ordering::SeqCst);

    harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert_eq!(harness.server.delete_calls.load(Ordering::SeqCst), 1);
    assert!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0]
            .attachments
            .is_empty()
    );
}

#[tokio::test]
async fn delete_transport_success_with_authority_still_present_is_retryable_without_resend() {
    let harness = seeded_attachment().await;
    harness
        .server
        .discard_next_delete
        .store(true, Ordering::SeqCst);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.delete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0]
            .attachments
            .len(),
        1
    );
}

#[tokio::test]
async fn delete_not_found_with_target_still_present_is_retryable_without_replica_publication() {
    let harness = seeded_attachment().await;
    harness
        .server
        .delete_not_found
        .store(true, Ordering::SeqCst);
    let sink = Arc::new(AttachmentSink::default());
    let _observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let publications_before = sink.0.lock().unwrap().len();
    let revision_before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .revision;

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.item_get_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.server.attachment_get_calls.load(Ordering::SeqCst),
        1
    );
    let deletes = harness.server.deletes();
    assert_eq!(deletes.len(), 1);
    assert_eq!(
        deletes[0].url,
        format!("{SERVER_URL}/api/v1/attachments/{ATTACHMENT_ID}")
    );
    assert!(deletes[0].body.is_empty());
    assert_eq!(deletes[0].header("content-type"), None);
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        revision_before
    );
    assert_eq!(sink.0.lock().unwrap().len(), publications_before);
}

#[tokio::test]
async fn delete_not_found_succeeds_only_after_item_and_attachment_authority_prove_absence() {
    let harness = seeded_attachment().await;
    harness
        .server
        .delete_not_found
        .store(true, Ordering::SeqCst);
    harness
        .server
        .attachment_deleted
        .store(true, Ordering::SeqCst);
    harness
        .server
        .hold_attachment_get
        .store(true, Ordering::SeqCst);
    let revision_before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .revision;
    let deletion = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::DeleteAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    until("404 Delete reaches its Attachment authority probe", || {
        harness.server.attachment_get_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    assert_eq!(harness.server.item_get_calls.load(Ordering::SeqCst), 1);
    assert!(!deletion.is_finished());
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        revision_before
    );
    harness
        .server
        .hold_attachment_get
        .store(false, Ordering::SeqCst);
    harness.server.attachment_get_release.add_permits(1);

    assert!(matches!(
        deletion.await.unwrap().unwrap(),
        RuntimeResponse::AttachmentDeleted { .. }
    ));
    assert_eq!(harness.server.deletes().len(), 1);
    assert_eq!(
        harness.server.attachment_get_calls.load(Ordering::SeqCst),
        1
    );
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        revision_before + 1
    );
}

#[tokio::test]
async fn missing_owning_item_after_delete_is_authority_missing_without_replica_publication() {
    let harness = seeded_attachment().await;
    harness.server.item_get_failure.store(5, Ordering::SeqCst);
    let sink = Arc::new(AttachmentSink::default());
    let _observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let publications_before = sink.0.lock().unwrap().len();
    let before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::AuthorityMissing);
    assert_eq!(harness.server.deletes().len(), 1);
    assert_eq!(harness.server.item_get_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.server.attachment_get_calls.load(Ordering::SeqCst),
        0
    );
    assert_eq!(
        harness.runtime.replica().snapshot(&harness.account_id),
        Some(before)
    );
    assert_eq!(sink.0.lock().unwrap().len(), publications_before);
}

#[tokio::test]
async fn finite_multipage_absence_removes_only_the_target_and_publishes_once() {
    let harness = seeded_attachment_with_unrelated_authority().await;
    harness
        .server
        .attachment_page_mode
        .store(3, Ordering::SeqCst);
    let sink = Arc::new(AttachmentSink::default());
    let _observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let publications_before = sink.0.lock().unwrap().len();
    let revision_before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .revision;

    assert!(matches!(
        harness
            .runtime
            .request(
                RuntimeRequest::DeleteAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap(),
        RuntimeResponse::AttachmentDeleted { .. }
    ));

    assert_eq!(harness.server.deletes().len(), 1);
    assert_eq!(harness.server.item_get_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.server.attachment_get_calls.load(Ordering::SeqCst),
        3
    );
    let attachment_gets = harness
        .server
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|request| {
            request.method == "GET" && request.url.contains(&format!("/{ITEM_ID}/attachments"))
        })
        .map(|request| request.url.clone())
        .collect::<Vec<_>>();
    assert_eq!(attachment_gets.len(), 3);
    assert!(!attachment_gets[0].contains("cursor="));
    assert!(attachment_gets[1].contains("cursor=authority-1"));
    assert!(attachment_gets[2].contains("cursor=authority-2"));
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        revision_before + 1
    );
    let publications = sink.0.lock().unwrap();
    assert_eq!(publications.len(), publications_before + 1);
    let RuntimeProjection::Items(items) = publications.last().unwrap() else {
        panic!("Attachment Delete observation published another projection kind");
    };
    let owning = items
        .items
        .iter()
        .find(|item| item.item_id == ITEM_ID)
        .unwrap();
    assert!(!owning
        .attachments
        .iter()
        .any(|attachment| attachment.attachment_id == ATTACHMENT_ID));
    assert!(owning
        .attachments
        .iter()
        .any(|attachment| attachment.attachment_id == "attachment-sibling"));
    let unrelated = items
        .items
        .iter()
        .find(|item| item.item_id == "item-unrelated")
        .unwrap();
    assert_eq!(
        unrelated.attachments[0].attachment_id,
        "attachment-unrelated"
    );
}

#[tokio::test]
async fn delete_renews_once_then_replays_the_exact_bodyless_request() {
    let harness = seeded_attachment().await;
    harness
        .server
        .unauthorized_deletes
        .store(1, Ordering::SeqCst);

    harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    let deletes = harness.server.deletes();
    assert_eq!(deletes.len(), 2);
    assert_eq!(deletes[0].url, deletes[1].url);
    assert!(deletes.iter().all(|delete| delete.body.is_empty()));
    assert_eq!(
        deletes[0].header("authorization"),
        Some("Bearer session-token-1")
    );
    assert_eq!(
        deletes[1].header("authorization"),
        Some("Bearer session-token-2")
    );
}

#[tokio::test]
async fn malformed_foreign_and_transient_delete_authority_never_manufactures_success() {
    for (stage, fault, expected) in [
        ("item-network", 1usize, RuntimeErrorCode::RetryableTransport),
        ("item-malformed", 3, RuntimeErrorCode::InvariantViolation),
        ("item-foreign", 4, RuntimeErrorCode::InvariantViolation),
        (
            "attachment-network",
            1,
            RuntimeErrorCode::RetryableTransport,
        ),
        (
            "attachment-malformed",
            3,
            RuntimeErrorCode::InvariantViolation,
        ),
        (
            "attachment-foreign-item",
            4,
            RuntimeErrorCode::InvariantViolation,
        ),
        (
            "attachment-foreign-vault",
            5,
            RuntimeErrorCode::InvariantViolation,
        ),
    ] {
        let harness = seeded_attachment().await;
        if stage.starts_with("item-") {
            harness
                .server
                .item_get_failure
                .store(fault, Ordering::SeqCst);
        } else {
            harness
                .server
                .attachment_get_failure
                .store(fault, Ordering::SeqCst);
        }

        let error = harness
            .runtime
            .request(
                RuntimeRequest::DeleteAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, expected, "{stage}");
        assert_eq!(harness.server.delete_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0]
                .attachments
                .len(),
            1,
            "{stage}"
        );
    }
}

#[tokio::test]
async fn active_item_operation_refuses_delete_before_transport() {
    let harness = seeded_attachment().await;
    assert!(matches!(
        harness
            .runtime
            .request(
                create_share(&harness.account_id),
                RequestCancellation::new()
            )
            .await
            .unwrap(),
        RuntimeResponse::Accepted { .. }
    ));

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.delete_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn active_attachment_move_refuses_delete_before_transport() {
    let harness = seeded_attachment().await;
    harness
        .runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: harness.account_id.clone(),
                item_id: ITEM_ID.into(),
                target_vault_id: "vault-2".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.delete_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        harness.runtime.replica().snapshot(&harness.account_id),
        Some(before)
    );
}

#[tokio::test]
async fn delete_and_rename_share_the_same_item_writer() {
    let harness = seeded_attachment().await;
    harness.server.hold_delete.store(true, Ordering::SeqCst);
    let delete = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::DeleteAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    until("Delete owns the Item writer", || {
        harness.server.delete_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let rename = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::RenameAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        name: "must-wait.txt".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    settle().await;
    assert!(!rename.is_finished());
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 0);

    harness.server.hold_delete.store(false, Ordering::SeqCst);
    harness.server.delete_release.add_permits(1);
    assert!(matches!(
        delete.await.unwrap().unwrap(),
        RuntimeResponse::AttachmentDeleted { .. }
    ));
    assert_eq!(
        rename.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::AuthorityMissing
    );
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn account_lock_cancels_and_drains_a_hung_foreground_delete() {
    let harness = seeded_attachment().await;
    harness.server.hold_delete.store(true, Ordering::SeqCst);
    let delete = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::DeleteAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    until("Delete reaches transport", || {
        harness.server.delete_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let lock = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move { runtime.mark_account_locked(&account_id).await }
    });
    until("Lock cancels and drains Delete", || {
        lock.is_finished() && delete.is_finished()
    })
    .await;

    assert_eq!(
        delete.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    lock.await.unwrap().unwrap();
    assert_eq!(harness.server.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(!harness
        .runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&harness.account_id));
}

#[tokio::test]
async fn delete_rejects_missing_denied_and_cancelled_requests_without_false_success() {
    let harness = seeded_attachment().await;
    let missing = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: "missing-attachment".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(missing.code, RuntimeErrorCode::AuthorityMissing);
    assert_eq!(harness.server.delete_calls.load(Ordering::SeqCst), 0);

    harness.server.denied_deletes.store(1, Ordering::SeqCst);
    let denied = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(denied.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(harness.server.delete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0]
            .attachments
            .len(),
        1
    );

    let cancellation = RequestCancellation::new();
    cancellation.cancel();
    let cancelled = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            cancellation,
        )
        .await
        .unwrap_err();
    assert_eq!(cancelled.code, RuntimeErrorCode::Cancelled);
    assert_eq!(harness.server.delete_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn read_only_attachment_delete_is_rejected_before_transport() {
    let harness = seeded_attachment_with_role(AuthorityVaultRole::ReadOnly).await;

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::ReadOnly);
    assert_eq!(harness.server.delete_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn newer_background_authority_wins_the_guarded_delete_commit() {
    let harness = seeded_attachment().await;
    harness
        .server
        .hold_attachment_get
        .store(true, Ordering::SeqCst);
    let deletion = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::DeleteAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    until("Delete pauses at Attachment authority", || {
        harness.server.attachment_get_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let background = Replica::new(Arc::new(SerializedReplicaPersistence::new(
        harness.replica.clone(),
    )));
    let observed = background.load(&harness.account_id).await.unwrap().unwrap();
    let mut item = observed.bootstrap.snapshot().visible_items[0].clone();
    item.version = 2;
    item.updated_at = "2026-08-28T14:00:00Z".into();
    assert!(matches!(
        background
            .execute(GuardedCommitPlan::new(
                harness.account_id.clone(),
                observed.incarnation,
                observed.revision,
                observed.lock_epoch,
                vec![PlanMutation::CommitAttachmentAuthority {
                    attachment_id: ATTACHMENT_ID.into(),
                    attachment_present: true,
                    item: Box::new(item),
                }],
            ))
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));

    harness
        .server
        .hold_attachment_get
        .store(false, Ordering::SeqCst);
    harness.server.attachment_get_release.add_permits(1);
    let error = deletion.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    harness
        .runtime
        .decrypt_visible_items(&harness.account_id)
        .unwrap();
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0]
            .attachments
            .len(),
        1
    );
}

#[tokio::test]
async fn stale_fetched_item_cannot_turn_delete_into_revision_only_success() {
    let harness = seeded_attachment().await;
    let observed = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let mut newer = observed.bootstrap.snapshot().visible_items[0].clone();
    newer.version = 2;
    newer.updated_at = "2026-08-28T15:00:00Z".into();
    assert!(matches!(
        harness
            .runtime
            .execute_plan(GuardedCommitPlan::new(
                harness.account_id.clone(),
                observed.incarnation,
                observed.revision,
                observed.lock_epoch,
                vec![PlanMutation::CommitAttachmentAuthority {
                    attachment_id: ATTACHMENT_ID.into(),
                    attachment_present: true,
                    item: Box::new(newer),
                }],
            ))
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));
    let before_delete = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(
        harness.runtime.replica().snapshot(&harness.account_id),
        Some(before_delete)
    );
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0]
            .attachments
            .len(),
        1
    );
}

#[tokio::test]
async fn runtime_close_cancels_and_drains_a_hung_delete_probe() {
    let harness = seeded_attachment().await;
    harness
        .server
        .hold_attachment_get
        .store(true, Ordering::SeqCst);
    let deletion = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::DeleteAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    until("Delete reaches its Attachment authority probe", || {
        harness.server.attachment_get_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let close = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        async move { runtime.close().await }
    });
    until("close cancels and drains Delete", || {
        close.is_finished() && deletion.is_finished()
    })
    .await;

    assert_eq!(
        deletion.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    close.await.unwrap();
    assert_eq!(harness.server.delete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(harness.runtime.is_closed());
}

#[tokio::test]
async fn delete_commit_failure_preserves_replica_and_never_publishes_success() {
    let harness = seeded_attachment().await;
    let before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    harness.replica.fail_next_commits(1);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        harness.runtime.replica().snapshot(&harness.account_id),
        Some(before)
    );
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0]
            .attachments
            .len(),
        1
    );
}

#[tokio::test]
async fn delete_releases_all_guards_before_a_synchronous_reentrant_callback() {
    let harness = seeded_attachment().await;
    let sink = Arc::new(ReentrantAttachmentSink {
        publications: Mutex::new(Vec::new()),
        callback: Mutex::new(None),
    });
    let _observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let callback_completed = Arc::new(AtomicBool::new(false));
    *sink.callback.lock().unwrap() = Some(Box::new({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        let callback_completed = Arc::clone(&callback_completed);
        move || {
            let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
            let lifecycle = std::thread::spawn(move || {
                let runtime_thread = tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap();
                let completed = runtime_thread.block_on(async {
                    runtime
                        .request(
                            RuntimeRequest::Lock { account_id },
                            RequestCancellation::new(),
                        )
                        .await
                        .is_ok()
                });
                finished_tx.send(completed).unwrap();
            });
            assert!(finished_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("Lock deadlocked on the begun Delete callback"));
            lifecycle.join().unwrap();
            callback_completed.store(true, Ordering::SeqCst);
        }
    }));

    let response = harness
        .runtime
        .request(
            RuntimeRequest::DeleteAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert!(matches!(
        response,
        RuntimeResponse::AttachmentDeleted { .. }
    ));
    assert!(callback_completed.load(Ordering::SeqCst));
    assert!(!harness
        .runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&harness.account_id));
}

#[tokio::test]
async fn repeated_rename_uses_exact_patch_and_preserves_readable_key_authority() {
    let harness = seeded_attachment().await;
    let original_key = harness
        .server
        .attachment
        .lock()
        .unwrap()
        .encrypted_attachment_key
        .clone();
    for name in ["first-name.txt", "second-name.txt"] {
        let response = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: name.into(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        assert!(matches!(
            response,
            RuntimeResponse::AttachmentRenamed { .. }
        ));
        let items = harness.runtime.unlocked_items.lock().unwrap();
        assert_eq!(items[&harness.account_id][0].attachments[0].name, name);
        assert!(
            serde_json::to_value(&items[&harness.account_id][0].attachments[0])
                .unwrap()
                .get("storageKey")
                .is_none()
        );
    }
    let patches = harness.server.patches();
    assert_eq!(patches.len(), 2);
    for patch in patches {
        assert_eq!(
            patch.url,
            format!("{SERVER_URL}/api/v1/attachments/{ATTACHMENT_ID}")
        );
        assert_eq!(
            patch.header("content-type"),
            Some("application/merge-patch+json")
        );
        assert_eq!(
            patch.header("authorization"),
            Some("Bearer session-token-1")
        );
        let body: Value = serde_json::from_slice(&patch.body).unwrap();
        assert_eq!(body.as_object().unwrap().len(), 3);
        assert!(body.get("encryptedName").is_some());
        assert!(body.get("encryptionIv").is_some());
        assert_eq!(body["encryptionAlgorithm"], "AES-GCM-AAD-V1");
    }
    let attachment = harness.server.attachment.lock().unwrap();
    assert_eq!(attachment.envelope_version, 1);
    assert_eq!(attachment.encrypted_attachment_key, original_key);
}

#[tokio::test]
async fn successful_rename_advances_and_publishes_the_projection_once() {
    let harness = seeded_attachment().await;
    let items_sink = Arc::new(AttachmentSink::default());
    let _items_observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            items_sink.clone(),
        )
        .unwrap();
    let status_sink = Arc::new(AttachmentSink::default());
    let _status_observation = harness
        .runtime
        .observe(
            ObservationRequest::RuntimeStatus {
                account_id: Some(harness.account_id.clone()),
            },
            status_sink.clone(),
        )
        .unwrap();
    let items_publications_before = items_sink.0.lock().unwrap().len();
    let status_publications_before = status_sink.0.lock().unwrap().len();
    let status_revision_before = match status_sink.0.lock().unwrap().last().unwrap() {
        RuntimeProjection::RuntimeStatus(status) => status.revision,
        _ => panic!("Runtime-status observation published another projection kind"),
    };

    harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "published-once.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    let items_publications = items_sink.0.lock().unwrap();
    assert_eq!(items_publications.len(), items_publications_before + 1);
    let RuntimeProjection::Items(items) = items_publications.last().unwrap() else {
        panic!("Attachment observation published another projection kind");
    };
    assert_eq!(items.items[0].attachments[0].name, "published-once.txt");
    let status_publications = status_sink.0.lock().unwrap();
    assert_eq!(status_publications.len(), status_publications_before + 1);
    let RuntimeProjection::RuntimeStatus(status) = status_publications.last().unwrap() else {
        panic!("Runtime-status observation published another projection kind");
    };
    assert_eq!(status.revision, status_revision_before + 1);
}

#[tokio::test]
async fn ambiguous_rename_probes_authority_without_blind_resubmission() {
    let harness = seeded_attachment().await;
    harness
        .server
        .lose_next_patch_response
        .store(true, Ordering::SeqCst);

    harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "proved-after-loss.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "proved-after-loss.txt"
    );
}

#[tokio::test]
async fn ambiguous_rename_that_authority_does_not_prove_is_retryable_without_resubmission() {
    let harness = seeded_attachment().await;
    harness
        .server
        .lose_next_patch_response
        .store(true, Ordering::SeqCst);
    harness
        .server
        .discard_next_patch
        .store(true, Ordering::SeqCst);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "unproved-after-loss.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "original.txt"
    );
}

#[tokio::test]
async fn changed_key_envelope_authority_after_patch_is_retryable_without_replica_publication() {
    for (field, drift) in [
        ("envelope-version", 1usize),
        ("encrypted-attachment-key", 2),
        ("attachment-key-iv", 3),
        ("attachment-key-algorithm", 4),
    ] {
        let harness = seeded_attachment().await;
        let before = harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap();
        harness
            .server
            .key_authority_drift_after_patch
            .store(drift, Ordering::SeqCst);

        let error = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("drifted-{field}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::RetryableTransport, "{field}");
        assert_eq!(
            harness.server.patch_calls.load(Ordering::SeqCst),
            1,
            "{field}"
        );
        assert_eq!(
            harness.runtime.replica().snapshot(&harness.account_id),
            Some(before),
            "{field}"
        );
        assert_eq!(
            harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0]
                .name,
            "original.txt",
            "{field}"
        );
    }
}

#[tokio::test]
async fn changed_uploader_and_attachment_address_authority_is_retryable_without_publication() {
    for (field, drift) in [
        ("uploader", 1usize),
        ("attachment-id", 2),
        ("item-id", 3),
        ("vault-id", 4),
    ] {
        let harness = seeded_attachment().await;
        let before = harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap();
        harness
            .server
            .address_authority_drift_after_patch
            .store(drift, Ordering::SeqCst);

        let error = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("drifted-{field}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::RetryableTransport, "{field}");
        assert_eq!(
            harness.server.patch_calls.load(Ordering::SeqCst),
            1,
            "{field}"
        );
        assert_eq!(
            harness.runtime.replica().snapshot(&harness.account_id),
            Some(before),
            "{field}"
        );
        assert_eq!(
            harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0]
                .name,
            "original.txt",
            "{field}"
        );
    }
}

#[tokio::test]
async fn transient_failure_at_each_authority_probe_is_retryable_without_resend_or_publication() {
    for (stage, fault) in [
        ("item-network", 1usize),
        ("item-too-large", 2),
        ("attachment-network", 1),
        ("attachment-too-large", 2),
    ] {
        let harness = seeded_attachment().await;
        if stage.starts_with("item-") {
            harness
                .server
                .item_get_failure
                .store(fault, Ordering::SeqCst);
        } else {
            harness
                .server
                .attachment_get_failure
                .store(fault, Ordering::SeqCst);
        }

        let error = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("{stage}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::RetryableTransport, "{stage}");
        assert_eq!(
            harness.server.patch_calls.load(Ordering::SeqCst),
            1,
            "{stage}"
        );
        assert_eq!(
            harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0]
                .name,
            "original.txt",
            "{stage}"
        );
    }
}

#[tokio::test]
async fn malformed_and_foreign_authority_fail_closed_without_resend_or_publication() {
    for (stage, fault) in [
        ("item-malformed", 3usize),
        ("item-foreign", 4),
        ("attachment-malformed", 3),
        ("attachment-foreign-item", 4),
        ("attachment-foreign-vault", 5),
    ] {
        let harness = seeded_attachment().await;
        if stage.starts_with("item-") {
            harness
                .server
                .item_get_failure
                .store(fault, Ordering::SeqCst);
        } else {
            harness
                .server
                .attachment_get_failure
                .store(fault, Ordering::SeqCst);
        }

        let error = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("{stage}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation, "{stage}");
        assert_eq!(
            harness.server.patch_calls.load(Ordering::SeqCst),
            1,
            "{stage}"
        );
        assert_eq!(
            harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0]
                .name,
            "original.txt",
            "{stage}"
        );
    }
}

#[tokio::test]
async fn unique_attachment_authority_cursors_exhaust_the_bound_without_publication() {
    let harness = seeded_attachment().await;
    harness
        .server
        .attachment_page_mode
        .store(1, Ordering::SeqCst);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "cursor-exhaustion.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "original.txt"
    );
}

#[tokio::test]
async fn oversized_attachment_authority_aggregate_fails_without_publication() {
    let harness = seeded_attachment().await;
    harness
        .server
        .attachment_page_mode
        .store(2, Ordering::SeqCst);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "aggregate-exhaustion.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness.server.attachment_get_calls.load(Ordering::SeqCst),
        9
    );
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "original.txt"
    );
}

#[tokio::test]
async fn rename_renews_at_most_once_and_replays_exact_bytes_only_after_unauthorized() {
    let harness = seeded_attachment().await;
    harness
        .server
        .unauthorized_patches
        .store(1, Ordering::SeqCst);

    harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "after-renewal.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();

    let patches = harness.server.patches();
    assert_eq!(patches.len(), 2);
    assert_eq!(patches[0].body, patches[1].body);
    assert_eq!(
        patches[0].header("authorization"),
        Some("Bearer session-token-1")
    );
    assert_eq!(
        patches[1].header("authorization"),
        Some("Bearer session-token-2")
    );
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);

    let harness = seeded_attachment().await;
    harness
        .server
        .unauthorized_patches
        .store(2, Ordering::SeqCst);
    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "still-unauthorized.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AuthenticationRequired);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 2);
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn lock_cancels_and_drains_a_hung_session_refresh_without_resubmission() {
    let harness = seeded_attachment().await;
    harness
        .server
        .unauthorized_patches
        .store(1, Ordering::SeqCst);
    harness.server.refresh_mode.store(1, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "cancelled-refresh.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename reaches Session refresh", || {
        harness.server.refresh_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let lock_runtime = Arc::clone(&harness.runtime);
    let lock_account = harness.account_id.clone();
    let lock = tokio::spawn(async move { lock_runtime.mark_account_locked(&lock_account).await });
    until("Lock cancels and drains the held Session refresh", || {
        lock.is_finished() && rename.is_finished()
    })
    .await;

    assert_eq!(
        rename.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    lock.await.unwrap().unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(!harness
        .runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&harness.account_id));
}

#[tokio::test]
async fn renewal_maps_only_transport_failure_to_retryable() {
    for (mode, expected) in [
        (2usize, RuntimeErrorCode::RetryableTransport),
        (3, RuntimeErrorCode::AuthenticationUnavailable),
    ] {
        let harness = seeded_attachment().await;
        harness
            .server
            .unauthorized_patches
            .store(1, Ordering::SeqCst);
        harness.server.refresh_mode.store(mode, Ordering::SeqCst);

        let error = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("refresh-class-{mode}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();

        assert_eq!(error.code, expected, "refresh mode {mode}");
        assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
        assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn same_item_renames_have_one_writer() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let first_runtime = Arc::clone(&harness.runtime);
    let first_account = harness.account_id.clone();
    let first = tokio::spawn(async move {
        first_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: first_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "first-writer.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("the first Rename reaches PATCH", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let second_runtime = Arc::clone(&harness.runtime);
    let second_account = harness.account_id.clone();
    let second = tokio::spawn(async move {
        second_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: second_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "second-writer.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    settle().await;
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);

    harness.server.hold_patch.store(false, Ordering::SeqCst);
    harness.server.patch_release.add_permits(1);
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 2);
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "second-writer.txt"
    );
}

#[tokio::test]
async fn durable_item_acceptance_cannot_create_an_overlay_behind_rename_admission() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "writer-first.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename owns the shared Item writer", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let acceptance_runtime = Arc::clone(&harness.runtime);
    let acceptance_account = harness.account_id.clone();
    let acceptance = tokio::spawn(async move {
        acceptance_runtime
            .request(
                RuntimeRequest::UpdateLoginItem {
                    account_id: acceptance_account,
                    item_id: ITEM_ID.into(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::task::yield_now().await;
    assert!(
        !acceptance.is_finished(),
        "durable acceptance must wait at the shared Item writer"
    );
    let while_renaming = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(while_renaming.operations.is_empty());
    assert!(while_renaming.items.is_empty());

    harness.server.hold_patch.store(false, Ordering::SeqCst);
    harness.server.patch_release.add_permits(1);
    assert!(matches!(
        rename.await.unwrap().unwrap(),
        RuntimeResponse::AttachmentRenamed { .. }
    ));
    assert!(matches!(
        acceptance.await.unwrap().unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    let after = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(after.operations.len(), 1);
    assert_eq!(after.items.len(), 1);
}

#[tokio::test]
async fn create_share_cannot_accept_behind_rename_admission() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let rename = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(
                    RuntimeRequest::RenameAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        name: "rename-before-share.txt".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        }
    });
    until("Rename owns the Item writer before Share", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let share = tokio::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        async move {
            runtime
                .request(create_share(&account_id), RequestCancellation::new())
                .await
        }
    });
    settle().await;
    assert!(!share.is_finished(), "Share must wait at the Item writer");
    let while_renaming = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(while_renaming.operations.is_empty());
    assert!(while_renaming.share_capabilities.is_empty());

    harness.server.hold_patch.store(false, Ordering::SeqCst);
    harness.server.patch_release.add_permits(1);
    assert!(matches!(
        rename.await.unwrap().unwrap(),
        RuntimeResponse::AttachmentRenamed { .. }
    ));
    assert!(matches!(
        share.await.unwrap().unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    let after = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(after.operations.len(), 1);
    assert_eq!(after.share_capabilities.len(), 1);
}

#[tokio::test]
async fn accepted_create_share_refuses_rename_before_patch() {
    let harness = seeded_attachment().await;
    assert!(matches!(
        harness
            .runtime
            .request(
                create_share(&harness.account_id),
                RequestCancellation::new()
            )
            .await
            .unwrap(),
        RuntimeResponse::Accepted { .. }
    ));

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "must-not-patch.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn active_item_operation_refuses_rename_without_patch_or_false_publication() {
    let harness = seeded_attachment().await;
    harness
        .runtime
        .request(
            RuntimeRequest::UpdateLoginItem {
                account_id: harness.account_id.clone(),
                item_id: ITEM_ID.into(),
                draft: draft(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect("the ordinary Item Operation should be durably accepted");
    let revision = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .revision;

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "must-not-publish.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        revision
    );
}

#[tokio::test]
async fn active_attachment_move_overlay_refuses_rename_without_patch_or_false_publication() {
    let harness = seeded_attachment().await;
    harness
        .runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: harness.account_id.clone(),
                item_id: ITEM_ID.into(),
                target_vault_id: "vault-2".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect("the Attachment Move preparation should be durably accepted");
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(snapshot.attachment_move_preparations.len(), 1);
    assert_eq!(snapshot.items.len(), 1);

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "must-not-publish.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 0);
    let after = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert_eq!(after.revision, snapshot.revision);
    assert_eq!(
        after.attachment_move_preparations,
        snapshot.attachment_move_preparations
    );
    assert_eq!(after.items, snapshot.items);
}

#[tokio::test]
async fn account_lock_cancels_a_hung_foreground_rename_before_retiring_plaintext() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "before-lock.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename reaches PATCH", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let lock_runtime = Arc::clone(&harness.runtime);
    let lock_account = harness.account_id.clone();
    let lock = tokio::spawn(async move { lock_runtime.mark_account_locked(&lock_account).await });
    until("Lock cancels and drains the foreground Rename", || {
        lock.is_finished() && rename.is_finished()
    })
    .await;
    let error = rename.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    lock.await.unwrap().unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(!harness
        .runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&harness.account_id));

    // Retirement waited for registration cleanup: a later generation can admit fresh work.
    harness.server.hold_patch.store(false, Ordering::SeqCst);
    harness
        .runtime
        .unlock_account(&harness.account_id)
        .await
        .unwrap();
    harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "after-unlock.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn lock_at_the_final_rename_boundary_publishes_no_stale_projection() {
    let harness = seeded_attachment().await;
    let sink = Arc::new(AttachmentSink::default());
    let _observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let publications_before = sink.0.lock().unwrap().len();
    let replica_revision_before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .revision;
    let reached_projection = Arc::new(AtomicBool::new(false));
    let release_projection = Arc::new(AtomicBool::new(false));
    harness
        .runtime
        .set_before_plaintext_commit_hook(Some(Arc::new({
            let reached_projection = Arc::clone(&reached_projection);
            let release_projection = Arc::clone(&release_projection);
            move || {
                reached_projection.store(true, Ordering::SeqCst);
                while !release_projection.load(Ordering::SeqCst) {
                    std::thread::yield_now();
                }
            }
        })));
    let rename = std::thread::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(runtime.request(
                    RuntimeRequest::RenameAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        name: "committed-before-lock.txt".into(),
                    },
                    RequestCancellation::new(),
                ))
        }
    });
    until("Rename reaches its final plaintext boundary", || {
        reached_projection.load(Ordering::SeqCst)
    })
    .await;
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        replica_revision_before + 1,
        "the authoritative Rename must already be committed"
    );

    let lock_runtime = Arc::clone(&harness.runtime);
    let lock_account = harness.account_id.clone();
    let lock = tokio::spawn(async move { lock_runtime.mark_account_locked(&lock_account).await });
    until("Lock registers retirement intent", || {
        harness
            .runtime
            .account_access_retirement_is_pending(&harness.account_id)
    })
    .await;
    release_projection.store(true, Ordering::SeqCst);

    assert!(matches!(
        rename.join().unwrap().unwrap(),
        RuntimeResponse::AttachmentRenamed { .. }
    ));
    lock.await.unwrap().unwrap();
    assert_eq!(
        sink.0.lock().unwrap().len(),
        publications_before,
        "no old plaintext may be published with the committed Replica revision"
    );
    assert!(!harness
        .runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&harness.account_id));
}

#[tokio::test]
async fn runtime_close_cancels_a_hung_rename_probe_before_retiring_authority() {
    let harness = seeded_attachment().await;
    harness
        .server
        .hold_attachment_get
        .store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "never-published.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename reaches its Attachment authority probe", || {
        harness.server.attachment_get_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let close_runtime = Arc::clone(&harness.runtime);
    let close = tokio::spawn(async move { close_runtime.close().await });
    until("close cancels and drains the foreground Rename", || {
        close.is_finished() && rename.is_finished()
    })
    .await;

    let error = rename.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    close.await.unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(harness.runtime.is_closed());
    assert!(harness.runtime.unlocked_items.lock().unwrap().is_empty());
}

#[tokio::test]
async fn begun_rename_callback_can_complete_each_lifecycle_reentrantly_cross_thread() {
    for lifecycle in 0..5 {
        let harness = seeded_attachment().await;
        *harness
            .runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                Arc::new(SuccessfulAttachmentTeardown),
            )));
        harness
            .runtime
            .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
        let sink = Arc::new(ReentrantAttachmentSink {
            publications: Mutex::new(Vec::new()),
            callback: Mutex::new(None),
        });
        let _observation = harness
            .runtime
            .observe(
                ObservationRequest::Items {
                    account_id: harness.account_id.clone(),
                },
                sink.clone(),
            )
            .unwrap();
        let publications_before = sink.publications.lock().unwrap().len();
        let callback_completed = Arc::new(AtomicBool::new(false));
        *sink.callback.lock().unwrap() = Some(Box::new({
            let runtime = Arc::clone(&harness.runtime);
            let account_id = harness.account_id.clone();
            let callback_completed = Arc::clone(&callback_completed);
            move || {
                let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);
                let lifecycle_thread = std::thread::spawn(move || {
                    let runtime_thread = tokio::runtime::Builder::new_current_thread()
                        .build()
                        .unwrap();
                    let completed = runtime_thread.block_on(async {
                        match lifecycle {
                            0 => runtime
                                .request(
                                    RuntimeRequest::Lock { account_id },
                                    RequestCancellation::new(),
                                )
                                .await
                                .is_ok(),
                            1 => runtime
                                .request(
                                    RuntimeRequest::SignOut { account_id },
                                    RequestCancellation::new(),
                                )
                                .await
                                .is_ok(),
                            2 => runtime
                                .request(
                                    RuntimeRequest::RemoveAccount { account_id },
                                    RequestCancellation::new(),
                                )
                                .await
                                .is_ok(),
                            3 => runtime
                                .request(RuntimeRequest::Wipe, RequestCancellation::new())
                                .await
                                .is_ok(),
                            _ => {
                                runtime.close().await;
                                true
                            }
                        }
                    });
                    finished_tx.send(completed).unwrap();
                });
                assert!(
                    finished_rx
                        .recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap_or_else(|_| panic!(
                            "lifecycle {lifecycle} deadlocked on the begun host callback"
                        )),
                    "lifecycle {lifecycle} did not complete"
                );
                lifecycle_thread.join().unwrap();
                callback_completed.store(true, Ordering::SeqCst);
            }
        }));

        let response = harness
            .runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: harness.account_id.clone(),
                    attachment_id: ATTACHMENT_ID.into(),
                    name: format!("reentrant-{lifecycle}.txt"),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();

        assert!(matches!(
            response,
            RuntimeResponse::AttachmentRenamed { .. }
        ));
        assert!(callback_completed.load(Ordering::SeqCst));
        let publications = sink.publications.lock().unwrap();
        let renamed_callbacks = publications
            .iter()
            .filter(|projection| {
                matches!(projection, RuntimeProjection::Items(items)
                    if items.items.iter().any(|item| item.attachments.iter().any(|attachment|
                        attachment.name == format!("reentrant-{lifecycle}.txt"))))
            })
            .count();
        assert_eq!(renamed_callbacks, 1, "lifecycle {lifecycle}");
        assert!(publications.len() > publications_before);
    }
}

#[tokio::test]
async fn close_at_the_final_rename_boundary_emits_no_callback_after_close_intent() {
    let harness = seeded_attachment().await;
    let sink = Arc::new(AttachmentSink::default());
    let _observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let publications_before = sink.0.lock().unwrap().len();
    let replica_revision_before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .revision;
    let reached_projection = Arc::new(AtomicBool::new(false));
    let release_projection = Arc::new(AtomicBool::new(false));
    harness
        .runtime
        .foreground_attachments
        .set_before_publication_admission_hook(Some(Arc::new({
            let reached_projection = Arc::clone(&reached_projection);
            let release_projection = Arc::clone(&release_projection);
            move || {
                reached_projection.store(true, Ordering::SeqCst);
                while !release_projection.load(Ordering::SeqCst) {
                    std::thread::yield_now();
                }
            }
        })));
    let rename = std::thread::spawn({
        let runtime = Arc::clone(&harness.runtime);
        let account_id = harness.account_id.clone();
        move || {
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(runtime.request(
                    RuntimeRequest::RenameAttachment {
                        account_id,
                        attachment_id: ATTACHMENT_ID.into(),
                        name: "committed-before-close.txt".into(),
                    },
                    RequestCancellation::new(),
                ))
        }
    });
    until("Rename reaches its final projection boundary", || {
        reached_projection.load(Ordering::SeqCst)
    })
    .await;
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        replica_revision_before + 1,
        "the authoritative Rename must already be committed"
    );

    let close_runtime = Arc::clone(&harness.runtime);
    let close = tokio::spawn(async move { close_runtime.close().await });
    until(
        "close completes without waiting for a callback that has not begun",
        || close.is_finished(),
    )
    .await;
    release_projection.store(true, Ordering::SeqCst);

    assert!(matches!(
        rename.join().unwrap().unwrap(),
        RuntimeResponse::AttachmentRenamed { .. }
    ));
    close.await.unwrap();
    assert_eq!(sink.0.lock().unwrap().len(), publications_before);
    assert!(harness.runtime.unlocked_items.lock().unwrap().is_empty());
}

#[tokio::test]
async fn remove_and_wipe_at_final_rename_boundary_emit_no_callback_after_retirement_intent() {
    for wipe in [false, true] {
        let harness = seeded_attachment().await;
        *harness
            .runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                Arc::new(SuccessfulAttachmentTeardown),
            )));
        harness
            .runtime
            .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
        let sink = Arc::new(AttachmentSink::default());
        let _observation = harness
            .runtime
            .observe(
                ObservationRequest::Items {
                    account_id: harness.account_id.clone(),
                },
                sink.clone(),
            )
            .unwrap();
        let publications_before = sink.0.lock().unwrap().len();
        let replica_revision_before = harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision;
        let reached_admission = Arc::new(AtomicBool::new(false));
        let release_admission = Arc::new(AtomicBool::new(false));
        harness
            .runtime
            .foreground_attachments
            .set_before_publication_admission_hook(Some(Arc::new({
                let reached_admission = Arc::clone(&reached_admission);
                let release_admission = Arc::clone(&release_admission);
                move || {
                    reached_admission.store(true, Ordering::SeqCst);
                    while !release_admission.load(Ordering::SeqCst) {
                        std::thread::yield_now();
                    }
                }
            })));
        let rename = std::thread::spawn({
            let runtime = Arc::clone(&harness.runtime);
            let account_id = harness.account_id.clone();
            move || {
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap()
                    .block_on(runtime.request(
                        RuntimeRequest::RenameAttachment {
                            account_id,
                            attachment_id: ATTACHMENT_ID.into(),
                            name: "committed-before-teardown.txt".into(),
                        },
                        RequestCancellation::new(),
                    ))
            }
        });
        until("Rename reaches publication admission", || {
            reached_admission.load(Ordering::SeqCst)
        })
        .await;
        assert_eq!(
            harness
                .runtime
                .replica()
                .snapshot(&harness.account_id)
                .unwrap()
                .revision,
            replica_revision_before + 1,
            "wipe={wipe}: authority must commit before final publication admission"
        );

        let teardown_runtime = Arc::clone(&harness.runtime);
        let teardown_account = harness.account_id.clone();
        let teardown = tokio::spawn(async move {
            teardown_runtime
                .request(
                    if wipe {
                        RuntimeRequest::Wipe
                    } else {
                        RuntimeRequest::RemoveAccount {
                            account_id: teardown_account,
                        }
                    },
                    RequestCancellation::new(),
                )
                .await
        });
        until(
            "teardown completes without waiting for a callback that has not begun",
            || teardown.is_finished(),
        )
        .await;
        release_admission.store(true, Ordering::SeqCst);

        assert!(matches!(
            rename.join().unwrap().unwrap(),
            RuntimeResponse::AttachmentRenamed { .. }
        ));
        assert!(matches!(
            teardown.await.unwrap().unwrap(),
            RuntimeResponse::Teardown {
                status: TeardownStatus::Complete,
                ..
            }
        ));
        assert_eq!(
            sink.0.lock().unwrap().len(),
            publications_before,
            "wipe={wipe}: no Items callback may begin after teardown intent"
        );
    }
}

#[tokio::test]
async fn sign_out_cancels_a_hung_foreground_rename_before_destroying_access() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "before-sign-out.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename reaches PATCH before Sign-out", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let sign_out_runtime = Arc::clone(&harness.runtime);
    let sign_out_account = harness.account_id.clone();
    let sign_out = tokio::spawn(async move {
        sign_out_runtime
            .request(
                RuntimeRequest::SignOut {
                    account_id: sign_out_account,
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Sign-out cancels and drains the foreground Rename", || {
        sign_out.is_finished() && rename.is_finished()
    })
    .await;

    assert_eq!(
        rename.await.unwrap().unwrap_err().code,
        RuntimeErrorCode::Cancelled
    );
    sign_out.await.unwrap().unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.cancel_calls.load(Ordering::SeqCst), 1);
    assert!(!harness
        .runtime
        .unlocked_items
        .lock()
        .unwrap()
        .contains_key(&harness.account_id));
}

#[tokio::test]
async fn dropping_a_hung_rename_releases_lifecycle_registration_before_lock() {
    let harness = seeded_attachment().await;
    harness.server.hold_patch.store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "dropped.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename reaches PATCH before its future is dropped", || {
        harness.server.patch_calls.load(Ordering::SeqCst) == 1
    })
    .await;
    rename.abort();
    assert!(rename.await.unwrap_err().is_cancelled());

    let lock_runtime = Arc::clone(&harness.runtime);
    let lock_account = harness.account_id.clone();
    let lock = tokio::spawn(async move { lock_runtime.mark_account_locked(&lock_account).await });
    until(
        "Lock observes the dropped Rename registration as drained",
        || lock.is_finished(),
    )
    .await;
    lock.await.unwrap().unwrap();
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn account_remove_and_device_wipe_cancel_hung_rename_before_deleting_authority() {
    for wipe in [false, true] {
        let harness = seeded_attachment().await;
        *harness
            .runtime
            .attachment_move_lifecycle
            .lock()
            .expect("Attachment Move lifecycle lock poisoned") =
            Some(Arc::new(AttachmentMoveLifecycle::new(
                Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
                Arc::new(SuccessfulAttachmentTeardown),
            )));
        harness
            .runtime
            .install_teardown_host_cleanup(Arc::new(SuccessfulHostTeardown));
        harness.server.hold_patch.store(true, Ordering::SeqCst);
        let rename_runtime = Arc::clone(&harness.runtime);
        let rename_account = harness.account_id.clone();
        let rename = tokio::spawn(async move {
            rename_runtime
                .request(
                    RuntimeRequest::RenameAttachment {
                        account_id: rename_account,
                        attachment_id: ATTACHMENT_ID.into(),
                        name: "removed-before-publication.txt".into(),
                    },
                    RequestCancellation::new(),
                )
                .await
        });
        until("Rename reaches PATCH before teardown", || {
            harness.server.patch_calls.load(Ordering::SeqCst) == 1
        })
        .await;

        let teardown_runtime = Arc::clone(&harness.runtime);
        let teardown_account = harness.account_id.clone();
        let teardown = tokio::spawn(async move {
            teardown_runtime
                .request(
                    if wipe {
                        RuntimeRequest::Wipe
                    } else {
                        RuntimeRequest::RemoveAccount {
                            account_id: teardown_account,
                        }
                    },
                    RequestCancellation::new(),
                )
                .await
        });
        until("teardown cancels and drains the foreground Rename", || {
            teardown.is_finished() && rename.is_finished()
        })
        .await;

        let error = rename.await.unwrap().unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::Cancelled, "wipe={wipe}");
        assert!(matches!(
            teardown.await.unwrap().unwrap(),
            RuntimeResponse::Teardown { .. }
        ));
        assert_eq!(
            harness.server.patch_calls.load(Ordering::SeqCst),
            1,
            "wipe={wipe}"
        );
        assert_eq!(
            harness.server.cancel_calls.load(Ordering::SeqCst),
            1,
            "wipe={wipe}"
        );
        assert!(harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .is_none());
    }
}

#[tokio::test]
async fn newer_background_authority_wins_the_guarded_rename_commit() {
    let harness = seeded_attachment().await;
    harness
        .server
        .hold_attachment_get
        .store(true, Ordering::SeqCst);
    let rename_runtime = Arc::clone(&harness.runtime);
    let rename_account = harness.account_id.clone();
    let rename = tokio::spawn(async move {
        rename_runtime
            .request(
                RuntimeRequest::RenameAttachment {
                    account_id: rename_account,
                    attachment_id: ATTACHMENT_ID.into(),
                    name: "foreground.txt".into(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    until("Rename pauses while fetching Attachment authority", || {
        harness.server.attachment_get_calls.load(Ordering::SeqCst) == 1
    })
    .await;

    let background = Replica::new(Arc::new(SerializedReplicaPersistence::new(
        harness.replica.clone(),
    )));
    let observed = background.load(&harness.account_id).await.unwrap().unwrap();
    let mut item = observed.bootstrap.snapshot().visible_items[0].clone();
    let encrypted = encrypt_with_aad(
        "background.txt",
        &[13u8; 32],
        &AadContext {
            vault_id: TEST_VAULT_ID.into(),
            entity_id: ATTACHMENT_ID.into(),
            entity_type: "attachment_name".into(),
            version: 1,
            user_id: USER.into(),
        },
    )
    .unwrap();
    item.attachments[0].encrypted_name = encrypted.ciphertext;
    item.attachments[0].encryption_iv = encrypted.iv;
    item.attachments[0].encryption_algorithm = encrypted.algorithm;
    assert!(matches!(
        background
            .execute(GuardedCommitPlan::new(
                harness.account_id.clone(),
                observed.incarnation,
                observed.revision,
                observed.lock_epoch,
                vec![PlanMutation::CommitAttachmentAuthority {
                    attachment_id: ATTACHMENT_ID.into(),
                    attachment_present: true,
                    item: Box::new(item),
                }],
            ))
            .await
            .unwrap(),
        PlanResult::Applied { .. }
    ));

    harness
        .server
        .hold_attachment_get
        .store(false, Ordering::SeqCst);
    harness.server.attachment_get_release.add_permits(1);
    let error = rename.await.unwrap().unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    harness
        .runtime
        .decrypt_visible_items(&harness.account_id)
        .unwrap();
    assert_eq!(
        harness.runtime.unlocked_items.lock().unwrap()[&harness.account_id][0].attachments[0].name,
        "background.txt"
    );
}

#[tokio::test]
async fn older_fetched_item_authority_is_retryable_without_commit_or_publication() {
    let harness = seeded_attachment().await;
    let mut current = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let mut newer = current.bootstrap.snapshot().visible_items[0].clone();
    newer.version = 2;
    newer.updated_at = "2026-08-28T12:00:00Z".into();
    harness
        .runtime
        .execute_plan(GuardedCommitPlan::new(
            harness.account_id.clone(),
            current.incarnation.clone(),
            current.revision,
            current.lock_epoch,
            vec![PlanMutation::CommitAttachmentAuthority {
                attachment_id: ATTACHMENT_ID.into(),
                attachment_present: true,
                item: Box::new(newer),
            }],
        ))
        .await
        .unwrap();
    current = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let sink = Arc::new(AttachmentSink::default());
    let _observation = harness
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: harness.account_id.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let publications = sink.0.lock().unwrap().len();

    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "stale-fetch.txt".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.code, RuntimeErrorCode::RetryableTransport);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .unwrap()
            .revision,
        current.revision
    );
    assert_eq!(sink.0.lock().unwrap().len(), publications);
}

#[tokio::test]
async fn rename_rejects_foreign_missing_invalid_and_cancelled_requests_before_transport() {
    let harness = seeded_attachment().await;
    let cases = [
        (
            RuntimeRequest::RenameAttachment {
                account_id: AccountId::from("foreign-account"),
                attachment_id: ATTACHMENT_ID.into(),
                name: "name.txt".into(),
            },
            RequestCancellation::new(),
            RuntimeErrorCode::AccountMissing,
        ),
        (
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: "missing-attachment".into(),
                name: "name.txt".into(),
            },
            RequestCancellation::new(),
            RuntimeErrorCode::AuthorityMissing,
        ),
        (
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "   ".into(),
            },
            RequestCancellation::new(),
            RuntimeErrorCode::SizeRejected,
        ),
    ];
    for (request, cancellation, expected) in cases {
        let error = harness
            .runtime
            .request(request, cancellation)
            .await
            .unwrap_err();
        assert_eq!(error.code, expected);
    }
    let cancellation = RequestCancellation::new();
    cancellation.cancel();
    let error = harness
        .runtime
        .request(
            RuntimeRequest::RenameAttachment {
                account_id: harness.account_id.clone(),
                attachment_id: ATTACHMENT_ID.into(),
                name: "cancelled.txt".into(),
            },
            cancellation,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::Cancelled);
    assert_eq!(harness.server.patch_calls.load(Ordering::SeqCst), 0);
}

fn attachment_authority() -> AuthorityAttachmentRecord {
    attachment_authority_for(
        ATTACHMENT_ID,
        ITEM_ID,
        "original.txt",
        "attachments/item-existing/file.enc",
    )
}

fn attachment_authority_for(
    attachment_id: &str,
    item_id: &str,
    name: &str,
    storage_key: &str,
) -> AuthorityAttachmentRecord {
    let attachment_key = [13u8; 32];
    let context = |entity_type: &str| AadContext {
        vault_id: TEST_VAULT_ID.into(),
        entity_id: attachment_id.into(),
        entity_type: entity_type.into(),
        version: 1,
        user_id: USER.into(),
    };
    let wrapped_key = encrypt_with_aad(
        &BASE64.encode(attachment_key),
        &TEST_VAULT_KEY,
        &context("attachment_key"),
    )
    .unwrap();
    let encrypted_name =
        encrypt_with_aad(name, &attachment_key, &context("attachment_name")).unwrap();
    let encrypted_content_type = encrypt_with_aad(
        "text/plain",
        &attachment_key,
        &context("attachment_content_type"),
    )
    .unwrap();
    AuthorityAttachmentRecord {
        id: attachment_id.into(),
        item_id: item_id.into(),
        vault_id: TEST_VAULT_ID.into(),
        storage_key: storage_key.into(),
        encrypted_name: encrypted_name.ciphertext,
        encryption_iv: encrypted_name.iv,
        encryption_algorithm: encrypted_name.algorithm,
        encrypted_attachment_key: wrapped_key.ciphertext,
        attachment_key_iv: wrapped_key.iv,
        attachment_key_algorithm: wrapped_key.algorithm,
        encrypted_content_type: encrypted_content_type.ciphertext,
        encrypted_content_type_iv: encrypted_content_type.iv,
        envelope_version: 1,
        file_size: 42,
        uploaded_by: USER.into(),
        created_at: "2026-08-23T00:00:00Z".into(),
    }
}

fn attachment_dto(attachment: AuthorityAttachmentRecord) -> VaultAttachmentResponse {
    VaultAttachmentResponse {
        id: attachment.id,
        item_id: attachment.item_id,
        vault_id: attachment.vault_id,
        storage_key: attachment.storage_key,
        encrypted_name: attachment.encrypted_name,
        encryption_iv: attachment.encryption_iv,
        encryption_algorithm: attachment.encryption_algorithm,
        encrypted_attachment_key: attachment.encrypted_attachment_key,
        attachment_key_iv: attachment.attachment_key_iv,
        attachment_key_algorithm: attachment.attachment_key_algorithm,
        encrypted_content_type: attachment.encrypted_content_type,
        encrypted_content_type_iv: attachment.encrypted_content_type_iv,
        envelope_version: attachment.envelope_version,
        file_size: attachment.file_size,
        uploaded_by: attachment.uploaded_by,
        created_at: attachment.created_at,
    }
}

fn attachment_page_response(server: &AttachmentServer, url: &str) -> Value {
    let mode = server.attachment_page_mode.load(Ordering::SeqCst);
    if mode == 0 {
        let mut items = server
            .additional_owning_attachments
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .map(|attachment| serde_json::to_value(attachment).unwrap())
            .collect::<Vec<_>>();
        if !server.attachment_deleted.load(Ordering::SeqCst) {
            items.insert(
                0,
                serde_json::to_value(server.attachment.lock().unwrap().clone()).unwrap(),
            );
        }
        return completed(
            200,
            serde_json::to_vec(&json!({
                "items": items,
                "hasMore": false,
                "nextCursor": null,
            }))
            .unwrap(),
        );
    }

    let page = url
        .split("cursor=authority-")
        .nth(1)
        .and_then(|value| value.split('&').next())
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let (count, has_more) = match mode {
        1 => (1usize, true),
        3 => (1, page < 2),
        _ => (1, page < 8),
    };
    let template = server.attachment.lock().unwrap().clone();
    let items: Vec<_> = (0..count)
        .map(|offset| {
            if mode == 3 {
                return attachment_dto(attachment_authority_for(
                    &format!("decoy-{page}-{offset}"),
                    ITEM_ID,
                    &format!("decoy-{page}-{offset}.txt"),
                    &format!("attachments/{ITEM_ID}/decoy-{page}-{offset}.enc"),
                ));
            }
            let mut attachment = template.clone();
            attachment.id = format!("decoy-{mode}-{page}-{offset}");
            attachment
        })
        .chain(
            (mode == 3 && page == 1)
                .then(|| server.additional_owning_attachments.lock().unwrap().clone())
                .into_iter()
                .flatten(),
        )
        .collect();
    let mut body = serde_json::to_vec(&json!({
        "items": items,
        "hasMore": has_more,
        "nextCursor": has_more.then(|| format!("authority-{}", page + 1)),
    }))
    .unwrap();
    if mode == 2 {
        // JSON permits trailing whitespace. Nine pages padded just below the transport's 4 MiB
        // per-page bound exceed the 32 MiB authority aggregate without allocating huge entity sets.
        body.resize(4 * 1024 * 1024 - 16 * 1024, b' ');
    }
    completed(200, body)
}
