use std::path::PathBuf;

use serde_json::Value;

fn corpus_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../generated/replica-conformance/history-corpus.json")
}

fn row_payload(step: &Value, store: &str, record_id: &str) -> Value {
    let writes = step["request"]["prepared"]["writes"]
        .as_array()
        .expect("commit has writes");
    let payload = writes
        .iter()
        .find(|write| {
            write["type"] == "put"
                && write["row"]["store"] == store
                && write["row"]["key"]["recordId"] == record_id
        })
        .unwrap_or_else(|| panic!("missing {store}/{record_id} write"))["row"]["payloadJson"]
        .as_str()
        .expect("row payload is JSON");
    serde_json::from_str(payload).expect("row payload parses")
}

#[test]
fn checked_in_replica_conformance_corpus_exists() {
    let corpus = std::fs::read_to_string(corpus_path())
        .expect("the generated Replica conformance corpus must be checked in");

    assert!(!corpus.is_empty());
}

#[test]
fn corpus_declares_independent_oracle_empty_cursor_long_retry_and_plaintext_causality() {
    let corpus: Value = serde_json::from_str(
        &std::fs::read_to_string(corpus_path()).expect("Replica corpus is checked in"),
    )
    .expect("Replica corpus is JSON");
    assert_eq!(corpus["oracle"], "rustDomainLogicalSnapshots");
    assert_eq!(corpus["plaintextCausality"], "encryptedCreatePlanInput");

    let serialized = serde_json::to_string(&corpus).unwrap();
    assert!(serialized.contains(r#"\"type\":\"cold\""#));
    assert!(serialized.contains(r#"\"type\":\"capturedEmpty\""#));
    assert!(serialized.contains(r#"\"attemptCount\":\"7\""#));
}

#[test]
fn bootstrap_corpus_accumulates_two_captured_empty_pages_before_promotion() {
    let corpus: Value = serde_json::from_str(
        &std::fs::read_to_string(corpus_path()).expect("Replica corpus is checked in"),
    )
    .expect("Replica corpus is JSON");
    let history = corpus["histories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|history| history["name"] == "bootstrap-staging-promotion-and-tagged-cursor")
        .expect("named Bootstrap history exists");
    let steps = history["steps"].as_array().expect("history has steps");
    let labels: Vec<_> = steps
        .iter()
        .map(|step| step["label"].as_str().unwrap())
        .collect();
    assert_eq!(
        labels,
        [
            "install Bootstrap Account",
            "begin staged Bootstrap generation",
            "stage first Bootstrap page with captured-empty Cursor",
            "retry exact staged page persistence request",
            "stage final Bootstrap page and accumulate authority",
            "promote captured-empty Bootstrap generation atomically",
        ]
    );

    let first_page = &steps[2];
    let first_receipt = row_payload(first_page, "bootstrapPages", "generation-1/0");
    assert_eq!(first_receipt["pageIdentity"], "0");
    assert_eq!(
        first_receipt["requestCursor"],
        serde_json::json!({ "type": "initial" })
    );
    assert_eq!(
        first_receipt["pinnedWatermark"],
        serde_json::json!({ "type": "capturedEmpty" })
    );
    assert_eq!(
        first_receipt["continuation"],
        serde_json::json!({ "type": "more", "nextCursor": "page-2" })
    );
    assert_eq!(
        row_payload(
            first_page,
            "authorityItems",
            "generation-1/bootstrap-item-1"
        )["id"],
        "bootstrap-item-1"
    );
    assert_eq!(steps[3]["request"], first_page["request"]);

    let final_page = &steps[4];
    let final_receipt = row_payload(final_page, "bootstrapPages", "generation-1/1");
    assert_eq!(final_receipt["pageIdentity"], "1");
    assert_eq!(
        final_receipt["requestCursor"],
        serde_json::json!({ "type": "after", "cursor": "page-2" })
    );
    assert_eq!(
        final_receipt["pinnedWatermark"],
        serde_json::json!({ "type": "capturedEmpty" })
    );
    assert_eq!(
        final_receipt["continuation"],
        serde_json::json!({ "type": "final" })
    );
    assert_eq!(
        row_payload(
            final_page,
            "authorityItems",
            "generation-1/bootstrap-item-2"
        )["id"],
        "bootstrap-item-2"
    );

    let loaded = &steps[5]["expectedLoadedState"][0]["response"];
    let rows = loaded["rows"].as_array().expect("promoted state has rows");
    let metadata: Value = serde_json::from_str(
        rows.iter()
            .find(|row| row["store"] == "replicaMetadata")
            .expect("promoted metadata row exists")["payloadJson"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(metadata["state"], "ready");
    assert_eq!(
        metadata["activeCursor"],
        serde_json::json!({ "type": "capturedEmpty" })
    );
    let mut item_ids: Vec<_> = rows
        .iter()
        .filter(|row| row["store"] == "authorityItems")
        .map(|row| {
            let payload: Value =
                serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap();
            payload["id"].as_str().unwrap().to_owned()
        })
        .collect();
    item_ids.sort();
    assert_eq!(item_ids, ["bootstrap-item-1", "bootstrap-item-2"]);
}
