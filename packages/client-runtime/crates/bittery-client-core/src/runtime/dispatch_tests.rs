//! Slice B: what happens to an accepted Operation once the network is allowed to fail.
//!
//! The fake Device and fake Server both live in `operation_fixtures`, so these tests and the
//! reconciliation slice argue with the same Server behavior rather than with two stubs.

use super::operation_fixtures::*;
use super::*;
use crate::{
    auth_http::AuthenticatedOutcome,
    http_transport::{HttpHeader, HttpMethod, SerializedHttpExecutor},
    replica::{GuardedCommitPlan, PlanMutation},
    test_fixtures::TEST_VAULT_ID,
    CreateVaultType, VaultImageSourceInput,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::atomic::AtomicUsize;

#[test]
fn create_vault_recovery_classification_is_closed_and_independent_of_message_wording() {
    use super::create_vault_staging::CreateVaultRecoveryError;

    assert_eq!(
        dispatch::create_vault_recovery_policy(&CreateVaultRecoveryError::ParkedFenced),
        dispatch::CreateVaultRecoveryPolicy::ParkedFenced,
    );
    for message in [
        "contradictory authority",
        "fatal authority was fenced by a hostile message",
    ] {
        let classified = CreateVaultRecoveryError::from(RuntimeError::new(
            RuntimeErrorCode::InvariantViolation,
            message,
        ));
        match classified {
            CreateVaultRecoveryError::Fatal(error) => {
                assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
                assert_eq!(error.message, message);
                assert_eq!(
                    dispatch::create_vault_recovery_policy(
                        &CreateVaultRecoveryError::Fatal(error,)
                    ),
                    dispatch::CreateVaultRecoveryPolicy::FailAccount,
                );
            }
            CreateVaultRecoveryError::ParkedFenced => {
                panic!("fatal recovery was reclassified from its message")
            }
        }
    }
}

#[test]
fn production_create_vault_staging_exhaustively_maps_closed_wire_values() {
    use crate::server_contract::VaultImageStagingStatusResponse;

    let binding = super::create_vault_staging::CreateVaultStagingBinding {
        account_id: AccountId::from("account-1"),
        operation_id: "operation_image".into(),
        vault_id: TEST_VAULT_ID.into(),
        object_key: "vaults/image".into(),
        byte_length: 11,
        content_type: "image/avif".into(),
        sha256: "0".repeat(64),
    };
    let body =
        dispatch::ProductionOperationPort::staging_body(&binding).expect("closed MIME must bind");
    assert_eq!(
        serde_json::to_value(body.content_type).unwrap(),
        json!("image/avif")
    );

    let status = |response| dispatch::ProductionOperationPort::status(response, &binding);
    assert_eq!(
        status(VaultImageStagingStatusResponse::Absent {}).unwrap(),
        super::create_vault_staging::CreateVaultStagingStatus::Missing
    );
    assert_eq!(
        status(VaultImageStagingStatusResponse::Unconfirmed {
            object_key: binding.object_key.clone(),
            generation: 1,
            lease_expires_at: "2026-08-31T12:00:00Z".into(),
        })
        .unwrap(),
        super::create_vault_staging::CreateVaultStagingStatus::AwaitingUpload
    );
    assert_eq!(
        status(VaultImageStagingStatusResponse::Confirmed {
            object_key: binding.object_key.clone(),
            generation: 1,
            lease_expires_at: "2026-08-31T12:00:00Z".into(),
        })
        .unwrap(),
        super::create_vault_staging::CreateVaultStagingStatus::Confirmed
    );
    assert!(status(VaultImageStagingStatusResponse::CleanupPending {
        object_key: binding.object_key.clone(),
        generation: 1,
        lease_expires_at: "2026-08-31T12:00:00Z".into(),
    })
    .is_err());

    let mut invalid = binding;
    invalid.content_type = "image/svg+xml".into();
    assert!(dispatch::ProductionOperationPort::staging_body(&invalid).is_err());
}

struct DispatchImageSource(Option<Vec<u8>>);

#[async_trait]
impl crate::VaultImageSource for DispatchImageSource {
    async fn next_chunk(
        &mut self,
        _: usize,
    ) -> Result<Option<Vec<u8>>, crate::VaultImageSourceError> {
        Ok(self.0.take())
    }
    async fn close(&mut self) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
}

pub(super) struct DispatchImageSourcePort;

#[async_trait]
impl crate::VaultImageSourcePort for DispatchImageSourcePort {
    async fn claim(
        &self,
        _: &crate::VaultImageSourceGrant,
    ) -> Result<Box<dyn crate::VaultImageSource>, crate::VaultImageSourceError> {
        Ok(Box::new(DispatchImageSource(Some(b"image-bytes".to_vec()))))
    }
    async fn retire_account(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_account_retirement(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn begin_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn end_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn retire_vaults(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_vault_retirement(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn forget_account_vault_retirements(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn retire_runtime(&self, _: &str) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct ProductionVaultImageHttp {
    requests: Mutex<Vec<(String, String)>>,
    reject_create: AtomicBool,
    return_malformed_create_outcome: AtomicBool,
    return_retained_create_outcome: AtomicBool,
    lookup_unauthorized: AtomicUsize,
    put_unauthorized: AtomicUsize,
    apply_create_with_malformed_authority: AtomicBool,
    cleanup_failures: AtomicUsize,
    cleanup_unauthorized: AtomicUsize,
    cleanup_bodies: Mutex<Vec<Vec<u8>>>,
}

#[async_trait]
impl SerializedHttpExecutor for ProductionVaultImageHttp {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&request_json).unwrap();
        let method = request["method"].as_str().unwrap().to_owned();
        let url = request["url"].as_str().unwrap().to_owned();
        self.requests
            .lock()
            .unwrap()
            .push((method.clone(), url.clone()));
        let body: Vec<u8> = request["body"]
            .as_array()
            .unwrap()
            .iter()
            .map(|byte| byte.as_u64().unwrap() as u8)
            .collect();
        let response = if url.ends_with("/api/v1/sessions/current/refresh") {
            completed(
                200,
                serde_json::to_vec(&json!({
                    "token": SECOND_TOKEN,
                    "sessionId": "session-2",
                    "expiresAt": "2099-01-01T00:00:00Z"
                }))
                .unwrap(),
            )
        } else if url.ends_with("/vault-image-staging/status") {
            completed(
                200,
                serde_json::to_vec(&json!({ "state": "absent" })).unwrap(),
            )
        } else if url.ends_with("/vault-image-staging/grants") {
            let body: Value = serde_json::from_slice(&body).unwrap();
            let operation_id = url.split('/').nth_back(2).unwrap();
            let sha256 = body["sha256"].as_str().unwrap();
            let checksum = {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .encode(crate::auth_http::decode_sha256_hex(sha256).unwrap())
            };
            let object_key = format!(
                "vaults/{USER}/{}/create/{operation_id}-{}",
                body["vaultId"].as_str().unwrap(),
                sha256
            );
            completed(
                200,
                serde_json::to_vec(&json!({
                    "objectKey": object_key,
                    "uploadUrl": "https://objects.example.test/staged-image",
                    "uploadHeaders": [
                        { "name": "Content-Length", "value": body["byteLength"].as_i64().unwrap().to_string() },
                        { "name": "Content-Type", "value": body["contentType"].as_str().unwrap() },
                        { "name": "x-amz-content-sha256", "value": sha256 },
                        { "name": "x-amz-checksum-sha256", "value": checksum }
                    ],
                    "generation": 1,
                    "leaseExpiresAt": "2099-01-01T00:00:00Z"
                }))
                .unwrap(),
            )
        } else if url == "https://objects.example.test/staged-image" {
            completed(200, Vec::new())
        } else if url.ends_with("/vault-image-staging/confirmations") {
            let body: Value = serde_json::from_slice(&body).unwrap();
            let operation_id = url.split('/').nth_back(2).unwrap();
            completed(200, serde_json::to_vec(&json!({
                "state": "confirmed",
                "objectKey": format!("vaults/{USER}/{}/create/{operation_id}-{}", body["vaultId"].as_str().unwrap(), body["sha256"].as_str().unwrap()),
                "generation": 1,
                "leaseExpiresAt": "2099-01-01T00:00:00Z"
            })).unwrap())
        } else if method == "GET" && url.contains("/api/v1/operations/") {
            if self
                .lookup_unauthorized
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                    value.checked_sub(1)
                })
                .is_ok()
            {
                completed(401, Vec::new())
            } else if !self.return_retained_create_outcome.load(Ordering::SeqCst) {
                completed(404, Vec::new())
            } else {
                let operation_id = url.rsplit('/').next().unwrap();
                completed(
                    200,
                    serde_json::to_vec(&json!({
                        "operationId": operation_id,
                        "kind": "create_vault",
                        "result": { "status": "rejected", "code": "vault_id_conflict" }
                    }))
                    .unwrap(),
                )
            }
        } else if method == "PUT" && url.contains("/api/v1/vaults/") {
            if self
                .put_unauthorized
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                    value.checked_sub(1)
                })
                .is_ok()
            {
                completed(401, Vec::new())
            } else if self.return_malformed_create_outcome.load(Ordering::SeqCst) {
                completed(
                    200,
                    serde_json::to_vec(&json!({
                        "operationId": "another-operation",
                        "kind": "create_vault",
                        "result": { "status": "rejected", "code": "vault_id_conflict" }
                    }))
                    .unwrap(),
                )
            } else if self.reject_create.load(Ordering::SeqCst) {
                let operation_id = request["headers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|header| {
                        header["name"]
                            .as_str()
                            .unwrap()
                            .eq_ignore_ascii_case("idempotency-key")
                    })
                    .unwrap()["value"]
                    .as_str()
                    .unwrap();
                completed(
                    200,
                    serde_json::to_vec(&json!({
                        "operationId": operation_id,
                        "kind": "create_vault",
                        "result": { "status": "rejected", "code": "vault_id_conflict" }
                    }))
                    .unwrap(),
                )
            } else if self
                .apply_create_with_malformed_authority
                .load(Ordering::SeqCst)
            {
                let operation_id = request["headers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|header| {
                        header["name"]
                            .as_str()
                            .unwrap()
                            .eq_ignore_ascii_case("idempotency-key")
                    })
                    .unwrap()["value"]
                    .as_str()
                    .unwrap();
                completed(
                    200,
                    serde_json::to_vec(&json!({
                        "operationId": operation_id,
                        "kind": "create_vault",
                        "result": {
                            "status": "applied",
                            "vaultId": url.rsplit('/').next().unwrap()
                        }
                    }))
                    .unwrap(),
                )
            } else {
                completed(503, b"{}".to_vec())
            }
        } else if method == "GET" && url.contains("/api/v1/vaults/") {
            completed(
                200,
                serde_json::to_vec(&json!({
                    "id": "contradictory-vault-id",
                    "name": "Runtime Vault",
                    "vaultType": "personal",
                    "icon": "lock",
                    "imageUrl": null,
                    "userRole": "owner",
                    "itemCount": "0",
                    "memberCount": "1",
                    "createdAt": "2026-08-31T00:00:00Z"
                }))
                .unwrap(),
            )
        } else if method == "DELETE" && url.ends_with("/vault-image-staging") {
            self.cleanup_bodies.lock().unwrap().push(body.clone());
            if self
                .cleanup_unauthorized
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                    value.checked_sub(1)
                })
                .is_ok()
            {
                completed(401, b"{}".to_vec())
            } else if self
                .cleanup_failures
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                    value.checked_sub(1)
                })
                .is_ok()
            {
                completed(503, b"{}".to_vec())
            } else {
                completed(
                    200,
                    serde_json::to_vec(&json!({ "success": true })).unwrap(),
                )
            }
        } else {
            panic!("unexpected production Vault image route {method} {url}")
        };
        Ok(response.to_string())
    }

    fn cancel(&self, _: &str) {}
}

