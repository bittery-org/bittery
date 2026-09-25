use super::*;

#[test]
fn physical_reply_checks_encoded_control_size_before_allocating_an_unbounded_envelope() {
    let answer = (
        Reply::Entry {
            cursor: "cursor".into(),
            next_cursor: None,
            record: bittery_client_core::RecoveryRecord::RawReplicaRow {
                account_id: "account".into(),
                store: bittery_client_core::ReplicaStore::Operations,
                record_id: "row".into(),
                payload_json: "\0".repeat(CONTROL_BYTES / 6 + 1),
            },
        },
        None,
    );
    let (control, bytes) = encode(answer).unwrap();
    assert!(bytes.is_none());
    assert!(matches!(
        serde_json::from_str::<Reply>(&control).unwrap(),
        Reply::LimitExceeded {
            bound: RecoveryBound::ControlBytes
        }
    ));
}
use bittery_client_core::{
    SqliteAttachmentArtifactStore, SqliteReplica, SqliteVaultImageArtifactStore,
};

fn fixture() -> (tempfile::TempDir, NativeRecovery) {
    let directory = tempfile::tempdir().unwrap();
    SqliteReplica::open(directory.path().join("replica.sqlite")).unwrap();
    SqliteAttachmentArtifactStore::open(directory.path().join("attachments.sqlite")).unwrap();
    SqliteVaultImageArtifactStore::open(directory.path().join("vault-images.sqlite")).unwrap();
    let shared = NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
        .unwrap()
        .unwrap();
    let recovery = NativeRecovery::new(
        directory.path().to_path_buf(),
        Arc::new(Mutex::new(Some(shared))),
        Arc::new(NativeRecoveryFiles::default()),
    );
    (directory, recovery)
}
async fn invoke(recovery: &NativeRecovery, request: Request) -> Reply {
    let (json, binary) = recovery
        .invoke(serde_json::to_string(&request).unwrap(), None)
        .await
        .unwrap();
    assert!(binary.is_none());
    serde_json::from_str(&json).unwrap()
}
fn enter(id: &str) -> Request {
    Request::EnterMaintenance {
        recovery_id: id.into(),
    }
}
fn leave(id: &str) -> Request {
    Request::LeaveMaintenance {
        recovery_id: id.into(),
    }
}

#[tokio::test]
async fn cancellation_during_final_gate_release_cannot_recreate_retired_file_state() {
    let (_directory, recovery) = fixture();
    assert!(matches!(
        invoke(&recovery, enter("race")).await,
        Reply::MaintenanceEntered { .. }
    ));
    recovery.cancel("race");
    assert_eq!(recovery.0.transfer.cancellation_count(), 1);
    // Hold the actual OS gate slot: Leave has finished file cleanup but cannot release ownership.
    let gate = recovery.0.gate.clone();
    let (held_send, held_receive) = std::sync::mpsc::channel();
    let (release_send, release_receive) = std::sync::mpsc::channel();
    let gate_holder = std::thread::spawn(move || {
        let _gate = gate.lock().unwrap();
        held_send.send(()).unwrap();
        release_receive.recv().unwrap();
    });
    held_receive.recv().unwrap();
    let leaving_recovery = recovery.clone();
    let leaving = tokio::spawn(async move { invoke(&leaving_recovery, leave("race")).await });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while recovery.0.transfer.cancellation_count() != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let cancelling_recovery = recovery.clone();
    let (done_send, done_receive) = std::sync::mpsc::channel();
    let cancelling = std::thread::spawn(move || {
        cancelling_recovery.cancel("race");
        done_send.send(()).unwrap();
    });
    // The old implementation completes cancellation here and recreates the removed entry. The
    // fixed scope fence makes it wait for Leave, then observe that this scope has been retired.
    let _ = done_receive.recv_timeout(std::time::Duration::from_millis(100));
    release_send.send(()).unwrap();
    gate_holder.join().unwrap();
    assert!(matches!(leaving.await.unwrap(), Reply::MaintenanceLeft));
    cancelling.join().unwrap();
    assert_eq!(recovery.0.transfer.cancellation_count(), 0);
}

