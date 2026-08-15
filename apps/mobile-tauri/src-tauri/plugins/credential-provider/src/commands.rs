//! The command surface, one entry per method the Expo module exposed.
//!
//! Command names are snake_case here (they are the ACL identity — see `build.rs`) and
//! camelCase on the Kotlin side, the same split the keystore plugin uses. Parameters
//! arrive from JavaScript in camelCase; Tauri maps them onto these snake_case arguments.

use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::CredentialProviderExt;

// ----------------------------------------------------------------------
// Vault state
// ----------------------------------------------------------------------

#[command]
pub(crate) fn set_master_unlock_key<R: Runtime>(
    app: AppHandle<R>,
    muk_base64: String,
    user_id: Option<String>,
    auto_lock_timeout_ms: Option<f64>,
) -> crate::Result<bool> {
    app.credential_provider()
        .set_master_unlock_key(SetMasterUnlockKeyArgs {
            muk_base64,
            user_id,
            auto_lock_timeout_ms,
        })
}

#[command]
pub(crate) fn set_muk_auto_lock_timeout<R: Runtime>(
    app: AppHandle<R>,
    timeout_ms: f64,
    user_id: Option<String>,
) -> crate::Result<bool> {
    app.credential_provider()
        .set_muk_auto_lock_timeout(SetMukAutoLockTimeoutArgs {
            timeout_ms,
            user_id,
        })
}

#[command]
pub(crate) fn clear_master_unlock_key<R: Runtime>(
    app: AppHandle<R>,
    user_id: Option<String>,
) -> crate::Result<bool> {
    app.credential_provider()
        .clear_master_unlock_key(UserIdArgs { user_id })
}

#[command]
pub(crate) fn clear_all_master_unlock_keys<R: Runtime>(app: AppHandle<R>) -> crate::Result<bool> {
    app.credential_provider().clear_all_master_unlock_keys()
}

#[command]
pub(crate) fn is_vault_unlocked<R: Runtime>(
    app: AppHandle<R>,
    user_id: Option<String>,
) -> crate::Result<bool> {
    app.credential_provider()
        .is_vault_unlocked(UserIdArgs { user_id })
}

#[command]
pub(crate) fn get_master_unlock_key_base64<R: Runtime>(
    app: AppHandle<R>,
    user_id: Option<String>,
) -> crate::Result<Option<String>> {
    app.credential_provider()
        .get_master_unlock_key_base64(UserIdArgs { user_id })
}

// ----------------------------------------------------------------------
// MUK escrow
// ----------------------------------------------------------------------

#[command]
pub(crate) fn escrow_muk_with_biometric<R: Runtime>(
    app: AppHandle<R>,
    email: String,
    user_id: Option<String>,
    timeout_ms: Option<f64>,
) -> crate::Result<bool> {
    app.credential_provider()
        .escrow_muk_with_biometric(EscrowMukArgs {
            email,
            user_id,
            timeout_ms,
        })
}

#[command]
pub(crate) fn retrieve_escrowed_muk<R: Runtime>(app: AppHandle<R>) -> crate::Result<bool> {
    app.credential_provider().retrieve_escrowed_muk()
}

#[command]
pub(crate) fn has_valid_escrow<R: Runtime>(app: AppHandle<R>) -> crate::Result<bool> {
    app.credential_provider().has_valid_escrow()
}

#[command]
pub(crate) fn has_valid_escrow_for_email<R: Runtime>(
    app: AppHandle<R>,
    email: String,
) -> crate::Result<bool> {
    app.credential_provider()
        .has_valid_escrow_for_email(EmailArgs { email })
}

#[command]
pub(crate) fn get_escrow_remaining_time<R: Runtime>(app: AppHandle<R>) -> crate::Result<i64> {
    app.credential_provider().get_escrow_remaining_time()
}

#[command]
pub(crate) fn clear_escrow<R: Runtime>(app: AppHandle<R>) -> crate::Result<bool> {
    app.credential_provider().clear_escrow()
}

// ----------------------------------------------------------------------
// Sync
// ----------------------------------------------------------------------

#[command]
pub(crate) fn sync_vault_data<R: Runtime>(
    app: AppHandle<R>,
    data_json: String,
) -> crate::Result<SyncVaultDataResult> {
    app.credential_provider()
        .sync_vault_data(SyncVaultDataArgs { data_json })
}

#[command]
pub(crate) fn get_pending_passkey_mutations<R: Runtime>(
    app: AppHandle<R>,
    user_id: Option<String>,
) -> crate::Result<Vec<PendingPasskeyMutation>> {
    app.credential_provider()
        .get_pending_passkey_mutations(UserIdArgs { user_id })
}

#[command]
pub(crate) fn mark_pending_passkey_mutations_applied<R: Runtime>(
    app: AppHandle<R>,
    ids: Vec<String>,
) -> crate::Result<bool> {
    app.credential_provider()
        .mark_pending_passkey_mutations_applied(IdsArgs { ids })
}

#[command]
pub(crate) fn mark_pending_passkey_mutations_failed<R: Runtime>(
    app: AppHandle<R>,
    ids: Vec<String>,
    error: String,
) -> crate::Result<bool> {
    app.credential_provider()
        .mark_pending_passkey_mutations_failed(IdsWithErrorArgs { ids, error })
}

// ----------------------------------------------------------------------
// 30-day master password re-entry
// ----------------------------------------------------------------------

#[command]
pub(crate) fn is_master_password_reentry_required<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<bool> {
    app.credential_provider()
        .is_master_password_reentry_required()
}

#[command]
pub(crate) fn can_use_biometric_unlock<R: Runtime>(app: AppHandle<R>) -> crate::Result<bool> {
    app.credential_provider().can_use_biometric_unlock()
}

#[command]
pub(crate) fn update_last_master_password_entry<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<bool> {
    app.credential_provider()
        .update_last_master_password_entry()
}

#[command]
pub(crate) fn get_last_master_password_entry<R: Runtime>(app: AppHandle<R>) -> crate::Result<i64> {
    app.credential_provider().get_last_master_password_entry()
}

// ----------------------------------------------------------------------
// Capability
// ----------------------------------------------------------------------

#[command]
pub(crate) fn is_available<R: Runtime>(app: AppHandle<R>) -> crate::Result<bool> {
    app.credential_provider().is_available()
}

#[command]
pub(crate) fn is_biometric_available<R: Runtime>(app: AppHandle<R>) -> crate::Result<bool> {
    app.credential_provider().is_biometric_available()
}

#[command]
pub(crate) fn open_credential_provider_settings<R: Runtime>(
    app: AppHandle<R>,
) -> crate::Result<bool> {
    app.credential_provider()
        .open_credential_provider_settings()
}

#[command]
pub(crate) fn is_supported<R: Runtime>(app: AppHandle<R>) -> crate::Result<ProviderSupport> {
    app.credential_provider().is_supported()
}
