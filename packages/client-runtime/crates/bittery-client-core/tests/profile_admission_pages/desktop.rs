use super::*;
use bittery_client_core::{
    ProfileAccountCredentialField as Field, ProfileGlobalCredentialField,
    ProfileSourceManifestDigest, ProfileSourceManifestEntry, ProfileSourceStringEncoding,
    ProfileSourceVerificationResult as Verification, ProfileSourceVerifyStep as VerifyStep,
};
use serde_json::{json, Value};

pub(super) const ACCOUNT: &str = "acct_legacy_α:7";

pub(super) struct Populated {
    pub(super) store: String,
    pub(super) sync: Option<String>,
    pub(super) credentials: Vec<Option<String>>,
    verification_fault: Option<&'static str>,
    requests: Mutex<Vec<ProfileAdmissionRequest>>,
}

fn metadata() -> Value {
    json!({"accountId": ACCOUNT, "email":"Person@example.test", "userId":"original-user",
        "name":"Original", "serverUrl":"https://EXAMPLE.test/", "secretKeyHint":"A3-ABCDEF",
        "addedAt":1700000000000_u64, "lastActiveAt":1700000000123_u64,
        "biometricEnabled":false, "insecureTransportConfirmed":false, "teamAvatarUrl":null})
}

fn store() -> Value {
    json!({"bittery_accounts_list":json!({"version":2,"accounts":[metadata()]}).to_string(),
        "bittery_active_account": ACCOUNT,
        "bittery_master_password_reentry_period_ms":"0",
        format!("bittery_account_{ACCOUNT}_auto_lock_timeout"):"-1",
        format!("bittery_account_{ACCOUNT}_biometric_enabled"):"false",
        format!("bittery_account_{ACCOUNT}_server_url"):"https://example.test",
        format!("bittery_account_{ACCOUNT}_pinned_kdf_params"):json!({"schemaVersion":1,"algorithm":"pbkdf2-sha256","iterations":600000}).to_string()})
}

fn selectors() -> Vec<ProfileSourceSelector> {
    std::iter::once(ProfileSourceSelector::GlobalCredential {
        field: ProfileGlobalCredentialField::DeviceKey,
    })
    .chain(
        [
            Field::SecretKey,
            Field::SessionData,
            Field::JwtToken,
            Field::VaultKeys,
            Field::EncryptedPrivateKey,
        ]
        .into_iter()
        .map(|field| ProfileSourceSelector::AccountCredential {
            account_id: ACCOUNT.into(),
            field,
        }),
    )
    .collect()
}

impl Populated {
    pub(super) fn valid() -> Self {
        Self { store:store().to_string(), sync:None, credentials:vec![
            Some("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=".into()),
            Some("A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2".into()),
            Some(json!({"encryptedMasterUnlockKey":{"ciphertext":"original-ciphertext","iv":"original-iv","algorithm":"AES-GCM-AAD-V1"},
                "email":"person@example.test","userId":"original-user","createdAt":1700000000000_u64,
                "expiresAt":1209600000_u64}).to_string()),
            None,None,None], verification_fault:None, requests:Mutex::new(Vec::new()) }
    }

    pub(super) fn manifest(&self) -> Vec<ProfileSourceManifestEntry> {
        let sources = [
            (
                ProfileSourceFamily::DesktopStore,
                ProfileSourceSelector::WholeFile {},
                Some(self.store.as_str()),
                Some("decoder-store-file"),
            ),
            (
                ProfileSourceFamily::DesktopSyncStore,
                ProfileSourceSelector::WholeFile {},
                self.sync.as_deref(),
                self.sync.as_ref().map(|_| "decoder-sync-file"),
            ),
        ]
        .into_iter()
        .chain(
            selectors()
                .into_iter()
                .zip(&self.credentials)
                .map(|(selector, value)| {
                    (
                        ProfileSourceFamily::DesktopCredentials,
                        selector,
                        value.as_deref(),
                        None,
                    )
                }),
        );
        sources
            .map(|(family, selector, value, file_identity)| {
                let observation = match value {
                    None => ProfileSourceObservation::Missing {},
                    Some(value) if family == ProfileSourceFamily::DesktopCredentials => {
                        ProfileSourceObservation::StoredString {
                            encoding: ProfileSourceStringEncoding::Utf8,
                            length: value.len() as u64,
                        }
                    }
                    Some(value) => ProfileSourceObservation::FileBytes {
                        length: value.len() as u64,
                    },
                };
                ProfileSourceManifestEntry::from_evidence(
                    LegacyProfileFormat::DesktopLegacyV1,
                    family,
                    selector,
                    observation,
                    file_identity.map(str::to_owned),
                    value.unwrap_or_default().as_bytes(),
                )
                .unwrap()
            })
            .collect()
    }

