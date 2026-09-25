//! Public Runtime crash histories over real SQLite and the retained platform fixture.
use super::*;
use std::sync::atomic::AtomicUsize;

fn session_source() -> Arc<Source> {
    let mut source = Source::two_accounts();
    let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
    inner.credentials[3] = Some("original-session-token".into());
    inner.credentials[4] = Some("[]".into());
    inner.credentials[5] = Some("original-encrypted-private-key".into());
    source
}

fn incomplete_session_source() -> Arc<Source> {
    let mut source = Source::two_accounts();
    let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
    inner.credentials[3] = Some("original-incomplete-session-token".into());
    inner.credentials[4] = Some("[]".into());
    let mut store: Value = serde_json::from_str(&inner.store).unwrap();
    store[format!("bittery_account_{}_travel_mode_cache", desktop::ACCOUNT)] = json!(json!({
        "enabled":false,"hiddenVaultIds":["retained-selection"],"enabledAt":null,"updatedAt":0
    })
    .to_string());
    inner.store = store.to_string();
    source
}

fn enabled_travel_source() -> Arc<Source> {
    let enabled = super::travel::with_enabled_policy(false, true);
    let mut source = Source::two_accounts();
    let inner = &mut Arc::get_mut(&mut source).unwrap().inner;
    let original: Value = serde_json::from_str(&inner.store).unwrap();
    let mut store: Value = serde_json::from_str(&enabled.inner.store).unwrap();
    for (key, value) in original.as_object().unwrap() {
        store
            .as_object_mut()
            .unwrap()
            .entry(key.clone())
            .or_insert_with(|| value.clone());
    }
    store["bittery_accounts_list"] = original["bittery_accounts_list"].clone();
    inner.store = store.to_string();
    inner.sync = enabled.inner.sync.clone();
    inner.credentials = enabled.inner.credentials.clone();
    source
}

struct PlatformWriteFault {
    inner: Arc<RetainingPlatform>,
    target_write: usize,
    writes: AtomicUsize,
    lose_readback: bool,
    fail_next_read: AtomicBool,
    fired: AtomicBool,
}

#[async_trait]
impl SerializedPlatformStorageExecutor for PlatformWriteFault {
    async fn invoke(&self, request: Zeroizing<String>) -> Result<Zeroizing<String>, RuntimeError> {
        let parsed: PlatformStorageRequest = serde_json::from_str(&request).unwrap();
        if matches!(parsed, PlatformStorageRequest::Get { .. })
            && self.fail_next_read.swap(false, Ordering::SeqCst)
        {
            return Err(unavailable());
        }
        let is_target = matches!(parsed, PlatformStorageRequest::Set { .. })
            && self.writes.fetch_add(1, Ordering::SeqCst) + 1 == self.target_write;
        let reply = self.inner.invoke(request).await?;
        if is_target {
            self.fired.store(true, Ordering::SeqCst);
            self.fail_next_read
                .store(self.lose_readback, Ordering::SeqCst);
            return Err(unavailable());
        }
        Ok(reply)
    }
}

fn assert_two_locked(runtime: &Arc<Runtime>) {
    let sink = Arc::new(Sink::default());
    let observation = runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone(),
        )
        .unwrap();
    let projections = sink.0.lock().unwrap();
    let Some(RuntimeProjection::RuntimeStatus(status)) = projections.last() else {
        panic!("Runtime status");
    };
    assert!(!status.closed);
    assert_eq!(status.accounts.len(), 2);
    assert!(status
        .accounts
        .iter()
        .all(|account| account.access == AccountAccessState::Locked));
    assert!(status
        .accounts
        .iter()
        .any(|account| account.account_id.as_str() == desktop::ACCOUNT));
    assert!(status
        .accounts
        .iter()
        .any(|account| account.account_id.as_str() == SECOND_ACCOUNT));
    drop(projections);
    observation.close();
}

