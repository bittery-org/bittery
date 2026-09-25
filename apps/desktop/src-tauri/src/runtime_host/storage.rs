//! Primitive native storage execution. Core alone assigns keys, formats and lifetimes.

use async_trait::async_trait;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use bittery_client_core::{
    validate_native_sqlite_schema, PlatformStorageArea, PlatformStorageDeleteResult,
    PlatformStorageInventoryContinuation, PlatformStorageInventoryFamily, PlatformStorageKeysPage,
    PlatformStorageRequest, PlatformStorageResponse, RuntimeError, RuntimeErrorCode, SecretString,
    SerializedPlatformStorageExecutor,
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::sync::Mutex;
use std::{collections::HashMap, path::Path, sync::Arc};
use zeroize::Zeroizing;

const SCHEMA: &str =
    "CREATE TABLE platform_records (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);";

pub(super) struct NativePlatformStorage {
    state: Arc<tokio::sync::Mutex<StorageState>>,
    #[cfg(test)]
    worker_barrier: Option<Arc<TestWorkerBarrier>>,
}

#[cfg(test)]
struct TestWorkerBarrier {
    state: Mutex<TestWorkerBarrierState>,
    changed: std::sync::Condvar,
}

#[cfg(test)]
struct TestWorkerBarrierState {
    armed: bool,
    entered: bool,
    released: bool,
}

#[cfg(test)]
impl TestWorkerBarrier {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(TestWorkerBarrierState {
                armed: true,
                entered: false,
                released: false,
            }),
            changed: std::sync::Condvar::new(),
        })
    }

    fn block_next_worker(&self) {
        let mut state = self.state.lock().unwrap();
        if !state.armed {
            return;
        }
        state.armed = false;
        state.entered = true;
        self.changed.notify_all();
        while !state.released {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn wait_until_entered(&self) {
        let mut state = self.state.lock().unwrap();
        while !state.entered {
            state = self.changed.wait(state).unwrap();
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().unwrap();
        state.released = true;
        self.changed.notify_all();
    }
}

struct StorageState {
    device: Connection,
    session: HashMap<String, SecretString>,
    secrets: Arc<dyn DeviceSecrets>,
    inventory_nonce: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InventoryCursor {
    version: u32,
    owner: String,
    area: PlatformStorageArea,
    prefix: String,
    after: String,
}

impl InventoryCursor {
    fn decode(
        cursor: Option<&str>,
        owner: &str,
        area: PlatformStorageArea,
        prefix: &str,
    ) -> Result<Option<String>, RuntimeError> {
        let Some(cursor) = cursor else {
            return Ok(None);
        };
        if cursor.is_empty() || cursor.len() > PlatformStorageKeysPage::MAX_CURSOR_BYTES {
            return Err(unavailable());
        }
        let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| unavailable())?;
        let cursor: Self = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if cursor.version != 1
            || cursor.owner != owner
            || cursor.area != area
            || cursor.prefix != prefix
            || cursor.after.is_empty()
            || cursor.after.len() > PlatformStorageKeysPage::MAX_KEY_BYTES
            || !cursor.after.starts_with(prefix)
        {
            return Err(unavailable());
        }
        Ok(Some(cursor.after))
    }

    fn encode(
        owner: &str,
        area: PlatformStorageArea,
        prefix: &str,
        after: &str,
    ) -> Result<String, RuntimeError> {
        let bytes = serde_json::to_vec(&Self {
            version: 1,
            owner: owner.into(),
            area,
            prefix: prefix.into(),
            after: after.into(),
        })
        .map_err(|_| unavailable())?;
        let cursor = URL_SAFE_NO_PAD.encode(bytes);
        if cursor.len() > PlatformStorageKeysPage::MAX_CURSOR_BYTES {
            return Err(inventory_bound());
        }
        Ok(cursor)
    }
}

impl StorageState {
    fn delete_if_unchanged(
        &mut self,
        area: PlatformStorageArea,
        key: &str,
        expected_value: &str,
    ) -> Result<PlatformStorageDeleteResult, RuntimeError> {
        match area {
            PlatformStorageArea::DevicePlain => {
                let transaction = self
                    .device
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|_| unavailable())?;
                let actual = transaction
                    .query_row(
                        "SELECT CAST(value AS BLOB) FROM platform_records WHERE key = ?1",
                        [key],
                        |row| row.get::<_, Vec<u8>>(0),
                    )
                    .optional()
                    .map_err(|_| unavailable())?;
                let result = match actual {
                    None => PlatformStorageDeleteResult::AlreadyAbsent,
                    Some(actual) if actual.as_slice() == expected_value.as_bytes() => {
                        transaction
                            .execute("DELETE FROM platform_records WHERE key = ?1", [key])
                            .map_err(|_| unavailable())?;
                        PlatformStorageDeleteResult::Deleted
                    }
                    Some(_) => PlatformStorageDeleteResult::Conflict,
                };
                transaction.commit().map_err(|_| unavailable())?;
                Ok(result)
            }
            PlatformStorageArea::SessionSecret => {
                let result = match self.session.get(key) {
                    None => PlatformStorageDeleteResult::AlreadyAbsent,
                    Some(actual) if actual.as_ref().as_bytes() == expected_value.as_bytes() => {
                        self.session.remove(key);
                        PlatformStorageDeleteResult::Deleted
                    }
                    Some(_) => PlatformStorageDeleteResult::Conflict,
                };
                Ok(result)
            }
            PlatformStorageArea::DeviceSecret => self.secrets.compare_delete(key, expected_value),
        }
    }

    fn list_keys(
        &mut self,
        area: PlatformStorageArea,
        prefix: &str,
        cursor: Option<&str>,
    ) -> Result<PlatformStorageKeysPage, RuntimeError> {
        let after = InventoryCursor::decode(cursor, &self.inventory_nonce, area, prefix)?;
        let mut keys = Vec::<String>::new();
        let mut select = |key: &str| -> Result<(), RuntimeError> {
            if key.is_empty() {
                return Err(unavailable());
            }
            if key.len() > PlatformStorageKeysPage::MAX_KEY_BYTES {
                return Err(inventory_bound());
            }
            if !key.starts_with(prefix) || after.as_deref().is_some_and(|after| key <= after) {
                return Ok(());
            }
            let index = keys
                .binary_search_by(|candidate| candidate.as_str().cmp(key))
                .map_or_else(Ok, |_| Err(unavailable()))?;
            // Session storage is unordered. Keep only the next bounded page and its lookahead.
            if index <= PlatformStorageKeysPage::MAX_PAGE_KEYS {
                keys.insert(index, key.into());
                keys.truncate(PlatformStorageKeysPage::MAX_PAGE_KEYS + 1);
            }
            Ok(())
        };
        match area {
            PlatformStorageArea::DevicePlain => {
                let transaction = self.device.transaction().map_err(|_| unavailable())?;
                let version: u32 = transaction
                    .pragma_query_value(None, "user_version", |row| row.get(0))
                    .map_err(|_| unavailable())?;
                if version != 1 {
                    return Err(unavailable());
                }
                validate_native_sqlite_schema(&transaction, SCHEMA).map_err(|_| unavailable())?;
                let mut statement = transaction
                    .prepare("SELECT key FROM platform_records ORDER BY key COLLATE BINARY")
                    .map_err(|_| unavailable())?;
                let mut rows = statement.query([]).map_err(|_| unavailable())?;
                while let Some(row) = rows.next().map_err(|_| unavailable())? {
                    // Filtering in SQL could omit malformed physical keys from a complete census.
                    let rusqlite::types::ValueRef::Text(bytes) =
                        row.get_ref(0).map_err(|_| unavailable())?
                    else {
                        return Err(unavailable());
                    };
                    select(std::str::from_utf8(bytes).map_err(|_| unavailable())?)?;
                }
            }
            PlatformStorageArea::SessionSecret => {
                for key in self.session.keys() {
                    select(key)?;
                }
            }
            PlatformStorageArea::DeviceSecret => {
                let mut selected = Ok(());
                self.secrets.visit_keys(&mut |key| {
                    if selected.is_ok() {
                        selected = select(key);
                    }
                })?;
                selected?;
            }
        }
        let mut page = PlatformStorageKeysPage {
            version: 1,
            family: PlatformStorageInventoryFamily::PlatformStorage,
            backing_areas: vec![area],
            keys: Vec::new(),
            continuation: PlatformStorageInventoryContinuation::End {},
        };
        let mut more = false;
        for key in keys {
            if page.keys.len() == PlatformStorageKeysPage::MAX_PAGE_KEYS {
                more = true;
                break;
            }
            let continuation = PlatformStorageInventoryContinuation::More {
                cursor: InventoryCursor::encode(&self.inventory_nonce, area, prefix, &key)?,
            };
            let previous = std::mem::replace(&mut page.continuation, continuation);
            page.keys.push(key);
            // Measure the complete envelope, including the cursor, before consuming this key.
            let bytes = serde_json::to_vec(&PlatformStorageResponse::KeysPage(page.clone()))
                .map_err(|_| unavailable())?;
            if bytes.len() > PlatformStorageKeysPage::MAX_CONTROL_BYTES {
                page.keys.pop();
                page.continuation = previous;
                if page.keys.is_empty() {
                    return Err(inventory_bound());
                }
                more = true;
                break;
            }
        }
        if !more {
            page.continuation = PlatformStorageInventoryContinuation::End {};
        }
        page.validate_for(area, prefix)?;
        Ok(page)
    }
}

fn inventory_bound() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::SizeRejected,
        message: "Native platform inventory exceeds its control bound".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

trait DeviceSecrets: Send + Sync {
    fn visit_keys(&self, visitor: &mut dyn FnMut(&str)) -> Result<(), RuntimeError>;
    fn get(&self, key: &str) -> Result<Option<SecretString>, RuntimeError>;
    fn set(&self, key: &str, value: &str) -> Result<(), RuntimeError>;
    fn delete(&self, key: &str) -> Result<(), RuntimeError>;
    fn compare_delete(
        &self,
        key: &str,
        expected_value: &str,
    ) -> Result<PlatformStorageDeleteResult, RuntimeError>;
    fn delete_prefix(&self, prefix: &str, preserve_key: Option<&str>) -> Result<(), RuntimeError>;
}

struct OsKeychain {
    vault: Arc<crate::keychain::KeychainVault>,
}

impl DeviceSecrets for OsKeychain {
    fn visit_keys(&self, visitor: &mut dyn FnMut(&str)) -> Result<(), RuntimeError> {
        self.vault
            .visit_fresh_keys(visitor)
            .map_err(|_| unavailable())
    }
    fn get(&self, key: &str) -> Result<Option<SecretString>, RuntimeError> {
        self.vault
            .get_value(key)
            .map(|value| value.map(SecretString::from))
            .map_err(|_| unavailable())
    }
    fn set(&self, key: &str, value: &str) -> Result<(), RuntimeError> {
        self.vault.set_value(key, value).map_err(|_| unavailable())
    }
    fn delete(&self, key: &str) -> Result<(), RuntimeError> {
        self.vault
            .delete_value(key)
            .map(|_| ())
            .map_err(|_| unavailable())
    }
    fn compare_delete(
        &self,
        key: &str,
        expected_value: &str,
    ) -> Result<PlatformStorageDeleteResult, RuntimeError> {
        self.vault
            .compare_delete_value(key, expected_value)
            .map_err(|_| unavailable())
    }
    fn delete_prefix(&self, prefix: &str, preserve_key: Option<&str>) -> Result<(), RuntimeError> {
        match preserve_key {
            Some(key) => self.vault.delete_prefix_except(prefix, Some(key)),
            None => self.vault.delete_prefix(prefix),
        }
        .map_err(|_| unavailable())
    }
}

fn unavailable() -> RuntimeError {
    RuntimeError {
        code: RuntimeErrorCode::StorageUnavailable,
        message: "Native platform storage is unavailable".into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

impl NativePlatformStorage {
    pub(super) fn open(path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        Self::with_secrets(
            path,
            Arc::new(OsKeychain {
                vault: crate::keychain::default_vault(),
            }),
        )
    }

    #[cfg(test)]
    pub(super) fn with_test_vault(
        path: impl AsRef<Path>,
        vault: Arc<crate::keychain::KeychainVault>,
    ) -> Result<Self, RuntimeError> {
        Self::with_secrets(path, Arc::new(OsKeychain { vault }))
    }

    fn with_secrets(
        path: impl AsRef<Path>,
        secrets: Arc<dyn DeviceSecrets>,
    ) -> Result<Self, RuntimeError> {
        let mut device = Connection::open(path).map_err(|_| unavailable())?;
        let version: u32 = device
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|_| unavailable())?;
        match version {
            0 => {
                let transaction = device.transaction().map_err(|_| unavailable())?;
                // Version zero previously accepted only an empty file. Check every schema object
                // before CREATE, including views that an ordinary table count would miss.
                validate_native_sqlite_schema(&transaction, "").map_err(|_| unavailable())?;
                transaction
                    .execute_batch(SCHEMA)
                    .map_err(|_| unavailable())?;
                transaction
                    .pragma_update(None, "user_version", 1)
                    .map_err(|_| unavailable())?;
                transaction.commit().map_err(|_| unavailable())?;
            }
            1 => {
                validate_native_sqlite_schema(&device, SCHEMA).map_err(|_| unavailable())?;
            }
            _ => return Err(unavailable()),
        }
        device
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| unavailable())?;
        Ok(Self {
            state: Arc::new(tokio::sync::Mutex::new(StorageState {
                device,
                session: HashMap::new(),
                secrets,
                inventory_nonce: bittery_crypto_core::generate_uuid(),
            })),
            #[cfg(test)]
            worker_barrier: None,
        })
    }
}

#[async_trait]
impl SerializedPlatformStorageExecutor for NativePlatformStorage {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        let request: PlatformStorageRequest =
            serde_json::from_str(&request_json).map_err(|_| RuntimeError {
                code: RuntimeErrorCode::InvariantViolation,
                message: "Invalid native platform storage request".into(),
                recovery_bound: None,
                team_page_problem: None,
            })?;
        let inventory = matches!(&request, PlatformStorageRequest::ListKeys { .. });
        if inventory && request_json.len() > PlatformStorageKeysPage::MAX_CONTROL_BYTES {
            return Err(inventory_bound());
        }
        drop(request_json);
        // Acquire FIFO ownership before issuing blocking work. If the caller drops this future
        // after spawn, the detached worker retains its place and later reads/writes cannot overtake.
        let mut state = self.state.clone().lock_owned().await;
        #[cfg(test)]
        let worker_barrier = self.worker_barrier.clone();
        tokio::task::spawn_blocking(move || {
            #[cfg(test)]
            if let Some(barrier) = worker_barrier {
                barrier.block_next_worker();
            }
            let response = match &request {
                PlatformStorageRequest::ListKeys { area, prefix, cursor } => {
                    PlatformStorageResponse::KeysPage(state.list_keys(*area, prefix, cursor.as_deref())?)
                }
                PlatformStorageRequest::Get { area, key } => {
                    let value = match area {
                        PlatformStorageArea::DevicePlain => state.device.query_row("SELECT value FROM platform_records WHERE key = ?1", [key], |row| row.get::<_, String>(0)).optional().map_err(|_| unavailable())?.map(SecretString::from),
                        PlatformStorageArea::SessionSecret => state.session.get(key).cloned(),
                        PlatformStorageArea::DeviceSecret => state.secrets.get(key)?,
                    };
                    PlatformStorageResponse::Value { value }
                }
                PlatformStorageRequest::Set { area, key, value } => {
                    match area {
                        PlatformStorageArea::DevicePlain => { state.device.execute("INSERT INTO platform_records (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key.as_str(), value.as_ref()]).map_err(|_| unavailable())?; }
                        PlatformStorageArea::SessionSecret => { state.session.insert(key.clone(), value.clone()); }
                        PlatformStorageArea::DeviceSecret => state.secrets.set(key, value)?,
                    }
                    PlatformStorageResponse::Done
                }
                PlatformStorageRequest::Delete { area, key } => {
                    match area {
                        PlatformStorageArea::DevicePlain => { state.device.execute("DELETE FROM platform_records WHERE key = ?1", [key]).map_err(|_| unavailable())?; }
                        PlatformStorageArea::SessionSecret => { state.session.remove(key); }
                        PlatformStorageArea::DeviceSecret => state.secrets.delete(key)?,
                    }
                    PlatformStorageResponse::Done
                }
                PlatformStorageRequest::DeleteIfUnchanged { area, key, expected_value } => {
                    PlatformStorageResponse::DeleteResult {
                        result: state.delete_if_unchanged(*area, key, expected_value)?,
                    }
                }
                PlatformStorageRequest::DeletePrefix { area, prefix, preserve_key } => {
                    match area {
                        // BLOB comparison gives exact Rust starts_with semantics, including
                        // wildcard characters, Unicode and embedded NULs in opaque keys.
                        PlatformStorageArea::DevicePlain => { state.device.execute("DELETE FROM platform_records WHERE substr(CAST(key AS BLOB), 1, length(CAST(?1 AS BLOB))) = CAST(?1 AS BLOB) AND (?2 IS NULL OR CAST(key AS BLOB) != CAST(?2 AS BLOB))", rusqlite::params![prefix, preserve_key]).map_err(|_| unavailable())?; }
                        PlatformStorageArea::SessionSecret => { state.session.retain(|key, _| !key.starts_with(prefix) || Some(key.as_str()) == preserve_key.as_deref()); }
                        PlatformStorageArea::DeviceSecret => state.secrets.delete_prefix(prefix, preserve_key.as_deref())?,
                    }
                    PlatformStorageResponse::Done
                }
            };
            let mut bytes = Zeroizing::new(Vec::new());
            serde_json::to_writer(&mut *bytes, &response).map_err(|_| unavailable())?;
            if inventory && bytes.len() > PlatformStorageKeysPage::MAX_CONTROL_BYTES {
                return Err(inventory_bound());
            }
            String::from_utf8(std::mem::take(&mut *bytes))
                .map(Zeroizing::new)
                .map_err(|error| {
                    drop(Zeroizing::new(error.into_bytes()));
                    unavailable()
                })
        }).await.map_err(|_| unavailable())?
    }
}

/// A failed physical open still supplies an executor to the same recovery-capable Core.
/// It preserves the original error and never creates a replacement database.
pub(super) struct OpenedStorage<T>(pub(super) Result<T, RuntimeError>);

#[async_trait]
impl bittery_client_core::SerializedReplicaExecutor
    for OpenedStorage<bittery_client_core::SqliteReplica>
{
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        self.0
            .as_ref()
            .map_err(Clone::clone)?
            .invoke(request_json)
            .await
    }
}
#[async_trait]
impl SerializedPlatformStorageExecutor for OpenedStorage<NativePlatformStorage> {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, RuntimeError> {
        self.0
            .as_ref()
            .map_err(Clone::clone)?
            .invoke(request_json)
            .await
    }
}

#[cfg(test)]
#[path = "storage_inventory_tests.rs"]
mod inventory_tests;

#[cfg(test)]
#[path = "storage_keychain_tests.rs"]
mod keychain_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct TestSecrets {
        values: Mutex<HashMap<String, SecretString>>,
        unavailable: AtomicBool,
    }

    impl TestSecrets {
        fn values(
            &self,
        ) -> Result<std::sync::MutexGuard<'_, HashMap<String, SecretString>>, RuntimeError>
        {
            if self.unavailable.load(Ordering::SeqCst) {
                return Err(unavailable());
            }
            self.values.lock().map_err(|_| unavailable())
        }
    }

    impl DeviceSecrets for TestSecrets {
        fn visit_keys(&self, visitor: &mut dyn FnMut(&str)) -> Result<(), RuntimeError> {
            for key in self.values()?.keys() {
                visitor(key);
            }
            Ok(())
        }
        fn get(&self, key: &str) -> Result<Option<SecretString>, RuntimeError> {
            Ok(self.values()?.get(key).cloned())
        }
        fn set(&self, key: &str, value: &str) -> Result<(), RuntimeError> {
            self.values()?.insert(key.into(), value.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), RuntimeError> {
            self.values()?.remove(key);
            Ok(())
        }
        fn compare_delete(
            &self,
            key: &str,
            expected_value: &str,
        ) -> Result<PlatformStorageDeleteResult, RuntimeError> {
            let mut values = self.values()?;
            Ok(match values.get(key) {
                None => PlatformStorageDeleteResult::AlreadyAbsent,
                Some(actual) if actual.as_ref().as_bytes() == expected_value.as_bytes() => {
                    values.remove(key);
                    PlatformStorageDeleteResult::Deleted
                }
                Some(_) => PlatformStorageDeleteResult::Conflict,
            })
        }
        fn delete_prefix(
            &self,
            prefix: &str,
            preserve_key: Option<&str>,
        ) -> Result<(), RuntimeError> {
            self.values()?
                .retain(|key, _| !key.starts_with(prefix) || Some(key.as_str()) == preserve_key);
            Ok(())
        }
    }

    async fn invoke(storage: &NativePlatformStorage, request: Value) -> Value {
        let response = storage
            .invoke(Zeroizing::new(request.to_string()))
            .await
            .unwrap();
        serde_json::from_str(&response).unwrap()
    }

    fn database_bytes(path: &Path) -> (Vec<u8>, Option<Vec<u8>>) {
        let mut wal_path = path.as_os_str().to_os_string();
        wal_path.push("-wal");
        let wal = match std::fs::read(std::path::PathBuf::from(wal_path)) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => panic!("could not capture the platform database WAL: {error}"),
        };
        (std::fs::read(path).unwrap(), wal)
    }

    #[tokio::test]
    async fn prefix_deletion_preserves_exact_key_inside_sql_and_session_operations() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("preserved-platform.sqlite");
        let storage = NativePlatformStorage::open(&path).unwrap();
        let prefix = "owned:%_\0:ä:";
        let marker = format!("{prefix}catalog");
        let staged = format!("{prefix}staged");
        let similar = format!("{marker}:extra");
        for area in ["devicePlain", "sessionSecret"] {
            for key in [&marker, &staged, &similar, &"unrelated".to_owned()] {
                invoke(
                    &storage,
                    json!({"type":"set","area":area,"key":key,"value":"retained"}),
                )
                .await;
            }
            invoke(
                &storage,
                json!({"type":"deletePrefix","area":area,"prefix":prefix,"preserveKey":marker}),
            )
            .await;
            for key in [&marker, &"unrelated".to_owned()] {
                assert_eq!(
                    invoke(&storage, json!({"type":"get","area":area,"key":key})).await,
                    json!({"type":"value","value":"retained"})
                );
            }
            for key in [&staged, &similar] {
                assert_eq!(
                    invoke(&storage, json!({"type":"get","area":area,"key":key})).await,
                    json!({"type":"value","value":null})
                );
            }
            // Exact exclusion survives an idempotent replay without changing its value.
            invoke(
                &storage,
                json!({"type":"deletePrefix","area":area,"prefix":prefix,"preserveKey":marker}),
            )
            .await;
        }
        drop(storage);
        let reopened = NativePlatformStorage::open(&path).unwrap();
        assert_eq!(
            invoke(
                &reopened,
                json!({"type":"get","area":"devicePlain","key":marker})
            )
            .await,
            json!({"type":"value","value":"retained"})
        );
    }

    #[tokio::test]
    async fn guarded_deletion_compares_exact_values_in_every_native_area() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("guarded-platform.sqlite");
        let secrets = Arc::new(TestSecrets::default());
        let storage = NativePlatformStorage::with_secrets(&path, secrets).unwrap();
        let expected = "exact\0é value";
        for area in ["devicePlain", "sessionSecret", "deviceSecret"] {
            let key = format!("guarded:{area}");
            let unrelated = format!("{key}:near");
            for (candidate, value) in [(&key, expected), (&unrelated, "unrelated")] {
                assert_eq!(
                    invoke(
                        &storage,
                        json!({"type":"set","area":area,"key":candidate,"value":value}),
                    )
                    .await,
                    json!({"type":"done"})
                );
            }

            assert_eq!(
                invoke(
                    &storage,
                    json!({
                        "type":"deleteIfUnchanged", "area":area, "key":key,
                        "expectedValue":"different"
                    }),
                )
                .await,
                json!({"type":"deleteResult","result":"conflict"})
            );
            assert_eq!(
                invoke(&storage, json!({"type":"get","area":area,"key":key}),).await,
                json!({"type":"value","value":expected})
            );
            assert_eq!(
                invoke(
                    &storage,
                    json!({
                        "type":"deleteIfUnchanged", "area":area, "key":key,
                        "expectedValue":expected
                    }),
                )
                .await,
                json!({"type":"deleteResult","result":"deleted"})
            );
            assert_eq!(
                invoke(
                    &storage,
                    json!({
                        "type":"deleteIfUnchanged", "area":area, "key":key,
                        "expectedValue":expected
                    }),
                )
                .await,
                json!({"type":"deleteResult","result":"alreadyAbsent"})
            );
            assert_eq!(
                invoke(&storage, json!({"type":"get","area":area,"key":unrelated}),).await,
                json!({"type":"value","value":"unrelated"})
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dropped_issued_delete_cannot_be_overtaken_by_later_storage_work() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ordered-platform.sqlite");
        let mut storage =
            NativePlatformStorage::with_secrets(&path, Arc::new(TestSecrets::default())).unwrap();
        assert_eq!(
            invoke(
                &storage,
                json!({
                    "type":"set", "area":"sessionSecret", "key":"ordered",
                    "value":"original"
                }),
            )
            .await,
            json!({"type":"done"})
        );
        let barrier = TestWorkerBarrier::new();
        storage.worker_barrier = Some(barrier.clone());
        let storage = Arc::new(storage);

        let issued_storage = storage.clone();
        let issued = tokio::spawn(async move {
            invoke(
                &issued_storage,
                json!({
                    "type":"deleteIfUnchanged", "area":"sessionSecret", "key":"ordered",
                    "expectedValue":"original"
                }),
            )
            .await
        });
        let entered = barrier.clone();
        tokio::task::spawn_blocking(move || entered.wait_until_entered())
            .await
            .unwrap();
        issued.abort();
        assert!(issued.await.unwrap_err().is_cancelled());

        let later_storage = storage.clone();
        let mut later = tokio::spawn(async move {
            invoke(
                &later_storage,
                json!({
                    "type":"set", "area":"sessionSecret", "key":"ordered",
                    "value":"original"
                }),
            )
            .await
        });
        let overtook = tokio::time::timeout(std::time::Duration::from_millis(100), &mut later)
            .await
            .is_ok();
        barrier.release();
        assert!(
            !overtook,
            "later storage work overtook a detached issued delete"
        );
        assert_eq!(later.await.unwrap(), json!({"type":"done"}));
        assert_eq!(
            invoke(
                &storage,
                json!({"type":"get", "area":"sessionSecret", "key":"ordered"}),
            )
            .await,
            json!({"type":"value","value":"original"})
        );
    }

    #[test]
    fn open_refuses_unversioned_foreign_schema_without_writes() {
        for (shape, sql) in [
            (
                "table",
                "CREATE TABLE sqliteXforeign (payload BLOB NOT NULL); INSERT INTO sqliteXforeign VALUES (X'00ff1234');",
            ),
            (
                "view",
                "CREATE VIEW sqliteXforeign AS SELECT 'opaque-retained-evidence' AS payload;",
            ),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("foreign-platform.sqlite");
            {
                let raw = Connection::open(&path).unwrap();
                raw.execute_batch(sql).unwrap();
            }
            let before = database_bytes(&path);

            // Constructing the ordinary owner does not read or write OS credentials.
            let result = NativePlatformStorage::open(&path).map(drop);

            assert!(
                database_bytes(&path) == before,
                "native open must preserve the foreign {shape}, database stamps, and optional WAL"
            );
            let error = result.expect_err("an unknown schema cannot be an empty platform store");
            assert_eq!(error.code, RuntimeErrorCode::StorageUnavailable, "{shape}");
        }
    }

    #[test]
    fn open_preserves_unsupported_known_layout_and_extra_schema_objects() {
        for (case, version, extra_schema) in [
            ("known-unversioned", 0, ""),
            (
                "current-with-view",
                1,
                "CREATE VIEW foreign_view AS SELECT key, value FROM platform_records;",
            ),
            (
                "current-with-trigger",
                1,
                "CREATE TRIGGER foreign_trigger AFTER INSERT ON platform_records BEGIN UPDATE platform_records SET value = 'foreign-trigger-effect' WHERE key = NEW.key; END;",
            ),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("unsupported-platform.sqlite");
            drop(NativePlatformStorage::open(&path).unwrap());
            {
                let raw = Connection::open(&path).unwrap();
                raw.execute(
                    "INSERT INTO platform_records (key, value) VALUES (?1, ?2)",
                    ["retained-key", "opaque-retained-value"],
                )
                .unwrap();
                raw.pragma_update(None, "user_version", version).unwrap();
                raw.execute_batch(extra_schema).unwrap();
            }
            let before = database_bytes(&path);

            let result = NativePlatformStorage::open(&path).map(drop);

            assert!(
                database_bytes(&path) == before,
                "native open must preserve {case} database records, schema, stamps, and optional WAL"
            );
            let error = result.expect_err("an unsupported physical layout must be refused");
            assert_eq!(error.code, RuntimeErrorCode::StorageUnavailable, "{case}");
        }
    }

    #[tokio::test]
    async fn list_keys_is_literal_ordered_and_read_only_for_plain_and_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("inventory-platform.sqlite");
        let storage = NativePlatformStorage::open(&path).unwrap();
        let prefix = "bittery:runtime:platform-storage:%_\0:";
        let first = format!("{prefix}\u{e000}");
        let second = format!("{prefix}\u{10000}");
        let near = "bittery:runtime:platform-storage:XY\0:near";

        for area in ["devicePlain", "sessionSecret"] {
            let value = format!("opaque-{area}-retained-value");
            // Insert in the opposite order. UTF-8 orders E000 before 10000; UTF-16 does not.
            for key in [second.as_str(), near, first.as_str()] {
                assert_eq!(
                    invoke(
                        &storage,
                        json!({
                            "type": "set", "area": area, "key": key, "value": value
                        })
                    )
                    .await,
                    json!({"type": "done"})
                );
            }
            let before = database_bytes(&path);

            let response = invoke(
                &storage,
                json!({
                    "type": "listKeys", "area": area, "prefix": prefix, "cursor": null
                }),
            )
            .await;

            assert_eq!(
                response,
                json!({
                    "type": "keysPage", "version": 1, "family": "platformStorage",
                    "backingAreas": [area], "keys": [first, second],
                    "continuation": {"type": "end"}
                })
            );
            for key in [second.as_str(), near, first.as_str()] {
                assert_eq!(
                    invoke(&storage, json!({"type": "get", "area": area, "key": key})).await,
                    json!({"type": "value", "value": value})
                );
            }
            assert!(
                database_bytes(&path) == before,
                "{area} enumeration must preserve the entire database and optional WAL"
            );
        }
    }

    #[tokio::test]
    async fn list_keys_pages_preserve_all_keys_and_bind_cursor_to_owner_and_selector() {
        async fn page(
            storage: &NativePlatformStorage,
            prefix: &str,
            cursor: Option<&str>,
        ) -> Value {
            let response = storage.invoke(Zeroizing::new(json!({
                "type": "listKeys", "area": "devicePlain", "prefix": prefix, "cursor": cursor
            }).to_string())).await.unwrap();
            assert!(
                response.len() <= 262_144,
                "the complete serialized page is bounded"
            );
            let response: Value = serde_json::from_str(&response).unwrap();
            assert!(response["keys"].as_array().unwrap().len() <= 128);
            response
        }

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("paged-platform.sqlite");
        let storage = NativePlatformStorage::open(&path).unwrap();
        let prefix = "bittery:runtime:platform-storage:paged:%_\0:";
        let expected: Vec<String> = (0..129)
            .map(|index| format!("{prefix}{index:03}"))
            .collect();
        for key in expected.iter().rev() {
            assert_eq!(
                invoke(
                    &storage,
                    json!({
                        "type": "set", "area": "devicePlain", "key": key,
                        "value": "opaque-paged-retained-value"
                    })
                )
                .await,
                json!({"type": "done"})
            );
        }
        let before = database_bytes(&path);
        let mut collected = Vec::<String>::new();
        let mut cursor: Option<String> = None;
        let mut first_cursor = None;
        let mut checked_live_binding = false;
        let mut reached_end = false;

        for _ in 0..=expected.len() {
            let response = page(&storage, prefix, cursor.as_deref()).await;
            let keys: Vec<String> = response["keys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|key| key.as_str().unwrap().to_owned())
                .collect();
            assert!(collected.len() + keys.len() <= expected.len());
            assert_eq!(
                keys,
                expected[collected.len()..collected.len() + keys.len()]
            );

            if let Some(live_cursor) = cursor.as_deref().filter(|_| !checked_live_binding) {
                assert_eq!(
                    page(&storage, prefix, Some(live_cursor)).await,
                    response,
                    "repeating a live cursor must return the same page"
                );
                for (area, wrong_prefix) in [
                    ("sessionSecret", prefix),
                    (
                        "devicePlain",
                        "bittery:runtime:platform-storage:another-prefix:",
                    ),
                ] {
                    assert!(
                        storage
                            .invoke(Zeroizing::new(
                                json!({
                                    "type": "listKeys", "area": area, "prefix": wrong_prefix,
                                    "cursor": live_cursor
                                })
                                .to_string()
                            ))
                            .await
                            .is_err(),
                        "a cursor cannot change its area or prefix"
                    );
                }
                checked_live_binding = true;
            }

            let continuation = match response["continuation"]["type"].as_str().unwrap() {
                "more" => {
                    assert!(!keys.is_empty());
                    let next = response["continuation"]["cursor"].as_str().unwrap();
                    assert!(!next.is_empty());
                    assert_ne!(cursor.as_deref(), Some(next));
                    first_cursor.get_or_insert_with(|| next.to_owned());
                    cursor = Some(next.to_owned());
                    json!({"type": "more", "cursor": next})
                }
                "end" => {
                    reached_end = true;
                    json!({"type": "end"})
                }
                _ => panic!("unexpected inventory continuation"),
            };
            assert_eq!(
                response,
                json!({
                    "type": "keysPage", "version": 1, "family": "platformStorage",
                    "backingAreas": ["devicePlain"], "keys": keys, "continuation": continuation
                })
            );
            collected.extend(keys);
            if reached_end {
                break;
            }
        }
        assert!(reached_end && checked_live_binding);
        assert_eq!(collected, expected);
        assert!(
            database_bytes(&path) == before,
            "pagination must not change DB or WAL bytes"
        );

        drop(storage);
        let reopened = NativePlatformStorage::open(&path).unwrap();
        let before_reopened = database_bytes(&path);
        assert!(
            reopened
                .invoke(Zeroizing::new(
                    json!({
                        "type": "listKeys", "area": "devicePlain", "prefix": prefix,
                        "cursor": first_cursor.expect("129 keys require continuation")
                    })
                    .to_string()
                ))
                .await
                .is_err(),
            "a cursor cannot survive native owner loss"
        );
        assert!(
            database_bytes(&path) == before_reopened,
            "refusing an old owner cursor must not change DB or WAL bytes"
        );
    }

    #[tokio::test]
    async fn durable_records_reopen_while_session_secrets_do_not() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("platform.sqlite");
        let storage = NativePlatformStorage::open(&path).unwrap();
        for area in ["devicePlain", "sessionSecret"] {
            assert_eq!(
                invoke(
                    &storage,
                    json!({"type":"set", "area":area, "key":"account", "value":"retained"})
                )
                .await,
                json!({"type":"done"})
            );
            assert_eq!(
                invoke(
                    &storage,
                    json!({"type":"get", "area":area, "key":"account"})
                )
                .await,
                json!({"type":"value", "value":"retained"})
            );
        }
        drop(storage);
        let reopened = NativePlatformStorage::open(&path).unwrap();
        assert_eq!(
            invoke(
                &reopened,
                json!({"type":"get", "area":"devicePlain", "key":"account"})
            )
            .await,
            json!({"type":"value", "value":"retained"})
        );
        assert_eq!(
            invoke(
                &reopened,
                json!({"type":"get", "area":"sessionSecret", "key":"account"})
            )
            .await,
            json!({"type":"value", "value":null})
        );
    }

    #[tokio::test]
    async fn prefix_deletion_is_literal_isolated_and_durable() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("platform.sqlite");
        let storage = NativePlatformStorage::open(&path).unwrap();
        for area in ["devicePlain", "sessionSecret"] {
            for key in [
                "account:%_é:first",
                "account:%_é:second",
                "account:other",
                "unrelated",
            ] {
                invoke(
                    &storage,
                    json!({"type":"set", "area":area, "key":key, "value":"retained"}),
                )
                .await;
            }
            invoke(
                &storage,
                json!({"type":"deletePrefix", "area":area, "prefix":"account:%_é:"}),
            )
            .await;
            for key in ["account:%_é:first", "account:%_é:second"] {
                assert_eq!(
                    invoke(&storage, json!({"type":"get", "area":area, "key":key})).await,
                    json!({"type":"value", "value":null})
                );
            }
            assert_eq!(
                invoke(
                    &storage,
                    json!({"type":"get", "area":area, "key":"account:other"})
                )
                .await,
                json!({"type":"value", "value":"retained"})
            );
            for _ in 0..2 {
                invoke(
                    &storage,
                    json!({"type":"delete", "area":area, "key":"unrelated"}),
                )
                .await;
            }
        }
        drop(storage);
        let reopened = NativePlatformStorage::open(&path).unwrap();
        assert_eq!(
            invoke(
                &reopened,
                json!({"type":"get", "area":"devicePlain", "key":"account:%_é:first"})
            )
            .await,
            json!({"type":"value", "value":null})
        );
        assert_eq!(
            invoke(
                &reopened,
                json!({"type":"get", "area":"devicePlain", "key":"account:other"})
            )
            .await,
            json!({"type":"value", "value":"retained"})
        );
    }

    #[tokio::test]
    async fn device_secrets_use_only_the_keychain_and_failures_are_not_absence() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("platform.sqlite");
        let secrets = Arc::new(TestSecrets::default());
        let storage = NativePlatformStorage::with_secrets(&path, secrets.clone()).unwrap();
        for key in ["account:first", "account:second", "other"] {
            invoke(&storage, json!({"type":"set", "area":"deviceSecret", "key":key, "value":"keychain-only-secret"})).await;
        }
        assert_eq!(
            invoke(
                &storage,
                json!({"type":"get", "area":"devicePlain", "key":"account:first"})
            )
            .await,
            json!({"type":"value", "value":null})
        );
        drop(storage);
        let reopened = NativePlatformStorage::with_secrets(&path, secrets.clone()).unwrap();
        assert_eq!(
            invoke(
                &reopened,
                json!({"type":"get", "area":"deviceSecret", "key":"account:first"})
            )
            .await,
            json!({"type":"value", "value":"keychain-only-secret"})
        );
        secrets.unavailable.store(true, Ordering::SeqCst);
        for request in [
            json!({"type":"get", "area":"deviceSecret", "key":"missing"}),
            json!({"type":"set", "area":"deviceSecret", "key":"other", "value":"replacement"}),
            json!({"type":"delete", "area":"deviceSecret", "key":"other"}),
            json!({"type":"deletePrefix", "area":"deviceSecret", "prefix":"account:"}),
        ] {
            assert_eq!(
                reopened
                    .invoke(Zeroizing::new(request.to_string()))
                    .await
                    .unwrap_err()
                    .code,
                RuntimeErrorCode::StorageUnavailable
            );
        }
        secrets.unavailable.store(false, Ordering::SeqCst);
        invoke(
            &reopened,
            json!({"type":"deletePrefix", "area":"deviceSecret", "prefix":"account:"}),
        )
        .await;
        assert_eq!(
            invoke(
                &reopened,
                json!({"type":"get", "area":"deviceSecret", "key":"account:first"})
            )
            .await,
            json!({"type":"value", "value":null})
        );
        assert_eq!(
            invoke(
                &reopened,
                json!({"type":"get", "area":"deviceSecret", "key":"other"})
            )
            .await,
            json!({"type":"value", "value":"keychain-only-secret"})
        );
        invoke(
            &reopened,
            json!({"type":"delete", "area":"deviceSecret", "key":"other"}),
        )
        .await;
        assert_eq!(
            invoke(
                &reopened,
                json!({"type":"get", "area":"deviceSecret", "key":"other"})
            )
            .await,
            json!({"type":"value", "value":null})
        );
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes
            .windows(b"keychain-only-secret".len())
            .any(|window| window == b"keychain-only-secret"));
    }

    #[test]
    fn corrupt_and_future_storage_are_reported_without_reset() {
        let directory = tempfile::tempdir().unwrap();
        let corrupt = directory.path().join("corrupt.sqlite");
        std::fs::write(&corrupt, b"preserve-corrupt-evidence").unwrap();
        assert!(matches!(
            NativePlatformStorage::open(&corrupt),
            Err(RuntimeError {
                code: RuntimeErrorCode::StorageUnavailable,
                ..
            })
        ));
        assert_eq!(
            std::fs::read(&corrupt).unwrap(),
            b"preserve-corrupt-evidence"
        );
        let future = directory.path().join("future.sqlite");
        let connection = Connection::open(&future).unwrap();
        connection
            .execute_batch("PRAGMA user_version = 2;")
            .unwrap();
        drop(connection);
        let original = std::fs::read(&future).unwrap();
        assert!(matches!(
            NativePlatformStorage::open(&future),
            Err(RuntimeError {
                code: RuntimeErrorCode::StorageUnavailable,
                ..
            })
        ));
        assert_eq!(std::fs::read(&future).unwrap(), original);
        assert!(NativePlatformStorage::open(
            directory.path().join("missing-parent/platform.sqlite")
        )
        .is_err());
    }
}
