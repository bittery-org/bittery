//! Shared non-mutating validation of the existing native physical SQLite layouts.
use crate::RecoveryUnavailableReason;
use rusqlite::{types::Value, Connection};

pub(crate) fn admit_unversioned(
    connection: &Connection,
    schema: &str,
    known_old: &[&str],
) -> Result<(), RecoveryUnavailableReason> {
    let identity: i32 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
    let version: i32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
    if identity != 0 || version != 0 {
        return Err(RecoveryUnavailableReason::UnsupportedSchema);
    }
    admit_empty_or_known(connection, schema, known_old)
}

/// Inspect every declared object before an owner creates or migrates its known layout. The
/// caller validates its own application/version stamps, which differ between physical owners.
pub(crate) fn admit_empty_or_known(
    connection: &Connection,
    schema: &str,
    known_old: &[&str],
) -> Result<(), RecoveryUnavailableReason> {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
    if count == 0 {
        return Ok(());
    }
    match validate(connection, schema) {
        Err(RecoveryUnavailableReason::UnsupportedSchema) => {
            for old in known_old {
                match validate(connection, old) {
                    Ok(()) => return Ok(()),
                    Err(RecoveryUnavailableReason::UnsupportedSchema) => {}
                    Err(error) => return Err(error),
                }
            }
            Err(RecoveryUnavailableReason::UnsupportedSchema)
        }
        result => result,
    }
}

/// Compare schema metadata against the actual existing adapter schema, without reconstructing or
/// migrating the input. Column order/type/default/key, indexes and foreign keys must all match.
/// `schema` is trusted adapter-owned SQL, never caller-supplied SQL from a Runtime request.
pub fn validate(database: &Connection, schema: &str) -> Result<(), RecoveryUnavailableReason> {
    let expected =
        Connection::open_in_memory().map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
    expected
        .execute_batch(schema)
        .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
    let tables = |connection: &Connection| -> Result<Vec<String>, RecoveryUnavailableReason> {
        connection.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name").map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?.query_map([], |row| row.get(0)).map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?.collect::<Result<Vec<_>, _>>().map_err(|_| RecoveryUnavailableReason::StorageUnavailable)
    };
    let expected_tables = tables(&expected)?;
    if tables(database)? != expected_tables {
        return Err(RecoveryUnavailableReason::UnsupportedSchema);
    }
    // table_info omits CHECK clauses and triggers. Compare the complete declared objects too;
    // otherwise a future trigger could change the meaning of a later guarded repair transaction.
    if schema_objects(database)? != schema_objects(&expected)? {
        return Err(RecoveryUnavailableReason::UnsupportedSchema);
    }
    for table in expected_tables {
        for pragma in ["table_info", "foreign_key_list", "index_list"] {
            let query = format!("PRAGMA {pragma}({table})");
            if schema_rows(database, &query)
                .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?
                != schema_rows(&expected, &query)
                    .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?
            {
                return Err(RecoveryUnavailableReason::UnsupportedSchema);
            }
        }
    }
    Ok(())
}

fn schema_objects(
    connection: &Connection,
) -> Result<Vec<(String, String, String)>, RecoveryUnavailableReason> {
    connection.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' AND sql IS NOT NULL ORDER BY type,name")
        .map_err(|_|RecoveryUnavailableReason::StorageUnavailable)?
        .query_map([],|row| {
            let kind:String=row.get(0)?;
            let sql:String=row.get(2)?;
            Ok((kind.clone(),row.get(1)?,normalize_schema_sql(&kind,&sql)))
        }).map_err(|_|RecoveryUnavailableReason::StorageUnavailable)?
        .collect::<Result<Vec<_>,_>>().map_err(|_|RecoveryUnavailableReason::StorageUnavailable)
}

fn normalize_schema_sql(kind: &str, sql: &str) -> String {
    let normalized: String = sql
        .chars()
        .filter(|value| !value.is_ascii_whitespace())
        .map(|value| value.to_ascii_lowercase())
        .collect();
    if kind != "table" {
        return normalized;
    }
    // The known physical_generation migration appends a column after table constraints; fresh
    // creation declares it before them. Column order is checked separately by table_info. Compare
    // these top-level declarations as a set while retaining every inner CHECK/key expression.
    let Some(start) = normalized.find('(') else {
        return normalized;
    };
    let Some(end) = normalized.rfind(')') else {
        return normalized;
    };
    let mut declarations = Vec::new();
    let mut depth = 0;
    let mut boundary = start + 1;
    for (offset, character) in normalized
        .char_indices()
        .skip_while(|(offset, _)| *offset <= start)
        .take_while(|(offset, _)| *offset < end)
    {
        match character {
            '(' => depth += 1,
            ')' => depth -= 1,
            ',' if depth == 0 => {
                declarations.push(&normalized[boundary..offset]);
                boundary = offset + 1;
            }
            _ => {}
        }
    }
    declarations.push(&normalized[boundary..end]);
    declarations.sort_unstable();
    format!(
        "{}({}){}",
        &normalized[..start],
        declarations.join(","),
        &normalized[end + 1..]
    )
}
fn schema_rows(
    connection: &Connection,
    query: &str,
) -> Result<Vec<Vec<Value>>, RecoveryUnavailableReason> {
    let mut statement = connection
        .prepare(query)
        .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
    let columns = statement.column_count();
    let result = statement
        .query_map([], |row| {
            (0..columns)
                .map(|index| row.get(index))
                .collect::<Result<Vec<Value>, _>>()
        })
        .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| RecoveryUnavailableReason::StorageUnavailable)?;
    Ok(result)
}
