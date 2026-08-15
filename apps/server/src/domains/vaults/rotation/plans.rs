//! Durable, short-lived coordination for Vault key rotation.
//!
//! Policy modules authorize an intention before calling [`create_plan`]. This module owns the
//! snapshot, staging and atomic cryptographic state transition; it intentionally does not decide
//! whether a User may remove a Member or depart a Team.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{query, query_as, query_scalar, PgPool, Postgres, Transaction};
use time::{format_description::well_known::Rfc3339, Duration, OffsetDateTime};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    db::enums::{
        KeyRotationReason, VaultKeyRotationManifestKind, VaultKeyRotationPlanState,
        VaultKeyRotationStaleReason,
    },
    error::AppError,
    shared::transaction::database_error,
};

const IDLE_LIFETIME: Duration = Duration::minutes(30);
const ABSOLUTE_LIFETIME: Duration = Duration::hours(24);
pub(crate) const MAX_PAGE_RECORDS: usize = 100;
pub(crate) const MAX_PAGE_BYTES: usize = 512 * 1024;
pub(crate) const MAX_CLEANUP_BATCH: u32 = 500;

#[derive(Debug, Clone)]
pub(crate) struct CreateRotationPlanInput {
    pub vault_id: String,
    pub initiator_user_id: String,
    pub reason: KeyRotationReason,
    pub authorization_context: String,
    pub excluded_user_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RotationPlanSummary {
    pub id: String,
    pub vault_id: String,
    pub initiator_user_id: String,
    pub expected_key_version: i32,
    pub state: VaultKeyRotationPlanState,
    #[schema(format = DateTime)]
    pub idle_expires_at: String,
    #[schema(format = DateTime)]
    pub absolute_expires_at: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparationRecord {
    pub id: String,
    pub expected_version: i32,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparationPage {
    pub records: Vec<PreparationRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct StagedOutput {
    pub id: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RotationResult {
    pub plan_id: String,
    pub vault_id: String,
    pub key_version: i32,
    pub rotation_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FinalizeError {
    Stale(VaultKeyRotationStaleReason),
    InvalidState,
    Incomplete,
    RetryableConflict,
    Database(String),
}

impl From<sqlx::Error> for FinalizeError {
    fn from(value: sqlx::Error) -> Self {
        if crate::shared::transaction::is_retryable_transaction_error(&value) {
            Self::RetryableConflict
        } else {
            Self::Database(value.to_string())
        }
    }
}

type PlanRow = (
    String,
    String,
    String,
    i32,
    VaultKeyRotationPlanState,
    OffsetDateTime,
    OffsetDateTime,
);

#[derive(Debug, Clone)]
pub(crate) struct LockedPlanPolicy {
    pub vault_id: String,
    pub initiator_user_id: String,
    pub reason: String,
    pub authorization_context: String,
    pub excluded_user_id: Option<String>,
}

fn format_rotation_deadline(value: OffsetDateTime) -> Result<String, AppError> {
    value.format(&Rfc3339).map_err(|error| {
        tracing::error!(%error, "Failed to format rotation deadline");
        AppError::internal("Vault key rotation operation failed")
    })
}

/// Locks and exposes only the policy binding of an active plan. Policy callers use this before
/// finalization so authorization and the intended target are revalidated in the same transaction.
pub(crate) async fn lock_plan_policy(
    tx: &mut Transaction<'_, Postgres>,
    plan_id: &str,
) -> Result<LockedPlanPolicy, FinalizeError> {
    query_as::<_, (String, String, String, String, Option<String>)>(
        "SELECT vault_id, initiator_user_id, reason::text, authorization_context, excluded_user_id FROM vault_key_rotation_plan WHERE id=$1 AND state IN ('preparing','ready') AND idle_expires_at>now() AND absolute_expires_at>now() FOR UPDATE",
    )
    .bind(plan_id)
    .fetch_optional(&mut **tx)
    .await?
    .map(|row| LockedPlanPolicy {
        vault_id: row.0,
        initiator_user_id: row.1,
        reason: row.2,
        authorization_context: row.3,
        excluded_user_id: row.4,
    })
    .ok_or(FinalizeError::InvalidState)
}

/// Snapshots authoritative state. Authorization must already have succeeded in the policy caller.
pub(crate) async fn create_plan(
    pool: &PgPool,
    input: CreateRotationPlanInput,
) -> Result<RotationPlanSummary, AppError> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await
        .map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    let expected_key_version: i32 = query_scalar("SELECT key_version FROM vault WHERE id = $1")
        .bind(&input.vault_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|error| database_error(error, "Vault key rotation database operation failed"))?
        .ok_or_else(|| AppError::not_found("Vault not found"))?;
    let now = OffsetDateTime::now_utc();
    let id = Uuid::new_v4().to_string();
    let idle_expires_at = now + IDLE_LIFETIME;
    let absolute_expires_at = now + ABSOLUTE_LIFETIME;
    let idle_expires_at_wire = format_rotation_deadline(idle_expires_at)?;
    let absolute_expires_at_wire = format_rotation_deadline(absolute_expires_at)?;

    query("INSERT INTO vault_key_rotation_plan (id, vault_id, initiator_user_id, reason, authorization_context, excluded_user_id, expected_key_version, idle_expires_at, absolute_expires_at) VALUES ($1, $2, $3, $4::key_rotation_reason, $5, $6, $7, $8, $9)")
        .bind(&id).bind(&input.vault_id).bind(&input.initiator_user_id).bind(input.reason)
        .bind(&input.authorization_context).bind(&input.excluded_user_id).bind(expected_key_version)
        .bind(idle_expires_at).bind(absolute_expires_at).execute(&mut *tx).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;

    query("INSERT INTO vault_key_rotation_plan_manifest (plan_id, kind, entity_id, expected_version, payload) SELECT $1, 'member', vk.user_id, $2, json_build_object('userId', vk.user_id, 'publicKey', u.public_key, 'role', vk.role)::text FROM vault_key vk JOIN \"user\" u ON u.id=vk.user_id WHERE vk.vault_id = $3 AND ($4::text IS NULL OR vk.user_id <> $4) ORDER BY vk.user_id")
        .bind(&id).bind(expected_key_version).bind(&input.vault_id).bind(&input.excluded_user_id)
        .execute(&mut *tx).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    query("INSERT INTO vault_key_rotation_plan_manifest (plan_id, kind, entity_id, expected_version, payload) SELECT $1, 'item', i.id, i.version, json_build_object('id', i.id, 'vaultId', i.vault_id, 'encryptedData', i.encrypted_data, 'encryptionIv', i.encryption_iv, 'encryptionAlgorithm', i.encryption_algorithm, 'encryptionVersion', i.encryption_version, 'encryptedByUserId', i.encrypted_by_user_id)::text FROM item i WHERE i.vault_id = $2 ORDER BY i.id")
        .bind(&id).bind(&input.vault_id).execute(&mut *tx).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    query("INSERT INTO vault_key_rotation_plan_manifest (plan_id, kind, entity_id, expected_version, payload) SELECT $1, 'attachment', a.id, a.envelope_version, json_build_object('encryptedAttachmentKey', a.encrypted_attachment_key, 'attachmentKeyIv', a.attachment_key_iv, 'attachmentKeyAlgorithm', a.attachment_key_algorithm, 'vaultId', a.vault_id, 'attachmentId', a.id, 'uploadedBy', a.uploaded_by, 'envelopeVersion', a.envelope_version)::text FROM item_attachment a WHERE a.vault_id = $2 ORDER BY a.id")
        .bind(&id).bind(&input.vault_id).execute(&mut *tx).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    tx.commit()
        .await
        .map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;

    Ok(RotationPlanSummary {
        id,
        vault_id: input.vault_id,
        initiator_user_id: input.initiator_user_id,
        expected_key_version,
        state: VaultKeyRotationPlanState::Preparing,
        idle_expires_at: idle_expires_at_wire,
        absolute_expires_at: absolute_expires_at_wire,
    })
}

async fn load_active_plan<'a, E>(
    executor: E,
    plan_id: &str,
    initiator_user_id: &str,
) -> Result<PlanRow, AppError>
where
    E: sqlx::Executor<'a, Database = Postgres>,
{
    let row: PlanRow = query_as("SELECT p.id, p.vault_id, p.initiator_user_id, p.expected_key_version, p.state, p.idle_expires_at, p.absolute_expires_at FROM vault_key_rotation_plan p WHERE p.id = $1 AND p.initiator_user_id = $2 AND EXISTS (SELECT 1 FROM vault_key vk WHERE vk.vault_id=p.vault_id AND vk.user_id=$2) FOR UPDATE")
        .bind(plan_id).bind(initiator_user_id).fetch_optional(executor).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?
        .ok_or_else(|| AppError::not_found("Rotation plan not found"))?;
    let now = OffsetDateTime::now_utc();
    if row.4 != VaultKeyRotationPlanState::Preparing && row.4 != VaultKeyRotationPlanState::Ready {
        return Err(AppError::conflict("Rotation plan is no longer active"));
    }
    if row.5 <= now || row.6 <= now {
        return Err(AppError::conflict("Rotation plan expired"));
    }
    Ok(row)
}

pub(crate) async fn read_preparation_page(
    pool: &PgPool,
    plan_id: &str,
    initiator_user_id: &str,
    kind: VaultKeyRotationManifestKind,
    cursor: Option<&str>,
    requested_limit: usize,
) -> Result<PreparationPage, AppError> {
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    let plan = load_active_plan(&mut *tx, plan_id, initiator_user_id).await?;
    let limit = requested_limit.clamp(1, MAX_PAGE_RECORDS);
    let rows: Vec<(String, i32, String)> = query_as("SELECT entity_id, expected_version, payload FROM vault_key_rotation_plan_manifest WHERE plan_id = $1 AND kind = $2::vault_key_rotation_manifest_kind AND entity_id > $3 ORDER BY entity_id LIMIT $4")
        .bind(plan_id).bind(kind).bind(cursor.unwrap_or("")).bind((limit + 1) as i64).fetch_all(&mut *tx).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    let available = rows.len();
    let mut records = Vec::new();
    let mut bytes = 0usize;
    for (id, expected_version, payload) in rows.into_iter().take(limit) {
        let record_bytes = id.len() + payload.len() + 16;
        if !records.is_empty() && bytes + record_bytes > MAX_PAGE_BYTES {
            break;
        }
        if record_bytes > MAX_PAGE_BYTES {
            return Err(AppError::payload_too_large(
                "Rotation record exceeds page limit",
            ));
        }
        bytes += record_bytes;
        records.push(PreparationRecord {
            id,
            expected_version,
            payload,
        });
    }
    let next_cursor = (records.len() < available)
        .then(|| records.last().map(|record| record.id.clone()))
        .flatten();
    query("UPDATE vault_key_rotation_plan SET idle_expires_at = LEAST($1, absolute_expires_at) WHERE id = $2 AND idle_expires_at = $3")
        .bind(OffsetDateTime::now_utc() + IDLE_LIFETIME).bind(plan_id).bind(plan.5).execute(&mut *tx).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    tx.commit()
        .await
        .map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    Ok(PreparationPage {
        next_cursor,
        records,
    })
}

pub(crate) async fn stage_outputs(
    pool: &PgPool,
    plan_id: &str,
    initiator_user_id: &str,
    kind: VaultKeyRotationManifestKind,
    outputs: &[StagedOutput],
) -> Result<(), AppError> {
    if outputs.is_empty() || outputs.len() > MAX_PAGE_RECORDS {
        return Err(AppError::bad_request("Invalid staged output page size"));
    }
    let mut tx = pool
        .begin()
        .await
        .map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    let plan = load_active_plan(&mut *tx, plan_id, initiator_user_id).await?;
    let page_bytes: usize = outputs
        .iter()
        .map(|output| output.id.len() + output.payload.len() + 16)
        .sum();
    if page_bytes > MAX_PAGE_BYTES {
        return Err(AppError::payload_too_large(
            "Staged output page exceeds limit",
        ));
    }
    for output in outputs {
        if output.payload.len() > MAX_PAGE_BYTES {
            return Err(AppError::payload_too_large("Staged output exceeds limit"));
        }
        let exists: bool = query_scalar("SELECT EXISTS(SELECT 1 FROM vault_key_rotation_plan_manifest WHERE plan_id = $1 AND kind = $2::vault_key_rotation_manifest_kind AND entity_id = $3)")
            .bind(plan_id).bind(kind).bind(&output.id).fetch_one(&mut *tx).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
        if !exists {
            return Err(AppError::bad_request(
                "Staged output is not in the plan manifest",
            ));
        }
        validate_staged_payload(kind, &output.payload)?;
        let hash = hex::encode(Sha256::digest(output.payload.as_bytes()));
        let stored: Option<String> = query_scalar("INSERT INTO vault_key_rotation_plan_staged_output (plan_id, kind, entity_id, payload, payload_hash) VALUES ($1, $2::vault_key_rotation_manifest_kind, $3, $4, $5) ON CONFLICT (plan_id, kind, entity_id) DO UPDATE SET payload_hash = vault_key_rotation_plan_staged_output.payload_hash WHERE vault_key_rotation_plan_staged_output.payload_hash = EXCLUDED.payload_hash RETURNING payload_hash")
            .bind(plan_id).bind(kind).bind(&output.id).bind(&output.payload).bind(&hash).fetch_optional(&mut *tx).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
        if stored.is_none() {
            return Err(AppError::conflict(
                "Staged output conflicts with an earlier upload",
            ));
        }
    }
    query("UPDATE vault_key_rotation_plan p SET state='ready' WHERE p.id=$1 AND NOT EXISTS (SELECT 1 FROM vault_key_rotation_plan_manifest m LEFT JOIN vault_key_rotation_plan_staged_output s ON s.plan_id=m.plan_id AND s.kind=m.kind AND s.entity_id=m.entity_id WHERE m.plan_id=p.id AND s.entity_id IS NULL)")
        .bind(plan_id).execute(&mut *tx).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    query("UPDATE vault_key_rotation_plan SET idle_expires_at = LEAST($1, absolute_expires_at) WHERE id = $2 AND idle_expires_at = $3")
        .bind(OffsetDateTime::now_utc() + IDLE_LIFETIME).bind(plan_id).bind(plan.5).execute(&mut *tx).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    tx.commit()
        .await
        .map_err(|error| database_error(error, "Vault key rotation database operation failed"))
}

pub(crate) async fn abandon_plan(
    pool: &PgPool,
    plan_id: &str,
    initiator_user_id: &str,
) -> Result<(), AppError> {
    let changed = query("UPDATE vault_key_rotation_plan SET state='abandoned' WHERE id=$1 AND initiator_user_id=$2 AND state IN ('preparing','ready') AND idle_expires_at>now() AND absolute_expires_at>now()")
        .bind(plan_id).bind(initiator_user_id).execute(pool).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?.rows_affected();
    if changed == 0 {
        return Err(AppError::conflict("Rotation plan is no longer active"));
    }
    Ok(())
}

/// Applies one plan inside a caller-owned transaction. Used by atomic multi-Vault departure.
pub(crate) async fn finalize_locked_plan(
    tx: &mut Transaction<'_, Postgres>,
    plan_id: &str,
    initiator_user_id: &str,
) -> Result<RotationResult, FinalizeError> {
    let plan: PlanRow = query_as("SELECT p.id, p.vault_id, p.initiator_user_id, p.expected_key_version, p.state, p.idle_expires_at, p.absolute_expires_at FROM vault_key_rotation_plan p WHERE p.id = $1 AND p.initiator_user_id = $2 AND EXISTS (SELECT 1 FROM vault_key vk WHERE vk.vault_id=p.vault_id AND vk.user_id=$2) FOR UPDATE")
        .bind(plan_id).bind(initiator_user_id).fetch_optional(&mut **tx).await?.ok_or(FinalizeError::InvalidState)?;
    if !matches!(
        plan.4,
        VaultKeyRotationPlanState::Preparing | VaultKeyRotationPlanState::Ready
    ) || plan.5 <= OffsetDateTime::now_utc()
        || plan.6 <= OffsetDateTime::now_utc()
    {
        return Err(FinalizeError::InvalidState);
    }
    let current_key_version: i32 =
        query_scalar("SELECT key_version FROM vault WHERE id = $1 FOR UPDATE")
            .bind(&plan.1)
            .fetch_optional(&mut **tx)
            .await?
            .ok_or(FinalizeError::InvalidState)?;
    if current_key_version != plan.3 {
        mark_stale(tx, plan_id, VaultKeyRotationStaleReason::VaultVersion).await?;
        return Err(FinalizeError::Stale(
            VaultKeyRotationStaleReason::VaultVersion,
        ));
    }

    for kind in VaultKeyRotationManifestKind::ALL {
        let missing: i64 = query_scalar("SELECT COUNT(*) FROM vault_key_rotation_plan_manifest m LEFT JOIN vault_key_rotation_plan_staged_output s ON s.plan_id=m.plan_id AND s.kind=m.kind AND s.entity_id=m.entity_id WHERE m.plan_id=$1 AND m.kind=$2::vault_key_rotation_manifest_kind AND s.entity_id IS NULL")
            .bind(plan_id).bind(kind).fetch_one(&mut **tx).await?;
        if missing != 0 {
            return Err(FinalizeError::Incomplete);
        }
    }
    let member_stale: bool = query_scalar("SELECT EXISTS((SELECT entity_id, payload::jsonb->>'publicKey', payload::jsonb->>'role' FROM vault_key_rotation_plan_manifest WHERE plan_id=$1 AND kind='member' EXCEPT SELECT vk.user_id, u.public_key, vk.role::text FROM vault_key vk JOIN \"user\" u ON u.id=vk.user_id JOIN vault_key_rotation_plan p ON p.id=$1 WHERE vk.vault_id=$2 AND (p.excluded_user_id IS NULL OR vk.user_id<>p.excluded_user_id)) UNION ALL (SELECT vk.user_id, u.public_key, vk.role::text FROM vault_key vk JOIN \"user\" u ON u.id=vk.user_id JOIN vault_key_rotation_plan p ON p.id=$1 WHERE vk.vault_id=$2 AND (p.excluded_user_id IS NULL OR vk.user_id<>p.excluded_user_id) EXCEPT SELECT entity_id, payload::jsonb->>'publicKey', payload::jsonb->>'role' FROM vault_key_rotation_plan_manifest WHERE plan_id=$1 AND kind='member'))")
        .bind(plan_id).bind(&plan.1).fetch_one(&mut **tx).await?;
    if member_stale {
        mark_stale(tx, plan_id, VaultKeyRotationStaleReason::MemberSet).await?;
        return Err(FinalizeError::Stale(VaultKeyRotationStaleReason::MemberSet));
    }
    let item_stale: bool = query_scalar("SELECT EXISTS(SELECT 1 FROM (SELECT entity_id, expected_version FROM vault_key_rotation_plan_manifest WHERE plan_id=$1 AND kind='item') m FULL JOIN (SELECT id, version FROM item WHERE vault_id=$2) i ON i.id=m.entity_id WHERE i.id IS NULL OR m.entity_id IS NULL OR i.version<>m.expected_version)")
        .bind(plan_id).bind(&plan.1).fetch_one(&mut **tx).await?;
    if item_stale {
        mark_stale(tx, plan_id, VaultKeyRotationStaleReason::ItemState).await?;
        return Err(FinalizeError::Stale(VaultKeyRotationStaleReason::ItemState));
    }
    let attachment_stale: bool = query_scalar("SELECT EXISTS(SELECT 1 FROM (SELECT entity_id, expected_version FROM vault_key_rotation_plan_manifest WHERE plan_id=$1 AND kind='attachment') m FULL JOIN (SELECT id, envelope_version FROM item_attachment WHERE vault_id=$2) a ON a.id=m.entity_id WHERE a.id IS NULL OR m.entity_id IS NULL OR a.envelope_version<>m.expected_version)")
        .bind(plan_id).bind(&plan.1).fetch_one(&mut **tx).await?;
    if attachment_stale {
        mark_stale(tx, plan_id, VaultKeyRotationStaleReason::AttachmentState).await?;
        return Err(FinalizeError::Stale(
            VaultKeyRotationStaleReason::AttachmentState,
        ));
    }

    query("DELETE FROM vault_key vk USING vault_key_rotation_plan p WHERE p.id=$1 AND vk.vault_id=$2 AND vk.user_id=p.excluded_user_id").bind(plan_id).bind(&plan.1).execute(&mut **tx).await?;
    query("UPDATE vault_key vk SET encrypted_vault_key=s.payload::jsonb->>'encryptedVaultKey' FROM vault_key_rotation_plan_staged_output s WHERE s.plan_id=$1 AND s.kind='member' AND vk.vault_id=$2 AND vk.user_id=s.entity_id").bind(plan_id).bind(&plan.1).execute(&mut **tx).await?;
    query("UPDATE item i SET encrypted_data=s.payload::jsonb->>'encryptedData', encryption_iv=s.payload::jsonb->>'encryptionIv', encryption_algorithm=s.payload::jsonb->>'encryptionAlgorithm', version=i.version+1, updated_at=now() FROM vault_key_rotation_plan_staged_output s WHERE s.plan_id=$1 AND s.kind='item' AND i.vault_id=$2 AND i.id=s.entity_id").bind(plan_id).bind(&plan.1).execute(&mut **tx).await?;
    query("UPDATE item_attachment a SET encrypted_attachment_key=s.payload::jsonb->>'encryptedAttachmentKey', attachment_key_iv=s.payload::jsonb->>'attachmentKeyIv', attachment_key_algorithm=s.payload::jsonb->>'attachmentKeyAlgorithm', envelope_version=a.envelope_version+1 FROM vault_key_rotation_plan_staged_output s WHERE s.plan_id=$1 AND s.kind='attachment' AND a.vault_id=$2 AND a.id=s.entity_id").bind(plan_id).bind(&plan.1).execute(&mut **tx).await?;
    let key_version = current_key_version + 1;
    query("UPDATE vault SET key_version=$1, updated_at=now() WHERE id=$2")
        .bind(key_version)
        .bind(&plan.1)
        .execute(&mut **tx)
        .await?;
    let rotation_id = Uuid::new_v4().to_string();
    query("INSERT INTO vault_key_rotation (id, vault_id, key_version, reason, initiated_by_id, removed_user_id, items_re_encrypted, members_updated, status, created_at, completed_at) SELECT $1, vault_id, $2, reason, initiator_user_id, excluded_user_id, (SELECT COUNT(*) FROM vault_key_rotation_plan_manifest WHERE plan_id=$3 AND kind='item'), (SELECT COUNT(*) FROM vault_key_rotation_plan_manifest WHERE plan_id=$3 AND kind='member'), 'completed', now(), now() FROM vault_key_rotation_plan WHERE id=$3")
        .bind(&rotation_id).bind(key_version).bind(plan_id).execute(&mut **tx).await?;
    query("UPDATE vault_key_rotation_plan SET state='completed', completed_at=now() WHERE id=$1")
        .bind(plan_id)
        .execute(&mut **tx)
        .await?;
    query("INSERT INTO sync_event (id, event_type, vault_id, entity_id, entity_type, version, user_id, metadata) SELECT 'syncevt_' || md5(random()::text || clock_timestamp()::text || vk.user_id), 'vault_key_rotated', $2, $2, 'vault_key', $3, vk.user_id, json_build_object('rotationId', $1)::text FROM vault_key vk WHERE vk.vault_id=$2")
        .bind(&rotation_id).bind(&plan.1).bind(key_version).execute(&mut **tx).await?;
    query("INSERT INTO sync_event (id,event_type,vault_id,entity_id,entity_type,version,user_id,metadata) SELECT 'syncevt_' || md5(random()::text || clock_timestamp()::text || vk.user_id || 'member_removed'),'vault_member_removed',p.vault_id,p.excluded_user_id,'vault_member',$2,vk.user_id,json_build_object('rotationId',$1,'removedUserId',p.excluded_user_id)::text FROM vault_key_rotation_plan p JOIN vault_key vk ON vk.vault_id=p.vault_id WHERE p.id=$3 AND p.reason='member_removed' AND p.excluded_user_id IS NOT NULL")
        .bind(&rotation_id).bind(key_version).bind(plan_id).execute(&mut **tx).await?;
    query("INSERT INTO sync_event (id,event_type,vault_id,entity_id,entity_type,version,user_id,metadata) SELECT 'syncevt_' || md5(random()::text || clock_timestamp()::text || excluded_user_id),'vault_access_revoked',vault_id,vault_id,'vault',$2,excluded_user_id,json_build_object('rotationId',$1)::text FROM vault_key_rotation_plan WHERE id=$3 AND excluded_user_id IS NOT NULL")
        .bind(&rotation_id).bind(key_version).bind(plan_id).execute(&mut **tx).await?;
    Ok(RotationResult {
        plan_id: plan_id.to_owned(),
        vault_id: plan.1,
        key_version,
        rotation_id,
    })
}

async fn mark_stale(
    tx: &mut Transaction<'_, Postgres>,
    plan_id: &str,
    reason: VaultKeyRotationStaleReason,
) -> Result<(), sqlx::Error> {
    query("UPDATE vault_key_rotation_plan SET state='stale', stale_reason=$2::vault_key_rotation_stale_reason WHERE id=$1")
        .bind(plan_id)
        .bind(reason)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(crate) async fn record_stale(
    pool: &PgPool,
    plan_id: &str,
    reason: VaultKeyRotationStaleReason,
) -> Result<(), AppError> {
    query("UPDATE vault_key_rotation_plan SET state='stale', stale_reason=$2::vault_key_rotation_stale_reason WHERE id=$1 AND state IN ('preparing','ready')")
        .bind(plan_id).bind(reason).execute(pool).await.map_err(|error| database_error(error, "Vault key rotation database operation failed"))?;
    Ok(())
}

fn validate_staged_payload(
    kind: VaultKeyRotationManifestKind,
    payload: &str,
) -> Result<(), AppError> {
    let object = serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .ok_or_else(|| AppError::bad_request("Invalid staged output"))?;
    let required: &[&str] = match kind {
        VaultKeyRotationManifestKind::Member => &["encryptedVaultKey"],
        VaultKeyRotationManifestKind::Item => {
            &["encryptedData", "encryptionIv", "encryptionAlgorithm"]
        }
        VaultKeyRotationManifestKind::Attachment => &[
            "encryptedAttachmentKey",
            "attachmentKeyIv",
            "attachmentKeyAlgorithm",
        ],
    };
    if required.iter().any(|field| {
        object
            .get(*field)
            .and_then(|value| value.as_str())
            .is_none_or(|value| value.is_empty())
    }) {
        return Err(AppError::bad_request("Invalid staged output"));
    }
    Ok(())
}

/// Deletes only terminal or expired plans and relies on FK cascades for staged data.
pub(crate) async fn cleanup_rotation_plans(
    pool: &PgPool,
    requested_limit: u32,
) -> Result<u64, sqlx::Error> {
    let limit = requested_limit.clamp(1, MAX_CLEANUP_BATCH) as i64;
    let result = query("WITH doomed AS (SELECT id FROM vault_key_rotation_plan WHERE (state IN ('completed','stale','failed','abandoned','expired') OR absolute_expires_at <= now() OR idle_expires_at <= now()) ORDER BY absolute_expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM vault_key_rotation_plan p USING doomed WHERE p.id=doomed.id")
        .bind(limit).execute(pool).await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{
        seed_item, seed_user, seed_vault, seed_vault_key, with_api_test_app,
    };

    async fn seed_rotation_fixture(pool: &PgPool) {
        seed_user(
            pool,
            "rotation_user",
            "Rotation User",
            "rotation@example.com",
        )
        .await;
        seed_vault(
            pool,
            "rotation_vault",
            "Rotation Vault",
            "personal",
            "rotation_user",
            None,
        )
        .await;
        seed_vault_key(
            pool,
            "rotation_key",
            "rotation_vault",
            "rotation_user",
            "wrapped-key",
            "owner",
        )
        .await;
        seed_item(
            pool,
            "rotation_item",
            "rotation_vault",
            "login",
            "ciphertext",
            "iv",
            "rotation_user",
        )
        .await;
    }

    async fn create_test_plan(pool: &PgPool) -> RotationPlanSummary {
        create_plan(
            pool,
            CreateRotationPlanInput {
                vault_id: "rotation_vault".to_owned(),
                initiator_user_id: "rotation_user".to_owned(),
                reason: KeyRotationReason::MemberRemoved,
                authorization_context: "test".to_owned(),
                excluded_user_id: None,
            },
        )
        .await
        .expect("rotation plan should be created")
    }

    async fn stage_test_plan(pool: &PgPool, plan_id: &str) {
        stage_outputs(
            pool,
            plan_id,
            "rotation_user",
            VaultKeyRotationManifestKind::Member,
            &[StagedOutput {
                id: "rotation_user".to_owned(),
                payload: r#"{"encryptedVaultKey":"rewrapped-key"}"#.to_owned(),
            }],
        )
        .await
        .expect("member output should stage");
        stage_outputs(
			pool,
			plan_id,
			"rotation_user",
			VaultKeyRotationManifestKind::Item,
			&[StagedOutput {
				id: "rotation_item".to_owned(),
				payload: r#"{"encryptedData":"rotated","encryptionIv":"new-iv","encryptionAlgorithm":"AES-GCM-AAD-V1"}"#.to_owned(),
			}],
		)
		.await
		.expect("item output should stage");
    }

    #[tokio::test]
    async fn member_removal_emits_cache_eviction_and_membership_events() {
        with_api_test_app("rotation_member_removal_events", |app| async move {
            seed_rotation_fixture(&app.pool).await;
            seed_user(
                &app.pool,
                "rotation_removed_user",
                "Removed User",
                "removed@rotation.example.com",
            )
            .await;
            seed_vault_key(
                &app.pool,
                "rotation_removed_key",
                "rotation_vault",
                "rotation_removed_user",
                "removed-wrapped-key",
                "member",
            )
            .await;
            let plan = create_plan(
                &app.pool,
                CreateRotationPlanInput {
                    vault_id: "rotation_vault".to_owned(),
                    initiator_user_id: "rotation_user".to_owned(),
                    reason: KeyRotationReason::MemberRemoved,
                    authorization_context: "test-removal".to_owned(),
                    excluded_user_id: Some("rotation_removed_user".to_owned()),
                },
            )
            .await
            .expect("removal plan should be created");
            stage_test_plan(&app.pool, &plan.id).await;
            let mut tx = app.pool.begin().await.expect("transaction should start");

            finalize_locked_plan(&mut tx, &plan.id, "rotation_user")
                .await
                .expect("removal should finalize");
            tx.commit().await.expect("rotation should commit");

            let revoked: (String, String, String, String) = query_as(
                "SELECT event_type::text,entity_id,entity_type::text,user_id FROM sync_event WHERE event_type='vault_access_revoked' AND user_id='rotation_removed_user'",
            )
            .fetch_one(&app.pool)
            .await
            .expect("revocation event should exist");
            assert_eq!(
                revoked,
                (
                    "vault_access_revoked".to_owned(),
                    "rotation_vault".to_owned(),
                    "vault".to_owned(),
                    "rotation_removed_user".to_owned(),
                )
            );

            let remaining_member_events: Vec<(String, String, String)> = query_as(
                "SELECT event_type::text,entity_id,entity_type::text FROM sync_event WHERE user_id='rotation_user' AND event_type IN ('vault_key_rotated','vault_member_removed') ORDER BY event_type",
            )
            .fetch_all(&app.pool)
            .await
            .expect("remaining Member events should load");
            assert_eq!(
                remaining_member_events,
                vec![
                    (
                        "vault_key_rotated".to_owned(),
                        "rotation_vault".to_owned(),
                        "vault_key".to_owned(),
                    ),
                    (
                        "vault_member_removed".to_owned(),
                        "rotation_removed_user".to_owned(),
                        "vault_member".to_owned(),
                    ),
                ]
            );
        })
        .await;
    }

    #[tokio::test]
    async fn another_plans_manifest_cannot_hide_a_new_item() {
        with_api_test_app("rotation_new_item_staleness", |app| async move {
            seed_rotation_fixture(&app.pool).await;
            let plan = create_test_plan(&app.pool).await;
            seed_item(
                &app.pool,
                "new_rotation_item",
                "rotation_vault",
                "login",
                "new-ciphertext",
                "new-iv",
                "rotation_user",
            )
            .await;
            let _other_plan = create_test_plan(&app.pool).await;
            stage_test_plan(&app.pool, &plan.id).await;
            let mut tx = app.pool.begin().await.unwrap();

            let result = finalize_locked_plan(&mut tx, &plan.id, "rotation_user").await;

            assert!(matches!(
                result,
                Err(FinalizeError::Stale(VaultKeyRotationStaleReason::ItemState))
            ));
        })
        .await;
    }

    #[tokio::test]
    async fn another_plans_manifest_cannot_hide_a_new_attachment() {
        with_api_test_app("rotation_new_attachment_staleness", |app| async move {
			seed_rotation_fixture(&app.pool).await;
			let plan = create_test_plan(&app.pool).await;
			query(
				r#"INSERT INTO item_attachment (id, item_id, vault_id, storage_key, encrypted_attachment_key, attachment_key_iv, attachment_key_algorithm, envelope_version, encrypted_name, encrypted_content_type, encryption_iv, encrypted_content_type_iv, encryption_algorithm, file_size, storage_size, uploaded_by) VALUES ('new_rotation_attachment', 'rotation_item', 'rotation_vault', 'attachments/new', 'wrapped-attachment-key', 'attachment-key-iv', 'AES-GCM-AAD-V1', 1, 'name', 'type', 'iv', 'type-iv', 'AES-GCM-AAD-V1', 1, 1, 'rotation_user')"#,
			)
			.execute(&app.pool)
			.await
			.expect("attachment should seed");
			let _other_plan = create_test_plan(&app.pool).await;
			stage_test_plan(&app.pool, &plan.id).await;
			let mut tx = app.pool.begin().await.unwrap();

			let result = finalize_locked_plan(&mut tx, &plan.id, "rotation_user").await;

			assert!(matches!(
				result,
				Err(FinalizeError::Stale(
					VaultKeyRotationStaleReason::AttachmentState
				))
			));
		})
		.await;
    }

    #[test]
    fn public_bounds_are_hard_caps() {
        assert_eq!(MAX_PAGE_RECORDS, 100);
        assert_eq!(MAX_PAGE_BYTES, 512 * 1024);
        assert_eq!(MAX_CLEANUP_BATCH, 500);
    }

    #[test]
    fn rotation_deadlines_use_rfc3339() {
        let formatted = format_rotation_deadline(OffsetDateTime::UNIX_EPOCH)
            .expect("the Unix epoch should format");
        assert_eq!(formatted, "1970-01-01T00:00:00Z");
    }

    #[test]
    fn staged_payloads_require_the_fields_finalization_reads() {
        assert!(validate_staged_payload(
            VaultKeyRotationManifestKind::Member,
            r#"{"encryptedVaultKey":"ciphertext"}"#,
        )
        .is_ok());
        assert!(validate_staged_payload(VaultKeyRotationManifestKind::Member, r#"{}"#).is_err());
        assert!(validate_staged_payload(
            VaultKeyRotationManifestKind::Attachment,
            r#"{"encryptedAttachmentKey":"key","attachmentKeyIv":"iv","attachmentKeyAlgorithm":"AES-GCM-AAD-V1"}"#,
        )
        .is_ok());
        assert!(validate_staged_payload(
            VaultKeyRotationManifestKind::Item,
            r#"{"encryptedData":"data","encryptionIv":"iv","encryptionAlgorithm":""}"#,
        )
        .is_err());
    }
}
