//! Category payloads cross the public Move path using the existing Item envelope.
use super::*;

#[tokio::test]
async fn every_supported_category_crosses_accounts_with_its_complete_payload() {
    let cases = crate::runtime::create_tests::item_category_cases();
    assert_eq!(cases.len(), 5);
    for (mut expected, category, authority_category) in cases {
        if let crate::ItemDraft::SecureNote(note) = &mut expected {
            note.note = "First line\nSecond line: 🗝".into();
        }
        let category = serde_json::to_value(category)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        move_category(
            expected,
            &category,
            serde_json::to_value(authority_category).unwrap(),
        )
        .await;
    }
}

async fn move_category(expected: crate::ItemDraft, category: &str, authority_category: Value) {
    let plaintext = crate::runtime::create::item_plaintext(&expected).unwrap();
    let sealed = encrypt_with_aad(
        &plaintext,
        &[41; 32],
        &AadContext {
            vault_id: "vault-1".into(),
            entity_id: SOURCE_ITEM.into(),
            entity_type: "item".into(),
            version: 1,
            user_id: "user-1".into(),
        },
    )
    .unwrap();
    let http = MoveHttp::new();
    {
        let mut items = http.source.server.created_items.lock().unwrap();
        items[0].category = category.into();
        items[0].encrypted_data = sealed.ciphertext;
        items[0].encryption_iv = sealed.iv;
        items[0].encryption_algorithm = sealed.algorithm;
    }
    let AdmittedMoveFixture {
        database,
        http,
        runtime,
        source,
        operation_id,
        ..
    } = AdmittedMoveFixture::with_http(http).await;
    let RuntimeProjection::Items(items) = runtime
        .projection(&ObservationRequest::Items {
            account_id: source.clone(),
        })
        .unwrap()
        .projection
    else {
        panic!("expected Items");
    };
    assert_eq!(items.items.len(), 1);
    assert_eq!(items.items[0].data, crate::PublicItemDraft::from(&expected));
    assert_eq!(items.items[0].status, crate::ItemProjectionStatus::Pending);
    let accepted = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(accepted["source"]["category"], authority_category);
    assert_eq!(accepted["target"]["category"], authority_category);
    let create_bytes: Vec<u8> =
        serde_json::from_value(accepted["children"][0]["request"]["body"].clone()).unwrap();
    let create_body: Value = serde_json::from_slice(&create_bytes).unwrap();
    assert_eq!(create_body["category"], category);

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
    .unwrap_or_else(|_| panic!("the {category} Move must finish through the public dispatcher"));
    let target_items = http.target.server.created_items.lock().unwrap().clone();
    assert_eq!(target_items.len(), 1);
    let target = &target_items[0];
    assert_eq!(target.category, category);
    assert_eq!(target.id, accepted["target"]["id"].as_str().unwrap());
    let target_plaintext = bittery_crypto_core::decrypt_with_aad(
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
            version: u64::try_from(target.encryption_version).unwrap(),
            user_id: "user-1".into(),
        },
    )
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&target_plaintext).unwrap(),
        serde_json::from_str::<Value>(&plaintext).unwrap()
    );
    assert!(http.source.server.created_items().is_empty());
    assert_eq!(http.mutations(SOURCE_ORIGIN).len(), 2);
    let completed = workflow(&durable_rows(&database.0, &source).await, &operation_id);
    assert_eq!(completed["target"], accepted["target"]);
    assert_eq!(completed["stage"], json!({"type":"completed"}));
    let children = completed["children"].as_array().unwrap();
    assert_eq!(children.len(), 3);
    assert!(children
        .iter()
        .all(|child| child["result"]["result"]["type"] == "applied"));
    close_move_runtime(runtime, runner).await;
}
