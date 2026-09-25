use super::{
    inventory,
    persistence_contract::{
        apply_prepared_writes_to_rows, reconstruct_snapshot, ExpectedReplicaInstall,
        LockEpochAdvanceResult, PreparedReplicaWrite, ReplicaHead, ReplicaInstallResult,
        ReplicaPersistenceResponse, ReplicaRowKey, ReplicaStore, StoredReplicaRow,
    },
    ReplicaInventoryPage, ReplicaPersistence, ReplicaPersistenceRequest, ReplicaPhysicalKey,
    SerializedReplicaExecutor,
};
use crate::{AccountId, RuntimeError, RuntimeErrorCode};
use async_trait::async_trait;
use rusqlite::{
    params, types::ValueRef, Connection, OptionalExtension, Row, Transaction, TransactionBehavior,
};
use std::{path::Path, sync::Mutex};

// Physical engine versions are independent of Rust's logical Replica/contract versions.
pub(crate) const APPLICATION_ID: i32 = 0x4254_5259; // BTRY
pub(crate) const PHYSICAL_VERSION: i32 = 1;
pub(crate) const MIGRATION_1: &[&str] = &[
    r#"
CREATE TABLE IF NOT EXISTS replica_heads (
    account_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    incarnation TEXT NOT NULL,
    replica_revision TEXT NOT NULL,
    lock_epoch TEXT NOT NULL,
    failure_json TEXT
);"#,
    r#"
CREATE TABLE IF NOT EXISTS replica_rows (
    account_id TEXT NOT NULL,
    store INTEGER NOT NULL,
    record_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (account_id, store, record_id),
    FOREIGN KEY (account_id) REFERENCES replica_heads(account_id) ON DELETE CASCADE
);"#,
];

fn migrate(connection: &mut Connection, fail_after: Option<usize>) -> Result<(), RuntimeError> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let identity: i32 = transaction
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(sqlite_error)?;
    let version: i32 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(sqlite_error)?;
    if identity != 0 && identity != APPLICATION_ID {
        return Err(storage_error(
            "This database belongs to another application",
        ));
    }
    if !(0..=PHYSICAL_VERSION).contains(&version) || (identity == 0 && version != 0) {
        return Err(storage_error(
            "This Replica requires a different application version",
        ));
    }
    if version == 0 {
        // A view-only file is not empty. Validate all objects before creating tables or stamps,
        // while preserving this owner's supported application-id/version-zero combinations.
        crate::sqlite_schema::admit_empty_or_known(&transaction, &MIGRATION_1.join("\n"), &[])
            .map_err(|_| storage_error("This database is not a supported Replica"))?;
    }
    let mut boundary = 0;
    for next_version in (version + 1)..=PHYSICAL_VERSION {
        let statements = match next_version {
            1 => MIGRATION_1,
            _ => return Err(storage_error("Replica migration is unavailable")),
        };
        for statement in statements {
            transaction.execute_batch(statement).map_err(sqlite_error)?;
            migration_boundary(&mut boundary, fail_after)?;
        }
        transaction
            .pragma_update(None, "application_id", APPLICATION_ID)
            .map_err(sqlite_error)?;
        migration_boundary(&mut boundary, fail_after)?;
        transaction
            .pragma_update(None, "user_version", next_version)
            .map_err(sqlite_error)?;
        migration_boundary(&mut boundary, fail_after)?;
    }
    validate_schema(&transaction)?;
    transaction.commit().map_err(sqlite_error)
}

fn migration_boundary(boundary: &mut usize, fail_after: Option<usize>) -> Result<(), RuntimeError> {
    *boundary += 1;
    if fail_after == Some(*boundary) {
        return Err(storage_error("Replica schema upgrade failed"));
    }
    Ok(())
}

