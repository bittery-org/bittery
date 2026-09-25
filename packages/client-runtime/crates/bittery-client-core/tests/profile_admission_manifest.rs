use bittery_client_core::{
    LegacyProfileFormat, ProfileAdmissionRequest, ProfileAdmissionResponse,
    ProfileGlobalCredentialField, ProfileSourceEvidenceDigest, ProfileSourceFamily,
    ProfileSourceManifestDigest, ProfileSourceManifestEntry, ProfileSourceManifestHeader,
    ProfileSourceObservation, ProfileSourceReopenStep, ProfileSourceSelector,
    ProfileSourceVerificationResult, ProfileSourceVerifyStep,
};

#[test]
fn manifest_digest_framing_has_one_shared_exact_vector() {
    let file = ProfileSourceManifestEntry::from_evidence(
        LegacyProfileFormat::DesktopLegacyV1,
        ProfileSourceFamily::DesktopStore,
        ProfileSourceSelector::WholeFile {},
        ProfileSourceObservation::FileBytes { length: 3 },
        Some("linux:8:42".into()),
        &[0, 255, 65],
    )
    .unwrap();
    assert_eq!(
        file.evidence_sha256,
        "6d2d978bdb005d623fe96695bf0b4a5f96d412f25075ad0e59ae09c71c3012ba"
    );

    let missing = ProfileSourceManifestEntry::from_evidence(
        LegacyProfileFormat::DesktopLegacyV1,
        ProfileSourceFamily::DesktopCredentials,
        ProfileSourceSelector::GlobalCredential {
            field: ProfileGlobalCredentialField::DeviceKey,
        },
        ProfileSourceObservation::Missing {},
        None,
        &[],
    )
    .unwrap();
    assert_eq!(
        missing.evidence_sha256,
        "60130a8e10f52d2beebc0a9c918fbeef2d8dd9c996f818b411865f7f711b8e69"
    );

    let mut digest =
        ProfileSourceManifestDigest::new(LegacyProfileFormat::DesktopLegacyV1, "profile-é", 2)
            .unwrap();
    digest.append(&file).unwrap();
    digest.append(&missing).unwrap();
    assert_eq!(
        digest.finish().unwrap(),
        "a96c89d50b27a592f7d39262f1af7fe02f8fca47db4563e667043836cc73f638"
    );
}

fn header(entries_sha256: &str) -> ProfileSourceManifestHeader {
    ProfileSourceManifestHeader {
        version: 1,
        format: LegacyProfileFormat::DesktopLegacyV1,
        profile_identity: "profile".into(),
        recorded_capture_id: "original-capture".into(),
        entry_count: 1,
        entries_sha256: entries_sha256.into(),
    }
}

#[test]
fn evidence_digest_streams_exact_bytes_and_rejects_incompatible_evidence() {
    let selector = ProfileSourceSelector::WholeFile {};
    let observation = ProfileSourceObservation::FileBytes { length: 3 };
    let mut streamed = ProfileSourceEvidenceDigest::new(
        LegacyProfileFormat::DesktopLegacyV1,
        ProfileSourceFamily::DesktopStore,
        &selector,
        &observation,
        Some("linux:8:42"),
    )
    .unwrap();
    streamed.update(&[0]).unwrap();
    streamed.update(&[255, 65]).unwrap();
    assert_eq!(
        streamed.finish().unwrap(),
        "6d2d978bdb005d623fe96695bf0b4a5f96d412f25075ad0e59ae09c71c3012ba"
    );

    let mut short = ProfileSourceEvidenceDigest::new(
        LegacyProfileFormat::DesktopLegacyV1,
        ProfileSourceFamily::DesktopStore,
        &selector,
        &observation,
        Some("linux:8:42"),
    )
    .unwrap();
    short.update(&[0, 255]).unwrap();
    assert!(short.finish().is_err());

    assert!(ProfileSourceEvidenceDigest::new(
        LegacyProfileFormat::ExtensionLegacyV1,
        ProfileSourceFamily::DesktopStore,
        &selector,
        &observation,
        Some("linux:8:42"),
    )
    .is_err());
    assert!(ProfileSourceEvidenceDigest::new(
        LegacyProfileFormat::DesktopLegacyV1,
        ProfileSourceFamily::DesktopStore,
        &selector,
        &observation,
        None,
    )
    .is_err());
    assert!(ProfileSourceManifestEntry::from_evidence(
        LegacyProfileFormat::DesktopLegacyV1,
        ProfileSourceFamily::DesktopCredentials,
        ProfileSourceSelector::GlobalCredential {
            field: ProfileGlobalCredentialField::DeviceKey,
        },
        ProfileSourceObservation::Missing {},
        None,
        &[1],
    )
    .is_err());
}