#[tokio::test]
async fn malformed_create_vault_outcome_fails_durably_without_mutation_or_dispatch_spin() {
    let harness = seeded(false).await;
    let authority_before = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .bootstrap
        .vaults;
    let operation_id = match harness
        .runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: harness.account_id.clone(),
                name: "Runtime Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::VaultCreationAccepted { operation_id, .. } => operation_id,
        other => panic!("expected create-Vault acceptance, got {other:?}"),
    };
    let server = Arc::new(ProductionVaultImageHttp::default());
    server
        .return_malformed_create_outcome
        .store(true, Ordering::SeqCst);
    let runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    runtime
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap()
        .unwrap();

    assert!(matches!(
        runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Parked
    ));
    let after = runtime.replica().snapshot(&harness.account_id).unwrap();
    assert_eq!(after.failure, Some(RuntimeErrorCode::InvariantViolation));
    assert_eq!(after.bootstrap.vaults, authority_before);
    assert!(after
        .operations
        .iter()
        .any(|operation| operation.operation_id == operation_id));
    let requests = server.requests.lock().unwrap().len();
    assert!(matches!(
        runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Parked
    ));
    assert_eq!(server.requests.lock().unwrap().len(), requests);
    assert!(harness.timer.requested().is_empty());
}

#[tokio::test]
async fn retained_create_vault_receipts_without_reading_obsolete_point_authority() {
    let harness = seeded(false).await;
    let operation_id = match harness
        .runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: harness.account_id.clone(),
                name: "Runtime Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::VaultCreationAccepted { operation_id, .. } => operation_id,
        other => panic!("expected create-Vault acceptance, got {other:?}"),
    };
    let server = Arc::new(ProductionVaultImageHttp::default());
    server
        .apply_create_with_malformed_authority
        .store(true, Ordering::SeqCst);
    let runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    runtime
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap()
        .unwrap();

    assert!(matches!(
        runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Progressed
    ));
    let after = runtime.replica().snapshot(&harness.account_id).unwrap();
    assert_eq!(after.failure, None);
    assert_eq!(
        after.bootstrap.state,
        crate::replica::ReplicaState::RefreshRequired
    );
    assert_eq!(after.receipts.len(), 1);
    assert_eq!(after.receipts[0].operation_id, operation_id);
    assert!(!after
        .operations
        .iter()
        .any(|operation| operation.operation_id == operation_id));
    assert!(server
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|request| { !(request.0 == "GET" && request.1.contains("/api/v1/vaults/")) }));
    let requests = server.requests.lock().unwrap().len();
    assert!(matches!(
        runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Parked
    ));
    assert_eq!(server.requests.lock().unwrap().len(), requests);
    assert!(harness.timer.requested().is_empty());
}

#[tokio::test]
async fn accepted_create_vault_reaches_the_production_dispatch_gate() {
    let harness = seeded(false).await;
    harness.server.script([Fault::Status(503)]);
    let operation_id = match harness
        .runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: harness.account_id.clone(),
                name: "Runtime Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::VaultCreationAccepted { operation_id, .. } => operation_id,
        other => panic!("expected create-Vault acceptance, got {other:?}"),
    };

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let operation = harness
        .operation()
        .expect("transient create remains durable");
    assert_eq!(operation.scheduling.attempt_count, 1);
    let request = harness.server.create_requests().pop().unwrap();
    assert_eq!(
        request.url,
        format!("{SERVER_URL}/api/v1/vaults/{}", operation.vault_id())
    );
    assert_eq!(
        request.header("idempotency-key"),
        Some(operation_id.as_str())
    );
}

