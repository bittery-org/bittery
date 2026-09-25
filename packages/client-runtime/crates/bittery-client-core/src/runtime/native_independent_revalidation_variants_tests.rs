use super::*;

#[path = "native_independent_revalidation_replacement_tests.rs"]
mod replacement;

struct IndependentFixture {
    source: SqliteOwner,
    source_http: Arc<MembershipHttp>,
    destination: SqliteOwner,
    destination_http: Arc<MembershipHttp>,
    source_channel: String,
    source_attachment: crate::NativeSourceAttachment,
    channel: String,
    driver: tokio::task::JoinHandle<()>,
}

impl IndependentFixture {
    async fn new(hidden: &[&str]) -> Self {
        Self::with_clocks(
            hidden,
            Arc::new(FixedClock(NOW_MS)),
            Arc::new(FixedClock(NOW_MS)),
        )
        .await
    }

    async fn with_clocks(
        hidden: &[&str],
        source_clock: Arc<dyn Clock>,
        destination_clock: Arc<dyn Clock>,
    ) -> Self {
        let (source, source_http) = travel_owner_with_clock(
            "independent-proof-source",
            ClientPlatform::Desktop,
            source_clock,
        )
        .await;
        let (destination, destination_http) = travel_owner_with_clock(
            "independent-proof-consumer",
            ClientPlatform::Extension,
            destination_clock,
        )
        .await;
        let account = AccountId::from("account-1");
        *source_http.policy.lock().unwrap() = TravelModeResponse {
            enabled: true,
            enabled_at: Some("2023-11-14T22:13:20Z".into()),
            hidden_vault_ids: hidden.iter().map(|id| (*id).into()).collect(),
            updated_at: "2023-11-14T22:13:20Z".into(),
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
        let source_control = source.runtime.native_authority();
        let destination_control = destination.runtime.native_authority();
        let source_attachment = source
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "proof-source-port".into())
            .unwrap();
        let initial = source_attachment.snapshot().unwrap();
        let source_channel = initial.channel_id.clone();
        let channel = destination_control
            .attach_desktop(initial, "proof-consumer-port".into())
            .await
            .unwrap();
        let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
        wait_selected_cleanup(&destination, &account, &Incarnation::from("generation-1")).await;
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
        Self {
            source,
            source_http,
            destination,
            destination_http,
            source_channel,
            source_attachment,
            channel,
            driver,
        }
    }

    async fn prepare(&self) -> Value {
        invoke_value(&self.destination.runtime.native_authority(), json!({"type":"prepareIndependentRevalidation", "channelId":self.channel, "sourceAccount":"account-1"})).await.unwrap()["challenge"].clone()
    }

    async fn prove(&self, challenge: &Value) -> Value {
        invoke_value(
            &self.source.runtime.native_authority(),
            json!({"type":"revalidateIndependentRestrictions", "challenge":challenge}),
        )
        .await
        .unwrap()["reply"]
            .clone()
    }

    async fn session(&self) -> crate::platform_storage::CurrentSessionDocument {
        self.destination
            .runtime
            .platform_storage
            .load_current_session(
                &AccountId::from("account-1"),
                &Incarnation::from("generation-1"),
            )
            .await
            .unwrap()
            .unwrap()
    }

    async fn close(self) {
        self.source.runtime.close().await;
        self.destination.runtime.close().await;
        self.driver.await.unwrap();
    }
}

#[tokio::test]
async fn independent_revalidation_rejects_purpose_crossuse_without_consuming_its_challenge() {
    let fixture = IndependentFixture::new(&[SELECTED]).await;
    let challenge = fixture.prepare().await;
    let before = fixture.session().await;
    let mut transfer_challenge = challenge.clone();
    transfer_challenge["purpose"] = json!({"type":"transfer"});
    let exported = invoke_value(
        &fixture.source.runtime.native_authority(),
        json!({"type":"export", "challenge":transfer_challenge}),
    )
    .await
    .unwrap();
    let mut transfer = exported["reply"].clone();
    transfer["challenge"] = challenge.clone();
    assert!(invoke_value(
        &fixture.destination.runtime.native_authority(),
        json!({"type":"completeImport", "reply":transfer})
    )
    .await
    .is_err());
    let mut wrong_reply = fixture.prove(&challenge).await;
    wrong_reply["challenge"]["purpose"] = json!({"type":"transfer"});
    assert!(invoke_value(
        &fixture.destination.runtime.native_authority(),
        json!({"type":"completeIndependentRevalidation", "reply":wrong_reply})
    )
    .await
    .is_err());
    assert!(fixture.session().await == before);
    let proof = fixture.prove(&challenge).await;
    invoke_value(
        &fixture.destination.runtime.native_authority(),
        json!({"type":"completeIndependentRevalidation", "reply":proof}),
    )
    .await
    .unwrap();
    assert!(fixture.session().await == before);
    fixture.close().await;
}