fn validate_schema(transaction: &Transaction<'_>) -> Result<(), RuntimeError> {
    for (table, expected) in [
        (
            "replica_heads",
            vec![
                ("account_id", "TEXT", 1, 1),
                ("user_id", "TEXT", 1, 0),
                ("incarnation", "TEXT", 1, 0),
                ("replica_revision", "TEXT", 1, 0),
                ("lock_epoch", "TEXT", 1, 0),
                ("failure_json", "TEXT", 0, 0),
            ],
        ),
        (
            "replica_rows",
            vec![
                ("account_id", "TEXT", 1, 1),
                ("store", "INTEGER", 1, 2),
                ("record_id", "TEXT", 1, 3),
                ("payload_json", "TEXT", 1, 0),
            ],
        ),
    ] {
        let columns: Vec<(String, String, i32, i32)> = transaction
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(sqlite_error)?
            .query_map([], |row| {
                Ok((row.get(1)?, row.get(2)?, row.get(3)?, row.get(5)?))
            })
            .map_err(sqlite_error)?
            .collect::<Result<_, _>>()
            .map_err(sqlite_error)?;
        let expected: Vec<_> = expected
            .into_iter()
            .map(|(name, kind, required, key)| (name.to_owned(), kind.to_owned(), required, key))
            .collect();
        if columns != expected {
            return Err(storage_error("Replica schema is not supported"));
        }
    }
    let foreign_keys: Vec<(String, String, String, String)> = transaction
        .prepare("PRAGMA foreign_key_list(replica_rows)")
        .map_err(sqlite_error)?
        .query_map([], |row| {
            Ok((row.get(2)?, row.get(3)?, row.get(4)?, row.get(6)?))
        })
        .map_err(sqlite_error)?
        .collect::<Result<_, _>>()
        .map_err(sqlite_error)?;
    if foreign_keys
        != [(
            "replica_heads".into(),
            "account_id".into(),
            "account_id".into(),
            "CASCADE".into(),
        )]
    {
        return Err(storage_error("Replica Account scope is not supported"));
    }
    Ok(())
}

/// Native durable implementation of the Rust-owned Replica persistence contract.
///
/// Hosts choose the database location. Schema and table identity remain private to the adapter.
pub struct SqliteReplica {
    connection: Mutex<Connection>,
    inventory_nonce: String,
    #[cfg(test)]
    fail_after_write: Option<usize>,
}

