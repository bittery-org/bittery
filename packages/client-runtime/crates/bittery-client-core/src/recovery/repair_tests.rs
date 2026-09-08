mod report_capture;
mod report_cases;
use super::{
    capture::capture,
    control::{
        RecoveryControlRequest as Control, RecoveryControlResponse as Reply, RecoveryExpectedRow,
        RecoveryRecord, RecoveryUnavailableReason, SerializedRecoveryExecutor,
    },
    repair::{can_rebootstrap, can_repair, rebootstrap, repair_bundle, RecoveryIdentity},
    transfer::{export_snapshot, RecoveryPort},
};
use crate::http_transport::{HttpHeader, HttpMethod};
use crate::replica::persistence_contract::{ReplicaHead, ReplicaStore};
use crate::replica::{
    canonical_create_vault_request, CreateVaultCheckpoint, CreateVaultImageRecord,
    CreateVaultOperationRecord, ImmutableHttpRequest, OperationKind, OperationRecord,
    OperationSchedulingState, ResourceRef,
};
use crate::{RecoveryClassification, RequestCancellation, RuntimeError, RuntimeErrorCode};
use base64::Engine;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};

#[derive(Clone)]
struct Entry {
    record: RecoveryRecord,
    bytes: Option<Vec<u8>>,
}
#[derive(Default)]
struct Stage {
    expected: Vec<RecoveryExpectedRow>,
    rows: Vec<RecoveryRecord>,
    building: Option<(ReplicaStore, String, usize, Vec<u8>)>,
}
struct Storage {
    entries: Mutex<Vec<Entry>>,
    stage: Mutex<Stage>,
    sink: Mutex<Vec<u8>>,
    source: Mutex<Vec<u8>>,
    offset: Mutex<usize>,
    fail_stage: AtomicBool,
    fail_commit: AtomicBool,
    lose_commit_response: AtomicBool,
    tamper_guard: AtomicBool,
    commits: AtomicUsize,
    duplicate_second_row: AtomicBool,
    rewind_count: AtomicUsize,
    fail_eof_pass: AtomicUsize,
}
fn key(record: &RecoveryRecord) -> String {
    match record {
        RecoveryRecord::RawReplicaHead { account_id, .. } => format!("0/{account_id}"),
        RecoveryRecord::RawReplicaRow {
            account_id,
            store,
            record_id,
            ..
        } => format!("1/{account_id}/{store:?}/{record_id}"),
        RecoveryRecord::ArtifactMetadata {
            account_id,
            artifact_id,
            ..
        } => format!("2/{account_id}/{artifact_id}"),
        RecoveryRecord::ArtifactChunk {
            account_id,
            artifact_id,
            chunk_index,
            ..
        } => format!("3/{account_id}/{artifact_id}/{chunk_index:010}"),
        RecoveryRecord::ProvisionalMetadata {
            account_id,
            operation_id,
            attachment_id,
            generation,
            ..
        } => format!("4/{account_id}/{operation_id}/{attachment_id}/{generation}"),
        RecoveryRecord::ProvisionalChunk {
            account_id,
            operation_id,
            attachment_id,
            generation,
            chunk_index,
            ..
        } => {
            format!("5/{account_id}/{operation_id}/{attachment_id}/{generation}/{chunk_index:010}")
        }
        RecoveryRecord::VaultImageMetadata {
            account_id,
            operation_id,
            ..
        } => format!("6/{account_id}/{operation_id}"),
        RecoveryRecord::VaultImageChunk {
            account_id,
            operation_id,
            chunk_index,
        } => format!("7/{account_id}/{operation_id}/{chunk_index:010}"),
    }
}
impl Storage {
    fn new(entries: Vec<Entry>) -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(entries),
            stage: Mutex::new(Stage::default()),
            sink: Mutex::new(Vec::new()),
            source: Mutex::new(Vec::new()),
            offset: Mutex::new(0),
            fail_stage: AtomicBool::new(false),
            fail_commit: AtomicBool::new(false),
            lose_commit_response: AtomicBool::new(false),
            tamper_guard: AtomicBool::new(false),
            commits: AtomicUsize::new(0),
            duplicate_second_row: AtomicBool::new(false),
            rewind_count: AtomicUsize::new(0),
            fail_eof_pass: AtomicUsize::new(0),
        })
    }
    fn durable(&self) -> Vec<(String, String, Option<Vec<u8>>)> {
        let mut result: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    key(&entry.record),
                    serde_json::to_string(&entry.record).unwrap(),
                    entry.bytes.clone(),
                )
            })
            .collect();
        result.sort();
        result
    }
}
#[async_trait::async_trait]
impl SerializedRecoveryExecutor for Storage {
    async fn invoke(
        &self,
        request: String,
        binary: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
        let request: Control = serde_json::from_str(&request).unwrap();
        let mut response_bytes = None;
        let response = match request {
            Control::ReadEntry { cursor, .. } => {
                let index = cursor
                    .map(|cursor| cursor.parse::<usize>().unwrap())
                    .unwrap_or(0);
                let mut entries = self.entries.lock().unwrap().clone();
                entries.sort_by_key(|entry| key(&entry.record));
                if index == entries.len() {
                    Reply::End
                } else {
                    let actual = if self.duplicate_second_row.load(Ordering::SeqCst) && index == 2 {
                        1
                    } else {
                        index
                    };
                    let entry = entries[actual].clone();
                    response_bytes = entry.bytes;
                    Reply::Entry {
                        cursor: index.to_string(),
                        next_cursor: (index + 1 < entries.len()).then(|| (index + 1).to_string()),
                        record: entry.record,
                    }
                }
            }
            Control::SinkWrite { .. } => {
                let bytes = binary.unwrap();
                assert!(bytes.len() <= 256 * 1024);
                self.sink.lock().unwrap().extend(bytes);
                Reply::SinkWritten
            }
            Control::SinkCommit { .. } => {
                *self.source.lock().unwrap() = self.sink.lock().unwrap().clone();
                Reply::SinkCommitted
            }
            Control::SinkDiscard { .. } => {
                self.sink.lock().unwrap().clear();
                Reply::SinkDiscarded
            }
            Control::SourceRewind { .. } => {
                self.rewind_count.fetch_add(1, Ordering::SeqCst);
                *self.offset.lock().unwrap() = 0;
                Reply::SourceRewound
            }
            Control::SourceRead { max_bytes, .. } => {
                let source = self.source.lock().unwrap();
                let mut offset = self.offset.lock().unwrap();
                if *offset == source.len() {
                    if self.fail_eof_pass.load(Ordering::SeqCst)
                        == self.rewind_count.load(Ordering::SeqCst)
                    {
                        return Err(RuntimeError::new(
                            RuntimeErrorCode::StorageUnavailable,
                            "source EOF failed after authenticated terminal",
                        ));
                    }
                    Reply::SourceEnded
                } else {
                    let end = (*offset + max_bytes as usize).min(source.len());
                    response_bytes = Some(source[*offset..end].to_vec());
                    *offset = end;
                    Reply::SourceChunk
                }
            }
            Control::SourceClose { .. } => Reply::SourceClosed,
            Control::BeginRepairStage { .. } => {
                *self.stage.lock().unwrap() = Stage::default();
                Reply::RepairStageBegun
            }
            Control::StageExpectedRow { row, .. } => {
                self.stage.lock().unwrap().expected.push(row);
                Reply::ExpectedRowStaged
            }
            Control::StageRowStart {
                store,
                record_id,
                payload_byte_length,
                ..
            } => {
                assert!(self.stage.lock().unwrap().building.is_none());
                self.stage.lock().unwrap().building =
                    Some((store, record_id, payload_byte_length as usize, Vec::new()));
                Reply::RowStarted
            }
            Control::StageRowChunk { .. } => {
                self.stage
                    .lock()
                    .unwrap()
                    .building
                    .as_mut()
                    .unwrap()
                    .3
                    .extend(binary.unwrap());
                Reply::RowChunkStaged
            }
            Control::StageRowEnd { account_id, .. } => {
                if self.fail_stage.swap(false, Ordering::SeqCst) {
                    Reply::Unavailable {
                        reason: RecoveryUnavailableReason::Quota,
                    }
                } else {
                    let mut stage = self.stage.lock().unwrap();
                    let (store, record_id, length, body) = stage.building.take().unwrap();
                    assert_eq!(body.len(), length);
                    stage.rows.push(RecoveryRecord::RawReplicaRow {
                        account_id,
                        store,
                        record_id,
                        payload_json: String::from_utf8(body).unwrap(),
                    });
                    Reply::RowEnded
                }
            }
            Control::DiscardRepairStage { .. } => {
                *self.stage.lock().unwrap() = Stage::default();
                Reply::RepairStageDiscarded
            }
            Control::AddArtifactEntry { record, .. } => {
                let mut entries = self.entries.lock().unwrap();
                if let Some(existing) = entries
                    .iter()
                    .find(|entry| key(&entry.record) == key(&record))
                {
                    if existing.record != record || existing.bytes != binary {
                        Reply::Unavailable {
                            reason: RecoveryUnavailableReason::Corrupt,
                        }
                    } else {
                        Reply::ArtifactAdded
                    }
                } else {
                    entries.push(Entry {
                        record,
                        bytes: binary,
                    });
                    Reply::ArtifactAdded
                }
            }
            Control::CommitRepair {
                account_id,
                expected_head_json,
                next_head,
                staged_row_count,
                expected_row_count,
                ..
            } => {
                if self.fail_commit.swap(false, Ordering::SeqCst) {
                    Reply::Unavailable {
                        reason: RecoveryUnavailableReason::Quota,
                    }
                } else {
                    let mut entries = self.entries.lock().unwrap();
                    let stage = self.stage.lock().unwrap();
                    if self.tamper_guard.swap(false, Ordering::SeqCst) {
                        if let RecoveryRecord::RawReplicaRow { payload_json, .. } = &mut entries
                            .iter_mut()
                            .find(|entry| {
                                matches!(
                                    entry.record,
                                    RecoveryRecord::RawReplicaRow {
                                        store: ReplicaStore::Operations,
                                        ..
                                    }
                                )
                            })
                            .unwrap()
                            .record
                        {
                            payload_json.push(' ');
                        }
                    }
                    let head = entries.iter().find_map(|entry| match &entry.record {
                        RecoveryRecord::RawReplicaHead { payload_json, .. } => Some(payload_json),
                        _ => None,
                    });
                    let rows: Vec<_> = entries
                        .iter()
                        .filter_map(|entry| match &entry.record {
                            RecoveryRecord::RawReplicaRow {
                                store,
                                record_id,
                                payload_json,
                                ..
                            } => Some((*store, record_id, payload_json)),
                            _ => None,
                        })
                        .collect();
                    let guards = head == Some(&expected_head_json)
                        && rows.len() == expected_row_count as usize
                        && stage.expected.len() == rows.len()
                        && rows.iter().all(|(store, id, payload)| {
                            stage.expected.iter().any(|expected| {
                                expected.store == *store
                                    && expected.record_id == **id
                                    && expected.payload_sha256
                                        == format!("{:x}", Sha256::digest(payload.as_bytes()))
                            })
                        });
                    if !guards {
                        Reply::Stale
                    } else {
                        assert_eq!(stage.rows.len(), staged_row_count as usize);
                        entries.retain(|entry| {
                            !matches!(
                                entry.record,
                                RecoveryRecord::RawReplicaHead { .. }
                                    | RecoveryRecord::RawReplicaRow { .. }
                            )
                        });
                        entries.push(Entry {
                            record: RecoveryRecord::RawReplicaHead {
                                account_id,
                                payload_json: serde_json::to_string(&next_head).unwrap(),
                            },
                            bytes: None,
                        });
                        entries.extend(stage.rows.iter().cloned().map(|record| Entry {
                            record,
                            bytes: None,
                        }));
                        self.commits.fetch_add(1, Ordering::SeqCst);
                        if self.lose_commit_response.swap(false, Ordering::SeqCst) {
                            return Err(RuntimeError::new(
                                RuntimeErrorCode::StorageUnavailable,
                                "commit acknowledgement lost",
                            ));
                        }
                        Reply::Repaired
                    }
                }
            }
            _ => panic!("unexpected Core repair control"),
        };
        Ok((serde_json::to_string(&response).unwrap(), response_bytes))
    }
}
fn fixture() -> (Arc<Storage>, RecoveryIdentity, Vec<u8>, String) {
    let image=base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9kAAAAASUVORK5CYII=").unwrap();
    let hash = format!("{:x}", Sha256::digest(&image));
    let intent = CreateVaultOperationRecord {
        account_id: "account".into(),
        name: "Vault".into(),
        vault_type: crate::CreateVaultType::Personal,
        icon: "bank".into(),
        encrypted_vault_key: "wrapped".into(),
        image: Some(CreateVaultImageRecord {
            byte_length: image.len() as u64,
            content_type: "image/png".into(),
            sha256: hash.clone(),
            object_key: format!("vaults/user/vault/create/image-{hash}"),
        }),
        checkpoint: CreateVaultCheckpoint::ArtifactReady,
    };
    let canonical = canonical_create_vault_request("vault", &intent).unwrap();
    let operation = OperationRecord {
        operation_id: "image".into(),
        kind: OperationKind::CreateVault,
        target: ResourceRef::Vault {
            vault_id: "vault".into(),
        },
        request: ImmutableHttpRequest {
            method: HttpMethod::Put,
            path: canonical.path,
            headers: vec![HttpHeader {
                name: "Content-Type".into(),
                value: "application/json".into(),
            }],
            body: Vec::new(),
        },
        request_fingerprint: canonical.fingerprint,
        attachment_move_recovery: None,
        create_vault: Some(intent),
        scheduling: OperationSchedulingState::default(),
    };
    let payload = serde_json::to_string_pretty(&operation).unwrap();
    let head = ReplicaHead {
        account_id: "account".into(),
        user_id: "user".into(),
        incarnation: "incarnation".into(),
        replica_revision: 5,
        lock_epoch: 2,
        failure: None,
    };
    let entries=vec![
        Entry{record:RecoveryRecord::RawReplicaHead{account_id:"account".into(),payload_json:serde_json::to_string(&head).unwrap()},bytes:None},
        Entry{record:RecoveryRecord::RawReplicaRow{account_id:"account".into(),store:ReplicaStore::Operations,record_id:"image".into(),payload_json:payload.clone()},bytes:None},
        Entry{record:RecoveryRecord::VaultImageMetadata{account_id:"account".into(),operation_id:"image".into(),metadata_json:json!({"accountId":"account","operationId":"image","vaultId":"vault","byteLength":image.len().to_string(),"contentType":"image/png","sha256":hash,"published":true}).to_string()},bytes:None},
        Entry{record:RecoveryRecord::VaultImageChunk{account_id:"account".into(),operation_id:"image".into(),chunk_index:0},bytes:Some(image.clone())},
    ];
    (
        Storage::new(entries),
        RecoveryIdentity {
            account_id: "account".into(),
            incarnation: "incarnation".into(),
            user_id: "user".into(),
            server_url: "https://server.test".into(),
        },
        image,
        payload,
    )
}
fn make_port(storage: &Arc<Storage>) -> RecoveryPort {
    RecoveryPort::new_test(
        storage.clone(),
        "recovery".into(),
        RequestCancellation::default(),
    )
}
async fn export(storage: &Arc<Storage>, identity: &RecoveryIdentity) -> Vec<u8> {
    storage.sink.lock().unwrap().clear();
    let port = make_port(storage);
    let snapshot = capture(&port, &identity.account_id).await.unwrap();
    assert!(
        snapshot.complete,
        "complete={} read={} proof={} authority={} artifacts={} failure={:?}",
        snapshot.complete,
        snapshot.read_complete,
        snapshot.proof.is_some(),
        snapshot
            .proof
            .as_ref()
            .is_some_and(|proof| proof.authority_valid),
        snapshot.selection.is_some(),
        snapshot.failure
    );
    assert_eq!(
        export_snapshot(
            &port,
            &identity.account_id,
            Some(identity.server_url.clone()),
            Some(identity.user_id.clone()),
            "separate recovery password",
            "sink",
            &snapshot
        )
        .await
        .unwrap()
        .1,
        RecoveryClassification::Complete
    );
    storage.source.lock().unwrap().clone()
}
fn corrupt_derived(storage: &Storage) {
    storage.entries.lock().unwrap().push(Entry {
        record: RecoveryRecord::RawReplicaRow {
            account_id: "account".into(),
            store: ReplicaStore::AuthorityItems,
            record_id: "generation/item".into(),
            payload_json: "malformed derived row".into(),
        },
        bytes: None,
    });
}

