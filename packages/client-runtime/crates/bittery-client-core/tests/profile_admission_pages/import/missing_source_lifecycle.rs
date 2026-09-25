//! Account lifecycle preserves the parked owner until its source Account is removed.
use super::*;
use bittery_client_core::{
    RuntimeResponse, TeardownHostCleanup, TeardownHostCleanupRequest, TeardownHostCleanupResponse,
    TeardownStatus,
};

struct LifecyclePlatform(Arc<RetainingPlatform>);
#[async_trait]
impl SerializedPlatformStorageExecutor for LifecyclePlatform {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let decoded: PlatformStorageRequest = serde_json::from_str(&request).unwrap();
        match &decoded {
            PlatformStorageRequest::Delete { area, key } => {
                self.0
                    .values
                    .lock()
                    .unwrap()
                    .remove(&(area_name(*area), key.clone()));
            }
            PlatformStorageRequest::DeletePrefix {
                area,
                prefix,
                preserve_key,
            } => {
                assert!(!prefix.is_empty());
                self.0
                    .values
                    .lock()
                    .unwrap()
                    .retain(|(stored_area, key), _| {
                        *stored_area != area_name(*area)
                            || !key.starts_with(prefix)
                            || preserve_key
                                .as_ref()
                                .is_some_and(|preserve| preserve == key)
                    });
            }
            _ => return self.0.invoke(request).await,
        }
        Ok(Zeroizing::new(
            serde_json::to_string(&PlatformStorageResponse::Done).unwrap(),
        ))
    }
}

#[derive(Default)]
struct AccountCleanup(Mutex<Vec<AccountId>>);
#[async_trait]
impl TeardownHostCleanup for AccountCleanup {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        let TeardownHostCleanupRequest::DeleteAccount { account_id } = request else {
            panic!("Account cleanup only")
        };
        self.0.lock().unwrap().push(account_id);
        Ok(TeardownHostCleanupResponse::AccountDeleted)
    }
}

// Same current Server Vault/key facts as the genuine login response. This models a new empty
// destination bootstrap after RemoveAccount; it does not alter the frozen producer artifact.
struct ReaddNetwork(Arc<AccountNetworks>);
#[async_trait]
impl SerializedHttpExecutor for ReaddNetwork {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        let url = url::Url::parse(value["url"].as_str().unwrap()).unwrap();
        if url.path() == "/api/v1/sync/bootstrap" {
            assert_eq!(url.origin().ascii_serialization(), TARGET_SERVER);
            self.0.target.calls.fetch_add(1, Ordering::SeqCst);
            let phase = url
                .query_pairs()
                .find(|(key, _)| key == "phase")
                .unwrap()
                .1
                .into_owned();
            let peer = &self.0.target;
            let body = match phase.as_str() {
                "vaults" => json!({"phase":"vaults","hasMore":false,"nextCursor":null,
                    "syncCursor":{"id":"target-readded-bootstrap"},"vaults":[{
                    "id":peer.vault_id,"name":peer.vault_name,"vaultType":"personal","role":peer.vault_role,
                    "icon":null,"imageUrl":null,"encryptedVaultKey":peer.wrapped_vault_key}]}),
                "items" => json!({"phase":"items","hasMore":false,"nextCursor":null,
                    "syncCursor":{"id":"target-readded-bootstrap"},"items":[]}),
                _ => panic!("unexpected bootstrap phase"),
            };
            return Ok(admission_http_completed(200, body));
        }
        self.0.invoke(request).await
    }
    fn cancel(&self, _: &str) {}
}

