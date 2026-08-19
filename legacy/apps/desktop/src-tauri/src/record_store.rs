//! Bulk access to the disposable record namespace in `store.json`.
//!
//! The JavaScript store plugin exposes only one-key mutations. Looping over those methods
//! turns a 300-record refresh into hundreds of IPC calls even when `save()` is coalesced.
//! These commands keep the loop beside the store and cross the webview boundary once.

use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::tauri_api::{
    RecordStoreApplyArgs, RecordStoreEntry, RecordStoreGetArgs, RecordStoreListArgs,
};

const STORE_PATH: &str = "store.json";

#[tauri::command]
pub fn record_store_apply(
    app: AppHandle,
    puts: Vec<RecordStoreEntry>,
    deletes: Vec<String>,
    clear_prefixes: Vec<String>,
) -> Result<(), String> {
    let args = RecordStoreApplyArgs {
        puts,
        deletes,
        clear_prefixes,
    };
    let store = app
        .store(STORE_PATH)
        .map_err(|error| format!("Failed to access record store: {error}"))?;
    let mut changed = !args.puts.is_empty();

    for prefix in &args.clear_prefixes {
        for key in store.keys() {
            if key.starts_with(prefix) {
                changed = store.delete(key) || changed;
            }
        }
    }
    for key in &args.deletes {
        changed = store.delete(key) || changed;
    }
    for record in args.puts {
        store.set(record.key, record.value);
    }

    if changed {
        store
            .save()
            .map_err(|error| format!("Failed to persist record store: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn record_store_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let args = RecordStoreGetArgs { key };
    let store = app
        .store(STORE_PATH)
        .map_err(|error| format!("Failed to access record store: {error}"))?;
    Ok(store
        .get(args.key)
        .and_then(|value| value.as_str().map(str::to_owned)))
}

#[tauri::command]
pub fn record_store_list(app: AppHandle, prefix: String) -> Result<Vec<RecordStoreEntry>, String> {
    let args = RecordStoreListArgs { prefix };
    let store = app
        .store(STORE_PATH)
        .map_err(|error| format!("Failed to access record store: {error}"))?;
    Ok(store
        .entries()
        .into_iter()
        .filter_map(|(key, value)| {
            if !key.starts_with(&args.prefix) {
                return None;
            }
            value.as_str().map(|value| RecordStoreEntry {
                key,
                value: value.to_owned(),
            })
        })
        .collect())
}