#[tokio::test]
async fn retried_production_create_vault_looks_up_then_proves_with_identical_put() {
    let harness = seeded(false).await;
    let operation_id = match harness
        .runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: harness.account_id.clone(),
                name: "Lookup Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::VaultCreationAccepted { operation_id, .. } => operation_id,
        other => panic!("expected create-Vault acceptance, got {other:?}"),
    };
    let server = Arc::new(ProductionVaultImageHttp::default());
    let runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    runtime
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap()
        .unwrap();

    runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    server.requests.lock().unwrap().clear();
    server
        .return_retained_create_outcome
        .store(true, Ordering::SeqCst);
    server.reject_create.store(true, Ordering::SeqCst);
    runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let requests = server.requests.lock().unwrap();
    let operation_route = format!("{SERVER_URL}/api/v1/operations/{operation_id}");
    let retry = requests.as_slice();
    assert_eq!(retry[0], ("GET".into(), operation_route));
    assert_eq!(retry[1].0, "PUT");
    assert!(retry[1].1.contains("/api/v1/vaults/"));
    assert!(runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .operations
        .is_empty());
}

#[tokio::test]
async fn production_create_lookup_and_put_share_one_session_renewal_budget() {
    let harness = seeded(false).await;
    let operation_id = match harness
        .runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: harness.account_id.clone(),
                name: "Renewal Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "lock".into(),
                image_source: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::VaultCreationAccepted { operation_id, .. } => operation_id,
        other => panic!("expected create-Vault acceptance, got {other:?}"),
    };
    let server = Arc::new(ProductionVaultImageHttp::default());
    server.lookup_unauthorized.store(1, Ordering::SeqCst);
    server.put_unauthorized.store(1, Ordering::SeqCst);
    let runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    runtime.replica().load(&harness.account_id).await.unwrap();

    runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let routes = server.requests.lock().unwrap().clone();
    assert_eq!(
        routes
            .iter()
            .filter(|(_, url)| url.ends_with("/refresh"))
            .count(),
        1
    );
    assert_eq!(
        routes.iter().filter(|(method, _)| method == "GET").count(),
        2
    );
    assert_eq!(
        routes.iter().filter(|(method, _)| method == "PUT").count(),
        1
    );
    assert!(runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .operations
        .iter()
        .any(|operation| operation.operation_id == operation_id));
    assert_eq!(
        runtime
            .waiting_reasons
            .lock()
            .unwrap()
            .get(&harness.account_id),
        Some(&AccountWaitingReason::ReauthenticationRequired)
    );
}

#[tokio::test]
async fn a_selectively_parked_image_does_not_starve_another_vaults_accepted_work() {
    let harness = seeded(false).await;
    harness
        .runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    harness.runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "parked-image-source",
            Arc::new(DispatchImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    for name in ["First selected image", "Second selected image"] {
        harness
            .runtime
            .request(
                RuntimeRequest::CreateVault {
                    account_id: harness.account_id.clone(),
                    name: name.into(),
                    vault_type: CreateVaultType::Personal,
                    icon: "image".into(),
                    image_source: Some(VaultImageSourceInput {
                        capability_id: "browser-image".into(),
                        byte_length: 11,
                        content_type: "image/png".into(),
                    }),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    let server = Arc::new(ProductionVaultImageHttp::default());
    server.reject_create.store(true, Ordering::SeqCst);
    let runtime = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    runtime.replica.load(&harness.account_id).await.unwrap();
    runtime.unlock_account(&harness.account_id).await.unwrap();
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "parked-image-source",
            Arc::new(DispatchImageSourcePort),
            artifacts,
        )
        .unwrap(),
    );
    let before = runtime.replica.snapshot(&harness.account_id).unwrap();
    assert_eq!(before.operations.len(), 2);
    // Select the actual first scheduled Operation, independent of random ID ordering.
    let parked = before.operations[0].clone();
    let other = before.operations[1].clone();
    let retirement = runtime
        .foreground_attachments
        .begin_vault_retirement(
            &harness.account_id,
            &before.incarnation,
            &[parked.vault_id().to_owned()],
            super::foreground_attachment_lifecycle::VaultRetirementProof::DurableJournal {
                revision: before.revision,
            },
        )
        .unwrap();
    retirement.drain().await;
    runtime
        .foreground_attachments
        .acknowledge_vault_retirement(&retirement)
        .unwrap();
    assert!(!runtime.has_vault_retirement_work(&before));
    assert!(
        matches!(
            runtime.dispatch_eligible_operations().await,
            dispatch::DispatchPass::Progressed
        ),
        "a parked image must not stop eligible work for another Vault"
    );
    let after = runtime.replica.snapshot(&harness.account_id).unwrap();
    assert_eq!(after.operations, vec![parked.clone()]);
    assert!(after
        .receipts
        .iter()
        .any(|receipt| receipt.operation_id == other.operation_id));
    let uploads = || {
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, url)| url == "https://objects.example.test/staged-image")
            .count()
    };
    assert_eq!(uploads(), 1);
    for _ in 0..2 {
        assert!(matches!(
            runtime.dispatch_eligible_operations().await,
            dispatch::DispatchPass::Parked
        ));
    }
    assert_eq!(uploads(), 1);
    assert!(
        harness.timer.requested().is_empty(),
        "selective parking must not busy-loop on a timer"
    );
    assert_eq!(
        runtime
            .replica
            .snapshot(&harness.account_id)
            .unwrap()
            .operations,
        vec![parked]
    );
    runtime.close().await;
    harness.runtime.close().await;
}

#[tokio::test]
async fn production_create_vault_dispatch_stages_one_exact_image_before_put() {
    let harness = seeded(false).await;
    harness
        .runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    harness.runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-image-dispatch",
            Arc::new(DispatchImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    let (operation_id, vault_id) = match harness
        .runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: harness.account_id.clone(),
                name: "Image Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "image".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "browser-image".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::VaultCreationAccepted {
            operation_id,
            vault_id,
            ..
        } => (operation_id, vault_id),
        other => panic!("expected image Vault acceptance, got {other:?}"),
    };
    let server = Arc::new(ProductionVaultImageHttp::default());
    server.reject_create.store(true, Ordering::SeqCst);
    server.cleanup_unauthorized.store(2, Ordering::SeqCst);
    let restarted = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    restarted
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap()
        .unwrap();
    restarted.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-image-dispatch",
            Arc::new(DispatchImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );

    restarted.unlock_account(&harness.account_id).await.unwrap();
    restarted
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let pending = restarted.replica().snapshot(&harness.account_id).unwrap();
    assert!(pending.operations.is_empty());
    let pending_receipt = pending
        .receipts
        .iter()
        .find(|receipt| receipt.operation_id == operation_id)
        .unwrap();
    assert!(matches!(
        pending_receipt.result,
        crate::replica::OperationOutcomeResult::VaultRejected { .. }
    ));
    assert!(pending_receipt
        .create_vault_cleanup
        .as_ref()
        .is_some_and(|cleanup| cleanup.remote_staging_pending));
    assert_eq!(
        restarted
            .waiting_reasons
            .lock()
            .unwrap()
            .get(&harness.account_id),
        Some(&AccountWaitingReason::ReauthenticationRequired)
    );

    let recovered = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    recovered
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap()
        .unwrap();
    recovered.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-image-dispatch",
            Arc::new(DispatchImageSourcePort),
            artifacts,
        )
        .unwrap(),
    );
    assert!(matches!(
        recovered.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Progressed
    ));
    let completed = recovered.replica().snapshot(&harness.account_id).unwrap();
    let completed_receipt = completed
        .receipts
        .iter()
        .find(|receipt| receipt.operation_id == operation_id)
        .unwrap();
    assert!(completed_receipt.create_vault_cleanup.is_none());
    let cleanup_bodies = server.cleanup_bodies.lock().unwrap();
    assert_eq!(cleanup_bodies.len(), 3);
    assert!(cleanup_bodies.windows(2).all(|pair| pair[0] == pair[1]));
    let routes: Vec<_> = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|(method, url)| (method.clone(), url.rsplit('/').next().unwrap().to_owned()))
        .collect();
    assert_eq!(
        routes,
        vec![
            ("POST".into(), "status".into()),
            ("POST".into(), "grants".into()),
            ("PUT".into(), "staged-image".into()),
            ("POST".into(), "confirmations".into()),
            ("GET".into(), operation_id),
            ("PUT".into(), vault_id),
            ("DELETE".into(), "vault-image-staging".into()),
            ("POST".into(), "refresh".into()),
            ("DELETE".into(), "vault-image-staging".into()),
            ("DELETE".into(), "vault-image-staging".into()),
        ]
    );
}

