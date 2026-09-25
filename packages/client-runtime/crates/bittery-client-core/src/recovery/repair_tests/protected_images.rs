use super::*;
use crate::recovery::{archive::EntryHeader, transfer::ArchiveReader};
use crate::vault_image::{
    protected::ProtectedImageWriter, VaultImageArtifactMetadata, VaultImageArtifactScope,
};

pub(super) fn protected_fixture() -> (Arc<Storage>, RecoveryIdentity, Vec<u8>) {
    let (storage, identity, image, _) = fixture();
    let original = VaultImageArtifactMetadata::new(
        VaultImageArtifactScope::new(identity.account_id.clone(), "image").unwrap(),
        "vault",
        image.len() as u64,
        "image/png",
        format!("{:x}", Sha256::digest(&image)),
    )
    .unwrap();
    let mut writer = ProtectedImageWriter::new(original.scope().clone(), "vault", "user").unwrap();
    let ciphertext = writer.push(&image).unwrap();
    let protection = writer.finish(&original, &[7; 32]).unwrap();
    let mut entries = storage.entries.lock().unwrap();
    entries.retain(|entry| {
        matches!(
            entry.record,
            RecoveryRecord::RawReplicaHead { .. } | RecoveryRecord::RawReplicaRow { .. }
        )
    });
    for entry in entries.iter_mut() {
        if let RecoveryRecord::RawReplicaRow {
            store: ReplicaStore::Operations,
            payload_json,
            ..
        } = &mut entry.record
        {
            let mut operation: OperationRecord = serde_json::from_str(payload_json).unwrap();
            operation
                .create_vault
                .as_mut()
                .unwrap()
                .image
                .as_mut()
                .unwrap()
                .protected_witness = Some(protection.witness.clone());
            *payload_json = serde_json::to_string(&operation).unwrap();
        }
    }
    entries.push(Entry {record:RecoveryRecord::ProtectedVaultImageMetadata {
        account_id: "account".into(), operation_id: "image".into(), publication_id: protection.witness.publication_id.clone(),
        metadata_json:json!({"accountId":"account", "operationId":"image", "vaultId":"vault",
        "publicationId":protection.witness.publication_id, "byteLength":image.len().to_string(), "contentType":"image/png",
        "sha256":original.sha256(), "published":true, "protection":protection}).to_string(),
    }, bytes:None});
    entries.push(Entry {
        record: RecoveryRecord::ProtectedVaultImageChunk {
            account_id: "account".into(),
            operation_id: "image".into(),
            publication_id: protection.witness.publication_id,
            chunk_index: 0,
        },
        bytes: Some(ciphertext),
    });
    drop(entries);
    (storage, identity, image)
}
async fn protected_port(storage: &Arc<Storage>, device_key: Option<[u8; 32]>) -> RecoveryPort {
    let physical = crate::platform_storage::PlatformStorage::new(
        crate::runtime::operation_fixtures::MemoryPlatform::new(),
    );
    if let Some(key) = device_key {
        physical
            .store_device_key(&crate::platform_storage::DeviceKeyDocument::new(key))
            .await
            .unwrap();
    }
    make_port(storage).with_platform_storage(physical)
}
#[tokio::test]
async fn opaque_protected_image_coverage_matches_the_original_accepted_witness() {
    let (storage, identity, _) = protected_fixture();
    assert!(
        capture(&make_port(&storage), &identity.account_id)
            .await
            .unwrap()
            .complete
    );
}
#[tokio::test]
async fn protected_image_export_contains_only_an_encrypted_portable_artifact_key() {
    let (storage, identity, image) = protected_fixture();
    let port = protected_port(&storage, Some([7; 32])).await;
    let before = storage.durable();
    let snapshot = capture(&port, &identity.account_id).await.unwrap();
    let (_, classification) = export_snapshot(
        &port,
        &identity.account_id,
        Some(identity.server_url.clone()),
        Some(identity.user_id.clone()),
        "separate recovery password",
        "sink",
        &snapshot,
    )
    .await
    .unwrap();
    assert_eq!(classification, RecoveryClassification::Complete);
    let mut reader = ArchiveReader::open(
        &port,
        &identity.account_id,
        "source",
        "separate recovery password",
    )
    .await
    .unwrap();
    assert!(matches!(
        reader.next().await.unwrap().unwrap().header,
        EntryHeader::Manifest { version: 2, .. }
    ));
    let mut keys = 0;
    while let Some(record) = reader.next().await.unwrap() {
        if matches!(record.header, EntryHeader::ProtectedVaultImageKey { .. }) {
            keys += 1;
            assert!(!record.body.windows(image.len()).any(|bytes| bytes == image));
            assert!(!record.body.windows(44).any(|bytes| {
                bytes
                    == base64::engine::general_purpose::STANDARD
                        .encode([7; 32])
                        .as_bytes()
            }));
        }
    }
    assert_eq!(keys, 1);
    assert!(storage.durable() == before);
}

