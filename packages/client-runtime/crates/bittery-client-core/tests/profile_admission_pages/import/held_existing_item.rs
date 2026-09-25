use super::held_update::{expected_confirmed_item, mutate_queue, replica_rows};
use super::*;

fn held_metadata_source(
    kind: &str,
    favorite: Option<bool>,
    trashed: bool,
    status: &str,
) -> Arc<Source> {
    let mut source = queued_metadata::metadata_source(kind, favorite, trashed);
    mutate_queue(&mut source, |queue| {
        let command = &mut queue[0];
        command["status"] = json!(status);
        command["retryCount"] = json!(3);
        command["lastError"] = json!("legacy metadata attempt stopped");
        command["nextAttemptAt"] = json!(1_800_000_000_123_u64);
        command["conflictCopyId"] = json!("conflict-copy:metadata");
        command["projectionClaimId"] = json!("departed-metadata-projector");
        command["projectionClaimExpiresAt"] = json!(1_800_000_000_456_u64);
    });
    source
}

fn payloads(rows: &[Value], store: &str) -> Vec<Value> {
    rows.iter()
        .filter(|row| row["store"] == store)
        .map(|row| serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap())
        .collect()
}

#[derive(Clone, Copy, Debug)]
enum HeldKind {
    Favorite(Option<bool>),
    Trash,
    Restore { trashed: bool },
    PermanentDelete { trashed: bool },
    Move { same_vault: bool, attachments: bool },
}

const HELD_KINDS: [HeldKind; 12] = [
    HeldKind::Favorite(Some(true)),
    HeldKind::Favorite(Some(false)),
    HeldKind::Favorite(None),
    HeldKind::Trash,
    HeldKind::Restore { trashed: false },
    HeldKind::Restore { trashed: true },
    HeldKind::PermanentDelete { trashed: false },
    HeldKind::PermanentDelete { trashed: true },
    HeldKind::Move {
        same_vault: true,
        attachments: false,
    },
    HeldKind::Move {
        same_vault: true,
        attachments: true,
    },
    HeldKind::Move {
        same_vault: false,
        attachments: false,
    },
    HeldKind::Move {
        same_vault: false,
        attachments: true,
    },
];

fn apply_held_history(source: &mut Arc<Source>, status: &str, error: &str) {
    mutate_queue(source, |queue| {
        let command = &mut queue[0];
        command["status"] = json!(status);
        command["retryCount"] = json!(3);
        command["lastError"] = json!(error);
        command["nextAttemptAt"] = json!(1_800_000_000_123_u64);
        command["conflictCopyId"] = json!("conflict-copy:metadata");
        command["projectionClaimId"] = json!("departed-metadata-projector");
        command["projectionClaimExpiresAt"] = json!(1_800_000_000_456_u64);
    });
}

fn set_all_vault_roles(source: &mut Arc<Source>, role: &str) {
    let fixture = Arc::get_mut(source).expect("held fixture has one owner");
    let mut keys: Vec<Value> =
        serde_json::from_str(fixture.inner.credentials[4].as_ref().unwrap()).unwrap();
    for key in &mut keys {
        key["role"] = json!(role);
    }
    fixture.inner.credentials[4] = Some(serde_json::to_string(&keys).unwrap());
}

impl HeldKind {
    fn source(self, status: &str) -> Arc<Source> {
        let mut source = match self {
            Self::Favorite(favorite) => {
                queued_metadata::metadata_source("toggle_favorite", favorite, false)
            }
            Self::Trash => queued_metadata::metadata_source("delete", None, false),
            Self::Restore { trashed } => queued_metadata::metadata_source("restore", None, trashed),
            Self::PermanentDelete { trashed } => {
                queued_metadata::metadata_source("permanent_delete", None, trashed)
            }
            Self::Move {
                same_vault,
                attachments,
            } => queued_move::move_source(same_vault, attachments),
        };
        apply_held_history(&mut source, status, "legacy existing-Item attempt stopped");
        set_all_vault_roles(&mut source, "read-only");
        source
    }

