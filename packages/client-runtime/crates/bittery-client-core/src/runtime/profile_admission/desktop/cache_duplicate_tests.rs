use super::*;
use serde_json::Value;

const PRODUCER_CAPTURE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../core/src/services/fixtures/legacy-item-cache-duplicate-only-native-first-item-page.json"
));
const ACCOUNT: &str = "acc-duplicate-stage";
const EMAIL: &str = "acc-duplicate-stage@test.com";
const SERVER: &str = "https://bittery.test";

fn source() -> (
    BTreeMap<String, SecretString>,
    BTreeMap<String, SecretString>,
    Value,
) {
    let capture: Value = serde_json::from_str(PRODUCER_CAPTURE).unwrap();
    assert_eq!(
        capture["boundary"],
        "AccountVaultReplica.hydrateFromServer awaited first Item page"
    );
    assert_eq!(capture["stagedItems"], serde_json::json!([]));
    let state: Value = serde_json::from_str(capture["stateRaw"].as_str().unwrap()).unwrap();
    let active_generation = state["activeGeneration"].as_str().unwrap();
    let mut store = BTreeMap::new();
    store.insert(
        format!("record:{ACCOUNT}:meta:meta"),
        SecretString::from(capture["stateRaw"].as_str().unwrap().to_owned()),
    );
    for (field, kind) in [("activeItems", "items"), ("activeVaults", "vaults")] {
        for row in capture[field].as_array().unwrap() {
            store.insert(
                format!(
                    "record:item-cache-stage:{ACCOUNT}:{active_generation}:{kind}:{}",
                    row["id"].as_str().unwrap()
                ),
                SecretString::from(row["value"].as_str().unwrap().to_owned()),
            );
        }
    }
    for (collection, rows) in capture["stage"].as_object().unwrap() {
        for row in rows.as_array().unwrap() {
            store.insert(
                format!("record:{collection}:{}", row["id"].as_str().unwrap()),
                SecretString::from(row["value"].as_str().unwrap().to_owned()),
            );
        }
    }
    // This actual producer capture contains ItemCache metadata, not an independent Sync
    // checkpoint. Admission must keep its existing Cold/RefreshRequired disposition.
    (store, BTreeMap::new(), capture)
}

fn decode_source(
    store: &mut BTreeMap<String, SecretString>,
    sync: &mut BTreeMap<String, SecretString>,
) -> Result<BTreeMap<String, DecodedCache>, RuntimeError> {
    decode(
        |value, _| Ok(value.trim_end_matches('/').to_owned()),
        store,
        sync,
        &[AccountIdentity {
            account_id: ACCOUNT,
            user_id: "user-acc-duplicate-stage",
            email: EMAIL,
            normalized_server_url: SERVER,
            insecure_transport_confirmed: false,
        }],
    )
}

#[test]
fn actual_producer_duplicate_only_stage_admits_original_active_authority_and_cursor() {
    let (mut store, mut sync, capture) = source();
    let decoded = decode_source(&mut store, &mut sync).unwrap();
    assert!(
        store.is_empty(),
        "all proved duplicate rows should be consumed"
    );
    assert!(sync.is_empty());
    let active = decoded.get(ACCOUNT).unwrap();
    let state: Value = serde_json::from_str(capture["initialStateRaw"].as_str().unwrap()).unwrap();
    assert_eq!(
        active.source_active_generation.as_deref(),
        state["activeGeneration"].as_str()
    );
    assert_eq!(active.items.len(), 1);
    assert_eq!(active.items[0].id, "item-duplicate");
    assert_eq!(active.vaults.len(), 1);
    assert_eq!(active.vaults[0].id, "vault-duplicate");
    assert_eq!(
        active
            .metadata
            .as_ref()
            .unwrap()
            .sync_baseline
            .as_ref()
            .unwrap()
            .cursor,
        SyncCursor::CapturedValue {
            id: "evt-original".into()
        }
    );
    assert_eq!(active.sync_baseline, LegacyCheckpointEvidence::Missing {});
    assert_eq!(active.last_sync_cursor, active.sync_baseline);
}

fn refuses_unconsumed_stage(mut store: BTreeMap<String, SecretString>) {
    let (_, mut sync, _) = source();
    let result = decode_source(&mut store, &mut sync);
    assert!(
        result.is_err() || !store.is_empty(),
        "unproved source evidence was consumed"
    );
}

fn stage_key(kind: &str, id: &str) -> String {
    let capture: Value = serde_json::from_str(PRODUCER_CAPTURE).unwrap();
    let collection = capture["stage"].as_object().unwrap().keys().next().unwrap();
    let generation = collection
        .strip_prefix(&format!("item-cache-stage:{ACCOUNT}:"))
        .unwrap()
        .split(':')
        .next()
        .unwrap();
    format!("record:item-cache-stage:{ACCOUNT}:{generation}:{kind}:{id}")
}

fn active_key(kind: &str, id: &str) -> String {
    let capture: Value = serde_json::from_str(PRODUCER_CAPTURE).unwrap();
    let state: Value = serde_json::from_str(capture["stateRaw"].as_str().unwrap()).unwrap();
    let generation = state["activeGeneration"].as_str().unwrap();
    format!("record:item-cache-stage:{ACCOUNT}:{generation}:{kind}:{id}")
}

