//! Connected Travel acts on the consumer Replica without retiring its unaffected Account access.
use super::*;
#[path = "native_independent_revalidation_tests.rs"]
mod independent_revalidation;
#[path = "native_authority_replay_tests.rs"]
mod replay;
use crate::{
    replica::AuthorityVaultRecord,
    test_fixtures::{personal_vault, TEST_MASTER_UNLOCK_KEY},
};

const SELECTED: &str = "native-travel-selected";
const REMAINING: &str = "native-travel-remaining";

struct MembershipHttp {
    vaults: Vec<AuthorityVaultRecord>,
    missing_memberships: Mutex<HashSet<String>>,
    policy_read_gate: Mutex<Option<Arc<NativeSettingsGate>>>,
    policy: Mutex<TravelModeResponse>,
    settings_gate: Mutex<Option<Arc<NativeSettingsGate>>>,
}

#[async_trait]
impl crate::http_transport::SerializedHttpExecutor for MembershipHttp {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<String, RuntimeError> {
        let request: Value = serde_json::from_str(&request).unwrap();
        let url = request["url"].as_str().unwrap_or_default();
        if url.ends_with("/travel-mode/hidden-vaults") {
            assert_eq!(request["method"], "PUT");
            let gate = self
                .settings_gate
                .lock()
                .unwrap()
                .clone()
                .expect("scripted native settings request");
            gate.entered.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
            return Ok(routing_completed(
                200,
                serde_json::to_value(&*self.policy.lock().unwrap()).unwrap(),
            ));
        }
        let body = if url.contains("/sync/bootstrap") && url.contains("phase=vaults") {
            json!({
                "phase":"vaults", "vaults":self.vaults.iter().filter(|vault| !self.missing_memberships.lock().unwrap().contains(&vault.id)).collect::<Vec<_>>(), "hasMore":false,
                "nextCursor":null, "syncCursor":{"id":"native-travel-start"}
            })
        } else if url.contains("/sync/bootstrap") && url.contains("phase=items") {
            json!({
                "phase":"items", "items":[], "hasMore":false,
                "nextCursor":null, "syncCursor":{"id":"native-travel-start"}
            })
        } else if url.contains("/sync/changes") {
            json!({
                "events":[], "cursor":{"id":"native-travel-start"},
                "hasMore":false, "requiresFullRefresh":false
            })
        } else if url.ends_with("/travel-mode") {
            let gate = self.policy_read_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.entered.add_permits(1);
                gate.release.acquire().await.unwrap().forget();
            }
            serde_json::to_value(&*self.policy.lock().unwrap()).unwrap()
        } else {
            return Ok(json!({"type":"networkFailure"}).to_string());
        };
        Ok(routing_completed(200, body))
    }

    fn cancel(&self, _: &str) {}
}

async fn travel_owner(token: &str, platform: ClientPlatform) -> (SqliteOwner, Arc<MembershipHttp>) {
    travel_owner_with_clock(token, platform, Arc::new(FixedClock(NOW_MS))).await
}

async fn travel_owner_with_clock(
    token: &str,
    platform: ClientPlatform,
    clock: Arc<dyn Clock>,
) -> (SqliteOwner, Arc<MembershipHttp>) {
    let vaults: Vec<_> = [SELECTED, REMAINING]
        .into_iter()
        .map(|id| personal_vault(id, "user-1"))
        .collect();
    let http = Arc::new(MembershipHttp {
        vaults: vaults.clone(),
        missing_memberships: Mutex::default(),
        policy_read_gate: Mutex::default(),
        settings_gate: Mutex::new(None),
        policy: Mutex::new(TravelModeResponse {
            enabled: false,
            enabled_at: None,
            hidden_vault_ids: Vec::new(),
            updated_at: "2023-11-14T22:13:20Z".into(),
        }),
    });
    let owner = empty_sqlite_owner(platform, http.clone(), clock).await;
    let mut authentication = verified_with_derived_muk();
    authentication.master_unlock_key = Zeroizing::new(TEST_MASTER_UNLOCK_KEY);
    authentication.token = Zeroizing::new(token.to_owned());
    authentication.travel_mode = TravelModeResponse {
        enabled: false,
        enabled_at: None,
        hidden_vault_ids: Vec::new(),
        updated_at: "2023-11-14T22:13:20Z".into(),
    };
    authentication.vault_keys = vaults
        .into_iter()
        .map(|vault| AuthVaultKeyResponse {
            encrypted_vault_key: vault.encrypted_vault_key,
            role: VaultRole::Owner,
            vault_icon: None,
            vault_id: vault.id,
            vault_image_url: None,
            vault_name: vault.name,
            vault_type: VaultType::Personal,
        })
        .collect();
    owner
        .runtime
        .install_verified_authentication_with(
            authentication,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .unwrap();
    owner
        .runtime
        .bootstrap_account(&AccountId::from("account-1"), RequestCancellation::new())
        .await
        .unwrap();
    (owner, http)
}

#[tokio::test]
async fn legacy_wrapped_keys_use_current_visible_membership_and_exact_account() {
    let (owner, http) = travel_owner("local-wrapped-keys", ClientPlatform::Desktop).await;
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "wrapped-key-port".into())
        .unwrap();
    let encoded = source
        .encode_legacy_vault_keys("account-1", Some("wrapped-1"))
        .unwrap();
    let frame: Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(frame["protocolVersion"], 1);
    assert_eq!(frame["requestId"], "wrapped-1");
    assert_eq!(frame["type"], "DESKTOP_VAULT_KEYS");
    assert_eq!(frame["accountId"], "account-1");
    assert!(frame["email"]
        .as_str()
        .is_some_and(|email| !email.is_empty()));
    let keys: Value = serde_json::from_str(frame["vaultKeys"].as_str().unwrap()).unwrap();
    let keys = keys.as_array().unwrap();
    assert_eq!(keys.len(), 2);
    for key in keys {
        let authority = http
            .vaults
            .iter()
            .find(|vault| key["vaultId"] == vault.id)
            .expect("only current Bootstrap Vaults may be returned");
        assert_eq!(key["vaultId"], authority.id);
        assert_eq!(key["vaultName"], authority.name);
        assert_eq!(key["vaultType"], "personal");
        assert_eq!(key["role"], "owner");
        assert!(key["vaultIcon"].is_null());
        assert!(key["vaultImageUrl"].is_null());
        assert!(key["encryptedVaultKey"].as_str() == Some(authority.encrypted_vault_key.as_str()));
    }
    assert!(source
        .encode_legacy_vault_keys("account-other", None)
        .is_err());
    source.close();
    owner.runtime.close().await;
}

#[tokio::test]
async fn legacy_wrapped_key_formatter_preserves_team_role_and_optional_metadata() {
    let (owner, _) = travel_owner("team-key-metadata", ClientPlatform::Desktop).await;
    // This is a formatter fixture over one current Bootstrap row. Actual Server shared-member
    // authority is a separate acceptance case and is not implied by this local conversion test.
    let mut snapshot = owner
        .runtime
        .require_snapshot(&AccountId::from("account-1"))
        .unwrap();
    let generation = snapshot.bootstrap.active_generation.clone().unwrap();
    let selected = snapshot
        .bootstrap
        .vaults
        .get_mut(&(generation, SELECTED.to_owned()))
        .unwrap();
    selected.vault_type = AuthorityVaultType::Team;
    selected.role = AuthorityVaultRole::ReadOnly;
    selected.icon = Some("team-icon".into());
    selected.image_url = Some("https://native-legacy.invalid/team.png".into());
    let (encoded, _) =
        crate::runtime::native_authority::encode_visible_wrapped_keys(&owner.runtime, &snapshot)
            .unwrap();
    let keys: Value = serde_json::from_str(&encoded).unwrap();
    let selected = keys
        .as_array()
        .unwrap()
        .iter()
        .find(|key| key["vaultId"] == SELECTED)
        .unwrap();
    assert_eq!(selected["vaultType"], "team");
    assert_eq!(selected["role"], "read-only");
    assert_eq!(selected["vaultIcon"], "team-icon");
    assert_eq!(
        selected["vaultImageUrl"],
        "https://native-legacy.invalid/team.png"
    );
    owner.runtime.close().await;
}

