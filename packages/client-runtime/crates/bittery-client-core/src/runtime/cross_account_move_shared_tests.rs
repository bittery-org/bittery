//! Shared Vault membership uses the Account's real installed RSA private-key envelope.
use super::*;

#[tokio::test]
async fn private_source_moves_to_an_rsa_shared_member_destination() {
    assert_shared_move(false, true).await;
}

#[tokio::test]
async fn rsa_shared_member_source_moves_to_a_private_destination() {
    assert_shared_move(true, false).await;
}

async fn assert_shared_move(source_shared: bool, target_shared: bool) {
    let mut http = MoveHttp::new();
    if source_shared {
        Arc::get_mut(&mut http)
            .unwrap()
            .source
            .use_shared_member(&[41; 32]);
    }
    if target_shared {
        Arc::get_mut(&mut http)
            .unwrap()
            .target
            .use_shared_member(&TARGET_KEY);
    }
    let AdmittedMoveFixture {
        database,
        http,
        runtime,
        source,
        target,
        operation_id,
        ..
    } = AdmittedMoveFixture::with_http(http).await;
    for (account, shared) in [(&source, source_shared), (&target, target_shared)] {
        let rows = durable_rows(&database.0, account).await;
        let vault = rows
            .iter()
            .find(|row| row["store"] == "authorityVaults")
            .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
            .unwrap();
        assert_eq!(vault["vaultType"], if shared { "team" } else { "personal" });
        assert_eq!(vault["role"], if shared { "member" } else { "owner" });
    }
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_source_visible(&runtime, &source, crate::ItemProjectionStatus::Pending);
    http.resumed.store(true, Ordering::SeqCst);
    http.trash_result.release.add_permits(1);
    http.delete_result.release.add_permits(1);
    http.offline.store(false, Ordering::SeqCst);
    let runner = tokio::spawn(runtime.clone().run_operation_dispatch());
    tokio::time::timeout(Duration::from_secs(10), async {
        while resolution(&runtime, &source, &operation_id) != OperationResolution::Applied {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("RSA Member authority must complete the public cross-Account Move");
    let target_items = http.target.server.created_items.lock().unwrap().clone();
    assert_eq!(target_items.len(), 1);
    let target = &target_items[0];
    assert_eq!(target.id, accepted["target"]["id"].as_str().unwrap());
    let plaintext = bittery_crypto_core::decrypt_with_aad(
        &bittery_crypto_core::EncryptedData {
            ciphertext: target.encrypted_data.clone(),
            iv: target.encryption_iv.clone(),
            algorithm: target.encryption_algorithm.clone(),
        },
        &TARGET_KEY,
        &AadContext {
            vault_id: target.vault_id.clone(),
            entity_id: target.id.clone(),
            entity_type: "item".into(),
            user_id: "user-1".into(),
            version: u64::try_from(target.encryption_version).unwrap(),
        },
    )
    .unwrap();
    let data: Value = serde_json::from_str(&plaintext).unwrap();
    assert_eq!(
        data,
        json!({"title":"Original Login", "username":"ada", "password":"move-password"})
    );
    assert!(http.source.server.created_items().is_empty());
    assert_eq!(http.mutations(SOURCE_ORIGIN).len(), 2);
    assert_eq!(http.target.server.creates(), 1);
    let completed = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(completed["stage"], json!({"type":"completed"}));
    assert_eq!(completed["target"], accepted["target"]);
    assert_eq!(completed["children"].as_array().unwrap().len(), 3);
    assert!(completed["children"]
        .as_array()
        .unwrap()
        .iter()
        .all(|child| child["result"]["result"]["type"] == "applied"));
    close_move_runtime(runtime, runner).await;
}

#[tokio::test]
async fn shared_read_only_destination_refuses_move_without_changing_either_account() {
    assert_read_only_move_refused(false).await;
}

#[tokio::test]
async fn shared_read_only_source_refuses_move_without_changing_either_account() {
    assert_read_only_move_refused(true).await;
}

async fn assert_read_only_move_refused(source_read_only: bool) {
    let database = MoveDatabase::new();
    let platform = Arc::new(InstallationPlatform::default());
    let mut http = MoveHttp::new();
    let endpoint = if source_read_only {
        let endpoint = &mut Arc::get_mut(&mut http).unwrap().source;
        endpoint.use_shared_member(&[41; 32]);
        endpoint
    } else {
        let endpoint = &mut Arc::get_mut(&mut http).unwrap().target;
        endpoint.use_shared_member(&TARGET_KEY);
        endpoint
    };
    endpoint.set_vault_role(crate::server_contract::VaultRole::ReadOnly);
    let sqlite = MoveSqlite::open(&database.0);
    let runtime = open_move_runtime(sqlite, platform, http.clone()).await;
    let (source, target) = sign_in_move_accounts(&runtime).await;
    let source_rows = durable_rows(&database.0, &source).await;
    let target_rows = durable_rows(&database.0, &target).await;
    let read_only_rows = if source_read_only {
        &source_rows
    } else {
        &target_rows
    };
    let read_only_vault = read_only_rows
        .iter()
        .find(|row| row["store"] == "authorityVaults")
        .map(|row| serde_json::from_str::<Value>(row["payloadJson"].as_str().unwrap()).unwrap())
        .unwrap();
    assert_eq!(read_only_vault["vaultType"], "team");
    assert_eq!(read_only_vault["role"], "readOnly");
    let source_items = ObservationRequest::Items {
        account_id: source.clone(),
    };
    let target_items = ObservationRequest::Items {
        account_id: target.clone(),
    };
    let source_visible =
        serde_json::to_value(runtime.projection(&source_items).unwrap().projection).unwrap();
    let target_visible =
        serde_json::to_value(runtime.projection(&target_items).unwrap().projection).unwrap();
    let requests_before = http.requests.lock().unwrap().len();
    let error = runtime
        .request(
            RuntimeRequest::MoveItem {
                account_id: source.clone(),
                item_id: SOURCE_ITEM.into(),
                target_account_id: Some(target.clone()),
                target_vault_id: "vault-1".into(),
            },
            RequestCancellation::new(),
        )
        .await
        .expect_err("shared ReadOnly participation must refuse public Move admission");
    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(durable_rows(&database.0, &source).await, source_rows);
    assert_eq!(durable_rows(&database.0, &target).await, target_rows);
    assert_source_visible(
        &runtime,
        &source,
        crate::ItemProjectionStatus::Authoritative,
    );
    assert_eq!(
        serde_json::to_value(runtime.projection(&source_items).unwrap().projection).unwrap(),
        source_visible
    );
    assert_eq!(
        serde_json::to_value(runtime.projection(&target_items).unwrap().projection).unwrap(),
        target_visible
    );
    for account in [&source, &target] {
        let RuntimeProjection::Operations(operations) = runtime
            .projection(&ObservationRequest::Operations {
                account_id: account.clone(),
            })
            .unwrap()
            .projection
        else {
            panic!("expected public Operations projection");
        };
        assert!(
            operations.operations.is_empty(),
            "refusal must not admit a workflow or ordinary child"
        );
    }
    assert_eq!(http.requests.lock().unwrap().len(), requests_before);
    assert!(http.mutations(SOURCE_ORIGIN).is_empty());
    assert!(http.mutations(TARGET_ORIGIN).is_empty());
    assert_eq!(
        http.source.server.created_items(),
        vec![SOURCE_ITEM.to_owned()]
    );
    assert!(http.target.server.created_items().is_empty());
    assert!(http.source.server.outcomes.lock().unwrap().is_empty());
    assert!(http.target.server.outcomes.lock().unwrap().is_empty());
    tokio::time::timeout(Duration::from_secs(5), runtime.close())
        .await
        .unwrap();
}
