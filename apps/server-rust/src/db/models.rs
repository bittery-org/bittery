use sqlx::FromRow;
use time::OffsetDateTime;

#[derive(Clone, Debug, FromRow)]
pub struct DbSessionRecord {
	pub id: String,
	pub expires_at: OffsetDateTime,
	pub created_at: OffsetDateTime,
	pub last_active_at: OffsetDateTime,
	pub user_id: String,
	pub ip_address: Option<String>,
	pub user_agent: Option<String>,
	pub device_name: Option<String>,
	pub platform: Option<String>,
	pub client_id: Option<String>,
	pub device_info: Option<String>,
	pub browser_name: Option<String>,
	pub browser_version: Option<String>,
	pub os_name: Option<String>,
	pub os_version: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSignupVerificationRow {
	pub id: String,
	pub email: String,
	pub invitation_token: Option<String>,
	pub code: String,
	pub attempts: i32,
	pub max_attempts: i32,
	pub expires_at: OffsetDateTime,
	pub used_at: Option<OffsetDateTime>,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSignupInvitationRow {
	pub id: String,
	pub team_id: String,
	pub team_name: String,
	pub team_type: String,
	pub team_image_key: Option<String>,
	pub email: String,
	pub role: String,
	pub invited_by_id: String,
	pub expires_at: OffsetDateTime,
	pub member_limit: Option<i32>,
	pub billing_plan: String,
	pub billing_status: String,
	pub pending_vault_keys: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbAuthVaultKeyRow {
	pub vault_id: String,
	pub vault_name: String,
	pub vault_type: String,
	pub vault_icon: Option<String>,
	pub vault_image_key: Option<String>,
	pub encrypted_vault_key: String,
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbLoginAttemptRow {
	pub id: String,
	pub user_id: Option<String>,
	pub normalized_email_hash: String,
	pub client_public_key: String,
	pub server_ephemeral_secret: String,
	pub expires_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbLoginUserRow {
	pub id: String,
	pub email: String,
	pub name: String,
	pub secret_key_hint: Option<String>,
	pub srp_salt: String,
	pub srp_verifier: String,
	pub public_key: String,
	pub encrypted_private_key: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbRecoveryVerificationRow {
	pub id: String,
	pub email: String,
	pub code: String,
	pub attempts: i32,
	pub max_attempts: i32,
	pub expires_at: OffsetDateTime,
	pub used_at: Option<OffsetDateTime>,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbRecoveryUserDataRow {
	pub id: String,
	pub encrypted_master_key: Option<String>,
	pub encrypted_private_key: String,
	pub secret_key_hint: Option<String>,
	pub recovery_key_hint: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbRecoveryVaultKeyRow {
	pub vault_id: String,
	pub encrypted_vault_key: String,
	pub created_by_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTombstoneCandidate {
	pub id: String,
	pub vault_id: String,
	pub last_modified_by: Option<String>,
	pub version: Option<i32>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultOwnerRow {
	pub id: String,
	pub created_by_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbPendingAttachmentUploadRow {
	pub id: String,
	pub storage_key: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbBillingActorRow {
	pub user_id: String,
	pub team_id: Option<String>,
	pub role: String,
	pub email: String,
	pub name: String,
	pub owner_id: Option<String>,
	pub billing_plan: Option<String>,
	pub billing_status: Option<String>,
	pub stripe_customer_id: Option<String>,
	pub stripe_subscription_id: Option<String>,
	pub stripe_subscription_item_id: Option<String>,
	pub stripe_price_id: Option<String>,
	pub current_period_end: Option<OffsetDateTime>,
	pub cancel_at_period_end: Option<bool>,
	pub seats_purchased: Option<i32>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbBillingContactRow {
	pub id: String,
	pub email: String,
	pub name: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbScopedItemAccessRow {
	pub item_id: String,
	pub vault_id: String,
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbShareLinkRow {
	pub id: String,
	pub item_id: String,
	pub created_by_id: String,
	pub token: String,
	pub status: String,
	pub access_mode: String,
	pub is_one_time_use: bool,
	pub access_count: i32,
	pub max_access_count: Option<i32>,
	pub expires_at: OffsetDateTime,
	pub created_at: OffsetDateTime,
	pub last_accessed_at: Option<OffsetDateTime>,
	pub vault_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbShareLinkAllowedEmailRow {
	pub id: String,
	pub share_link_id: String,
	pub email: String,
	pub verified: bool,
	pub verified_at: Option<OffsetDateTime>,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbShareLinkAllowedEmailDeleteRow {
	pub id: String,
	pub email: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbShareAccessLogRow {
	pub id: String,
	pub accessed_by_email: Option<String>,
	pub ip_address: Option<String>,
	pub user_agent: Option<String>,
	pub success: bool,
	pub failure_reason: Option<String>,
	pub accessed_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamBillingEntitlementRow {
	pub team_id: Option<String>,
	pub billing_plan: Option<String>,
	pub billing_status: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamInvitationDetailsRow {
	pub id: String,
	pub email: String,
	pub team_id: String,
	pub team_name: String,
	pub role: String,
	pub status: String,
	pub invited_by_name: String,
	pub expires_at: OffsetDateTime,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbPendingTeamInvitationRow {
	pub id: String,
	pub token: String,
	pub team_id: String,
	pub team_name: String,
	pub role: String,
	pub invited_by_name: String,
	pub expires_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamInvitationAcceptRow {
	pub id: String,
	pub team_id: String,
	pub team_name: String,
	pub email: String,
	pub role: String,
	pub invited_by_id: String,
	pub expires_at: OffsetDateTime,
	pub billing_plan: String,
	pub billing_status: String,
	pub pending_vault_keys: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamUserRow {
	pub id: String,
	pub email: String,
	pub team_id: Option<String>,
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultRoleRow {
	pub vault_id: String,
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamMembershipActorRow {
	pub id: String,
	pub team_id: Option<String>,
	pub role: String,
	pub billing_plan: Option<String>,
	pub billing_status: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamInvitationListRow {
	pub id: String,
	pub email: String,
	pub role: String,
	pub status: String,
	pub invited_by_name: String,
	pub created_at: OffsetDateTime,
	pub expires_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbManageTeamInvitationRow {
	pub id: String,
	pub team_id: String,
	pub billing_plan: String,
	pub billing_status: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamInvitationSendTeamRow {
	pub id: String,
	pub member_limit: Option<i32>,
	pub billing_plan: String,
	pub billing_status: String,
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
	pub team_type: String,
	pub owner_id: String,
	pub role: String,
	pub member_count: i64,
	pub member_limit: Option<i32>,
	pub image_key: Option<String>,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbTeamDetailsRow {
	pub id: String,
	pub name: String,
	pub team_type: String,
	pub owner_id: String,
	pub owner_name: String,
	pub user_role: String,
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
	pub role: String,
	pub joined_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbDeleteTeamActorRow {
	pub user_id: String,
	pub user_name: String,
	pub team_id: String,
	pub role: String,
	pub team_type: String,
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
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbRotationItemRow {
	pub id: String,
	pub encrypted_data: String,
	pub encryption_iv: String,
	pub encryption_algorithm: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncConflictRow {
	pub version: i32,
	pub user_id: String,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncEventVaultRow {
	pub id: String,
	pub vault_id: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultAccessRow {
	pub vault_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbLastAcknowledgedRow {
	pub event_id: String,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncStateEventRow {
	pub id: String,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncEventCursorRow {
	pub id: String,
	pub seq: i64,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncEventIdRow {
	pub id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbSyncEventRow {
	pub id: String,
	pub seq: i64,
	pub event_type: String,
	pub entity_id: String,
	pub entity_type: String,
	pub vault_id: Option<String>,
	pub version: i32,
	pub client_id: Option<String>,
	pub user_id: String,
	pub metadata: Option<String>,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbBootstrapVaultAccessRow {
	pub vault_id: String,
	pub vault_name: String,
	pub vault_type: String,
	pub vault_icon: Option<String>,
	pub vault_image_key: Option<String>,
	pub encrypted_vault_key: String,
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbBootstrapItemRow {
	pub id: String,
	pub vault_id: String,
	pub category: String,
	pub favorite: bool,
	pub encrypted_data: String,
	pub encryption_iv: String,
	pub encryption_algorithm: String,
	pub version: i32,
	pub last_modified_by: Option<String>,
	pub created_at: OffsetDateTime,
	pub updated_at: OffsetDateTime,
	pub deleted_at: Option<OffsetDateTime>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbBootstrapAttachmentRow {
	pub id: String,
	pub item_id: String,
	pub vault_id: String,
	pub storage_key: String,
	pub encrypted_name: String,
	pub encrypted_content_type: String,
	pub encryption_iv: String,
	pub encrypted_content_type_iv: Option<String>,
	pub encryption_algorithm: String,
	pub file_size: i32,
	pub uploaded_by: Option<String>,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbPendingAttachmentReservationRow {
	pub id: String,
	pub file_size: i32,
	pub storage_size: i32,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbScopedAttachmentAccessRow {
	pub id: String,
	pub item_id: String,
	pub vault_id: String,
	pub storage_key: String,
	pub encrypted_name: String,
	pub encrypted_content_type: String,
	pub encryption_iv: String,
	pub encrypted_content_type_iv: Option<String>,
	pub encryption_algorithm: String,
	pub file_size: i32,
	pub uploaded_by: Option<String>,
	pub created_at: OffsetDateTime,
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultListRow {
	pub id: String,
	pub name: String,
	pub vault_type: String,
	pub icon: Option<String>,
	pub image_key: Option<String>,
	pub role: String,
	pub encrypted_vault_key: String,
	pub created_by_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultGetRow {
	pub id: String,
	pub name: String,
	pub vault_type: String,
	pub icon: Option<String>,
	pub image_key: Option<String>,
	pub user_role: String,
	pub item_count: i64,
	pub member_count: i64,
	pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbManagedVaultRow {
	pub id: String,
	pub name: String,
	pub icon: Option<String>,
	pub image_key: Option<String>,
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultOwnerAccessRow {
	pub vault_id: String,
	pub vault_type: String,
	pub team_id: Option<String>,
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultDeleteRow {
	pub id: String,
	pub name: String,
	pub vault_type: String,
	pub image_key: Option<String>,
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultMemberAccessRow {
	pub user_id: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultAvailableMemberRow {
	pub user_id: String,
	pub name: String,
	pub email: String,
	pub public_key: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbVaultLookupUserRow {
	pub id: String,
	pub name: String,
	pub email: String,
	pub public_key: String,
	pub team_id: Option<String>,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbItemVaultAccessRow {
	pub role: String,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbPublicShareLinkRow {
	pub id: String,
	pub created_by_id: String,
	pub token: String,
	pub status: String,
	pub access_mode: String,
	pub is_one_time_use: bool,
	pub encrypted_item_data: String,
	pub encryption_iv: String,
	pub encrypted_share_key: String,
	pub share_key_iv: String,
	pub access_count: i32,
	pub max_access_count: Option<i32>,
	pub expires_at: OffsetDateTime,
}

#[derive(Clone, Debug, FromRow)]
pub struct DbShareEmailVerificationRow {
	pub id: String,
	pub share_link_id: String,
	pub email: String,
	pub code: String,
	pub attempts: i32,
	pub max_attempts: i32,
	pub expires_at: OffsetDateTime,
	pub created_at: OffsetDateTime,
	pub used_at: Option<OffsetDateTime>,
}