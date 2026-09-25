//! Independent exclusions are restored only by the explicit two-owner nonsecret challenge.
use super::*;
#[path = "native_independent_revalidation_variants_tests.rs"]
mod variants;

async fn invoke_value(
    control: &crate::NativeAuthorityFacade,
    request: Value,
) -> Result<Value, RuntimeError> {
    let response = control.invoke(Zeroizing::new(request.to_string())).await?;
    Ok(serde_json::from_str(&response).unwrap())
}

#[tokio::test]
async fn independent_revalidation_restores_only_fresh_authority_without_borrowing_credentials() {
    let (source, source_http) = travel_owner("revalidation-source", ClientPlatform::Desktop).await;
    let (destination, _) =
        travel_owner("revalidation-independent", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    hide_source(&source, &source_http, &account).await;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source(
            "allowed-extension".into(),
            "revalidation-source-port".into(),
        )
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "revalidation-consumer-port".into())
        .await
        .unwrap();
    let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
    wait_selected_cleanup(&destination, &account, &incarnation).await;
    source_control
        .acknowledge_restrictions(
            destination_control
                .restriction_acknowledgement(&channel)
                .unwrap(),
        )
        .unwrap();

    *source_http.policy.lock().unwrap() = TravelModeResponse {
        enabled: false,
        enabled_at: None,
        hidden_vault_ids: vec![],
        updated_at: "2023-11-14T22:13:21Z".into(),
    };
    source
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    source
        .runtime
        .bootstrap_account(&account, RequestCancellation::new())
        .await
        .unwrap();
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    destination
        .runtime
        .bootstrap_account(&account, RequestCancellation::new())
        .await
        .unwrap();
    let before = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    assert!(
        before.bootstrap.vaults.keys().all(|(_, id)| id != SELECTED),
        "disabled source policy and fresh ordinary bootstrap cannot remove a native exclusion"
    );
    let session_before = destination
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    let prepared = invoke_value(&destination_control, json!({"type":"prepareIndependentRevalidation", "channelId":channel, "sourceAccount":account})).await;
    if let Err(error) = &prepared {
        source.runtime.close().await;
        destination.runtime.close().await;
        driver.await.unwrap();
        panic!(
            "existing challenge owner must prepare independent restriction revalidation: {error:?}"
        );
    }
    let prepared = prepared
        .expect("existing challenge owner must prepare independent restriction revalidation");
    let challenge = prepared["challenge"].clone();
    assert_eq!(
        challenge["purpose"]["type"],
        "revalidateIndependentRestrictions"
    );
    assert_eq!(challenge["purpose"]["excludedVaultIds"], json!([SELECTED]));
    assert!(
        invoke_value(
            &source_control,
            json!({"type":"export", "challenge":challenge})
        )
        .await
        .is_err(),
        "revalidation purpose cannot export credentials"
    );
    let proved = invoke_value(
        &source_control,
        json!({"type":"revalidateIndependentRestrictions", "challenge":challenge}),
    )
    .await
    .unwrap();
    assert_eq!(proved["type"], "independentRestrictionsRevalidated");
    assert_eq!(proved["reply"]["visibleVaultIds"], json!([SELECTED]));
    let reply = proved["reply"].clone();
    invoke_value(
        &destination_control,
        json!({"type":"completeIndependentRevalidation", "reply":reply}),
    )
    .await
    .unwrap();
    assert!(
        invoke_value(
            &destination_control,
            json!({"type":"completeIndependentRevalidation", "reply":reply})
        )
        .await
        .is_err(),
        "completion is single-use"
    );
    let session_after = destination
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(
        session_before == session_after,
        "nonsecret completion must not install or renew any Session or wrapper"
    );
    assert_eq!(
        destination.runtime.account_access_state(&account),
        Some(AccountAccessState::Unlocked)
    );
    assert!(!destination
        .runtime
        .native_authority
        .has_borrowed_session(&account));
    destination
        .runtime
        .bootstrap_account(&account, RequestCancellation::new())
        .await
        .unwrap();
    accept_login(&destination.runtime, &account, SELECTED).await;
    assert!(projected_vaults(&destination.runtime, &account).contains(&SELECTED.to_owned()));
    source.runtime.close().await;
    destination.runtime.close().await;
    driver.await.unwrap();
}
