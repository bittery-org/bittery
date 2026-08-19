use serde::{Deserialize, Serialize};
use sqlx::{query_as, query_scalar, PgPool};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::{
    config::DeploymentMode,
    db::enums::{ShareLinkAccessMode, ShareLinkStatus, VaultRole, VaultType},
    error::AppError,
    shared::transaction::database_error,
};

use super::authorize_team_admin;
use crate::domains::teams::audit::mask_ip;

/// Newest-first caps. The console shows a member's footprint, not an archive.
const MAX_SHARE_LINKS: i64 = 100;
const MAX_SESSIONS: i64 = 50;

#[derive(Debug, Clone, sqlx::FromRow)]
struct MemberVaultRow {
    id: String,
    name: String,
    vault_type: VaultType,
    role: VaultRole,
    granted_at: OffsetDateTime,
    item_count: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct MemberSessionRow {
    id: String,
    device_name: Option<String>,
    platform: Option<String>,
    browser_name: Option<String>,
    os_name: Option<String>,
    ip_address: Option<String>,
    created_at: OffsetDateTime,
    last_active_at: OffsetDateTime,
    expires_at: OffsetDateTime,
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct MemberShareLinkRow {
    id: String,
    item_id: String,
    status: ShareLinkStatus,
    access_mode: ShareLinkAccessMode,
    access_count: i32,
    max_access_count: Option<i32>,
    expires_at: OffsetDateTime,
    created_at: OffsetDateTime,
    last_accessed_at: Option<OffsetDateTime>,
}

/// Team vaults the member can decrypt, i.e. the vaults they hold a wrapped key for.
///
/// Scoped to `team_id`: a member's personal vaults are deliberately invisible to admins.
async fn load_member_vaults(
    pool: &PgPool,
    team_id: &str,
    user_id: &str,
) -> Result<Vec<MemberVaultRow>, AppError> {
    query_as::<_, MemberVaultRow>(
        "SELECT v.id,
                v.name,
                v.type::text AS vault_type,
                vk.role::text AS role,
                vk.created_at AS granted_at,
                (SELECT COUNT(*) FROM item i WHERE i.vault_id = v.id AND i.deleted_at IS NULL) AS item_count
         FROM vault_key vk
         INNER JOIN vault v ON vk.vault_id = v.id
         WHERE vk.user_id = $1 AND v.team_id = $2
         ORDER BY v.name ASC",
    )
    .bind(user_id)
    .bind(team_id)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load member vaults"))
}

/// Unexpired sessions for the member. Sessions double as devices in this schema.
async fn load_member_sessions(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<MemberSessionRow>, AppError> {
    query_as::<_, MemberSessionRow>(
        "SELECT id, device_name, platform, browser_name, os_name, ip_address,
                created_at, last_active_at, expires_at
         FROM session
         WHERE user_id = $1 AND expires_at > now()
         ORDER BY last_active_at DESC
         LIMIT $2",
    )
    .bind(user_id)
    .bind(MAX_SESSIONS)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load member sessions"))
}

/// Share links the member created, newest first, capped at [`MAX_SHARE_LINKS`].
async fn load_member_share_links(
    pool: &PgPool,
    user_id: &str,
) -> Result<Vec<MemberShareLinkRow>, AppError> {
    query_as::<_, MemberShareLinkRow>(
        "SELECT id, item_id, status::text AS status, access_mode::text AS access_mode,
                access_count, max_access_count, expires_at, created_at, last_accessed_at
         FROM share_link
         WHERE created_by_id = $1
         ORDER BY created_at DESC
         LIMIT $2",
    )
    .bind(user_id)
    .bind(MAX_SHARE_LINKS)
    .fetch_all(pool)
    .await
    .map_err(|error| database_error(error, "Failed to load member share links"))
}

/// Total share links created by the member, so the UI can say when its list is capped.
async fn count_member_share_links(pool: &PgPool, user_id: &str) -> Result<i64, AppError> {
    query_scalar::<_, i64>("SELECT COUNT(*) FROM share_link WHERE created_by_id = $1")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .map_err(|error| database_error(error, "Failed to count member share links"))
}

/// Whether `user_id` belongs to `team_id`. Guards cross-team lookups.
async fn is_team_member(pool: &PgPool, team_id: &str, user_id: &str) -> Result<bool, AppError> {
    query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM \"user\" WHERE id = $1 AND team_id = $2)")
        .bind(user_id)
        .bind(team_id)
        .fetch_one(pool)
        .await
        .map_err(|error| database_error(error, "Failed to verify team membership"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberAccessInput {
    pub user_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberVaultAccess {
    pub id: String,
    pub name: String,
    pub vault_type: VaultType,
    pub role: VaultRole,
    pub granted_at: String,
    pub item_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberDevice {
    pub id: String,
    pub device_name: Option<String>,
    pub platform: Option<String>,
    pub browser_name: Option<String>,
    pub os_name: Option<String>,
    pub masked_ip: Option<String>,
    pub created_at: String,
    pub last_active_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberShareLink {
    pub id: String,
    pub item_id: String,
    pub status: ShareLinkStatus,
    pub access_mode: ShareLinkAccessMode,
    pub access_count: u32,
    pub max_access_count: Option<u32>,
    pub expires_at: String,
    pub created_at: String,
    pub last_accessed_at: Option<String>,
    /// True when the link is still `active` but its expiry has already passed.
    pub is_expired: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberAccessResponse {
    pub vaults: Vec<MemberVaultAccess>,
    pub devices: Vec<MemberDevice>,
    pub share_links: Vec<MemberShareLink>,
    /// Total links created, which may exceed `share_links.len()` when capped.
    pub share_link_total: u32,
    /// Share links that are `active` and not past their expiry.
    pub active_share_link_count: u32,
}

/// The effective access footprint of one team member: what they can decrypt, what
/// they are signed in from, and what they have shared outward.
///
/// Returns an empty footprint rather than an error when the target is outside the
/// caller's team, so the console cannot be used to probe for user existence.
pub(crate) async fn get_member_access(
    pool: &sqlx::PgPool,
    caller_user_id: &str,
    deployment_mode: DeploymentMode,
    input: MemberAccessInput,
) -> Result<MemberAccessResponse, AppError> {
    let admin = authorize_team_admin(pool, caller_user_id, deployment_mode).await?;

    if !is_team_member(pool, &admin.team_id, &input.user_id).await? {
        return Ok(empty_access());
    }

    let now = OffsetDateTime::now_utc();
    let vaults = load_member_vaults(pool, &admin.team_id, &input.user_id).await?;
    let sessions = load_member_sessions(pool, &input.user_id).await?;
    let share_rows = load_member_share_links(pool, &input.user_id).await?;
    let share_link_total = count_member_share_links(pool, &input.user_id).await?;

    let share_links: Vec<MemberShareLink> = share_rows
        .into_iter()
        .map(|row| to_share_link(row, now))
        .collect();
    let active_share_link_count = share_links
        .iter()
        .filter(|link| link.status == ShareLinkStatus::Active && !link.is_expired)
        .count();

    Ok(MemberAccessResponse {
        vaults: vaults.into_iter().map(to_vault_access).collect(),
        devices: sessions.into_iter().map(to_device).collect(),
        share_links,
        share_link_total: to_count(share_link_total),
        active_share_link_count: to_count(active_share_link_count as i64),
    })
}

fn empty_access() -> MemberAccessResponse {
    MemberAccessResponse {
        vaults: Vec::new(),
        devices: Vec::new(),
        share_links: Vec::new(),
        share_link_total: 0,
        active_share_link_count: 0,
    }
}

fn to_vault_access(row: MemberVaultRow) -> MemberVaultAccess {
    MemberVaultAccess {
        id: row.id,
        name: row.name,
        vault_type: row.vault_type,
        role: row.role,
        granted_at: format_timestamp(row.granted_at),
        item_count: to_count(row.item_count),
    }
}

fn to_device(row: MemberSessionRow) -> MemberDevice {
    MemberDevice {
        id: row.id,
        device_name: row.device_name,
        platform: row.platform,
        browser_name: row.browser_name,
        os_name: row.os_name,
        masked_ip: mask_ip(row.ip_address.as_deref()),
        created_at: format_timestamp(row.created_at),
        last_active_at: format_timestamp(row.last_active_at),
        expires_at: format_timestamp(row.expires_at),
    }
}

fn to_share_link(row: MemberShareLinkRow, now: OffsetDateTime) -> MemberShareLink {
    MemberShareLink {
        id: row.id,
        item_id: row.item_id,
        is_expired: row.status == ShareLinkStatus::Active && row.expires_at <= now,
        status: row.status,
        access_mode: row.access_mode,
        access_count: to_count(row.access_count as i64),
        max_access_count: row.max_access_count.map(|value| to_count(value as i64)),
        expires_at: format_timestamp(row.expires_at),
        created_at: format_timestamp(row.created_at),
        last_accessed_at: row.last_accessed_at.map(format_timestamp),
    }
}

fn format_timestamp(value: OffsetDateTime) -> String {
    value.format(&Rfc3339).expect("timestamp should format")
}

fn to_count(value: i64) -> u32 {
    value.clamp(0, u32::MAX as i64) as u32
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
