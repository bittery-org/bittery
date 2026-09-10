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
fn bootstrap_corpus_accumulates_phase_scoped_pages_before_promotion() {
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
            "stage standalone Bootstrap Vault authority",
            "retry exact staged page persistence request",
            "stage first Item page and accumulate authority",
            "stage final Bootstrap Item page",
            "promote captured-empty Bootstrap generation atomically",
        ]
    );

    let vault_page = &steps[2];
    let vault_receipt = row_payload(vault_page, "bootstrapPages", "generation-1/vaults:0");
    assert_eq!(
        vault_receipt["pageIdentity"],
        serde_json::json!({ "phase": "vaults", "ordinal": "0" })
    );
    assert_eq!(
        vault_receipt["requestCursor"],
        serde_json::json!({ "type": "vaultsInitial" })
    );
    assert_eq!(
        vault_receipt["pinnedWatermark"],
        serde_json::json!({ "type": "capturedEmpty" })
    );
    assert_eq!(
        vault_receipt["continuation"],
        serde_json::json!({ "type": "final" })
    );
    assert_eq!(
        row_payload(vault_page, "authorityVaults", "generation-1/vault-1")["id"],
        "vault-1"
    );
    assert_eq!(steps[3]["request"], vault_page["request"]);

    let first_item_page = &steps[4];
    let first_item_receipt = row_payload(first_item_page, "bootstrapPages", "generation-1/items:0");
    assert_eq!(
        first_item_receipt["pageIdentity"],
        serde_json::json!({ "phase": "items", "ordinal": "0" })
    );
    assert_eq!(
        first_item_receipt["requestCursor"],
        serde_json::json!({ "type": "itemsInitial" })
    );
    assert_eq!(
        first_item_receipt["continuation"],
        serde_json::json!({ "type": "more", "nextCursor": "page-2" })
    );
    assert_eq!(
        row_payload(
            first_item_page,
            "authorityItems",
            "generation-1/bootstrap-item-1"
        )["id"],
        "bootstrap-item-1"
    );

    let final_page = &steps[5];
    let final_receipt = row_payload(final_page, "bootstrapPages", "generation-1/items:1");
    assert_eq!(
        final_receipt["pageIdentity"],
        serde_json::json!({ "phase": "items", "ordinal": "1" })
    );
    assert_eq!(
        final_receipt["requestCursor"],
        serde_json::json!({ "type": "itemsAfter", "cursor": "page-2" })
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

    let loaded = &steps[6]["expectedLoadedState"][0]["response"];
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

#[test]
fn corpus_exercises_multi_item_bootstrap_and_atomic_import_batches() {
    let corpus: Value =
        serde_json::from_str(&std::fs::read_to_string(corpus_path()).unwrap()).unwrap();
    let histories = corpus["histories"].as_array().unwrap();
    let bootstrap = histories
        .iter()
        .find(|history| history["name"] == "five-category-item-authority")
        .unwrap();
    let page = bootstrap["steps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|step| step["label"] == "stage five-category Item page")
        .unwrap();
    let writes = page["request"]["prepared"]["writes"].as_array().unwrap();
    assert_eq!(
        writes
            .iter()
            .filter(|write| write["type"] == "put" && write["row"]["store"] == "authorityItems")
            .count(),
        5,
        "one prepared Bootstrap plan must install several Items"
    );
    let import = histories
        .iter()
        .find(|history| history["name"] == "import-batch-authority-and-rejection-are-atomic")
        .unwrap();
    let steps = import["steps"].as_array().unwrap();
    let accepted = steps
        .iter()
        .find(|step| step["label"] == "atomically accept the first Import request")
        .unwrap();
    let operation = row_payload(accepted, "operations", "operation-import-first");
    let body: Vec<u8> = serde_json::from_value(operation["request"]["body"].clone()).unwrap();
    let body: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["items"].as_array().unwrap().len(), 5);
    let reconciled = steps
        .iter()
        .find(|step| {
            step["label"]
                == "atomically install first batch authority, its receipt, and remove the Operation"
        })
        .unwrap();
    assert_eq!(
        row_payload(reconciled, "operationReceipts", "operation-import-first")["result"]
            ["importedCount"],
        5
    );
    let writes = reconciled["request"]["prepared"]["writes"]
        .as_array()
        .unwrap();
    assert_eq!(
        writes
            .iter()
            .filter(|write| write["type"] == "put" && write["row"]["store"] == "authorityItems")
            .count(),
        5
    );
    assert_eq!(
        writes
            .iter()
            .filter(|write| write["type"] == "delete" && write["store"] == "operations")
            .count(),
        1
    );
    let final_rows = steps.last().unwrap()["expectedLoadedState"][0]["response"]["rows"]
        .as_array()
        .unwrap();
    let items = final_rows
        .iter()
        .filter(|row| row["store"] == "authorityItems")
        .collect::<Vec<_>>();
    assert_eq!(
        items.len(),
        8,
        "both applied batches preserve the preexisting Bootstrap Item"
    );
    assert_eq!(
        items
            .iter()
            .filter(|row| row["key"]["recordId"]
                .as_str()
                .unwrap()
                .contains("operation-import-"))
            .count(),
        7
    );
    assert_eq!(
        final_rows
            .iter()
            .filter(|row| row["store"] == "operationReceipts")
            .count(),
        3
    );
}