#[tokio::test]
async fn legacy_wrapped_keys_hide_selected_vault_and_retire_on_lock() {
    let (owner, http) = travel_owner("local-hidden-keys", ClientPlatform::Desktop).await;
    let account = AccountId::from("account-1");
    let source = owner
        .runtime
        .native_authority()
        .attach_source_scoped("allowed-extension".into(), "hidden-key-port".into())
        .unwrap();
    hide_source(&owner, &http, &account).await;
    let encoded = source.encode_legacy_vault_keys("account-1", None).unwrap();
    let frame: Value = serde_json::from_str(&encoded).unwrap();
    assert!(frame.get("requestId").is_none());
    let keys: Value = serde_json::from_str(frame["vaultKeys"].as_str().unwrap()).unwrap();
    let keys = keys.as_array().unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0]["vaultId"], REMAINING);
    owner
        .runtime
        .request(
            RuntimeRequest::Lock {
                account_id: account,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(source.encode_legacy_vault_keys("account-1", None).is_err());
    source.close();
    owner.runtime.close().await;
}

#[tokio::test]
async fn held_legacy_wrapped_keys_refuse_peer_eof_before_final_encoding() {
    let (owner, _) = travel_owner("held-wrapped-keys", ClientPlatform::Desktop).await;
    let source = Arc::new(
        owner
            .runtime
            .native_authority()
            .attach_source_scoped("allowed-extension".into(), "held-key-port".into())
            .unwrap(),
    );
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let release_rx = Arc::new(Mutex::new(release_rx));
    owner
        .runtime
        .foreground_attachments
        .set_before_finalization_admission_hook(Some(Arc::new(move || {
            entered_tx.send(()).unwrap();
            release_rx.lock().unwrap().recv().unwrap();
        })));
    let pending_source = source.clone();
    let pending = tokio::task::spawn_blocking(move || {
        pending_source.encode_legacy_vault_keys("account-1", Some("held-keys"))
    });
    tokio::task::spawn_blocking(move || {
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("wrapped-key read must reach final encoding");
    })
    .await
    .unwrap();
    source.close();
    release_tx.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    owner.runtime.close().await;
}

async fn accept_login(runtime: &Runtime, account: &AccountId, vault: &str) -> String {
    let draft = serde_json::from_value(json!({
        "category":"login", "data":{"title":vault,"username":"user","password":"secret"}
    }))
    .unwrap();
    let RuntimeResponse::Accepted { operation_id, .. } = runtime
        .request(
            RuntimeRequest::CreateItem {
                account_id: account.clone(),
                vault_id: vault.into(),
                draft,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("local Login was not accepted");
    };
    operation_id
}

fn projected_vaults(runtime: &Arc<Runtime>, account: &AccountId) -> Vec<String> {
    let sink = Arc::new(Sink::default());
    let observer = runtime
        .observe(
            ObservationRequest::Items {
                account_id: account.clone(),
            },
            sink.clone(),
        )
        .unwrap();
    let values = sink.0.lock().unwrap();
    let Some(RuntimeProjection::Items(items)) = values.last() else {
        panic!("Items observation expected");
    };
    let vaults = items
        .items
        .iter()
        .map(|item| item.vault_id.clone())
        .collect();
    drop(values);
    observer.close();
    vaults
}

fn assert_accepted_operation_unchanged(
    original: &crate::replica::OperationRecord,
    current: &crate::replica::OperationRecord,
) {
    // Exhaustive destructuring makes any added durable field require an explicit decision.
    // Only diagnostic scheduling may advance while the existing dispatcher retries offline.
    let crate::replica::OperationRecord {
        operation_id,
        kind,
        target,
        request,
        request_fingerprint,
        accepted_item_category,
        attachment_move_recovery,
        create_vault,
        update_vault,
        scheduling,
        legacy_admission,
    } = original;
    assert_eq!(
        (
            &current.operation_id,
            &current.kind,
            &current.target,
            &current.request,
            &current.request_fingerprint,
            &current.accepted_item_category,
            &current.attachment_move_recovery,
            &current.create_vault,
            &current.update_vault,
            &current.legacy_admission,
        ),
        (
            operation_id,
            kind,
            target,
            request,
            request_fingerprint,
            accepted_item_category,
            attachment_move_recovery,
            create_vault,
            update_vault,
            legacy_admission,
        ),
        "selective retirement preserves every immutable accepted Operation field",
    );
    assert!(current.scheduling.attempt_count >= scheduling.attempt_count);
    if current.scheduling.attempt_count > scheduling.attempt_count {
        assert!(
            current.scheduling.not_before_ms > NOW_MS,
            "an observed offline dispatch attempt retains its future retry schedule",
        );
    } else {
        assert_eq!(current.scheduling, *scheduling);
    }
}

#[tokio::test]
async fn connected_verified_travel_hide_preserves_visible_vault_and_borrowed_account_authority() {
    let (source, source_http) = travel_owner("desktop-S2", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("independent-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let selected_operation = accept_login(&destination.runtime, &account, SELECTED).await;
    let remaining_operation = accept_login(&destination.runtime, &account, REMAINING).await;
    let accepted = destination
        .runtime
        .require_snapshot(&account)
        .unwrap()
        .operations;
    assert!(accepted
        .iter()
        .any(|operation| operation.operation_id == selected_operation));
    assert!(accepted
        .iter()
        .any(|operation| operation.operation_id == remaining_operation));
    assert_eq!(projected_vaults(&destination.runtime, &account).len(), 2);

    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let authority = source_control
        .attach_source("allowed-extension".into(), "travel-source-port".into())
        .unwrap();
    let source_channel = authority.channel_id.clone();
    let channel = destination_control
        .attach_desktop(authority, "travel-destination-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    assert_eq!(projected_vaults(&destination.runtime, &account).len(), 2);
    assert_eq!(
        destination.runtime.account_access_state(&account),
        Some(AccountAccessState::Unlocked)
    );

    hide_source(&source, &source_http, &account).await;
    let changed = source_control.source_snapshot(&source_channel).unwrap();
    native_control(
        &destination_control,
        crate::NativeAuthorityRequest::ApplyAuthority {
            channel_id: channel.clone(),
            source: changed,
        },
    )
    .await;

    let crate::NativeAuthorityResponse::RestrictionAcknowledgement { acknowledgement } =
        native_control(
            &destination_control,
            crate::NativeAuthorityRequest::RestrictionAcknowledgement {
                channel_id: channel.clone(),
            },
        )
        .await
    else {
        panic!("native adoption acknowledgement expected");
    };
    assert!(acknowledgement.frontier > 0);
    native_control(
        &source_control,
        crate::NativeAuthorityRequest::AcknowledgeRestrictions { acknowledgement },
    )
    .await;
    assert!(source_control
        .source_snapshot(&source_channel)
        .unwrap()
        .restrictions
        .is_empty());
    let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
    wait_selected_cleanup(&destination, &account, &incarnation).await;

    assert_eq!(
        destination.runtime.account_access_state(&account),
        Some(AccountAccessState::Unlocked),
        "selective Desktop hide must retain the consumer Account and unrelated Vault access"
    );
    assert_eq!(
        projected_vaults(&destination.runtime, &account),
        vec![REMAINING.to_owned()]
    );
    let snapshot = destination.runtime.require_snapshot(&account).unwrap();
    assert_eq!(snapshot.operations.len(), accepted.len());
    for original in &accepted {
        let current = snapshot
            .operations
            .iter()
            .find(|operation| operation.operation_id == original.operation_id)
            .expect("the original accepted Operation ID remains present");
        assert_accepted_operation_unchanged(original, current);
    }
    assert!(snapshot
        .bootstrap
        .vaults
        .keys()
        .all(|(_, vault)| vault != SELECTED));
    let borrowed = destination
        .runtime
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        borrowed.provenance,
        crate::platform_storage::SessionProvenance::Borrowed { .. }
    ));
    assert!(borrowed
        .vault_keys
        .iter()
        .all(|key| key.vault_id != SELECTED));
    assert!(borrowed
        .vault_keys
        .iter()
        .any(|key| key.vault_id == REMAINING));
    let independent = destination
        .runtime
        .platform_storage
        .load_current_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        independent.provenance,
        crate::platform_storage::SessionProvenance::Independent
    ));
    assert!(independent
        .vault_keys
        .iter()
        .all(|key| key.vault_id != SELECTED));
    assert!(independent
        .vault_keys
        .iter()
        .any(|key| key.vault_id == REMAINING));
    accept_login(&destination.runtime, &account, REMAINING).await;

    source.runtime.close().await;
    destination.runtime.close().await;
    driver.await.unwrap();
    let reopened = reopen_sqlite_owner(&destination).await;
    assert_eq!(
        reopened.account_access_state(&account),
        Some(AccountAccessState::Locked)
    );
    let restored = reopened.require_snapshot(&account).unwrap();
    for original in &accepted {
        let current = restored
            .operations
            .iter()
            .find(|operation| operation.operation_id == original.operation_id)
            .expect("reopen retains the original accepted Operation ID");
        assert_accepted_operation_unchanged(original, current);
    }
    assert!(restored
        .bootstrap
        .vaults
        .keys()
        .all(|(_, vault)| vault != SELECTED));
    reopened.close().await;
}

async fn hide_source(source: &SqliteOwner, http: &MembershipHttp, account: &AccountId) {
    *http.policy.lock().unwrap() = TravelModeResponse {
        enabled: true,
        enabled_at: Some("2023-11-14T22:13:20Z".into()),
        hidden_vault_ids: vec![SELECTED.into()],
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
}

async fn wait_selected_cleanup(
    owner: &SqliteOwner,
    account: &AccountId,
    incarnation: &Incarnation,
) {
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let snapshot = owner.runtime.require_snapshot(account).unwrap();
            let stored = owner
                .runtime
                .platform_storage
                .load_current_session(account, incarnation)
                .await
                .unwrap()
                .unwrap();
            let effective = owner
                .runtime
                .effective_session(account, incarnation)
                .await
                .unwrap()
                .unwrap();
            if snapshot.bootstrap.pending_vault_retirements.is_empty()
                && stored.vault_keys.iter().all(|key| key.vault_id != SELECTED)
                && effective
                    .vault_keys
                    .iter()
                    .all(|key| key.vault_id != SELECTED)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("existing retirement dispatcher must complete physical Session cleanup");
}

#[tokio::test]
async fn native_attachment_after_completed_hide_retires_independent_vault_without_borrowing_credentials(
) {
    let (source, source_http) = travel_owner("desktop-S2", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("independent-S1", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    accept_login(&destination.runtime, &account, SELECTED).await;
    accept_login(&destination.runtime, &account, REMAINING).await;
    hide_source(&source, &source_http, &account).await;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let source_snapshot = source_control
        .attach_source("allowed-extension".into(), "baseline-source-port".into())
        .unwrap();
    assert!(
        !source_snapshot.restrictions.is_empty(),
        "source attachment must capture already enforced retirements"
    );
    let channel = destination_control
        .attach_desktop(source_snapshot, "baseline-destination-port".into())
        .await
        .unwrap();
    assert_eq!(
        destination.runtime.account_access_state(&account),
        Some(AccountAccessState::Unlocked)
    );
    assert_eq!(
        projected_vaults(&destination.runtime, &account),
        vec![REMAINING.to_owned()]
    );
    let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
    wait_selected_cleanup(&destination, &account, &incarnation).await;
    let session = destination
        .runtime
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        session.provenance,
        crate::platform_storage::SessionProvenance::Independent
    ));
    assert_eq!(session.token.as_ref(), "independent-S1");
    assert!(!destination
        .runtime
        .native_authority
        .has_borrowed_session(&account));
    let crate::NativeAuthorityResponse::RestrictionAcknowledgement { acknowledgement } =
        native_control(
            &destination_control,
            crate::NativeAuthorityRequest::RestrictionAcknowledgement {
                channel_id: channel,
            },
        )
        .await
    else {
        panic!("native adoption acknowledgement expected");
    };
    native_control(
        &source_control,
        crate::NativeAuthorityRequest::AcknowledgeRestrictions { acknowledgement },
    )
    .await;
    source.runtime.close().await;
    destination.runtime.close().await;
    driver.await.unwrap();
}

// Fixture-only OS threads expose a real cross-thread host callback; no Runtime scheduler changes.

async fn install_second_travel_account(owner: &SqliteOwner, token: &str) {
    let mut authentication = verified_with_derived_muk();
    authentication.normalized_server_url = "https://second-native-travel.test".into();
    authentication.master_unlock_key = Zeroizing::new(TEST_MASTER_UNLOCK_KEY);
    authentication.token = Zeroizing::new(token.into());
    authentication.travel_mode = TravelModeResponse {
        enabled: false,
        enabled_at: None,
        hidden_vault_ids: Vec::new(),
        updated_at: "2023-11-14T22:13:20Z".into(),
    };
    authentication.vault_keys = [SELECTED, REMAINING]
        .into_iter()
        .map(|id| {
            let vault = personal_vault(id, "user-1");
            AuthVaultKeyResponse {
                encrypted_vault_key: vault.encrypted_vault_key,
                role: VaultRole::Owner,
                vault_icon: None,
                vault_id: vault.id,
                vault_image_url: None,
                vault_name: vault.name,
                vault_type: VaultType::Personal,
            }
        })
        .collect();
    owner
        .runtime
        .install_verified_authentication_with(
            authentication,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["account-2", "generation-2"]),
        )
        .await
        .unwrap();
    owner
        .runtime
        .bootstrap_account(&AccountId::from("account-2"), RequestCancellation::new())
        .await
        .unwrap();
}

struct HeldNativeItems {
    started: std::sync::atomic::AtomicBool,
    entered: std::sync::mpsc::SyncSender<()>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
}

impl ObservationSink for HeldNativeItems {
    fn publish(&self, projection: RuntimeProjection) {
        assert!(matches!(projection, RuntimeProjection::Items(_)));
        if self.started.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        self.entered.send(()).unwrap();
        // Dropping the fixture sender also releases this callback during assertion unwinding.
        let _ = self.release.lock().unwrap().recv();
    }
}

#[tokio::test]
async fn held_account_delivery_does_not_block_other_native_restriction_adoption() {
    let (source, source_http) = travel_owner("source-one", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("consumer-one", ClientPlatform::Extension).await;
    install_second_travel_account(&source, "source-two").await;
    install_second_travel_account(&destination, "consumer-two").await;
    let first = AccountId::from("account-1");
    let second = AccountId::from("account-2");
    for account in [&first, &second] {
        accept_login(&destination.runtime, account, SELECTED).await;
        accept_login(&destination.runtime, account, REMAINING).await;
    }
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let source_snapshot = source_control
        .attach_source("allowed-extension".into(), "held-source-port".into())
        .unwrap();
    let source_channel = source_snapshot.channel_id.clone();
    let channel = destination_control
        .attach_desktop(source_snapshot, "held-consumer-port".into())
        .await
        .unwrap();
    for account in [&first, &second] {
        let challenge = destination_control
            .prepare_import(&channel, account, account)
            .await
            .unwrap();
        destination_control
            .complete_import(source_control.export(challenge).await.unwrap())
            .await
            .unwrap();
    }

    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let observed_runtime = destination.runtime.clone();
    let observed_account = first.clone();
    let observer = std::thread::spawn(move || {
        let handle = observed_runtime
            .observe(
                ObservationRequest::Items {
                    account_id: observed_account,
                },
                Arc::new(HeldNativeItems {
                    started: std::sync::atomic::AtomicBool::new(false),
                    entered: entered_tx,
                    release: Mutex::new(release_rx),
                }),
            )
            .unwrap();
        handle.close();
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("Account A host callback began");

    hide_source(&source, &source_http, &first).await;
    hide_source(&source, &source_http, &second).await;
    let snapshot = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(snapshot.restrictions.len(), 2);
    assert_eq!(snapshot.restrictions[0].source.account_id, first);
    assert_eq!(snapshot.restrictions[1].source.account_id, second);
    let applying_control = destination.runtime.native_authority();
    let apply_channel = channel.clone();
    let apply = std::thread::spawn(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                native_control(
                    &applying_control,
                    crate::NativeAuthorityRequest::ApplyAuthority {
                        channel_id: apply_channel,
                        source: snapshot,
                    },
                )
                .await
            })
    });

    // No destination dispatcher is running: the actual ApplyAuthority adoption futures must
    // independently commit B's journal while A still owns its copied public Items delivery.
    let progressed = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let physical = destination
                .runtime
                .replica
                .load_uncached(&second)
                .await
                .unwrap()
                .unwrap();
            if physical
                .bootstrap
                .pending_vault_retirements
                .iter()
                .any(|id| id == SELECTED)
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok();
    if progressed {
        assert_eq!(
            projected_vaults(&destination.runtime, &second),
            vec![REMAINING.to_owned()]
        );
        accept_login(&destination.runtime, &second, REMAINING).await;
    }
    // Release and reap before the expected RED assertion; never strand a test worker on failure.
    drop(release_tx);
    observer.join().unwrap();
    let applied = apply.join().unwrap();
    assert!(matches!(applied, crate::NativeAuthorityResponse::Applied));
    source.runtime.close().await;
    destination.runtime.close().await;
    assert!(
        progressed,
        "Account B must durably adopt its native restriction while Account A delivery is held"
    );
}

#[derive(Default)]
struct OverlapExportSink {
    frames: Mutex<Vec<RuntimeProjection>>,
    controls: Mutex<Vec<crate::ObservationControl>>,
}

impl ObservationSink for OverlapExportSink {
    fn publish(&self, projection: RuntimeProjection) {
        self.frames.lock().unwrap().push(projection);
    }

    fn control(&self, control: crate::ObservationControl) {
        self.controls.lock().unwrap().push(control);
    }
}

#[tokio::test]
async fn native_restriction_adopts_existing_local_journal_before_export_cleanup() {
    let (source, source_http) = travel_owner("overlap-source", ClientPlatform::Desktop).await;
    let (destination, destination_http) =
        travel_owner("overlap-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    accept_login(&destination.runtime, &account, SELECTED).await;
    accept_login(&destination.runtime, &account, REMAINING).await;
    let accepted = destination
        .runtime
        .require_snapshot(&account)
        .unwrap()
        .operations;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "overlap-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "overlap-consumer-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();

    let sink = Arc::new(OverlapExportSink::default());
    let export = destination
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: account.clone(),
                vault_ids: vec![SELECTED.into()],
            },
            sink.clone(),
        )
        .unwrap();
    assert!(matches!(
        sink.frames.lock().unwrap().as_slice(),
        [RuntimeProjection::VaultExport(_)]
    ));
    *destination_http.policy.lock().unwrap() = TravelModeResponse {
        enabled: true,
        enabled_at: Some("2023-11-14T22:13:20Z".into()),
        hidden_vault_ids: vec![SELECTED.into()],
        updated_at: "2023-11-14T22:13:20Z".into(),
    };
    let refresh_runtime = destination.runtime.clone();
    let refresh_account = account.clone();
    let refresh = tokio::spawn(async move {
        refresh_runtime
            .request(
                RuntimeRequest::RefreshTravelMode {
                    account_id: refresh_account,
                },
                RequestCancellation::new(),
            )
            .await
    });
    let original_journal = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let stored = destination
                .runtime
                .replica
                .load_uncached(&account)
                .await
                .unwrap()
                .unwrap();
            if stored
                .bootstrap
                .pending_vault_retirements
                .contains(&SELECTED.to_owned())
            {
                break stored;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("public local Refresh adopts the physical journal before Export cleanup");
    assert!(!refresh.is_finished());
    assert_eq!(sink.controls.lock().unwrap().len(), 1);
    refresh.abort();
    assert!(refresh.await.unwrap_err().is_cancelled());

    hide_source(&source, &source_http, &account).await;
    let changed = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(changed.restrictions.len(), 1);
    let apply_request = crate::NativeAuthorityRequest::ApplyAuthority {
        channel_id: channel.clone(),
        source: changed.clone(),
    };
    let mut apply = Box::pin(destination_control.invoke(Zeroizing::new(
        serde_json::to_string(&apply_request).unwrap(),
    )));
    // Ownership acknowledgement cannot wait for the host's physical plaintext disposal.
    let early = tokio::time::timeout(std::time::Duration::from_secs(2), &mut apply).await;
    let completed_before_cleanup = early.is_ok();
    let early_success = matches!(&early, Ok(Ok(_)));
    let access_before_cleanup = destination.runtime.account_access_state(&account);
    let retained = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let visible_before_cleanup = if early_success {
        Some(projected_vaults(&destination.runtime, &account))
    } else {
        None
    };
    let acknowledgement = if early_success {
        let crate::NativeAuthorityResponse::RestrictionAcknowledgement { acknowledgement } =
            native_control(
                &destination_control,
                crate::NativeAuthorityRequest::RestrictionAcknowledgement {
                    channel_id: channel.clone(),
                },
            )
            .await
        else {
            panic!("native adoption acknowledgement expected")
        };
        Some(acknowledgement)
    } else {
        None
    };

    // Reap even the expected RED's hard-retirement wait before making its failing assertion.
    sink.frames.lock().unwrap().clear();
    export.close();
    let applied = match early {
        Ok(result) => result,
        Err(_) => tokio::time::timeout(std::time::Duration::from_secs(5), apply)
            .await
            .expect("native Apply finishes after host cleanup"),
    };
    let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
    let cleanup_completed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let stored = destination
                .runtime
                .replica
                .load_uncached(&account)
                .await
                .unwrap()
                .unwrap();
            if stored.bootstrap.pending_vault_retirements.is_empty() {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    // Freeze ordinary retry scheduling before comparing the replay's physical snapshot.
    driver.abort();
    let _ = driver.await;
    let mut replay_preserved = false;
    if let Some(acknowledgement) = &acknowledgement {
        let before_replay = destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .unwrap()
            .unwrap();
        native_control(&destination_control, apply_request).await;
        let crate::NativeAuthorityResponse::RestrictionAcknowledgement {
            acknowledgement: replayed,
        } = native_control(
            &destination_control,
            crate::NativeAuthorityRequest::RestrictionAcknowledgement {
                channel_id: channel.clone(),
            },
        )
        .await
        else {
            panic!("replayed acknowledgement expected")
        };
        let after_replay = destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .unwrap()
            .unwrap();
        replay_preserved = &replayed == acknowledgement && before_replay == after_replay;
        native_control(
            &source_control,
            crate::NativeAuthorityRequest::AcknowledgeRestrictions {
                acknowledgement: replayed,
            },
        )
        .await;
    }
    let after = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    source.runtime.close().await;
    destination.runtime.close().await;

    assert!(
        completed_before_cleanup && applied.is_ok(),
        "native overlap must adopt the existing journal before the held Export acknowledges cleanup"
    );
    assert_eq!(access_before_cleanup, Some(AccountAccessState::Unlocked));
    assert_eq!(visible_before_cleanup, Some(vec![REMAINING.to_owned()]));
    assert_eq!(
        retained, original_journal,
        "overlap cannot replace or rewrite the existing durable duty"
    );
    assert!(acknowledgement.is_some_and(|ack| ack.frontier == changed.restriction_frontier));
    assert!(
        cleanup_completed && replay_preserved,
        "cleanup and lost-ACK replay preserve exact adoption"
    );
    assert_eq!(sink.controls.lock().unwrap().len(), 1);
    for original in &accepted {
        let current = after
            .operations
            .iter()
            .find(|operation| operation.operation_id == original.operation_id)
            .unwrap();
        assert_accepted_operation_unchanged(original, current);
    }
}

async fn overlap_acknowledgement(
    control: &crate::NativeAuthorityFacade,
    channel: &str,
) -> Result<crate::NativeRestrictionAcknowledgement, RuntimeError> {
    let response = control
        .invoke(Zeroizing::new(
            serde_json::to_string(&crate::NativeAuthorityRequest::RestrictionAcknowledgement {
                channel_id: channel.to_owned(),
            })
            .unwrap(),
        ))
        .await?;
    let response: crate::NativeAuthorityResponse = serde_json::from_str(&response).unwrap();
    let crate::NativeAuthorityResponse::RestrictionAcknowledgement { acknowledgement } = response
    else {
        panic!("native restriction acknowledgement expected")
    };
    Ok(acknowledgement)
}

#[tokio::test]
async fn native_overlap_waits_for_original_journal_but_not_its_export_cleanup() {
    let (source, source_http) = travel_owner("prejournal-source", ClientPlatform::Desktop).await;
    let (destination, destination_http) =
        travel_owner("prejournal-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    accept_login(&destination.runtime, &account, SELECTED).await;
    accept_login(&destination.runtime, &account, REMAINING).await;
    let accepted = destination
        .runtime
        .require_snapshot(&account)
        .unwrap()
        .operations;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "prejournal-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "prejournal-consumer-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    let before_ack = overlap_acknowledgement(&destination_control, &channel)
        .await
        .unwrap();

    let selected_sink = Arc::new(OverlapExportSink::default());
    let unrelated_sink = Arc::new(OverlapExportSink::default());
    let selected_export = destination
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: account.clone(),
                vault_ids: vec![SELECTED.into()],
            },
            selected_sink.clone(),
        )
        .unwrap();
    let unrelated_export = destination
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: account.clone(),
                vault_ids: vec![REMAINING.into()],
            },
            unrelated_sink.clone(),
        )
        .unwrap();
    assert_eq!(selected_sink.frames.lock().unwrap().len(), 1);
    assert_eq!(unrelated_sink.frames.lock().unwrap().len(), 1);
    let metadata = Pause::new(PersistenceStep::Metadata);
    destination.platform.pause_at(metadata.clone());
    *destination_http.policy.lock().unwrap() = TravelModeResponse {
        enabled: true,
        enabled_at: Some("2023-11-14T22:13:20Z".into()),
        hidden_vault_ids: vec![SELECTED.into()],
        updated_at: "2023-11-14T22:13:20Z".into(),
    };
    let refresh_runtime = destination.runtime.clone();
    let refresh_account = account.clone();
    let refresh = tokio::spawn(async move {
        refresh_runtime
            .request(
                RuntimeRequest::RefreshTravelMode {
                    account_id: refresh_account,
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        metadata.wait_until_reached(),
    )
    .await
    .expect("original selected policy reaches its actual metadata acknowledgement");
    let unjournaled = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    assert!(unjournaled.bootstrap.pending_vault_retirements.is_empty());
    assert_eq!(selected_sink.controls.lock().unwrap().len(), 1);
    assert!(unrelated_sink.controls.lock().unwrap().is_empty());

    hide_source(&source, &source_http, &account).await;
    let changed = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(changed.restrictions.len(), 1);
    let mut apply = Box::pin(
        destination_control.invoke(Zeroizing::new(
            serde_json::to_string(&crate::NativeAuthorityRequest::ApplyAuthority {
                channel_id: channel.clone(),
                source: changed.clone(),
            })
            .unwrap(),
        )),
    );
    let mut apply_result = tokio::time::timeout(std::time::Duration::from_millis(250), &mut apply)
        .await
        .ok();
    let pending_before_journal = apply_result.is_none();
    let access_before_journal = destination.runtime.account_access_state(&account);
    let unrelated_retired_before_journal = !unrelated_sink.controls.lock().unwrap().is_empty();
    let ack_before_journal = overlap_acknowledgement(&destination_control, &channel)
        .await
        .ok();
    let physical_before_journal = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();

    // The original caller, not native adoption, must turn its captured policy into durable ownership.
    metadata.release();
    if apply_result.is_none() {
        apply_result = tokio::time::timeout(std::time::Duration::from_secs(2), &mut apply)
            .await
            .ok();
    }
    let adopted_before_cleanup = matches!(&apply_result, Some(Ok(_)));
    let journal_before_cleanup = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let ack_before_cleanup = overlap_acknowledgement(&destination_control, &channel)
        .await
        .ok();
    let original_caller_still_waiting = !refresh.is_finished();
    let unrelated_retired_before_cleanup = !unrelated_sink.controls.lock().unwrap().is_empty();

    // Both the expected hard-retirement RED and the corrected original cleanup are reaped first.
    selected_sink.frames.lock().unwrap().clear();
    unrelated_sink.frames.lock().unwrap().clear();
    selected_export.close();
    unrelated_export.close();
    if apply_result.is_none() {
        apply_result = Some(
            tokio::time::timeout(std::time::Duration::from_secs(5), apply)
                .await
                .expect("native overlap finishes after both host disposal acknowledgements"),
        );
    }
    let refreshed = tokio::time::timeout(std::time::Duration::from_secs(5), refresh)
        .await
        .expect("original Refresh finishes after host cleanup")
        .unwrap();
    let after = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    source.runtime.close().await;
    destination.runtime.close().await;

    assert_eq!(
        access_before_journal,
        Some(AccountAccessState::Unlocked),
        "an overlapping unjournaled local proof must not retire the borrowed Account"
    );
    assert!(
        !unrelated_retired_before_journal && !unrelated_retired_before_cleanup,
        "pending verification preserves the already-delivered unrelated Export loan"
    );
    assert!(
        pending_before_journal
            && physical_before_journal
                .bootstrap
                .pending_vault_retirements
                .is_empty()
    );
    assert_eq!(
        ack_before_journal,
        Some(before_ack),
        "native cannot acknowledge an unjournaled proof"
    );
    assert!(
        adopted_before_cleanup && original_caller_still_waiting,
        "native adoption must follow original journal ownership without waiting for its Export cleanup or Account execution"
    );
    assert!(journal_before_cleanup
        .bootstrap
        .pending_vault_retirements
        .contains(&SELECTED.to_owned()));
    assert!(ack_before_cleanup.is_some_and(|ack| ack.frontier == changed.restriction_frontier));
    assert!(matches!(apply_result, Some(Ok(_))) && refreshed.is_ok());
    assert!(after.bootstrap.pending_vault_retirements.is_empty());
    assert_eq!(selected_sink.controls.lock().unwrap().len(), 1);
    for original in &accepted {
        let current = after
            .operations
            .iter()
            .find(|operation| operation.operation_id == original.operation_id)
            .unwrap();
        assert_accepted_operation_unchanged(original, current);
    }
}
#[tokio::test]
async fn native_prejournal_wait_is_cancelled_by_its_channel_or_runtime_loss() {
    for runtime_loss in [false, true] {
        let (source, source_http) =
            travel_owner("prejournal-source", ClientPlatform::Desktop).await;
        let (destination, destination_http) =
            travel_owner("prejournal-consumer", ClientPlatform::Extension).await;
        let account = AccountId::from("account-1");
        accept_login(&destination.runtime, &account, SELECTED).await;
        accept_login(&destination.runtime, &account, REMAINING).await;
        let accepted = destination
            .runtime
            .require_snapshot(&account)
            .unwrap()
            .operations;
        let source_control = source.runtime.native_authority();
        let destination_control = destination.runtime.native_authority();
        let initial = source_control
            .attach_source("allowed-extension".into(), "prejournal-source-port".into())
            .unwrap();
        let source_channel = initial.channel_id.clone();
        let channel = destination_control
            .attach_desktop(initial, "prejournal-consumer-port".into())
            .await
            .unwrap();
        let challenge = destination_control
            .prepare_import(&channel, &account, &account)
            .await
            .unwrap();
        destination_control
            .complete_import(source_control.export(challenge).await.unwrap())
            .await
            .unwrap();

        let selected_sink = Arc::new(OverlapExportSink::default());
        let unrelated_sink = Arc::new(OverlapExportSink::default());
        let selected_export = destination
            .runtime
            .observe(
                ObservationRequest::VaultExport {
                    account_id: account.clone(),
                    vault_ids: vec![SELECTED.into()],
                },
                selected_sink.clone(),
            )
            .unwrap();
        let unrelated_export = destination
            .runtime
            .observe(
                ObservationRequest::VaultExport {
                    account_id: account.clone(),
                    vault_ids: vec![REMAINING.into()],
                },
                unrelated_sink.clone(),
            )
            .unwrap();
        assert_eq!(selected_sink.frames.lock().unwrap().len(), 1);
        assert_eq!(unrelated_sink.frames.lock().unwrap().len(), 1);
        let metadata = Pause::new(PersistenceStep::Metadata);
        destination.platform.pause_at(metadata.clone());
        *destination_http.policy.lock().unwrap() = TravelModeResponse {
            enabled: true,
            enabled_at: Some("2023-11-14T22:13:20Z".into()),
            hidden_vault_ids: vec![SELECTED.into()],
            updated_at: "2023-11-14T22:13:20Z".into(),
        };
        let refresh_runtime = destination.runtime.clone();
        let refresh_account = account.clone();
        let refresh = tokio::spawn(async move {
            refresh_runtime
                .request(
                    RuntimeRequest::RefreshTravelMode {
                        account_id: refresh_account,
                    },
                    RequestCancellation::new(),
                )
                .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            metadata.wait_until_reached(),
        )
        .await
        .expect("original selected policy reaches its actual metadata acknowledgement");
        let unjournaled = destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .unwrap()
            .unwrap();
        assert!(unjournaled.bootstrap.pending_vault_retirements.is_empty());
        assert_eq!(selected_sink.controls.lock().unwrap().len(), 1);
        assert!(unrelated_sink.controls.lock().unwrap().is_empty());

        hide_source(&source, &source_http, &account).await;
        let changed = source_control.source_snapshot(&source_channel).unwrap();
        assert_eq!(changed.restrictions.len(), 1);
        let mut apply = Box::pin(
            destination_control.invoke(Zeroizing::new(
                serde_json::to_string(&crate::NativeAuthorityRequest::ApplyAuthority {
                    channel_id: channel.clone(),
                    source: changed.clone(),
                })
                .unwrap(),
            )),
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut apply)
                .await
                .is_err(),
            "native adoption waits for the original unjournaled local proof"
        );
        let retiring_runtime = destination.runtime.clone();
        let retiring_channel = channel.clone();
        let teardown = tokio::spawn(async move {
            if runtime_loss {
                retiring_runtime.close().await;
                Ok(())
            } else {
                retiring_runtime
                    .native_authority()
                    .invoke(Zeroizing::new(
                        serde_json::to_string(&crate::NativeAuthorityRequest::RetireChannel {
                            channel_id: retiring_channel,
                        })
                        .unwrap(),
                    ))
                    .await
                    .map(|_| ())
            }
        });
        let cancelled = tokio::time::timeout(std::time::Duration::from_secs(2), &mut apply).await;
        let cancelled_before_cleanup = matches!(&cancelled, Ok(Err(_)));
        let no_live_ack = overlap_acknowledgement(&destination_control, &channel)
            .await
            .is_err();
        let original_journal_absent = destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .unwrap()
            .unwrap()
            .bootstrap
            .pending_vault_retirements
            .is_empty();
        let cleanup_still_waiting = !teardown.is_finished();

        metadata.release();
        selected_sink.frames.lock().unwrap().clear();
        unrelated_sink.frames.lock().unwrap().clear();
        selected_export.close();
        unrelated_export.close();
        if cancelled.is_err() {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), apply).await;
        }
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), refresh)
            .await
            .expect("original Refresh releases after metadata and host disposal")
            .unwrap();
        let teardown_result = tokio::time::timeout(std::time::Duration::from_secs(5), teardown)
            .await
            .expect("native lifecycle drains after host disposal")
            .unwrap();
        let mut live_duty_completed = true;
        if !runtime_loss {
            // Live port loss cannot erase the Runtime's already-observed local proof. Its existing
            // dispatcher owns cleanup while locked; no new native authority or password is supplied.
            let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
            live_duty_completed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                loop {
                    let stored = destination
                        .runtime
                        .replica
                        .load_uncached(&account)
                        .await
                        .unwrap()
                        .unwrap();
                    if stored.bootstrap.pending_vault_retirements.is_empty()
                        && stored
                            .bootstrap
                            .vaults
                            .keys()
                            .all(|(_, vault)| vault != SELECTED)
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .is_ok();
            let after = destination
                .runtime
                .replica
                .load_uncached(&account)
                .await
                .unwrap()
                .unwrap();
            for original in &accepted {
                let current = after
                    .operations
                    .iter()
                    .find(|operation| operation.operation_id == original.operation_id)
                    .unwrap();
                assert_accepted_operation_unchanged(original, current);
            }
            destination.runtime.close().await;
            driver.await.unwrap();
        }
        source.runtime.close().await;
        assert!(
            cancelled_before_cleanup && no_live_ack && original_journal_absent,
            "exact channel/Runtime loss cancels only its native wait before journal ownership or host cleanup"
        );
        assert!(cleanup_still_waiting && teardown_result.is_ok());
        assert!(
            live_duty_completed,
            "live channel loss conserves the original local cleanup duty"
        );
        // Actual Runtime loss before journal commit has no durable-ownership or erasure guarantee.
    }
}
#[tokio::test]
async fn native_mixed_restriction_preserves_old_proof_and_fences_new_scope_before_waiting() {
    let (source, source_http) = travel_owner("prejournal-source", ClientPlatform::Desktop).await;
    let (destination, destination_http) =
        travel_owner("prejournal-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    accept_login(&destination.runtime, &account, SELECTED).await;
    accept_login(&destination.runtime, &account, REMAINING).await;
    let accepted = destination
        .runtime
        .require_snapshot(&account)
        .unwrap()
        .operations;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "prejournal-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "prejournal-consumer-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    let before_ack = overlap_acknowledgement(&destination_control, &channel)
        .await
        .unwrap();

    let selected_sink = Arc::new(OverlapExportSink::default());
    let unrelated_sink = Arc::new(OverlapExportSink::default());
    let selected_export = destination
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: account.clone(),
                vault_ids: vec![SELECTED.into()],
            },
            selected_sink.clone(),
        )
        .unwrap();
    let unrelated_export = destination
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: account.clone(),
                vault_ids: vec![REMAINING.into()],
            },
            unrelated_sink.clone(),
        )
        .unwrap();
    assert_eq!(selected_sink.frames.lock().unwrap().len(), 1);
    assert_eq!(unrelated_sink.frames.lock().unwrap().len(), 1);
    let metadata = Pause::new(PersistenceStep::Metadata);
    destination.platform.pause_at(metadata.clone());
    *destination_http.policy.lock().unwrap() = TravelModeResponse {
        enabled: true,
        enabled_at: Some("2023-11-14T22:13:20Z".into()),
        hidden_vault_ids: vec![SELECTED.into()],
        updated_at: "2023-11-14T22:13:20Z".into(),
    };
    let refresh_runtime = destination.runtime.clone();
    let refresh_account = account.clone();
    let refresh = tokio::spawn(async move {
        refresh_runtime
            .request(
                RuntimeRequest::RefreshTravelMode {
                    account_id: refresh_account,
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        metadata.wait_until_reached(),
    )
    .await
    .expect("original selected policy reaches its actual metadata acknowledgement");
    let unjournaled = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    assert!(unjournaled.bootstrap.pending_vault_retirements.is_empty());
    assert_eq!(selected_sink.controls.lock().unwrap().len(), 1);
    assert!(unrelated_sink.controls.lock().unwrap().is_empty());

    *source_http.policy.lock().unwrap() = TravelModeResponse {
        enabled: true,
        enabled_at: Some("2023-11-14T22:13:20Z".into()),
        hidden_vault_ids: vec![SELECTED.into(), REMAINING.into()],
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
    let changed = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(changed.restrictions.len(), 1);
    let mut apply = Box::pin(
        destination_control.invoke(Zeroizing::new(
            serde_json::to_string(&crate::NativeAuthorityRequest::ApplyAuthority {
                channel_id: channel.clone(),
                source: changed.clone(),
            })
            .unwrap(),
        )),
    );
    let mut apply_result = tokio::time::timeout(std::time::Duration::from_millis(250), &mut apply)
        .await
        .ok();
    let account_before_journal = destination.runtime.account_access_state(&account);
    let new_scope_retired_before_wait = unrelated_sink.controls.lock().unwrap().len() == 1;
    let ack_before_journal = overlap_acknowledgement(&destination_control, &channel)
        .await
        .ok();
    let before_journal = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();

    metadata.release();
    let original_journal = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let stored = destination
                .runtime
                .replica
                .load_uncached(&account)
                .await
                .unwrap()
                .unwrap();
            if stored
                .bootstrap
                .pending_vault_retirements
                .contains(&SELECTED.to_owned())
                || refresh.is_finished()
            {
                break stored;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("original policy either adopts its selected journal or reports the old failure");
    let original_still_owns_cleanup = !refresh.is_finished();
    // Release Account execution without pretending that the original Export disposed its data.
    refresh.abort();
    let _ = refresh.await;
    if apply_result.is_none() {
        apply_result = tokio::time::timeout(std::time::Duration::from_secs(2), &mut apply)
            .await
            .ok();
    }
    let adopted_before_cleanup = matches!(&apply_result, Some(Ok(_)));
    let both_journals = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let ack_before_cleanup = overlap_acknowledgement(&destination_control, &channel)
        .await
        .ok();
    let retained_policy = destination
        .runtime
        .platform_storage
        .load_account_metadata(&account, &both_journals.incarnation)
        .await
        .unwrap()
        .unwrap()
        .verified_travel_mode;

    selected_sink.frames.lock().unwrap().clear();
    unrelated_sink.frames.lock().unwrap().clear();
    selected_export.close();
    unrelated_export.close();
    if apply_result.is_none() {
        apply_result = Some(
            tokio::time::timeout(std::time::Duration::from_secs(5), apply)
                .await
                .expect("mixed native Apply releases after both host cleanup acknowledgements"),
        );
    }
    let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
    let cleanup_completed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let stored = destination
                .runtime
                .replica
                .load_uncached(&account)
                .await
                .unwrap()
                .unwrap();
            if stored.bootstrap.pending_vault_retirements.is_empty()
                && stored
                    .bootstrap
                    .vaults
                    .keys()
                    .all(|(_, id)| id != SELECTED && id != REMAINING)
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .is_ok();
    let after = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    source.runtime.close().await;
    destination.runtime.close().await;
    driver.await.unwrap();

    assert_eq!(
        account_before_journal,
        Some(AccountAccessState::Unlocked),
        "a mixed source restriction conserves the borrowed Account and original local proof"
    );
    assert!(
        new_scope_retired_before_wait,
        "the previously visible selected scope is fenced before waiting for old metadata"
    );
    assert!(before_journal
        .bootstrap
        .pending_vault_retirements
        .is_empty());
    assert_eq!(
        ack_before_journal,
        Some(before_ack),
        "neither a partial nor an unjournaled batch may be acknowledged"
    );
    assert!(
        original_still_owns_cleanup
            && original_journal
                .bootstrap
                .pending_vault_retirements
                .contains(&SELECTED.to_owned())
    );
    assert!(adopted_before_cleanup && matches!(apply_result, Some(Ok(_))));
    assert!([SELECTED, REMAINING].iter().all(|id| {
        both_journals
            .bootstrap
            .pending_vault_retirements
            .contains(&(*id).to_owned())
    }));
    assert!(ack_before_cleanup.is_some_and(|ack| ack.frontier == changed.restriction_frontier));
    assert!(
        retained_policy
            .is_some_and(|policy| policy.enabled && policy.hidden_vault_ids == [SELECTED]),
        "native restriction evidence does not replace the consumer's independently verified policy"
    );
    assert!(cleanup_completed);
    assert_eq!(selected_sink.controls.lock().unwrap().len(), 1);
    assert_eq!(unrelated_sink.controls.lock().unwrap().len(), 1);
    for original in &accepted {
        let current = after
            .operations
            .iter()
            .find(|operation| operation.operation_id == original.operation_id)
            .unwrap();
        assert_accepted_operation_unchanged(original, current);
    }
}

struct NativeStageSessionReadGate {
    inner: Arc<InstallationPlatform>,
    runtime: Mutex<std::sync::Weak<Runtime>>,
    entered: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
    armed: AtomicBool,
}

#[async_trait]
impl crate::platform_storage::SerializedPlatformStorageExecutor for NativeStageSessionReadGate {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        let selected_already_fenced =
            self.runtime
                .lock()
                .unwrap()
                .upgrade()
                .is_some_and(|runtime| {
                    [SELECTED, REMAINING].iter().all(|id| {
                        runtime.foreground_attachments.is_vault_fenced(
                            &AccountId::from("account-1"),
                            &Incarnation::from("generation-1"),
                            id,
                        )
                    })
                });
        if value["type"] == "get"
            && value["key"]
                .as_str()
                .is_some_and(|key| key.ends_with(":current-session"))
            && selected_already_fenced
            && self.armed.swap(false, Ordering::SeqCst)
        {
            self.entered.add_permits(1);
            self.release.acquire().await.unwrap().forget();
        }
        self.inner.invoke(request).await
    }
}

async fn travel_owner_with_stage_gate(
    token: &str,
    platform: ClientPlatform,
) -> (
    SqliteOwner,
    Arc<MembershipHttp>,
    Arc<NativeStageSessionReadGate>,
) {
    let vaults: Vec<_> = [SELECTED, REMAINING]
        .into_iter()
        .map(|id| personal_vault(id, "user-1"))
        .collect();
    let http = Arc::new(MembershipHttp {
        vaults: vaults.clone(),
        missing_memberships: Mutex::default(),
        policy_read_gate: Mutex::default(),
        settings_gate: Mutex::new(None),
        policy: Mutex::new(TravelModeResponse {
            enabled: false,
            enabled_at: None,
            hidden_vault_ids: Vec::new(),
            updated_at: "2023-11-14T22:13:20Z".into(),
        }),
    });
    let path = std::env::temp_dir().join(format!(
        "bittery-native-stage-{}.sqlite",
        bittery_crypto_core::generate_uuid()
    ));
    let storage = Arc::new(InstallationPlatform::default());
    let gate = Arc::new(NativeStageSessionReadGate {
        inner: storage.clone(),
        runtime: Mutex::new(std::sync::Weak::new()),
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
        armed: AtomicBool::new(false),
    });
    let runtime = Runtime::with_persistence(
        Arc::new(crate::SqliteReplica::open(&path).unwrap()),
        Arc::new(PlatformStorage::for_platform(gate.clone(), platform)),
        Arc::new(HttpTransport::new(http.clone())),
        Some(AuthClientConfig::new("native-test".into(), platform, "test".into()).unwrap()),
        None,
        false,
        Arc::new(FixedClock(NOW_MS)),
        Arc::new(SystemDeviceTimer),
        None,
    );
    *gate.runtime.lock().unwrap() = Arc::downgrade(&runtime);
    runtime.open().await.unwrap();
    let owner = SqliteOwner {
        runtime,
        platform: storage,
        path,
    };
    let mut authentication = verified_with_derived_muk();
    authentication.master_unlock_key = Zeroizing::new(TEST_MASTER_UNLOCK_KEY);
    authentication.token = Zeroizing::new(token.to_owned());
    authentication.travel_mode = TravelModeResponse {
        enabled: false,
        enabled_at: None,
        hidden_vault_ids: Vec::new(),
        updated_at: "2023-11-14T22:13:20Z".into(),
    };
    authentication.vault_keys = vaults
        .into_iter()
        .map(|vault| AuthVaultKeyResponse {
            encrypted_vault_key: vault.encrypted_vault_key,
            role: VaultRole::Owner,
            vault_icon: None,
            vault_id: vault.id,
            vault_image_url: None,
            vault_name: vault.name,
            vault_type: VaultType::Personal,
        })
        .collect();
    owner
        .runtime
        .install_verified_authentication_with(
            authentication,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["account-1", "generation-1"]),
        )
        .await
        .unwrap();
    owner
        .runtime
        .bootstrap_account(&AccountId::from("account-1"), RequestCancellation::new())
        .await
        .unwrap();
    (owner, http, gate)
}

#[tokio::test]
async fn native_complete_stage_omission_and_verified_selection_share_selective_continuity() {
    use crate::replica::{
        BeginBootstrapPlan, BootstrapContinuation, BootstrapGenerationId, BootstrapGuard,
        BootstrapPageCursor, BootstrapPageIdentity, Sha256Fingerprint, StageBootstrapPagePlan,
        StageBootstrapPageResult, SyncCursor,
    };
    let (source, source_http, session_gate) =
        travel_owner_with_stage_gate("stage-source", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("stage-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    accept_login(&destination.runtime, &account, SELECTED).await;
    accept_login(&destination.runtime, &account, REMAINING).await;
    let accepted = destination
        .runtime
        .require_snapshot(&account)
        .unwrap()
        .operations;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "stage-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "stage-consumer-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();

    let mut source_exports = Vec::new();
    let mut consumer_exports = Vec::new();
    for id in [SELECTED, REMAINING] {
        let source_sink = Arc::new(OverlapExportSink::default());
        let source_handle = source
            .runtime
            .observe(
                ObservationRequest::VaultExport {
                    account_id: account.clone(),
                    vault_ids: vec![id.into()],
                },
                source_sink.clone(),
            )
            .unwrap();
        let consumer_sink = Arc::new(OverlapExportSink::default());
        let consumer_handle = destination
            .runtime
            .observe(
                ObservationRequest::VaultExport {
                    account_id: account.clone(),
                    vault_ids: vec![id.into()],
                },
                consumer_sink.clone(),
            )
            .unwrap();
        assert_eq!(source_sink.frames.lock().unwrap().len(), 1);
        assert_eq!(consumer_sink.frames.lock().unwrap().len(), 1);
        source_exports.push((source_handle, source_sink));
        consumer_exports.push((consumer_handle, consumer_sink));
    }
    let before = source.runtime.require_snapshot(&account).unwrap();
    let guard = |snapshot: &crate::replica::ReplicaSnapshot| BootstrapGuard {
        account_id: snapshot.account_id.clone(),
        user_id: snapshot.user_id.clone(),
        incarnation: snapshot.incarnation.clone(),
        expected_replica_revision: snapshot.revision,
        expected_lock_epoch: snapshot.lock_epoch,
    };
    let generation = BootstrapGenerationId("native-complete-stage".into());
    assert!(matches!(
        source
            .runtime
            .replica
            .begin_bootstrap(BeginBootstrapPlan {
                guard: guard(&before),
                generation_id: generation.clone(),
            })
            .await
            .unwrap(),
        crate::replica::PlanResult::Applied { .. }
    ));
    for (page_identity, request_cursor, vaults, fingerprint) in [
        (
            BootstrapPageIdentity::vaults(0),
            BootstrapPageCursor::VaultsInitial,
            vec![personal_vault(REMAINING, "user-1")],
            b"native-stage-vaults".as_slice(),
        ),
        (
            BootstrapPageIdentity::items(0),
            BootstrapPageCursor::ItemsInitial,
            Vec::new(),
            b"native-stage-items".as_slice(),
        ),
    ] {
        let current = source.runtime.require_snapshot(&account).unwrap();
        assert_eq!(
            source
                .runtime
                .replica
                .stage_bootstrap_page(StageBootstrapPagePlan {
                    guard: guard(&current),
                    generation_id: generation.clone(),
                    page_identity,
                    request_cursor,
                    raw_response_fingerprint: Sha256Fingerprint::of_bytes(fingerprint),
                    pinned_watermark: SyncCursor::CapturedValue {
                        id: "native-stage-watermark".into()
                    },
                    continuation: BootstrapContinuation::Final,
                    vault_key_version_included: false,
                    vaults,
                    items: Vec::new(),
                })
                .await
                .unwrap(),
            StageBootstrapPageResult::Applied
        );
    }
    let staged = source
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    assert!(staged.bootstrap.generations[&generation].final_page_staged);
    assert!(!staged.bootstrap.policy_verification_pending);
    assert_eq!(
        staged.bootstrap.active_cursor,
        before.bootstrap.active_cursor
    );
    session_gate.armed.store(true, Ordering::SeqCst);
    *source_http.policy.lock().unwrap() = TravelModeResponse {
        enabled: true,
        enabled_at: Some("2023-11-14T22:13:20Z".into()),
        hidden_vault_ids: vec![SELECTED.into(), REMAINING.into()],
        updated_at: "2023-11-14T22:13:20Z".into(),
    };
    let runtime = source.runtime.clone();
    let account_id = account.clone();
    let mut refresh = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::RefreshTravelMode { account_id },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        session_gate.entered.acquire(),
    )
    .await
    .expect("public Refresh reaches Session primitive after both source fences")
    .unwrap()
    .forget();
    assert!(source_exports
        .iter()
        .all(|(_, sink)| sink.controls.lock().unwrap().len() == 1));
    let held_source = source
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        held_source.bootstrap.staging_generation.as_ref(),
        Some(&generation)
    );
    assert!(held_source.bootstrap.pending_vault_retirements.is_empty());
    let changed = source_control.source_snapshot(&source_channel).unwrap();
    let mut apply = Box::pin(
        destination_control.invoke(Zeroizing::new(
            serde_json::to_string(&crate::NativeAuthorityRequest::ApplyAuthority {
                channel_id: channel.clone(),
                source: changed,
            })
            .unwrap(),
        )),
    );
    let mut outcome = tokio::time::timeout(std::time::Duration::from_millis(250), &mut apply)
        .await
        .ok();
    let both_consumer_controls = consumer_exports
        .iter()
        .all(|(_, sink)| sink.controls.lock().unwrap().len() == 1);
    let access = destination.runtime.account_access_state(&account);
    let adopted = matches!(&outcome, Some(Ok(_)));
    let physical = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let both_journaled = [SELECTED, REMAINING].iter().all(|id| {
        physical
            .bootstrap
            .pending_vault_retirements
            .iter()
            .any(|current| current == id)
    });
    // Reap every original hold before the expected missing-A assertion. No forced retirement
    // or disposal supplies the evidence sampled above.
    session_gate.release.add_permits(1);
    for (handle, sink) in source_exports.into_iter().chain(consumer_exports) {
        sink.frames.lock().unwrap().clear();
        handle.close();
    }
    if outcome.is_none() {
        outcome = tokio::time::timeout(std::time::Duration::from_secs(5), &mut apply)
            .await
            .ok();
    }
    drop(apply);
    let source_finished =
        tokio::time::timeout(std::time::Duration::from_secs(5), &mut refresh).await;
    if source_finished.is_err() {
        refresh.abort();
        let _ = refresh.await;
    }
    source.runtime.close().await;
    destination.runtime.close().await;
    assert!(
        matches!(source_finished, Ok(Ok(Ok(RuntimeResponse::TravelMode {
            result: crate::TravelModeCommandResult::Confirmed { policy, .. }, ..
        }))) if policy.enabled && policy.hidden_vault_ids == vec![SELECTED.to_owned(), REMAINING.to_owned()]),
        "source public caller confirms its exact selection after original host disposal"
    );
    assert!(
        outcome.is_some(),
        "consumer Apply is reaped after host disposal"
    );
    assert_eq!(access, Some(AccountAccessState::Unlocked));
    assert!(
        both_consumer_controls,
        "the authenticated native snapshot must carry the omitted-stage A restriction as well as policy-selected B"
    );
    assert!(
        adopted && both_journaled,
        "both exact selected duties are durably adopted before host Export disposal"
    );
    for original in &accepted {
        let current = physical
            .operations
            .iter()
            .find(|operation| operation.operation_id == original.operation_id)
            .unwrap();
        assert_accepted_operation_unchanged(original, current);
    }
    assert_eq!(physical.incarnation, incarnation);
}

#[tokio::test]
async fn retained_move_scope_error_preserves_selected_fence_notification_and_native_classification()
{
    let (source, http) = travel_owner("malformed-move-source", ClientPlatform::Desktop).await;
    let account = AccountId::from("account-1");
    let control = source.runtime.native_authority();
    let initial = control
        .attach_source("allowed-extension".into(), "malformed-move-port".into())
        .unwrap();
    let sink = Arc::new(OverlapExportSink::default());
    let export = source
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: account.clone(),
                vault_ids: vec![SELECTED.into()],
            },
            sink.clone(),
        )
        .unwrap();
    assert_eq!(sink.frames.lock().unwrap().len(), 1);
    // This is retained-store fixture data, not a new public Move. Current Replica validation
    // accepts its nonempty immutable bytes without an attachment recovery record. Positively
    // prove that at the physical persistence boundary before testing the later public error.
    let mut operation =
        crate::test_fixtures::test_operation("retained-malformed-move", "retained-move-item");
    operation.kind = crate::replica::OperationKind::MoveItem;
    operation.target = crate::replica::ResourceRef::Item {
        item_id: "retained-move-item".into(),
        vault_id: REMAINING.into(),
    };
    operation.request.body = b"{}".to_vec();
    operation.request.path = "/api/v1/items/retained-move-item/moves".into();
    operation.request.method = crate::HttpMethod::Post;
    operation.request_fingerprint =
        crate::replica::Sha256Fingerprint::of_bytes(&operation.request.body);
    operation.attachment_move_recovery = None;
    let before = source.runtime.require_snapshot(&account).unwrap();
    assert!(matches!(
        source
            .runtime
            .replica
            .execute_exact(GuardedCommitPlan::new(
                account.clone(),
                before.incarnation.clone(),
                before.revision,
                before.lock_epoch,
                vec![crate::replica::PlanMutation::AcceptOperation(
                    operation.clone()
                )],
            ))
            .await
            .unwrap(),
        crate::replica::PlanResult::Applied { .. }
    ));
    let loaded = source
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    assert!(loaded.operations.iter().any(|value| value == &operation));
    let original_error = operation.accepted_vault_ids().unwrap_err();
    *http.policy.lock().unwrap() = TravelModeResponse {
        enabled: true,
        enabled_at: Some("2023-11-14T22:13:20Z".into()),
        hidden_vault_ids: vec![SELECTED.into()],
        updated_at: "2023-11-14T22:13:20Z".into(),
    };
    let result = source
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await;
    let output_refused = export.begin_vault_export_output().is_err();
    let controls = sink.controls.lock().unwrap().len();
    let changed = control.source_snapshot(&initial.channel_id).unwrap();
    let classified = changed
        .restrictions
        .iter()
        .any(|batch| batch.vault_ids.iter().any(|id| id == SELECTED));
    let retained = source
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    sink.frames.lock().unwrap().clear();
    export.close();
    source.runtime.close().await;
    assert_eq!(
        result.unwrap_err(),
        original_error,
        "the original retained Move scope error remains exact"
    );
    assert!(
        output_refused,
        "the verified selected first fence already refuses output"
    );
    assert_eq!(
        controls, 1,
        "a projection-filter error after first fence must not lose its original Export retirement handoff"
    );
    assert!(
        classified,
        "the installed source fence must be classified before any snapshot can escape"
    );
    assert_eq!(
        retained.operations, loaded.operations,
        "error preserves exact retained evidence for existing recovery"
    );
    assert!(
        retained.bootstrap.pending_vault_retirements.is_empty(),
        "no journal or native adoption ACK is invented for the failed mutation"
    );
}

