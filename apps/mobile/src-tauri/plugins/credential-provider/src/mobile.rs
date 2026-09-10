use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

/// Must match the `@TauriPlugin` class's package in `android/`. Tauri resolves the
/// Kotlin class as `<identifier>.<class name>`.
const PLUGIN_IDENTIFIER: &str = "com.bittery.mobile.credentialprovider";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<CredentialProvider<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "CredentialProviderPlugin")?;
    Ok(CredentialProvider(handle))
}

pub struct CredentialProvider<R: Runtime>(PluginHandle<R>);

/// Every call is one `run_mobile_plugin` into the Kotlin method of the same name in
/// camelCase, unwrapping the `{ "value": … }` envelope described on [`Wrapped`].
impl<R: Runtime> CredentialProvider<R> {
    fn call<T: DeserializeOwned, A: serde::Serialize>(
        &self,
        method: &str,
        args: A,
    ) -> crate::Result<T> {
        self.0
            .run_mobile_plugin::<Wrapped<T>>(method, args)
            .map(|wrapped| wrapped.value)
            .map_err(Into::into)
    }

    // ------------------------------------------------------------------
    // Vault state
    // ------------------------------------------------------------------

    pub fn set_master_unlock_key(&self, args: SetMasterUnlockKeyArgs) -> crate::Result<bool> {
        self.call("setMasterUnlockKey", args)
    }

    pub fn set_muk_auto_lock_timeout(
        &self,
        args: SetMukAutoLockTimeoutArgs,
    ) -> crate::Result<bool> {
        self.call("setMukAutoLockTimeout", args)
    }

    pub fn clear_master_unlock_key(&self, args: AccountIdArgs) -> crate::Result<bool> {
        self.call("clearMasterUnlockKey", args)
    }

    pub fn clear_all_master_unlock_keys(&self) -> crate::Result<bool> {
        self.call("clearAllMasterUnlockKeys", ())
    }

    pub fn is_vault_unlocked(&self, args: AccountIdArgs) -> crate::Result<bool> {
        self.call("isVaultUnlocked", args)
    }

    pub fn get_master_unlock_key_base64(&self, args: AccountIdArgs) -> crate::Result<Option<String>> {
        self.call("getMasterUnlockKeyBase64", args)
    }

    pub fn borrow_live_master_unlock_key_base64(
        &self,
        args: RequiredAccountIdArgs,
    ) -> crate::Result<Option<String>> {
        self.call("borrowLiveMasterUnlockKeyBase64", args)
    }

    // ------------------------------------------------------------------
    // MUK escrow
    // ------------------------------------------------------------------

    pub fn escrow_muk_with_biometric(&self, args: EscrowMukArgs) -> crate::Result<bool> {
        self.call("escrowMukWithBiometric", args)
    }

    pub fn retrieve_escrowed_muk(&self) -> crate::Result<bool> {
        self.call("retrieveEscrowedMuk", ())
    }

    pub fn has_valid_escrow(&self) -> crate::Result<bool> {
        self.call("hasValidEscrow", ())
    }

    pub fn has_valid_escrow_for_email(&self, args: EmailArgs) -> crate::Result<bool> {
        self.call("hasValidEscrowForEmail", args)
    }

    pub fn get_escrow_remaining_time(&self) -> crate::Result<i64> {
        self.call("getEscrowRemainingTime", ())
    }

    pub fn clear_escrow(&self) -> crate::Result<bool> {
        self.call("clearEscrow", ())
    }

    pub fn clear_escrow_for_account(&self, args: RequiredAccountIdArgs) -> crate::Result<bool> {
        self.call("clearEscrowForAccount", args)
    }

    // ------------------------------------------------------------------
    // Sync
    // ------------------------------------------------------------------

    pub fn sync_vault_data(&self, args: SyncVaultDataArgs) -> crate::Result<SyncVaultDataResult> {
        self.call("syncVaultData", args)
    }

    pub fn get_pending_passkey_mutations(
        &self,
        args: UserIdArgs,
    ) -> crate::Result<Vec<PendingPasskeyMutation>> {
        self.call("getPendingPasskeyMutations", args)
    }

    pub fn mark_pending_passkey_mutations_applied(&self, args: IdsArgs) -> crate::Result<bool> {
        self.call("markPendingPasskeyMutationsApplied", args)
    }

    pub fn mark_pending_passkey_mutations_failed(
        &self,
        args: IdsWithErrorArgs,
    ) -> crate::Result<bool> {
        self.call("markPendingPasskeyMutationsFailed", args)
    }

    // ------------------------------------------------------------------
    // 30-day master password re-entry
    // ------------------------------------------------------------------

    pub fn is_master_password_reentry_required(&self) -> crate::Result<bool> {
        self.call("isMasterPasswordReentryRequired", ())
    }

    pub fn can_use_biometric_unlock(&self) -> crate::Result<bool> {
        self.call("canUseBiometricUnlock", ())
    }

    pub fn update_last_master_password_entry(&self) -> crate::Result<bool> {
        self.call("updateLastMasterPasswordEntry", ())
    }

    pub fn get_last_master_password_entry(&self) -> crate::Result<i64> {
        self.call("getLastMasterPasswordEntry", ())
    }

    // ------------------------------------------------------------------
    // Capability
    // ------------------------------------------------------------------

    pub fn is_available(&self) -> crate::Result<bool> {
        self.call("isAvailable", ())
    }

    pub fn is_biometric_available(&self) -> crate::Result<bool> {
        self.call("isBiometricAvailable", ())
    }

    pub fn authenticate(&self, args: AuthenticateArgs) -> crate::Result<bool> {
        self.call("authenticate", args)
    }

    pub fn open_credential_provider_settings(&self) -> crate::Result<bool> {
        self.call("openCredentialProviderSettings", ())
    }

    /// The one command outside the `value` envelope — see [`Wrapped`].
    pub fn is_supported(&self) -> crate::Result<ProviderSupport> {
        self.0
            .run_mobile_plugin("isSupported", ())
            .map_err(Into::into)
    }
}