#[tokio::test]
async fn production_sign_out_best_effort_replays_pending_image_cleanup_without_a_test_port() {
    let harness = seeded(false).await;
    harness
        .runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    harness.runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-signout-cleanup",
            Arc::new(DispatchImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    let operation_id = match harness
        .runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: harness.account_id.clone(),
                name: "Sign-out image".into(),
                vault_type: CreateVaultType::Personal,
                icon: "image".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "signout-image".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    {
        RuntimeResponse::VaultCreationAccepted { operation_id, .. } => operation_id,
        other => panic!("expected image Vault acceptance, got {other:?}"),
    };
    let server = Arc::new(ProductionVaultImageHttp::default());
    let production = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        server.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    production
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap()
        .unwrap();
    production
        .unlock_account(&harness.account_id)
        .await
        .unwrap();
    production.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-signout-cleanup",
            Arc::new(DispatchImageSourcePort),
            artifacts,
        )
        .unwrap(),
    );

    let result = production
        .request(
            RuntimeRequest::SignOut {
                account_id: harness.account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await;

    let cleanup_bodies = server.cleanup_bodies.lock().unwrap();
    assert_eq!(
        cleanup_bodies.len(),
        1,
        "sign-out result: {result:?}; requests: {:?}",
        server.requests.lock().unwrap()
    );
    let binding: Value = serde_json::from_slice(&cleanup_bodies[0]).unwrap();
    assert!(binding["vaultId"].as_str().is_some());
    assert_eq!(binding["byteLength"], json!(11));
    assert_eq!(binding["contentType"], json!("image/png"));
    assert_eq!(
        server
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, url)| method == "DELETE" && url.ends_with("/vault-image-staging"))
            .count(),
        1
    );
    assert!(server
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|(_, url)| url.contains(&operation_id)));
}

#[derive(Clone, Copy)]
enum ExistingDispatchCase {
    Update,
    Favorite,
    Trash,
    Restore,
    Move,
    PermanentlyDelete,
}

impl ExistingDispatchCase {
    fn all() -> [Self; 6] {
        [
            Self::Update,
            Self::Favorite,
            Self::Trash,
            Self::Restore,
            Self::Move,
            Self::PermanentlyDelete,
        ]
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

    fn method(self) -> &'static str {
        match self {
            Self::Update | Self::Favorite => "PATCH",
            Self::Trash | Self::PermanentlyDelete => "DELETE",
            Self::Restore | Self::Move => "POST",
        }
    }

    fn path(self) -> &'static str {
        match self {
            Self::Update | Self::Trash => "/api/v1/items/item-existing",
            Self::Favorite => "/api/v1/items/item-existing/favorite",
            Self::Restore => "/api/v1/items/item-existing/restore",
            Self::Move => "/api/v1/items/item-existing/moves",
            Self::PermanentlyDelete => "/api/v1/items/item-existing/permanent",
        }
    }
}

async fn existing_item_kind_reaches_the_shared_dispatcher(case: ExistingDispatchCase) {
    let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
    harness.server.script([Fault::Status(503)]);
    let (operation_id, _) = harness
        .accept_existing(case.request(harness.account_id.clone()))
        .await;

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    assert_eq!(harness.operation().unwrap().scheduling.attempt_count, 1);
}

macro_rules! existing_dispatch_case {
    ($name:ident, $case:expr) => {
        #[tokio::test]
        async fn $name() {
            existing_item_kind_reaches_the_shared_dispatcher($case).await;
        }
    };
}

existing_dispatch_case!(
    update_item_reaches_the_shared_dispatcher,
    ExistingDispatchCase::Update
);
existing_dispatch_case!(
    favorite_reaches_the_shared_dispatcher,
    ExistingDispatchCase::Favorite
);
existing_dispatch_case!(
    trash_reaches_the_shared_dispatcher,
    ExistingDispatchCase::Trash
);
existing_dispatch_case!(
    restore_reaches_the_shared_dispatcher,
    ExistingDispatchCase::Restore
);
existing_dispatch_case!(
    move_reaches_the_shared_dispatcher,
    ExistingDispatchCase::Move
);
existing_dispatch_case!(
    permanent_delete_reaches_the_shared_dispatcher,
    ExistingDispatchCase::PermanentlyDelete
);

#[tokio::test]
async fn every_existing_item_kind_retries_immutable_requests_without_an_attempt_limit() {
    let faults = [
        Fault::NetworkFailure,
        Fault::Status(500),
        Fault::Status(502),
        Fault::NetworkFailure,
        Fault::Status(503),
        Fault::Status(429),
        Fault::Status(408),
    ];
    for case in ExistingDispatchCase::all() {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        harness.server.script(faults);
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        let accepted = harness.operation().unwrap();
        let mut delays = Vec::new();

        for expected_attempt_count in 1..=7 {
            harness
                .runtime
                .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
                .await;
            let retriable = harness
                .operation()
                .expect("a transient answer stays accepted");
            assert_eq!(retriable.scheduling.attempt_count, expected_attempt_count);
            let delay = retriable
                .scheduling
                .not_before_ms
                .saturating_sub(harness.clock.now());
            delays.push(delay);
            harness.clock.advance(delay);
        }

        assert_eq!(
            delays,
            vec![1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000]
        );
        let after_retries = harness.operation().unwrap();
        assert_eq!(after_retries.request, accepted.request);
        assert_eq!(
            after_retries.request_fingerprint,
            accepted.request_fingerprint
        );
        let requests = harness.server.existing_item_mutation_requests();
        assert_eq!(requests.len(), 7);
        let mut expected_headers: Vec<(String, String)> = accepted
            .request
            .headers
            .iter()
            .map(|header| (header.name.clone(), header.value.clone()))
            .collect();
        expected_headers.extend([
            ("Idempotency-Key".into(), operation_id.clone()),
            ("Bittery-Client-Id".into(), "client-1".into()),
            ("Bittery-Client-Platform".into(), "web".into()),
            ("Bittery-Client-Version".into(), "1.0.0".into()),
            ("Authorization".into(), format!("Bearer {FIRST_TOKEN}")),
        ]);
        for request in requests {
            assert_eq!(request.method, case.method());
            assert_eq!(request.url, format!("{SERVER_URL}{}", case.path()));
            assert_eq!(request.body, accepted.request.body);
            assert_eq!(request.headers, expected_headers);
        }
    }
}

