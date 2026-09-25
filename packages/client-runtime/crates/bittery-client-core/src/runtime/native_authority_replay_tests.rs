//! Actual native snapshots and ACK replay retain consumer authority after local cleanup.
use super::*;
use crate::replica::ReplicaState;

#[derive(Default)]
struct EmptyNativeHostCleanup {
    reject_next: AtomicBool,
}

#[async_trait]
impl TeardownHostCleanup for EmptyNativeHostCleanup {
    async fn invoke(
        &self,
        request: TeardownHostCleanupRequest,
    ) -> Result<TeardownHostCleanupResponse, RuntimeError> {
        match request {
            TeardownHostCleanupRequest::DeleteAccount { account_id } => {
                assert_eq!(account_id, AccountId::from("account-1"));
                if self.reject_next.swap(false, Ordering::SeqCst) {
                    return Err(RuntimeError::new(
                        RuntimeErrorCode::StorageUnavailable,
                        "injected native host removal refusal",
                    ));
                }
                Ok(TeardownHostCleanupResponse::AccountDeleted)
            }
            TeardownHostCleanupRequest::WipeDevice => {
                panic!("Account-scoped native removal must not request Device-wide host cleanup")
            }
        }
    }
}

fn enable_native_account_removal(owner: &SqliteOwner) -> Arc<EmptyNativeHostCleanup> {
    owner
        .platform
        .allow_teardown_prefixes
        .store(true, Ordering::SeqCst);
    *owner.runtime.attachment_move_lifecycle.lock().unwrap() =
        Some(Arc::new(AttachmentMoveLifecycle::new(
            Arc::new(attachment_move_lifecycle::TestAccountLeasePort),
            Arc::new(crate::SqliteAttachmentArtifactStore::open(":memory:").unwrap()),
        )));
    let host = Arc::new(EmptyNativeHostCleanup::default());
    owner.runtime.install_teardown_host_cleanup(host.clone());
    host
}

