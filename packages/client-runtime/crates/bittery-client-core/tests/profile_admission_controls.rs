use bittery_client_core::{
    PlatformStorageResponse, ProfileAdmissionRequest, ProfileAdmissionResponse,
    ProfileSnapshotCloseSelector,
};

#[test]
fn platform_inventory_end_rejects_a_contradictory_cursor() {
    let response = r#"{
        "type": "keysPage",
        "version": 1,
        "family": "platformStorage",
        "backingAreas": ["devicePlain"],
        "keys": [],
        "continuation": {"type": "end", "cursor": "contradictory"}
    }"#;

    assert!(
        serde_json::from_str::<PlatformStorageResponse>(response).is_err(),
        "End cannot accept a cursor and claim the physical census is complete"
    );
}

#[test]
fn source_cleanup_controls_reject_extra_fields_without_changing_valid_wire() {
    assert!(serde_json::from_str::<ProfileAdmissionResponse>(
        r#"{"type":"sourceSnapshotClosed","released":false}"#
    )
    .is_err());
    assert!(serde_json::from_str::<ProfileAdmissionRequest>(
        r#"{"type":"closeSourceSnapshot","selector":{"type":"currentCapability","handle":"exact-snapshot"}}"#
    )
    .is_err());

    assert_eq!(
        serde_json::to_string(&ProfileAdmissionResponse::SourceSnapshotClosed {}).unwrap(),
        r#"{"type":"sourceSnapshotClosed"}"#
    );
    assert_eq!(
        serde_json::to_string(&ProfileAdmissionRequest::CloseSourceSnapshot {
            selector: ProfileSnapshotCloseSelector::CurrentCapability {},
        })
        .unwrap(),
        r#"{"type":"closeSourceSnapshot","selector":{"type":"currentCapability"}}"#
    );
}

#[cfg(not(target_arch = "wasm32"))]
mod inventory_objects {
    use super::*;
    use async_trait::async_trait;
    use bittery_client_core::{
        AttachmentArtifactInventoryContinuation, AttachmentArtifactInventoryPage,
        AttachmentArtifactPhysicalKey, AuthClientConfig, ClientPlatform, LegacyProfileFormat,
        PlatformStorageKeysPage, PlatformStorageRequest, ProfileAdmissionSource, Runtime,
        RuntimeError, RuntimeErrorCode, SerializedHttpExecutor, SerializedPlatformStorageExecutor,
        SerializedProfileAdmissionExecutor, SerializedReplicaExecutor,
        VaultImageInventoryContinuation, VaultImageInventoryPage, VaultImagePhysicalKey,
    };
    use serde::de::DeserializeOwned;
    use std::sync::{Arc, Mutex};
    use zeroize::Zeroizing;

    const EMPTY_REPLICA: &str = r#"{"type":"inventoryPage","version":1,"family":"replica","entries":[],"continuation":{"type":"end"}}"#;
    const AFTER_REPLICA: &str = "Fixture reached Platform inventory after Replica decoding";
    const INVALID_REPLICA: &str = "Replica persistence returned an invalid response";

    // Only the Replica reply is substituted. Runtime still owns decoding, admission ordering,
    // and source cleanup; this fixture makes no claim about a physical store or Web adapter.
    struct InventoryReply {
        replica: &'static str,
        calls: Mutex<Vec<&'static str>>,
    }