#[test]
fn nonduplicate_or_unscoped_stage_rows_remain_source_evidence() {
    for scenario in [
        "equivalent-json-different-bytes",
        "changed-record-id",
        "empty-record-id",
        "missing-active-record",
        "unique-baseline",
        "stage-only-item",
        "wrong-kind",
        "unknown-kind",
        "unknown-account",
        "absent-account-scope",
        "active-generation-baseline",
        "second-generation",
    ] {
        let (mut store, _, _) = source();
        let item_stage = stage_key("item-baseline", "item-duplicate");
        let vault_stage = stage_key("vaults", "vault-duplicate");
        match scenario {
            "equivalent-json-different-bytes" => {
                let raw = store.remove(&item_stage).unwrap();
                store.insert(item_stage, SecretString::from(format!("{} ", raw.as_ref())));
            }
            "changed-record-id" => {
                let raw = store.remove(&item_stage).unwrap();
                store.insert(stage_key("item-baseline", "different-id"), raw);
            }
            "empty-record-id" => {
                let raw = store.remove(&item_stage).unwrap();
                store.insert(stage_key("item-baseline", ""), raw);
            }
            "missing-active-record" => {
                store.remove(&active_key("items", "item-duplicate"));
            }
            "unique-baseline" => {
                let raw = store.remove(&item_stage).unwrap();
                let mut value: Value = serde_json::from_str(&raw).unwrap();
                value["version"] = serde_json::json!(2);
                store.insert(item_stage, SecretString::from(value.to_string()));
            }
            "stage-only-item" => {
                let raw = store.get(&item_stage).unwrap();
                store.insert(
                    stage_key("items", "new-item"),
                    SecretString::from(raw.as_ref().to_owned()),
                );
            }
            "wrong-kind" => {
                let raw = store.remove(&item_stage).unwrap();
                store.insert(stage_key("vault-baseline", "item-duplicate"), raw);
            }
            "unknown-kind" => {
                let raw = store.remove(&vault_stage).unwrap();
                store.insert(stage_key("unknown", "vault-duplicate"), raw);
            }
            "unknown-account" => {
                let raw = store.remove(&vault_stage).unwrap();
                store.insert(vault_stage.replacen(ACCOUNT, "unknown-account", 1), raw);
            }
            "absent-account-scope" => {
                let active = active_key("items", "item-duplicate");
                let raw = store.remove(&active).unwrap();
                let mut value: Value = serde_json::from_str(&raw).unwrap();
                value.as_object_mut().unwrap().remove("accountId");
                let raw = value.to_string();
                store.insert(active, SecretString::from(raw.clone()));
                store.insert(item_stage, SecretString::from(raw));
            }
            "active-generation-baseline" => {
                let raw = store.remove(&item_stage).unwrap();
                store.insert(active_key("item-baseline", "item-duplicate"), raw);
            }
            "second-generation" => {
                let raw = store.remove(&vault_stage).unwrap();
                store.insert(
                    format!("record:item-cache-stage:{ACCOUNT}:another-generation:vaults:vault-duplicate"),
                    raw,
                );
            }
            _ => unreachable!(),
        }
        refuses_unconsumed_stage(store);
    }
}

#[test]
fn accepted_account_match_cannot_hide_an_unknown_account_stage_partition() {
    let (mut store, _, _) = source();
    let ambiguous_id = "unknown:later:vaults:vault-duplicate";
    let original = store.get(&active_key("items", "item-duplicate")).unwrap();
    let mut item: Value = serde_json::from_str(original).unwrap();
    item["id"] = serde_json::json!(ambiguous_id);
    let raw = item.to_string();
    store.insert(
        active_key("items", ambiguous_id),
        SecretString::from(raw.clone()),
    );
    store.insert(stage_key("items", ambiguous_id), SecretString::from(raw));
    refuses_unconsumed_stage(store);
}

#[test]
fn stage_interpretation_cannot_overlap_the_selected_active_prefix() {
    let (mut store, _, _) = source();
    let ambiguous_id = "unknown:later:vaults:vault-duplicate";
    let original = store.get(&active_key("items", "item-duplicate")).unwrap();
    let mut item: Value = serde_json::from_str(original).unwrap();
    item["id"] = serde_json::json!(ambiguous_id);
    store.insert(
        active_key("items", ambiguous_id),
        SecretString::from(item.to_string()),
    );
    refuses_unconsumed_stage(store);
}

#[test]
fn consumed_active_rows_cannot_hide_an_unknown_stage_owner_without_leftover_stage_rows() {
    let (mut store, _, capture) = source();
    for (collection, rows) in capture["stage"].as_object().unwrap() {
        for row in rows.as_array().unwrap() {
            store.remove(&format!(
                "record:{collection}:{}",
                row["id"].as_str().unwrap()
            ));
        }
    }
    let ambiguous_id = "unknown:later:vaults:vault-duplicate";
    let original = store.get(&active_key("items", "item-duplicate")).unwrap();
    let mut item: Value = serde_json::from_str(original).unwrap();
    item["id"] = serde_json::json!(ambiguous_id);
    store.insert(
        active_key("items", ambiguous_id),
        SecretString::from(item.to_string()),
    );
    refuses_unconsumed_stage(store);
}