async fn remove(runtime: &Arc<Runtime>, account: &str) {
    assert!(matches!(
        runtime
            .request(
                RuntimeRequest::RemoveAccount {
                    account_id: account.into()
                },
                RequestCancellation::new()
            )
            .await
            .unwrap(),
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
}

fn assert_retired_projection(runtime: &Arc<Runtime>, operation: &str) {
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::Operations {
                account_id: desktop::ACCOUNT.into(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Operations(projection) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("operations")
    };
    let value = serde_json::to_value(projection).unwrap();
    let operation = value["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["operationId"] == operation)
        .unwrap();
    assert_eq!(operation["resolution"], "pending");
    assert_eq!(operation["crossAccountMove"]["sourceVisible"], false);
    assert_eq!(
        operation["crossAccountMove"]["disposition"],
        json!({"type":"blocked","reason":"destinationRetired"})
    );
    observation.close();
}

#[tokio::test]
async fn destination_remove_readd_retains_parked_owner_until_actual_source_account_removal() {
    let (source, command, network) = protected_crash_source();
    account_lifecycle_case(source, command, network, assert_retired_projection).await;
}

pub(super) async fn account_lifecycle_case(
    source: Arc<Source>,
    command: Value,
    network: Arc<AccountNetworks>,
    assert_disposition: fn(&Arc<Runtime>, &str),
) {
    let secret = source.second_credentials.as_ref().unwrap()[0]
        .clone()
        .unwrap();
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let lifecycle_platform = Arc::new(LifecyclePlatform(platform.clone()));
    let http = Arc::new(ReaddNetwork(network.clone()));
    let runtime = authenticated_runtime(&directory, lifecycle_platform.clone(), http.clone()).await;
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: source.clone(),
        })
        .await
        .unwrap();
    let cleanup = Arc::new(AccountCleanup::default());
    runtime.install_teardown_host_cleanup(cleanup.clone());
    runtime.open().await.unwrap();
    for (account, role) in [
        (desktop::ACCOUNT, network.source.vault_role),
        (SECOND_ACCOUNT, network.target.vault_role),
    ] {
        let expected_role = if role == "read-only" {
            "readOnly"
        } else {
            "owner"
        };
        assert_eq!(
            row(&snapshot(&directory, account).await, "authorityVaults")["role"],
            expected_role
        );
    }
    for account in [desktop::ACCOUNT, SECOND_ACCOUNT] {
        runtime
            .request(
                RuntimeRequest::QuickUnlock {
                    account_id: account.into(),
                    master_password: PASSWORD.into(),
                },
                RequestCancellation::new(),
            )
            .await
            .unwrap();
    }
    for (account, role) in [
        (desktop::ACCOUNT, network.source.vault_role),
        (SECOND_ACCOUNT, network.target.vault_role),
    ] {
        let expected_role = if role == "read-only" {
            "readOnly"
        } else {
            "owner"
        };
        assert_eq!(
            row(&snapshot(&directory, account).await, "authorityVaults")["role"],
            expected_role
        );
    }
    let original = row(
        &snapshot(&directory, desktop::ACCOUNT).await,
        "crossAccountMoves",
    );
    let before_remove = network.call_count();
    remove(&runtime, SECOND_ACCOUNT).await;
    assert_eq!(network.call_count(), before_remove);
    let retired = row(
        &snapshot(&directory, desktop::ACCOUNT).await,
        "crossAccountMoves",
    );
    let mut expected = original.clone();
    expected["destinationBinding"]["status"] = json!("retired");
    expected["destinationBinding"]["bindingRevision"] = json!("1");
    assert_eq!(
        retired, expected,
        "only the original binding retires; lineage, request and schedule remain exact"
    );
    assert_disposition(&runtime, command["operationId"].as_str().unwrap());
    let RuntimeResponse::SignedIn {
        account_id: replacement,
        ..
    } = runtime
        .request(
            RuntimeRequest::SignIn {
                server_url: TARGET_SERVER.into(),
                email: "target@legacy.invalid".into(),
                master_password: PASSWORD.into(),
                secret_key: secret,
                insecure_transport_confirmed: false,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("same-identity re-add")
    };
    assert_ne!(replacement.as_str(), SECOND_ACCOUNT);
    let source_after = snapshot(&directory, desktop::ACCOUNT).await;
    let target_after = snapshot(&directory, replacement.as_str()).await;
    assert_eq!(row(&source_after, "crossAccountMoves"), retired);
    let http_after = network.call_count();
    let operation_id = command["operationId"].as_str().unwrap();
    let result = runtime
        .request(
            RuntimeRequest::PrepareCrossAccountMoveResume {
                account_id: desktop::ACCOUNT.into(),
                operation_id: operation_id.into(),
                target_account_id: replacement.clone(),
                expected_binding_revision: 1,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(result.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(result.message, "The source Move is unavailable");
    let authority = runtime
        .native_authority()
        .attach_source(
            "parked-lifecycle".into(),
            "parked-lifecycle-transport".into(),
        )
        .unwrap();
    let guard:CrossAccountMoveResumeGuard=serde_json::from_value(json!({
        "accountId":desktop::ACCOUNT,"sourceIncarnation":source_after["head"]["incarnation"],"sourceLockEpoch":source_after["head"]["lockEpoch"],
        "targetAccountId":replacement,"targetIncarnation":target_after["head"]["incarnation"],"targetLockEpoch":target_after["head"]["lockEpoch"],
        "operationId":operation_id,"bindingRevision":"1","sourceReplicaRevision":source_after["head"]["replicaRevision"],"ownerIncarnation":authority.owner_id
    })).unwrap();
    let result = runtime
        .request(
            RuntimeRequest::ResumeCrossAccountMove { guard },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(result.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(result.message, "The source Move is unavailable");
    assert_eq!(network.call_count(), http_after);
    assert_parked_dispatch_scan(&runtime, &network).await;
    let http_after = network.call_count();
    assert_eq!(snapshot(&directory, desktop::ACCOUNT).await, source_after);
    assert_eq!(
        snapshot(&directory, replacement.as_str()).await,
        target_after
    );
    runtime.close().await;
    let calls = source.calls.lock().unwrap().len();
    let reopened = authenticated_runtime(&directory, lifecycle_platform, http).await;
    reopened.install_teardown_host_cleanup(cleanup.clone());
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    assert_eq!(
        row(
            &snapshot(&directory, desktop::ACCOUNT).await,
            "crossAccountMoves"
        ),
        retired
    );
    assert_disposition(&reopened, operation_id);
    assert_eq!(source.calls.lock().unwrap().len(), calls);
    assert_eq!(network.call_count(), http_after);
    let target_before_cleanup = snapshot(&directory, replacement.as_str()).await;
    remove(&reopened, desktop::ACCOUNT).await;
    let removed = snapshot(&directory, desktop::ACCOUNT).await;
    assert!(removed["head"].is_null());
    assert!(removed["rows"].as_array().unwrap().is_empty());
    assert_eq!(
        snapshot(&directory, replacement.as_str()).await,
        target_before_cleanup
    );
    assert_eq!(network.call_count(), http_after);
    assert_eq!(
        *cleanup.0.lock().unwrap(),
        vec![
            AccountId::from(SECOND_ACCOUNT),
            AccountId::from(desktop::ACCOUNT)
        ]
    );
    assert!(!platform.catalog()["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|account| account["accountId"] == desktop::ACCOUNT));
    reopened.close().await;
}
