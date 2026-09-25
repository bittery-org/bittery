use super::{operation_fixtures::*, *};
use crate::{VaultIconPatch, VaultImageChange};
use async_trait::async_trait;

fn vaults(runtime: &Runtime, account_id: &AccountId) -> Vec<crate::VaultProjection> {
    let projection = runtime
        .projection(&ObservationRequest::Items {
            account_id: account_id.clone(),
        })
        .unwrap()
        .projection;
    let RuntimeProjection::Items(items) = projection else {
        panic!("expected Items projection");
    };
    items.vaults
}

struct VaultMutationHttp {
    server: Arc<FakeServer>,
    reject: bool,
}
#[async_trait]
impl SerializedHttpExecutor for VaultMutationHttp {
    async fn invoke(&self, request: zeroize::Zeroizing<String>) -> Result<String, RuntimeError> {
        let value: serde_json::Value = serde_json::from_str(&request).unwrap();
        let mutation_kind = value["url"].as_str().and_then(|url| {
            if url.ends_with("/metadata-updates") {
                Some("update_vault")
            } else if url.ends_with("/deletions") {
                Some("delete_vault")
            } else {
                None
            }
        });
        if let Some(kind) = mutation_kind {
            let operation_id = value["headers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|header| header["name"] == "Idempotency-Key")
                .unwrap()["value"]
                .as_str()
                .unwrap();
            let result = if self.reject {
                serde_json::json!({"status":"rejected","code":"vault_access_denied"})
            } else {
                serde_json::json!({"status":"applied","vaultId":crate::test_fixtures::TEST_VAULT_ID})
            };
            let body = serde_json::json!({"operationId":operation_id,"kind":kind,"result":result});
            return Ok(
                serde_json::json!({"type":"completed","status":200,"headers":[],
                "body":serde_json::to_vec(&body).unwrap()})
                .to_string(),
            );
        }
        self.server.invoke(request).await
    }
    fn cancel(&self, dispatch_id: &str) {
        self.server.cancel(dispatch_id);
    }
}

async fn mutation_harness() -> Harness {
    mutation_harness_with_rejection(false).await
}

async fn mutation_harness_with_rejection(reject: bool) -> Harness {
    let mut h = seeded(true).await;
    h.runtime.close().await;
    h.runtime = Runtime::with_test_dispatch_environment(
        h.replica.clone(),
        h.platform.clone(),
        Arc::new(VaultMutationHttp {
            server: h.server.clone(),
            reject,
        }),
        auth_config(),
        h.clock.clone(),
        h.timer.clone(),
    );
    h.runtime.replica.load(&h.account_id).await.unwrap();
    h.runtime.unlock_account(&h.account_id).await.unwrap();
    h
}

#[tokio::test]
async fn rename_outcome_completes_once_and_requests_current_authority_without_optimistic_metadata()
{
    let h = mutation_harness().await;
    let original_vaults = vaults(&h.runtime, &h.account_id);
    let response = h
        .runtime
        .request(
            RuntimeRequest::UpdateVault {
                account_id: h.account_id.clone(),
                vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
                name: Some("Renamed Vault".into()),
                icon: VaultIconPatch::Unchanged,
                image: VaultImageChange::Unchanged,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultUpdateAccepted { operation_id, .. } = response else {
        panic!("expected update acceptance");
    };
    h.runtime
        .dispatch_once_ignoring_lease(&h.account_id, &operation_id)
        .await;
    let projection = h
        .runtime
        .projection(&ObservationRequest::Operations {
            account_id: h.account_id.clone(),
        })
        .unwrap()
        .projection;
    let RuntimeProjection::Operations(operations) = projection else {
        panic!("expected Operations");
    };
    assert_eq!(operations.operations.len(), 1);
    assert_eq!(operations.operations[0].operation_id, operation_id);
    assert_eq!(
        operations.operations[0].resolution,
        crate::OperationResolution::Applied
    );
    let snapshot = h.runtime.replica.snapshot(&h.account_id).unwrap();
    assert_eq!(
        snapshot.bootstrap.state,
        crate::replica::ReplicaState::RefreshRequired
    );
    assert_eq!(
        snapshot.bootstrap.snapshot().visible_vaults.len(),
        original_vaults.len()
    );
    assert_ne!(
        snapshot.bootstrap.snapshot().visible_vaults[0].name,
        "Renamed Vault"
    );
    h.runtime.close().await;
}

#[tokio::test]
async fn rename_is_durably_accepted_without_publishing_unconfirmed_vault_authority() {
    let h = seeded(true).await;
    let before = vaults(&h.runtime, &h.account_id);
    let response = h
        .runtime
        .request(
            RuntimeRequest::UpdateVault {
                account_id: h.account_id.clone(),
                vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
                name: Some("  Renamed Vault  ".into()),
                icon: VaultIconPatch::Unchanged,
                image: VaultImageChange::Unchanged,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultUpdateAccepted {
        operation_id,
        vault_id,
        ..
    } = response
    else {
        panic!("expected durable Vault update acceptance");
    };
    assert_eq!(vault_id, crate::test_fixtures::TEST_VAULT_ID);
    let after = vaults(&h.runtime, &h.account_id);
    assert_eq!(before, after, "accepted intent is not confirmed metadata");
    let operation = h.operation().expect("durable accepted operation");
    assert_eq!(operation.operation_id, operation_id);
    assert_eq!(operation.request.body, br#"{"name":"Renamed Vault"}"#);
    assert_eq!(
        operation.request.path,
        format!("/api/v1/vaults/{vault_id}/metadata-updates")
    );
    assert!(
        h.server.requests.lock().unwrap().is_empty(),
        "acceptance needs no online Server"
    );
    h.runtime.close().await;
}

#[tokio::test]
async fn invalid_metadata_is_rejected_before_durable_acceptance() {
    let h = seeded(true).await;
    for (name, icon) in [
        (Some(" x ".into()), VaultIconPatch::Unchanged),
        (Some("x".repeat(201)), VaultIconPatch::Unchanged),
        (
            None,
            VaultIconPatch::Set {
                value: "i".repeat(129),
            },
        ),
    ] {
        let error = h
            .runtime
            .request(
                RuntimeRequest::UpdateVault {
                    account_id: h.account_id.clone(),
                    vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
                    name,
                    icon,
                    image: VaultImageChange::Unchanged,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        assert!(h.operation().is_none());
    }
    assert!(h.server.requests.lock().unwrap().is_empty());
    h.runtime.close().await;
}

#[tokio::test]
async fn icon_and_image_removal_keep_exact_three_state_patch_bytes() {
    for (icon, image, expected) in [
        (VaultIconPatch::Unchanged, VaultImageChange::Unchanged, "{}"),
        (
            VaultIconPatch::Clear,
            VaultImageChange::Unchanged,
            r#"{"icon":null}"#,
        ),
        (
            VaultIconPatch::Set {
                value: "star".into(),
            },
            VaultImageChange::Unchanged,
            r#"{"icon":"star"}"#,
        ),
        (
            VaultIconPatch::Unchanged,
            VaultImageChange::Remove,
            r#"{"imageKey":null}"#,
        ),
    ] {
        let h = seeded(true).await;
        let before = vaults(&h.runtime, &h.account_id);
        h.runtime
            .request(
                RuntimeRequest::UpdateVault {
                    account_id: h.account_id.clone(),
                    vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
                    name: None,
                    icon,
                    image,
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        assert_eq!(h.operation().unwrap().request.body, expected.as_bytes());
        assert_eq!(vaults(&h.runtime, &h.account_id), before);
        h.runtime.close().await;
    }
}

#[tokio::test]
async fn replacement_image_is_durable_before_acceptance_without_persisting_source_authority() {
    let h = mutation_harness().await;
    // This narrow harness loads/unlocks a seeded Replica without production open/install.
    // Supply the existing Device key required for accepted protected image publication.
    h.runtime
        .platform_storage
        .store_device_key(&DeviceKeyDocument::new([7; 32]))
        .await
        .unwrap();
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    h.runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "runtime-vault-update",
            super::create_vault_tests::fail_end_once_source(),
            artifacts.clone(),
        )
        .unwrap(),
    );
    let before = vaults(&h.runtime, &h.account_id);
    h.runtime
        .request(
            RuntimeRequest::UpdateVault {
                account_id: h.account_id.clone(),
                vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
                name: Some("New image".into()),
                icon: VaultIconPatch::Unchanged,
                image: VaultImageChange::Source {
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
    let operation = h.operation().unwrap();
    assert!(
        operation.request.body.is_empty(),
        "unconfirmed upload cannot dispatch a final request"
    );
    assert!(!serde_json::to_string(&operation)
        .unwrap()
        .contains("opaque-image-source"));
    assert_eq!(vaults(&h.runtime, &h.account_id), before);
    assert!(h.server.requests.lock().unwrap().is_empty());
    let image = operation.vault_image().unwrap().clone();
    assert_eq!(image.byte_length, 11);
    let witness = image
        .protected_witness
        .as_ref()
        .expect("acceptance requires a durable protected publication");
    assert!(!image.raw_cleanup_pending);
    let family =
        crate::VaultImageArtifactScope::new(h.account_id.clone(), &operation.operation_id).unwrap();
    use crate::VaultImageArtifactPort;
    let publication = artifacts
        .read_generation(&family, None)
        .await
        .unwrap()
        .unwrap()
        .metadata
        .unwrap();
    assert_eq!(publication.protection().unwrap().witness, *witness);
    assert_eq!(publication.vault_id(), operation.vault_id());
    assert_eq!(publication.byte_length(), image.byte_length);
    assert_eq!(publication.sha256(), image.sha256);
    let ciphertext = artifacts.read_all(&publication).await.unwrap();
    assert_ne!(ciphertext, b"image-bytes");
    assert!(!ciphertext.windows(11).any(|bytes| bytes == b"image-bytes"));
    let durable = h
        .runtime
        .replica
        .load_uncached(&h.account_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        durable
            .operations
            .iter()
            .find(|accepted| accepted.operation_id == operation.operation_id),
        Some(&operation),
        "accepted evidence survives a durable reread"
    );
    let staging = super::create_vault_tests::FailingThenExactStaging {
        failures_left: std::sync::atomic::AtomicUsize::new(1),
        calls: Mutex::new(Vec::new()),
    };
    use super::create_vault_staging::CreateVaultStagingPass;
    for expected in [
        CreateVaultStagingPass::RetryScheduled,
        CreateVaultStagingPass::Progressed,
        CreateVaultStagingPass::DispatchReady,
    ] {
        assert_eq!(
            h.runtime
                .drive_create_vault_staging_cycle(&h.account_id, &operation.operation_id, &staging)
                .await
                .unwrap(),
            expected
        );
    }
    let frozen = h.operation().unwrap();
    assert_eq!(frozen.request_fingerprint, operation.request_fingerprint);
    let body: serde_json::Value = serde_json::from_slice(&frozen.request.body).unwrap();
    assert_eq!(body["imageKey"], image.object_key);
    h.clock.advance(1_000);
    h.runtime
        .dispatch_once_ignoring_lease(&h.account_id, &operation.operation_id)
        .await;
    assert!(
        h.runtime
            .pending_vault_image_acceptance_cleanup
            .lock()
            .unwrap()
            .is_empty(),
        "final image dispatch must drain the same acceptance release as creation"
    );
    let completed = h.runtime.replica.snapshot(&h.account_id).unwrap();
    assert!(completed.operations.is_empty());
    let receipt = completed
        .receipts
        .iter()
        .find(|receipt| receipt.operation_id == operation.operation_id)
        .unwrap();
    let cleanup = receipt.create_vault_cleanup.as_ref().unwrap();
    assert!(cleanup.local_artifact_pending);
    assert!(!cleanup.remote_staging_pending);
    h.runtime.close().await;
}

#[tokio::test]
async fn deletion_is_durable_offline_and_does_not_publish_unconfirmed_absence() {
    let h = seeded(true).await;
    let before = vaults(&h.runtime, &h.account_id);
    let response = h
        .runtime
        .request(
            RuntimeRequest::DeleteVault {
                account_id: h.account_id.clone(),
                vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::VaultDeletionAccepted { operation_id, .. } = response else {
        panic!("expected durable deletion");
    };
    let operation = h.operation().unwrap();
    assert_eq!(operation.operation_id, operation_id);
    assert_eq!(operation.request.body, b"{}");
    assert_eq!(
        operation.request.path,
        format!(
            "/api/v1/vaults/{}/deletions",
            crate::test_fixtures::TEST_VAULT_ID
        )
    );
    assert_eq!(vaults(&h.runtime, &h.account_id), before);
    assert!(h.server.requests.lock().unwrap().is_empty());
    h.runtime.close().await;
}

#[tokio::test]
async fn pending_deletion_refuses_new_item_import_and_metadata_work_but_keeps_reads() {
    let h = seeded(true).await;
    let before = vaults(&h.runtime, &h.account_id);
    h.runtime
        .request(
            RuntimeRequest::DeleteVault {
                account_id: h.account_id.clone(),
                vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    for request in [
        RuntimeRequest::CreateItem {
            account_id: h.account_id.clone(),
            vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
            draft: draft(),
        },
        RuntimeRequest::ImportItems {
            account_id: h.account_id.clone(),
            vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
            items: vec![],
        },
        RuntimeRequest::UpdateVault {
            account_id: h.account_id.clone(),
            vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
            name: Some("Later rename".into()),
            icon: VaultIconPatch::Unchanged,
            image: VaultImageChange::Unchanged,
        },
        RuntimeRequest::DeleteVault {
            account_id: h.account_id.clone(),
            vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
        },
    ] {
        let error = h
            .runtime
            .request(request, RequestCancellation::new())
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    }
    assert_eq!(
        h.runtime
            .replica
            .snapshot(&h.account_id)
            .unwrap()
            .operations
            .len(),
        1
    );
    assert_eq!(vaults(&h.runtime, &h.account_id), before);
    h.runtime.close().await;
}

#[tokio::test]
async fn pending_deletion_refuses_existing_item_and_share_work_only_in_its_vault() {
    let h = seeded_with_existing_item(true, false).await;
    let account_id = h.account_id.clone();
    let item_id = "item-existing".to_owned();
    h.runtime
        .request(
            RuntimeRequest::DeleteVault {
                account_id: account_id.clone(),
                vault_id: crate::test_fixtures::TEST_VAULT_ID.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    for request in [
        RuntimeRequest::UpdateItem {
            guard: crate::ItemEditGuard::test_fixture(account_id.clone(), &item_id),
            account_id: account_id.clone(),
            item_id: item_id.clone(),
            draft: draft(),
        },
        RuntimeRequest::SetItemFavorite {
            account_id: account_id.clone(),
            item_id: item_id.clone(),
            favorite: true,
        },
        RuntimeRequest::TrashItem {
            account_id: account_id.clone(),
            item_id: item_id.clone(),
        },
        RuntimeRequest::RestoreItem {
            account_id: account_id.clone(),
            item_id: item_id.clone(),
        },
        RuntimeRequest::PermanentlyDeleteItem {
            account_id: account_id.clone(),
            item_id: item_id.clone(),
        },
        RuntimeRequest::MoveItem {
            account_id: account_id.clone(),
            item_id: item_id.clone(),
            target_vault_id: "vault-2".into(),
            target_account_id: None,
        },
        RuntimeRequest::CreateShare {
            account_id: account_id.clone(),
            item_id,
            draft: crate::CreateShareDraft {
                access_mode: crate::ShareAccessMode::Anyone,
                expires_in: crate::ShareExpiration::SevenDays,
                is_one_time_use: false,
                allowed_emails: vec![],
            },
        },
    ] {
        let error = h
            .runtime
            .request(request, RequestCancellation::new())
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    }
    assert_eq!(
        h.runtime
            .replica
            .snapshot(&account_id)
            .unwrap()
            .operations
            .len(),
        1
    );
    assert!(h.server.requests.lock().unwrap().is_empty());
    assert!(matches!(
        h.runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id,
                    vault_id: "vault-2".into(),
                    draft: draft(),
                },
                RequestCancellation::new()
            )
            .await
            .unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    h.runtime.close().await;
}

#[tokio::test]
async fn pending_destination_deletion_refuses_move_and_preserves_source_writes() {
    let h = seeded_with_existing_item(true, false).await;
    h.runtime
        .request(
            RuntimeRequest::DeleteVault {
                account_id: h.account_id.clone(),
                vault_id: "vault-2".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let error = h
        .runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: h.account_id.clone(),
                item_id: "item-existing".into(),
                target_vault_id: "vault-2".into(),
                target_account_id: None,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(
        h.runtime
            .replica
            .snapshot(&h.account_id)
            .unwrap()
            .operations
            .len(),
        1
    );
    assert!(matches!(
        h.runtime
            .request(
                RuntimeRequest::SetItemFavorite {
                    account_id: h.account_id.clone(),
                    item_id: "item-existing".into(),
                    favorite: true,
                },
                RequestCancellation::new()
            )
            .await
            .unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    h.runtime.close().await;
}

#[tokio::test]
async fn accepted_vault_update_and_delete_are_recoverable_without_weakening_exact_requests() {
    use crate::replica::{
        persistence_contract::{ReplicaHead, ReplicaStore},
        recovery::RecoveryCoverage,
    };
    for delete in [false, true] {
        let h = seeded(true).await;
        let vault_id = crate::test_fixtures::TEST_VAULT_ID.to_owned();
        let request = if delete {
            RuntimeRequest::DeleteVault {
                account_id: h.account_id.clone(),
                vault_id,
            }
        } else {
            RuntimeRequest::UpdateVault {
                account_id: h.account_id.clone(),
                vault_id,
                name: Some("Recovery accepted rename".into()),
                icon: VaultIconPatch::Clear,
                image: VaultImageChange::Unchanged,
            }
        };
        h.runtime
            .request(request, RequestCancellation::new())
            .await
            .unwrap();
        let snapshot = h.runtime.replica.snapshot(&h.account_id).unwrap();
        assert_eq!(snapshot.operations.len(), 1);
        let operation = &snapshot.operations[0];
        let head = ReplicaHead {
            account_id: snapshot.account_id.clone(),
            user_id: snapshot.user_id.clone(),
            incarnation: snapshot.incarnation.clone(),
            replica_revision: snapshot.revision,
            lock_epoch: snapshot.lock_epoch,
            failure: snapshot.failure,
        };
        let mut coverage = RecoveryCoverage::new(head.clone()).unwrap();
        coverage
            .push_row(
                ReplicaStore::Operations,
                &operation.operation_id,
                &serde_json::to_string(operation).unwrap(),
            )
            .expect("actual accepted Vault intent must remain recoverable");
        let proof = coverage.finish().unwrap();
        assert_eq!(proof.operation_count, 1);
        assert_eq!(proof.accepted_rows().count(), 1);
        // Recovery still delegates to the same exact immutable-request validator as admission.
        for field in ["body", "path", "method", "headers", "fingerprint", "target"] {
            let mut changed = operation.clone();
            match field {
                "body" => changed.request.body.push(b' '),
                "path" => changed.request.path.push('/'),
                "method" => changed.request.method = crate::http_transport::HttpMethod::Get,
                "headers" => changed.request.headers.clear(),
                "fingerprint" => changed.request_fingerprint.0[0] ^= 1,
                "target" => {
                    changed.target = crate::replica::ResourceRef::Vault {
                        vault_id: "different-vault".into(),
                    }
                }
                _ => unreachable!(),
            }
            let mut coverage = RecoveryCoverage::new(head.clone()).unwrap();
            assert!(
                coverage
                    .push_row(
                        ReplicaStore::Operations,
                        &changed.operation_id,
                        &serde_json::to_string(&changed).unwrap()
                    )
                    .is_err(),
                "changed {field} must fail closed"
            );
            assert!(coverage.finish().is_err());
        }
        h.runtime.close().await;
    }
}

#[tokio::test]
async fn retained_delete_completes_exact_identity_and_refreshes_without_erasing_other_work() {
    for reject in [false, true] {
        let h = mutation_harness_with_rejection(reject).await;
        let vault_id = crate::test_fixtures::TEST_VAULT_ID.to_owned();
        h.runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: h.account_id.clone(),
                    vault_id: vault_id.clone(),
                    draft: draft(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let response = h
            .runtime
            .request(
                RuntimeRequest::DeleteVault {
                    account_id: h.account_id.clone(),
                    vault_id: vault_id.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
        let RuntimeResponse::VaultDeletionAccepted { operation_id, .. } = response else {
            panic!("expected actual public DeleteVault acceptance");
        };
        let before = h.runtime.replica.snapshot(&h.account_id).unwrap();
        let original = before
            .operations
            .iter()
            .find(|operation| operation.operation_id == operation_id)
            .unwrap();
        h.runtime
            .dispatch_once_ignoring_lease(&h.account_id, &operation_id)
            .await;
        let after = h.runtime.replica.snapshot(&h.account_id).unwrap();
        let receipt = after
            .receipts
            .iter()
            .find(|receipt| receipt.operation_id == operation_id)
            .expect("exact DeleteVault result must complete rather than retry forever");
        assert!(
            receipt.create_vault_cleanup.is_none(),
            "Delete has no image artifact duty"
        );
        assert_eq!(receipt.kind, crate::replica::OperationKind::DeleteVault);
        assert_eq!(receipt.request_fingerprint, original.request_fingerprint);
        assert_eq!(receipt.target, original.target);
        assert_eq!(
            serde_json::to_value(&receipt.result).unwrap(),
            if reject {
                serde_json::json!({"type":"vaultMutationRejected","code":"vault_access_denied"})
            } else {
                serde_json::json!({"type":"vaultApplied","vaultId":vault_id})
            }
        );
        assert!(!after
            .operations
            .iter()
            .any(|operation| operation.operation_id == operation_id));
        assert_eq!(
            after.operations,
            before
                .operations
                .into_iter()
                .filter(|operation| operation.operation_id != operation_id)
                .collect::<Vec<_>>()
        );
        assert_eq!(after.items, before.items);
        assert_eq!(after.bootstrap.vaults, before.bootstrap.vaults);
        assert_eq!(after.bootstrap.items, before.bootstrap.items);
        assert_eq!(
            after.bootstrap.active_generation,
            before.bootstrap.active_generation
        );
        assert!(
            after.bootstrap.pending_vault_retirements.is_empty(),
            "an old retained delete is not current authority or permission to purge"
        );
        assert_eq!(
            after.bootstrap.state,
            crate::replica::ReplicaState::RefreshRequired
        );
        h.runtime.close().await;
    }
}
