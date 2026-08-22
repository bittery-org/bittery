pub(crate) mod http;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, FromRow, PgPool};
use utoipa::ToSchema;

use crate::{
    db::{
        enums::{ItemCategory, SyncEntityType, SyncEventType, VaultRole},
        events::{
            generate_resource_id, insert_audit_event, insert_sync_event, insert_user_sync_event,
        },
    },
    error::AppError,
    shared::transaction::{acquire_advisory_lock, database_error},
};

const CREATE_ITEM_DISCRIMINATOR: &[u8] = b"bittery.operation.v1";
const CREATE_ITEM_KIND: &[u8] = b"create_item";
const CREATE_ITEM_ROUTE: &[u8] = b"PUT /api/v1/vaults/{vaultId}/items/{itemId}";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OperationKind {
    CreateItem,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CreateItemRejectionCode {
    InvalidCiphertext,
    VaultAccessDenied,
    VaultReadOnly,
    ItemIdConflict,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum CreateItemOperationResult {
    Applied {
        #[serde(rename = "itemId")]
        item_id: String,
        version: i32,
    },
    Rejected {
        code: CreateItemRejectionCode,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateItemOperationOutcome {
    pub(crate) operation_id: String,
    pub(crate) kind: OperationKind,
    pub(crate) result: CreateItemOperationResult,
}

pub(crate) struct CreateItemOperationInput {
    pub(crate) operation_id: String,
    pub(crate) user_id: String,
    pub(crate) vault_id: String,
    pub(crate) item_id: String,
    pub(crate) category: ItemCategory,
    pub(crate) encrypted_data: String,
    pub(crate) encryption_iv: String,
    pub(crate) encryption_algorithm: String,
    pub(crate) client_id: Option<String>,
    pub(crate) raw_body: Vec<u8>,
    pub(crate) ciphertext_limit: usize,
}

#[derive(FromRow)]
struct StoredOutcomeRow {
    request_fingerprint: Vec<u8>,
    result_status: String,
    entity_id: Option<String>,
    entity_version: Option<i32>,
    rejection_code: Option<String>,
    rejection_details: Option<String>,
}

pub(crate) enum ExistingOutcome {
    Matching(CreateItemOperationOutcome),
    Reused,
}

fn fingerprint_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn create_item_fingerprint(input: &CreateItemOperationInput) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in [
        CREATE_ITEM_DISCRIMINATOR,
        CREATE_ITEM_KIND,
        CREATE_ITEM_ROUTE,
        input.vault_id.as_bytes(),
        input.item_id.as_bytes(),
        input.raw_body.as_slice(),
        b"" as &[u8],
    ] {
        fingerprint_part(&mut hasher, part);
    }
    hasher.finalize().into()
}

fn rejection_code(value: &str) -> Result<CreateItemRejectionCode, AppError> {
    match value {
        "invalid_ciphertext" => Ok(CreateItemRejectionCode::InvalidCiphertext),
        "vault_access_denied" => Ok(CreateItemRejectionCode::VaultAccessDenied),
        "vault_read_only" => Ok(CreateItemRejectionCode::VaultReadOnly),
        "item_id_conflict" => Ok(CreateItemRejectionCode::ItemIdConflict),
        _ => Err(AppError::internal(
            "Stored Operation outcome has an unknown rejection code",
        )),
    }
}

fn outcome_from_row(
    operation_id: &str,
    row: StoredOutcomeRow,
) -> Result<CreateItemOperationOutcome, AppError> {
    let result = match row.result_status.as_str() {
        "applied" => CreateItemOperationResult::Applied {
            item_id: row
                .entity_id
                .ok_or_else(|| AppError::internal("Stored applied Operation has no entity"))?,
            version: row
                .entity_version
                .ok_or_else(|| AppError::internal("Stored applied Operation has no version"))?,
        },
        "rejected" => CreateItemOperationResult::Rejected {
            code: rejection_code(
                row.rejection_code
                    .as_deref()
                    .ok_or_else(|| AppError::internal("Stored rejected Operation has no code"))?,
            )?,
            details: row
                .rejection_details
                .map(|details| serde_json::from_str(&details))
                .transpose()
                .map_err(|_| AppError::internal("Stored Operation details are invalid"))?,
        },
        _ => {
            return Err(AppError::internal(
                "Stored Operation outcome has an unknown status",
            ))
        }
    };
    Ok(CreateItemOperationOutcome {
        operation_id: operation_id.to_owned(),
        kind: OperationKind::CreateItem,
        result,
    })
}

async fn load_outcome<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Postgres>,
    user_id: &str,
    operation_id: &str,
) -> Result<Option<StoredOutcomeRow>, AppError> {
    query_as::<_, StoredOutcomeRow>(
        "SELECT request_fingerprint, result_status, entity_id, entity_version, rejection_code, rejection_details::text AS rejection_details FROM operation_outcome WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(operation_id)
    .fetch_optional(executor)
    .await
    .map_err(|error| database_error(error, "Failed to load Operation outcome"))
}

pub(crate) async fn get_create_item_outcome(
    pool: &PgPool,
    user_id: &str,
    operation_id: &str,
) -> Result<Option<CreateItemOperationOutcome>, AppError> {
    load_outcome(pool, user_id, operation_id)
        .await?
        .map(|row| outcome_from_row(operation_id, row))
        .transpose()
}

pub(crate) async fn execute_create_item(
    pool: &PgPool,
    input: CreateItemOperationInput,
) -> Result<ExistingOutcome, AppError> {
    let fingerprint = create_item_fingerprint(&input);
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Failed to start Operation transaction"))?;
    acquire_advisory_lock(
        &mut *transaction,
        &format!(
            "operation:{}:{}:{}{}",
            input.user_id.len(),
            input.operation_id.len(),
            input.user_id,
            input.operation_id
        ),
        "Failed to serialize Operation",
    )
    .await?;

    if let Some(row) = load_outcome(&mut *transaction, &input.user_id, &input.operation_id).await? {
        if row.request_fingerprint != fingerprint {
            transaction.rollback().await.map_err(|error| {
                database_error(error, "Failed to close reused Operation transaction")
            })?;
            return Ok(ExistingOutcome::Reused);
        }
        let outcome = outcome_from_row(&input.operation_id, row)?;
        transaction
            .commit()
            .await
            .map_err(|error| database_error(error, "Failed to replay Operation outcome"))?;
        return Ok(ExistingOutcome::Matching(outcome));
    }

    #[derive(FromRow)]
    struct AccessRow {
        role: VaultRole,
    }
    let access = query_as::<_, AccessRow>(
        "SELECT role::text AS role FROM vault_key WHERE vault_id = $1 AND user_id = $2 LIMIT 1",
    )
    .bind(&input.vault_id)
    .bind(&input.user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|error| database_error(error, "Failed to verify create Item authorization"))?;

    let mut rejection = if input.encrypted_data.len() > input.ciphertext_limit {
        Some((
            CreateItemRejectionCode::InvalidCiphertext,
            "invalid_ciphertext",
        ))
    } else {
        match access {
            None => Some((
                CreateItemRejectionCode::VaultAccessDenied,
                "vault_access_denied",
            )),
            Some(access) if !access.role.can_write() => {
                Some((CreateItemRejectionCode::VaultReadOnly, "vault_read_only"))
            }
            Some(_) => None,
        }
    };

    if rejection.is_none() {
        let inserted = query(
            "INSERT INTO item (id, vault_id, category, encrypted_data, encryption_iv, encryption_algorithm, version, encryption_version, encrypted_by_user_id, last_modified_by) VALUES ($1, $2, $3::item_category, $4, $5, $6, 1, 1, $7, $7) ON CONFLICT (id) DO NOTHING",
        )
        .bind(&input.item_id)
        .bind(&input.vault_id)
        .bind(input.category)
        .bind(&input.encrypted_data)
        .bind(&input.encryption_iv)
        .bind(&input.encryption_algorithm)
        .bind(&input.user_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to create Item"))?;
        if inserted.rows_affected() == 0 {
            rejection = Some((CreateItemRejectionCode::ItemIdConflict, "item_id_conflict"));
        }
    }

    let result = if let Some((code, stored_code)) = rejection {
        insert_audit_event(
            &mut *transaction,
            &generate_resource_id("audit"),
            &input.user_id,
            "item_create_rejected",
            "item",
            &input.item_id,
            Some(json!({ "vaultId": input.vault_id, "code": stored_code })),
        )
        .await?;
        query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, $2, 'create_item', $3, 'rejected', $4)",
        )
        .bind(&input.user_id)
        .bind(&input.operation_id)
        .bind(fingerprint.as_slice())
        .bind(stored_code)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to retain rejected Operation outcome"))?;
        CreateItemOperationResult::Rejected {
            code,
            details: None,
        }
    } else {
        insert_audit_event(
            &mut *transaction,
            &generate_resource_id("audit"),
            &input.user_id,
            "item_created",
            "item",
            &input.item_id,
            Some(json!({ "vaultId": input.vault_id, "category": input.category })),
        )
        .await?;
        insert_sync_event(
            &mut *transaction,
            SyncEventType::ItemCreated,
            &input.item_id,
            SyncEntityType::Item,
            &input.vault_id,
            &input.user_id,
            1,
            input.client_id.as_deref(),
            None,
        )
        .await?;
        query(
            "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, entity_id, entity_version) VALUES ($1, $2, 'create_item', $3, 'applied', $4, 1)",
        )
        .bind(&input.user_id)
        .bind(&input.operation_id)
        .bind(fingerprint.as_slice())
        .bind(&input.item_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| database_error(error, "Failed to retain applied Operation outcome"))?;
        CreateItemOperationResult::Applied {
            item_id: input.item_id.clone(),
            version: 1,
        }
    };

    insert_user_sync_event(
        &mut *transaction,
        SyncEventType::OperationResolved,
        &input.operation_id,
        SyncEntityType::Operation,
        &input.user_id,
        1,
        input.client_id.as_deref(),
        None,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Operation outcome"))?;
    Ok(ExistingOutcome::Matching(CreateItemOperationOutcome {
        operation_id: input.operation_id,
        kind: OperationKind::CreateItem,
        result,
    }))
}

#[cfg(test)]
mod tests {
    use super::{create_item_fingerprint, CreateItemOperationInput};
    use crate::db::enums::ItemCategory;

    #[test]
    fn fingerprint_is_exactly_sensitive_to_raw_body_bytes() {
        let input = |raw_body: &[u8]| CreateItemOperationInput {
            operation_id: "ignored".into(),
            user_id: "ignored".into(),
            vault_id: "vault".into(),
            item_id: "item".into(),
            category: ItemCategory::Login,
            encrypted_data: "ciphertext".into(),
            encryption_iv: "iv".into(),
            encryption_algorithm: "aes-gcm".into(),
            client_id: None,
            raw_body: raw_body.to_vec(),
            ciphertext_limit: 1024,
        };
        assert_ne!(
            create_item_fingerprint(&input(br#"{"a":1}"#)),
            create_item_fingerprint(&input(br#"{ "a": 1 }"#)),
        );
    }
}
