use super::*;

struct MemberHttp {
    inner: RoutingAuthHttp,
    encrypted_private_key: String,
    wrapped: String,
    item: Value,
}

#[async_trait]
impl SerializedHttpExecutor for MemberHttp {
    async fn invoke(
        &self,
        request_json: zeroize::Zeroizing<String>,
    ) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&request_json).unwrap();
        let url = request["url"].as_str().unwrap();
        if url.contains("/sync/bootstrap") {
            let common = json!({"hasMore": false, "nextCursor": null, "syncCursor": {"id": "member-cursor"}});
            let mut page = common;
            if url.contains("phase=vaults") {
                page["phase"] = json!("vaults");
                page["vaults"] = json!([{
                    "encryptedVaultKey": self.wrapped, "icon": null, "id": "vault-1",
                    "imageUrl": null, "name": "Shared", "role": "member", "vaultType": "team"
                }]);
            } else {
                page["phase"] = json!("items");
                page["items"] = json!([self.item]);
            }
            return Ok(routing_completed(200, page));
        }
        let finish = url.ends_with("/finish");
        let answer = self.inner.invoke(request_json).await?;
        if !finish {
            return Ok(answer);
        }
        // Keep the real SRP fixture proof. Only the existing Server identity/key payload varies.
        let mut answer: Value = serde_json::from_str(&answer).unwrap();
        let bytes: Vec<u8> = serde_json::from_value(answer["body"].clone()).unwrap();
        let mut body: Value = serde_json::from_slice(&bytes).unwrap();
        body["user"]["encryptedPrivateKey"] = json!(self.encrypted_private_key);
        body["vaultKeys"]["items"] = json!([{
            "encryptedVaultKey": self.wrapped, "role": "member", "vaultIcon": null,
            "vaultId": "vault-1", "vaultImageUrl": null, "vaultName": "Shared", "vaultType": "team"
        }]);
        answer["body"] = json!(serde_json::to_vec(&body).unwrap());
        Ok(answer.to_string())
    }
    fn cancel(&self, dispatch_id: &str) {
        self.inner.cancel(dispatch_id);
    }
}

