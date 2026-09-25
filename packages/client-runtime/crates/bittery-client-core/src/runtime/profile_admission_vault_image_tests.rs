use super::*;
use crate::{
    AttachmentArtifactInventoryContinuation, AttachmentArtifactStore,
    AttachmentArtifactStoreRequest, AttachmentArtifactStoreResponse, SqliteAttachmentArtifactStore,
    SqliteVaultImageArtifactStore,
};

#[tokio::test]
async fn applicable_admission_preserves_unpublished_raw_vault_image_artifacts() {
    let directory = TestDirectory::new();
    let replica_path = directory.0.join("replica.sqlite");
    let attachment_path = directory.0.join("attachments.sqlite");
    let image_path = directory.0.join("vault-images.sqlite");
    let replica = Arc::new(RecordedReplica {
        inner: crate::replica::SqliteReplica::open(&replica_path).unwrap(),
        exchanges: Mutex::new(Vec::new()),
    });
    let attachments = Arc::new(SqliteAttachmentArtifactStore::open(&attachment_path).unwrap());
    let AttachmentArtifactStoreResponse::InventoryPage(empty_attachments) = attachments
        .invoke(AttachmentArtifactStoreRequest::Inventory { cursor: None })
        .await
        .unwrap()
    else {
        panic!("the installed Attachment owner must support physical inventory");
    };
    empty_attachments.validate().unwrap();
    assert!(empty_attachments.entries.is_empty());
    assert_eq!(
        empty_attachments.continuation,
        AttachmentArtifactInventoryContinuation::End {}
    );

    let scope = VaultImageArtifactScope::new(
        account("unexplained-image-account"),
        "unexplained-image-operation",
    )
    .unwrap();
    assert!(scope.publication_id().is_none());
    let bytes = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff];
    let seeded = SqliteVaultImageArtifactStore::open(&image_path).unwrap();
    // Real public writes create a partial raw generation under the empty publication ID.
    // No image metadata, publication, Account, or catalog authority is fabricated.
    seeded.begin(&scope).await.unwrap();
    assert_eq!(
        seeded.write_chunk(&scope, 0, &bytes).await.unwrap(),
        VaultImageChunkWrite::Stored
    );
    drop(seeded);
    let images = Arc::new(SqliteVaultImageArtifactStore::open(&image_path).unwrap());
    let generation = images
        .read_generation(&scope, None)
        .await
        .unwrap()
        .expect("the real partial raw generation must survive owner reopen");
    assert_eq!(generation.scope, scope);
    assert!(generation.metadata.is_none());

    let before_replica = physical_database_bytes(&replica_path);
    let before_attachments = physical_database_bytes(&attachment_path);
    let before_images = physical_database_bytes(&image_path);
    let platform = Arc::new(RecordedPlatform::default());
    let network = Arc::new(AdmissionNoNetwork::default());
    let source = Arc::new(RecordedEmptyDesktopSource::default());
    let runtime = Runtime::with_configured_serialized_executors_and_attachment_move_preparation(
        replica.clone(),
        platform.clone(),
        network.clone(),
        AuthClientConfig::new(
            "admission-test".into(),
            ClientPlatform::Desktop,
            "0.5.2".into(),
        )
        .unwrap(),
        AttachmentMovePreparationFacade::new(
            attachments.clone(),
            attachments.clone(),
            network.clone(),
        ),
        Arc::new(crate::runtime::attachment_move_lifecycle::TestAccountLeasePort),
    );
    // This existing startup source stub rejects claim/acceptance calls and permits the
    // ordinary source-retirement cleanup performed by Runtime.close.
    runtime.install_vault_image_ingress(
        VaultImageIngressFacade::new(
            "image-admission-runtime",
            Arc::new(UnusedVaultImageSource),
            images.clone(),
        )
        .unwrap(),
    );
    runtime
        .set_profile_admission_source(ProfileAdmissionSource::Legacy {
            format: LegacyProfileFormat::DesktopLegacyV1,
            executor: source.clone(),
        })
        .await
        .unwrap();

    let opened = runtime.open().await;
    let source_after_open = source.completed.lock().unwrap().clone();
    let unchanged_after_open = physical_database_bytes(&replica_path) == before_replica
        && physical_database_bytes(&attachment_path) == before_attachments
        && physical_database_bytes(&image_path) == before_images;
    let sink = Arc::new(Sink::default());
    let observation = runtime.observe(
        ObservationRequest::RuntimeStatus { account_id: None },
        sink.clone(),
    );
    let command = runtime
        .request(
            RuntimeRequest::LocalSecuritySettings {
                account_id: scope.account_id().clone(),
            },
            RequestCancellation::new(),
        )
        .await;
    // Check preservation through the public store only after capturing physical equality.
    let duplicate = images.write_chunk(&scope, 0, &bytes).await;
    let retained = images.read_generation(&scope, None).await;
    runtime.close().await;

    assert!(
        unchanged_after_open,
        "admission must preserve all three databases and optional WALs"
    );
    assert!(physical_database_bytes(&replica_path) == before_replica);
    assert!(physical_database_bytes(&attachment_path) == before_attachments);
    assert!(physical_database_bytes(&image_path) == before_images);
    assert_eq!(duplicate.unwrap(), VaultImageChunkWrite::AlreadyStored);
    assert_eq!(retained.unwrap(), Some(generation));
    assert_eq!(
        source_after_open,
        vec![
            ProfileAdmissionRequest::BeginSourceSnapshot {
                format: LegacyProfileFormat::DesktopLegacyV1,
            },
            ProfileAdmissionRequest::CloseSourceSnapshot {
                selector: ProfileSnapshotCloseSelector::Exact {
                    handle: "live-desktop-snapshot".into(),
                },
            },
        ]
    );
    assert_eq!(*source.completed.lock().unwrap(), source_after_open);
    assert!(observation.is_err());
    assert!(sink.0.lock().unwrap().is_empty());
    assert_eq!(
        command.unwrap_err().code,
        RuntimeErrorCode::InvariantViolation
    );
    assert_eq!(network.0.load(Ordering::SeqCst), 0);
    let replica_exchanges = replica.exchanges.lock().unwrap();
    assert!(!replica_exchanges.is_empty());
    assert!(replica_exchanges.iter().all(|(request, response)| {
        request == &json!({"type":"inventory", "cursor":null})
            && response
                == &json!({
                    "type":"inventoryPage", "version":1, "family":"replica",
                    "entries":[], "continuation":{"type":"end"}
                })
    }));
    let platform_exchanges = platform.exchanges.lock().unwrap();
    assert!(platform_exchanges
        .iter()
        .all(|(request, _)| { matches!(request["type"].as_str(), Some("get" | "listKeys")) }));
    for area in ["devicePlain", "deviceSecret", "sessionSecret"] {
        assert!(
            platform_exchanges.iter().any(|(request, response)| {
                request
                    == &json!({
                        "type":"listKeys", "area":area,
                        "prefix":"bittery:runtime:platform-storage:", "cursor":null
                    })
                    && response
                        == &json!({
                            "type":"keysPage", "version":1, "family":"platformStorage",
                            "backingAreas":[area], "keys":[], "continuation":{"type":"end"}
                        })
            }),
            "the destination platform census must prove {area} empty"
        );
    }
    assert!(platform.inner.values.lock().unwrap().is_empty());
    let error = opened.expect_err("an unpublished image must block empty profile admission");
    assert_eq!(
        error.message,
        "Profile admission found unexplained destination Vault image artifacts"
    );
    assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
}
