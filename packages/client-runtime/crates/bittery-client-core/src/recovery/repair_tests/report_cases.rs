//! Authenticated but semantically invalid reports must not reach physical repair publication.
use super::*;
use crate::recovery::archive::{encode_prefix, DecodedRecord, EntryHeader, RecordDecoder};
use bittery_crypto_core::replica_recovery::{
    RecoveryDecryptor, RecoveryEncryptor, RECOVERY_CHUNK_BYTES, RECOVERY_HEADER_BYTES,
};
use zeroize::Zeroizing;

const PASSWORD: &str = "separate recovery password";

pub(super) fn decode_archive(bytes: &[u8]) -> Vec<DecodedRecord> {
    let mut envelope = RecoveryDecryptor::new(PASSWORD, &bytes[..RECOVERY_HEADER_BYTES]).unwrap();
    let mut decoder = RecordDecoder::default();
    let mut records = Vec::new();
    let mut position = RECOVERY_HEADER_BYTES;
    while position < bytes.len() {
        let length =
            u32::from_be_bytes(bytes[position..position + 4].try_into().unwrap()) as usize + 9;
        if let Some(plaintext) = envelope
            .open_frame(&bytes[position..position + length])
            .unwrap()
        {
            records.extend(decoder.push(&plaintext).unwrap());
        }
        position += length;
    }
    assert!(envelope.finished());
    assert_eq!(position, bytes.len());
    decoder.finish().unwrap();
    records
}

pub(super) fn copy_records(records: &[DecodedRecord]) -> Vec<DecodedRecord> {
    records
        .iter()
        .map(|record| DecodedRecord {
            header: record.header.clone(),
            body: record.body.clone(),
        })
        .collect()
}

pub(super) fn encode_archive(records: &[DecodedRecord]) -> Vec<u8> {
    // This fixture is deliberately tiny. Production continues to stream arbitrary-sized records.
    let mut plaintext = Zeroizing::new(Vec::new());
    for record in records {
        plaintext.extend(encode_prefix(&record.header, record.body.len()).unwrap());
        plaintext.extend_from_slice(&record.body);
    }
    assert!(plaintext.len() < RECOVERY_CHUNK_BYTES);
    let mut envelope = RecoveryEncryptor::new(PASSWORD).unwrap();
    let mut ciphertext = envelope.header().to_vec();
    ciphertext.extend(envelope.seal_chunk(&plaintext).unwrap());
    ciphertext.extend(envelope.finish().unwrap());
    ciphertext
}

#[tokio::test]
async fn authenticated_report_refusals_preserve_original_work_and_missing_artifacts() {
    let (storage, identity, _, _) = fixture();
    let archive = export(&storage, &identity).await;
    let records = decode_archive(&archive);
    let report_index = records
        .iter()
        .position(|record| matches!(record.header, EntryHeader::Report))
        .unwrap();
    assert_eq!(report_index, records.len() - 1);
    let original_report: serde_json::Value =
        serde_json::from_slice(&records[report_index].body).unwrap();
    let mut cases = Vec::new();
    let mut missing = copy_records(&records);
    missing.remove(report_index);
    cases.push(("missing report", missing));
    let mut duplicated = copy_records(&records);
    duplicated.extend(copy_records(&records[report_index..]));
    cases.push(("duplicate report", duplicated));
    let mut early = copy_records(&records);
    let report = early.remove(report_index);
    early.insert(1, report);
    cases.push(("report before data", early));

    let changes = [
        (
            "record count",
            "exportedRecordCount",
            json!(original_report["exportedRecordCount"].as_u64().unwrap() + 1),
        ),
        ("incomplete source", "sourceReadComplete", json!(false)),
        ("incomplete export", "exportReadComplete", json!(false)),
        (
            "unproved accepted work",
            "acceptedWorkValidated",
            json!(false),
        ),
        (
            "unproved artifacts",
            "artifactDependenciesValidated",
            json!(false),
        ),
        (
            "complete with findings",
            "findings",
            json!([{"type":"invalidReplicaHead"}]),
        ),
        ("unsupported report", "version", json!(2)),
        (
            "oversized report",
            "findings",
            json!([{"type":"invalidReplicaRow","store":"authorityItems","recordId":"x".repeat(64 * 1024)}]),
        ),
    ];
    for (name, field, value) in changes {
        let mut changed = copy_records(&records);
        let mut report = original_report.clone();
        report[field] = value;
        changed[report_index].body = Zeroizing::new(serde_json::to_vec(&report).unwrap());
        cases.push((name, changed));
    }

    storage
        .entries
        .lock()
        .unwrap()
        .retain(|entry| !matches!(entry.record, RecoveryRecord::VaultImageChunk { .. }));
    let current = capture(&make_port(&storage), &identity.account_id)
        .await
        .unwrap();
    assert!(can_repair(&current, &identity));
    let before = storage.durable();
    for (name, records) in cases {
        *storage.source.lock().unwrap() = encode_archive(&records);
        *storage.offset.lock().unwrap() = 0;
        assert!(
            repair_bundle(
                &make_port(&storage),
                &identity,
                &current,
                PASSWORD,
                "source"
            )
            .await
            .is_err(),
            "accepted {name}"
        );
        assert_eq!(
            storage.durable(),
            before,
            "changed durable state for {name}"
        );
        assert_eq!(
            storage.commits.load(Ordering::SeqCst),
            0,
            "published {name}"
        );
    }
    // Semantic refusals do not strand a repair stage or prevent the original valid archive.
    *storage.source.lock().unwrap() = archive;
    *storage.offset.lock().unwrap() = 0;
    repair_bundle(
        &make_port(&storage),
        &identity,
        &current,
        PASSWORD,
        "source",
    )
    .await
    .unwrap();
    assert_eq!(storage.commits.load(Ordering::SeqCst), 1);
    assert!(
        capture(&make_port(&storage), &identity.account_id)
            .await
            .unwrap()
            .complete
    );
}