#[tokio::test]
async fn every_existing_item_kind_honors_durable_backoff_after_restart() {
    for case in ExistingDispatchCase::all() {
        let harness = seeded_with_existing_item(true, case.needs_deleted_authority()).await;
        harness.server.script([Fault::NetworkFailure]);
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        harness
            .runtime
            .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
            .await;
        assert_eq!(
            harness.operation().unwrap().scheduling.not_before_ms,
            START_MS + 1_000
        );
        harness.runtime.close().await;

        harness.clock.advance(400);
        let restarted = Runtime::with_test_dispatch_environment(
            harness.replica.clone(),
            harness.platform.clone(),
            harness.server.clone(),
            auth_config(),
            harness.clock.clone(),
            harness.timer.clone(),
        );
        restarted
            .replica()
            .load(&harness.account_id)
            .await
            .unwrap()
            .unwrap();
        match restarted.dispatch_eligible_operations().await {
            dispatch::DispatchPass::WaitFor { milliseconds } => assert_eq!(milliseconds, 600),
            _ => panic!("the restarted Runtime must honor the durable deadline"),
        }
        assert_eq!(harness.server.existing_item_mutation_requests().len(), 1);

        harness.clock.advance(600);
        harness.server.script([Fault::Status(503)]);
        assert!(matches!(
            restarted.dispatch_eligible_operations().await,
            dispatch::DispatchPass::Progressed
        ));
        assert_eq!(harness.server.existing_item_mutation_requests().len(), 2);
        assert_eq!(
            restarted
                .replica()
                .snapshot(&harness.account_id)
                .unwrap()
                .operations[0]
                .scheduling
                .attempt_count,
            2
        );
        restarted.close().await;
    }
}

#[tokio::test]
async fn forced_duplicate_dispatch_replays_each_existing_item_request_exactly() {
    for case in ExistingDispatchCase::all() {
        let harness = seeded_with_existing_item(false, case.needs_deleted_authority()).await;
        harness
            .server
            .script([Fault::NetworkFailure, Fault::Status(503)]);
        let (operation_id, _) = harness
            .accept_existing(case.request(harness.account_id.clone()))
            .await;
        let accepted = harness.operation().unwrap();
        let http = AuthHttpClient::new(
            &harness.runtime.http_transport,
            SERVER_URL,
            false,
            auth_config(),
        )
        .unwrap();

        let first = http
            .dispatch_operation(
                FIRST_TOKEN,
                &operation_id,
                &accepted.request,
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let duplicate = http
            .dispatch_operation(
                FIRST_TOKEN,
                &operation_id,
                &accepted.request,
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        assert!(matches!(first, AuthenticatedOutcome::Transient));
        assert!(matches!(duplicate, AuthenticatedOutcome::Transient));

        let requests = harness.server.existing_item_mutation_requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].method, requests[1].method);
        assert_eq!(requests[0].url, requests[1].url);
        assert_eq!(requests[0].headers, requests[1].headers);
        assert_eq!(requests[0].body, requests[1].body);
        assert!(harness.operation().is_some());
    }
}

// ---------------------------------------------------------------- the required behavior

#[tokio::test]
async fn an_operation_outlives_more_than_five_transient_failures_with_identical_bytes() {
    let harness = seeded(false).await;
    harness.server.script([
        Fault::NetworkFailure,
        Fault::Status(500),
        Fault::Status(502),
        Fault::NetworkFailure,
        Fault::Status(503),
        Fault::Status(429),
    ]);
    let (operation_id, item_id) = harness.accept_create().await;
    let accepted = harness.operation().unwrap();

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("seven dispatch attempts", || harness.server.creates() >= 7).await;
    until("the seventh attempt is reconciled", || {
        harness
            .runtime
            .replica()
            .snapshot(&harness.account_id)
            .is_some_and(|snapshot| snapshot.operations.is_empty())
    })
    .await;
    settle().await;

    // Six failures never ended the Operation, and the seventh attempt reached the Server.
    assert_eq!(harness.server.creates(), 7);
    assert_eq!(harness.server.created_items(), vec![item_id.clone()]);

    let requests = harness.server.create_requests();
    assert_eq!(requests.len(), 7);
    for request in &requests {
        // Identity and bytes are the same on every attempt. Nothing about a retry is new.
        assert_eq!(
            request.header("idempotency-key"),
            Some(operation_id.as_str())
        );
        assert_eq!(request.method, "PUT");
        assert_eq!(
            request.url,
            format!("{SERVER_URL}/api/v1/vaults/{TEST_VAULT_ID}/items/{item_id}")
        );
        assert_eq!(request.body, accepted.request.body);
        assert_eq!(request.header("content-type"), Some("application/json"));
        assert_eq!(
            request.header("authorization"),
            Some(format!("Bearer {FIRST_TOKEN}").as_str())
        );
    }

    // Bounded exponential backoff, and a count that only ever describes what happened.
    assert_eq!(
        harness.timer.requested(),
        vec![1_000, 2_000, 4_000, 8_000, 16_000, 32_000]
    );
    // Only the seventh attempt's authoritative outcome ended it, and the compact receipt names
    // the same identity and the same fingerprint the six failures never moved.
    let receipts = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .receipts;
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].operation_id, operation_id);
    assert_eq!(
        receipts[0].request_fingerprint,
        accepted.request_fingerprint
    );

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn backoff_is_durable_and_is_honored_by_the_next_process() {
    let harness = seeded(true).await;
    harness.server.script([Fault::NetworkFailure]);
    let (operation_id, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("one failed attempt and a persisted backoff", || {
        harness
            .operation()
            .is_some_and(|operation| operation.scheduling.attempt_count == 1)
    })
    .await;
    let parked = harness.operation().unwrap();
    assert_eq!(parked.scheduling.not_before_ms, START_MS + 1_000);
    harness.runtime.close().await;
    dispatcher.await.unwrap();

    // A new process reads the same durable rows. Backoff was never in memory.
    let clock = TestClock::new();
    clock.advance(400);
    let timer = TestTimer::holding(clock.clone());
    let restarted = Runtime::with_test_dispatch_environment(
        harness.replica.clone(),
        harness.platform.clone(),
        harness.server.clone(),
        auth_config(),
        clock.clone(),
        timer.clone(),
    );
    restarted
        .replica()
        .load(&harness.account_id)
        .await
        .unwrap()
        .unwrap();
    let restored = restarted
        .replica()
        .snapshot(&harness.account_id)
        .unwrap()
        .operations[0]
        .clone();
    assert_eq!(restored.scheduling.attempt_count, 1);
    assert_eq!(restored.scheduling.not_before_ms, START_MS + 1_000);
    assert_eq!(restored.operation_id, operation_id);

    // This fixture isolates durable scheduling. A locked owner correctly retains the result
    // until authority can be decrypted; an instantly advancing test timer would spin its retry.
    restarted.unlock_account(&harness.account_id).await.unwrap();
    let before = harness.server.creates();
    let dispatcher = tokio::spawn(Arc::clone(&restarted).run_operation_dispatch());
    until("the restart waits out the remaining backoff", || {
        !timer.requested().is_empty()
    })
    .await;
    settle().await;
    // It waited exactly the remainder, and sent nothing early.
    assert_eq!(timer.requested(), vec![600]);
    assert_eq!(harness.server.creates(), before);

    clock.advance(600);
    timer.hold.store(false, Ordering::SeqCst);
    timer.released.notify_waiters();
    until("the deferred attempt runs", || {
        harness.server.creates() == before + 1
    })
    .await;
    assert_eq!(harness.server.created_items(), vec![item_id]);
    restarted.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn a_lost_lease_duplicates_no_effect_and_loses_no_operation() {
    let harness = seeded(false).await;
    let (operation_id, item_id) = harness.accept_create().await;
    let accepted = harness.operation().unwrap();

    // The lease is an optimization with an expiry, so a stalled or dead holder cannot pin work.
    let held = harness
        .runtime
        .dispatch_leases
        .acquire(&operation_id, harness.clock.now())
        .expect("a free Operation leases");
    assert!(
        harness
            .runtime
            .dispatch_leases
            .acquire(&operation_id, harness.clock.now())
            .is_none(),
        "a live lease suppresses a second local send"
    );
    harness.clock.advance(dispatch::DISPATCH_LEASE_MS + 1);
    let stolen = harness
        .runtime
        .dispatch_leases
        .acquire(&operation_id, harness.clock.now())
        .expect("an expired lease is not a lock");
    // Losing the holder's guard, exactly as a dead process would, frees nothing and breaks nothing.
    std::mem::forget(held);
    drop(stolen);

    // Two stale local senders now believe they own the same Operation. The Account execution
    // fence serializes them, then current durable truth prevents the second HTTP send after the
    // first reconciles. The lease remains only an optimization; the Account writer is the local
    // ownership contract.
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    harness
        .runtime
        .dispatch_captured_ignoring_lease(&snapshot, &accepted)
        .await;
    harness
        .runtime
        .dispatch_captured_ignoring_lease(&snapshot, &accepted)
        .await;

    assert_eq!(harness.server.creates(), 1);
    assert_eq!(harness.server.created_items(), vec![item_id]);
    let requests = harness.server.create_requests();
    assert_eq!(requests[0].body, accepted.request.body);
    assert_eq!(
        requests[0].header("idempotency-key"),
        Some(operation_id.as_str())
    );

    // The one accepted immutable request lands on one completion, never a local discard.
    let after = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(after.operations.is_empty());
    assert_eq!(after.receipts.len(), 1);
    assert_eq!(after.receipts[0].operation_id, operation_id);
}

#[tokio::test]
async fn a_renewable_session_error_refreshes_and_keeps_the_same_bytes() {
    let harness = seeded(false).await;
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);
    harness.server.accepted_tokens.lock().unwrap().clear();
    let (operation_id, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Item is created after a Session renewal", || {
        !harness.server.created_items().is_empty()
    })
    .await;
    settle().await;

    assert_eq!(harness.server.refresh_calls.load(Ordering::SeqCst), 1);
    assert_eq!(harness.server.created_items(), vec![item_id]);
    let requests = harness.server.create_requests();
    // The credential changed between attempts; nothing else did.
    assert_eq!(
        requests[0].header("authorization"),
        Some(format!("Bearer {FIRST_TOKEN}").as_str())
    );
    assert_eq!(
        requests[1].header("authorization"),
        Some(format!("Bearer {SECOND_TOKEN}").as_str())
    );
    assert_eq!(requests[0].body, requests[1].body);
    assert_eq!(
        requests[0].header("idempotency-key"),
        Some(operation_id.as_str())
    );
    assert_eq!(
        requests[1].header("idempotency-key"),
        Some(operation_id.as_str())
    );

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn retry_lookup_refresh_replaces_the_session_used_by_the_following_send() {
    let harness = seeded(false).await;
    harness.server.script([Fault::NetworkFailure]);
    let (operation_id, item_id) = harness.accept_create().await;

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;
    assert_eq!(harness.operation().unwrap().scheduling.attempt_count, 1);
    harness.clock.advance(1_000);
    harness.server.accepted_tokens.lock().unwrap().clear();
    *harness.server.refresh.lock().unwrap() = RefreshBehavior::Renews(SECOND_TOKEN);

    harness
        .runtime
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    assert_eq!(
        harness.server.refresh_calls.load(Ordering::SeqCst),
        1,
        "lookup renewal must replace the Session used by the send"
    );
    assert_eq!(harness.server.created_items(), vec![item_id]);
    let requests = harness.server.create_requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].header("authorization"),
        Some("Bearer session-token-1")
    );
    assert_eq!(
        requests[1].header("authorization"),
        Some("Bearer session-token-2")
    );
}

