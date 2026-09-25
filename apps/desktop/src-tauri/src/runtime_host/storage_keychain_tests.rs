//! Actual OS acceptance; the child selects this test alone so global mock setup cannot run.
//! Run from apps/desktop/src-tauri:
//! cargo test --lib runtime_host::storage::keychain_tests::real_os_device_secret_inventory_reads_fresh_keys_without_changing_cache -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::storage::keychain_tests::real_os_device_secret_inventory_refuses_malformed_entries_without_changes -- --ignored --exact --nocapture --test-threads=1
//! cargo test --lib runtime_host::storage::keychain_tests::real_os_device_secret_inventory_pages_without_changes_and_refuses_old_owner_cursor -- --ignored --exact --nocapture --test-threads=1

use super::*;
use crate::keychain::KeychainVault;
use keyring::Entry;
use serde_json::{json, Value};

const CHILD_MARKER: &str = "BITTERY91_DEVICE_SECRET_INVENTORY_CHILD";
const EXACT_TEST: &str = "runtime_host::storage::keychain_tests::real_os_device_secret_inventory_reads_fresh_keys_without_changing_cache";
const MALFORMED_TEST: &str = "runtime_host::storage::keychain_tests::real_os_device_secret_inventory_refuses_malformed_entries_without_changes";
const PAGING_TEST: &str = "runtime_host::storage::keychain_tests::real_os_device_secret_inventory_pages_without_changes_and_refuses_old_owner_cursor";
const SERVICE: &str = "com.bittery.desktop";