    fn wire_id(self) -> &'static str {
        match self {
            Self::Favorite(None) => "source-command:metadata",
            Self::Move {
                same_vault: true, ..
            } => "source-command:move",
            Self::Move { .. } => "attempt:move",
            _ => "attempt:metadata",
        }
    }

    fn request(self) -> Value {
        match self {
            Self::Favorite(favorite) => json!({
                "method":"PATCH",
                "path":"/api/v1/items/item%3Aoffline/favorite",
                "headers":[
                    {"name":"Content-Type", "value":"application/merge-patch+json"},
                    {"name":"If-Match", "value":"\"6\""}
                ],
                "body":format!("{{\"favorite\":{}}}", favorite.unwrap_or(false)).into_bytes()
            }),
            Self::Trash => json!({
                "method":"DELETE",
                "path":"/api/v1/items/item%3Aoffline",
                "headers":[{"name":"If-Match", "value":"\"6\""}],
                "body":Vec::<u8>::new()
            }),
            Self::Restore { .. } => json!({
                "method":"POST",
                "path":"/api/v1/items/item%3Aoffline/restore",
                "headers":[{"name":"If-Match", "value":"\"6\""}],
                "body":Vec::<u8>::new()
            }),
            Self::PermanentDelete { .. } => json!({
                "method":"DELETE",
                "path":"/api/v1/items/item%3Aoffline/permanent",
                "headers":[{"name":"If-Match", "value":"\"6\""}],
                "body":Vec::<u8>::new()
            }),
            Self::Move { same_vault, .. } => {
                let target = if same_vault {
                    "vault:offline"
                } else {
                    "vault:target"
                };
                json!({
                    "method":"POST",
                    "path":"/api/v1/items/item%3Aoffline/moves",
                    "headers":[
                        {"name":"Content-Type", "value":"application/json"},
                        {"name":"If-Match", "value":"\"6\""}
                    ],
                    "body":format!("{{\"mode\":\"prepared\",\"sourceVaultId\":\"vault:offline\",\"targetVaultId\":\"{target}\",\"encryptedData\":\"updated-ciphertext\",\"encryptionIv\":\"updated-iv\",\"encryptionAlgorithm\":\"AES-GCM-AAD-V1\"}}").into_bytes()
                })
            }
        }
    }

    fn operation_kind(self) -> &'static str {
        match self {
            Self::Favorite(_) => "set_item_favorite",
            Self::Trash => "trash_item",
            Self::Restore { .. } => "restore_item",
            Self::PermanentDelete { .. } => "permanently_delete_item",
            Self::Move { .. } => "move_item",
        }
    }

    fn target_vault(self) -> &'static str {
        match self {
            Self::Move {
                same_vault: false, ..
            } => "vault:target",
            _ => "vault:offline",
        }
    }

    fn expected_source_command(self, status: &str) -> Value {
        let (id, semantic_id, attempt_id, kind) = match self {
            Self::Favorite(None) => (
                "source-command:metadata",
                "semantic:metadata",
                None,
                "toggle_favorite",
            ),
            Self::Favorite(_) => (
                "source-command:metadata",
                "semantic:metadata",
                Some("attempt:metadata"),
                "toggle_favorite",
            ),
            Self::Trash => (
                "source-command:metadata",
                "semantic:metadata",
                Some("attempt:metadata"),
                "delete",
            ),
            Self::Restore { .. } => (
                "source-command:metadata",
                "semantic:metadata",
                Some("attempt:metadata"),
                "restore",
            ),
            Self::PermanentDelete { .. } => (
                "source-command:metadata",
                "semantic:metadata",
                Some("attempt:metadata"),
                "permanent_delete",
            ),
            Self::Move {
                same_vault: true, ..
            } => ("source-command:move", "semantic:move", None, "move"),
            Self::Move { .. } => (
                "source-command:move",
                "semantic:move",
                Some("attempt:move"),
                "move",
            ),
        };
        let mut command = json!({
            "accountId":desktop::ACCOUNT,
            "accountEmail":"Person@example.test",
            "id":id,
            "operationId":semantic_id,
            "type":kind,
            "entityId":"item:offline",
            "vaultId":"vault:offline",
            "baseVersion":6,
            "timestamp":"1700000002000",
            "retryCount":"3",
            "status":status,
            "lastError":"legacy existing-Item attempt stopped",
            "nextAttemptAt":"1800000000123",
            "conflictCopyId":"conflict-copy:metadata",
            "projectionClaimId":"departed-metadata-projector",
            "projectionClaimExpiresAt":"1800000000456"
        });
        if let Some(attempt_id) = attempt_id {
            command["attemptId"] = json!(attempt_id);
        }
        if let Self::Favorite(Some(favorite)) = self {
            command["favorite"] = json!(favorite);
        }
        if let Self::Move { same_vault, .. } = self {
            command["targetVaultId"] = json!(if same_vault {
                "vault:offline"
            } else {
                "vault:target"
            });
            command["encryptedPayload"] = json!({
                "encryptionVersion":7,
                "encryptedByUserId":"original-user"
            });
        }
        command
    }

    fn expected_authority(self) -> Value {
        let mut authority = expected_confirmed_item();
        if matches!(
            self,
            Self::Restore { trashed: true } | Self::PermanentDelete { trashed: true }
        ) {
            authority["deletedAt"] = json!("2026-09-20T01:00:00Z");
        }
        if matches!(
            self,
            Self::Move {
                attachments: false,
                ..
            }
        ) {
            authority["attachments"] = json!([]);
        }
        authority
    }

    fn source_free_reopen(self, status: &str) -> bool {
        matches!(
            (self, status),
            (Self::Favorite(Some(true)), "failed")
                | (
                    Self::Move {
                        same_vault: false,
                        attachments: true
                    },
                    "conflicted"
                )
        )
    }
}