#[test]
fn bounded_verify_and_reopen_controls_keep_modes_and_steps_closed() {
    let valid_header = header(&"0".repeat(64));
    let verify = ProfileAdmissionRequest::VerifySourceSnapshot {
        step: ProfileSourceVerifyStep::Start {
            verification_attempt_id: "attempt-2".into(),
            snapshot_handle: "live-source".into(),
            header: valid_header.clone(),
        },
    };
    verify.validate().unwrap();
    assert_eq!(
        serde_json::to_string(&verify).unwrap(),
        format!(
            "{{\"type\":\"verifySourceSnapshot\",\"step\":{{\"type\":\"start\",\"verificationAttemptId\":\"attempt-2\",\"snapshotHandle\":\"live-source\",\"header\":{{\"version\":1,\"format\":\"desktopLegacyV1\",\"profileIdentity\":\"profile\",\"recordedCaptureId\":\"original-capture\",\"entryCount\":\"1\",\"entriesSha256\":\"{}\"}}}}}}",
            "0".repeat(64)
        )
    );

    let reopen = ProfileAdmissionRequest::ReopenSourceSnapshot {
        step: ProfileSourceReopenStep::Start {
            verification_attempt_id: "attempt-3".into(),
            header: valid_header,
        },
    };
    reopen.validate().unwrap();
    let reopen_wire = serde_json::to_string(&reopen).unwrap();
    assert!(!reopen_wire.contains("snapshotHandle"));
    assert!(
        serde_json::from_str::<ProfileAdmissionRequest>(&reopen_wire.replace(
            "\"verificationAttemptId\":\"attempt-3\"",
            "\"verificationAttemptId\":\"attempt-3\",\"snapshotHandle\":\"old\"",
        ))
        .is_err()
    );

    let response = ProfileAdmissionResponse::SourceSnapshotVerification {
        result: ProfileSourceVerificationResult::Matched {
            verification_cursor: "bound-cursor".into(),
            next_index: 1,
        },
    };
    assert_eq!(
        serde_json::to_string(&response).unwrap(),
        r#"{"type":"sourceSnapshotVerification","result":{"type":"matched","verificationCursor":"bound-cursor","nextIndex":"1"}}"#
    );
}

#[test]
fn manifest_fields_reject_noncanonical_hashes_versions_and_incomplete_counts() {
    let mut invalid = header(&"A".repeat(64));
    assert!(invalid.validate().is_err());
    invalid.entries_sha256 = "0".repeat(64);
    invalid.version = 2;
    assert!(invalid.validate().is_err());

    let digest =
        ProfileSourceManifestDigest::new(LegacyProfileFormat::DesktopLegacyV1, "profile", 1)
            .unwrap();
    assert!(digest.finish().is_err());

    let missing = ProfileSourceManifestEntry::from_evidence(
        LegacyProfileFormat::DesktopLegacyV1,
        ProfileSourceFamily::DesktopCredentials,
        ProfileSourceSelector::GlobalCredential {
            field: ProfileGlobalCredentialField::DeviceKey,
        },
        ProfileSourceObservation::Missing {},
        None,
        &[],
    )
    .unwrap();
    let mut zero =
        ProfileSourceManifestDigest::new(LegacyProfileFormat::DesktopLegacyV1, "profile", 0)
            .unwrap();
    assert!(zero.append(&missing).is_err());

    let wire = serde_json::to_string(&missing).unwrap();
    assert!(wire.contains(r#""fileIdentity":null"#));
    assert!(serde_json::from_str::<ProfileSourceManifestEntry>(
        &wire.replace(r#","fileIdentity":null"#, "")
    )
    .is_err());
}
