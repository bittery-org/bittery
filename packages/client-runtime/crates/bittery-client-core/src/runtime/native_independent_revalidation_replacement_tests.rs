use super::*;

#[tokio::test]
async fn independent_revalidation_refuses_proof_after_consumer_account_replacement() {
    let fixture = IndependentFixture::new(&[SELECTED]).await;
    let challenge = fixture.prepare().await;
    let proof = fixture.prove(&challenge).await;
    let account = AccountId::from("account-1");
    let replacement = Incarnation::from("replacement-consumer-generation");
    // Connected Desktop authority fences independent Sign-in. Use the supported
    // standalone replacement transition, then reconnect this same consumer Runtime.
    fixture
        .destination
        .runtime
        .native_authority()
        .retire_channel(&fixture.channel)
        .await
        .unwrap();
    // Replace the Account through the ordinary authenticated installation owner. The
    // delayed proof retains the original destination incarnation and must not restore
    // authority or credentials in this independently authenticated successor.
    let mut authentication = verified_with_derived_muk();
    authentication.master_unlock_key = Zeroizing::new(TEST_MASTER_UNLOCK_KEY);
    authentication.token = Zeroizing::new("replacement-consumer-session".to_owned());
    authentication.travel_mode = fixture.destination_http.policy.lock().unwrap().clone();
    authentication.vault_keys = fixture
        .destination_http
        .vaults
        .iter()
        .map(|vault| AuthVaultKeyResponse {
            encrypted_vault_key: vault.encrypted_vault_key.clone(),
            role: VaultRole::Owner,
            vault_icon: None,
            vault_id: vault.id.clone(),
            vault_image_url: None,
            vault_name: vault.name.clone(),
            vault_type: VaultType::Personal,
        })
        .collect();
    fixture
        .destination
        .runtime
        .install_verified_authentication_with(
            authentication,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["replacement-consumer-generation"]),
        )
        .await
        .unwrap();
    fixture
        .destination
        .runtime
        .bootstrap_account(&account, RequestCancellation::new())
        .await
        .unwrap();
    let fresh_source = fixture
        .source
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "replacement-source-port".into())
        .unwrap();
    fixture
        .destination
        .runtime
        .native_authority()
        .attach_desktop(
            fresh_source.snapshot().unwrap(),
            "replacement-consumer-port".into(),
        )
        .await
        .unwrap();
    let before = fixture
        .destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before.incarnation, replacement);
    let session_before = fixture
        .destination
        .runtime
        .platform_storage
        .load_current_session(&account, &replacement)
        .await
        .unwrap()
        .unwrap();
    let access_before = fixture.destination.runtime.account_access_state(&account);
    fixture.destination.platform.clear_events();
    let completed = invoke_value(
        &fixture.destination.runtime.native_authority(),
        json!({"type":"completeIndependentRevalidation", "reply":proof}),
    )
    .await;
    let after = fixture
        .destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let session_after = fixture
        .destination
        .runtime
        .platform_storage
        .load_current_session(&account, &replacement)
        .await
        .unwrap()
        .unwrap();
    let access_after = fixture.destination.runtime.account_access_state(&account);
    let borrowed = fixture
        .destination
        .runtime
        .native_authority
        .has_borrowed_session(&account);
    let credentials_untouched = fixture.destination.platform.events().is_empty();
    fixture.close().await;

    assert!(
        completed.is_err(),
        "a proof for the old destination cannot complete"
    );
    assert_eq!(access_before, Some(AccountAccessState::Unlocked));
    assert_eq!(access_after, access_before);
    assert_eq!(after, before);
    assert!(session_after == session_before);
    assert!(credentials_untouched && !borrowed);
}
