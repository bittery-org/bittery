use super::*;
use crate::recovery::{
    report::{ReadPhase, RecoveryFinding, RecoveryReport},
    transfer::ArchiveReader,
};
use crate::RecoveryBound;

struct InterruptedRead {
    storage: Arc<Storage>,
    index: usize,
    bound: Option<RecoveryBound>,
}
#[async_trait::async_trait]
impl SerializedRecoveryExecutor for InterruptedRead {
    async fn invoke(
        &self,
        request: String,
        binary: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
        if let Control::ReadEntry { cursor, .. } = serde_json::from_str(&request).unwrap() {
            if cursor.as_deref().unwrap_or("0") == self.index.to_string() {
                return match self.bound {
                    Some(bound) => Ok((
                        serde_json::to_string(&Reply::LimitExceeded { bound }).unwrap(),
                        None,
                    )),
                    None => Err(RuntimeError::new(
                        RuntimeErrorCode::StorageUnavailable,
                        "fixture physical read failed",
                    )),
                };
            }
        }
        self.storage.invoke(request, binary).await
    }
}
fn interrupted_port(
    storage: &Arc<Storage>,
    index: usize,
    bound: Option<RecoveryBound>,
) -> RecoveryPort {
    RecoveryPort::new_test(
        Arc::new(InterruptedRead {
            storage: storage.clone(),
            index,
            bound,
        }),
        "report-capture".into(),
        RequestCancellation::new(),
    )
}
async fn report(storage: &Arc<Storage>, identity: &RecoveryIdentity) -> RecoveryReport {
    let port = make_port(storage);
    let mut reader = ArchiveReader::open(
        &port,
        &identity.account_id,
        "source",
        "separate recovery password",
    )
    .await
    .unwrap();
    let mut report = None;
    let mut count = 0;
    while let Some(record) = reader.next().await.unwrap() {
        match record.header {
            super::super::archive::EntryHeader::Manifest { .. } => {}
            super::super::archive::EntryHeader::Report => {
                assert!(report.is_none());
                report = Some(RecoveryReport::decode(&record.body).unwrap());
            }
            _ => {
                assert!(report.is_none());
                count += 1;
            }
        }
    }
    let report = report.unwrap();
    assert_eq!(report.exported_record_count, count);
    reader.source_fingerprint().unwrap();
    report
}
async fn partial_export(
    port: &RecoveryPort,
    identity: &RecoveryIdentity,
    snapshot: &super::super::capture::Snapshot,
) -> Result<(u64, RecoveryClassification), RuntimeError> {
    export_snapshot(
        port,
        &identity.account_id,
        Some(identity.server_url.clone()),
        Some(identity.user_id.clone()),
        "separate recovery password",
        "sink",
        snapshot,
    )
    .await
}

