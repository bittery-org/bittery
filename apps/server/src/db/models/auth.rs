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
    pub kdf_algorithm: String,
    pub kdf_iterations: i32,
    pub kdf_schema_version: i32,
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