    fn verify(&self, step: VerifyStep) -> Verification {
        match step {
            VerifyStep::Start {
                verification_attempt_id,
                snapshot_handle,
                header,
            } => {
                assert!(!verification_attempt_id.is_empty());
                assert_eq!(snapshot_handle, SNAPSHOT_HANDLE);
                assert_eq!(header.profile_identity, "decoder-profile");
                assert_eq!(header.recorded_capture_id, "decoder-capture");
                let manifest = self.manifest();
                assert_eq!(header.entry_count as usize, manifest.len());
                let mut digest = ProfileSourceManifestDigest::new(
                    header.format,
                    &header.profile_identity,
                    header.entry_count,
                )
                .unwrap();
                for entry in &manifest {
                    digest.append(entry).unwrap();
                }
                assert!(header.verify_digest(digest).unwrap());
                Verification::Started {
                    verification_cursor: "verify:0".into(),
                    next_index: 0,
                }
            }
            VerifyStep::Entry {
                verification_cursor,
                index,
                expected_entry,
            } => {
                assert_eq!(verification_cursor, format!("verify:{index}"));
                assert_eq!(expected_entry, self.manifest()[index as usize]);
                match self.verification_fault {
                    Some("changed") => Verification::Changed {},
                    Some("unavailable") => Verification::Unavailable {},
                    Some("index") => Verification::Matched {
                        verification_cursor: format!("verify:{}", index + 1),
                        next_index: index + 2,
                    },
                    _ => Verification::Matched {
                        verification_cursor: format!("verify:{}", index + 1),
                        next_index: index + 1,
                    },
                }
            }
            VerifyStep::Finish {
                verification_cursor,
            } => {
                assert_eq!(
                    verification_cursor,
                    format!("verify:{}", self.manifest().len())
                );
                Verification::Unchanged {
                    snapshot_handle: if self.verification_fault == Some("handle") {
                        "another-snapshot".into()
                    } else {
                        SNAPSHOT_HANDLE.into()
                    },
                }
            }
        }
    }
}

