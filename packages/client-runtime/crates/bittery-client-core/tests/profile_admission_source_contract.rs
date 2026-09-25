use bittery_client_core::{
    ProfileAccountCredentialField, ProfileAdmissionRequest, ProfileAdmissionResponse,
    ProfileGlobalCredentialField, ProfileSourceContinuation, ProfileSourceFamily,
    ProfileSourceObservation, ProfileSourcePage, ProfileSourceSelector,
    ProfileSourceStringEncoding, ProfileSourceValueKind, PROFILE_SOURCE_BINARY_BYTES,
    PROFILE_SOURCE_CURSOR_BYTES, PROFILE_SOURCE_IDENTITY_BYTES,
};
use serde_json::json;

fn file_page(length: u64, byte_length: u64) -> ProfileSourcePage {
    ProfileSourcePage {
        snapshot_handle: "live-source".into(),
        family: ProfileSourceFamily::DesktopStore,
        selector: ProfileSourceSelector::WholeFile {},
        observation: ProfileSourceObservation::FileBytes { length },
        offset: 0,
        byte_length,
        continuation: ProfileSourceContinuation::End {},
    }
}

fn valid(page: &ProfileSourcePage, bytes: Option<&[u8]>) -> bool {
    page.validate_for(
        "live-source",
        page.family,
        &page.selector,
        page.offset,
        None,
        bytes,
    )
    .is_ok()
}

#[test]
fn source_request_preserves_opaque_account_and_requires_explicit_nullable_cursor() {
    let request = ProfileAdmissionRequest::ReadSourcePage {
        snapshot_handle: "live-source".into(),
        family: ProfileSourceFamily::DesktopCredentials,
        selector: ProfileSourceSelector::AccountCredential {
            account_id: "acct_legacy_fallback_1".into(),
            field: ProfileAccountCredentialField::SessionData,
        },
        cursor: None,
    };
    request.validate().unwrap();
    let encoded = serde_json::to_string(&request).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&encoded).unwrap(),
        json!({
            "type":"readSourcePage", "snapshotHandle":"live-source",
            "family":"desktopCredentials", "cursor":null,
            "selector":{"type":"accountCredential","accountId":"acct_legacy_fallback_1","field":"sessionData"}
        })
    );
    assert_eq!(
        serde_json::from_str::<ProfileAdmissionRequest>(&encoded).unwrap(),
        request
    );
    for malformed in [
        encoded.replace(",\"cursor\":null", ""),
        encoded.replace("\"cursor\":null", "\"cursor\":null,\"cursor\":\"later\""),
        encoded.replace(
            "\"field\":\"sessionData\"",
            "\"field\":\"sessionData\",\"field\":\"jwtToken\"",
        ),
        encoded.replace("\"accountId\":", "\"path\":\"/arbitrary\",\"accountId\":"),
    ] {
        assert!(serde_json::from_str::<ProfileAdmissionRequest>(&malformed).is_err());
    }
}

#[test]
fn source_page_wire_keeps_lossless_decimal_counts_and_rejects_contradictory_fields() {
    let mut page = file_page(u64::MAX, 1);
    page.offset = u64::MAX - 1;
    let wire = serde_json::to_string(&ProfileAdmissionResponse::SourcePage(page.clone())).unwrap();
    let value: serde_json::Value = serde_json::from_str(&wire).unwrap();
    assert_eq!(value["type"], "sourcePage");
    assert_eq!(value["observation"]["length"], u64::MAX.to_string());
    assert_eq!(value["offset"], (u64::MAX - 1).to_string());
    assert_eq!(value["byteLength"], "1");
    assert!(value.get("page").is_none());
    assert!(value.get("binaryChunk").is_none());
    assert!(valid(&page, Some(&[1])));
    assert_eq!(
        serde_json::from_str::<ProfileAdmissionResponse>(&wire).unwrap(),
        ProfileAdmissionResponse::SourcePage(page)
    );
    for replacement in [
        "1",
        "\"01\"",
        "\"+1\"",
        "\"-1\"",
        "\"18446744073709551616\"",
    ] {
        let malformed = wire.replace(
            "\"byteLength\":\"1\"",
            &format!("\"byteLength\":{replacement}"),
        );
        assert!(serde_json::from_str::<ProfileAdmissionResponse>(&malformed).is_err());
    }
    for malformed in [
        wire.replace(
            "\"byteLength\":\"1\"",
            "\"byteLength\":\"1\",\"byteLength\":\"2\"",
        ),
        wire.replace("\"type\":\"end\"", "\"type\":\"end\",\"cursor\":\"later\""),
        wire.replace(
            "\"type\":\"wholeFile\"",
            "\"type\":\"wholeFile\",\"path\":\"store.json\"",
        ),
        wire.replace(
            "\"type\":\"fileBytes\"",
            "\"type\":\"fileBytes\",\"value\":\"hidden\"",
        ),
    ] {
        assert!(serde_json::from_str::<ProfileAdmissionResponse>(&malformed).is_err());
    }
}