impl SqliteReplica {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        Self::open_with_failure(path, None)
    }

    fn open_with_failure(
        path: impl AsRef<Path>,
        fail_after_write: Option<usize>,
    ) -> Result<Self, RuntimeError> {
        let mut connection = Connection::open(path).map_err(sqlite_error)?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(sqlite_error)?;
        migrate(&mut connection, None)?;
        #[cfg(not(test))]
        let _ = fail_after_write;
        Ok(Self {
            connection: Mutex::new(connection),
            inventory_nonce: bittery_crypto_core::generate_uuid(),
            #[cfg(test)]
            fail_after_write,
        })
    }

    #[cfg(test)]
    pub(super) fn open_failing_after(
        path: impl AsRef<Path>,
        write_count: usize,
    ) -> Result<Self, RuntimeError> {
        Self::open_with_failure(path, Some(write_count))
    }

    #[cfg(test)]
    pub(super) fn open_failing_migration_after(
        path: impl AsRef<Path>,
        write_count: usize,
    ) -> Result<Self, RuntimeError> {
        let mut connection = Connection::open(&path).map_err(sqlite_error)?;
        migrate(&mut connection, Some(write_count))?;
        drop(connection);
        Self::open(path)
    }

    fn invoke_sync(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| replica_error("SQLite Replica connection lock poisoned"))?;
        let transaction = connection.transaction().map_err(sqlite_error)?;
        let response = match request {
            ReplicaPersistenceRequest::Inventory { cursor } => {
                ReplicaPersistenceResponse::InventoryPage(inventory_page(
                    &transaction,
                    &self.inventory_nonce,
                    cursor.as_deref(),
                )?)
            }
            ReplicaPersistenceRequest::Load { account_id } => {
                let (head, rows) = load_account(&transaction, &account_id)?;
                ReplicaPersistenceResponse::Loaded { head, rows }
            }
            ReplicaPersistenceRequest::Install { prepared } => {
                let account_id = prepared.next_head.account_id.clone();
                let (current, rows) = load_account(&transaction, &account_id)?;
                let matches = match (&prepared.expected, current.as_ref()) {
                    (ExpectedReplicaInstall::Missing { account_id }, None) => {
                        account_id == &prepared.next_head.account_id
                    }
                    (
                        ExpectedReplicaInstall::Present {
                            account_id,
                            user_id,
                            incarnation,
                            replica_revision,
                            lock_epoch,
                        },
                        Some(current),
                    ) => {
                        account_id == &current.account_id
                            && user_id == &current.user_id
                            && incarnation == &current.incarnation
                            && *replica_revision == current.replica_revision
                            && *lock_epoch == current.lock_epoch
                    }
                    _ => false,
                };
                if !matches {
                    ReplicaPersistenceResponse::Installed {
                        result: ReplicaInstallResult::Stale,
                    }
                } else {
                    validate_write_scope(&account_id, &prepared.writes)?;
                    let next_rows = apply_prepared_writes_to_rows(rows, &prepared.writes);
                    reconstruct_snapshot(&account_id, Some(prepared.next_head.clone()), next_rows)?
                        .ok_or_else(|| replica_error("prepared Replica install lost its head"))?;
                    let mut boundary = 0;
                    put_head(&transaction, &prepared.next_head)?;
                    self.after_write(&mut boundary)?;
                    for write in &prepared.writes {
                        apply_write(&transaction, write)?;
                        self.after_write(&mut boundary)?;
                    }
                    ReplicaPersistenceResponse::Installed {
                        result: ReplicaInstallResult::Applied,
                    }
                }
            }
            ReplicaPersistenceRequest::Commit { prepared } => {
                let (current, rows) = load_account(&transaction, &prepared.expected.account_id)?;
                let Some(current) = current else {
                    transaction.commit().map_err(sqlite_error)?;
                    return Ok(ReplicaPersistenceResponse::Committed {
                        result: super::PlanResult::Missing,
                    });
                };
                if current.user_id != prepared.expected.user_id
                    || current.incarnation != prepared.expected.incarnation
                    || current.replica_revision != prepared.expected.replica_revision
                    || current.lock_epoch != prepared.expected.lock_epoch
                {
                    transaction.commit().map_err(sqlite_error)?;
                    return Ok(ReplicaPersistenceResponse::Committed {
                        result: super::PlanResult::Stale {
                            actual_revision: current.replica_revision,
                        },
                    });
                }
                validate_commit_transition(&current, &prepared.next_head)?;
                validate_write_scope(&prepared.expected.account_id, &prepared.writes)?;
                let next_rows = apply_prepared_writes_to_rows(rows, &prepared.writes);
                reconstruct_snapshot(
                    &prepared.expected.account_id,
                    Some(prepared.next_head.clone()),
                    next_rows,
                )?
                .ok_or_else(|| replica_error("prepared Replica commit lost its head"))?;
                let replica_revision = prepared.next_head.replica_revision;
                let mut boundary = 0;
                put_head(&transaction, &prepared.next_head)?;
                self.after_write(&mut boundary)?;
                for write in &prepared.writes {
                    apply_write(&transaction, write)?;
                    self.after_write(&mut boundary)?;
                }
                ReplicaPersistenceResponse::Committed {
                    result: super::PlanResult::Applied { replica_revision },
                }
            }
            ReplicaPersistenceRequest::AdvanceLockEpoch { prepared } => {
                let (current, _) = load_account(&transaction, &prepared.expected.account_id)?;
                let Some(current) = current else {
                    transaction.commit().map_err(sqlite_error)?;
                    return Ok(ReplicaPersistenceResponse::LockEpochAdvanced {
                        result: LockEpochAdvanceResult::Missing,
                    });
                };
                if current.user_id != prepared.expected.user_id
                    || current.incarnation != prepared.expected.incarnation
                    || current.replica_revision != prepared.expected.replica_revision
                    || current.lock_epoch != prepared.expected.lock_epoch
                {
                    transaction.commit().map_err(sqlite_error)?;
                    return Ok(ReplicaPersistenceResponse::LockEpochAdvanced {
                        result: LockEpochAdvanceResult::Stale,
                    });
                }
                let expected_epoch = current
                    .lock_epoch
                    .checked_add(1)
                    .ok_or_else(|| replica_error("Account lock epoch overflowed"))?;
                if prepared.next_head.account_id != current.account_id
                    || prepared.next_head.user_id != current.user_id
                    || prepared.next_head.incarnation != current.incarnation
                    || prepared.next_head.replica_revision != current.replica_revision
                    || prepared.next_head.lock_epoch != expected_epoch
                    || prepared.next_head.failure != current.failure
                {
                    return Err(replica_error(
                        "prepared Account lock epoch transition is invalid",
                    ));
                }
                let mut boundary = 0;
                put_head(&transaction, &prepared.next_head)?;
                self.after_write(&mut boundary)?;
                ReplicaPersistenceResponse::LockEpochAdvanced {
                    result: LockEpochAdvanceResult::Applied {
                        lock_epoch: expected_epoch,
                    },
                }
            }
            ReplicaPersistenceRequest::DeleteAccountIfUnchanged {
                account_id,
                expected_head,
                expected_rows,
            } => {
                use super::persistence_contract::{
                    admission_deletion_matches, ReplicaAccountDeletionResult,
                };
                // Validate expected evidence even if the current physical scope is empty.
                admission_deletion_matches(
                    &account_id,
                    &expected_head,
                    &expected_rows,
                    &expected_head,
                    &expected_rows,
                )?;
                let result = match load_account(&transaction, &account_id) {
                    Ok((None, rows)) if rows.is_empty() => {
                        ReplicaAccountDeletionResult::AlreadyAbsent {}
                    }
                    Ok((Some(head), rows))
                        if admission_deletion_matches(
                            &account_id,
                            &expected_head,
                            &expected_rows,
                            &head,
                            &rows,
                        )? =>
                    {
                        let mut boundary = 0;
                        transaction
                            .execute(
                                "DELETE FROM replica_rows WHERE account_id = ?1",
                                params![account_id.as_str()],
                            )
                            .map_err(sqlite_error)?;
                        self.after_write(&mut boundary)?;
                        transaction
                            .execute(
                                "DELETE FROM replica_heads WHERE account_id = ?1",
                                params![account_id.as_str()],
                            )
                            .map_err(sqlite_error)?;
                        self.after_write(&mut boundary)?;
                        ReplicaAccountDeletionResult::Deleted {}
                    }
                    _ => ReplicaAccountDeletionResult::Conflict {},
                };
                ReplicaPersistenceResponse::AccountDeletion { result }
            }
            ReplicaPersistenceRequest::DeleteAccount { account_id } => {
                if account_id.as_str().is_empty() {
                    return Err(replica_error("Replica Account identity is empty"));
                }
                let mut boundary = 0;
                transaction
                    .execute(
                        "DELETE FROM replica_rows WHERE account_id = ?1",
                        params![account_id.as_str()],
                    )
                    .map_err(sqlite_error)?;
                self.after_write(&mut boundary)?;
                transaction
                    .execute(
                        "DELETE FROM replica_heads WHERE account_id = ?1",
                        params![account_id.as_str()],
                    )
                    .map_err(sqlite_error)?;
                self.after_write(&mut boundary)?;
                ReplicaPersistenceResponse::AccountDeleted
            }
            ReplicaPersistenceRequest::WipeDevice => {
                let mut boundary = 0;
                transaction
                    .execute("DELETE FROM replica_rows", [])
                    .map_err(sqlite_error)?;
                self.after_write(&mut boundary)?;
                transaction
                    .execute("DELETE FROM replica_heads", [])
                    .map_err(sqlite_error)?;
                self.after_write(&mut boundary)?;
                ReplicaPersistenceResponse::DeviceWiped
            }
        };
        transaction.commit().map_err(sqlite_error)?;
        Ok(response)
    }

    fn after_write(&self, boundary: &mut usize) -> Result<(), RuntimeError> {
        *boundary += 1;
        #[cfg(test)]
        if self.fail_after_write == Some(*boundary) {
            return Err(replica_error("injected SQLite Replica write failure"));
        }
        Ok(())
    }
}