#[async_trait]
impl SerializedProfileAdmissionExecutor for Populated {
    async fn invoke(
        &self,
        request: Zeroizing<String>,
    ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
        let request: ProfileAdmissionRequest = serde_json::from_str(&request).unwrap();
        self.requests.lock().unwrap().push(request.clone());
        let (response, binary) = match request {
            ProfileAdmissionRequest::BeginSourceSnapshot { format } => (
                ProfileAdmissionResponse::SourceSnapshot {
                    snapshot: bittery_client_core::ProfileSourceSnapshot {
                        format,
                        snapshot_handle: SNAPSHOT_HANDLE.into(),
                        profile_identity: "decoder-profile".into(),
                        capture_id: "decoder-capture".into(),
                        session_instance: None,
                        families: vec![
                            ProfileSourceFamilyInventory {
                                family: ProfileSourceFamily::DesktopStore,
                                presence: ProfileSourcePresence::Present,
                                file_identity: Some("decoder-store-file".into()),
                            },
                            ProfileSourceFamilyInventory {
                                family: ProfileSourceFamily::DesktopSyncStore,
                                presence: if self.sync.is_some() {
                                    ProfileSourcePresence::Present
                                } else {
                                    ProfileSourcePresence::Missing
                                },
                                file_identity: self
                                    .sync
                                    .is_some()
                                    .then(|| "decoder-sync-file".into()),
                            },
                            ProfileSourceFamilyInventory {
                                family: ProfileSourceFamily::DesktopCredentials,
                                presence: ProfileSourcePresence::Present,
                                file_identity: None,
                            },
                        ],
                    },
                },
                None,
            ),
            ProfileAdmissionRequest::ReadSourcePage {
                snapshot_handle,
                family,
                selector,
                cursor,
            } => {
                assert!(cursor.is_none());
                let value = match family {
                    ProfileSourceFamily::DesktopStore => Some(self.store.as_str()),
                    ProfileSourceFamily::DesktopSyncStore => self.sync.as_deref(),
                    ProfileSourceFamily::DesktopCredentials => self.credentials[selectors()
                        .iter()
                        .position(|value| value == &selector)
                        .expect("exact Core-derived credential selector")]
                    .as_deref(),
                    _ => panic!("unexpected family"),
                };
                let observation = match value {
                    None => ProfileSourceObservation::Missing {},
                    Some(value) if family == ProfileSourceFamily::DesktopCredentials => {
                        ProfileSourceObservation::StoredString {
                            encoding: ProfileSourceStringEncoding::Utf8,
                            length: value.len() as u64,
                        }
                    }
                    Some(value) => ProfileSourceObservation::FileBytes {
                        length: value.len() as u64,
                    },
                };
                (
                    ProfileAdmissionResponse::SourcePage(ProfileSourcePage {
                        snapshot_handle,
                        family,
                        selector,
                        observation,
                        offset: 0,
                        byte_length: value.map_or(0, |value| value.len() as u64),
                        continuation: ProfileSourceContinuation::End {},
                    }),
                    value.map(|value| Zeroizing::new(value.as_bytes().to_vec())),
                )
            }
            ProfileAdmissionRequest::CloseSourceSnapshot { .. } => {
                (ProfileAdmissionResponse::SourceSnapshotClosed {}, None)
            }
            ProfileAdmissionRequest::VerifySourceSnapshot { step } => (
                ProfileAdmissionResponse::SourceSnapshotVerification {
                    result: self.verify(step),
                },
                (self.verification_fault == Some("binary")).then(|| Zeroizing::new(Vec::new())),
            ),
            ProfileAdmissionRequest::PrepareLegacyProfileReset { .. }
            | ProfileAdmissionRequest::ResetLegacySourceFamily { .. }
            | ProfileAdmissionRequest::ReopenSourceForCleanup { .. }
            | ProfileAdmissionRequest::DeleteCapturedSource { .. } => {
                return Err(RuntimeError {
                    code: RuntimeErrorCode::StorageUnavailable,
                    message: "fixture retains legacy source".into(),
                    recovery_bound: None,
                    team_page_problem: None,
                });
            }
            ProfileAdmissionRequest::ReopenSourceSnapshot { .. } => {
                panic!("Initial decoder validation must not verify or reopen a snapshot")
            }
        };
        Ok((
            Zeroizing::new(serde_json::to_string(&response).unwrap()),
            binary,
        ))
    }
}

#[tokio::test]
async fn changed_source_verification_refuses_before_any_destination_write() {
    let mut source = Populated::valid();
    source.verification_fault = Some("changed");
    let source = Arc::new(source);
    assert_eq!(
        refused(source.clone()).await.message,
        "Legacy profile source changed during verification"
    );
    assert!(!source
        .requests
        .lock()
        .unwrap()
        .iter()
        .any(|request| matches!(
            request,
            ProfileAdmissionRequest::VerifySourceSnapshot {
                step: VerifyStep::Finish { .. }
            }
        )));
}