#[test]
fn source_controls_require_objects_at_outer_and_nested_control_boundaries() {
    let page =
        serde_json::to_string(&ProfileAdmissionResponse::SourcePage(file_page(1, 1))).unwrap();
    assert!(serde_json::from_str::<ProfileAdmissionResponse>(&page).is_ok());
    let snapshot = json!({
        "type":"sourceSnapshot",
        "snapshot":{
            "format":"desktopLegacyV1", "snapshotHandle":"live-source",
            "profileIdentity":"profile", "captureId":"capture",
            "families":[
                {"family":"desktopStore","presence":"present"},
                {"family":"desktopSyncStore","presence":"missing"},
                {"family":"desktopCredentials","presence":"missing"}
            ]
        }
    });
    let mut snapshot_array = snapshot.clone();
    snapshot_array["snapshot"] = json!([
        "desktopLegacyV1",
        "live-source",
        "profile",
        "capture",
        snapshot["snapshot"]["families"],
        null
    ]);
    let mut family_array = snapshot.clone();
    family_array["snapshot"]["families"][0] = json!(["desktopStore", "present"]);
    assert!(serde_json::from_value::<ProfileAdmissionResponse>(snapshot).is_ok());
    let candidates = [
        ("outer response", r#"["sourceSnapshotClosed"]"#.to_owned()),
        (
            "selector",
            page.replace(r#"{"type":"wholeFile"}"#, r#"["wholeFile"]"#),
        ),
        (
            "continuation",
            page.replace(r#"{"type":"end"}"#, r#"["end"]"#),
        ),
        (
            "observation",
            page.replace(
                r#"{"type":"fileBytes","length":"1"}"#,
                r#"["fileBytes","1"]"#,
            ),
        ),
        ("snapshot", snapshot_array.to_string()),
        ("family inventory", family_array.to_string()),
    ];
    let mut accepted: Vec<_> = candidates
        .iter()
        .filter_map(|(label, wire)| {
            serde_json::from_str::<ProfileAdmissionResponse>(wire)
                .is_ok()
                .then_some(*label)
        })
        .collect();
    for (label, wire) in [
        (
            "outer request",
            r#"["beginSourceSnapshot","desktopLegacyV1"]"#,
        ),
        (
            "close selector",
            r#"{"type":"closeSourceSnapshot","selector":["currentCapability"]}"#,
        ),
    ] {
        if serde_json::from_str::<ProfileAdmissionRequest>(wire).is_ok() {
            accepted.push(label);
        }
    }
    if serde_json::from_str::<ProfileSourcePage>(
        r#"["live-source","desktopStore",{"type":"wholeFile"},{"type":"fileBytes","length":"1"},"0","1",{"type":"end"}]"#,
    ).is_ok() {
        accepted.push("page");
    }
    assert!(
        accepted.is_empty(),
        "array-shaped source controls were accepted at {accepted:?}"
    );
}

#[test]
fn bounded_source_pages_preserve_contiguous_large_file_bytes_and_exact_end() {
    let bytes = vec![83; PROFILE_SOURCE_BINARY_BYTES];
    let mut first = file_page(bytes.len() as u64 + 3, bytes.len() as u64);
    first.continuation = ProfileSourceContinuation::More {
        cursor: "next-page".into(),
    };
    assert!(valid(&first, Some(&bytes)));
    let mut last = first.clone();
    last.offset = first.byte_length;
    last.byte_length = 3;
    last.continuation = ProfileSourceContinuation::End {};
    last.validate_for(
        "live-source",
        first.family,
        &first.selector,
        first.byte_length,
        Some(&first.observation),
        Some(&[1, 2, 3]),
    )
    .unwrap();

    assert!(last
        .validate_for(
            "other-owner",
            first.family,
            &first.selector,
            first.byte_length,
            Some(&first.observation),
            Some(&[1, 2, 3])
        )
        .is_err());
    assert!(last
        .validate_for(
            "live-source",
            ProfileSourceFamily::DesktopSyncStore,
            &first.selector,
            first.byte_length,
            Some(&first.observation),
            Some(&[1, 2, 3])
        )
        .is_err());
    assert!(last
        .validate_for(
            "live-source",
            first.family,
            &first.selector,
            first.byte_length + 1,
            Some(&first.observation),
            Some(&[1, 2, 3])
        )
        .is_err());
    assert!(last
        .validate_for(
            "live-source",
            first.family,
            &first.selector,
            first.byte_length,
            Some(&ProfileSourceObservation::FileBytes { length: 7 }),
            Some(&[1, 2, 3])
        )
        .is_err());
    assert!(!valid(&last, None));
    assert!(!valid(&last, Some(&[1, 2])));
    first.continuation = ProfileSourceContinuation::End {};
    assert!(
        !valid(&first, Some(&bytes)),
        "a short response cannot claim End"
    );
    last.continuation = ProfileSourceContinuation::More {
        cursor: "again".into(),
    };
    assert!(
        !valid(&last, Some(&[1, 2, 3])),
        "More cannot continue beyond the total"
    );
    let oversized = vec![1; PROFILE_SOURCE_BINARY_BYTES + 1];
    assert!(!valid(
        &file_page(oversized.len() as u64, oversized.len() as u64),
        Some(&oversized)
    ));
    let mut overflow = file_page(u64::MAX, 1);
    overflow.offset = u64::MAX;
    assert!(!valid(&overflow, Some(&[1])));
    let mut stalled = file_page(1, 0);
    stalled.continuation = ProfileSourceContinuation::More {
        cursor: "stalled".into(),
    };
    assert!(!valid(&stalled, Some(&[])));
}

#[test]
fn source_observations_keep_missing_unsupported_and_present_empty_distinct() {
    let mut page = ProfileSourcePage {
        family: ProfileSourceFamily::DesktopCredentials,
        selector: ProfileSourceSelector::GlobalCredential {
            field: ProfileGlobalCredentialField::DeviceKey,
        },
        observation: ProfileSourceObservation::Missing {},
        ..file_page(0, 0)
    };
    assert!(valid(&page, None));
    assert!(!valid(&page, Some(&[])));
    page.observation = ProfileSourceObservation::PresentUnsupported {
        value_kind: ProfileSourceValueKind::Null,
    };
    assert!(valid(&page, None));
    assert!(!valid(&page, Some(&[])));
    page.observation = ProfileSourceObservation::StoredString {
        encoding: ProfileSourceStringEncoding::Utf8,
        length: 0,
    };
    assert!(valid(&page, Some(&[])));
    assert!(!valid(&page, None));
    page.observation = ProfileSourceObservation::FileBytes { length: 0 };
    assert!(
        !valid(&page, Some(&[])),
        "a credential string is not a physical file"
    );
    assert!(valid(&file_page(0, 0), Some(&[])));
    assert!(!valid(&file_page(0, 0), None));
    page.observation = ProfileSourceObservation::StoredString {
        encoding: ProfileSourceStringEncoding::Utf8,
        length: 4,
    };
    page.byte_length = 2;
    page.continuation = ProfileSourceContinuation::More {
        cursor: "utf8-tail".into(),
    };
    assert!(
        valid(&page, Some(&[0xf0, 0x9f])),
        "raw pages may split a UTF8 character"
    );
}

#[test]
fn source_selectors_reject_foreign_families_and_bound_opaque_identity_bytes() {
    let mut request = ProfileAdmissionRequest::ReadSourcePage {
        snapshot_handle: "live-source".into(),
        family: ProfileSourceFamily::DesktopStore,
        selector: ProfileSourceSelector::WholeFile {},
        cursor: None,
    };
    request.validate().unwrap();
    let ProfileAdmissionRequest::ReadSourcePage { family, .. } = &mut request else {
        unreachable!()
    };
    *family = ProfileSourceFamily::ExtensionRecords;
    assert!(request.validate().is_err());
    let ProfileAdmissionRequest::ReadSourcePage {
        family,
        selector,
        cursor,
        ..
    } = &mut request
    else {
        unreachable!()
    };
    *family = ProfileSourceFamily::DesktopCredentials;
    *selector = ProfileSourceSelector::AccountCredential {
        account_id: "é".repeat(PROFILE_SOURCE_IDENTITY_BYTES / 2 + 1).into(),
        field: ProfileAccountCredentialField::SecretKey,
    };
    *cursor = None;
    assert!(request.validate().is_err());
    let ProfileAdmissionRequest::ReadSourcePage {
        selector, cursor, ..
    } = &mut request
    else {
        unreachable!()
    };
    *selector = ProfileSourceSelector::AccountCredential {
        account_id: "acct_opaque".into(),
        field: ProfileAccountCredentialField::SecretKey,
    };
    *cursor = Some(String::new());
    assert!(request.validate().is_err());
    let ProfileAdmissionRequest::ReadSourcePage { cursor, .. } = &mut request else {
        unreachable!()
    };
    *cursor = Some("x".repeat(PROFILE_SOURCE_CURSOR_BYTES + 1));
    assert!(request.validate().is_err());
    let ProfileAdmissionRequest::ReadSourcePage { cursor, .. } = &mut request else {
        unreachable!()
    };
    *cursor = Some("x".repeat(PROFILE_SOURCE_CURSOR_BYTES));
    request.validate().unwrap();
}