#[tokio::test]
async fn failed_favorite_with_exact_confirmed_base_is_admitted_without_an_overlay() {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    let source = held_metadata_source("toggle_favorite", Some(true), false, "failed");
    let runtime = runtime_with_platform_and_source(&directory, platform, source).await;

    runtime.open().await.unwrap();
    assert_locked(&runtime);
    let rows = replica_rows(&directory).await;
    let operations = payloads(&rows, "operations");
    assert_eq!(operations.len(), 1);
    let operation = &operations[0];
    assert_eq!(operation["operationId"], "attempt:metadata");
    assert_eq!(operation["kind"], "set_item_favorite");
    assert_eq!(operation["request"]["method"], "PATCH");
    assert_eq!(
        operation["request"]["path"],
        "/api/v1/items/item%3Aoffline/favorite"
    );
    assert_eq!(
        operation["request"]["headers"],
        json!([
            {"name":"Content-Type", "value":"application/merge-patch+json"},
            {"name":"If-Match", "value":"\"6\""}
        ])
    );
    assert_eq!(operation["request"]["body"], json!(b"{\"favorite\":true}"));
    let evidence = &operation["legacyAdmission"];
    assert_eq!(evidence["disposition"], "legacyFailed");
    assert_eq!(
        evidence["sourceCommand"]["operationId"],
        "semantic:metadata"
    );
    assert_eq!(evidence["sourceCommand"]["status"], "failed");
    assert_eq!(evidence["sourceCommand"]["retryCount"], "3");
    assert_eq!(
        evidence["sourceCommand"]["conflictCopyId"],
        "conflict-copy:metadata"
    );
    assert!(evidence.get("overlaySha256").is_none());
    assert!(evidence.get("capturedFailureCode").is_none());
    assert!(payloads(&rows, "optimisticItems").is_empty());
    let authority = payloads(&rows, "authorityItems");
    assert_eq!(authority.len(), 1);
    assert_eq!(authority[0]["category"], "login");
    assert_eq!(authority[0]["version"], 6);
    assert_eq!(authority[0]["encryptionVersion"], 3);
    assert_eq!(authority[0]["favorite"], true);
    runtime.close().await;
}

