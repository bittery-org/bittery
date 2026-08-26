//! One retained answer per Operation, for the lifetime of the User.
//!
//! An Operation is identified by `(User, Operation ID)` and pinned to a fingerprint of the exact
//! bytes that asked for it. Everything the Server decided about it — the effect, the audit trail,
//! the entity Sync event, the outcome row and the `operation_resolved` event — commits in one
//! transaction, so a client that lost the response can ask again and get the same answer instead
//! of causing a second effect.
//!
//! The wire type is one union tagged on `kind`. A caller recovering from a lost response is
//! precisely the caller that does not yet know what happened, so it cannot pick a per-kind route;
//! it reads `kind`, checks it against its own durable record, and only then reads the result. A
//! `kind` it does not know fails to parse rather than being read as some other Operation's answer.

pub(crate) mod http;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, FromRow, PgPool};
use utoipa::ToSchema;

use crate::{
    db::{
        enums::{
            OperationKind, OperationOutcomeStatus, OperationRejectionCode, SyncEntityType,
            SyncEventType,
        },
        events::{begin_sync_event_transaction, insert_user_sync_event},
    },
    domains::vaults::{
        self, CreateItemEffectInput, FavoriteItemEffectInput, ItemEffect, ItemEffectInput,
        MoveItemEffectInput, UpdateItemEffectInput,
    },
    error::AppError,
    shared::transaction::{acquire_operation_lock, database_error},
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateShareAppliedPayload {
    pub(crate) share_link_id: String,
    pub(crate) base_share_url: String,
    pub(crate) expires_at: String,
}

/// Pins every fingerprint to this protocol, so bytes hashed under a later one can never collide.
const OPERATION_DISCRIMINATOR: &[u8] = b"bittery.operation.v1";

/// What one Item Operation asked for, and which Domain effect answers it.
///
/// The variants carry the route identity and canonical path values the fingerprint needs, so a
/// handler cannot accidentally fingerprint one route's bytes under another route's name.
pub(crate) enum ItemOperationEffect {
    Create(CreateItemEffectInput),
    Update(UpdateItemEffectInput),
    SetFavorite(FavoriteItemEffectInput),
    Trash(ItemEffectInput),
    Restore(ItemEffectInput),
    Move(MoveItemEffectInput),
    PermanentlyDelete(ItemEffectInput),
}

impl ItemOperationEffect {
    pub(crate) fn kind(&self) -> OperationKind {
        match self {
            Self::Create(_) => OperationKind::CreateItem,
            Self::Update(_) => OperationKind::UpdateItem,
            Self::SetFavorite(_) => OperationKind::SetItemFavorite,
            Self::Trash(_) => OperationKind::TrashItem,
            Self::Restore(_) => OperationKind::RestoreItem,
            Self::Move(_) => OperationKind::MoveItem,
            Self::PermanentlyDelete(_) => OperationKind::PermanentlyDeleteItem,
        }
    }

    /// The canonical route identity, method included: `DELETE` and `PATCH` on one path are two
    /// different Operations and must never share a fingerprint.
    fn route(&self) -> &'static str {
        match self {
            Self::Create(_) => "PUT /api/v1/vaults/{vaultId}/items/{itemId}",
            Self::Update(_) => "PATCH /api/v1/items/{itemId}",
            Self::SetFavorite(_) => "PATCH /api/v1/items/{itemId}/favorite",
            Self::Trash(_) => "DELETE /api/v1/items/{itemId}",
            Self::Restore(_) => "POST /api/v1/items/{itemId}/restore",
            Self::Move(_) => "POST /api/v1/items/{itemId}/moves",
            Self::PermanentlyDelete(_) => "DELETE /api/v1/items/{itemId}/permanent",
        }
    }

    /// The path values, in route order.
    fn path_values(&self) -> Vec<&str> {
        match self {
            Self::Create(input) => vec![input.vault_id.as_str(), input.item_id.as_str()],
            Self::Update(input) => vec![input.item_id.as_str()],
            Self::SetFavorite(input) => vec![input.item_id.as_str()],
            Self::Trash(input) => vec![input.item_id.as_str()],
            Self::Restore(input) => vec![input.item_id.as_str()],
            Self::Move(input) => vec![input.item_id.as_str()],
            Self::PermanentlyDelete(input) => vec![input.item_id.as_str()],
        }
    }

    /// The normalized concurrency precondition, or none where the route has none.
    fn precondition(&self) -> Option<i32> {
        match self {
            Self::Create(_) => None,
            Self::Update(input) => Some(input.expected_version),
            Self::SetFavorite(input) => Some(input.expected_version),
            Self::Trash(input) => Some(input.expected_version),
            Self::Restore(input) => Some(input.expected_version),
            Self::Move(input) => Some(input.expected_version),
            Self::PermanentlyDelete(input) => Some(input.expected_version),
        }
    }

    fn client_id(&self) -> Option<&str> {
        match self {
            Self::Create(input) => input.client_id.as_deref(),
            Self::Update(input) => input.client_id.as_deref(),
            Self::SetFavorite(input) => input.client_id.as_deref(),
            Self::Trash(input) => input.client_id.as_deref(),
            Self::Restore(input) => input.client_id.as_deref(),
            Self::Move(input) => input.client_id.as_deref(),
            Self::PermanentlyDelete(input) => input.client_id.as_deref(),
        }
    }
}