#[tokio::test]
async fn rsa_member_can_create_and_read_after_real_account_installation() {
    let pair = bittery_crypto_core::generate_rsa_key_pair().unwrap();
    let vault_key = [23; 32];
    let verified = verified_with_derived_muk();
    let encrypted_private_key = serde_json::to_string(
        &bittery_crypto_core::encrypt(&pair.private_key, &*verified.master_unlock_key).unwrap(),
    )
    .unwrap();
    let wrapped =
        bittery_crypto_core::encrypt_vault_key_for_member(&vault_key, &pair.public_key).unwrap();
    let (_, mut item) =
        sealed_login_item_with_key("member-item", "Member Login", "member-secret", &vault_key);
    item.as_object_mut().unwrap().remove("vault");
    let http = Arc::new(MemberHttp {
        inner: RoutingAuthHttp::new(current_kdf_profile(), RoutingAuthBehavior::Success, None),
        encrypted_private_key,
        wrapped,
        item,
    });
    let (runtime, replica, platform) = routing_harness(http.clone()).await;
    let response = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::SignedIn { account_id, .. } = response else {
        panic!("expected installed Account")
    };
    assert_eq!(
        items(&runtime, &account_id).len(),
        1,
        "Bootstrap must decrypt real RSA member authority"
    );
    let cases = super::super::create_tests::item_category_cases();
    for (draft, _, _) in &cases {
        let response = runtime
            .request(
                RuntimeRequest::CreateItem {
                    account_id: account_id.clone(),
                    vault_id: "vault-1".into(),
                    draft: draft.clone(),
                },
                RequestCancellation::new(),
            )
            .await
            .expect("real RSA member authority must use the installed private-key envelope");
        assert!(matches!(response, RuntimeResponse::Accepted { .. }));
    }
    assert_drafts(&runtime, &account_id, &cases);
    let accepted = runtime.replica.snapshot(&account_id).unwrap().operations;
    runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account_id.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_eq!(
        runtime
            .projection(&ObservationRequest::Items {
                account_id: account_id.clone()
            })
            .err()
            .expect("locked projection must be refused")
            .code,
        RuntimeErrorCode::AuthenticationRequired
    );
    runtime.close().await;
    drop(runtime);
    let restored = Runtime::with_configured_serialized_executors(
        replica,
        platform,
        http,
        AuthClientConfig::new(
            "client-routing".into(),
            ClientPlatform::Desktop,
            "0.5.2-test".into(),
        )
        .unwrap(),
    );
    restored.open().await.unwrap();
    assert_eq!(
        restored.account_access_state(&account_id),
        Some(AccountAccessState::Locked)
    );
    restored
        .request(
            quick_unlock_request(account_id.as_str()),
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert_drafts(&restored, &account_id, &cases);
    assert_eq!(
        restored.replica.snapshot(&account_id).unwrap().operations,
        accepted
    );
}

fn items(runtime: &Runtime, account_id: &AccountId) -> Vec<crate::ItemProjection> {
    let projection = runtime
        .projection(&ObservationRequest::Items {
            account_id: account_id.clone(),
        })
        .unwrap();
    let RuntimeProjection::Items(items) = projection.projection else {
        panic!("expected Items")
    };
    items.items
}

fn assert_drafts(
    runtime: &Runtime,
    account_id: &AccountId,
    cases: &[(
        crate::ItemDraft,
        crate::server_contract::ItemCategory,
        crate::replica::AuthorityItemCategory,
    )],
) {
    let items = items(runtime, account_id);
    assert_eq!(
        items.len(),
        6,
        "authority and all five accepted categories must decrypt"
    );
    for (draft, _, _) in cases {
        let expected = crate::PublicItemDraft::from(draft);
        assert!(items.iter().any(|item| item.data == expected));
    }
}

fn stage_owner_conversion_authority(
    http: &RoutingAuthHttp,
    item: &Value,
    vault_type: &str,
    wrapped: &str,
    cursor: &str,
) {
    *http.bootstrap_pages.lock().unwrap() = vec![
        json!({
            "phase": "vaults", "hasMore": false, "nextCursor": null,
            "syncCursor": { "id": cursor },
            "vaults": [{
                "id": "vault-1", "name": "Converted Vault", "vaultType": vault_type,
                "role": "owner", "encryptedVaultKey": wrapped, "icon": null, "imageUrl": null
            }]
        }),
        json!({
            "phase": "items", "hasMore": false, "nextCursor": null,
            "syncCursor": { "id": cursor }, "items": [item]
        }),
    ];
    http.state.lock().unwrap().bootstrap_index = 0;
}

#[tokio::test]
async fn incoming_personal_team_conversion_refreshes_owner_authority_without_rewriting_accepted_work(
) {
    let vault_key = [37; 32];
    let (original_wrapper, mut item) = sealed_login_item_with_key(
        "conversion-item",
        "Existing credential",
        "conversion-secret",
        &vault_key,
    );
    item.as_object_mut().unwrap().remove("vault");
    let http = Arc::new(RoutingAuthHttp::new(
        current_kdf_profile(),
        RoutingAuthBehavior::Success,
        None,
    ));
    stage_owner_conversion_authority(&http, &item, "personal", &original_wrapper, "personal-1");
    let (runtime, _replica, _platform) = routing_harness(http.clone()).await;
    let RuntimeResponse::SignedIn { account_id, .. } = runtime
        .request(
            sign_in_request(NORMALIZED_EMAIL),
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("expected installed owner Account");
    };
    let draft = super::super::create_tests::item_category_cases()[0]
        .0
        .clone();
    let create = || RuntimeRequest::CreateItem {
        account_id: account_id.clone(),
        vault_id: "vault-1".into(),
        draft: draft.clone(),
    };
    assert!(matches!(
        runtime
            .request(create(), RequestCancellation::new())
            .await
            .unwrap(),
        RuntimeResponse::Accepted { .. }
    ));
    let initial = runtime.replica.snapshot(&account_id).unwrap();
    let mut accepted = initial.operations.clone();
    let derived = verified_with_derived_muk();
    let personal_wrapper = encrypt_vault_key_with_muk(
        &vault_key,
        derived.master_unlock_key.as_slice(),
        &VaultKeyWrapContext::new("vault-1", "user-1", 1),
    )
    .unwrap();
    assert_ne!(personal_wrapper, original_wrapper);

    // Actual Server conversion preserves Owner role. Personal→team keeps its wrapper; the sole
    // Owner's team→personal conversion may submit a fresh personal wrapper for the same Vault key.
    for (kind, wrapper, cursor) in [
        ("team", &original_wrapper, "team-2"),
        ("personal", &personal_wrapper, "personal-3"),
    ] {
        let before = runtime.replica.snapshot(&account_id).unwrap();
        stage_owner_conversion_authority(&http, &item, kind, wrapper, cursor);
        *http.changes_pages.lock().unwrap() = vec![json!({
            "cursor": { "id": cursor }, "hasMore": false, "requiresFullRefresh": false,
            "events": [{
                "id": cursor, "type": "vault_updated", "entityType": "vault",
                "entityId": "vault-1", "vaultId": "vault-1", "userId": "user-1",
                "version": 1, "clientId": null, "metadata": null, "timestamp": "0"
            }]
        })];
        http.state.lock().unwrap().changes_index = 0;
        // The ordinary incoming changes path interprets the hint and fetches complete authority;
        // no test writes Replica rows, key material or a local conversion result.
        runtime
            .bootstrap_account(&account_id, RequestCancellation::new())
            .await
            .unwrap();
        let after = runtime.replica.snapshot(&account_id).unwrap();
        assert_ne!(
            after.bootstrap.active_generation,
            before.bootstrap.active_generation
        );
        assert_eq!(after.incarnation, initial.incarnation);
        assert_eq!(after.lock_epoch, initial.lock_epoch);
        assert_eq!(
            after.operations, accepted,
            "conversion changed accepted encrypted evidence"
        );
        assert_eq!(after.receipts, initial.receipts);
        assert_eq!(
            after.bootstrap.active_cursor,
            crate::replica::SyncCursor::CapturedValue { id: cursor.into() }
        );
        let authority = after.bootstrap.snapshot();
        assert_eq!(authority.visible_vaults.len(), 1);
        assert_eq!(authority.visible_vaults[0].encrypted_vault_key, *wrapper);
        let RuntimeProjection::Items(projection) = runtime
            .projection(&ObservationRequest::Items {
                account_id: account_id.clone(),
            })
            .unwrap()
            .projection
        else {
            panic!("expected current Item/Vault projection");
        };
        assert_eq!(projection.vaults.len(), 1);
        assert_eq!(
            serde_json::to_value(projection.vaults[0].vault_type).unwrap(),
            json!(kind)
        );
        assert_eq!(projection.vaults[0].role, crate::VaultProjectionRole::Owner);
        let existing = projection
            .items
            .iter()
            .find(|item| item.item_id == "conversion-item")
            .unwrap();
        assert_eq!(existing.data.password(), Some("conversion-secret"));
        // New local admission must use the refreshed authoritative wrapper, preserving all older
        // request bytes/fingerprints while retaining the same writable Owner role.
        assert!(matches!(
            runtime
                .request(create(), RequestCancellation::new())
                .await
                .unwrap(),
            RuntimeResponse::Accepted { .. }
        ));
        accepted = runtime.replica.snapshot(&account_id).unwrap().operations;
    }
    assert!(!http
        .requests()
        .iter()
        .any(|request| request["method"] == "PUT"));
    runtime.close().await;
}
