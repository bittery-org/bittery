//! A newly observed current Item is readable, but cannot become missing original Move evidence.
use super::*;
const CURRENT_CURSOR: &str = "parked-current-source-sync";
const CURRENT_AUTHORITY_PATH: &str = "/api/v1/items/source:item%2F%E9%9B%AA/authority";
const CURRENT_TITLE: &str = "A current source observed after the legacy acknowledgement";

pub(super) struct CurrentSourceNetwork {
    auth: Arc<AccountNetworks>,
    item: Value,
    armed: std::sync::atomic::AtomicBool,
    requests: Mutex<Vec<Value>>,
}
#[async_trait]
impl SerializedHttpExecutor for CurrentSourceNetwork {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        self.requests.lock().unwrap().push(value.clone());
        if value["type"] == "openStream" {
            let url = url::Url::parse(value["request"]["url"].as_str().unwrap()).unwrap();
            assert_eq!(url.origin().ascii_serialization(), SOURCE_SERVER);
            return Ok(json!({"type":"opened","status":200,"headers":[{"name":"content-type","value":"text/event-stream"}]}).to_string());
        }
        if value["type"] == "readStream" {
            // Keep the public Sync connection alive until the host aborts/drains its runner.
            return std::future::pending().await;
        }
        let url = url::Url::parse(value["url"].as_str().unwrap()).unwrap();
        if self.armed.load(Ordering::SeqCst)
            && url.origin().ascii_serialization() == SOURCE_SERVER
            && url.path() == "/api/v1/sync/changes"
        {
            assert_eq!(value["method"], "GET");
            let advanced = url.query_pairs().any(|(_, value)| value == CURRENT_CURSOR);
            return Ok(admission_http_completed(
                200,
                json!({"cursor":{"id":CURRENT_CURSOR},"events":if advanced {vec![]} else {vec![json!({
                "id":CURRENT_CURSOR,"type":"item_updated","entityType":"item","entityId":"source:item/雪",
                "userId":"source:user","vaultId":"source:vault/雪","clientId":"current-independent-client",
                "metadata":null,"timestamp":"1789000001123","version":9})]},"hasMore":false,"requiresFullRefresh":false}),
            ));
        }
        if url.origin().ascii_serialization() == SOURCE_SERVER
            && url.path() == CURRENT_AUTHORITY_PATH
        {
            assert_eq!(value["method"], "GET");
            return Ok(admission_http_completed(200, self.item.clone()));
        }
        self.auth.invoke(request).await
    }
    fn cancel(&self, _: &str) {}
}

fn current_source_item() -> Value {
    // These are explicitly new current Server/cache facts under the genuine fixture Vault key.
    // They are not a source preimage, original Attachment inventory, or original completion proof.
    let encrypted = bittery_crypto_core::encrypt_with_aad(
        &json!({"title":CURRENT_TITLE,"username":"current","password":"current password"})
            .to_string(),
        &[0x47; 32],
        &bittery_crypto_core::AadContext {
            vault_id: "source:vault/雪".into(),
            entity_id: "source:item/雪".into(),
            entity_type: "item".into(),
            version: 1,
            user_id: "source:user".into(),
        },
    )
    .unwrap();
    json!({"id":"source:item/雪","vaultId":"source:vault/雪","category":"login","favorite":false,
        "encryptedData":encrypted.ciphertext,"encryptionIv":encrypted.iv,"encryptionAlgorithm":encrypted.algorithm,
        "version":9,"encryptionVersion":1,"encryptedByUserId":"source:user","lastModifiedBy":"source:user",
        "createdAt":"2026-09-20T00:00:00Z","updatedAt":"2026-09-21T00:00:00Z","deletedAt":null,"attachments":[]})
}

fn assert_readable_current_item(runtime: &Arc<Runtime>) {
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::Items {
                account_id: desktop::ACCOUNT.into(),
            },
            sink.clone(),
        )
        .unwrap();
    let RuntimeProjection::Items(projection) = sink.0.lock().unwrap().last().cloned().unwrap()
    else {
        panic!("items")
    };
    assert_eq!(projection.items.len(), 1);
    assert_eq!(projection.items[0].item_id, "source:item/雪");
    assert!(!projection.items[0].favorite);
    let bittery_client_core::PublicItemDraft::Login(data) = &projection.items[0].data else {
        panic!("decrypted login")
    };
    assert_eq!(data.editable.title, CURRENT_TITLE);
    observation.close();
}