#[tokio::test]
async fn an_unrenewable_session_parks_the_operation_and_resumes_when_a_session_arrives() {
    let harness = seeded(false).await;
    harness.server.accepted_tokens.lock().unwrap().clear();
    let (_, item_id) = harness.accept_create().await;

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("the Account reports it needs reauthentication", || {
        harness.waiting_reason() == Some(AccountWaitingReason::ReauthenticationRequired)
    })
    .await;

    // Parked is parked: no timer, no further sends, no busy loop.
    let creates = harness.server.creates();
    let refreshes = harness.server.refresh_calls.load(Ordering::SeqCst);
    settle().await;
    assert_eq!(harness.server.creates(), creates);
    assert_eq!(
        harness.server.refresh_calls.load(Ordering::SeqCst),
        refreshes
    );
    assert!(harness.timer.requested().is_empty());
    assert!(harness.operation().is_some(), "parking never discards work");

    // A Session arrives, and the same durable bytes go out again.
    harness
        .server
        .accepted_tokens
        .lock()
        .unwrap()
        .push(SECOND_TOKEN.to_owned());
    store_session(&harness.runtime, &harness.account_id, SECOND_TOKEN).await;
    harness.runtime.note_session_available(&harness.account_id);

    until("the parked Operation resumes", || {
        !harness.server.created_items().is_empty()
    })
    .await;
    assert_eq!(harness.server.created_items(), vec![item_id]);
    assert_eq!(harness.waiting_reason(), None);

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

// What an HTTP success alone is worth now lives in `outcome_tests`: a `200` the Runtime cannot
// reconcile leaves the Operation and overlay unchanged; Bootstrap alone owns page progress.

#[tokio::test]
async fn dispatch_attaches_only_what_the_durable_bytes_deliberately_omit() {
    let harness = seeded(false).await;
    let (operation_id, _) = harness.accept_create().await;
    let accepted = harness.operation().unwrap();
    assert_eq!(
        accepted.request.headers,
        vec![HttpHeader {
            name: "Content-Type".to_owned(),
            value: "application/json".to_owned(),
        }]
    );
    assert_eq!(accepted.request.method, HttpMethod::Put);

    let dispatcher = tokio::spawn(Arc::clone(&harness.runtime).run_operation_dispatch());
    until("one attempt", || harness.server.creates() == 1).await;
    let sent = harness.server.create_requests()[0].clone();

    let names: Vec<String> = sent
        .headers
        .iter()
        .map(|(name, _)| name.to_ascii_lowercase())
        .collect();
    assert_eq!(
        names,
        vec![
            "content-type",
            "idempotency-key",
            "bittery-client-id",
            "bittery-client-platform",
            "bittery-client-version",
            "authorization",
        ]
    );
    // The Operation ID is the wire idempotency key, exactly as the Server route requires.
    assert_eq!(sent.header("idempotency-key"), Some(operation_id.as_str()));
    assert_eq!(
        sent.header("authorization"),
        Some(format!("Bearer {FIRST_TOKEN}").as_str())
    );

    harness.runtime.close().await;
    dispatcher.await.unwrap();
}

#[tokio::test]
async fn rescheduling_can_never_move_an_accepted_operations_bytes() {
    let harness = seeded(false).await;
    let (operation_id, _) = harness.accept_create().await;
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let mut tampered = snapshot.operations[0].clone();
    tampered.request.body.push(b' ');

    let error = harness
        .runtime
        .execute_plan(GuardedCommitPlan::new(
            harness.account_id.clone(),
            snapshot.incarnation.clone(),
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::RescheduleOperation(tampered)],
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        harness.operation().unwrap().request,
        snapshot.operations[0].request
    );

    let unknown = crate::test_fixtures::test_operation("operation-unknown", "item-unknown");
    let error = harness
        .runtime
        .execute_plan(GuardedCommitPlan::new(
            harness.account_id.clone(),
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![PlanMutation::RescheduleOperation(unknown)],
        ))
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert!(harness
        .operation()
        .is_some_and(|operation| operation.operation_id == operation_id));
}

/// A fresh browser source broker has no acceptance release from the previous Worker.
struct RestartImageSourcePort {
    end_calls: AtomicUsize,
}

#[async_trait]
impl crate::VaultImageSourcePort for RestartImageSourcePort {
    async fn claim(
        &self,
        _: &crate::VaultImageSourceGrant,
    ) -> Result<Box<dyn crate::VaultImageSource>, crate::VaultImageSourceError> {
        panic!("restored bytes must not require a new source grant")
    }
    async fn begin_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        panic!("accepted work must not be accepted again")
    }
    async fn end_acceptance(
        &self,
        _: &str,
        _: &AccountId,
        _: &str,
    ) -> Result<(), crate::VaultImageSourceError> {
        self.end_calls.fetch_add(1, Ordering::SeqCst);
        Err(crate::VaultImageSourceError::Source)
    }
    async fn retire_account(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_account_retirement(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn retire_vaults(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn complete_vault_retirement(
        &self,
        _: &str,
        _: &AccountId,
        _: &[String],
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn forget_account_vault_retirements(
        &self,
        _: &str,
        _: &AccountId,
    ) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
    async fn retire_runtime(&self, _: &str) -> Result<(), crate::VaultImageSourceError> {
        Ok(())
    }
}

struct CheckpointReplica {
    inner: Arc<PlainReplica>,
    checkpoints: Mutex<Vec<crate::replica::CreateVaultCheckpoint>>,
}
#[async_trait]
impl crate::replica::SerializedReplicaExecutor for CheckpointReplica {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        use crate::replica::persistence_contract::{
            PreparedReplicaWrite, ReplicaPersistenceRequest, ReplicaPersistenceResponse,
            ReplicaStore,
        };
        let command: ReplicaPersistenceRequest = serde_json::from_str(&request).unwrap();
        let checkpoints: Vec<_> = match &command {
            ReplicaPersistenceRequest::Commit { prepared } => prepared
                .writes
                .iter()
                .filter_map(|write| {
                    let PreparedReplicaWrite::Put { row } = write else {
                        return None;
                    };
                    if row.store != ReplicaStore::Operations {
                        return None;
                    }
                    let operation: crate::replica::OperationRecord =
                        serde_json::from_str(&row.payload_json).unwrap();
                    operation.create_vault.map(|intent| intent.checkpoint)
                })
                .collect(),
            _ => Vec::new(),
        };
        let response = self.inner.invoke(request).await?;
        if matches!(
            serde_json::from_str::<ReplicaPersistenceResponse>(&response).unwrap(),
            ReplicaPersistenceResponse::Committed {
                result: crate::replica::PlanResult::Applied { .. }
            }
        ) {
            self.checkpoints.lock().unwrap().extend(checkpoints);
        }
        Ok(response)
    }
}

#[tokio::test]
async fn repaired_artifact_ready_vault_reaches_frozen_exact_put_in_a_fresh_runtime() {
    use crate::replica::{
        persistence_contract::{
            ExpectedReplicaInstall, PreparedReplicaInstall, PreparedReplicaWrite,
            ReplicaInstallResult, ReplicaPersistenceRequest, ReplicaPersistenceResponse,
        },
        ReplicaPersistence,
    };
    let harness = seeded(false).await;
    harness
        .runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    harness.runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "before-repair",
            Arc::new(DispatchImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );
    let accepted = harness
        .runtime
        .request(
            RuntimeRequest::CreateVault {
                account_id: harness.account_id.clone(),
                name: "Repaired Image Vault".into(),
                vault_type: CreateVaultType::Personal,
                icon: "image".into(),
                image_source: Some(VaultImageSourceInput {
                    capability_id: "image-before-repair".into(),
                    byte_length: 11,
                    content_type: "image/png".into(),
                }),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultCreationAccepted {
        operation_id,
        vault_id,
        ..
    } = accepted
    else {
        panic!("expected accepted image Vault");
    };
    let image_scope =
        crate::VaultImageArtifactScope::new(harness.account_id.clone(), operation_id.clone())
            .unwrap();
    let image_metadata =
        crate::VaultImageArtifactPort::read_generation(artifacts.as_ref(), &image_scope, None)
            .await
            .unwrap()
            .unwrap()
            .metadata
            .unwrap();
    assert!(image_metadata.protection().is_some());
    let image_ciphertext =
        crate::VaultImageArtifactPort::read_chunk(artifacts.as_ref(), &image_metadata, 0)
            .await
            .unwrap()
            .unwrap();
    assert_ne!(image_ciphertext, b"image-bytes");
    harness.runtime.close().await;
    let ReplicaPersistenceResponse::Loaded {
        head: Some(head),
        rows,
    } = harness
        .replica
        .state
        .invoke(ReplicaPersistenceRequest::Load {
            account_id: harness.account_id.clone(),
        })
        .await
        .unwrap()
    else {
        panic!("expected retained Replica");
    };
    let original = rows
        .iter()
        .find(|row| row.key.record_id == operation_id)
        .unwrap()
        .payload_json
        .clone();
    let operation: crate::replica::OperationRecord = serde_json::from_str(&original).unwrap();
    assert_eq!(
        operation.create_vault.as_ref().unwrap().checkpoint,
        crate::replica::CreateVaultCheckpoint::ArtifactReady
    );

    // Reproduce repair's guarded publication result without replacing its separately tested archive
    // policy: exact rows/current incarnation retained, only the two current counters advance.
    let mut repaired_head = head.clone();
    repaired_head.replica_revision += 1;
    repaired_head.lock_epoch += 1;
    let response = harness
        .replica
        .state
        .invoke(ReplicaPersistenceRequest::Install {
            prepared: PreparedReplicaInstall {
                expected: ExpectedReplicaInstall::Present {
                    account_id: head.account_id,
                    user_id: head.user_id,
                    incarnation: head.incarnation,
                    replica_revision: head.replica_revision,
                    lock_epoch: head.lock_epoch,
                },
                next_head: repaired_head.clone(),
                writes: rows
                    .into_iter()
                    .map(|row| PreparedReplicaWrite::Put { row })
                    .collect(),
            },
        })
        .await
        .unwrap();
    assert!(matches!(
        response,
        ReplicaPersistenceResponse::Installed {
            result: ReplicaInstallResult::Applied
        }
    ));
    let ReplicaPersistenceResponse::Loaded {
        head: Some(after),
        rows,
    } = harness
        .replica
        .state
        .invoke(ReplicaPersistenceRequest::Load {
            account_id: harness.account_id.clone(),
        })
        .await
        .unwrap()
    else {
        panic!("expected repaired Replica");
    };
    assert_eq!(after, repaired_head);
    assert_eq!(
        rows.iter()
            .find(|row| row.key.record_id == operation_id)
            .unwrap()
            .payload_json,
        original
    );
    let recording = Arc::new(CheckpointReplica {
        inner: harness.replica.clone(),
        checkpoints: Mutex::new(Vec::new()),
    });
    let server = Arc::new(ProductionVaultImageHttp::default());
    let restarted = Runtime::with_test_dispatch_environment(
        recording.clone(),
        harness.platform.clone(),
        server.clone(),
        auth_config(),
        harness.clock.clone(),
        harness.timer.clone(),
    );
    let sources = Arc::new(RestartImageSourcePort {
        end_calls: AtomicUsize::new(0),
    });
    restarted.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new("after-repair", sources.clone(), artifacts.clone())
            .unwrap(),
    );
    restarted
        .platform_storage
        .store_device_catalog(
            &DeviceCatalogDocument::new(vec![DeviceCatalogAccount {
                account_id: harness.account_id.clone(),
                active_incarnation: Some(repaired_head.incarnation.clone()),
                pending_retirement: None,
                pending_install: None,
            }])
            .unwrap(),
        )
        .await
        .unwrap();
    // The deterministic dispatch constructor starts ready; exercise normal startup here.
    restarted.ready.store(false, Ordering::SeqCst);
    restarted.open().await.unwrap();
    store_session(&restarted, &harness.account_id, SECOND_TOKEN).await;
    restarted.unlock_account(&harness.account_id).await.unwrap();
    restarted
        .dispatch_once_ignoring_lease(&harness.account_id, &operation_id)
        .await;

    let checkpoints = recording.checkpoints.lock().unwrap().clone();
    assert_eq!(
        checkpoints.iter().take(2).copied().collect::<Vec<_>>(),
        vec![
            crate::replica::CreateVaultCheckpoint::RemoteUploadConfirmed,
            crate::replica::CreateVaultCheckpoint::FinalRequestFrozen
        ]
    );
    let final_snapshot = restarted.replica().snapshot(&harness.account_id).unwrap();
    assert!(final_snapshot.failure.is_none());
    let pending = final_snapshot
        .operations
        .iter()
        .find(|operation| operation.operation_id == operation_id)
        .unwrap();
    assert_eq!(
        pending.create_vault.as_ref().unwrap().checkpoint,
        crate::replica::CreateVaultCheckpoint::FinalRequestFrozen
    );
    assert_eq!(pending.request_fingerprint, operation.request_fingerprint);
    assert_eq!(
        pending.request.body,
        crate::replica::canonical_create_vault_request(
            &vault_id,
            operation.create_vault.as_ref().unwrap()
        )
        .unwrap()
        .body
    );
    let routes: Vec<_> = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|(method, url)| (method.clone(), url.rsplit('/').next().unwrap().to_owned()))
        .collect();
    assert_eq!(
        routes,
        vec![
            ("POST".into(), "status".into()),
            ("POST".into(), "grants".into()),
            ("PUT".into(), "staged-image".into()),
            ("POST".into(), "confirmations".into()),
            ("GET".into(), operation_id),
            ("PUT".into(), vault_id)
        ]
    );
    assert_eq!(sources.end_calls.load(Ordering::SeqCst), 0);
    restarted.close().await;
    assert_eq!(
        crate::VaultImageArtifactPort::read_chunk(artifacts.as_ref(), &image_metadata, 0)
            .await
            .unwrap()
            .unwrap(),
        image_ciphertext
    );
}

#[path = "dispatch_isolation_tests.rs"]
mod isolation;

#[tokio::test]
async fn legacy_retry_history_waits_for_its_deadline_then_replays_a_reminted_attempt_exactly() {
    use crate::replica::{
        item_operation_fingerprint, source_timestamp, ImmutableHttpRequest,
        LegacyOperationAdmission, LegacyOperationDisposition, OperationKind, OperationRecord,
        ReplicaItemRecord, ResourceRef, LEGACY_OPERATION_ADMISSION_VERSION,
    };
    let harness = seeded_with_existing_item(true, false).await;
    let snapshot = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    let base = snapshot.bootstrap.snapshot().visible_items[0].clone();
    let now = harness.clock.now();
    let deadline = now + 2_000;
    let operation_id = "reminted-attempt-never-sent";
    let overlay = ReplicaItemRecord {
        account_id: harness.account_id.clone(),
        item_id: base.id.clone(),
        vault_id: base.vault_id.clone(),
        operation_id: operation_id.into(),
        category: base.category.clone(),
        encrypted_data: base.encrypted_data,
        encryption_iv: base.encryption_iv,
        encryption_algorithm: base.encryption_algorithm,
        encryption_version: base.encryption_version,
        encrypted_by_user_id: base.encrypted_by_user_id,
        favorite: true,
        version: base.version,
        created_at: base.created_at,
        updated_at: source_timestamp(now).unwrap(),
        deleted_at: None,
        attachments: base.attachments,
        permanently_deleted: false,
    };
    let admission = LegacyOperationAdmission {
        version: LEGACY_OPERATION_ADMISSION_VERSION, admission_id: "profile-admission".into(), source_queue_index: 0,
        source_command: serde_json::from_value(json!({
            "accountId":harness.account_id, "id":"original-source-command", "operationId":"original-semantic-operation", "attemptId":operation_id,
            "type":"toggle_favorite", "entityId":base.id, "vaultId":base.vault_id, "favorite":true,
            "baseVersion":base.version, "timestamp":now.to_string(), "retryCount":"5", "status":"retrying", "nextAttemptAt":deadline.to_string(),
            "projectionClaimId":"departed-projector", "projectionClaimExpiresAt":(deadline+1_000_000).to_string()
        })).unwrap(),
        disposition: LegacyOperationDisposition::Normal,
        overlay_sha256: Some(LegacyOperationAdmission::overlay_fingerprint(&overlay).unwrap()),
        captured_failure_code: None,
    };
    let body = br#"{"favorite":true}"#.to_vec();
    let operation = OperationRecord {
        operation_id: operation_id.into(),
        kind: OperationKind::SetItemFavorite,
        target: ResourceRef::Item {
            item_id: base.id.clone(),
            vault_id: base.vault_id.clone(),
        },
        request_fingerprint: item_operation_fingerprint(
            OperationKind::SetItemFavorite,
            "PATCH /api/v1/items/{itemId}/favorite",
            &base.id,
            &body,
            base.version,
        ),
        request: ImmutableHttpRequest {
            method: HttpMethod::Patch,
            path: format!("/api/v1/items/{}/favorite", base.id),
            headers: vec![
                HttpHeader {
                    name: "Content-Type".into(),
                    value: "application/merge-patch+json".into(),
                },
                HttpHeader {
                    name: "If-Match".into(),
                    value: format!("\"{}\"", base.version),
                },
            ],
            body,
        },
        accepted_item_category: Some(base.category),
        attachment_move_recovery: None,
        create_vault: None,
        update_vault: None,
        scheduling: admission.initial_scheduling(),
        legacy_admission: Some(Box::new(admission)),
    };
    harness
        .runtime
        .replica()
        .execute(GuardedCommitPlan::new(
            snapshot.account_id,
            snapshot.incarnation,
            snapshot.revision,
            snapshot.lock_epoch,
            vec![
                PlanMutation::AcceptOperation(operation.clone()),
                PlanMutation::PutOptimisticItem(overlay),
            ],
        ))
        .await
        .unwrap();
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::WaitFor {
            milliseconds: 2_000
        }
    ));
    harness.clock.advance(1_999);
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::WaitFor { milliseconds: 1 }
    ));
    assert_eq!(harness.server.outcome_lookups(), 0);
    assert!(harness.server.existing_item_mutation_requests().is_empty());
    harness.server.script([Fault::Status(503)]);
    harness.clock.advance(1);
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Progressed
    ));
    assert_eq!(harness.server.outcome_lookups(), 1);
    let requests = harness.server.existing_item_mutation_requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].body, operation.request.body);
    assert_eq!(
        requests[0].url,
        format!("{SERVER_URL}{}", operation.request.path)
    );
    assert!(requests[0]
        .headers
        .iter()
        .any(|(name, value)| name == "Idempotency-Key" && value == operation_id));
    let retried = harness.operation().unwrap();
    assert_eq!(retried.scheduling.attempt_count, 6);
    assert_eq!(retried.legacy_admission, operation.legacy_admission);
    assert_eq!(retried.request, operation.request);
    harness
        .clock
        .advance(retried.scheduling.not_before_ms - harness.clock.now());
    assert!(matches!(
        harness.runtime.dispatch_eligible_operations().await,
        dispatch::DispatchPass::Progressed
    ));
    let completed = harness
        .runtime
        .replica()
        .snapshot(&harness.account_id)
        .unwrap();
    assert!(completed.operations.is_empty());
    assert!(completed.items.is_empty());
    let receipt = completed
        .receipts
        .iter()
        .find(|receipt| receipt.operation_id == operation_id)
        .unwrap();
    assert_eq!(
        receipt.legacy_lineage.as_ref().unwrap().source_status,
        Some(crate::replica::LegacyItemCommandStatus::Retrying)
    );
    assert_eq!(
        receipt
            .legacy_lineage
            .as_ref()
            .unwrap()
            .source_operation_id
            .as_deref(),
        Some("original-semantic-operation")
    );
}