#[tokio::test]
async fn held_metadata_and_move_matrix_preserves_exact_requests_and_confirmed_authority() {
    for kind in HELD_KINDS {
        for status in ["failed", "conflicted"] {
            let directory = TestDirectory::new();
            let platform = Arc::new(RetainingPlatform::default());
            let source = kind.source(status);
            let runtime =
                runtime_with_platform_and_source(&directory, platform.clone(), source.clone())
                    .await;

            runtime.open().await.unwrap();
            assert_locked(&runtime);
            let rows = replica_rows(&directory).await;
            let operations = payloads(&rows, "operations");
            assert_eq!(operations.len(), 1, "{kind:?} {status}");
            let operation = &operations[0];
            assert_eq!(
                operation["operationId"],
                kind.wire_id(),
                "{kind:?} {status}"
            );
            assert_eq!(
                operation["kind"],
                kind.operation_kind(),
                "{kind:?} {status}"
            );
            assert_eq!(
                operation["acceptedItemCategory"], "login",
                "{kind:?} {status}"
            );
            assert_eq!(
                operation["target"],
                json!({
                    "type":"item",
                    "itemId":"item:offline",
                    "vaultId":kind.target_vault()
                }),
                "{kind:?} {status}"
            );
            assert_eq!(operation["request"], kind.request(), "{kind:?} {status}");
            let evidence = &operation["legacyAdmission"];
            assert_eq!(evidence["sourceQueueIndex"], "0", "{kind:?} {status}");
            assert_eq!(
                evidence["disposition"],
                if status == "failed" {
                    "legacyFailed"
                } else {
                    "legacyConflicted"
                },
                "{kind:?} {status}"
            );
            assert_eq!(
                evidence["sourceCommand"],
                kind.expected_source_command(status),
                "{kind:?} {status}"
            );
            assert!(evidence.get("overlaySha256").is_none(), "{kind:?} {status}");
            assert!(
                evidence.get("capturedFailureCode").is_none(),
                "{kind:?} {status}"
            );
            assert_eq!(operation["scheduling"]["attemptCount"], "3");
            assert_eq!(operation["scheduling"]["notBeforeMs"], "1800000000123");
            assert!(payloads(&rows, "optimisticItems").is_empty());
            assert_eq!(
                payloads(&rows, "authorityItems"),
                vec![kind.expected_authority()],
                "{kind:?} {status}"
            );
            let vaults = payloads(&rows, "authorityVaults");
            assert_eq!(
                vaults.len(),
                if matches!(
                    kind,
                    HeldKind::Move {
                        same_vault: false,
                        ..
                    }
                ) {
                    2
                } else {
                    1
                },
                "{kind:?} {status}"
            );
            assert!(
                vaults.iter().all(|vault| vault["role"] == "readOnly"),
                "{kind:?} {status}"
            );
            runtime.close().await;

            if kind.source_free_reopen(status) {
                let source_calls = source.calls.lock().unwrap().len();
                let reopened = Runtime::with_serialized_executors(
                    Arc::new(SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap()),
                    platform,
                    Arc::new(NoNetwork),
                );
                reopened.open().await.unwrap();
                assert_locked(&reopened);
                assert_eq!(source.calls.lock().unwrap().len(), source_calls);
                assert_eq!(replica_rows(&directory).await, rows);
                reopened.close().await;
            }
        }
    }
}

fn remove_vault_key(source: &mut Arc<Source>, vault_id: &str) {
    let fixture = Arc::get_mut(source).expect("held Move fixture has one owner");
    let mut keys: Vec<Value> =
        serde_json::from_str(fixture.inner.credentials[4].as_ref().unwrap()).unwrap();
    keys.retain(|key| key["vaultId"] != vault_id);
    fixture.inner.credentials[4] = Some(serde_json::to_string(&keys).unwrap());
}