fn assert_committed_same_reservations(before: &Value, after: &Value) {
    assert_eq!(after["profileAdmission"]["phase"], "committed");
    for field in ["admissionId", "source", "manifestDigest"] {
        assert!(!before["profileAdmission"][field].is_null());
        assert_eq!(
            before["profileAdmission"][field],
            after["profileAdmission"][field]
        );
    }
    for account in before["accounts"].as_array().unwrap() {
        let matched = after["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|candidate| candidate["accountId"] == account["accountId"])
            .unwrap();
        let incarnation = if account["activeIncarnation"].is_null() {
            &account["pendingInstall"]["incarnation"]
        } else {
            &account["activeIncarnation"]
        };
        assert!(!incarnation.is_null());
        assert_eq!(&matched["activeIncarnation"], incarnation);
        assert!(matched["pendingInstall"].is_null());
    }
}

#[tokio::test]
async fn every_destination_write_ambiguity_reopens_without_reminting_or_rewriting_staged_material()
{
    destination_write_ambiguity_matrix(session_source, ":current-session").await;
}

#[tokio::test]
async fn incomplete_session_write_ambiguities_reopen_without_promoting_or_rewriting_evidence() {
    destination_write_ambiguity_matrix(incomplete_session_source, ":legacy-session-evidence").await;
}

#[tokio::test]
async fn enabled_travel_write_ambiguities_keep_the_same_filtered_destinations() {
    destination_write_ambiguity_matrix(enabled_travel_source, ":legacy-session-evidence").await;
}

async fn destination_write_ambiguity_matrix(
    session_source: fn() -> Arc<Source>,
    session_suffix: &str,
) {
    let baseline_directory = TestDirectory::new();
    let baseline = Arc::new(RetainingPlatform::default());
    let runtime =
        runtime_with_platform_and_source(&baseline_directory, baseline.clone(), session_source())
            .await;
    runtime.open().await.unwrap();
    assert_two_locked(&runtime);
    runtime.close().await;
    let writes = baseline.sets.lock().unwrap().clone();
    // Keep this acceptance matrix honest as the bounded path grows: both Accounts, every
    // credential tier, the initial reservation, Account checkpoints, and whole-profile commit.
    for suffix in [
        ":device-key",
        ":local-security",
        ":metadata",
        ":quick-unlock",
        session_suffix,
    ] {
        assert!(
            writes.iter().any(|(key, _)| key.ends_with(suffix)),
            "missing {suffix}"
        );
    }
    for suffix in [
        ":metadata",
        ":quick-unlock",
        session_suffix,
        ":local-security",
    ] {
        for account in [desktop::ACCOUNT, SECOND_ACCOUNT] {
            let account_prefix = format!(
                "bittery:runtime:platform-storage:account:{}:{account}:",
                account.len()
            );
            assert_eq!(
                writes
                    .iter()
                    .filter(|(key, _)| key.starts_with(&account_prefix) && key.ends_with(suffix))
                    .count(),
                1,
                "missing or duplicate {account} {suffix}"
            );
        }
    }
    assert_eq!(
        writes.last().unwrap().1["profileAdmission"]["phase"],
        "committed"
    );

    for lose_readback in [false, true] {
        for target_write in 1..=writes.len() {
            let directory = TestDirectory::new();
            let platform = Arc::new(RetainingPlatform::default());
            let fault = Arc::new(PlatformWriteFault {
                inner: platform.clone(),
                target_write,
                writes: AtomicUsize::new(0),
                lose_readback,
                fail_next_read: AtomicBool::new(false),
                fired: AtomicBool::new(false),
            });
            let runtime =
                runtime_with_platform_and_source(&directory, fault.clone(), session_source()).await;
            let result = runtime.open().await;
            assert!(
                fault.fired.load(Ordering::SeqCst),
                "write {target_write} did not execute"
            );
            if lose_readback {
                assert!(
                    result.is_err(),
                    "write {target_write} published despite ambiguous readback"
                );
                assert!(runtime
                    .observe(
                        ObservationRequest::RuntimeStatus { account_id: None },
                        Arc::new(Sink::default())
                    )
                    .is_err());
                assert_eq!(
                    platform.sets.lock().unwrap().len(),
                    target_write,
                    "writes continued after ambiguity"
                );
            } else {
                result.unwrap();
                assert_two_locked(&runtime);
            }
            let before = platform.catalog();
            let retained = platform.values.lock().unwrap().clone();
            runtime.close().await;
            drop(runtime);
            // New Runtime, source capability and physical SQLite owner: no old in-memory proof.
            let source = session_source();
            platform.sets.lock().unwrap().clear();
            let reopened =
                runtime_with_platform_and_source(&directory, platform.clone(), source.clone())
                    .await;
            reopened.open().await.unwrap();
            assert_two_locked(&reopened);
            assert_committed_same_reservations(&before, &platform.catalog());
            {
                let after = platform.values.lock().unwrap();
                for (_, expected) in writes.iter().filter(|(key, _)| key.ends_with(":metadata")) {
                    let actual = after
                        .iter()
                        .filter(|((_, key), _)| key.ends_with(":metadata"))
                        .map(|(_, value)| serde_json::from_str::<Value>(value).unwrap())
                        .find(|value| value["accountId"] == expected["accountId"])
                        .unwrap();
                    assert_eq!(actual["verifiedTravelMode"], expected["verifiedTravelMode"]);
                }
                for (location, value) in retained.iter().filter(|((_, key), _)| key != CATALOG) {
                    assert_eq!(
                        after.get(location),
                        Some(value),
                        "staged material changed at {location:?}"
                    );
                    assert!(
                        !platform
                            .sets
                            .lock()
                            .unwrap()
                            .iter()
                            .any(|(key, _)| key == &location.1),
                        "reissued already proven document write"
                    );
                }
            }
            assert!(!source.calls.lock().unwrap().iter().any(|request| matches!(
                request,
                ProfileAdmissionRequest::BeginSourceSnapshot { .. }
            )));
            reopened.close().await;
        }
    }
}

struct ReplicaInstallFault {
    inner: SqliteReplica,
    target_install: usize,
    installed_accounts: Mutex<Vec<String>>,
    fired: AtomicBool,
    fail_read: AtomicBool,
    lose_readback: bool,
}

#[async_trait]
impl SerializedReplicaExecutor for ReplicaInstallFault {
    async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
        let value: Value = serde_json::from_str(&request).unwrap();
        if value["type"] == "load" && self.fail_read.swap(false, Ordering::SeqCst) {
            return Err(unavailable());
        }
        let reply = self.inner.invoke(request).await?;
        if value["type"] == "install" {
            let mut installs = self.installed_accounts.lock().unwrap();
            installs.push(
                value["prepared"]["nextHead"]["accountId"]
                    .as_str()
                    .unwrap()
                    .into(),
            );
            if installs.len() == self.target_install {
                self.fired.store(true, Ordering::SeqCst);
                self.fail_read.store(self.lose_readback, Ordering::SeqCst);
                return Err(unavailable());
            }
        }
        Ok(reply)
    }
}