#[tokio::test]
async fn partial_report_preserves_known_damage_and_actual_emitted_pass_completeness() {
    let (storage, identity, _, _) = fixture();
    corrupt_derived(&storage);
    storage.entries.lock().unwrap().retain(|entry| {
        !matches!(
            entry.record,
            RecoveryRecord::VaultImageMetadata { .. } | RecoveryRecord::VaultImageChunk { .. }
        )
    });
    let before = storage.durable();
    let current = capture(&make_port(&storage), &identity.account_id)
        .await
        .unwrap();
    assert!(!current.complete);
    assert!(current.read_complete);
    assert!(current.proof.is_some());
    assert!(current.selection.is_none());
    assert_eq!(
        partial_export(&make_port(&storage), &identity, &current)
            .await
            .unwrap()
            .1,
        RecoveryClassification::Partial
    );
    let complete_read_report = report(&storage, &identity).await;
    assert!(complete_read_report.source_read_complete);
    assert!(complete_read_report.export_read_complete);
    assert!(complete_read_report.accepted_work_validated);
    assert!(!complete_read_report.artifact_dependencies_validated);
    assert!(complete_read_report
        .findings
        .contains(&RecoveryFinding::InvalidReplicaRow {
            store: ReplicaStore::AuthorityItems,
            record_id: "generation/item".into()
        }));
    let operation_id = current.proof.as_ref().unwrap().required_images[0]
        .operation_id
        .clone();
    assert!(complete_read_report
        .findings
        .contains(&RecoveryFinding::MissingVaultImageDependency { operation_id }));
    assert!(!complete_read_report.proves_complete(complete_read_report.exported_record_count));

    storage.sink.lock().unwrap().clear();
    let interrupted = interrupted_port(&storage, 2, None);
    assert_eq!(
        partial_export(&interrupted, &identity, &current)
            .await
            .unwrap()
            .1,
        RecoveryClassification::Partial
    );
    let partial_read_report = report(&storage, &identity).await;
    assert!(partial_read_report.source_read_complete);
    assert!(!partial_read_report.export_read_complete);
    assert_eq!(partial_read_report.exported_record_count, 2);
    assert!(partial_read_report
        .findings
        .contains(&RecoveryFinding::ReadFailure {
            phase: ReadPhase::Export,
            code: RuntimeErrorCode::StorageUnavailable
        }));
    assert!(complete_read_report
        .findings
        .iter()
        .all(|finding| partial_read_report.findings.contains(finding)));
    assert_eq!(storage.durable(), before);
    assert_eq!(storage.commits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn physical_resource_refusal_never_becomes_partial_evidence_prefix() {
    let (storage, identity, _, _) = fixture();
    corrupt_derived(&storage);
    let before = storage.durable();
    let current = capture(&make_port(&storage), &identity.account_id)
        .await
        .unwrap();
    assert!(!current.complete);
    let port = interrupted_port(&storage, 1, Some(RecoveryBound::RecordBytes));
    let capture_error = match capture(&port, &identity.account_id).await {
        Err(error) => error,
        Ok(_) => panic!("resource exhaustion became a partial snapshot"),
    };
    assert_eq!(capture_error.code, RuntimeErrorCode::SizeRejected);
    assert_eq!(
        capture_error.recovery_bound,
        Some(RecoveryBound::RecordBytes)
    );
    let export_error = partial_export(&port, &identity, &current)
        .await
        .unwrap_err();
    assert_eq!(export_error.code, RuntimeErrorCode::SizeRejected);
    assert_eq!(
        export_error.recovery_bound,
        Some(RecoveryBound::RecordBytes)
    );
    assert!(storage.sink.lock().unwrap().is_empty());
    assert!(storage.source.lock().unwrap().is_empty());
    assert_eq!(storage.durable(), before);
    assert_eq!(storage.commits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn known_findings_overflow_refuses_export_without_truncating_the_diagnostic_inventory() {
    let (storage, identity, _, _) = fixture();
    for index in 0..300 {
        storage.entries.lock().unwrap().push(Entry {
            record: RecoveryRecord::RawReplicaRow {
                account_id: identity.account_id.as_str().into(),
                store: ReplicaStore::AuthorityItems,
                record_id: format!("generation/{index}/{}", "x".repeat(256)),
                payload_json: "invalid derived row retained as evidence".into(),
            },
            bytes: None,
        });
    }
    let before = storage.durable();
    let port = make_port(&storage);
    let current = capture(&port, &identity.account_id).await.unwrap();
    assert!(current.read_complete);
    assert!(!current.complete);
    let error = partial_export(&port, &identity, &current)
        .await
        .unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::SizeRejected);
    assert_eq!(error.recovery_bound, Some(RecoveryBound::ReportBytes));
    assert!(storage.sink.lock().unwrap().is_empty());
    assert!(storage.source.lock().unwrap().is_empty());
    assert_eq!(storage.durable(), before);
    assert_eq!(storage.commits.load(Ordering::SeqCst), 0);
}