    #[async_trait]
    impl SerializedReplicaExecutor for InventoryReply {
        async fn invoke(&self, request: String) -> Result<String, RuntimeError> {
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&request).unwrap(),
                serde_json::json!({"type":"inventory", "cursor":null})
            );
            self.calls.lock().unwrap().push("inventory");
            Ok(self.replica.into())
        }
    }

    #[async_trait]
    impl SerializedPlatformStorageExecutor for InventoryReply {
        async fn invoke(
            &self,
            request: Zeroizing<String>,
        ) -> Result<Zeroizing<String>, RuntimeError> {
            match serde_json::from_str::<PlatformStorageRequest>(&request).unwrap() {
                PlatformStorageRequest::Get { .. } => {
                    Ok(Zeroizing::new(r#"{"type":"value","value":null}"#.into()))
                }
                PlatformStorageRequest::ListKeys { .. } => {
                    self.calls.lock().unwrap().push("after-replica");
                    Err(RuntimeError {
                        code: RuntimeErrorCode::StorageUnavailable,
                        message: AFTER_REPLICA.into(),
                        recovery_bound: None,
                        team_page_problem: None,
                    })
                }
                _ => panic!("Raw-control refusal must not write destination storage"),
            }
        }
    }

    #[async_trait]
    impl SerializedHttpExecutor for InventoryReply {
        async fn invoke(&self, _: Zeroizing<String>) -> Result<String, RuntimeError> {
            panic!("Raw-control admission must not issue HTTP")
        }
        fn cancel(&self, _: &str) {}
    }

    #[async_trait]
    impl SerializedProfileAdmissionExecutor for InventoryReply {
        async fn invoke(
            &self,
            request: Zeroizing<String>,
        ) -> Result<(Zeroizing<String>, Option<Zeroizing<Vec<u8>>>), RuntimeError> {
            let response = match serde_json::from_str::<ProfileAdmissionRequest>(&request).unwrap()
            {
                ProfileAdmissionRequest::BeginSourceSnapshot { format } => {
                    assert_eq!(format, LegacyProfileFormat::DesktopLegacyV1);
                    self.calls.lock().unwrap().push("begin");
                    r#"{"type":"sourceSnapshot","snapshot":{"format":"desktopLegacyV1","snapshotHandle":"control-snapshot","profileIdentity":"control-profile","captureId":"control-capture","families":[{"family":"desktopStore","presence":"missing"},{"family":"desktopSyncStore","presence":"missing"},{"family":"desktopCredentials","presence":"missing"}]}}"#
                }
                ProfileAdmissionRequest::CloseSourceSnapshot { selector } => {
                    assert_eq!(
                        selector,
                        ProfileSnapshotCloseSelector::Exact {
                            handle: "control-snapshot".into()
                        }
                    );
                    self.calls.lock().unwrap().push("close");
                    r#"{"type":"sourceSnapshotClosed"}"#
                }
                ProfileAdmissionRequest::ReadSourcePage { .. } => {
                    panic!("Destination inventory must precede source decoding")
                }
                ProfileAdmissionRequest::ReopenSourceSnapshot { .. }
                | ProfileAdmissionRequest::PrepareLegacyProfileReset { .. }
                | ProfileAdmissionRequest::ResetLegacySourceFamily { .. }
                | ProfileAdmissionRequest::ReopenSourceForCleanup { .. }
                | ProfileAdmissionRequest::DeleteCapturedSource { .. }
                | ProfileAdmissionRequest::VerifySourceSnapshot { .. } => {
                    panic!("Initial inventory refusal cannot verify or reopen a snapshot")
                }
            };
            Ok((Zeroizing::new(response.into()), None))
        }
    }

    async fn decode_replica_reply(reply: &'static str) -> (RuntimeError, Vec<&'static str>) {
        let fixture = Arc::new(InventoryReply {
            replica: reply,
            calls: Mutex::new(Vec::new()),
        });
        let runtime = Runtime::with_configured_serialized_executors(
            fixture.clone(),
            fixture.clone(),
            fixture.clone(),
            AuthClientConfig::new(
                "inventory-controls".into(),
                ClientPlatform::Desktop,
                "0.5.2".into(),
            )
            .unwrap(),
        );
        runtime
            .set_profile_admission_source(ProfileAdmissionSource::Legacy {
                format: LegacyProfileFormat::DesktopLegacyV1,
                executor: fixture.clone(),
            })
            .await
            .unwrap();
        let error = runtime
            .open()
            .await
            .expect_err("The fixture always refuses admission");
        runtime.close().await;
        let calls = fixture.calls.lock().unwrap().clone();
        (error, calls)
    }

    fn require_object<T: DeserializeOwned>(
        label: &'static str,
        object: &str,
        array: &str,
        accepted: &mut Vec<&'static str>,
    ) {
        assert!(serde_json::from_str::<T>(object).is_ok(), "valid {label}");
        if serde_json::from_str::<T>(array).is_ok() {
            accepted.push(label);
        }
    }

    #[tokio::test]
    async fn inventory_controls_require_objects_at_serialized_and_direct_dto_boundaries() {
        let mut accepted = Vec::new();
        require_object::<PlatformStorageResponse>(
            "serialized Platform continuation",
            r#"{"type":"keysPage","version":1,"family":"platformStorage","backingAreas":["devicePlain"],"keys":[],"continuation":{"type":"end"}}"#,
            r#"{"type":"keysPage","version":1,"family":"platformStorage","backingAreas":["devicePlain"],"keys":[],"continuation":["end"]}"#,
            &mut accepted,
        );
        require_object::<PlatformStorageKeysPage>(
            "direct Platform page DTO",
            r#"{"version":1,"family":"platformStorage","backingAreas":["devicePlain"],"keys":[],"continuation":{"type":"end"}}"#,
            r#"[1,"platformStorage",["devicePlain"],[],{"type":"end"}]"#,
            &mut accepted,
        );

        let (valid_error, valid_calls) = decode_replica_reply(EMPTY_REPLICA).await;
        assert_eq!(valid_error.message, AFTER_REPLICA);
        assert_eq!(
            valid_calls,
            ["begin", "inventory", "after-replica", "close"]
        );
        for (label, reply) in [
            (
                "serialized Replica continuation",
                r#"{"type":"inventoryPage","version":1,"family":"replica","entries":[],"continuation":["end"]}"#,
            ),
            (
                "serialized Replica physical key",
                r#"{"type":"inventoryPage","version":1,"family":"replica","entries":[["head","orphan-account"]],"continuation":{"type":"end"}}"#,
            ),
            (
                "serialized Replica page",
                r#"["inventoryPage",1,"replica",[],{"type":"end"}]"#,
            ),
        ] {
            let (error, calls) = decode_replica_reply(reply).await;
            assert_eq!(calls.first(), Some(&"begin"));
            assert_eq!(calls.last(), Some(&"close"));
            if error.message == INVALID_REPLICA {
                assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
                assert_eq!(calls, ["begin", "inventory", "close"]);
            } else {
                assert!(
                    error.message == AFTER_REPLICA
                        || error.message
                            == "Profile admission found unexplained destination Replica records",
                    "unexpected {label} error: {error:?}"
                );
                accepted.push(label);
            }
        }

        // These are public Core DTOs, also used as typed keys inside owner-local cursors.
        // Attachment and Vault-image inventory are not wired Web controls at this stage.
        require_object::<AttachmentArtifactInventoryPage>(
            "direct Attachment page DTO",
            r#"{"version":1,"family":"attachmentArtifacts","schema":"sqliteV1","entries":[],"continuation":{"type":"end"}}"#,
            r#"[1,"attachmentArtifacts","sqliteV1",[],{"type":"end"}]"#,
            &mut accepted,
        );
        require_object::<AttachmentArtifactPhysicalKey>(
            "direct Attachment physical key DTO",
            r#"{"type":"provisionalChunk","accountId":"account","operationId":"operation","attachmentId":"attachment","generation":"generation","chunkIndex":0}"#,
            r#"["provisionalChunk","account","operation","attachment","generation",0]"#,
            &mut accepted,
        );
        require_object::<AttachmentArtifactInventoryContinuation>(
            "direct Attachment continuation DTO",
            r#"{"type":"end"}"#,
            r#"["end"]"#,
            &mut accepted,
        );
        require_object::<VaultImageInventoryPage>(
            "direct Vault-image page DTO",
            r#"{"version":1,"family":"vaultImages","schema":"sqliteV1","entries":[],"continuation":{"type":"end"}}"#,
            r#"[1,"vaultImages","sqliteV1",[],{"type":"end"}]"#,
            &mut accepted,
        );
        require_object::<VaultImagePhysicalKey>(
            "direct Vault-image physical key DTO",
            r#"{"type":"metadata","accountId":"account","operationId":"operation","publicationId":""}"#,
            r#"["metadata","account","operation",""]"#,
            &mut accepted,
        );
        require_object::<VaultImageInventoryContinuation>(
            "direct Vault-image continuation DTO",
            r#"{"type":"end"}"#,
            r#"["end"]"#,
            &mut accepted,
        );
        assert!(
            accepted.is_empty(),
            "Array-shaped inventory controls were accepted: {accepted:?}"
        );
    }
}