// Controlled HTTP boundary for public Save admission and completion.
struct NativeSettingsGate {
    entered: tokio::sync::Semaphore,
    release: tokio::sync::Semaphore,
}

#[tokio::test]
async fn native_pending_policy_episode_preserves_grant_but_pauses_fresh_consumer_admission() {
    let (source, source_http) = travel_owner("pending-source", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("pending-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    let original_operation = accept_login(&destination.runtime, &account, REMAINING).await;
    let original = destination
        .runtime
        .require_snapshot(&account)
        .unwrap()
        .operations;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "pending-source-port".into())
        .unwrap();
    let initial_generation = initial
        .accounts
        .iter()
        .find(|value| value.scope.account_id == account)
        .unwrap()
        .key_generation;
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "pending-consumer-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    let export_sink = Arc::new(OverlapExportSink::default());
    let export = destination
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: account.clone(),
                vault_ids: vec![REMAINING.into()],
            },
            export_sink.clone(),
        )
        .unwrap();
    assert_eq!(export_sink.frames.lock().unwrap().len(), 1);
    let gate = Arc::new(NativeSettingsGate {
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
    });
    *source_http.settings_gate.lock().unwrap() = Some(gate.clone());
    let runtime = source.runtime.clone();
    let account_id = account.clone();
    let mut save = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::SetTravelModeHiddenVaults {
                    account_id,
                    hidden_vault_ids: Vec::new(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    let travel_sink = Arc::new(OverlapExportSink::default());
    let items_sink = Arc::new(OverlapExportSink::default());
    let mut travel = None;
    let mut items = None;
    let mut output_lease = None;
    let work_cancellation = RequestCancellation::new();
    let mut stage = "source settings admission";
    // Every failure shares the release/disposal path below. In particular, a negative request
    // must not strand the original held HTTP exchange or turn a leaked Export loan into a hang.
    let pending = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        gate.entered.acquire().await.map_err(|_| "settings gate closed")?.forget();
        stage = "source public pending calibration";
        let pending_source = source.runtime.replica.load_uncached(&account).await
            .map_err(|_| "source snapshot failed")?.ok_or("source snapshot absent")?;
        travel = Some(source.runtime.observe(
            ObservationRequest::TravelMode { account_id: account.clone() },
            travel_sink.clone(),
        ).map_err(|_| "source Travel observation failed")?);
        let source_unverified = travel_sink.frames.lock().unwrap().iter().any(|frame| matches!(frame,
            RuntimeProjection::TravelMode(value) if value.account_id == account && value.enforcement == crate::TravelModeEnforcement::Unverified));
        let pending_snapshot = source_control.source_snapshot(&source_channel)
            .map_err(|_| "source authority snapshot failed")?;
        let generation_unchanged = pending_snapshot.accounts.iter()
            .find(|value| value.scope.account_id == account)
            .is_some_and(|value| value.key_generation == initial_generation);
        stage = "consumer ApplyAuthority";
        let pending_applied = destination_control.invoke(Zeroizing::new(
            serde_json::to_string(&crate::NativeAuthorityRequest::ApplyAuthority {
                channel_id: channel.clone(), source: pending_snapshot,
            }).unwrap(),
        )).await;
        stage = "consumer retained authority sample";
        let pending_destination = destination.runtime.replica.load_uncached(&account).await
            .map_err(|_| "consumer snapshot failed")?.ok_or("consumer snapshot absent")?;
        let access_while_pending = destination.runtime.account_access_state(&account);
        let prior_loan_retired = !export_sink.controls.lock().unwrap().is_empty();
        let prior_frame_retained = export_sink.frames.lock().unwrap().len() == 1;
        let effective = destination.runtime.effective_session(&account, &incarnation).await;
        let effective_retained = matches!(&effective, Ok(Some(_)));
        drop(effective);
        items = Some(destination.runtime.observe(
            ObservationRequest::Items { account_id: account.clone() }, items_sink.clone(),
        ));
        let subscription_retained = items.as_ref().is_some_and(Result::is_ok);
        let no_fresh_frame = items_sink.frames.lock().unwrap().is_empty();
        let output = export.begin_vault_export_output();
        let no_new_output = output.is_err();
        output_lease = output.ok();
        let trial = serde_json::from_value(json!({
            "category":"login", "data":{"title":"pending must refuse", "username":"user", "password":"secret"}
        })).unwrap();
        stage = "consumer new work admission";
        let new_work = destination.runtime.request(
            RuntimeRequest::CreateItem {
                account_id: account.clone(), vault_id: REMAINING.into(), draft: trial,
            }, work_cancellation.clone(),
        ).await;
        Ok::<_, &'static str>((pending_source.bootstrap.policy_verification_pending,
            source_unverified, generation_unchanged, pending_applied,
            pending_destination.bootstrap.policy_verification_pending, access_while_pending,
            prior_frame_retained, effective_retained, prior_loan_retired,
            subscription_retained, no_fresh_frame, no_new_output, new_work))
    }).await;
    work_cancellation.cancel();
    gate.release.add_permits(1);
    let saved = tokio::time::timeout(std::time::Duration::from_secs(5), &mut save).await;
    if saved.is_err() {
        save.abort();
        let _ = save.await;
    }
    let resolved = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let snapshot = source_control
            .source_snapshot(&source_channel)
            .map_err(|_| "resolved source snapshot failed")?;
        let applied = destination_control
            .invoke(Zeroizing::new(
                serde_json::to_string(&crate::NativeAuthorityRequest::ApplyAuthority {
                    channel_id: channel.clone(),
                    source: snapshot,
                })
                .unwrap(),
            ))
            .await;
        let fresh_frame = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if !items_sink.frames.lock().unwrap().is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok();
        let loan_remained_live = export_sink.controls.lock().unwrap().is_empty();
        let retained = destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .map_err(|_| "resolved consumer snapshot failed")?
            .ok_or("resolved consumer absent")?;
        Ok::<_, &'static str>((applied, fresh_frame, loan_remained_live, retained))
    })
    .await;
    // Dispose even a wrongly admitted output lease before Close can wait on it. Re-import is
    // intentionally a separate case: prepare_import retires the Session and drains this loan.
    export_sink.frames.lock().unwrap().clear();
    if let Some(lease) = output_lease {
        let _ = export.finish_vault_export_output(&lease);
    }
    export.close();
    items_sink.frames.lock().unwrap().clear();
    if let Some(Ok(handle)) = items {
        handle.close();
    }
    if let Some(handle) = travel {
        handle.close();
    }
    let closed = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(source.runtime.close(), destination.runtime.close())
    })
    .await;
    assert!(
        closed.is_ok(),
        "owners must close after every fixture hold is released"
    );
    let (
        source_pending,
        source_unverified,
        generation_unchanged,
        pending_applied,
        destination_pending,
        access_while_pending,
        prior_frame_retained,
        effective_retained,
        prior_loan_retired,
        subscription_retained,
        no_fresh_frame,
        no_new_output,
        new_work,
    ) = pending
        .unwrap_or_else(|_| panic!("bounded pending exercise stalled at {stage}"))
        .expect("pending public calibration");
    assert!(source_pending && source_unverified && generation_unchanged);
    assert!(pending_applied.is_ok());
    assert_eq!(access_while_pending, Some(AccountAccessState::Unlocked));
    assert!(prior_frame_retained && effective_retained && !prior_loan_retired);
    assert!(
        subscription_retained && no_fresh_frame,
        "source's unresolved episode must retain the consumer subscription silently, not expose fresh plaintext"
    );
    assert!(
        destination_pending,
        "native pending duty is durable before its admission is acknowledged"
    );
    assert!(
        new_work.is_err(),
        "fresh local work cannot bypass a connected source pending episode"
    );
    assert!(
        no_new_output,
        "new output admission shares the same pending gate"
    );
    assert!(matches!(saved, Ok(Ok(Ok(RuntimeResponse::TravelMode {
        result: crate::TravelModeCommandResult::Confirmed { policy, .. }, ..
    }))) if !policy.enabled && policy.hidden_vault_ids.is_empty()));
    let (resolved, fresh_frame, loan_remained_live, retained) = resolved
        .expect("bounded resolved authority delivery")
        .expect("resolved public calibration");
    assert!(resolved.is_ok() && fresh_frame && loan_remained_live);
    assert!(!retained.bootstrap.policy_verification_pending);
    assert_eq!(retained.operations.len(), original.len());
    let preserved = retained
        .operations
        .iter()
        .find(|operation| operation.operation_id == original_operation)
        .unwrap();
    assert_accepted_operation_unchanged(&original[0], preserved);
}

