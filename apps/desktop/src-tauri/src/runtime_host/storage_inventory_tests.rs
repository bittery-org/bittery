//! Conformance through the native serialized storage seam, including physical-file preservation.

use super::*;
use serde_json::{json, Value};

fn durable_bytes(path: &Path) -> (Vec<u8>, Option<Vec<u8>>) {
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let wal = match std::fs::read(std::path::PathBuf::from(wal)) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => panic!("could not read fixture WAL: {error}"),
    };
    (std::fs::read(path).unwrap(), wal)
}

#[tokio::test]
async fn inventory_refuses_unsupported_physical_keys_and_changed_schema_without_writes() {
    for (case, sql) in [
        (
            "blob key",
            "INSERT INTO platform_records VALUES (X'80', 'opaque-invalid-key-value');",
        ),
        (
            "invalid UTF-8 key",
            "INSERT INTO platform_records VALUES (CAST(X'80' AS TEXT), 'opaque-invalid-key-value');",
        ),
        (
            "empty key",
            "INSERT INTO platform_records VALUES ('', 'opaque-invalid-key-value');",
        ),
        (
            "oversized unrelated key",
            "INSERT INTO platform_records VALUES (printf('%0*d', 4097, 0), 'opaque-invalid-key-value');",
        ),
        (
            "new view after open",
            "CREATE VIEW sqliteXforeign AS SELECT key, value FROM platform_records;",
        ),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("unsupported-inventory.sqlite");
        let storage = NativePlatformStorage::open(&path).unwrap();
        let retained_key = "bittery:runtime:platform-storage:retained";
        storage
            .invoke(Zeroizing::new(
                json!({
                    "type":"set", "area":"devicePlain", "key":retained_key,
                    "value":"original-retained-value"
                })
                .to_string(),
            ))
            .await
            .unwrap();
        // Physical corruption and foreign schema cannot be constructed through ordinary Set.
        // Inject them into the actual file, then observe refusal at the serialized public seam.
        {
            let raw = Connection::open(&path).unwrap();
            raw.execute_batch(sql).unwrap();
        }
        let before = durable_bytes(&path);
        assert!(
            storage
                .invoke(Zeroizing::new(
                    json!({
                        "type":"listKeys", "area":"devicePlain",
                        "prefix":"bittery:runtime:platform-storage:", "cursor":null
                    })
                    .to_string()
                ))
                .await
                .is_err(),
            "{case} cannot disappear from a complete physical census"
        );
        assert!(
            durable_bytes(&path) == before,
            "{case} refusal must preserve all database and WAL evidence"
        );
        let retained = storage
            .invoke(Zeroizing::new(
                json!({"type":"get", "area":"devicePlain", "key":retained_key}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&retained).unwrap(),
            json!({"type":"value", "value":"original-retained-value"})
        );
    }
}

#[tokio::test]
async fn inventory_pages_preserve_escaped_keys_within_wire_byte_bound() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("escaped-platform.sqlite");
    let storage = NativePlatformStorage::open(&path).unwrap();
    let prefix = "bittery:runtime:platform-storage:escaped:";
    // These legal keys fit the UTF-8 key bound but expand sixfold in JSON. Twenty keys require
    // continuation because of complete wire bytes, well before the 128-key count limit.
    let keys: Vec<_> = (0..20)
        .map(|index| format!("{prefix}{index:03}:{}", "\0".repeat(4000)))
        .collect();
    for area in ["devicePlain", "sessionSecret"] {
        for key in keys.iter().rev() {
            storage
                .invoke(Zeroizing::new(
                    json!({"type":"set", "area":area, "key":key, "value":"retained-value"})
                        .to_string(),
                ))
                .await
                .unwrap();
        }
        let before = durable_bytes(&path);
        let mut cursor: Option<String> = None;
        let mut collected = Vec::new();
        let mut pages = 0;
        let mut ended = false;
        for _ in 0..=keys.len() {
            let raw = storage
                .invoke(Zeroizing::new(
                    json!({"type":"listKeys", "area":area, "prefix":prefix, "cursor":cursor})
                        .to_string(),
                ))
                .await
                .unwrap();
            assert!(raw.len() <= 262_144, "cursor and escaped keys must all fit");
            assert!(!raw.contains("retained-value"));
            let page: Value = serde_json::from_str(&raw).unwrap();
            let page_keys: Vec<String> = serde_json::from_value(page["keys"].clone()).unwrap();
            assert!(page_keys.len() <= 128);
            let continuation = match page["continuation"]["type"].as_str().unwrap() {
                "more" => {
                    assert!(!page_keys.is_empty());
                    let next = page["continuation"]["cursor"].as_str().unwrap();
                    assert_ne!(cursor.as_deref(), Some(next));
                    cursor = Some(next.to_owned());
                    json!({"type":"more", "cursor":next})
                }
                "end" => {
                    ended = true;
                    json!({"type":"end"})
                }
                _ => panic!("unknown continuation"),
            };
            assert_eq!(
                page,
                json!({
                    "type":"keysPage", "version":1, "family":"platformStorage",
                    "backingAreas":[area], "keys":page_keys, "continuation":continuation
                })
            );
            collected.extend(page_keys);
            pages += 1;
            if ended {
                break;
            }
        }
        assert!(
            ended && pages > 1,
            "all escaped keys must be paged to an end"
        );
        assert_eq!(collected, keys);
        assert!(durable_bytes(&path) == before);
        let value = storage
            .invoke(Zeroizing::new(
                json!({"type":"get", "area":area, "key":keys[19]}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&value).unwrap(),
            json!({"type":"value", "value":"retained-value"})
        );
    }
}