#[tokio::test]
async fn protected_archive_repair_rewraps_only_the_key_and_retries_lost_commit_without_new_revision(
) {
    for destination_key in [[7; 32], [8; 32]] {
        let (storage, identity, plaintext) = protected_fixture();
        let source_port = protected_port(&storage, Some([7; 32])).await;
        let original = storage.durable();
        let snapshot = capture(&source_port, &identity.account_id).await.unwrap();
        export_snapshot(
            &source_port,
            &identity.account_id,
            Some(identity.server_url.clone()),
            Some(identity.user_id.clone()),
            "separate recovery password",
            "sink",
            &snapshot,
        )
        .await
        .unwrap();
        corrupt_derived(&storage);
        storage.entries.lock().unwrap().retain(|entry| {
            !matches!(
                entry.record,
                RecoveryRecord::ProtectedVaultImageChunk { .. }
            ) && !(destination_key != [7; 32]
                && matches!(
                    entry.record,
                    RecoveryRecord::ProtectedVaultImageMetadata { .. }
                ))
        });
        let destination = protected_port(&storage, Some(destination_key)).await;
        let current = capture(&destination, &identity.account_id).await.unwrap();
        assert!(!current.complete);
        storage.lose_commit_response.store(true, Ordering::SeqCst);
        let error = repair_bundle(
            &destination,
            &identity,
            &current,
            "separate recovery password",
            "source",
        )
        .await
        .expect_err("lost commit reply");
        assert_eq!(
            error.code,
            RuntimeErrorCode::StorageUnavailable,
            "Only the injected committed response loss may stop repair"
        );
        let repaired = capture(&destination, &identity.account_id).await.unwrap();
        assert!(
            repaired.complete,
            "Lost commit reply must leave the fully repaired original work"
        );
        let revision = repaired.proof.as_ref().unwrap().head.replica_revision;
        assert_eq!(revision, 6);
        assert_eq!(
            repair_bundle(
                &destination,
                &identity,
                &repaired,
                "separate recovery password",
                "source"
            )
            .await
            .unwrap(),
            revision
        );
        let entries = storage.entries.lock().unwrap();
        let metadata = entries
            .iter()
            .find_map(|entry| match &entry.record {
                RecoveryRecord::ProtectedVaultImageMetadata { metadata_json, .. } => Some(
                    serde_json::from_str::<crate::recovery::artifacts::ImageMetadata>(
                        metadata_json,
                    )
                    .unwrap(),
                ),
                _ => None,
            })
            .unwrap();
        let chunks: Vec<_> = entries
            .iter()
            .filter(|entry| {
                matches!(
                    entry.record,
                    RecoveryRecord::ProtectedVaultImageChunk { .. }
                )
            })
            .map(|entry| entry.bytes.clone().unwrap())
            .collect();
        let protection = metadata.protection.as_ref().unwrap();
        let output = crate::vault_image::protected::read_protected_image(
            &metadata.original().unwrap(),
            "user",
            &protection.witness,
            protection,
            &chunks,
            &destination_key,
        )
        .unwrap();
        assert_eq!(output.as_slice(), plaintext);
        drop(entries);
        assert!(original
            .iter()
            .filter(|(key, _, _)| key.starts_with("1/") || key.starts_with("7/"))
            .all(|expected| storage.durable().contains(expected)));
    }
}

