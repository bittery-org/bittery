//! Actual Core image ingress, SQLite publication and the production HTTP transport cancellation path.
use super::*;
use crate::runtime::operation_fixtures::*;
use crate::VaultImageArtifactPort;
use base64::Engine as _;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicUsize};

struct HeldImageHttp {
    operation: Mutex<Option<OperationRecord>>,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
    hold_status: bool,
    hold_renewal: bool,
    reject_renewal: bool,
    active: Arc<AtomicBool>,
    uploads: AtomicUsize,
    cancellations: AtomicUsize,
}
struct ActiveUpload(Arc<AtomicBool>);
impl Drop for ActiveUpload {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
#[async_trait]
impl SerializedHttpExecutor for HeldImageHttp {
    async fn invoke(&self, text: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&text).unwrap();
        let operation = self.operation.lock().unwrap().clone().unwrap();
        let image = operation.vault_image().unwrap();
        let url = request["url"].as_str().unwrap();
        let response = if url.ends_with("/status") {
            if self.hold_renewal {
                return Ok(completed(401, Vec::new()).to_string());
            }
            if self.hold_status {
                self.active.store(true, Ordering::SeqCst);
                let _active = ActiveUpload(self.active.clone());
                self.entered.notify_one();
                self.release.notified().await;
            }
            json!({"state":"absent"})
        } else if url.ends_with("/sessions/current/refresh") {
            assert!(self.hold_renewal);
            self.active.store(true, Ordering::SeqCst);
            let _active = ActiveUpload(self.active.clone());
            self.entered.notify_one();
            self.release.notified().await;
            if self.reject_renewal {
                return Ok(completed(401, Vec::new()).to_string());
            }
            json!({"token":"late-refresh-token", "sessionId":"late-session", "expiresAt":"2027-01-01T00:00:00Z"})
        } else if url.ends_with("/grants") {
            use sha2::Digest;
            json!({"generation":1,"leaseExpiresAt":"2026-09-10T00:00:00Z", "objectKey":image.object_key,
            "uploadUrl":"https://objects.example.test/held-image", "uploadHeaders":[
                {"name":"Content-Length","value":image.byte_length.to_string()},
                {"name":"Content-Type","value":image.content_type},
                {"name":"x-amz-content-sha256","value":image.sha256},
                {"name":"x-amz-checksum-sha256","value":base64::engine::general_purpose::STANDARD.encode(sha2::Sha256::digest(b"image-bytes"))}
            ]})
        } else if url.ends_with("/held-image") {
            assert_eq!(request["body"], json!(b"image-bytes".to_vec()));
            self.uploads.fetch_add(1, Ordering::SeqCst);
            self.active.store(true, Ordering::SeqCst);
            let _active = ActiveUpload(self.active.clone());
            self.entered.notify_one();
            return std::future::pending().await;
        } else {
            panic!("unexpected image HTTP request {url}");
        };
        Ok(completed(200, serde_json::to_vec(&response).unwrap()).to_string())
    }
    fn cancel(&self, _: &str) {
        self.cancellations.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Copy)]
enum RetirementKind {
    Lock,
    Vault,
    Generation,
    StaleGeneration,
    RefusedSession,
    StaleSession,
    StatusLock,
    RenewalLock,
    RenewalSessionReplacement,
    RenewalRejectedSessionReplacement,
    RenewalAccountReplacement,
    RenewalRefusal,
}

