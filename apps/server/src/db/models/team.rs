use sqlx::FromRow;
use time::OffsetDateTime;

use crate::db::enums::{
    BillingPlan, BillingStatus, InvitationStatus, TeamRole, TeamType, VaultRole,
};

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamInvitationDetailsRow {
    pub id: String,
    pub email: String,
    pub team_id: String,
    pub team_name: String,
    pub role: TeamRole,
    pub status: InvitationStatus,
    pub invited_by_name: String,
    pub expires_at: OffsetDateTime,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbPendingTeamInvitationRow {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub role: TeamRole,
    pub invited_by_name: String,
    pub expires_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamInvitationAcceptRow {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    pub email: String,
    pub role: TeamRole,
    pub invited_by_id: String,
    pub expires_at: OffsetDateTime,
    pub billing_plan: BillingPlan,
    pub billing_status: BillingStatus,
    pub pending_vault_keys: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamUserRow {
    pub id: String,
    pub email: String,
    pub team_id: Option<String>,
    pub role: TeamRole,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultRoleRow {
    pub vault_id: String,
    pub role: VaultRole,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamInvitationListRow {
    pub id: String,
    pub email: String,
    pub role: TeamRole,
    pub status: InvitationStatus,
    pub invited_by_name: String,
    pub created_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbManageTeamInvitationRow {
    pub id: String,
    pub team_id: String,
    pub billing_plan: BillingPlan,
    pub billing_status: BillingStatus,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamInvitationSendTeamRow {
    pub id: String,
    pub member_limit: Option<i32>,
    pub billing_plan: BillingPlan,
    pub billing_status: BillingStatus,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbExistingInviteeRow {
    pub team_id: Option<String>,
    pub public_key: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamSummaryRow {
    pub id: String,
    pub name: String,
    pub team_type: TeamType,
    pub owner_id: String,
    pub role: TeamRole,
    pub member_count: i64,
    pub member_limit: Option<i32>,
    pub image_key: Option<String>,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamDetailsRow {
    pub id: String,
    pub name: String,
    pub team_type: TeamType,
    pub owner_id: String,
    pub owner_name: String,
    pub user_role: TeamRole,
    pub member_count: i64,
    pub member_limit: Option<i32>,
    pub image_key: Option<String>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamVaultRow {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbUserVaultKeyRow {
    pub vault_id: String,
    pub encrypted_vault_key: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamMemberRow {
    pub user_id: String,
    pub name: String,
    pub email: String,
    pub role: TeamRole,
    pub joined_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbDeleteTeamActorRow {
    pub user_id: String,
    pub user_name: String,
    pub team_id: String,
    pub role: TeamRole,
    pub team_type: TeamType,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamRotationVaultRow {
    pub id: String,
    pub name: String,
    pub key_version: i32,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbRotationMemberRow {
    pub user_id: String,
    pub public_key: String,
    pub role: VaultRole,
}

/// Column list for `item` SELECTs that populate `DbRotationItemRow`.
/// Must stay in sync with that struct's field order.
pub(crate) const ROTATION_ITEM_COLUMNS: &str = "id, encrypted_data, encryption_iv, encryption_algorithm, version, encryption_version, encrypted_by_user_id, last_modified_by";

#[derive(Clone, Debug, FromRow)]
pub struct DbRotationItemRow {
    pub id: String,
    pub encrypted_data: String,
    pub encryption_iv: String,
    pub encryption_algorithm: String,
    pub version: i32,
    pub encryption_version: i32,
    pub encrypted_by_user_id: String,
    pub last_modified_by: String,
}