#[tokio::test]
async fn sqlite_install_reply_and_readback_loss_resume_the_same_private_account_snapshot() {
    for lose_readback in [false, true] {
        for target_install in [1, 2] {
            let directory = TestDirectory::new();
            let platform = Arc::new(RetainingPlatform::default());
            let fault = Arc::new(ReplicaInstallFault {
                inner: SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap(),
                target_install,
                installed_accounts: Mutex::new(Vec::new()),
                fired: AtomicBool::new(false),
                fail_read: AtomicBool::new(false),
                lose_readback,
            });
            let runtime =
                runtime_with_platform_and_replica(&directory, platform.clone(), fault.clone())
                    .await;
            runtime
                .set_profile_admission_source(ProfileAdmissionSource::Legacy {
                    format: LegacyProfileFormat::DesktopLegacyV1,
                    executor: session_source(),
                })
                .await
                .unwrap();
            let result = runtime.open().await;
            assert!(fault.fired.load(Ordering::SeqCst));
            let installed = fault.installed_accounts.lock().unwrap().clone();
            assert_eq!(
                installed.len(),
                if lose_readback { target_install } else { 2 }
            );
            if lose_readback {
                assert!(result.is_err());
                assert_eq!(platform.catalog()["profileAdmission"]["phase"], "preparing");
                assert!(runtime
                    .observe(
                        ObservationRequest::RuntimeStatus { account_id: None },
                        Arc::new(Sink::default())
                    )
                    .is_err());
            } else {
                result.unwrap();
                assert_two_locked(&runtime);
            }
            let before = platform.catalog();
            // A successfully published Runtime advances its ordinary lock epoch on close. Capture
            // durable evidence after that transition, then replace both Runtime and SQLite owners.
            runtime.close().await;
            let mut snapshots = Vec::new();
            for account in &installed {
                let row_before = load_snapshot(&fault.inner, account).await;
                assert!(!row_before["head"].is_null());
                // The no-cache fixture has a real private Account head and exactly empty rows.
                assert!(row_before["rows"].as_array().unwrap().is_empty());
                assert_eq!(row_before["head"]["accountId"], account.as_str());
                snapshots.push((account.clone(), row_before));
            }
            drop(runtime);
            drop(fault);
            let restarted_replica = Arc::new(ReplicaInstallFault {
                inner: SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap(),
                target_install: 0,
                installed_accounts: Mutex::new(Vec::new()),
                fired: AtomicBool::new(false),
                fail_read: AtomicBool::new(false),
                lose_readback: false,
            });
            let reopened = runtime_with_platform_and_replica(
                &directory,
                platform.clone(),
                restarted_replica.clone(),
            )
            .await;
            reopened
                .set_profile_admission_source(ProfileAdmissionSource::Legacy {
                    format: LegacyProfileFormat::DesktopLegacyV1,
                    executor: session_source(),
                })
                .await
                .unwrap();
            reopened.open().await.unwrap();
            assert_two_locked(&reopened);
            assert_committed_same_reservations(&before, &platform.catalog());
            for (account, row_before) in snapshots {
                assert_eq!(
                    load_snapshot(&restarted_replica.inner, &account).await,
                    row_before
                );
                assert!(
                    !restarted_replica
                        .installed_accounts
                        .lock()
                        .unwrap()
                        .contains(&account),
                    "reinstalled proven private Account"
                );
            }
            reopened.close().await;
        }
    }
}