#[tokio::test]
async fn maintenance_retires_own_shared_gate_excludes_normal_access_and_cleans_up_after_cancel() {
    let (directory, recovery) = fixture();
    assert!(matches!(
        invoke(&recovery, enter("recovery")).await,
        Reply::MaintenanceEntered { .. }
    ));
    assert!(
        NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        invoke(
            &recovery,
            Request::ListAccounts {
                recovery_id: "recovery".into(),
                cursor: None
            }
        )
        .await,
        Reply::End
    ));
    recovery.cancel("recovery");
    assert!(matches!(
        invoke(
            &recovery,
            Request::ListAccounts {
                recovery_id: "recovery".into(),
                cursor: None
            }
        )
        .await,
        Reply::Unavailable {
            reason: Unavailable::Cancelled
        }
    ));
    assert!(matches!(
        invoke(&recovery, leave("recovery")).await,
        Reply::MaintenanceLeft
    ));
    assert!(
        NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn competing_normal_owner_blocks_entry_and_wrong_scope_cannot_release_exclusive_gate() {
    let (directory, recovery) = fixture();
    let competitor = NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
        .unwrap()
        .unwrap();
    assert!(matches!(
        invoke(&recovery, enter("recovery")).await,
        Reply::Unavailable {
            reason: Unavailable::Busy
        }
    ));
    drop(competitor);
    assert!(matches!(
        invoke(&recovery, enter("recovery")).await,
        Reply::MaintenanceEntered { .. }
    ));
    assert!(matches!(
        invoke(&recovery, leave("wrong")).await,
        Reply::Unavailable { .. }
    ));
    recovery.cancel("wrong");
    assert!(matches!(
        invoke(
            &recovery,
            Request::ListAccounts {
                recovery_id: "recovery".into(),
                cursor: None
            }
        )
        .await,
        Reply::End
    ));
    assert!(
        NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        invoke(&recovery, leave("recovery")).await,
        Reply::MaintenanceLeft
    ));
}

#[tokio::test]
async fn unknown_schema_returns_typed_refusal_preserves_file_and_releases_gate() {
    let (directory, recovery) = fixture();
    let path = directory.path().join("replica.sqlite");
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch("PRAGMA user_version=99")
        .unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert!(matches!(
        invoke(&recovery, enter("recovery")).await,
        Reply::Unavailable {
            reason: Unavailable::UnsupportedSchema
        }
    ));
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    assert!(
        NativeDeviceLease::try_acquire(directory.path(), DeviceLeaseMode::Shared)
            .unwrap()
            .is_some()
    );
    assert!(matches!(
        invoke(&recovery, leave("recovery")).await,
        Reply::MaintenanceLeft
    ));
}

#[tokio::test]
async fn staged_binary_uses_the_closed_command_and_cancelled_input_can_still_be_discarded() {
    let (_directory, recovery) = fixture();
    assert!(matches!(
        invoke(&recovery, enter("recovery")).await,
        Reply::MaintenanceEntered { .. }
    ));
    assert!(matches!(
        invoke(
            &recovery,
            Request::BeginRepairStage {
                recovery_id: "recovery".into(),
                account_id: "a".into()
            }
        )
        .await,
        Reply::RepairStageBegun
    ));
    assert!(matches!(
        invoke(
            &recovery,
            Request::StageRowStart {
                recovery_id: "recovery".into(),
                account_id: "a".into(),
                store: bittery_client_core::ReplicaStore::Operations,
                record_id: "operation".into(),
                payload_byte_length: 3
            }
        )
        .await,
        Reply::RowStarted
    ));
    let request = Request::StageRowChunk {
        recovery_id: "recovery".into(),
        account_id: "a".into(),
    };
    let (json, binary) = recovery
        .invoke(
            serde_json::to_string(&request).unwrap(),
            Some(vec![1, 2, 3]),
        )
        .await
        .unwrap();
    assert!(binary.is_none());
    assert!(matches!(
        serde_json::from_str::<Reply>(&json).unwrap(),
        Reply::RowChunkStaged
    ));
    recovery.cancel("recovery");
    assert!(matches!(
        invoke(
            &recovery,
            Request::StageRowEnd {
                recovery_id: "recovery".into(),
                account_id: "a".into()
            }
        )
        .await,
        Reply::Unavailable {
            reason: Unavailable::Cancelled
        }
    ));
    assert!(matches!(
        invoke(
            &recovery,
            Request::DiscardRepairStage {
                recovery_id: "recovery".into(),
                account_id: "a".into()
            }
        )
        .await,
        Reply::RepairStageDiscarded
    ));
    assert!(matches!(
        invoke(&recovery, leave("recovery")).await,
        Reply::MaintenanceLeft
    ));
}