#[tokio::test]
async fn lost_native_ack_replays_after_cleanup_without_retiring_new_unrelated_output() {
    let (source, source_http) = travel_owner("replay-source", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("replay-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    accept_login(&destination.runtime, &account, SELECTED).await;
    accept_login(&destination.runtime, &account, REMAINING).await;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "replay-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "replay-consumer-port".into())
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

    hide_source(&source, &source_http, &account).await;
    let original = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(original.restrictions.len(), 1);
    destination_control
        .apply_authority(&channel, original.clone())
        .await
        .unwrap();
    let acknowledged = destination_control
        .restriction_acknowledgement(&channel)
        .unwrap();
    assert_eq!(acknowledged.frontier, original.restriction_frontier);
    // Lose the outgoing ACK and allow the existing consumer journal to finish independently.
    let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
    wait_selected_cleanup(&destination, &account, &incarnation).await;
    let physical_before = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    assert!(physical_before
        .bootstrap
        .pending_vault_retirements
        .is_empty());
    let session_before = destination
        .runtime
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    let sink = Arc::new(OverlapExportSink::default());
    let output = destination
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

    // This is a fresh snapshot emitted by the actual source, not an old transport sequence.
    let replay = source_control.source_snapshot(&source_channel).unwrap();
    assert!(replay.sequence > original.sequence);
    assert_eq!(replay.restrictions, original.restrictions);
    let applied = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        destination_control.apply_authority(&channel, replay),
    )
    .await;
    let replay_ack = destination_control.restriction_acknowledgement(&channel);
    let output_admitted = output.begin_vault_export_output();
    let controls = sink.controls.lock().unwrap().clone();
    sink.frames.lock().unwrap().clear();
    if let Ok(lease) = output_admitted.as_ref() {
        output.finish_vault_export_output(lease).unwrap();
    }
    output.close();
    applied
        .expect("replayed cleanup must not wait for a new unrelated Export")
        .expect("equal native restriction replay remains valid after journal cleanup");
    assert!(output_admitted.is_ok());
    assert!(controls.is_empty());
    assert_eq!(replay_ack.unwrap(), acknowledged);
    assert_eq!(
        destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .unwrap()
            .unwrap(),
        physical_before,
        "an acknowledged retirement replay must not repeat any physical Replica mutation"
    );
    assert!(
        destination
            .runtime
            .effective_session(&account, &incarnation)
            .await
            .unwrap()
            .unwrap()
            == session_before
    );
    assert_eq!(
        destination.runtime.account_access_state(&account),
        Some(AccountAccessState::Unlocked)
    );
    assert_eq!(
        projected_vaults(&destination.runtime, &account),
        vec![REMAINING.to_owned()]
    );

    source_control
        .acknowledge_restrictions(acknowledged.clone())
        .unwrap();
    source_control
        .acknowledge_restrictions(acknowledged.clone())
        .expect("an identical accepted ACK may be retransmitted");
    let mut changed = acknowledged;
    changed.chain_digest[0] ^= 1;
    assert!(source_control.acknowledge_restrictions(changed).is_err());
    assert!(source_control
        .source_snapshot(&source_channel)
        .unwrap()
        .restrictions
        .is_empty());
    source.runtime.close().await;
    destination.runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn failed_first_native_journal_does_not_cancel_later_account_adoption_or_skip_ack_hole() {
    let (source, source_http) = travel_owner("failure-source-one", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("failure-consumer-one", ClientPlatform::Extension).await;
    install_second_travel_account(&source, "failure-source-two").await;
    install_second_travel_account(&destination, "failure-consumer-two").await;
    let first = AccountId::from("account-1");
    let second = AccountId::from("account-2");
    for account in [&first, &second] {
        accept_login(&destination.runtime, account, SELECTED).await;
        accept_login(&destination.runtime, account, REMAINING).await;
    }
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "failure-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "failure-consumer-port".into())
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
    let first_before = destination
        .runtime
        .replica
        .load_uncached(&first)
        .await
        .unwrap()
        .unwrap();
    let second_before = destination
        .runtime
        .replica
        .load_uncached(&second)
        .await
        .unwrap()
        .unwrap();
    // This trigger faults the real isolated SQLite transaction; it neither intercepts Core
    // admission nor supplies a retirement result. The second Account's writes remain available.
    let fault = rusqlite::Connection::open(&destination.path).unwrap();
    fault
        .execute_batch(
            "CREATE TRIGGER fail_first_native_retirement BEFORE DELETE ON replica_rows
             WHEN OLD.account_id = 'account-1'
             BEGIN SELECT RAISE(ABORT, 'injected first native retirement refusal'); END;",
        )
        .unwrap();
    hide_source(&source, &source_http, &first).await;
    hide_source(&source, &source_http, &second).await;
    let restricted = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(restricted.restrictions.len(), 2);
    assert_eq!(restricted.restrictions[0].source.account_id, first);
    assert_eq!(restricted.restrictions[1].source.account_id, second);
    let result = destination_control
        .apply_authority(&channel, restricted.clone())
        .await;
    assert!(matches!(result, Err(error) if error.code == RuntimeErrorCode::StorageUnavailable));

    // No consumer driver is running: ApplyAuthority itself must finish every admitted batch,
    // including the later Account, before returning the first physical failure.
    assert_eq!(
        destination
            .runtime
            .replica
            .load_uncached(&first)
            .await
            .unwrap()
            .unwrap(),
        first_before,
        "a rejected physical transaction cannot claim a journal or erase original evidence"
    );
    let second_after = destination
        .runtime
        .replica
        .load_uncached(&second)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        second_after.bootstrap.pending_vault_retirements,
        vec![SELECTED.to_owned()]
    );
    assert!(second_after
        .bootstrap
        .vaults
        .keys()
        .all(|(_, vault)| vault != SELECTED));
    assert_eq!(second_after.operations, second_before.operations);
    let incomplete = destination_control
        .restriction_acknowledgement(&channel)
        .unwrap();
    assert_eq!(incomplete.frontier, 0);
    assert!(incomplete.adoptions.is_empty());
    source_control.acknowledge_restrictions(incomplete).unwrap();
    assert_eq!(
        source_control
            .source_snapshot(&source_channel)
            .unwrap()
            .restrictions,
        restricted.restrictions
    );
    assert_eq!(
        projected_vaults(&destination.runtime, &second),
        vec![REMAINING.to_owned()]
    );
    accept_login(&destination.runtime, &second, REMAINING).await;

    fault
        .execute_batch("DROP TRIGGER fail_first_native_retirement")
        .unwrap();
    drop(fault);
    let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
    for (account, incarnation) in [(&first, "generation-1"), (&second, "generation-2")] {
        wait_selected_cleanup(&destination, account, &Incarnation::from(incarnation)).await;
    }
    destination_control
        .apply_authority(
            &channel,
            source_control.source_snapshot(&source_channel).unwrap(),
        )
        .await
        .unwrap();
    let complete = destination_control
        .restriction_acknowledgement(&channel)
        .unwrap();
    assert_eq!(complete.frontier, restricted.restriction_frontier);
    assert_eq!(complete.adoptions.len(), 2);
    source_control.acknowledge_restrictions(complete).unwrap();
    assert!(source_control
        .source_snapshot(&source_channel)
        .unwrap()
        .restrictions
        .is_empty());
    source.runtime.close().await;
    destination.runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn completed_destination_removal_acknowledges_only_its_captured_native_target() {
    completed_native_target_removal(RemovedTargetHistory::Absent).await;
}

#[tokio::test]
async fn removed_native_target_cannot_retire_a_successor_with_the_same_local_account_id() {
    completed_native_target_removal(RemovedTargetHistory::DifferentServerSuccessor).await;
}

enum RemovedTargetHistory {
    Absent,
    DifferentServerSuccessor,
}

async fn completed_native_target_removal(history: RemovedTargetHistory) {
    let (source, source_http) =
        travel_owner("removed-target-source", ClientPlatform::Desktop).await;
    let (destination, destination_http) =
        travel_owner("removed-target-consumer", ClientPlatform::Extension).await;
    enable_native_account_removal(&destination);
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source(
            "allowed-extension".into(),
            "removed-target-source-port".into(),
        )
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "removed-target-consumer-port".into())
        .await
        .unwrap();
    let removed = destination
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    assert!(matches!(
        removed,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
    assert!(destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .is_none());
    assert!(destination.platform.catalog().unwrap().accounts.is_empty());

    let successor = if matches!(history, RemovedTargetHistory::DifferentServerSuccessor) {
        let mut authentication = verified_with_derived_muk();
        authentication.normalized_server_url = "https://successor-native-travel.test".into();
        authentication.master_unlock_key = Zeroizing::new(TEST_MASTER_UNLOCK_KEY);
        authentication.token = Zeroizing::new("independent-successor-session".into());
        authentication.travel_mode = destination_http.policy.lock().unwrap().clone();
        authentication.vault_keys = destination_http
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
        destination
            .runtime
            .install_verified_authentication_with(
                authentication,
                evidence(),
                &FixedClock(NOW_MS),
                &FixedEntropy::new(&["account-1", "successor-generation"]),
            )
            .await
            .unwrap();
        accept_login(&destination.runtime, &account, SELECTED).await;
        accept_login(&destination.runtime, &account, REMAINING).await;
        Some(
            destination
                .runtime
                .replica
                .load_uncached(&account)
                .await
                .unwrap()
                .unwrap(),
        )
    } else {
        None
    };

    hide_source(&source, &source_http, &account).await;
    let restricted = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(restricted.restrictions.len(), 1);
    let applied = destination_control
        .apply_authority(&channel, restricted.clone())
        .await;
    let acknowledgement = destination_control.restriction_acknowledgement(&channel);
    if let Some(before) = successor {
        assert_eq!(
            destination
                .runtime
                .replica
                .load_uncached(&account)
                .await
                .unwrap()
                .unwrap(),
            before,
            "the old native capture cannot mutate a replacement local Account"
        );
        assert_eq!(
            destination.runtime.account_access_state(&account),
            Some(AccountAccessState::Unlocked)
        );
        let session = destination
            .runtime
            .effective_session(&account, &Incarnation::from("successor-generation"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(session.token.as_ref(), "independent-successor-session");
        assert!(matches!(
            session.provenance,
            crate::platform_storage::SessionProvenance::Independent
        ));
    }
    source.runtime.close().await;
    destination.runtime.close().await;
    applied
        .expect("completed removal must give the original captured target a terminal disposition");
    let acknowledgement = acknowledgement.unwrap();
    assert_eq!(acknowledgement.frontier, restricted.restriction_frontier);
    assert_eq!(acknowledgement.adoptions.len(), 1);
    assert_eq!(
        acknowledgement.adoptions[0].disposition,
        crate::NativeRestrictionDisposition::TargetRemoved {
            account_id: account,
            incarnation: Incarnation::from("generation-1"),
        }
    );
}

#[tokio::test]
async fn incomplete_host_removal_cannot_acknowledge_an_absent_captured_replica() {
    let (source, source_http) = travel_owner("incomplete-source", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("incomplete-consumer", ClientPlatform::Extension).await;
    enable_native_account_removal(&destination)
        .reject_next
        .store(true, Ordering::SeqCst);
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "incomplete-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "incomplete-consumer-port".into())
        .await
        .unwrap();
    let removed = destination
        .runtime
        .request(
            RuntimeRequest::RemoveAccount {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap();
    let RuntimeResponse::Teardown {
        status, failures, ..
    } = removed
    else {
        panic!("public removal must return its teardown result");
    };
    assert_eq!(status, TeardownStatus::Incomplete);
    assert_eq!(failures, vec![TeardownPhase::HostCleanup]);
    assert!(destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .is_none());
    assert!(destination.platform.catalog().unwrap().accounts.is_empty());
    hide_source(&source, &source_http, &account).await;
    let restricted = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(restricted.restrictions.len(), 1);
    let applied = destination_control
        .apply_authority(&channel, restricted)
        .await;
    let acknowledgement = destination_control.restriction_acknowledgement(&channel);
    source.runtime.close().await;
    destination.runtime.close().await;
    assert!(applied.is_err());
    assert!(match acknowledgement {
        Ok(acknowledgement) => acknowledgement.frontier == 0,
        Err(_) => true,
    });
}

async fn observe_source_selection(source: &SqliteOwner, http: &MembershipHttp, ids: Vec<String>) {
    observe_source_account_selection(source, http, &AccountId::from("account-1"), ids).await;
}

async fn observe_source_account_selection(
    source: &SqliteOwner,
    http: &MembershipHttp,
    account: &AccountId,
    ids: Vec<String>,
) {
    *http.policy.lock().unwrap() = TravelModeResponse {
        enabled: true,
        enabled_at: Some("2023-11-14T22:13:20Z".into()),
        hidden_vault_ids: ids,
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

#[tokio::test]
async fn malformed_native_prefix_and_interval_are_refused_before_current_authority_changes() {
    let (source, http) = travel_owner("malformed-source", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("malformed-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "malformed-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "malformed-consumer-port".into())
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
    hide_source(&source, &http, &account).await;
    observe_source_selection(&source, &http, vec![SELECTED.into(), REMAINING.into()]).await;
    let original = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(original.restrictions.len(), 2);
    let before = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let session = destination
        .runtime
        .effective_session(&account, &before.incarnation)
        .await
        .unwrap()
        .unwrap();
    let mut mutations = Vec::new();
    let mut changed = original.clone();
    changed.restrictions[0].vault_ids[0] = REMAINING.into();
    mutations.push(("changed immutable Vault selection", changed));
    let mut changed = original.clone();
    changed.restrictions[0].content_digest[0] ^= 1;
    mutations.push(("changed content digest", changed));
    let mut changed = original.clone();
    changed.restrictions[1].previous_digest[0] ^= 1;
    mutations.push(("changed preceding chain digest", changed));
    let mut changed = original.clone();
    changed.restrictions.swap(0, 1);
    mutations.push(("reordered complete prefix", changed));
    let mut changed = original.clone();
    changed.restriction_chain_digest[0] ^= 1;
    mutations.push(("snapshot frontier digest differs", changed));
    let mut changed = original.clone();
    changed.accounts[0]
        .restrictive_continuity
        .as_mut()
        .unwrap()
        .from_generation = u64::MAX;
    mutations.push(("inverted continuity interval", changed));
    let mut changed = original.clone();
    changed.accounts[0]
        .restrictive_continuity
        .as_mut()
        .unwrap()
        .through_generation += 1;
    mutations.push(("interval extends beyond Account generation", changed));
    let mut changed = original.clone();
    changed.accounts[0].unlocked = false;
    mutations.push(("hard Lock presented as restrictive continuity", changed));
    let mut changed = original.clone();
    changed.restrictions = vec![changed.restrictions[0].clone(); 17];
    mutations.push(("prefix exceeds admitted window", changed));
    for (label, changed) in mutations {
        assert!(
            destination_control
                .apply_authority(&channel, changed)
                .await
                .is_err(),
            "{label}"
        );
        assert!(
            destination
                .runtime
                .native_authority
                .has_borrowed_session(&account),
            "{label}"
        );
        assert_eq!(
            destination
                .runtime
                .replica
                .load_uncached(&account)
                .await
                .unwrap()
                .unwrap(),
            before,
            "{label}"
        );
        assert!(
            destination
                .runtime
                .effective_session(&account, &before.incarnation)
                .await
                .unwrap()
                .unwrap()
                == session,
            "{label}"
        );
        assert_eq!(
            destination_control
                .restriction_acknowledgement(&channel)
                .unwrap()
                .frontier,
            0,
            "{label}"
        );
    }
    destination_control
        .apply_authority(&channel, original.clone())
        .await
        .unwrap();
    let ack = destination_control
        .restriction_acknowledgement(&channel)
        .unwrap();
    assert_eq!(ack.frontier, original.restriction_frontier);
    assert_eq!(ack.adoptions.len(), 2);
    assert_eq!(
        destination.runtime.account_access_state(&account),
        Some(AccountAccessState::Unlocked)
    );
    assert!(
        projected_vaults(&destination.runtime, &account).is_empty(),
        "an all-hidden selection retains the Account while exposing no selected Vault"
    );
    source.runtime.close().await;
    destination.runtime.close().await;
}

#[tokio::test]
async fn native_batch_older_than_replay_ring_is_refused_without_retiring_live_authority() {
    let (source, http) = travel_owner("stale-ring-source", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("stale-ring-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "stale-ring-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "stale-ring-consumer-port".into())
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
    let mut oldest = None;
    for index in 1..=17 {
        // A verified Server response can retain IDs whose rows are already absent locally.
        // Each distinct ID starts an actual retirement lifetime and emits a source batch.
        observe_source_selection(
            &source,
            &http,
            vec![format!("30000000-0000-4000-8000-{index:012}")],
        )
        .await;
        let snapshot = source_control.source_snapshot(&source_channel).unwrap();
        assert_eq!(
            snapshot.restrictions.len(),
            1,
            "source must retain only the unacknowledged batch"
        );
        assert_eq!(snapshot.restrictions[0].batch_id, index);
        if oldest.is_none() {
            oldest = Some(snapshot.clone());
        }
        destination_control
            .apply_authority(&channel, snapshot)
            .await
            .unwrap();
        source_control
            .acknowledge_restrictions(
                destination_control
                    .restriction_acknowledgement(&channel)
                    .unwrap(),
            )
            .unwrap();
    }
    let current = source_control.source_snapshot(&source_channel).unwrap();
    assert!(current.restrictions.is_empty());
    let before = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let session = destination
        .runtime
        .effective_session(&account, &before.incarnation)
        .await
        .unwrap()
        .unwrap();
    let acknowledgement = destination_control
        .restriction_acknowledgement(&channel)
        .unwrap();
    assert_eq!(acknowledgement.adoptions.len(), 16);
    assert_eq!(acknowledgement.adoptions[0].batch_id, 2);
    let mut stale = oldest.unwrap();
    // A newer transport sequence must not turn unknown old batch content into authority.
    stale.sequence = current.sequence;
    let applied = destination_control.apply_authority(&channel, stale).await;
    let still_borrowed = destination
        .runtime
        .native_authority
        .has_borrowed_session(&account);
    let after = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    let after_ack = destination_control.restriction_acknowledgement(&channel);
    let after_session = destination
        .runtime
        .effective_session(&account, &before.incarnation)
        .await;
    source.runtime.close().await;
    destination.runtime.close().await;
    assert!(
        applied.is_err(),
        "unknown stale content is explicitly refused"
    );
    assert!(
        still_borrowed,
        "stale refusal cannot retire the current borrowed Account authority"
    );
    assert_eq!(after, before);
    assert_eq!(after_ack.unwrap(), acknowledgement);
    assert!(after_session.unwrap().unwrap() == session);
}

#[tokio::test]
async fn native_source_refuses_seventeenth_channel_without_evicting_admitted_peers() {
    let (source, _) = travel_owner("channel-bound-source", ClientPlatform::Desktop).await;
    let control = source.runtime.native_authority();
    let mut admitted = Vec::new();
    for index in 0..16 {
        admitted.push(
            control
                .attach_source("allowed-extension".into(), format!("bounded-port-{index}"))
                .unwrap(),
        );
    }
    assert!(control
        .attach_source("allowed-extension".into(), "excess-port".into())
        .is_err());
    for peer in admitted {
        let current = control.source_snapshot(&peer.channel_id).unwrap();
        assert_eq!(current.channel_id, peer.channel_id);
        assert_eq!(current.transport_id, peer.transport_id);
        assert_eq!(current.accounts, peer.accounts);
        assert!(current.restrictions.is_empty());
    }
    source.runtime.close().await;
}

#[tokio::test]
async fn native_source_outstanding_batch_overflow_retires_the_exact_channel() {
    let (source, http) = travel_owner("batch-bound-source", ClientPlatform::Desktop).await;
    let control = source.runtime.native_authority();
    let initial = control
        .attach_source("allowed-extension".into(), "bounded-batch-port".into())
        .unwrap();
    for index in 1..=16 {
        observe_source_selection(
            &source,
            &http,
            vec![format!("40000000-0000-4000-8000-{index:012}")],
        )
        .await;
        let snapshot = control.source_snapshot(&initial.channel_id).unwrap();
        assert_eq!(snapshot.restrictions.len(), index);
        assert_eq!(snapshot.restriction_frontier, index as u64);
    }
    observe_source_selection(
        &source,
        &http,
        vec!["40000000-0000-4000-8000-000000000017".into()],
    )
    .await;
    assert!(
        control.source_snapshot(&initial.channel_id).is_err(),
        "overload must explicitly retire authority rather than omit a required batch"
    );
    assert_eq!(
        source
            .runtime
            .account_access_state(&AccountId::from("account-1")),
        Some(AccountAccessState::Unlocked)
    );
    source.runtime.close().await;
}

#[tokio::test]
async fn native_owner_outstanding_bound_never_omits_a_live_channels_prefix() {
    let (source, http) = travel_owner("owner-window-source", ClientPlatform::Desktop).await;
    let source_control = source.runtime.native_authority();
    let mut channels = Vec::new();
    for index in 0..5 {
        channels.push(
            source_control
                .attach_source("allowed-extension".into(), format!("owner-window-{index}"))
                .unwrap()
                .channel_id,
        );
    }
    for index in 1..=12 {
        observe_source_selection(
            &source,
            &http,
            (0..100)
                .map(|id| format!("50000000-0000-4000-8000-{:012}", index * 100 + id))
                .collect(),
        )
        .await;
    }
    for channel in &channels {
        assert_eq!(
            source_control
                .source_snapshot(channel)
                .unwrap()
                .restrictions
                .len(),
            12
        );
    }
    observe_source_selection(
        &source,
        &http,
        (0..100)
            .map(|id| format!("50000000-0000-4000-8000-{:012}", 1_300 + id))
            .collect(),
    )
    .await;
    let snapshots: Vec<_> = channels
        .iter()
        .filter_map(|channel| source_control.source_snapshot(channel).ok())
        .collect();
    assert_eq!(
        snapshots.len(),
        4,
        "the fifth new batch must explicitly lose its channel at the 64-outstanding owner bound"
    );
    for snapshot in &snapshots {
        assert_eq!(snapshot.restrictions.len(), 13);
        assert_eq!(snapshot.restrictions.first().unwrap().batch_id, 1);
        assert_eq!(snapshot.restriction_frontier, 13);
    }
    assert!(
        source_control
            .attach_source("allowed-extension".into(), "over-cap-baseline".into())
            .is_err(),
        "a 13-batch baseline cannot fit beside 52 retained duties"
    );
    for snapshot in &snapshots {
        assert_eq!(
            source_control
                .source_snapshot(&snapshot.channel_id)
                .unwrap()
                .restrictions,
            snapshot.restrictions
        );
    }
    let destination = empty_sqlite_owner(
        ClientPlatform::Extension,
        http,
        Arc::new(FixedClock(NOW_MS)),
    )
    .await;
    let destination_control = destination.runtime.native_authority();
    let channel = destination_control
        .attach_desktop(snapshots[0].clone(), "empty-owner-window-consumer".into())
        .await
        .unwrap();
    let acknowledgement = destination_control
        .restriction_acknowledgement(&channel)
        .unwrap();
    assert_eq!(acknowledgement.frontier, 13);
    assert!(acknowledgement.adoptions.iter().all(|adoption| matches!(
        adoption.disposition,
        crate::NativeRestrictionDisposition::NoTargetAtCapture
    )));
    source_control
        .acknowledge_restrictions(acknowledgement)
        .unwrap();
    let admitted = source_control
        .attach_source("allowed-extension".into(), "freed-owner-window".into())
        .unwrap();
    assert_eq!(admitted.restrictions.len(), 13);
    source.runtime.close().await;
    destination.runtime.close().await;
}

async fn install_bounded_travel_account(source: &SqliteOwner, index: usize) {
    let mut authentication = verified_with_derived_muk();
    authentication.normalized_server_url = format!("https://bound-account-{index}.test");
    authentication.master_unlock_key = Zeroizing::new(TEST_MASTER_UNLOCK_KEY);
    authentication.token = Zeroizing::new(format!("bound-session-{index}"));
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
    let account = format!("account-{index}");
    let generation = format!("generation-{index}");
    source
        .runtime
        .install_verified_authentication_with(
            authentication,
            evidence(),
            &FixedClock(NOW_MS),
            &FixedEntropy::new(&[&account, &generation]),
        )
        .await
        .unwrap();
    source
        .runtime
        .bootstrap_account(&AccountId::from(account), RequestCancellation::new())
        .await
        .unwrap();
}

#[tokio::test]
async fn native_acknowledgement_cannot_reclaim_account_exclusion_capacity() {
    acknowledged_exclusion_bound(1, 1_600).await;
}

#[tokio::test]
async fn native_acknowledgement_cannot_reclaim_owner_exclusion_capacity() {
    acknowledged_exclusion_bound(5, 1_280).await;
}

async fn acknowledged_exclusion_bound(account_count: usize, per_account: usize) {
    let (source, http) = travel_owner("exclusion-source", ClientPlatform::Desktop).await;
    for index in 2..=account_count + 1 {
        install_bounded_travel_account(&source, index).await;
    }
    let untouched = AccountId::from(format!("account-{}", account_count + 1));
    let untouched_before = source
        .runtime
        .replica
        .load_uncached(&untouched)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(untouched_before.bootstrap.state, ReplicaState::Ready);
    let mut sessions = Vec::new();
    for index in 1..=account_count + 1 {
        let account = AccountId::from(format!("account-{index}"));
        let incarnation = Incarnation::from(format!("generation-{index}"));
        sessions.push((
            account.clone(),
            incarnation.clone(),
            source
                .runtime
                .effective_session(&account, &incarnation)
                .await
                .unwrap()
                .unwrap(),
        ));
    }
    let destination = empty_sqlite_owner(
        ClientPlatform::Extension,
        http.clone(),
        Arc::new(FixedClock(NOW_MS)),
    )
    .await;
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "exclusion-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "exclusion-consumer-port".into())
        .await
        .unwrap();
    let mut expected_frontier = 0;
    for index in 1..=account_count {
        let account = AccountId::from(format!("account-{index}"));
        for start in (0..per_account).step_by(100) {
            let ids = (start..(start + 100).min(per_account))
                .map(|id| format!("60000000-0000-4000-8000-{:012}", index * 10_000 + id))
                .collect();
            observe_source_account_selection(&source, &http, &account, ids).await;
            let snapshot = source_control.source_snapshot(&source_channel).unwrap();
            expected_frontier += 1;
            assert_eq!(
                snapshot.restrictions.len(),
                1,
                "each previous batch was acknowledged through actual NoTargetAtCapture routing"
            );
            assert_eq!(snapshot.restriction_frontier, expected_frontier);
            destination_control
                .apply_authority(&channel, snapshot)
                .await
                .unwrap();
            let ack = destination_control
                .restriction_acknowledgement(&channel)
                .unwrap();
            assert_eq!(ack.frontier, expected_frontier);
            assert!(ack.adoptions.iter().all(|adoption| matches!(
                adoption.disposition,
                crate::NativeRestrictionDisposition::NoTargetAtCapture
            )));
            source_control.acknowledge_restrictions(ack).unwrap();
        }
    }
    assert!(source_control
        .source_snapshot(&source_channel)
        .unwrap()
        .restrictions
        .is_empty());
    let overflowing_account = AccountId::from(format!("account-{account_count}"));
    let extra = format!(
        "60000000-0000-4000-8000-{:012}",
        account_count * 10_000 + per_account
    );
    observe_source_account_selection(&source, &http, &overflowing_account, vec![extra.clone()])
        .await;
    assert!(
        source_control.source_snapshot(&source_channel).is_err(),
        "ACK cannot clear exclusions to expose an unbounded continuing source authorization"
    );
    let physical = source
        .runtime
        .replica
        .load_uncached(&overflowing_account)
        .await
        .unwrap()
        .unwrap();
    assert!(
        physical.bootstrap.pending_vault_retirements.is_empty(),
        "source cleanup must still complete when native authority capacity is exhausted"
    );
    assert!(source.runtime.foreground_attachments.is_vault_fenced(
        &overflowing_account,
        &physical.incarnation,
        &extra
    ));
    for (account, incarnation, session) in sessions {
        assert_eq!(
            source.runtime.account_access_state(&account),
            Some(AccountAccessState::Unlocked)
        );
        assert!(
            source
                .runtime
                .effective_session(&account, &incarnation)
                .await
                .unwrap()
                .unwrap()
                == session
        );
    }
    assert_eq!(
        source
            .runtime
            .replica
            .load_uncached(&untouched)
            .await
            .unwrap()
            .unwrap(),
        untouched_before
    );
    accept_login(&source.runtime, &untouched, REMAINING).await;
    source.runtime.close().await;
    destination.runtime.close().await;
}

#[tokio::test]
async fn missing_native_prefix_cannot_bridge_continuity_or_acknowledge_a_hole() {
    for omitted in [1, 2] {
        let (source, http) = travel_owner("missing-source", ClientPlatform::Desktop).await;
        let (destination, _) = travel_owner("missing-consumer", ClientPlatform::Extension).await;
        let account = AccountId::from("account-1");
        accept_login(&destination.runtime, &account, SELECTED).await;
        accept_login(&destination.runtime, &account, REMAINING).await;
        let original_operations = destination
            .runtime
            .require_snapshot(&account)
            .unwrap()
            .operations;
        let source_control = source.runtime.native_authority();
        let destination_control = destination.runtime.native_authority();
        let initial = source_control
            .attach_source("allowed-extension".into(), "missing-source-port".into())
            .unwrap();
        let source_channel = initial.channel_id.clone();
        let channel = destination_control
            .attach_desktop(initial, "missing-consumer-port".into())
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
        hide_source(&source, &http, &account).await;
        observe_source_selection(&source, &http, vec![SELECTED.into(), REMAINING.into()]).await;
        let mut incomplete = source_control.source_snapshot(&source_channel).unwrap();
        assert_eq!(incomplete.restrictions.len(), 2);
        incomplete.restrictions.drain(..omitted);
        let applied = destination_control
            .apply_authority(&channel, incomplete)
            .await;
        assert!(
            applied.is_err(),
            "a prefix missing {omitted} batches cannot authorize its claimed interval"
        );
        assert!(!destination
            .runtime
            .native_authority
            .has_borrowed_session(&account));
        assert_eq!(
            destination.runtime.account_access_state(&account),
            Some(AccountAccessState::Locked)
        );
        assert!(destination_control
            .restriction_acknowledgement(&channel)
            .is_err());
        let retained = destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retained.operations.len(), original_operations.len());
        for original in &original_operations {
            assert_accepted_operation_unchanged(
                original,
                retained
                    .operations
                    .iter()
                    .find(|operation| operation.operation_id == original.operation_id)
                    .unwrap(),
            );
        }
        assert_eq!(
            source_control
                .source_snapshot(&source_channel)
                .unwrap()
                .restrictions
                .len(),
            2,
            "refusal cannot claim remote adoption or discard the source prefix"
        );
        source.runtime.close().await;
        destination.runtime.close().await;
    }
}

#[tokio::test]
async fn native_hide_then_disable_before_delivery_keeps_historical_duty_and_current_exclusions() {
    let (source, http) = travel_owner("coalesced-source", ClientPlatform::Desktop).await;
    let (destination, _) = travel_owner("coalesced-consumer", ClientPlatform::Extension).await;
    let account = AccountId::from("account-1");
    let incarnation = Incarnation::from("generation-1");
    accept_login(&destination.runtime, &account, SELECTED).await;
    accept_login(&destination.runtime, &account, REMAINING).await;
    let original_operations = destination
        .runtime
        .require_snapshot(&account)
        .unwrap()
        .operations;
    let local_policy = destination
        .runtime
        .platform_storage
        .load_account_metadata(&account, &incarnation)
        .await
        .unwrap()
        .unwrap()
        .verified_travel_mode;
    assert!(!local_policy.as_ref().unwrap().enabled);
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source("allowed-extension".into(), "coalesced-source-port".into())
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "coalesced-consumer-port".into())
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
    hide_source(&source, &http, &account).await;
    // No restrictive snapshot is delivered before the source observes its later disabled policy.
    {
        let mut disabled = http.policy.lock().unwrap();
        disabled.enabled = false;
        disabled.enabled_at = None;
    }
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
    let coalesced = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(coalesced.restrictions.len(), 1);
    assert!(
        matches!(&coalesced.restrictions[0].evidence, crate::NativeRestrictionEvidence::VerifiedPolicy { policy } if policy.enabled && policy.hidden_vault_ids == [SELECTED])
    );
    destination_control
        .apply_authority(&channel, coalesced.clone())
        .await
        .unwrap();
    let ack = destination_control
        .restriction_acknowledgement(&channel)
        .unwrap();
    assert_eq!(ack.frontier, coalesced.restriction_frontier);
    source_control.acknowledge_restrictions(ack).unwrap();
    let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
    wait_selected_cleanup(&destination, &account, &incarnation).await;
    let after_cleanup = destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after_cleanup.operations.len(), original_operations.len());
    for original in &original_operations {
        assert_accepted_operation_unchanged(
            original,
            after_cleanup
                .operations
                .iter()
                .find(|operation| operation.operation_id == original.operation_id)
                .unwrap(),
        );
    }
    let later = source_control.source_snapshot(&source_channel).unwrap();
    assert!(later.restrictions.is_empty());
    destination_control
        .apply_authority(&channel, later)
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
    assert_eq!(
        destination
            .runtime
            .platform_storage
            .load_account_metadata(&account, &incarnation)
            .await
            .unwrap()
            .unwrap()
            .verified_travel_mode,
        local_policy,
        "historical native proof cannot overwrite the consumer's current Server policy"
    );
    assert_eq!(
        destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .unwrap()
            .unwrap(),
        after_cleanup,
        "a later disabled snapshot cannot restore authority into an existing exclusion lifetime"
    );
    let borrowed = destination
        .runtime
        .effective_session(&account, &incarnation)
        .await
        .unwrap()
        .unwrap();
    assert!(borrowed
        .vault_keys
        .iter()
        .all(|key| key.vault_id != SELECTED));
    assert!(borrowed
        .vault_keys
        .iter()
        .any(|key| key.vault_id == REMAINING));
    accept_login(&destination.runtime, &account, REMAINING).await;
    source.runtime.close().await;
    destination.runtime.close().await;
    driver.await.unwrap();
}

#[tokio::test]
async fn completed_remove_resolves_an_already_waiting_native_prejournal_capture() {
    let (source, source_http) =
        travel_owner("waiting-removal-source", ClientPlatform::Desktop).await;
    let (destination, destination_http) =
        travel_owner("waiting-removal-consumer", ClientPlatform::Extension).await;
    enable_native_account_removal(&destination);
    let account = AccountId::from("account-1");
    let source_control = source.runtime.native_authority();
    let destination_control = destination.runtime.native_authority();
    let initial = source_control
        .attach_source(
            "allowed-extension".into(),
            "waiting-removal-source-port".into(),
        )
        .unwrap();
    let source_channel = initial.channel_id.clone();
    let channel = destination_control
        .attach_desktop(initial, "waiting-removal-consumer-port".into())
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
    let metadata = Pause::new(PersistenceStep::Metadata);
    destination.platform.pause_at(metadata.clone());
    *destination_http.policy.lock().unwrap() = TravelModeResponse {
        enabled: true,
        enabled_at: Some("2023-11-14T22:13:20Z".into()),
        hidden_vault_ids: vec![SELECTED.into()],
        updated_at: "2023-11-14T22:13:20Z".into(),
    };
    let local_runtime = destination.runtime.clone();
    let local_account = account.clone();
    let refresh = tokio::spawn(async move {
        local_runtime
            .request(
                RuntimeRequest::RefreshTravelMode {
                    account_id: local_account,
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
    .expect("local proof reaches metadata before journal ownership");
    assert!(destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap()
        .bootstrap
        .pending_vault_retirements
        .is_empty());
    hide_source(&source, &source_http, &account).await;
    let snapshot = source_control.source_snapshot(&source_channel).unwrap();
    assert_eq!(snapshot.restrictions.len(), 1);
    let apply_runtime = destination.runtime.clone();
    let apply_channel = channel.clone();
    let mut apply = tokio::spawn(async move {
        apply_runtime
            .native_authority()
            .apply_authority(&apply_channel, snapshot)
            .await
    });
    let waiting_before_caller_loss =
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut apply)
            .await
            .is_err();
    // Caller loss cannot turn the original retained proof into a second native retirement.
    refresh.abort();
    let refresh_cancelled = refresh.await.unwrap_err().is_cancelled();
    metadata.release();
    if !waiting_before_caller_loss {
        source.runtime.close().await;
        destination.runtime.close().await;
        panic!("native adoption must wait for the original prejournal proof");
    }
    assert!(refresh_cancelled);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut apply)
            .await
            .is_err(),
        "native adoption remains joined to the original unjournaled lifetime after its caller disappears"
    );
    assert!(destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .unwrap()
        .bootstrap
        .pending_vault_retirements
        .is_empty());
    assert_eq!(
        destination_control
            .restriction_acknowledgement(&channel)
            .unwrap()
            .frontier,
        0
    );
    let removed = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        destination.runtime.request(
            RuntimeRequest::RemoveAccount {
                account_id: account.clone(),
            },
            RequestCancellation::new(),
        ),
    )
    .await
    .expect("completed Remove must not wait forever for a native journal waiter")
    .unwrap();
    assert!(matches!(
        removed,
        RuntimeResponse::Teardown {
            status: TeardownStatus::Complete,
            ..
        }
    ));
    let applied = tokio::time::timeout(std::time::Duration::from_secs(5), apply)
        .await
        .expect("scope removal wakes the old native waiter")
        .unwrap();
    applied.expect("the exact captured removal settles the pending native adoption");
    let ack = destination_control
        .restriction_acknowledgement(&channel)
        .unwrap();
    assert_eq!(ack.frontier, 1);
    assert_eq!(
        ack.adoptions[0].disposition,
        crate::NativeRestrictionDisposition::TargetRemoved {
            account_id: account.clone(),
            incarnation: Incarnation::from("generation-1")
        }
    );
    assert!(destination
        .runtime
        .replica
        .load_uncached(&account)
        .await
        .unwrap()
        .is_none());
    assert!(destination.platform.catalog().unwrap().accounts.is_empty());
    source_control.acknowledge_restrictions(ack).unwrap();
    assert!(source_control
        .source_snapshot(&source_channel)
        .unwrap()
        .restrictions
        .is_empty());
    source.runtime.close().await;
    destination.runtime.close().await;
}

#[tokio::test]
async fn native_lock_or_eof_while_journal_cleanup_is_held_conserves_durable_erasure() {
    for source_lock in [true, false] {
        let (source, source_http) =
            travel_owner("journal-loss-source", ClientPlatform::Desktop).await;
        let (destination, _) =
            travel_owner("journal-loss-consumer", ClientPlatform::Extension).await;
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
            .attach_source(
                "allowed-extension".into(),
                "journal-loss-source-port".into(),
            )
            .unwrap();
        let source_channel = initial.channel_id.clone();
        let channel = destination_control
            .attach_desktop(initial, "journal-loss-consumer-port".into())
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
        let output = destination
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
        hide_source(&source, &source_http, &account).await;
        let snapshot = source_control.source_snapshot(&source_channel).unwrap();
        let mut apply = Box::pin(destination_control.apply_authority(&channel, snapshot));
        let adopted = tokio::time::timeout(std::time::Duration::from_secs(5), &mut apply).await;
        if !matches!(adopted, Ok(Ok(()))) {
            sink.frames.lock().unwrap().clear();
            output.close();
            if adopted.is_err() {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), apply).await;
            }
            source.runtime.close().await;
            destination.runtime.close().await;
            panic!("native durable ACK cannot await the selected Export's physical disposal");
        }
        let ack = destination_control.restriction_acknowledgement(&channel);
        let physical = destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .unwrap()
            .unwrap();
        let journal_before_loss = physical
            .bootstrap
            .pending_vault_retirements
            .contains(&SELECTED.to_owned());
        let controls_before_loss = sink.controls.lock().unwrap().len();
        let locked_snapshot = if source_lock {
            source
                .runtime
                .request(
                    RuntimeRequest::Lock {
                        account_id: account.clone(),
                    },
                    RequestCancellation::new(),
                )
                .await
                .unwrap();
            Some(source_control.source_snapshot(&source_channel).unwrap())
        } else {
            None
        };
        let losing_runtime = destination.runtime.clone();
        let losing_channel = channel.clone();
        let mut loss = tokio::spawn(async move {
            if let Some(snapshot) = locked_snapshot {
                losing_runtime
                    .native_authority()
                    .apply_authority(&losing_channel, snapshot)
                    .await
            } else {
                losing_runtime
                    .native_authority()
                    .retire_channel(&losing_channel)
                    .await
            }
        });
        let early = tokio::time::timeout(std::time::Duration::from_millis(100), &mut loss).await;
        let loss_waited_for_disposal = early.is_err();
        let borrowed_gone = !destination
            .runtime
            .native_authority
            .has_borrowed_session(&account);
        let retained = destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .unwrap()
            .unwrap();
        sink.frames.lock().unwrap().clear();
        output.close();
        let loss_result = match early {
            Ok(result) => result.unwrap(),
            Err(_) => tokio::time::timeout(std::time::Duration::from_secs(5), loss)
                .await
                .expect("native hard loss finishes after plaintext disposal")
                .unwrap(),
        };
        assert_eq!(ack.unwrap().frontier, 1);
        assert!(journal_before_loss);
        assert_eq!(controls_before_loss, 1);
        assert!(
            loss_waited_for_disposal,
            "hard native loss cannot finish while its plaintext Export loan remains held"
        );
        assert!(loss_result.is_ok());
        assert!(
            borrowed_gone,
            "hard loss revokes borrowed authority before physical cleanup finishes"
        );
        assert!(retained
            .bootstrap
            .pending_vault_retirements
            .contains(&SELECTED.to_owned()));
        assert_eq!(
            destination.runtime.account_access_state(&account),
            Some(AccountAccessState::Locked)
        );
        let driver = tokio::spawn(destination.runtime.clone().run_operation_dispatch());
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let snapshot = destination.runtime.replica.load_uncached(&account).await.unwrap().unwrap();
                let stored = destination.runtime.platform_storage.load_current_session(&account, &incarnation).await.unwrap().unwrap();
                if snapshot.bootstrap.pending_vault_retirements.is_empty()
                    && snapshot.bootstrap.vaults.keys().all(|(_, vault)| vault != SELECTED)
                    && snapshot.bootstrap.items.values().all(|item| item.vault_id != SELECTED)
                    && snapshot.items.iter().all(|item| item.vault_id != SELECTED)
                    && stored.vault_keys.iter().all(|key| key.vault_id != SELECTED) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        }).await.expect("the existing journal owner finishes all-generation authority and stored Session cleanup while locked");
        assert!(destination
            .runtime
            .effective_session(&account, &incarnation)
            .await
            .unwrap()
            .is_none());
        let after = destination
            .runtime
            .replica
            .load_uncached(&account)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after.operations.len(), accepted.len());
        for original in &accepted {
            assert_accepted_operation_unchanged(
                original,
                after
                    .operations
                    .iter()
                    .find(|operation| operation.operation_id == original.operation_id)
                    .unwrap(),
            );
        }
        assert!(after.bootstrap.pending_vault_retirements.is_empty());
        if !source_lock {
            assert!(destination_control
                .restriction_acknowledgement(&channel)
                .is_err());
        }
        source.runtime.close().await;
        destination.runtime.close().await;
        driver.await.unwrap();
    }
}