#[tokio::test]
async fn unavailable_or_malformed_source_proof_never_reaches_admission_commit() {
    for fault in ["unavailable", "index", "handle", "binary"] {
        let mut source = Populated::valid();
        source.verification_fault = Some(fault);
        let error = refused(Arc::new(source)).await;
        assert_ne!(error.message, STAGING_UNAVAILABLE, "{fault}");
    }
}

async fn refused(source: Arc<Populated>) -> RuntimeError {
    let directory = TestDirectory::new();
    let runtime = runtime_with_source(&directory, source.clone()).await;
    let error = runtime
        .open()
        .await
        .expect_err("this read-only source fixture cannot stage destination data");
    let sink = Arc::new(Sink::default());
    assert!(runtime
        .observe(
            ObservationRequest::RuntimeStatus { account_id: None },
            sink.clone()
        )
        .is_err());
    assert!(sink.0.lock().unwrap().is_empty());
    runtime.close().await;
    assert!(matches!(
        source.requests.lock().unwrap().last(),
        Some(ProfileAdmissionRequest::CloseSourceSnapshot { .. })
    ));
    error
}

#[tokio::test]
async fn populated_no_work_reads_exact_credentials_without_installing_or_signing_in() {
    let source = Arc::new(Populated::valid());
    let error = refused(source.clone()).await;
    assert_eq!(error.message, STAGING_UNAVAILABLE);
    let requested = source
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter_map(|request| match request {
            ProfileAdmissionRequest::ReadSourcePage {
                family: ProfileSourceFamily::DesktopCredentials,
                selector,
                ..
            } => Some(selector.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(requested, selectors());
}

#[tokio::test]
async fn stale_selected_account_is_not_treated_as_account_or_login_authority() {
    let mut source = Populated::valid();
    let mut values: Value = serde_json::from_str(&source.store).unwrap();
    values["bittery_active_account"] = json!("removed-account");
    source.store = values.to_string();

    assert_eq!(refused(Arc::new(source)).await.message, STAGING_UNAVAILABLE);
}

#[tokio::test]
async fn malformed_or_unsupported_plain_evidence_gets_a_specific_refusal() {
    let mut cases = Vec::new();
    cases.push((
        "{\"bittery_accounts_list\":\"{}\",\"bittery_accounts_list\":\"{}\"}".into(),
        "Legacy Desktop store is malformed",
    ));
    cases.push((
        "{\"bittery_accounts_list\":null}".into(),
        "Legacy Desktop store is malformed",
    ));
    let mut bad = store();
    bad["bittery_accounts_list"] = json!(json!({"version":1,"accounts":[metadata()]}).to_string());
    cases.push((
        bad.to_string(),
        "Legacy Desktop Account list is unsupported",
    ));
    let mut bad = store();
    bad["bittery_accounts_list"] =
        json!(json!({"version":2,"accounts":[metadata(),metadata()]}).to_string());
    cases.push((
        bad.to_string(),
        "Legacy Desktop Account identity is duplicated",
    ));
    let mut bad = store();
    bad["bittery_accounts_list"] = json!(json!({"version":2,"accounts":[[
        ACCOUNT,"Person@example.test","original-user","Original","https://example.test",
        null,null,"A3-ABCDEF",1700000000000_u64,1700000000123_u64,false,false
    ]]})
    .to_string());
    cases.push((bad.to_string(), "Legacy Desktop Account list is malformed"));
    let mut bad = store();
    bad[format!("bittery_account_{ACCOUNT}_pinned_kdf_params")] = json!(
        "{\"schemaVersion\":1,\"algorithm\":\"pbkdf2-sha256\",\"iterations\":600000,\"iterations\":600001}"
    );
    cases.push((bad.to_string(), "Legacy Desktop pinned KDF is malformed"));
    let mut bad = store();
    bad[format!("bittery_account_{ACCOUNT}_server_url")] = json!("https://foreign.example.test");
    cases.push((
        bad.to_string(),
        "Legacy Desktop Server identity disagrees with Account metadata",
    ));
    let mut bad = store();
    bad[format!("bittery_account_{ACCOUNT}_biometric_enabled")] = json!("yes");
    cases.push((
        bad.to_string(),
        "Legacy Desktop biometric enrollment is malformed",
    ));
    let mut bad = store();
    bad["bittery_master_password_reentry_period_ms"] = json!("12oops");
    cases.push((
        bad.to_string(),
        "Legacy Desktop security preference is malformed",
    ));
    let mut bad = store();
    bad["record:unknown:items:kept"] = json!("opaque evidence");
    cases.push((
        bad.to_string(),
        "Legacy Desktop store contains unsupported evidence",
    ));
    for (store, message) in cases {
        let mut source = Populated::valid();
        source.store = store;
        assert_eq!(refused(Arc::new(source)).await.message, message);
    }
}

#[tokio::test]
async fn malformed_pending_work_is_never_omitted_from_admission() {
    let mut source = Populated::valid();
    source.sync=Some(json!({"bittery_pending_mutation_queues_v3":json!({ACCOUNT:[{"kind":"create","id":"original-operation"}]}).to_string()}).to_string());
    assert_eq!(
        refused(Arc::new(source)).await.message,
        "Legacy Desktop Item command queues are malformed"
    );
}

#[tokio::test]
async fn missing_or_conflicting_protected_identity_cannot_become_signed_out() {
    for invalid in [0, 1, 2] {
        let mut source = Populated::valid();
        source.credentials[invalid] = None;
        assert_eq!(
            refused(Arc::new(source)).await.message,
            "Legacy Desktop Quick Unlock evidence is incomplete"
        );
    }
    let mut source = Populated::valid();
    let mut session: Value = serde_json::from_str(source.credentials[2].as_ref().unwrap()).unwrap();
    session["userId"] = json!("foreign-user");
    source.credentials[2] = Some(session.to_string());
    assert_eq!(
        refused(Arc::new(source)).await.message,
        "Legacy Desktop Session identity disagrees with Account metadata"
    );
}

#[tokio::test]
async fn nested_key_arrays_and_null_password_evidence_are_not_accepted_as_documents() {
    for (field, value) in [
        (
            "encryptedMasterUnlockKey",
            json!(["original-ciphertext", "original-iv", "AES-GCM-AAD-V1"]),
        ),
        ("lastMasterPasswordEntry", Value::Null),
    ] {
        let mut source = Populated::valid();
        let mut session: Value =
            serde_json::from_str(source.credentials[2].as_ref().unwrap()).unwrap();
        session[field] = value;
        source.credentials[2] = Some(session.to_string());
        assert_eq!(
            refused(Arc::new(source)).await.message,
            "Legacy Desktop Session data is malformed"
        );
    }
}

#[tokio::test]
async fn complete_retained_session_is_validated_without_expiry_refresh_or_dispatch() {
    let mut source = Populated::valid();
    source.credentials[3] = Some("original-expired-token".into());
    source.credentials[4] = Some("[]".into());
    source.credentials[5] = Some("original-encrypted-private-key".into());
    let mut session: Value = serde_json::from_str(source.credentials[2].as_ref().unwrap()).unwrap();
    session["serverExpiresAt"] = json!(1700000000001_u64);
    session["lastMasterPasswordEntry"] = json!(1699999999123_u64);
    source.credentials[2] = Some(session.to_string());
    assert_eq!(refused(Arc::new(source)).await.message, STAGING_UNAVAILABLE);
}

#[tokio::test]
async fn retained_session_vault_keys_must_be_objects_even_when_array_fields_fit() {
    let mut source = Populated::valid();
    source.credentials[3] = Some("original-token".into());
    source.credentials[4] = Some(
        json!([[
            "encrypted-key",
            "owner",
            null,
            "vault-a",
            null,
            "Personal",
            "personal"
        ]])
        .to_string(),
    );
    source.credentials[5] = Some("encrypted-private-key".into());
    assert_eq!(
        refused(Arc::new(source)).await.message,
        "Legacy Desktop retained Session keys are malformed"
    );
}
