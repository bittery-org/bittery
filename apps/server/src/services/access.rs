use serde::{Deserialize, Serialize};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use crate::{
    db::enums::{ShareLinkAccessMode, ShareLinkStatus, VaultRole, VaultType},
    error::AppError,
    repo::access::{
        count_member_share_links, is_team_member, load_member_sessions, load_member_share_links,
        load_member_vaults, MemberSessionRow, MemberShareLinkRow, MemberVaultRow,
    },
    services::{audit::mask_ip, team_admin::authorize_team_admin},
};

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
    input: MemberAccessInput,
) -> Result<MemberAccessResponse, AppError> {
    let admin = authorize_team_admin(pool, caller_user_id).await?;

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
