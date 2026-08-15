use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

/// Everything that is not Android — the host `cargo check`/`clippy` target, and iOS.
///
/// Nothing here can work: `CredentialProviderService`, `AutofillService` and the Room
/// database this plugin wraps are Android. So every command answers
/// [`crate::Error::Unsupported`] rather than panicking or inventing a result. iOS lands
/// here on purpose — the app must still boot with autofill simply unavailable, and a
/// plugin that failed to register (or an `unimplemented!()`) would take the whole app
/// down with it. `credential-provider.ts` turns each rejection into a stated
/// "unsupported", so the guest never sees a throw either.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<CredentialProvider<R>> {
    Ok(CredentialProvider(std::marker::PhantomData))
}

// `PhantomData<fn() -> R>` rather than `PhantomData<R>`: managed state must be
// `Send + Sync`, and a function pointer is unconditionally both.
pub struct CredentialProvider<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> CredentialProvider<R> {
    // ------------------------------------------------------------------
    // Vault state
    // ------------------------------------------------------------------

    pub fn set_master_unlock_key(&self, _args: SetMasterUnlockKeyArgs) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn set_muk_auto_lock_timeout(
        &self,
        _args: SetMukAutoLockTimeoutArgs,
    ) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn clear_master_unlock_key(&self, _args: UserIdArgs) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn clear_all_master_unlock_keys(&self) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn is_vault_unlocked(&self, _args: UserIdArgs) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn get_master_unlock_key_base64(&self, _args: UserIdArgs) -> crate::Result<Option<String>> {
        Err(crate::Error::Unsupported)
    }

    // ------------------------------------------------------------------
    // MUK escrow
    // ------------------------------------------------------------------

    pub fn escrow_muk_with_biometric(&self, _args: EscrowMukArgs) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn retrieve_escrowed_muk(&self) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn has_valid_escrow(&self) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn has_valid_escrow_for_email(&self, _args: EmailArgs) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn get_escrow_remaining_time(&self) -> crate::Result<i64> {
        Err(crate::Error::Unsupported)
    }

    pub fn clear_escrow(&self) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    // ------------------------------------------------------------------
    // Sync
    // ------------------------------------------------------------------

    pub fn sync_vault_data(&self, _args: SyncVaultDataArgs) -> crate::Result<SyncVaultDataResult> {
        Err(crate::Error::Unsupported)
    }

    pub fn get_pending_passkey_mutations(
        &self,
        _args: UserIdArgs,
    ) -> crate::Result<Vec<PendingPasskeyMutation>> {
        Err(crate::Error::Unsupported)
    }

    pub fn mark_pending_passkey_mutations_applied(&self, _args: IdsArgs) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn mark_pending_passkey_mutations_failed(
        &self,
        _args: IdsWithErrorArgs,
    ) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    // ------------------------------------------------------------------
    // 30-day master password re-entry
    // ------------------------------------------------------------------

    pub fn is_master_password_reentry_required(&self) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn can_use_biometric_unlock(&self) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn update_last_master_password_entry(&self) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn get_last_master_password_entry(&self) -> crate::Result<i64> {
        Err(crate::Error::Unsupported)
    }

    // ------------------------------------------------------------------
    // Capability
    // ------------------------------------------------------------------

    pub fn is_available(&self) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn is_biometric_available(&self) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn open_credential_provider_settings(&self) -> crate::Result<bool> {
        Err(crate::Error::Unsupported)
    }

    pub fn is_supported(&self) -> crate::Result<ProviderSupport> {
        Err(crate::Error::Unsupported)
    }
}