#[tokio::test]
async fn actual_current_source_sync_preserves_missing_evidence_and_refuses_a_new_same_item_owner() {
    let (source, command, auth) = protected_crash_source();
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let network = current_source_network(auth);
    let runtime = authenticated_runtime(&directory, platform.clone(), network.clone()).await;
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: source.clone(),
        })
        .await
        .unwrap();
    runtime.open().await.unwrap();
    let original = row(
        &snapshot(&directory, desktop::ACCOUNT).await,
        "crossAccountMoves",
    );
    runtime
        .request(
            RuntimeRequest::QuickUnlock {
                account_id: desktop::ACCOUNT.into(),
                master_password: PASSWORD.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(snapshot(&directory, desktop::ACCOUNT).await["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "authorityItems"));
    install_current_source(&runtime, &directory, &network).await;
    assert_readable_current_item(&runtime);
    assert_parked_projection(&runtime, command["operationId"].as_str().unwrap());
    let before = snapshot(&directory, desktop::ACCOUNT).await;
    let target_before = snapshot(&directory, SECOND_ACCOUNT).await;
    assert_eq!(row(&before, "crossAccountMoves"), original);
    assert!(before["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["store"] != "optimisticItems" && row["store"] != "operations"));
    let requests = network.requests.lock().unwrap().clone();
    let authority = format!("{SOURCE_SERVER}{CURRENT_AUTHORITY_PATH}");
    assert_eq!(
        requests
            .iter()
            .filter(|request| request["url"] == authority)
            .count(),
        1
    );
    let error = runtime
        .request(
            RuntimeRequest::SetItemFavorite {
                account_id: desktop::ACCOUNT.into(),
                item_id: "source:item/雪".into(),
                favorite: true,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        error.message,
        "another active Operation already owns this Item"
    );
    assert_eq!(*network.requests.lock().unwrap(), requests);
    assert_eq!(snapshot(&directory, desktop::ACCOUNT).await, before);
    assert_eq!(snapshot(&directory, SECOND_ACCOUNT).await, target_before);
    runtime.close().await;
    let calls = source.calls.lock().unwrap().len();
    let reopened = authenticated_runtime(&directory, platform, network.clone()).await;
    reopened.open().await.unwrap();
    assert_two_locked(&reopened);
    assert_eq!(
        snapshot(&directory, desktop::ACCOUNT).await["rows"],
        before["rows"]
    );
    assert_eq!(
        snapshot(&directory, SECOND_ACCOUNT).await["rows"],
        target_before["rows"]
    );
    assert_eq!(*network.requests.lock().unwrap(), requests);
    assert_eq!(
        row(
            &snapshot(&directory, desktop::ACCOUNT).await,
            "crossAccountMoves"
        ),
        original
    );
    assert_parked_projection(&reopened, command["operationId"].as_str().unwrap());
    reopened
        .request(
            RuntimeRequest::QuickUnlock {
                account_id: desktop::ACCOUNT.into(),
                master_password: PASSWORD.into(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_readable_current_item(&reopened);
    assert_parked_projection(&reopened, command["operationId"].as_str().unwrap());
    assert_eq!(
        row(
            &snapshot(&directory, desktop::ACCOUNT).await,
            "crossAccountMoves"
        ),
        original
    );
    let requests_after_unlock = network.requests.lock().unwrap().clone();
    let source_after_unlock = snapshot(&directory, desktop::ACCOUNT).await;
    let target_after_unlock = snapshot(&directory, SECOND_ACCOUNT).await;
    let error = reopened
        .request(
            RuntimeRequest::SetItemFavorite {
                account_id: desktop::ACCOUNT.into(),
                item_id: "source:item/雪".into(),
                favorite: true,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
    assert_eq!(
        error.message,
        "another active Operation already owns this Item"
    );
    assert_eq!(*network.requests.lock().unwrap(), requests_after_unlock);
    assert_eq!(
        snapshot(&directory, desktop::ACCOUNT).await,
        source_after_unlock
    );
    assert_eq!(
        snapshot(&directory, SECOND_ACCOUNT).await,
        target_after_unlock
    );
    assert_eq!(source.calls.lock().unwrap().len(), calls);
    reopened.close().await;
}

pub(super) fn current_source_network(auth: Arc<AccountNetworks>) -> Arc<CurrentSourceNetwork> {
    Arc::new(CurrentSourceNetwork {
        auth,
        item: current_source_item(),
        armed: std::sync::atomic::AtomicBool::new(false),
        requests: Mutex::new(Vec::new()),
    })
}
impl CurrentSourceNetwork {
    pub(super) fn request_log(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }
}
pub(super) async fn install_current_source(
    runtime: &Arc<Runtime>,
    directory: &TestDirectory,
    network: &Arc<CurrentSourceNetwork>,
) {
    network.armed.store(true, Ordering::SeqCst);
    let syncing = tokio::spawn(runtime.clone().run_live_sync());
    let settled = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let source = snapshot(directory, desktop::ACCOUNT).await;
            let metadata = row(&source, "replicaMetadata");
            let record_id = format!(
                "{}/source:item/雪",
                metadata["activeGeneration"].as_str().unwrap()
            );
            if metadata["state"] == "ready"
                && metadata["stagingGeneration"].is_null()
                && metadata["activeCursor"] == json!({"type":"capturedValue","id":CURRENT_CURSOR})
                && source["rows"].as_array().unwrap().iter().any(|row| {
                    row["store"] == "authorityItems"
                        && row["key"]["recordId"] == record_id
                        && serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap())
                            .unwrap()
                            == network.item
                })
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    syncing.abort();
    let _ = syncing.await;
    assert!(
        settled.is_ok(),
        "actual Sync must promote current item and cursor; snapshot={:?}; requests={:?}",
        snapshot(directory, desktop::ACCOUNT).await,
        network
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| (&request["type"], &request["url"]))
            .collect::<Vec<_>>()
    );
}