fn load_account(
    transaction: &Transaction<'_>,
    account_id: &AccountId,
) -> Result<(Option<ReplicaHead>, Vec<StoredReplicaRow>), RuntimeError> {
    let head = transaction
        .query_row(
            "SELECT user_id, incarnation, replica_revision, lock_epoch, failure_json \
             FROM replica_heads WHERE account_id = ?1",
            params![account_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            },
        )
        .optional()
        .map_err(sqlite_error)?
        .map(
            |(user_id, incarnation, replica_revision, lock_epoch, failure_json)| {
                Ok(ReplicaHead {
                    account_id: account_id.clone(),
                    user_id,
                    incarnation: incarnation.into(),
                    replica_revision: parse_u64(&replica_revision)?,
                    lock_epoch: parse_u64(&lock_epoch)?,
                    failure: failure_json
                        .map(|json| serde_json::from_str(&json).map_err(sqlite_error))
                        .transpose()?,
                })
            },
        )
        .transpose()?;

    let mut statement = transaction
        .prepare(
            "SELECT store, record_id, payload_json FROM replica_rows \
             WHERE account_id = ?1 ORDER BY store, record_id",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![account_id.as_str()], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(sqlite_error)?
        .map(|row| {
            let (store, record_id, payload_json) = row.map_err(sqlite_error)?;
            Ok(StoredReplicaRow {
                store: decode_store(store)?,
                key: ReplicaRowKey {
                    account_id: account_id.clone(),
                    record_id,
                },
                payload_json,
            })
        })
        .collect::<Result<Vec<_>, RuntimeError>>()?;
    Ok((head, rows))
}

pub(crate) fn put_head(
    transaction: &Transaction<'_>,
    head: &ReplicaHead,
) -> Result<(), RuntimeError> {
    let failure_json = head
        .failure
        .map(|failure| serde_json::to_string(&failure).map_err(sqlite_error))
        .transpose()?;
    transaction
        .execute(
            "INSERT INTO replica_heads \
             (account_id, user_id, incarnation, replica_revision, lock_epoch, failure_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(account_id) DO UPDATE SET user_id=excluded.user_id, \
             incarnation=excluded.incarnation, replica_revision=excluded.replica_revision, \
             lock_epoch=excluded.lock_epoch, failure_json=excluded.failure_json",
            params![
                head.account_id.as_str(),
                &head.user_id,
                head.incarnation.as_str(),
                head.replica_revision.to_string(),
                head.lock_epoch.to_string(),
                failure_json,
            ],
        )
        .map_err(sqlite_error)?;
    Ok(())
}

fn apply_write(
    transaction: &Transaction<'_>,
    write: &PreparedReplicaWrite,
) -> Result<(), RuntimeError> {
    match write {
        PreparedReplicaWrite::Put { row } => {
            transaction
                .execute(
                    "INSERT INTO replica_rows (account_id, store, record_id, payload_json) \
                     VALUES (?1, ?2, ?3, ?4) ON CONFLICT(account_id, store, record_id) \
                     DO UPDATE SET payload_json=excluded.payload_json",
                    params![
                        row.key.account_id.as_str(),
                        encode_store(row.store),
                        &row.key.record_id,
                        &row.payload_json,
                    ],
                )
                .map_err(sqlite_error)?;
        }
        PreparedReplicaWrite::Delete { store, key } => {
            transaction
                .execute(
                    "DELETE FROM replica_rows WHERE account_id = ?1 AND store = ?2 AND record_id = ?3",
                    params![key.account_id.as_str(), encode_store(*store), &key.record_id],
                )
                .map_err(sqlite_error)?;
        }
    }
    Ok(())
}

/// Enumerate raw physical keys, independently of heads and logical payload reconstruction.
fn inventory_page(
    transaction: &Transaction<'_>,
    owner: &str,
    cursor: Option<&str>,
) -> Result<ReplicaInventoryPage, RuntimeError> {
    let after = inventory::decode_cursor(owner, cursor)?;
    let identity: i32 = transaction
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(sqlite_error)?;
    let version: i32 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(sqlite_error)?;
    if identity != APPLICATION_ID || version != PHYSICAL_VERSION {
        return Err(storage_error("Replica inventory schema is not supported"));
    }
    crate::sqlite_schema::validate(transaction, &MIGRATION_1.join("\n"))
        .map_err(|_| storage_error("Replica inventory schema is not supported"))?;

    let mut page = inventory::PageBuilder::new(owner, after.as_ref());
    let limit = (inventory::PAGE_ENTRIES + 1) as i64;
    if !matches!(&after, Some(ReplicaPhysicalKey::Row { .. })) {
        let mut statement = transaction
            .prepare(match &after {
                None => "SELECT account_id FROM replica_heads ORDER BY account_id LIMIT ?1",
                _ => "SELECT account_id FROM replica_heads WHERE account_id > ?2 ORDER BY account_id LIMIT ?1",
            })
            .map_err(sqlite_error)?;
        let mut heads = match &after {
            Some(ReplicaPhysicalKey::Head { account_id }) => {
                statement.query(params![limit, account_id.as_str()])
            }
            _ => statement.query(params![limit]),
        }
        .map_err(sqlite_error)?;
        while let Some(row) = heads.next().map_err(sqlite_error)? {
            let account_id = physical_text(row, 0)?.into();
            if !page.push(ReplicaPhysicalKey::Head { account_id })? {
                return page.finish(true);
            }
        }
    }

    let mut statement = transaction
        .prepare(match &after {
            Some(ReplicaPhysicalKey::Row { .. }) => "SELECT account_id, store, record_id FROM replica_rows WHERE (account_id, store, record_id) > (?2, ?3, ?4) ORDER BY account_id, store, record_id LIMIT ?1",
            _ => "SELECT account_id, store, record_id FROM replica_rows ORDER BY account_id, store, record_id LIMIT ?1",
        })
        .map_err(sqlite_error)?;
    let mut rows = match &after {
        Some(ReplicaPhysicalKey::Row {
            account_id,
            store,
            record_id,
        }) => statement.query(params![
            limit,
            account_id.as_str(),
            store.physical_id(),
            record_id
        ]),
        _ => statement.query(params![limit]),
    }
    .map_err(sqlite_error)?;
    while let Some(row) = rows.next().map_err(sqlite_error)? {
        let account_id = physical_text(row, 0)?.into();
        let store = match row.get_ref(1).map_err(sqlite_error)? {
            ValueRef::Integer(value) => decode_store(value)
                .map_err(|_| storage_error("Replica inventory row store is not supported"))?,
            _ => {
                return Err(storage_error(
                    "Replica inventory row store has an invalid type",
                ));
            }
        };
        let record_id = physical_text(row, 2)?;
        if !page.push(ReplicaPhysicalKey::Row {
            account_id,
            store,
            record_id,
        })? {
            return page.finish(true);
        }
    }
    page.finish(false)
}

fn physical_text(row: &Row<'_>, index: usize) -> Result<String, RuntimeError> {
    match row.get_ref(index).map_err(sqlite_error)? {
        ValueRef::Text(bytes) => Ok(inventory::validate_text(bytes)?.to_owned()),
        _ => Err(storage_error("Replica inventory key has an invalid type")),
    }
}

fn validate_commit_transition(
    current: &ReplicaHead,
    next: &ReplicaHead,
) -> Result<(), RuntimeError> {
    let expected_next_revision = current
        .replica_revision
        .checked_add(1)
        .ok_or_else(|| replica_error("Replica revision overflowed"))?;
    if next.account_id != current.account_id
        || next.user_id != current.user_id
        || next.incarnation != current.incarnation
        || (next.replica_revision != current.replica_revision
            && next.replica_revision != expected_next_revision)
        || next.lock_epoch != current.lock_epoch
    {
        return Err(replica_error("prepared Replica head transition is invalid"));
    }
    Ok(())
}

fn validate_write_scope(
    guarded_account_id: &AccountId,
    writes: &[PreparedReplicaWrite],
) -> Result<(), RuntimeError> {
    for write in writes {
        let key = match write {
            PreparedReplicaWrite::Put { row } => &row.key,
            PreparedReplicaWrite::Delete { key, .. } => key,
        };
        if key.account_id != *guarded_account_id {
            return Err(replica_error(
                "prepared Replica write is outside its guarded Account",
            ));
        }
    }
    Ok(())
}

pub(crate) fn encode_store(store: ReplicaStore) -> i64 {
    store.physical_id()
}

pub(crate) fn decode_store(store: i64) -> Result<ReplicaStore, RuntimeError> {
    match store {
        0 => Ok(ReplicaStore::OptimisticItems),
        1 => Ok(ReplicaStore::Operations),
        2 => Ok(ReplicaStore::OperationReceipts),
        3 => Ok(ReplicaStore::ReplicaMetadata),
        4 => Ok(ReplicaStore::BootstrapGenerations),
        5 => Ok(ReplicaStore::BootstrapPages),
        6 => Ok(ReplicaStore::AuthorityVaults),
        7 => Ok(ReplicaStore::AuthorityItems),
        8 => Ok(ReplicaStore::AttachmentMovePreparations),
        9 => Ok(ReplicaStore::ShareCapabilities),
        10 => Ok(ReplicaStore::CrossAccountMoves),
        11 => Ok(ReplicaStore::RotationAttempts),
        _ => Err(replica_error("SQLite Replica row has an unknown store")),
    }
}

fn parse_u64(value: &str) -> Result<u64, RuntimeError> {
    value
        .parse()
        .map_err(|_| replica_error("SQLite Replica counter is invalid"))
}

fn sqlite_error(_error: impl std::fmt::Display) -> RuntimeError {
    // SQLite may include SQL, table names, or the application-owned path in its diagnostics.
    // Those implementation details stay behind the adapter together with the schema.
    storage_error("SQLite Replica storage is unavailable")
}

fn storage_error(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::StorageUnavailable, message)
}

fn replica_error(message: impl Into<String>) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::InvariantViolation, message)
}

#[async_trait]
impl ReplicaPersistence for SqliteReplica {
    async fn invoke(
        &self,
        request: ReplicaPersistenceRequest,
    ) -> Result<ReplicaPersistenceResponse, RuntimeError> {
        self.invoke_sync(request)
    }
}

#[async_trait]
impl SerializedReplicaExecutor for SqliteReplica {
    async fn invoke(&self, request_json: String) -> Result<String, RuntimeError> {
        let request = serde_json::from_str(&request_json)
            .map_err(|error| sqlite_error(format!("invalid request: {error}")))?;
        let response = self.invoke_sync(request)?;
        serde_json::to_string(&response).map_err(sqlite_error)
    }
}