#[tokio::test]
async fn independent_revalidation_refuses_proof_after_successor_source_restriction() {
    let fixture = IndependentFixture::new(&[SELECTED]).await;
    let challenge = fixture.prepare().await;
    let proof = fixture.prove(&challenge).await;
    *fixture.source_http.policy.lock().unwrap() = TravelModeResponse {
        enabled: true,
        enabled_at: Some("2023-11-14T22:13:22Z".into()),
        hidden_vault_ids: vec![REMAINING.into()],
        updated_at: "2023-11-14T22:13:22Z".into(),
    };
    fixture
        .source
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: AccountId::from("account-1"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    fixture
        .destination
        .runtime
        .native_authority()
        .apply_authority(
            &fixture.channel,
            fixture
                .source
                .runtime
                .native_authority()
                .source_snapshot(&fixture.source_channel)
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(invoke_value(
        &fixture.source.runtime.native_authority(),
        json!({"type":"revalidateIndependentRestrictions", "challenge":challenge})
    )
    .await
    .is_err());
    assert!(invoke_value(
        &fixture.destination.runtime.native_authority(),
        json!({"type":"completeIndependentRevalidation", "reply":proof})
    )
    .await
    .is_err());
    assert_eq!(
        fixture
            .destination
            .runtime
            .account_access_state(&AccountId::from("account-1")),
        Some(AccountAccessState::Unlocked)
    );
    assert!(!fixture
        .destination
        .runtime
        .native_authority
        .has_borrowed_session(&AccountId::from("account-1")));
    fixture.close().await;
}

#[tokio::test]
async fn independent_revalidation_refuses_proof_after_consumer_lock() {
    let fixture = IndependentFixture::new(&[SELECTED]).await;
    let proof = fixture.prove(&fixture.prepare().await).await;
    fixture
        .destination
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: AccountId::from("account-1"),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let before = fixture.session().await;
    assert!(invoke_value(
        &fixture.destination.runtime.native_authority(),
        json!({"type":"completeIndependentRevalidation", "reply":proof})
    )
    .await
    .is_err());
    assert!(fixture.session().await == before);
    assert_eq!(
        fixture
            .destination
            .runtime
            .account_access_state(&AccountId::from("account-1")),
        Some(AccountAccessState::Locked)
    );
    fixture.close().await;
}

#[tokio::test]
async fn independent_revalidation_restores_only_the_intersection_of_fresh_readable_membership() {
    let fixture = IndependentFixture::new(&[SELECTED, REMAINING]).await;
    fixture
        .source_http
        .missing_memberships
        .lock()
        .unwrap()
        .insert(REMAINING.into());
    fixture
        .destination_http
        .missing_memberships
        .lock()
        .unwrap()
        .insert(SELECTED.into());
    let before = fixture.session().await;
    let proof = fixture.prove(&fixture.prepare().await).await;
    assert_eq!(proof["visibleVaultIds"], json!([SELECTED]));
    invoke_value(
        &fixture.destination.runtime.native_authority(),
        json!({"type":"completeIndependentRevalidation", "reply":proof}),
    )
    .await
    .unwrap();
    assert!(fixture.session().await == before);
    let next = fixture.prepare().await;
    assert_eq!(
        next["purpose"]["excludedVaultIds"],
        json!([REMAINING, SELECTED])
    );
    fixture
        .source_http
        .missing_memberships
        .lock()
        .unwrap()
        .clear();
    let proof = fixture.prove(&next).await;
    invoke_value(
        &fixture.destination.runtime.native_authority(),
        json!({"type":"completeIndependentRevalidation", "reply":proof}),
    )
    .await
    .unwrap();
    assert!(fixture.session().await == before);
    fixture
        .destination
        .runtime
        .bootstrap_account(&AccountId::from("account-1"), RequestCancellation::new())
        .await
        .unwrap();
    accept_login(
        &fixture.destination.runtime,
        &AccountId::from("account-1"),
        REMAINING,
    )
    .await;
    assert_eq!(
        projected_vaults(&fixture.destination.runtime, &AccountId::from("account-1")),
        vec![REMAINING.to_owned()]
    );
    let next = fixture.prepare().await;
    assert_eq!(next["purpose"]["excludedVaultIds"], json!([SELECTED]));
    fixture.close().await;
}

#[tokio::test]
async fn independent_revalidation_refuses_a_borrowed_grant() {
    let fixture = IndependentFixture::new(&[SELECTED]).await;
    let account = AccountId::from("account-1");
    let source_control = fixture.source.runtime.native_authority();
    let destination_control = fixture.destination.runtime.native_authority();
    let challenge = destination_control
        .prepare_import(&fixture.channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    assert!(fixture
        .destination
        .runtime
        .native_authority
        .has_borrowed_session(&account));
    assert!(invoke_value(&destination_control, json!({"type":"prepareIndependentRevalidation", "channelId":fixture.channel, "sourceAccount":account})).await.is_err());
    assert!(fixture
        .destination
        .runtime
        .native_authority
        .has_borrowed_session(&account));
    assert_eq!(
        fixture.destination.runtime.account_access_state(&account),
        Some(AccountAccessState::Unlocked)
    );
    fixture.close().await;
}

#[tokio::test]
async fn independent_revalidation_refuses_an_exclusion_transcript_that_exceeds_the_opaque_frame() {
    let (source, source_http) = travel_owner("frame-source", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("frame-independent", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "frame-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "frame-consumer-port".into())
        .await
        .unwrap();
    let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
    let mut near_limit = None;
    for cut in 0..16 {
        *source_http.policy.lock().unwrap() = TravelModeResponse {
            enabled: true,
            enabled_at: Some("2023-11-14T22:13:20Z".into()),
            hidden_vault_ids: (cut * 100..(cut + 1) * 100)
                .map(|id| format!("{id:036}"))
                .collect(),
            updated_at: format!("2023-11-14T22:13:{:02}Z", 20 + cut),
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
        destination_control
            .apply_authority(
                &channel,
                source_control.source_snapshot(&source_channel).unwrap(),
            )
            .await
            .unwrap();
        source_control
            .acknowledge_restrictions(
                destination_control
                    .restriction_acknowledgement(&channel)
                    .unwrap(),
            )
            .unwrap();
        if cut == 14 {
            near_limit = Some(invoke_value(&destination_control, json!({"type":"prepareIndependentRevalidation", "channelId":channel, "sourceAccount":account})).await.unwrap());
        }
    }
    let near_limit = near_limit.unwrap();
    assert_eq!(
        near_limit["challenge"]["purpose"]["excludedVaultIds"]
            .as_array()
            .unwrap()
            .len(),
        1_500
    );
    let before = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let session = destination
        .runtime
        .platform_storage
        .load_current_session(&account, &Incarnation::from("generation-1"))
        .await
        .unwrap()
        .unwrap();
    let oversized = invoke_value(&destination_control, json!({"type":"prepareIndependentRevalidation", "channelId":channel, "sourceAccount":account})).await;
    let after = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let current_session = destination
        .runtime
        .platform_storage
        .load_current_session(&account, &Incarnation::from("generation-1"))
        .await
        .unwrap()
        .unwrap();
    let access = destination.runtime.account_access_state(&account);
    source.runtime.close().await;
    destination.runtime.close().await;
    driver.await.unwrap();
    assert!(
        oversized.is_err(),
        "preparation must include escaped challenge and envelope overhead in the actual 64KiB native request bound"
    );
    assert_eq!(before, after);
    assert!(session == current_session);
    assert_eq!(access, Some(AccountAccessState::Unlocked));
}

#[tokio::test]
async fn independent_revalidation_refuses_source_encoding_and_completion_after_proof_expiry() {
    let source_clock = Arc::new(NativeClock(std::sync::atomic::AtomicU64::new(NOW_MS)));
    let destination_clock = Arc::new(NativeClock(std::sync::atomic::AtomicU64::new(NOW_MS)));
    let fixture = IndependentFixture::with_clocks(
        &[SELECTED],
        source_clock.clone(),
        destination_clock.clone(),
    )
    .await;
    let challenge: crate::NativeImportChallenge =
        serde_json::from_value(fixture.prepare().await).unwrap();
    let reply = fixture
        .source_attachment
        .revalidate_independent_restrictions(challenge)
        .await
        .unwrap();
    let expiry = reply.source_session_expires_at_ms;
    assert!(expiry > NOW_MS);
    let response = crate::NativeAuthorityResponse::IndependentRestrictionsRevalidated { reply };
    let encoded = fixture
        .source_attachment
        .encode_response(&response)
        .unwrap();
    let proof: Value = serde_json::from_str(&encoded).unwrap();
    source_clock.0.store(expiry, Ordering::SeqCst);
    assert!(
        fixture
            .source_attachment
            .encode_response(&response)
            .is_err(),
        "held nonsecret response must recheck source Session expiry at encoding"
    );
    let session = fixture.session().await;
    destination_clock.0.store(expiry, Ordering::SeqCst);
    assert!(invoke_value(
        &fixture.destination.runtime.native_authority(),
        json!({"type":"completeIndependentRevalidation", "reply":proof["reply"]})
    )
    .await
    .is_err());
    assert!(fixture.session().await == session);
    assert_eq!(
        fixture
            .destination
            .runtime
            .account_access_state(&AccountId::from("account-1")),
        Some(AccountAccessState::Unlocked)
    );
    fixture.close().await;
}

#[tokio::test]
async fn independent_revalidation_refuses_when_its_own_session_expires_during_fresh_verification() {
    let clock = Arc::new(NativeClock(std::sync::atomic::AtomicU64::new(NOW_MS)));
    let fixture =
        IndependentFixture::with_clocks(&[SELECTED], Arc::new(FixedClock(NOW_MS)), clock.clone())
            .await;
    // The existing CurrentSession storage primitive supplies a near-expiry retained Session.
    // Revalidation must preserve these exact bytes and cannot renew them through the fresh GET.
    let mut session = fixture.session().await;
    session.expires_at_ms = NOW_MS + 10;
    session.server_expires_at_ms = Some(NOW_MS + 10);
    fixture
        .destination
        .runtime
        .platform_storage
        .store_current_session(&session)
        .await
        .unwrap();
    let proof = fixture.prove(&fixture.prepare().await).await;
    assert!(
        proof["sourceSessionExpiresAtMs"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            > session.expires_at_ms
    );
    let gate = Arc::new(NativeSettingsGate {
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
    });
    *fixture.destination_http.policy_read_gate.lock().unwrap() = Some(gate.clone());
    let runtime = fixture.destination.runtime.clone();
    let complete = tokio::spawn(async move {
        invoke_value(
            &runtime.native_authority(),
            json!({"type":"completeIndependentRevalidation", "reply":proof}),
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    clock.0.store(session.expires_at_ms, Ordering::SeqCst);
    fixture
        .destination_http
        .policy_read_gate
        .lock()
        .unwrap()
        .take();
    gate.release.add_permits(1);
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), complete)
        .await
        .unwrap()
        .unwrap();
    assert!(
        result.is_err(),
        "a current source proof cannot renew the consumer's expired Session"
    );
    assert!(fixture.session().await == session);
    assert_eq!(
        fixture
            .destination
            .runtime
            .account_access_state(&AccountId::from("account-1")),
        Some(AccountAccessState::Unlocked)
    );
    let stored = fixture
        .destination
        .runtime
        .replica
        .load_uncached(&AccountId::from("account-1"))
        .await
        .unwrap()
        .unwrap();
    assert!(stored.bootstrap.vaults.keys().all(|(_, id)| id != SELECTED));
    fixture.close().await;
}