#[tokio::test]
async fn complete_archive_repairs_missing_plaintext_image_preserving_exact_accepted_operation() {
    let (storage, identity, image, payload) = fixture();
    let archive = export(&storage, &identity).await;
    assert!(!archive.windows(image.len()).any(|window| window == image));
    corrupt_derived(&storage);
    storage
        .entries
        .lock()
        .unwrap()
        .retain(|entry| !matches!(entry.record, RecoveryRecord::VaultImageChunk { .. }));
    let port = make_port(&storage);
    let current = capture(&port, &identity.account_id).await.unwrap();
    assert!(!current.complete);
    assert!(can_repair(&current, &identity));
    assert!(!can_rebootstrap(&current, &identity));
    assert_eq!(
        repair_bundle(
            &port,
            &identity,
            &current,
            "separate recovery password",
            "source"
        )
        .await
        .unwrap(),
        6
    );
    let repaired = capture(&port, &identity.account_id).await.unwrap();
    assert!(repaired.complete);
    assert_eq!(repaired.proof.unwrap().head.lock_epoch, 3);
    let entries = storage.entries.lock().unwrap();
    assert!(entries.iter().any(|entry|matches!(&entry.record,RecoveryRecord::RawReplicaRow{store:ReplicaStore::Operations,payload_json,..}if payload_json==&payload)));
    assert!(entries
        .iter()
        .any(|entry| entry.bytes.as_ref() == Some(&image)));
    assert_eq!(storage.commits.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn guarded_rebootstrap_preserves_required_image_and_raw_work_and_refuses_unknown_work() {
    let (storage, identity, image, payload) = fixture();
    corrupt_derived(&storage);
    let port = make_port(&storage);
    let snapshot = capture(&port, &identity.account_id).await.unwrap();
    assert!(can_rebootstrap(&snapshot, &identity));
    assert_eq!(rebootstrap(&port, &identity, &snapshot).await.unwrap(), 6);
    assert!(capture(&port, &identity.account_id).await.unwrap().complete);
    {
        let entries = storage.entries.lock().unwrap();
        assert!(entries
            .iter()
            .any(|entry| entry.bytes.as_ref() == Some(&image)));
        assert!(entries.iter().any(|entry|matches!(&entry.record,RecoveryRecord::RawReplicaRow{payload_json,..}if payload_json==&payload)));
    }
    if let RecoveryRecord::RawReplicaRow { payload_json, .. } = &mut storage
        .entries
        .lock()
        .unwrap()
        .iter_mut()
        .find(|entry| {
            matches!(
                entry.record,
                RecoveryRecord::RawReplicaRow {
                    store: ReplicaStore::Operations,
                    ..
                }
            )
        })
        .unwrap()
        .record
    {
        *payload_json = "unknown accepted work".into();
    }
    let before = storage.durable();
    let corrupt = capture(&port, &identity.account_id).await.unwrap();
    assert!(corrupt.proof.is_none());
    assert!(!can_rebootstrap(&corrupt, &identity));
    assert!(rebootstrap(&port, &identity, &corrupt).await.is_err());
    assert_eq!(before, storage.durable());
}
#[tokio::test]
async fn failed_stage_and_commit_preserve_original_and_lost_commit_ack_replays_as_noop() {
    let (storage, identity, _, _) = fixture();
    export(&storage, &identity).await;
    corrupt_derived(&storage);
    let port = make_port(&storage);
    for fault in [&storage.fail_stage, &storage.fail_commit] {
        fault.store(true, Ordering::SeqCst);
        let current = capture(&port, &identity.account_id).await.unwrap();
        let before = storage.durable();
        assert!(repair_bundle(
            &port,
            &identity,
            &current,
            "separate recovery password",
            "source"
        )
        .await
        .is_err());
        assert_eq!(before, storage.durable());
        assert_eq!(storage.commits.load(Ordering::SeqCst), 0);
    }
    storage.lose_commit_response.store(true, Ordering::SeqCst);
    let current = capture(&port, &identity.account_id).await.unwrap();
    assert!(repair_bundle(
        &port,
        &identity,
        &current,
        "separate recovery password",
        "source"
    )
    .await
    .is_err());
    let current = capture(&port, &identity.account_id).await.unwrap();
    assert!(current.complete);
    assert_eq!(
        repair_bundle(
            &port,
            &identity,
            &current,
            "separate recovery password",
            "source"
        )
        .await
        .unwrap(),
        6
    );
    assert_eq!(storage.commits.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn unchanged_head_does_not_authorize_malformed_current_work_or_duplicate_export() {
    let (storage, identity, _, _) = fixture();
    export(&storage, &identity).await;
    corrupt_derived(&storage);
    if let RecoveryRecord::RawReplicaRow { payload_json, .. } = &mut storage
        .entries
        .lock()
        .unwrap()
        .iter_mut()
        .find(|entry| {
            matches!(
                entry.record,
                RecoveryRecord::RawReplicaRow {
                    store: ReplicaStore::Operations,
                    ..
                }
            )
        })
        .unwrap()
        .record
    {
        *payload_json = "unknown accepted work".into();
    }
    let port = make_port(&storage);
    let current = capture(&port, &identity.account_id).await.unwrap();
    let before = storage.durable();
    assert!(repair_bundle(
        &port,
        &identity,
        &current,
        "separate recovery password",
        "source"
    )
    .await
    .is_err());
    assert_eq!(before, storage.durable());
    let (storage, identity, _, _) = fixture();
    let port = make_port(&storage);
    let snapshot = capture(&port, &identity.account_id).await.unwrap();
    storage.duplicate_second_row.store(true, Ordering::SeqCst);
    assert!(export_snapshot(
        &port,
        &identity.account_id,
        Some(identity.server_url),
        Some(identity.user_id),
        "separate recovery password",
        "sink",
        &snapshot
    )
    .await
    .is_err());
    assert!(storage.sink.lock().unwrap().is_empty());
}

#[tokio::test]
async fn older_bundle_cannot_resurrect_an_acknowledged_protected_share_result() {
    use crate::replica::{
        OperationOutcomeResult, OperationReceiptRecord, ProtectedShareCapabilityRecord,
        Sha256Fingerprint,
    };
    let (storage, identity, _, _) = fixture();
    let capability: ProtectedShareCapabilityRecord = serde_json::from_value(json!({"accountId":"account","operationId":"share","ciphertext":"protected result","iv":"iv","algorithm":"AES-GCM-AAD-V1","result":{"shareLinkId":"link","baseShareUrl":"https://server.test/s","expiresAt":"2026-09-09T00:00:00Z"}})).unwrap();
    let receipt = OperationReceiptRecord {
        operation_id: "share".into(),
        kind: OperationKind::CreateShare,
        target: ResourceRef::Item {
            item_id: "item".into(),
            vault_id: "vault".into(),
        },
        request_fingerprint: Sha256Fingerprint([1; 32]),
        result: OperationOutcomeResult::ShareApplied {
            share_link_id: "link".into(),
            base_share_url: "https://server.test/s".into(),
            expires_at: "2026-09-09T00:00:00Z".into(),
        },
        completed_at_revision: 4,
        create_vault_cleanup: None,
    };
    storage.entries.lock().unwrap().extend([
        Entry {
            record: RecoveryRecord::RawReplicaRow {
                account_id: "account".into(),
                store: ReplicaStore::ShareCapabilities,
                record_id: "share".into(),
                payload_json: serde_json::to_string(&capability).unwrap(),
            },
            bytes: None,
        },
        Entry {
            record: RecoveryRecord::RawReplicaRow {
                account_id: "account".into(),
                store: ReplicaStore::OperationReceipts,
                record_id: "share".into(),
                payload_json: serde_json::to_string(&receipt).unwrap(),
            },
            bytes: None,
        },
    ]);
    export(&storage, &identity).await;
    storage.entries.lock().unwrap().retain(|entry| {
        !matches!(
            entry.record,
            RecoveryRecord::RawReplicaRow {
                store: ReplicaStore::ShareCapabilities,
                ..
            }
        )
    });
    corrupt_derived(&storage);
    let port = make_port(&storage);
    let current = capture(&port, &identity.account_id).await.unwrap();
    assert!(can_repair(&current, &identity));
    let before = storage.durable();
    assert!(repair_bundle(
        &port,
        &identity,
        &current,
        "separate recovery password",
        "source"
    )
    .await
    .is_err());
    assert_eq!(storage.durable(), before);
    assert_eq!(storage.commits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn same_head_concurrent_row_change_refuses_atomic_publication() {
    let (storage, identity, _, payload) = fixture();
    export(&storage, &identity).await;
    corrupt_derived(&storage);
    let port = make_port(&storage);
    let current = capture(&port, &identity.account_id).await.unwrap();
    let expected_head = current.head_json.clone();
    storage.tamper_guard.store(true, Ordering::SeqCst);
    assert!(repair_bundle(
        &port,
        &identity,
        &current,
        "separate recovery password",
        "source"
    )
    .await
    .is_err());
    assert_eq!(storage.commits.load(Ordering::SeqCst), 0);
    let current = capture(&port, &identity.account_id).await.unwrap();
    assert_eq!(current.head_json, expected_head);
    assert!(current.needs_rebuild());
    assert!(storage.entries.lock().unwrap().iter().any(|entry|matches!(&entry.record,RecoveryRecord::RawReplicaRow{store:ReplicaStore::Operations,payload_json,..} if payload_json==&format!("{payload} "))));
}

#[tokio::test]
async fn source_failure_after_authenticated_terminal_in_either_pass_cannot_commit() {
    let (storage, identity, _, _) = fixture();
    export(&storage, &identity).await;
    corrupt_derived(&storage);
    let before = storage.durable();
    let port = make_port(&storage);
    for pass in [1, 2] {
        storage.rewind_count.store(0, Ordering::SeqCst);
        storage.fail_eof_pass.store(pass, Ordering::SeqCst);
        let current = capture(&port, &identity.account_id).await.unwrap();
        assert!(repair_bundle(
            &port,
            &identity,
            &current,
            "separate recovery password",
            "source"
        )
        .await
        .is_err());
        assert_eq!(storage.durable(), before);
        assert_eq!(storage.commits.load(Ordering::SeqCst), 0);
        assert_eq!(storage.rewind_count.load(Ordering::SeqCst), pass);
    }
}

#[tokio::test]
async fn partial_evidence_and_foreign_identity_never_become_executable_repair() {
    let (storage, identity, _, _) = fixture();
    let port = make_port(&storage);
    let valid = capture(&port, &identity.account_id).await.unwrap();
    assert_eq!(
        export_snapshot(
            &port,
            &identity.account_id,
            Some(identity.server_url.clone()),
            None,
            "separate recovery password",
            "sink",
            &valid
        )
        .await
        .unwrap()
        .1,
        RecoveryClassification::Partial
    );
    corrupt_derived(&storage);
    let before = storage.durable();
    let current = capture(&port, &identity.account_id).await.unwrap();
    assert!(repair_bundle(
        &port,
        &identity,
        &current,
        "separate recovery password",
        "source"
    )
    .await
    .is_err());
    assert_eq!(storage.durable(), before);
    let (storage, identity, _, _) = fixture();
    export(&storage, &identity).await;
    corrupt_derived(&storage);
    let port = make_port(&storage);
    let current = capture(&port, &identity.account_id).await.unwrap();
    let foreign = RecoveryIdentity {
        server_url: "https://other-server.test".into(),
        ..identity
    };
    let before = storage.durable();
    assert!(repair_bundle(
        &port,
        &foreign,
        &current,
        "separate recovery password",
        "source"
    )
    .await
    .is_err());
    assert_eq!(storage.durable(), before);
}

#[tokio::test]
async fn protected_roundtrip_restores_real_published_provisional_bytes_for_accepted_preparation() {
    use bittery_crypto_core::attachment_move::{AttachmentBlobEncryptor, AttachmentBlobScope};
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../generated/replica-conformance/history-corpus.json"
    ))
    .unwrap();
    let (head, row, overlay) = corpus["histories"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|history| history["steps"].as_array().unwrap())
        .flat_map(|step| step["expectedLoadedState"].as_array().unwrap())
        .find_map(|loaded| {
            loaded["response"]["rows"]
                .as_array()
                .and_then(|rows| {
                    rows.iter()
                        .find(|row| row["store"] == "attachmentMovePreparations")
                })
                .map(|row| {
                    let overlay = loaded["response"]["rows"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|entry| {
                            entry["store"] == "optimisticItems"
                                && serde_json::from_str::<serde_json::Value>(
                                    entry["payloadJson"].as_str().unwrap(),
                                )
                                .unwrap()["operationId"]
                                    == row["key"]["recordId"]
                        })
                        .unwrap();
                    (
                        loaded["response"]["head"].clone(),
                        row.clone(),
                        overlay.clone(),
                    )
                })
        })
        .unwrap();
    let head: ReplicaHead = serde_json::from_value(head).unwrap();
    let account = head.account_id.as_str();
    let operation = row["key"]["recordId"].as_str().unwrap();
    let payload = row["payloadJson"].as_str().unwrap();
    let mut encryptor = AttachmentBlobEncryptor::new(
        [7; 32],
        AttachmentBlobScope::new(
            "vault-2".into(),
            "attachment-1".into(),
            head.user_id.clone(),
        ),
    )
    .unwrap();
    let mut bytes = encryptor.push(&[42; 42]).unwrap();
    let sealed = encryptor.finish().unwrap();
    bytes.extend(sealed.final_chunk);
    assert_eq!(sealed.byte_length, bytes.len() as u64);
    let owner = crate::replica::attachment_move_artifact_ref(
        &head.account_id,
        operation,
        "attachment-1",
        &sealed.ciphertext_sha256,
        sealed.byte_length,
    )
    .unwrap();
    let hash = sealed.ciphertext_sha256;
    let entries = vec![
        Entry {
            record: RecoveryRecord::RawReplicaHead {
                account_id: account.into(),
                payload_json: serde_json::to_string(&head).unwrap(),
            },
            bytes: None,
        },
        Entry {
            record: RecoveryRecord::RawReplicaRow {
                account_id: account.into(),
                store: ReplicaStore::AttachmentMovePreparations,
                record_id: operation.into(),
                payload_json: payload.into(),
            },
            bytes: None,
        },
        Entry {
            record: RecoveryRecord::RawReplicaRow {
                account_id: account.into(),
                store: ReplicaStore::OptimisticItems,
                record_id: overlay["key"]["recordId"].as_str().unwrap().into(),
                payload_json: overlay["payloadJson"].as_str().unwrap().into(),
            },
            bytes: None,
        },
        Entry {
            record: RecoveryRecord::ArtifactMetadata {
                account_id: account.into(),
                artifact_id: owner.artifact_id.clone(),
                metadata_json: json!({
                    "accountId": account,
                    "operationId": operation,
                    "attachmentId": "attachment-1",
                    "artifactId": owner.artifact_id,
                    "byteLength": bytes.len().to_string(),
                    "chunkCount": 1,
                    "ciphertextSha256": hash,
                    "publicationState": "published",
                    "durableChunkCount": 1,
                    "physicalGeneration": "generation"
                })
                .to_string(),
            },
            bytes: None,
        },
        Entry {
            record: RecoveryRecord::ProvisionalMetadata {
                account_id: account.into(),
                operation_id: operation.into(),
                attachment_id: "attachment-1".into(),
                generation: "generation".into(),
                metadata_json: json!({
                    "accountId": account,
                    "operationId": operation,
                    "attachmentId": "attachment-1",
                    "generation": "generation",
                    "current": true,
                    "publicationState": 2,
                    "durableChunkCount": 1,
                    "durableByteLength": bytes.len(),
                    "minimumChunkIndex": 0,
                    "maximumChunkIndex": 0,
                    "artifactId": owner.artifact_id,
                    "ciphertextSha256": hash,
                    "byteLength": bytes.len().to_string(),
                    "chunkCount": 1
                })
                .to_string(),
            },
            bytes: None,
        },
        Entry {
            record: RecoveryRecord::ProvisionalChunk {
                account_id: account.into(),
                operation_id: operation.into(),
                attachment_id: "attachment-1".into(),
                generation: "generation".into(),
                chunk_index: 0,
                chunk_sha256: hash,
            },
            bytes: Some(bytes.clone()),
        },
    ];
    let storage = Storage::new(entries);
    let identity = RecoveryIdentity {
        account_id: head.account_id.clone(),
        incarnation: head.incarnation.clone(),
        user_id: head.user_id.clone(),
        server_url: "https://server.test".into(),
    };
    export(&storage, &identity).await;
    storage
        .entries
        .lock()
        .unwrap()
        .retain(|entry| !matches!(entry.record, RecoveryRecord::ProvisionalChunk { .. }));
    let port = make_port(&storage);
    let current = capture(&port, &identity.account_id).await.unwrap();
    assert!(can_repair(&current, &identity));
    assert!(!can_rebootstrap(&current, &identity));
    assert_eq!(
        repair_bundle(
            &port,
            &identity,
            &current,
            "separate recovery password",
            "source"
        )
        .await
        .unwrap(),
        head.replica_revision + 1
    );
    let restored = capture(&port, &identity.account_id).await.unwrap();
    assert!(restored.complete);
    assert_eq!(restored.proof.unwrap().preparation_count, 1);
    assert!(storage
        .entries
        .lock()
        .unwrap()
        .iter()
        .any(|entry| entry.bytes.as_ref() == Some(&bytes)));
    assert!(storage.entries.lock().unwrap().iter().any(|entry| {
        matches!(
            &entry.record,
            RecoveryRecord::RawReplicaRow {
                store: ReplicaStore::AttachmentMovePreparations,
                payload_json,
                ..
            } if payload_json == payload
        )
    }));
}

#[tokio::test]
async fn protected_complete_export_retains_actual_physical_schema_provenance_and_final_report() {
    use super::{
        control::RecoveryPhysicalSchemas, report::RecoveryReport, transfer::ArchiveReader,
    };
    let (storage, identity, _, _) = fixture();
    let port = make_port(&storage);
    let actual = RecoveryPhysicalSchemas {
        replica_version: 80,
        attachment_artifacts_version: 30,
        vault_images_version: 20,
    };
    assert!(port.record_physical_schemas(actual));
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
    let mut reader = ArchiveReader::open(
        &port,
        &identity.account_id,
        "source",
        "separate recovery password",
    )
    .await
    .unwrap();
    let mut report = None;
    while let Some(record) = reader.next().await.unwrap() {
        if serde_json::to_value(&record.header).unwrap()["type"] == "report" {
            report = Some(RecoveryReport::decode(&record.body).unwrap());
        }
    }
    let report=report.expect("every protected export must authenticate its actual physical provenance and final capture report");
    assert_eq!(report.physical_schemas, actual);
    assert!(report.proves_complete(4));
}