/// What one Item Operation left behind.
///
/// `Applied` retains the affected Item and the version it reached. That is exactly enough for a
/// client that lost its response to tell an applied Operation from a rejected one, and to line the
/// answer up with its own record, without replaying the effect to find out.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum ItemOperationResult {
    Applied {
        #[serde(rename = "itemId")]
        item_id: String,
        version: i32,
    },
    Rejected {
        code: ItemOperationRejectionCode,
        #[serde(skip_serializing_if = "Option::is_none")]
        details: Option<Value>,
    },
}

/// The Item-only rejection vocabulary. Its OpenAPI name stays stable because Client Runtime has
/// already generated this contract; Share-only failures belong to the Share result instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
#[schema(as = OperationRejectionCode)]
pub(crate) enum ItemOperationRejectionCode {
    InvalidCiphertext,
    VaultAccessDenied,
    VaultReadOnly,
    ItemIdConflict,
    ItemNotFound,
    ItemVersionConflict,
    ItemTrashed,
    ItemNotTrashed,
    SourceVaultMismatch,
    TargetVaultAccessDenied,
    TargetVaultReadOnly,
    AttachmentStateConflict,
}

fn item_rejection_code(
    code: OperationRejectionCode,
) -> Result<ItemOperationRejectionCode, AppError> {
    Ok(match code {
        OperationRejectionCode::InvalidCiphertext => ItemOperationRejectionCode::InvalidCiphertext,
        OperationRejectionCode::VaultAccessDenied => ItemOperationRejectionCode::VaultAccessDenied,
        OperationRejectionCode::VaultReadOnly => ItemOperationRejectionCode::VaultReadOnly,
        OperationRejectionCode::ItemIdConflict => ItemOperationRejectionCode::ItemIdConflict,
        OperationRejectionCode::ItemNotFound => ItemOperationRejectionCode::ItemNotFound,
        OperationRejectionCode::ItemVersionConflict => {
            ItemOperationRejectionCode::ItemVersionConflict
        }
        OperationRejectionCode::ItemTrashed => ItemOperationRejectionCode::ItemTrashed,
        OperationRejectionCode::ItemNotTrashed => ItemOperationRejectionCode::ItemNotTrashed,
        OperationRejectionCode::SourceVaultMismatch => {
            ItemOperationRejectionCode::SourceVaultMismatch
        }
        OperationRejectionCode::TargetVaultAccessDenied => {
            ItemOperationRejectionCode::TargetVaultAccessDenied
        }
        OperationRejectionCode::TargetVaultReadOnly => {
            ItemOperationRejectionCode::TargetVaultReadOnly
        }
        OperationRejectionCode::AttachmentStateConflict => {
            ItemOperationRejectionCode::AttachmentStateConflict
        }
        OperationRejectionCode::ShareEntitlementDenied
        | OperationRejectionCode::ShareLimitReached => {
            return Err(AppError::internal(
                "Stored Item Operation has a Share-only rejection",
            ));
        }
    })
}