#[tokio::test]
async fn native_pending_refuses_fresh_import_without_replacing_the_existing_grant() {
    let (source, source_http) = travel_owner("reimport-source", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("reimport-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "reimport-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "reimport-consumer-port".into())
        .await
        .unwrap();
    let first = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(first).await.unwrap())
        .await
        .unwrap();
    let gate = Arc::new(NativeSettingsGate {
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
    });
    *source_http.settings_gate.lock().unwrap() = Some(gate.clone());
    let save_runtime = source.runtime.clone();
    let save_account = account.clone();
    let save = tokio::spawn(async move {
        save_runtime
            .request(
                RuntimeRequest::SetTravelModeHiddenVaults {
                    account_id: save_account,
                    hidden_vault_ids: Vec::new(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    let prepare_request = || {
        Zeroizing::new(
            serde_json::to_string(&crate::NativeAuthorityRequest::PrepareImportForSource {
                channel_id: channel.clone(),
                source_account: account.clone(),
                insecure_transport_confirmed: false,
            })
            .unwrap(),
        )
    };
    // No output loan is held here: preparation ordinarily retires the old Session, so a
    // wrong admission is observable as a changed Account and cannot hang on fixture disposal.
    let pending_prepare = destination_control.invoke(prepare_request()).await;
    let retained_access = destination.runtime.account_access_state(&account);
    let retained_session = destination
        .runtime
        .effective_session(&account, &Incarnation::from("generation-1"))
        .await
        .is_ok_and(|session| session.is_some());
    gate.release.add_permits(1);
    let saved = tokio::time::timeout(std::time::Duration::from_secs(5), save)
        .await
        .unwrap()
        .unwrap();
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    let fresh = destination_control.invoke(prepare_request()).await;
    let completed = if let Ok(encoded) = &fresh {
        let response: crate::NativeAuthorityResponse = serde_json::from_str(encoded).unwrap();
        let crate::NativeAuthorityResponse::Prepared { challenge } = response else {
            panic!("fresh challenge expected")
        };
        let reply = source_control.export(challenge).await.unwrap();
        destination_control.complete_import(reply).await
    } else {
        Err(RuntimeError::new(
            RuntimeErrorCode::AuthenticationRequired,
            "fresh preparation failed",
        ))
    };
    let final_access = destination.runtime.account_access_state(&account);
    source.runtime.close().await;
    destination.runtime.close().await;
    assert!(saved.is_ok());
    assert!(
        pending_prepare.is_err(),
        "source pending must refuse preparation before Session retirement"
    );
    assert_eq!(retained_access, Some(AccountAccessState::Unlocked));
    assert!(retained_session);
    assert!(
        fresh.is_ok() && completed.is_ok(),
        "matching verified control restores ordinary fresh import admission"
    );
    assert_eq!(final_access, Some(AccountAccessState::Unlocked));
}

#[tokio::test]
async fn native_channel_loss_retires_its_pending_admission_reason() {
    let (source, source_http) = travel_owner("lost-pending-source", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("lost-pending-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source(
            "allowed-extension".into(),
            "lost-pending-source-port".into(),
        )
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "lost-pending-consumer-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    let gate = Arc::new(NativeSettingsGate {
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
    });
    *source_http.settings_gate.lock().unwrap() = Some(gate.clone());
    let save_runtime = source.runtime.clone();
    let save_account = account.clone();
    let save = tokio::spawn(async move {
        save_runtime
            .request(
                RuntimeRequest::SetTravelModeHiddenVaults {
                    account_id: save_account,
                    hidden_vault_ids: Vec::new(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    let during = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let retired = destination_control
        .invoke(Zeroizing::new(
            serde_json::to_string(&crate::NativeAuthorityRequest::RetireChannel {
                channel_id: channel.clone(),
            })
            .unwrap(),
        ))
        .await;
    let after = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let access = destination.runtime.account_access_state(&account);
    gate.release.add_permits(1);
    let saved = tokio::time::timeout(std::time::Duration::from_secs(5), save)
        .await
        .unwrap()
        .unwrap();
    source.runtime.close().await;
    destination.runtime.close().await;
    assert!(during.bootstrap.policy_verification_pending && saved.is_ok());
    assert!(retired.is_ok());
    assert_eq!(access, Some(AccountAccessState::Locked));
    assert!(
        !after.bootstrap.policy_verification_pending,
        "the lost native source cannot leave an unresolved admission reason after its authority retires"
    );
}

async fn hold_native_settings(
    owner: &SqliteOwner,
    http: &Arc<MembershipHttp>,
) -> (
    Arc<NativeSettingsGate>,
    tokio::task::JoinHandle<Result<RuntimeResponse, RuntimeError>>,
) {
    let gate = Arc::new(NativeSettingsGate {
        entered: tokio::sync::Semaphore::new(0),
        release: tokio::sync::Semaphore::new(0),
    });
    *http.settings_gate.lock().unwrap() = Some(gate.clone());
    let runtime = owner.runtime.clone();
    let save = tokio::spawn(async move {
        runtime
            .request(
                RuntimeRequest::SetTravelModeHiddenVaults {
                    account_id: AccountId::from("account-1"),
                    hidden_vault_ids: Vec::new(),
                },
                RequestCancellation::new(),
            )
            .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    (gate, save)
}

#[tokio::test]
async fn native_and_server_verification_resolve_only_their_captured_episodes() {
    let (source, source_http) =
        travel_owner("overlap-pending-source", ClientPlatform::Desktop).await;
    let (destination, destination_http) =
        travel_owner("overlap-pending-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source(
            "allowed-extension".into(),
            "overlap-pending-source-port".into(),
        )
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "overlap-pending-consumer-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();

    // Abandon the actual admitted consumer PUT before any response. Its Server verification
    // duty is durable and must survive a later independent source verification.
    let (_consumer_gate, consumer_save) =
        hold_native_settings(&destination, &destination_http).await;
    consumer_save.abort();
    assert!(consumer_save.await.unwrap_err().is_cancelled());
    let server_pending = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let (first_gate, first_save) = hold_native_settings(&source, &source_http).await;
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    first_gate.release.add_permits(1);
    let first_saved = tokio::time::timeout(std::time::Duration::from_secs(5), first_save)
        .await
        .unwrap()
        .unwrap();
    let first_verified = source_control.source_snapshot(&source_channel).unwrap();
    destination_control
        .apply_authority(&channel, first_verified.clone())
        .await
        .unwrap();
    let after_native = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();

    // A successor source episode is independent of the still-pending consumer Server reason.
    let (second_gate, second_save) = hold_native_settings(&source, &source_http).await;
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    destination_http.policy.lock().unwrap().updated_at = "2023-11-14T22:13:21Z".into();
    let local_verified = destination
        .runtime
        .request(
            RuntimeRequest::RefreshTravelMode {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await;
    let after_server = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let old_verified = destination_control
        .apply_authority(&channel, first_verified)
        .await;
    let after_stale = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let items_sink = Arc::new(OverlapExportSink::default());
    let items = destination
        .runtime
        .observe(
            ObservationRequest::Items {
                account_id: account.clone(),
            },
            items_sink.clone(),
        )
        .unwrap();
    let silent_while_native_pending = items_sink.frames.lock().unwrap().is_empty();
    second_gate.release.add_permits(1);
    let second_saved = tokio::time::timeout(std::time::Duration::from_secs(5), second_save)
        .await
        .unwrap()
        .unwrap();
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    let after_both = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let fresh_items = !items_sink.frames.lock().unwrap().is_empty();
    let policy = destination
        .runtime
        .platform_storage
        .load_account_metadata(&account, &Incarnation::from("generation-1"))
        .await
        .unwrap()
        .unwrap()
        .verified_travel_mode
        .unwrap();
    items_sink.frames.lock().unwrap().clear();
    items.close();
    source.runtime.close().await;
    destination.runtime.close().await;
    assert!(server_pending.bootstrap.policy_verification_pending);
    assert!(first_saved.is_ok() && second_saved.is_ok());
    assert!(
        after_native.bootstrap.policy_verification_pending,
        "source Verified must preserve the consumer's unresolved Server episode"
    );
    assert!(matches!(
        local_verified,
        Ok(RuntimeResponse::TravelMode {
            result: crate::TravelModeCommandResult::Confirmed {
                enforcement: crate::TravelModeEnforcement::Unverified,
                ..
            },
            ..
        })
    ));
    assert!(
        after_server.bootstrap.policy_verification_pending,
        "fresh local GET cannot resolve the source's successor Pending episode"
    );
    assert!(old_verified.is_err() && after_stale.bootstrap.policy_verification_pending);
    assert!(silent_while_native_pending && fresh_items);
    assert!(!after_both.bootstrap.policy_verification_pending);
    assert_eq!(
        policy.server_updated_at_ms,
        Some(NOW_MS + 1_000),
        "native verification must not overwrite consumer current-policy evidence"
    );
}

#[tokio::test]
async fn coalesced_source_account_replacement_retires_the_old_borrowed_authority() {
    let (source, source_http) =
        travel_owner("replace-pending-source", ClientPlatform::Desktop).await;
    let (destination, _) =
        travel_owner("replace-pending-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    accept_login(&destination.runtime, &account, REMAINING).await;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "replace-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "replace-consumer-port".into())
        .await
        .unwrap();
    let challenge = destination_control
        .prepare_import(&channel, &account, &account)
        .await
        .unwrap();
    destination_control
        .complete_import(source_control.export(challenge).await.unwrap())
        .await
        .unwrap();
    let sink = Arc::new(OverlapExportSink::default());
    let export = destination
        .runtime
        .observe(
            ObservationRequest::VaultExport {
                account_id: account.clone(),
                vault_ids: vec![REMAINING.into()],
            },
            sink.clone(),
        )
        .unwrap();
    assert_eq!(sink.frames.lock().unwrap().len(), 1);
    // Use the authenticated installation owner to replace the same source Account. The
    // transport coalesces intermediate Lock; its next actual snapshot contains the successor.
    let mut authentication = verified_with_derived_muk();
    authentication.master_unlock_key = Zeroizing::new(TEST_MASTER_UNLOCK_KEY);
    authentication.token = Zeroizing::new("replacement-source-session".to_owned());
    authentication.travel_mode = source_http.policy.lock().unwrap().clone();
    authentication.vault_keys = source_http
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
    source
        .runtime
        .install_verified_authentication_with(
            authentication,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&["replacement-generation"]),
        )
        .await
        .unwrap();
    source
        .runtime
        .bootstrap_account(&account, RequestCancellation::new())
        .await
        .unwrap();
    let replacement = source_control.source_snapshot(&source_channel).unwrap();
    assert!(replacement
        .accounts
        .iter()
        .any(|authority| authority.scope.incarnation
            == Incarnation::from("replacement-generation")
            && authority.unlocked));
    let mut apply = Box::pin(
        destination_control.invoke(Zeroizing::new(
            serde_json::to_string(&crate::NativeAuthorityRequest::ApplyAuthority {
                channel_id: channel.clone(),
                source: replacement,
            })
            .unwrap(),
        )),
    );
    let early = tokio::time::timeout(std::time::Duration::from_millis(100), &mut apply).await;
    let access_after_admission = destination.runtime.account_access_state(&account);
    let notified = sink.controls.lock().unwrap().len() == 1;
    let output = export.begin_vault_export_output();
    let output_refused = output.is_err();
    // Dispose the held loan before reaping Apply or Close, including the expected early error.
    sink.frames.lock().unwrap().clear();
    if let Ok(lease) = output {
        export.finish_vault_export_output(&lease).unwrap();
    }
    export.close();
    let applied = match early {
        Ok(result) => result,
        Err(_) => tokio::time::timeout(std::time::Duration::from_secs(5), apply)
            .await
            .unwrap(),
    };
    let after = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    source.runtime.close().await;
    destination.runtime.close().await;
    assert_eq!(
        access_after_admission,
        Some(AccountAccessState::Locked),
        "a new source Account incarnation must reach ordinary hard retirement even when the native verification entry remembers its predecessor; Apply: {applied:?}"
    );
    assert!(notified && output_refused);
    assert!(applied.is_ok());
    assert!(!after.bootstrap.policy_verification_pending);
}