fn require(condition: bool, message: &'static str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

async fn invoke(platform: &NativePlatformStorage, request: Value) -> Result<Value, String> {
    let kind = request["type"]
        .as_str()
        .ok_or("Fixture request has no type")?;
    let response = platform
        .invoke(Zeroizing::new(request.to_string()))
        .await
        .map_err(|error| format!("Actual native {kind} failed: {:?}", error.code))?;
    serde_json::from_str(&response).map_err(|_| "Native response is not valid JSON".into())
}

fn unique_entry() -> Result<(String, Entry), String> {
    let identity = format!(
        "bittery91-inventory-{}",
        bittery_crypto_core::generate_uuid()
    );
    let physical =
        Entry::new(SERVICE, &identity).map_err(|_| "Cannot select the actual OS fixture entry")?;
    match physical.get_password() {
        Err(keyring::Error::NoEntry) => {}
        Ok(value) => {
            drop(Zeroizing::new(value));
            return Err("Unique OS fixture entry unexpectedly already exists".into());
        }
        Err(_) => return Err("Actual OS keychain is unavailable; acceptance cannot run".into()),
    }
    Ok((identity, physical))
}

fn cleanup_entry(
    identity: &str,
    physical: Entry,
    result: Result<(), String>,
) -> Result<(), String> {
    let _ = physical.delete_credential();
    match physical.get_password() {
        Err(keyring::Error::NoEntry) => result,
        Ok(value) => {
            drop(Zeroizing::new(value));
            Err(format!(
                "Fixture cleanup did not remove actual OS entry {identity}"
            ))
        }
        Err(_) => Err(format!(
            "Cannot prove actual OS fixture cleanup for entry {identity}"
        )),
    }
}

fn require_absent(physical: &Entry, message: &'static str) -> Result<(), String> {
    match physical.get_password() {
        Err(keyring::Error::NoEntry) => Ok(()),
        Ok(value) => {
            drop(Zeroizing::new(value));
            Err(message.into())
        }
        Err(_) => Err("Cannot verify actual OS fixture absence".into()),
    }
}

async fn actual_entry_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;

    // Once absence is proved, every outcome below runs exact-entry cleanup before it is returned.
    let result =
        async {
            let entry = Entry::new(SERVICE, &identity)
                .map_err(|_| "Cannot construct the isolated actual OS owner")?;
            let vault = Arc::new(KeychainVault::from_entry(
                entry,
                format!("desktop-keyring-test-v1:{identity}"),
            ));
            let directory =
                tempfile::tempdir().map_err(|_| "Cannot create native fixture directory")?;
            let platform = NativePlatformStorage::with_secrets(
                directory.path().join("platform.sqlite"),
                Arc::new(OsKeychain { vault }),
            )
            .map_err(|_| "Cannot open the native fixture platform store")?;
            let prefix = "bittery:runtime:platform-storage:";
            let key_a = "bittery:runtime:platform-storage:a";
            let key_b = "bittery:runtime:platform-storage:b";
            require(invoke(&platform, json!({
            "type": "set", "area": "deviceSecret", "key": key_a, "value": "cached-a-value"
        })).await? == json!({"type": "done"}), "Actual native Set did not acknowledge")?;
            require(
                invoke(
                    &platform,
                    json!({
                        "type": "get", "area": "deviceSecret", "key": key_a
                    }),
                )
                .await?
                    == json!({"type": "value", "value": "cached-a-value"}),
                "Actual native Set/Get did not establish the cached value",
            )?;

            // Deliberate whitespace and different A value expose any rewrite or cache refresh.
            let replacement = Zeroizing::new(format!(
            "{{\n  \"{key_b}\" : \"physical-b-value\",\n  \"{key_a}\" : \"physical-a-value\"\n}}\n"
        ));
            physical
                .set_password(&replacement)
                .map_err(|_| "Cannot replace the exact physical fixture entry")?;
            let before = Zeroizing::new(
                physical
                    .get_password()
                    .map_err(|_| "Cannot read the exact physical fixture bytes")?,
            );
            require(
                before.as_bytes() == replacement.as_bytes(),
                "The physical fixture entry did not retain exact replacement bytes",
            )?;
            require(
                invoke(
                    &platform,
                    json!({
                        "type": "get", "area": "deviceSecret", "key": key_b
                    }),
                )
                .await?
                    == json!({"type": "value", "value": null}),
                "The fixture must prove the owner cache predates physical key B",
            )?;

            let page = invoke(
                &platform,
                json!({
                    "type": "listKeys", "area": "deviceSecret", "prefix": prefix, "cursor": null
                }),
            )
            .await;

            let after = Zeroizing::new(
                physical
                    .get_password()
                    .map_err(|_| "Cannot verify the physical fixture bytes after inventory")?,
            );
            require(
                after.as_bytes() == before.as_bytes(),
                "Inventory changed physical credential bytes",
            )?;
            require(
                invoke(
                    &platform,
                    json!({
                        "type": "get", "area": "deviceSecret", "key": key_a
                    }),
                )
                .await?
                    == json!({"type": "value", "value": "cached-a-value"}),
                "Inventory changed the existing cached A value",
            )?;
            require(
                invoke(
                    &platform,
                    json!({
                        "type": "get", "area": "deviceSecret", "key": key_b
                    }),
                )
                .await?
                    == json!({"type": "value", "value": null}),
                "Inventory populated the existing cache with physical key B",
            )?;
            require(
                page?
                    == json!({
                        "type": "keysPage", "version": 1, "family": "platformStorage",
                        "backingAreas": ["deviceSecret"], "keys": [key_a, key_b],
                        "continuation": {"type": "end"}
                    }),
                "DeviceSecret inventory did not return exact fresh keys without values",
            )?;
            require(
                invoke(
                    &platform,
                    json!({
                        "type": "deleteIfUnchanged", "area": "deviceSecret", "key": key_b,
                        "expectedValue": "stale-b-value"
                    }),
                )
                .await?
                    == json!({"type": "deleteResult", "result": "conflict"}),
                "Guarded DeviceSecret deletion did not preserve changed physical evidence",
            )?;
            let conflicted = Zeroizing::new(
                physical
                    .get_password()
                    .map_err(|_| "Cannot verify physical bytes after guarded conflict")?,
            );
            require(
                conflicted.as_bytes() == before.as_bytes(),
                "Guarded DeviceSecret conflict changed physical bytes",
            )?;
            require(
                invoke(
                    &platform,
                    json!({
                        "type": "deleteIfUnchanged", "area": "deviceSecret", "key": key_b,
                        "expectedValue": "physical-b-value"
                    }),
                )
                .await?
                    == json!({"type": "deleteResult", "result": "deleted"}),
                "Guarded DeviceSecret deletion did not remove exact physical evidence",
            )?;
            require(
                invoke(
                    &platform,
                    json!({
                        "type": "deleteIfUnchanged", "area": "deviceSecret", "key": key_b,
                        "expectedValue": "physical-b-value"
                    }),
                )
                .await?
                    == json!({"type": "deleteResult", "result": "alreadyAbsent"}),
                "Guarded DeviceSecret deletion replay did not prove absence",
            )?;
            let retained = Zeroizing::new(
                physical
                    .get_password()
                    .map_err(|_| "Cannot verify guarded physical preservation")?,
            );
            require(
                retained.as_str() == format!(r#"{{"{key_a}":"physical-a-value"}}"#),
                "Guarded DeviceSecret deletion changed the unrelated raw value",
            )
        }
        .await;

    cleanup_entry(&identity, physical, result)
}

fn isolated_child(exact_test: &str) -> Result<bool, String> {
    match std::env::var_os(CHILD_MARKER) {
        None => {
            let executable =
                std::env::current_exe().map_err(|_| "Cannot locate the native test executable")?;
            let output = std::process::Command::new(executable)
                .args([
                    exact_test,
                    "--ignored",
                    "--exact",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env(CHILD_MARKER, "1")
                .stdin(std::process::Stdio::null())
                .output()
                .map_err(|_| "Cannot start the isolated actual OS test child")?;
            eprint!("{}", String::from_utf8_lossy(&output.stderr));
            require(
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("1 passed; 0 failed"),
                "Isolated actual OS DeviceSecret inventory failed",
            )?;
            Ok(false)
        }
        Some(value) if value == "1" => Ok(true),
        Some(_) => Err("Unexpected actual OS inventory child marker".into()),
    }
}

#[tokio::test]
#[ignore = "Requires the actual OS keychain; spawns an isolated exact-test child, never a mock"]
async fn real_os_device_secret_inventory_reads_fresh_keys_without_changing_cache(
) -> Result<(), String> {
    if isolated_child(EXACT_TEST)? {
        actual_entry_case().await
    } else {
        Ok(())
    }
}

async fn malformed_entry_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry = Entry::new(SERVICE, &identity)
            .map_err(|_| "Cannot construct the isolated actual OS owner")?;
        let directory = tempfile::tempdir().map_err(|_| "Cannot create native fixture directory")?;
        let platform = NativePlatformStorage::with_secrets(
            directory.path().join("platform.sqlite"),
            Arc::new(OsKeychain {
                vault: Arc::new(KeychainVault::from_entry(entry, format!("desktop-keyring-test-v1:{identity}"))),
            }),
        )
        .map_err(|_| "Cannot open the native fixture platform store")?;
        let cached_get = json!({
            "type": "get", "area": "deviceSecret", "key": "bittery:runtime:platform-storage:a"
        });
        let list = json!({
            "type": "listKeys", "area": "deviceSecret",
            "prefix": "bittery:runtime:platform-storage:", "cursor": null
        });
        require(
            invoke(&platform, json!({
                "type": "set", "area": "deviceSecret",
                "key": "bittery:runtime:platform-storage:a", "value": "cached-old-value"
            })).await? == json!({"type": "done"}),
            "Actual native Set did not acknowledge",
        )?;
        require(
            invoke(&platform, cached_get.clone()).await?
                == json!({"type": "value", "value": "cached-old-value"}),
            "Actual native Set/Get did not establish the cached value",
        )?;

        for (label, raw) in [
            ("duplicate key", r#"{"bittery:runtime:platform-storage:a":"first","bittery:runtime:platform-storage:a":"second"}"#),
            ("escaped duplicate key", r#"{"bittery:runtime:platform-storage:a":"first","bittery:runtime:platform-storage:\u0061":"second"}"#),
            ("duplicate key outside requested prefix", r#"{"legacy":"first","\u006cegacy":"second"}"#),
            ("nonstring value", r#"{"bittery:runtime:platform-storage:b":7}"#),
            ("invalid Unicode key", r#"{"bittery:runtime:platform-storage:\uD800":"value"}"#),
            ("invalid Unicode value", r#"{"bittery:runtime:platform-storage:a":"\uD800"}"#),
            ("malformed JSON", r#"{"bittery:runtime:platform-storage:a":"value""#),
            ("trailing JSON", r#"{"bittery:runtime:platform-storage:a":"value"} {"trailing":"object"}"#),
        ] {
            let case_result: Result<(), String> = async {
                let replacement = Zeroizing::new(raw.to_owned());
                physical.set_password(&replacement)
                    .map_err(|_| "Cannot replace the exact physical fixture entry")?;
                let before = Zeroizing::new(physical.get_password()
                    .map_err(|_| "Cannot read the exact physical fixture bytes")?);
                require(before.as_bytes() == replacement.as_bytes(),
                    "The physical fixture did not retain exact malformed bytes")?;

                let response = platform.invoke(Zeroizing::new(list.to_string())).await;
                let after = Zeroizing::new(physical.get_password()
                    .map_err(|_| "Cannot verify physical bytes after refused inventory")?);
                require(after.as_bytes() == before.as_bytes(),
                    "Refused inventory changed physical credential bytes")?;
                require(invoke(&platform, cached_get.clone()).await?
                    == json!({"type": "value", "value": "cached-old-value"}),
                    "Refused inventory changed the existing cached value")?;
                require(matches!(response, Err(error) if error.code == RuntimeErrorCode::StorageUnavailable),
                    "Malformed physical credential map did not refuse inventory")
            }.await;
            case_result.map_err(|error| format!("{label}: {error}"))?;
        }

        physical.delete_credential().map_err(|_| "Cannot remove exact fixture entry for absence check")?;
        require_absent(&physical,
            "Physical absence was not proved before empty inventory")?;
        require(invoke(&platform, list).await? == json!({
            "type": "keysPage", "version": 1, "family": "platformStorage",
            "backingAreas": ["deviceSecret"], "keys": [], "continuation": {"type": "end"}
        }), "Genuine physical absence did not produce empty End")?;
        require_absent(&physical,
            "Empty inventory created a physical credential entry")?;
        require(invoke(&platform, cached_get).await?
            == json!({"type": "value", "value": "cached-old-value"}),
            "Empty inventory changed the existing cached value")
    }.await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires the actual OS keychain; spawns an isolated exact-test child, never a mock"]
async fn real_os_device_secret_inventory_refuses_malformed_entries_without_changes(
) -> Result<(), String> {
    if isolated_child(MALFORMED_TEST)? {
        malformed_entry_case().await
    } else {
        Ok(())
    }
}

async fn paging_entry_case() -> Result<(), String> {
    let (identity, physical) = unique_entry()?;
    let result = async {
        let entry = Entry::new(SERVICE, &identity)
            .map_err(|_| "Cannot construct the isolated actual OS owner")?;
        let secrets = Arc::new(OsKeychain {
            vault: Arc::new(KeychainVault::from_entry(entry, format!("desktop-keyring-test-v1:{identity}"))),
        });
        let directory = tempfile::tempdir().map_err(|_| "Cannot create native fixture directory")?;
        let path = directory.path().join("platform.sqlite");
        let platform = NativePlatformStorage::with_secrets(&path, secrets.clone())
            .map_err(|_| "Cannot open the native fixture platform store")?;
        let prefix = "bittery:runtime:platform-storage:";
        let expected: Vec<String> = (0..129).map(|index| format!("{prefix}{index:03}")).collect();
        let cached_get = json!({
            "type": "get", "area": "deviceSecret", "key": expected[0]
        });
        let uncached_get = json!({
            "type": "get", "area": "deviceSecret", "key": expected[1]
        });
        require(invoke(&platform, json!({
            "type": "set", "area": "deviceSecret", "key": expected[0], "value": "cached-old-value"
        })).await? == json!({"type": "done"}), "Actual native Set did not acknowledge")?;
        require(invoke(&platform, cached_get.clone()).await?
            == json!({"type": "value", "value": "cached-old-value"}),
            "Actual native Set/Get did not establish the cached value")?;

        // A literal reverse-order object, not a map serialization that could sort the keys.
        let replacement = Zeroizing::new(format!("{{{}}}", expected.iter().rev()
            .map(|key| format!(r#""{key}":"p""#)).collect::<Vec<_>>().join(",")));
        physical.set_password(&replacement)
            .map_err(|_| "Cannot replace the exact physical fixture entry")?;
        let before = Zeroizing::new(physical.get_password()
            .map_err(|_| "Cannot read the exact physical fixture bytes")?);
        require(before.as_bytes() == replacement.as_bytes(),
            "The physical fixture did not retain exact reverse-order bytes")?;
        require(invoke(&platform, uncached_get.clone()).await? == json!({"type": "value", "value": null}),
            "The fixture must prove the cache predates the physical paging keys")?;

        let mut cursor: Option<String> = None;
        let mut old_owner_cursor: Option<String> = None;
        let mut collected = Vec::new();
        for (page_index, expected_keys) in [&expected[..128], &expected[128..]].into_iter().enumerate() {
            let request = json!({
                "type": "listKeys", "area": "deviceSecret", "prefix": prefix, "cursor": cursor
            });
            let wire = platform.invoke(Zeroizing::new(request.to_string())).await
                .map_err(|_| "Actual protected inventory page failed")?;
            require(wire.len() <= 262_144, "Protected inventory exceeded the wire byte bound")?;
            let page: Value = serde_json::from_str(&wire)
                .map_err(|_| "Protected inventory page is not valid JSON")?;
            let keys = page["keys"].as_array().ok_or("Protected inventory has no key array")?;
            require(keys.len() <= 128, "Protected inventory exceeded the page key bound")?;
            let continuation = if page_index == 0 {
                require(page["continuation"]["type"] == "more", "129 keys must produce More")?;
                let next = page["continuation"]["cursor"].as_str()
                    .ok_or("Protected inventory More has no opaque cursor")?.to_owned();
                require(!next.is_empty(), "Protected inventory cursor is empty")?;
                old_owner_cursor = Some(next.clone());
                cursor = Some(next.clone());
                json!({"type": "more", "cursor": next})
            } else {
                cursor = None;
                json!({"type": "end"})
            };
            require(page == json!({
                "type": "keysPage", "version": 1, "family": "platformStorage",
                "backingAreas": ["deviceSecret"], "keys": expected_keys, "continuation": continuation
            }), "Protected inventory did not return the exact ordered keys-only page")?;
            for key in keys {
                collected.push(key.as_str().ok_or("Protected inventory returned a nonstring key")?.to_owned());
            }
            if page_index == 1 {
                let replay = platform.invoke(Zeroizing::new(request.to_string())).await
                    .map_err(|_| "Repeating the live protected inventory cursor failed")?;
                require(replay.as_bytes() == wire.as_bytes(),
                    "Repeating the live protected inventory cursor changed its page")?;
            }
            let after = Zeroizing::new(physical.get_password()
                .map_err(|_| "Cannot verify the physical entry after paging")?);
            require(after.as_bytes() == before.as_bytes(), "Protected paging changed physical credential bytes")?;
            require(invoke(&platform, cached_get.clone()).await?
                == json!({"type": "value", "value": "cached-old-value"}),
                "Protected paging changed the existing cached value")?;
            require(invoke(&platform, uncached_get.clone()).await? == json!({"type": "value", "value": null}),
                "Protected paging populated the existing cache")?;
        }
        require(collected == expected && cursor.is_none(),
            "Protected inventory did not enumerate the complete 129-key sequence to End")?;
        let old_owner_cursor = old_owner_cursor.ok_or("Protected inventory produced no reusable cursor")?;

        drop(platform);
        // Production reuses its existing protected-entry owner across native storage instances too.
        let reopened = NativePlatformStorage::with_secrets(&path, secrets)
            .map_err(|_| "Cannot reopen the native fixture platform store")?;
        let old_page = reopened.invoke(Zeroizing::new(json!({
            "type": "listKeys", "area": "deviceSecret", "prefix": prefix, "cursor": old_owner_cursor
        }).to_string())).await;
        let after = Zeroizing::new(physical.get_password()
            .map_err(|_| "Cannot verify the physical entry after old-cursor refusal")?);
        require(after.as_bytes() == before.as_bytes(), "Old-cursor refusal changed physical credential bytes")?;
        require(invoke(&reopened, cached_get).await?
            == json!({"type": "value", "value": "cached-old-value"}),
            "Old-cursor refusal changed the existing cached value")?;
        require(invoke(&reopened, uncached_get).await? == json!({"type": "value", "value": null}),
            "Old-cursor refusal populated the existing cache")?;
        require(matches!(old_page, Err(error) if error.code == RuntimeErrorCode::StorageUnavailable),
            "Reopened native owner accepted its predecessor's cursor")
    }.await;
    cleanup_entry(&identity, physical, result)
}

#[tokio::test]
#[ignore = "Requires the actual OS keychain; spawns an isolated exact-test child, never a mock"]
async fn real_os_device_secret_inventory_pages_without_changes_and_refuses_old_owner_cursor(
) -> Result<(), String> {
    if isolated_child(PAGING_TEST)? {
        paging_entry_case().await
    } else {
        Ok(())
    }
}