#[test]
fn plain_active_prefix_beginning_with_stage_name_keeps_older_unscoped_rows() {
    const LEGACY_ACCOUNT: &str = "item-cache-stage:legacy";
    let (_, mut sync, capture) = source();
    let mut state: Value = serde_json::from_str(capture["stateRaw"].as_str().unwrap()).unwrap();
    state["activeGeneration"] = Value::Null;
    state["nativeView"]["itemsKeyPrefix"] =
        serde_json::json!(format!("record:{LEGACY_ACCOUNT}:items:"));
    state["nativeView"]["vaultsKeyPrefix"] =
        serde_json::json!(format!("record:{LEGACY_ACCOUNT}:vaults:"));
    let mut store = BTreeMap::from([(
        format!("record:{LEGACY_ACCOUNT}:meta:meta"),
        SecretString::from(state.to_string()),
    )]);
    for (field, kind) in [("activeItems", "items"), ("activeVaults", "vaults")] {
        for row in capture[field].as_array().unwrap() {
            let mut value: Value = serde_json::from_str(row["value"].as_str().unwrap()).unwrap();
            value.as_object_mut().unwrap().remove("accountId");
            store.insert(
                format!(
                    "record:{LEGACY_ACCOUNT}:{kind}:{}",
                    row["id"].as_str().unwrap()
                ),
                SecretString::from(value.to_string()),
            );
        }
    }
    let decoded = decode(
        |value, _| Ok(value.trim_end_matches('/').to_owned()),
        &mut store,
        &mut sync,
        &[AccountIdentity {
            account_id: LEGACY_ACCOUNT,
            user_id: "user-acc-duplicate-stage",
            email: EMAIL,
            normalized_server_url: SERVER,
            insecure_transport_confirmed: false,
        }],
    )
    .unwrap();
    assert!(store.is_empty());
    assert_eq!(decoded[LEGACY_ACCOUNT].items[0].id, "item-duplicate");
    assert_eq!(decoded[LEGACY_ACCOUNT].vaults[0].id, "vault-duplicate");
}

#[test]
fn unambiguous_colon_bearing_account_and_record_ids_consume_only_duplicate_rows() {
    const COLON_ACCOUNT: &str = "acc:duplicate-stage";
    const COLON_ITEM: &str = "item:duplicate";
    const COLON_VAULT: &str = "vault:duplicate";
    // This is a key-grammar control derived from the authentic raw producer capture; it does
    // not claim that ciphertext re-bound to these synthetic IDs can be unlocked.
    let (store, mut sync, capture) = source();
    let mut store = store
        .into_iter()
        .map(|(key, raw)| {
            let key = key
                .replace(ACCOUNT, COLON_ACCOUNT)
                .replace("item-duplicate", COLON_ITEM)
                .replace("vault-duplicate", COLON_VAULT);
            let mut value: Value = serde_json::from_str(&raw).unwrap();
            if key.ends_with(":meta:meta") {
                for prefix in ["itemsKeyPrefix", "vaultsKeyPrefix"] {
                    let original = value["nativeView"][prefix].as_str().unwrap().to_owned();
                    value["nativeView"][prefix] =
                        serde_json::json!(original.replace(ACCOUNT, COLON_ACCOUNT));
                }
            } else {
                value["accountId"] = serde_json::json!(COLON_ACCOUNT);
                value["accountEmail"] = serde_json::json!("colon@test.com");
                if value.get("category").is_some() {
                    value["id"] = serde_json::json!(COLON_ITEM);
                    value["vaultId"] = serde_json::json!(COLON_VAULT);
                } else {
                    value["id"] = serde_json::json!(COLON_VAULT);
                }
            }
            (key, SecretString::from(value.to_string()))
        })
        .collect::<BTreeMap<_, _>>();
    let decoded = decode(
        |value, _| Ok(value.trim_end_matches('/').to_owned()),
        &mut store,
        &mut sync,
        &[AccountIdentity {
            account_id: COLON_ACCOUNT,
            user_id: "user-acc-duplicate-stage",
            email: "colon@test.com",
            normalized_server_url: SERVER,
            insecure_transport_confirmed: false,
        }],
    )
    .unwrap();
    assert!(store.is_empty());
    assert!(sync.is_empty());
    let active = decoded.get(COLON_ACCOUNT).unwrap();
    assert_eq!(active.items[0].id, COLON_ITEM);
    assert_eq!(active.items[0].vault_id, COLON_VAULT);
    assert_eq!(active.vaults[0].id, COLON_VAULT);
    assert_eq!(active.sync_baseline, LegacyCheckpointEvidence::Missing {});
    let original_state: Value =
        serde_json::from_str(capture["stateRaw"].as_str().unwrap()).unwrap();
    assert_eq!(
        active.source_active_generation.as_deref(),
        original_state["activeGeneration"].as_str()
    );
}