async fn load_snapshot(replica: &SqliteReplica, account: &str) -> Value {
    serde_json::from_str(
        &replica
            .invoke(json!({"type":"load","accountId":account}).to_string())
            .await
            .unwrap(),
    )
    .unwrap()
}

struct FinalVerificationFault {
    inner: Arc<Source>,
    passes: AtomicUsize,
    changed: bool,
}

#[async_trait]
impl SerializedProfileAdmissionExecutor for FinalVerificationFault {
    async fn invoke(
        &self,
        request: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let parsed: ProfileAdmissionRequest = serde_json::from_str(&request).unwrap();
        if matches!(
            parsed,
            ProfileAdmissionRequest::VerifySourceSnapshot {
                step: ProfileSourceVerifyStep::Start { .. }
            }
        ) {
            self.passes.fetch_add(1, Ordering::SeqCst);
        }
        if self.passes.load(Ordering::SeqCst) == 2
            && matches!(
                parsed,
                ProfileAdmissionRequest::VerifySourceSnapshot {
                    step: ProfileSourceVerifyStep::Finish { .. }
                }
            )
        {
            return Ok((
                Zeroizing::new(
                    serde_json::to_string(&ProfileAdmissionResponse::SourceSnapshotVerification {
                        result: if self.changed {
                            ProfileSourceVerificationResult::Changed {}
                        } else {
                            ProfileSourceVerificationResult::Unavailable {}
                        },
                    })
                    .unwrap(),
                ),
                None,
            ));
        }
        self.inner.invoke(request).await
    }
}

#[tokio::test]
async fn final_source_proof_failure_keeps_verified_accounts_private_and_rechecks_on_reopen() {
    for changed in [false, true] {
        let directory = TestDirectory::new();
        let platform = Arc::new(RetainingPlatform::default());
        let source = Arc::new(FinalVerificationFault {
            inner: session_source(),
            passes: AtomicUsize::new(0),
            changed,
        });
        let runtime =
            runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;
        let error = runtime.open().await.unwrap_err();
        assert_eq!(
            error.message,
            if changed {
                "Legacy profile source changed during verification"
            } else {
                "Legacy profile source verification is unavailable"
            }
        );
        assert_eq!(source.passes.load(Ordering::SeqCst), 2);
        assert!(runtime
            .observe(
                ObservationRequest::RuntimeStatus { account_id: None },
                Arc::new(Sink::default())
            )
            .is_err());
        let before = platform.catalog();
        assert_eq!(before["profileAdmission"]["phase"], "preparing");
        assert!(before["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|account| account["activeIncarnation"].is_null()
                && !account["pendingInstall"].is_null()));
        assert!(before["profileAdmission"]["progress"]["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|account| account["checkpoint"] == "verified"));
        assert!(!source
            .inner
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|request| matches!(
                request,
                ProfileAdmissionRequest::ReopenSourceForCleanup { .. }
                    | ProfileAdmissionRequest::DeleteCapturedSource { .. }
            )));
        let retained = platform.values.lock().unwrap().clone();
        runtime.close().await;
        let physical = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
        let mut snapshots = Vec::new();
        for account in [desktop::ACCOUNT, SECOND_ACCOUNT] {
            let snapshot = load_snapshot(&physical, account).await;
            assert!(!snapshot["head"].is_null());
            snapshots.push((account, snapshot));
        }
        drop(physical);
        let restarted_source = session_source();
        platform.sets.lock().unwrap().clear();
        let reopened = runtime_with_platform_and_source(
            &directory,
            platform.clone(),
            restarted_source.clone(),
        )
        .await;
        reopened.open().await.unwrap();
        assert_two_locked(&reopened);
        assert_committed_same_reservations(&before, &platform.catalog());
        assert!(restarted_source
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|request| matches!(
                request,
                ProfileAdmissionRequest::ReopenSourceSnapshot { .. }
            )));
        assert!(platform
            .sets
            .lock()
            .unwrap()
            .iter()
            .all(|(key, _)| key == CATALOG));
        for (location, value) in retained.iter().filter(|((_, key), _)| key != CATALOG) {
            assert_eq!(platform.values.lock().unwrap().get(location), Some(value));
        }
        let physical = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
        for (account, snapshot) in snapshots {
            assert_eq!(load_snapshot(&physical, account).await, snapshot);
        }
        reopened.close().await;
    }
}