/// The non-secret answer retained for Share creation. The raw token and Share key exist only in
/// the Account-protected Client Replica and can never be reconstructed from this value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(crate) enum CreateShareOperationResult {
    Applied {
        #[serde(rename = "shareLinkId")]
        share_link_id: String,
        #[serde(rename = "baseShareUrl")]
        base_share_url: String,
        #[serde(rename = "expiresAt")]
        expires_at: String,
    },
    Rejected {
        code: CreateShareOperationRejectionCode,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CreateShareOperationRejectionCode {
    ItemNotFound,
    VaultReadOnly,
    ShareEntitlementDenied,
    ShareLimitReached,
}

fn create_share_rejection_code(
    code: OperationRejectionCode,
) -> Result<CreateShareOperationRejectionCode, AppError> {
    Ok(match code {
        OperationRejectionCode::ItemNotFound => CreateShareOperationRejectionCode::ItemNotFound,
        OperationRejectionCode::VaultReadOnly => CreateShareOperationRejectionCode::VaultReadOnly,
        OperationRejectionCode::ShareEntitlementDenied => {
            CreateShareOperationRejectionCode::ShareEntitlementDenied
        }
        OperationRejectionCode::ShareLimitReached => {
            CreateShareOperationRejectionCode::ShareLimitReached
        }
        _ => {
            return Err(AppError::internal(
                "Stored Share Operation has an Item-only rejection",
            ))
        }
    })
}

/// The one retained outcome shape, discriminated by Operation kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
// The field rename is spelled out per variant because the OpenAPI generator reads `rename`, not
// serde's `rename_all_fields`, and a schema that disagrees with the wire is worse than no schema.
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum OperationOutcome {
    CreateItem {
        #[serde(rename = "operationId")]
        operation_id: String,
        result: ItemOperationResult,
    },
    UpdateItem {
        #[serde(rename = "operationId")]
        operation_id: String,
        result: ItemOperationResult,
    },
    SetItemFavorite {
        #[serde(rename = "operationId")]
        operation_id: String,
        result: ItemOperationResult,
    },
    TrashItem {
        #[serde(rename = "operationId")]
        operation_id: String,
        result: ItemOperationResult,
    },
    RestoreItem {
        #[serde(rename = "operationId")]
        operation_id: String,
        result: ItemOperationResult,
    },
    MoveItem {
        #[serde(rename = "operationId")]
        operation_id: String,
        result: ItemOperationResult,
    },
    PermanentlyDeleteItem {
        #[serde(rename = "operationId")]
        operation_id: String,
        result: ItemOperationResult,
    },
    CreateShare {
        #[serde(rename = "operationId")]
        operation_id: String,
        result: CreateShareOperationResult,
    },
}

impl OperationOutcome {
    fn new(kind: OperationKind, operation_id: String, result: ItemOperationResult) -> Self {
        match kind {
            OperationKind::CreateItem => Self::CreateItem {
                operation_id,
                result,
            },
            OperationKind::UpdateItem => Self::UpdateItem {
                operation_id,
                result,
            },
            OperationKind::SetItemFavorite => Self::SetItemFavorite {
                operation_id,
                result,
            },
            OperationKind::TrashItem => Self::TrashItem {
                operation_id,
                result,
            },
            OperationKind::RestoreItem => Self::RestoreItem {
                operation_id,
                result,
            },
            OperationKind::MoveItem => Self::MoveItem {
                operation_id,
                result,
            },
            OperationKind::PermanentlyDeleteItem => Self::PermanentlyDeleteItem {
                operation_id,
                result,
            },
            OperationKind::CreateShare => {
                unreachable!("Share outcomes use their non-secret applied payload")
            }
        }
    }

    pub(crate) fn new_create_share(
        operation_id: String,
        result: CreateShareOperationResult,
    ) -> Self {
        Self::CreateShare {
            operation_id,
            result,
        }
    }
}

pub(crate) struct ItemOperationInput {
    pub(crate) operation_id: String,
    pub(crate) user_id: String,
    pub(crate) effect: ItemOperationEffect,
    pub(crate) raw_body: Vec<u8>,
}

#[derive(FromRow)]
struct StoredOutcomeRow {
    operation_kind: OperationKind,
    request_fingerprint: Vec<u8>,
    result_status: OperationOutcomeStatus,
    entity_id: Option<String>,
    entity_version: Option<i32>,
    rejection_code: Option<OperationRejectionCode>,
    rejection_details: Option<String>,
    applied_payload: Option<String>,
}

pub(crate) enum OperationResolution {
    Outcome {
        outcome: OperationOutcome,
        newly_committed: bool,
    },
    IdReused,
}

fn fingerprint_part(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

/// Hashes the immutable request: protocol, kind, route, path values, exact body bytes, and the
/// normalized precondition. Bearer token, Session, client ID and tracing headers are excluded,
/// because the same work sent from a renewed Session is the same work.
fn item_operation_fingerprint(input: &ItemOperationInput) -> [u8; 32] {
    let mut hasher = Sha256::new();
    let kind = input.effect.kind();
    let precondition = input
        .effect
        .precondition()
        .map(|version| version.to_string())
        .unwrap_or_default();
    fingerprint_part(&mut hasher, OPERATION_DISCRIMINATOR);
    fingerprint_part(&mut hasher, kind.as_str().as_bytes());
    fingerprint_part(&mut hasher, input.effect.route().as_bytes());
    for value in input.effect.path_values() {
        fingerprint_part(&mut hasher, value.as_bytes());
    }
    fingerprint_part(&mut hasher, input.raw_body.as_slice());
    fingerprint_part(&mut hasher, precondition.as_bytes());
    hasher.finalize().into()
}

fn outcome_from_row(
    operation_id: &str,
    row: StoredOutcomeRow,
) -> Result<OperationOutcome, AppError> {
    if row.operation_kind == OperationKind::CreateShare {
        let result = match row.result_status {
            OperationOutcomeStatus::Applied => {
                let payload = row.applied_payload.ok_or_else(|| {
                    AppError::internal("Stored applied Share Operation has no payload")
                })?;
                let payload: CreateShareAppliedPayload = serde_json::from_str(&payload)
                    .map_err(|_| AppError::internal("Stored Share Operation payload is invalid"))?;
                CreateShareOperationResult::Applied {
                    share_link_id: payload.share_link_id,
                    base_share_url: payload.base_share_url,
                    expires_at: payload.expires_at,
                }
            }
            OperationOutcomeStatus::Rejected => {
                CreateShareOperationResult::Rejected {
                    code: create_share_rejection_code(row.rejection_code.ok_or_else(|| {
                        AppError::internal("Stored rejected Operation has no code")
                    })?)?,
                }
            }
        };
        return Ok(OperationOutcome::new_create_share(
            operation_id.to_owned(),
            result,
        ));
    }
    let result = match row.result_status {
        OperationOutcomeStatus::Applied => ItemOperationResult::Applied {
            item_id: row
                .entity_id
                .ok_or_else(|| AppError::internal("Stored applied Operation has no entity"))?,
            version: row
                .entity_version
                .ok_or_else(|| AppError::internal("Stored applied Operation has no version"))?,
        },
        OperationOutcomeStatus::Rejected => ItemOperationResult::Rejected {
            code: item_rejection_code(
                row.rejection_code
                    .ok_or_else(|| AppError::internal("Stored rejected Operation has no code"))?,
            )?,
            details: row
                .rejection_details
                .map(|details| serde_json::from_str(&details))
                .transpose()
                .map_err(|_| AppError::internal("Stored Operation details are invalid"))?,
        },
    };
    Ok(OperationOutcome::new(
        row.operation_kind,
        operation_id.to_owned(),
        result,
    ))
}

async fn load_outcome<'e>(
    executor: impl sqlx::Executor<'e, Database = sqlx::Postgres>,
    user_id: &str,
    operation_id: &str,
) -> Result<Option<StoredOutcomeRow>, AppError> {
    query_as::<_, StoredOutcomeRow>(
        "SELECT operation_kind::text AS operation_kind, request_fingerprint, result_status::text AS result_status, entity_id, entity_version, rejection_code::text AS rejection_code, rejection_details::text AS rejection_details, applied_payload::text AS applied_payload FROM operation_outcome WHERE user_id = $1 AND operation_id = $2",
    )
    .bind(user_id)
    .bind(operation_id)
    .fetch_optional(executor)
    .await
    .map_err(|error| database_error(error, "Failed to load Operation outcome"))
}

pub(crate) async fn get_operation_outcome(
    pool: &PgPool,
    user_id: &str,
    operation_id: &str,
) -> Result<Option<OperationOutcome>, AppError> {
    load_outcome(pool, user_id, operation_id)
        .await?
        .map(|row| outcome_from_row(operation_id, row))
        .transpose()
}

/// Runs one Item Operation to a terminal answer, exactly once per `(User, Operation ID)`.
pub(crate) async fn execute_item_operation(
    pool: &PgPool,
    input: ItemOperationInput,
) -> Result<OperationResolution, AppError> {
    let fingerprint = item_operation_fingerprint(&input);
    let kind = input.effect.kind();
    let client_id = input.effect.client_id().map(str::to_owned);
    let mut transaction = begin_sync_event_transaction(pool)
        .await
        .map_err(|error| database_error(error, "Failed to start Operation transaction"))?;
    acquire_operation_lock(
        &mut *transaction,
        &input.user_id,
        &input.operation_id,
        "Failed to serialize Operation",
    )
    .await?;

    if let Some(row) = load_outcome(&mut *transaction, &input.user_id, &input.operation_id).await? {
        if row.request_fingerprint != fingerprint {
            transaction.rollback().await.map_err(|error| {
                database_error(error, "Failed to close reused Operation transaction")
            })?;
            return Ok(OperationResolution::IdReused);
        }
        let outcome = outcome_from_row(&input.operation_id, row)?;
        transaction
            .commit()
            .await
            .map_err(|error| database_error(error, "Failed to replay Operation outcome"))?;
        return Ok(OperationResolution::Outcome {
            outcome,
            newly_committed: false,
        });
    }

    let effect = match input.effect {
        ItemOperationEffect::Create(effect) => {
            vaults::apply_create_item(&mut transaction, &input.user_id, effect).await?
        }
        ItemOperationEffect::Update(effect) => {
            vaults::apply_update_item(&mut transaction, &input.user_id, effect).await?
        }
        ItemOperationEffect::SetFavorite(effect) => {
            vaults::apply_set_item_favorite(&mut transaction, &input.user_id, effect).await?
        }
        ItemOperationEffect::Trash(effect) => {
            vaults::apply_trash_item(&mut transaction, &input.user_id, effect).await?
        }
        ItemOperationEffect::Restore(effect) => {
            vaults::apply_restore_item(&mut transaction, &input.user_id, effect).await?
        }
        ItemOperationEffect::Move(effect) => {
            vaults::apply_move_item(&mut transaction, &input.user_id, effect).await?
        }
        ItemOperationEffect::PermanentlyDelete(effect) => {
            vaults::apply_permanently_delete_item(&mut transaction, &input.user_id, effect).await?
        }
    };

    let result = match effect {
        ItemEffect::Rejected(code) => {
            query(
                "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, rejection_code) VALUES ($1, $2, $3::operation_kind, $4, $5::operation_outcome_status, $6::operation_rejection_code)",
            )
            .bind(&input.user_id)
            .bind(&input.operation_id)
            .bind(kind)
            .bind(fingerprint.as_slice())
            .bind(OperationOutcomeStatus::Rejected)
            .bind(code)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                database_error(error, "Failed to retain rejected Operation outcome")
            })?;
            ItemOperationResult::Rejected {
                code: item_rejection_code(code)?,
                details: None,
            }
        }
        ItemEffect::Applied { item_id, version } => {
            query(
                "INSERT INTO operation_outcome (user_id, operation_id, operation_kind, request_fingerprint, result_status, entity_id, entity_version) VALUES ($1, $2, $3::operation_kind, $4, $5::operation_outcome_status, $6, $7)",
            )
            .bind(&input.user_id)
            .bind(&input.operation_id)
            .bind(kind)
            .bind(fingerprint.as_slice())
            .bind(OperationOutcomeStatus::Applied)
            .bind(&item_id)
            .bind(version)
            .execute(&mut *transaction)
            .await
            .map_err(|error| {
                database_error(error, "Failed to retain applied Operation outcome")
            })?;
            ItemOperationResult::Applied { item_id, version }
        }
    };

    insert_user_sync_event(
        &mut transaction,
        SyncEventType::OperationResolved,
        &input.operation_id,
        SyncEntityType::Operation,
        &input.user_id,
        1,
        client_id.as_deref(),
        None,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error(error, "Failed to commit Operation outcome"))?;
    Ok(OperationResolution::Outcome {
        outcome: OperationOutcome::new(kind, input.operation_id, result),
        newly_committed: true,
    })
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