#[tokio::test]
async fn unavailable_image_key_preserves_ciphertext_but_never_claims_a_complete_portable_archive() {
    for key in [None, Some([8; 32])] {
        let (storage, identity, _) = protected_fixture();
        let before = storage.durable();
        let port = protected_port(&storage, key).await;
        let snapshot = capture(&port, &identity.account_id).await.unwrap();
        assert!(snapshot.complete, "Physical encrypted work still exists");
        let (_, classification) = export_snapshot(
            &port,
            &identity.account_id,
            Some(identity.server_url.clone()),
            Some(identity.user_id.clone()),
            "separate recovery password",
            "sink",
            &snapshot,
        )
        .await
        .unwrap();
        assert_eq!(classification, RecoveryClassification::Partial);
        let decoded = super::report_cases::decode_archive(&storage.source.lock().unwrap());
        assert!(decoded
            .iter()
            .any(|record| matches!(record.header, EntryHeader::ProtectedVaultImageChunk { .. })));
        assert!(!decoded
            .iter()
            .any(|record| matches!(record.header, EntryHeader::ProtectedVaultImageKey { .. })));
        let report = decoded
            .iter()
            .find(|record| matches!(record.header, EntryHeader::Report))
            .unwrap();
        let report = crate::recovery::report::RecoveryReport::decode(&report.body).unwrap();
        assert!(report.findings.iter().any(|finding| matches!(finding, crate::recovery::report::RecoveryFinding::UnavailableVaultImageKey {operation_id} if operation_id == "image")));
        assert!(storage.durable() == before);
    }
}

#[tokio::test]
async fn authenticated_protected_archive_refuses_missing_keys_scope_substitution_and_legacy_headers_before_writes(
) {
    use super::report_cases::{copy_records, decode_archive, encode_archive};
    let (storage, identity, _) = protected_fixture();
    let port = protected_port(&storage, Some([7; 32])).await;
    let snapshot = capture(&port, &identity.account_id).await.unwrap();
    export_snapshot(
        &port,
        &identity.account_id,
        Some(identity.server_url.clone()),
        Some(identity.user_id.clone()),
        "separate recovery password",
        "sink",
        &snapshot,
    )
    .await
    .unwrap();
    let records = decode_archive(&storage.source.lock().unwrap());
    corrupt_derived(&storage);
    storage.entries.lock().unwrap().retain(|entry| {
        !matches!(
            entry.record,
            RecoveryRecord::ProtectedVaultImageChunk { .. }
        )
    });
    let current = capture(&port, &identity.account_id).await.unwrap();
    let before = storage.durable();
    for case in [
        "missing-key",
        "foreign-publication",
        "foreign-user",
        "legacy-manifest",
        "wrong-key-length",
        "changed-ciphertext",
    ] {
        let mut mutated = copy_records(&records);
        let key_index = mutated
            .iter()
            .position(|record| matches!(record.header, EntryHeader::ProtectedVaultImageKey { .. }))
            .unwrap();
        match case {
            "missing-key" => {
                mutated.remove(key_index);
                let report = mutated.last_mut().unwrap();
                let mut value: serde_json::Value = serde_json::from_slice(&report.body).unwrap();
                value["exportedRecordCount"] =
                    json!(value["exportedRecordCount"].as_u64().unwrap() - 1);
                *report.body = serde_json::to_vec(&value).unwrap();
            }
            "foreign-publication" => {
                if let EntryHeader::ProtectedVaultImageKey { publication_id, .. } =
                    &mut mutated[key_index].header
                {
                    *publication_id = "other-publication".into();
                }
            }
            "foreign-user" => {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&mutated[key_index].body).unwrap();
                value["binding"]["identity"]["userId"] = json!("another-user");
                *mutated[key_index].body = serde_json::to_vec(&value).unwrap();
            }
            "legacy-manifest" => {
                if let EntryHeader::Manifest { version, .. } = &mut mutated[0].header {
                    *version = 1;
                }
            }
            "wrong-key-length" => {
                let mut value: serde_json::Value =
                    serde_json::from_slice(&mutated[key_index].body).unwrap();
                value["artifactKey"] = json!("AA==");
                *mutated[key_index].body = serde_json::to_vec(&value).unwrap();
            }
            "changed-ciphertext" => {
                mutated
                    .iter_mut()
                    .find(|record| {
                        matches!(record.header, EntryHeader::ProtectedVaultImageChunk { .. })
                    })
                    .unwrap()
                    .body[0] ^= 1;
            }
            _ => unreachable!(),
        }
        *storage.source.lock().unwrap() = encode_archive(&mutated);
        assert!(
            repair_bundle(
                &port,
                &identity,
                &current,
                "separate recovery password",
                "source"
            )
            .await
            .is_err(),
            "{case}"
        );
        assert!(
            storage.durable() == before,
            "{case} must fail before adding an artifact or changing accepted work"
        );
        assert_eq!(storage.commits.load(Ordering::SeqCst), 0);
    }
}