async fn exercise_image_retirement(kind: RetirementKind, during_upload: bool) {
    let seed = seeded(false).await;
    let renewal_case = matches!(
        kind,
        RetirementKind::RenewalLock
            | RetirementKind::RenewalSessionReplacement
            | RetirementKind::RenewalRejectedSessionReplacement
            | RetirementKind::RenewalAccountReplacement
            | RetirementKind::RenewalRefusal
    );
    let replacement_snapshot = Mutex::new(None);
    let http = Arc::new(HeldImageHttp {
        operation: Mutex::new(None),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        hold_status: matches!(kind, RetirementKind::StatusLock),
        hold_renewal: renewal_case,
        reject_renewal: matches!(kind, RetirementKind::RenewalRejectedSessionReplacement),
        active: Arc::new(AtomicBool::new(false)),
        uploads: AtomicUsize::new(0),
        cancellations: AtomicUsize::new(0),
    });
    let runtime = Runtime::with_test_dispatch_environment(
        seed.replica.clone(),
        seed.platform.clone(),
        http.clone(),
        auth_config(),
        seed.clock.clone(),
        seed.timer.clone(),
    );
    runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    runtime.replica.load(&seed.account_id).await.unwrap();
    runtime.unlock_account(&seed.account_id).await.unwrap();
    let path = std::env::temp_dir().join(format!(
        "bittery-image-retirement-{}.sqlite",
        bittery_crypto_core::generate_uuid()
    ));
    let artifacts = Arc::new(crate::SqliteVaultImageArtifactStore::open(&path).unwrap());
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "protected-lifecycle",
            Arc::new(crate::runtime::create_vault_tests::ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: seed.account_id.clone(),
                name: "Image".into(),
                vault_type: crate::CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: Some(crate::VaultImageSourceInput {
                    capability_id: "opaque-image-source".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let original = runtime.replica.snapshot(&seed.account_id).unwrap();
    let operation = original.operations[0].clone();
    *http.operation.lock().unwrap() = Some(operation.clone());
    let family =
        crate::VaultImageArtifactScope::new(seed.account_id.clone(), &operation.operation_id)
            .unwrap();
    let protected = artifacts
        .read_generation(&family, None)
        .await
        .unwrap()
        .unwrap()
        .metadata
        .unwrap();
    assert!(protected.protection().is_some());
    assert_eq!(
        protected.scope().publication_id(),
        Some(
            operation
                .vault_image()
                .unwrap()
                .protected_witness
                .as_ref()
                .unwrap()
                .publication_id
                .as_str()
        )
    );
    if !during_upload {
        // An accidental read would fail integrity and the Account. A fenced owner must park
        // before opening these intentionally corrupt image envelopes.
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute("UPDATE vault_image_artifact_chunks SET plaintext=X'00'", [])
            .unwrap();
    }
    let dispatch = async { runtime.dispatch_eligible_operations().await };
    let retire = async {
        if during_upload {
            http.entered.notified().await;
        }
        if matches!(kind, RetirementKind::Vault) {
            let retirement = runtime.foreground_attachments.begin_vault_retirement(&seed.account_id, &original.incarnation,
                &[operation.vault_id().to_owned()], super::super::foreground_attachment_lifecycle::VaultRetirementProof::DurableJournal { revision: original.revision }).unwrap();
            retirement.drain().await;
        } else if matches!(
            kind,
            RetirementKind::Generation | RetirementKind::StaleGeneration
        ) {
            if matches!(kind, RetirementKind::StaleGeneration) {
                let mut stale = original.clone();
                stale.incarnation = crate::Incarnation::from("retired-incarnation");
                assert_eq!(
                    runtime
                        .retire_account_generation(&stale)
                        .await
                        .unwrap_err()
                        .code,
                    RuntimeErrorCode::Cancelled
                );
                assert!(http.active.load(Ordering::SeqCst));
                assert_eq!(http.cancellations.load(Ordering::SeqCst), 0);
            }
            runtime.retire_account_generation(&original).await.unwrap();
        } else if matches!(
            kind,
            RetirementKind::RenewalSessionReplacement
                | RetirementKind::RenewalRejectedSessionReplacement
        ) {
            let session = runtime
                .platform_storage
                .load_current_session(&seed.account_id, &original.incarnation)
                .await
                .unwrap()
                .unwrap();
            let mut replacement = session.clone();
            replacement.token = serde_json::from_value(json!("already-renewed-token")).unwrap();
            let execution = runtime.account_execution_lock(&seed.account_id).unwrap();
            let _guard = execution.lock().await;
            runtime
                .replace_independent_session(&session, replacement)
                .await
                .unwrap();
        } else if matches!(kind, RetirementKind::RenewalAccountReplacement) {
            runtime
                .install_or_replace_account(
                    seed.account_id.clone(),
                    original.user_id.clone(),
                    crate::Incarnation::from("replacement-incarnation"),
                )
                .await
                .unwrap();
            *replacement_snapshot.lock().unwrap() = runtime.replica.snapshot(&seed.account_id);
        } else if matches!(
            kind,
            RetirementKind::RefusedSession
                | RetirementKind::StaleSession
                | RetirementKind::RenewalRefusal
        ) {
            let session = runtime
                .platform_storage
                .load_current_session(&seed.account_id, &original.incarnation)
                .await
                .unwrap()
                .unwrap();
            if matches!(kind, RetirementKind::StaleSession) {
                let mut stale = session.clone();
                stale.token = serde_json::from_value(json!("retired-token")).unwrap();
                assert_eq!(
                    runtime
                        .retire_refused_session(&stale, original.lock_epoch)
                        .await
                        .unwrap_err()
                        .code,
                    RuntimeErrorCode::Cancelled
                );
                assert!(http.active.load(Ordering::SeqCst));
                assert_eq!(http.cancellations.load(Ordering::SeqCst), 0);
            }
            runtime
                .retire_refused_session(&session, original.lock_epoch)
                .await
                .unwrap();
        } else {
            runtime.mark_account_locked(&seed.account_id).await.unwrap();
        }
        if matches!(kind, RetirementKind::StatusLock) || renewal_case {
            if !matches!(
                kind,
                RetirementKind::RenewalSessionReplacement
                    | RetirementKind::RenewalRejectedSessionReplacement
            ) {
                assert!(runtime
                    .copy_live_master_unlock_key(&seed.account_id, &original.incarnation)
                    .is_none());
            }
            http.release.notify_one();
        } else {
            assert!(
                !http.active.load(Ordering::SeqCst),
                "retirement returned with an image HTTP loan active"
            );
        }
    };
    if during_upload {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(dispatch, retire);
        })
        .await
        .unwrap();
    } else {
        retire.await;
        dispatch.await;
    }
    assert_eq!(
        http.uploads.load(Ordering::SeqCst),
        usize::from(during_upload && !matches!(kind, RetirementKind::StatusLock) && !renewal_case)
    );
    assert_eq!(
        http.cancellations.load(Ordering::SeqCst),
        usize::from(during_upload && !matches!(kind, RetirementKind::StatusLock) && !renewal_case)
    );
    let after = runtime.replica.snapshot(&seed.account_id).unwrap();
    assert!(
        after.failure.is_none(),
        "fenced image corruption was incorrectly read"
    );
    if let Some(replacement) = replacement_snapshot.lock().unwrap().as_ref() {
        assert_eq!(
            &after, replacement,
            "late renewal changed replacement Account"
        );
    } else {
        assert_eq!(after.operations[0].request, operation.request);
        assert_eq!(
            after.operations[0].request_fingerprint,
            operation.request_fingerprint
        );
        assert_eq!(after.operations[0].vault_image(), operation.vault_image());
    }
    if matches!(
        kind,
        RetirementKind::RenewalSessionReplacement
            | RetirementKind::RenewalRejectedSessionReplacement
    ) {
        let session = runtime
            .platform_storage
            .load_current_session(&seed.account_id, &original.incarnation)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.token.as_ref(), "already-renewed-token");
        assert_ne!(
            runtime
                .waiting_reasons
                .lock()
                .unwrap()
                .get(&seed.account_id),
            Some(&AccountWaitingReason::ReauthenticationRequired)
        );
    }
    assert!(artifacts.read_chunk(&protected, 0).await.unwrap().is_some());
    runtime.close().await;
    seed.runtime.close().await;
    drop(runtime);
    drop(artifacts);
    let reopened = crate::SqliteVaultImageArtifactStore::open(&path).unwrap();
    assert!(reopened.read_chunk(&protected, 0).await.unwrap().is_some());
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn locked_account_parks_before_protected_image_upload() {
    exercise_image_retirement(RetirementKind::Lock, false).await;
}
#[tokio::test]
async fn hidden_vault_parks_before_protected_image_upload() {
    exercise_image_retirement(RetirementKind::Vault, false).await;
}
#[tokio::test]
async fn account_lock_cancels_and_drains_the_actual_image_http_transport() {
    exercise_image_retirement(RetirementKind::Lock, true).await;
}
#[tokio::test]
async fn selective_vault_retirement_cancels_and_drains_the_actual_image_http_transport() {
    exercise_image_retirement(RetirementKind::Vault, true).await;
}

#[derive(Clone, Copy)]
enum UpdateKeyChange {
    CorruptWrapper,
    MasterUnlockKey,
    VaultKey,
}

async fn exercise_protected_update_key_change(change: UpdateKeyChange) {
    let seed = seeded(false).await;
    let http = Arc::new(HeldImageHttp {
        operation: Mutex::new(None),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
        hold_status: false,
        hold_renewal: false,
        reject_renewal: false,
        active: Arc::new(AtomicBool::new(false)),
        uploads: AtomicUsize::new(0),
        cancellations: AtomicUsize::new(0),
    });
    let runtime = Runtime::with_test_dispatch_environment(
        seed.replica.clone(),
        seed.platform.clone(),
        http.clone(),
        auth_config(),
        seed.clock.clone(),
        seed.timer.clone(),
    );
    runtime.replica.load(&seed.account_id).await.unwrap();
    runtime.unlock_account(&seed.account_id).await.unwrap();
    runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    let artifacts = Arc::new(crate::SqliteVaultImageArtifactStore::open(":memory:").unwrap());
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "protected-update",
            Arc::new(crate::runtime::create_vault_tests::ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    runtime
        .request(
            RuntimeRequest::UpdateVault {
                account_id: seed.account_id.clone(),
                vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
                name: Some("Updated image".into()),
                icon: crate::VaultIconPatch::Unchanged,
                image: crate::VaultImageChange::Source {
                    source: crate::VaultImageSourceInput {
                        capability_id: "opaque-image-source".into(),
                        byte_length: 11,
                        content_type: "image/png".into(),
                    },
                },
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let original = runtime.replica.snapshot(&seed.account_id).unwrap();
    let operation = original.operations[0].clone();
    runtime
        .require_vault_image_read_authority(&original, &operation)
        .unwrap();
    *http.operation.lock().unwrap() = Some(operation.clone());
    let family =
        crate::VaultImageArtifactScope::new(seed.account_id.clone(), &operation.operation_id)
            .unwrap();
    let metadata = artifacts
        .read_generation(&family, None)
        .await
        .unwrap()
        .unwrap()
        .metadata
        .unwrap();
    let ciphertext = artifacts.read_chunk(&metadata, 0).await.unwrap().unwrap();
    let mut vault = original
        .bootstrap
        .vaults
        .values()
        .find(|vault| vault.id == operation.vault_id())
        .unwrap()
        .clone();
    if matches!(change, UpdateKeyChange::CorruptWrapper) {
        vault.encrypted_vault_key = "corrupt-current-wrapper".into();
    } else {
        let muk = if matches!(change, UpdateKeyChange::MasterUnlockKey) {
            [13; 32]
        } else {
            crate::test_fixtures::TEST_MASTER_UNLOCK_KEY
        };
        let key = if matches!(change, UpdateKeyChange::VaultKey) {
            [17; 32]
        } else {
            crate::test_fixtures::TEST_VAULT_KEY
        };
        vault.encrypted_vault_key = bittery_crypto_core::encrypt_vault_key_with_muk(
            &key,
            &muk,
            &bittery_crypto_core::VaultKeyWrapContext::new(
                operation.vault_id(),
                &original.user_id,
                1,
            ),
        )
        .unwrap();
        // Publish replacement material only into the Runtime's existing live key owner. This is
        // compatibility after valid replacement, not the password-change ceremony.
        runtime.live_master_unlock_keys.lock().unwrap().insert(
            (seed.account_id.clone(), original.incarnation.clone()),
            LiveMasterUnlockKey::new(zeroize::Zeroizing::new(muk)),
        );
    }
    seed.replica
        .state
        .seed_ready_personal_vault(&seed.account_id, vault)
        .unwrap();
    runtime.replica.load(&seed.account_id).await.unwrap();
    let current = runtime.replica.snapshot(&seed.account_id).unwrap();
    if matches!(change, UpdateKeyChange::CorruptWrapper) {
        assert!(matches!(
            runtime.require_vault_image_read_authority(&current, &operation),
            Err(CreateVaultRecoveryError::ParkedFenced)
        ));
    } else {
        runtime
            .require_vault_image_read_authority(&current, &operation)
            .unwrap();
        let dispatch =
            runtime.dispatch_once_ignoring_lease(&seed.account_id, &operation.operation_id);
        let retire_after_exact_upload = async {
            http.entered.notified().await;
            assert_eq!(http.uploads.load(Ordering::SeqCst), 1);
            runtime.mark_account_locked(&seed.account_id).await.unwrap();
            assert!(!http.active.load(Ordering::SeqCst));
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(dispatch, retire_after_exact_upload);
        })
        .await
        .unwrap();
    }
    assert_eq!(
        runtime
            .replica
            .snapshot(&seed.account_id)
            .unwrap()
            .operations[0],
        operation
    );
    assert_eq!(
        artifacts
            .read_generation(&family, None)
            .await
            .unwrap()
            .unwrap()
            .metadata
            .unwrap(),
        metadata
    );
    assert_eq!(
        artifacts.read_chunk(&metadata, 0).await.unwrap().unwrap(),
        ciphertext
    );
    assert_eq!(
        runtime
            .platform_storage
            .load_device_key()
            .await
            .unwrap()
            .unwrap()
            .key_bytes
            .as_slice(),
        &[7; 32]
    );
    runtime.close().await;
    seed.runtime.close().await;
}

#[tokio::test]
async fn protected_update_read_requires_a_usable_current_vault_key() {
    exercise_protected_update_key_change(UpdateKeyChange::CorruptWrapper).await;
}
#[tokio::test]
async fn protected_update_upload_survives_valid_master_unlock_key_replacement() {
    exercise_protected_update_key_change(UpdateKeyChange::MasterUnlockKey).await;
}
#[tokio::test]
async fn protected_update_upload_survives_valid_current_vault_key_replacement() {
    exercise_protected_update_key_change(UpdateKeyChange::VaultKey).await;
}

#[tokio::test]
async fn native_generation_lock_cancels_and_drains_the_actual_image_http_transport() {
    exercise_image_retirement(RetirementKind::Generation, true).await;
}
#[tokio::test]
async fn stale_native_generation_cannot_cancel_current_image_http_transport() {
    exercise_image_retirement(RetirementKind::StaleGeneration, true).await;
}

#[tokio::test]
async fn held_image_status_does_not_delay_account_lock_or_start_new_upload_afterward() {
    exercise_image_retirement(RetirementKind::StatusLock, true).await;
}
#[tokio::test]
async fn refused_current_session_cancels_and_drains_actual_image_upload() {
    exercise_image_retirement(RetirementKind::RefusedSession, true).await;
}
#[tokio::test]
async fn stale_session_refusal_does_not_cancel_current_image_upload() {
    exercise_image_retirement(RetirementKind::StaleSession, true).await;
}

#[tokio::test]
async fn held_image_session_renewal_does_not_block_lock_or_reinstall_retired_session() {
    exercise_image_retirement(RetirementKind::RenewalLock, true).await;
}
#[tokio::test]
async fn held_image_renewal_cannot_replace_a_new_session_or_mark_it_for_reauthentication() {
    exercise_image_retirement(RetirementKind::RenewalSessionReplacement, true).await;
}
#[tokio::test]
async fn held_image_renewal_cannot_follow_account_replacement() {
    exercise_image_retirement(RetirementKind::RenewalAccountReplacement, true).await;
}
#[tokio::test]
async fn held_image_renewal_does_not_block_current_session_refusal() {
    exercise_image_retirement(RetirementKind::RenewalRefusal, true).await;
}

#[tokio::test]
async fn refused_held_image_renewal_cannot_mark_a_replacement_session_for_reauthentication() {
    exercise_image_retirement(RetirementKind::RenewalRejectedSessionReplacement, true).await;
}