fn hide_vault(source: &mut Arc<Source>, vault_id: &str) {
    let fixture = Arc::get_mut(source).expect("held Move fixture has one owner");
    let mut store: Value = serde_json::from_str(&fixture.inner.store).unwrap();
    store[format!("bittery_account_{}_travel_mode_cache", desktop::ACCOUNT)] = json!(json!({
        "enabled":true,
        "hiddenVaultIds":[vault_id],
        "enabledAt":1_700_000_000_000_u64,
        "updatedAt":1_700_000_001_000_u64
    })
    .to_string());
    fixture.inner.store = store.to_string();
}

async fn assert_held_move_scope_refused(source: Arc<Source>, case: &str) {
    let directory = TestDirectory::new();
    let platform = Arc::new(RetainingPlatform::default());
    platform.values.lock().unwrap().insert(
        (
            "deviceSecret".into(),
            "unrelated-protected-reference".into(),
        ),
        "unchanged protected evidence".into(),
    );
    let protected_before = platform.values.lock().unwrap().clone();
    let replica = SqliteReplica::open(directory.0.join("replica.sqlite")).unwrap();
    let replica_before: Value = serde_json::from_str(
        &SerializedReplicaExecutor::invoke(
            &replica,
            json!({"type":"load","accountId":desktop::ACCOUNT}).to_string(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    let store_before = source.inner.store.clone();
    let sync_before = source.inner.sync.clone();
    let credentials_before = source.inner.credentials.clone();
    let runtime =
        runtime_with_platform_and_source(&directory, platform.clone(), source.clone()).await;

    let error = runtime.open().await.expect_err(case);
    assert!(
        matches!(
            error.code,
            RuntimeErrorCode::SourceFailure | RuntimeErrorCode::InvariantViolation
        ),
        "{case}: {error:?}"
    );
    assert!(platform.sets.lock().unwrap().is_empty(), "{case}");
    assert_eq!(*platform.values.lock().unwrap(), protected_before, "{case}");
    let replica_after: Value = serde_json::from_str(
        &SerializedReplicaExecutor::invoke(
            &replica,
            json!({"type":"load","accountId":desktop::ACCOUNT}).to_string(),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(replica_after, replica_before, "{case}");
    assert_eq!(source.inner.store, store_before, "{case}");
    assert_eq!(source.inner.sync, sync_before, "{case}");
    assert_eq!(source.inner.credentials, credentials_before, "{case}");
    runtime.close().await;
}

#[tokio::test]
async fn held_move_requires_each_retained_vault_key_before_preparing() {
    for status in ["failed", "conflicted"] {
        for (fault, vault_id) in [
            ("missingSourceKey", "vault:offline"),
            ("missingTargetKey", "vault:target"),
        ] {
            let mut source = HeldKind::Move {
                same_vault: false,
                attachments: true,
            }
            .source(status);
            remove_vault_key(&mut source, vault_id);
            assert_held_move_scope_refused(source, &format!("{status}/{fault}")).await;
        }
    }
}

#[tokio::test]
async fn held_move_with_an_enabled_travel_queue_is_refused_before_preparing() {
    // Enabled legacy Travel plus queued work is refused as a whole at this frontier. Varying the
    // hidden ID preserves both source shapes, but does not claim the refusal reached a per-Vault
    // visibility check.
    for status in ["failed", "conflicted"] {
        for vault_id in ["vault:offline", "vault:target"] {
            let mut source = HeldKind::Move {
                same_vault: false,
                attachments: true,
            }
            .source(status);
            hide_vault(&mut source, vault_id);
            assert_held_move_scope_refused(source, &format!("{status}/enabledTravel/{vault_id}"))
                .await;
        }
    }
}
