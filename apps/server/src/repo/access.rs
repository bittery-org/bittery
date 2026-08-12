use sqlx::{query_as, query_scalar, PgPool};
use time::OffsetDateTime;

use crate::{
    db::enums::{ShareLinkAccessMode, ShareLinkStatus, VaultRole, VaultType},
    error::AppError,
};

/// Newest-first caps. The console shows a member's footprint, not an archive.
const MAX_SHARE_LINKS: i64 = 100;
const MAX_SESSIONS: i64 = 50;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MemberVaultRow {
    pub id: String,
    pub name: String,
    pub vault_type: VaultType,
    pub role: VaultRole,
    pub granted_at: OffsetDateTime,
    pub item_count: i64,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MemberSessionRow {
    pub id: String,
    pub device_name: Option<String>,
    pub platform: Option<String>,
    pub browser_name: Option<String>,
    pub os_name: Option<String>,
    pub ip_address: Option<String>,
    pub created_at: OffsetDateTime,
    pub last_active_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MemberShareLinkRow {
    pub id: String,
    pub item_id: String,
    pub status: ShareLinkStatus,
    pub access_mode: ShareLinkAccessMode,
    pub access_count: i32,
    pub max_access_count: Option<i32>,
    pub expires_at: OffsetDateTime,
    pub created_at: OffsetDateTime,
    pub last_accessed_at: Option<OffsetDateTime>,
}

/// Team vaults the member can decrypt, i.e. the vaults they hold a wrapped key for.
///
/// Scoped to `team_id`: a member's personal vaults are deliberately invisible to admins.
pub async fn load_member_vaults(
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
    .map_err(|error| {
        tracing::error!(error = %error, "Failed to load member vaults");
        AppError::internal("Failed to load member vaults")
    })
}

/// Unexpired sessions for the member. Sessions double as devices in this schema.
pub async fn load_member_sessions(
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
    .map_err(|error| {
        tracing::error!(error = %error, "Failed to load member sessions");
        AppError::internal("Failed to load member sessions")
    })
}

/// Share links the member created, newest first, capped at [`MAX_SHARE_LINKS`].
pub async fn load_member_share_links(
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
    .map_err(|error| {
        tracing::error!(error = %error, "Failed to load member share links");
        AppError::internal("Failed to load member share links")
    })
}

/// Total share links created by the member, so the UI can say when its list is capped.
pub async fn count_member_share_links(pool: &PgPool, user_id: &str) -> Result<i64, AppError> {
    query_scalar::<_, i64>("SELECT COUNT(*) FROM share_link WHERE created_by_id = $1")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to count member share links");
            AppError::internal("Failed to count member share links")
        })
}

/// Whether `user_id` belongs to `team_id`. Guards cross-team lookups.
pub async fn is_team_member(pool: &PgPool, team_id: &str, user_id: &str) -> Result<bool, AppError> {
    query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM \"user\" WHERE id = $1 AND team_id = $2)")
        .bind(user_id)
        .bind(team_id)
        .fetch_one(pool)
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "Failed to verify team membership");
            AppError::internal("Failed to verify team membership")
        })
}