#[tokio::test]
async fn leaving_maintenance_retires_claimed_files_before_another_scope_can_use_them() {
    let (directory, recovery) = fixture();
    let path = directory.path().join("encrypted-archive");
    std::fs::write(&path, [1, 2, 3]).unwrap();
    let capability = recovery
        .0
        .transfer
        .grant_source("a".into(), std::fs::File::open(path).unwrap())
        .unwrap();
    invoke(&recovery, enter("first")).await;
    let request = |id: &str| Request::SourceRead {
        recovery_id: id.into(),
        account_id: "a".into(),
        capability_id: capability.clone(),
        max_bytes: 1,
    };
    let (_, bytes) = recovery
        .invoke(serde_json::to_string(&request("first")).unwrap(), None)
        .await
        .unwrap();
    assert_eq!(bytes, Some(vec![1]));
    assert!(matches!(
        invoke(&recovery, leave("first")).await,
        Reply::MaintenanceLeft
    ));
    invoke(&recovery, enter("second")).await;
    let (json, bytes) = recovery
        .invoke(serde_json::to_string(&request("second")).unwrap(), None)
        .await
        .unwrap();
    assert!(bytes.is_none());
    assert!(matches!(
        serde_json::from_str::<Reply>(&json).unwrap(),
        Reply::Unavailable { .. }
    ));
    invoke(&recovery, leave("second")).await;
}

#[tokio::test]
async fn protected_image_chunk_enters_actual_native_recovery_with_exact_binary_pairing() {
    use bittery_client_core::RecoveryRecord;
    let (directory, recovery) = fixture();
    let connection =
        rusqlite::Connection::open(directory.path().join("vault-images.sqlite")).unwrap();
    connection.execute("INSERT INTO vault_image_artifacts(account_id,operation_id,publication_id) VALUES('account','op','protected-a')", []).unwrap();
    drop(connection);
    assert!(matches!(
        invoke(&recovery, enter("protected")).await,
        Reply::MaintenanceEntered { .. }
    ));
    let record = RecoveryRecord::ProtectedVaultImageChunk {
        account_id: "account".into(),
        operation_id: "op".into(),
        publication_id: "protected-a".into(),
        chunk_index: 0,
    };
    let request = Request::AddArtifactEntry {
        recovery_id: "protected".into(),
        account_id: "account".into(),
        record,
    };
    assert!(matches!(
        invoke(&recovery, request.clone()).await,
        Reply::Unavailable {
            reason: Unavailable::Corrupt
        }
    ));
    let (response, binary) = recovery
        .invoke(
            serde_json::to_string(&request).unwrap(),
            Some(vec![1, 255, 3]),
        )
        .await
        .unwrap();
    assert!(binary.is_none());
    assert!(matches!(
        serde_json::from_str::<Reply>(&response).unwrap(),
        Reply::ArtifactAdded
    ));
    let connection =
        rusqlite::Connection::open(directory.path().join("vault-images.sqlite")).unwrap();
    let bytes: Vec<u8> = connection.query_row("SELECT plaintext FROM vault_image_artifact_chunks WHERE account_id='account' AND operation_id='op' AND publication_id='protected-a' AND chunk_index=0", [], |row|row.get(0)).unwrap();
    assert_eq!(bytes, vec![1, 255, 3]);
    drop(connection);
    assert!(matches!(
        invoke(&recovery, leave("protected")).await,
        Reply::MaintenanceLeft
    ));
}
