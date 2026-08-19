//! Bittery's Android credential provider and autofill services, as a Tauri plugin.
//!
//! The Kotlin under `android/` is the port of
//! `apps/mobile/modules/credential-provider` — the `CredentialProviderService`, the
//! `AutofillService`, their activities, the Room database and the vault crypto. It is
//! reached by the *system*, through the intents declared in the module's own
//! `AndroidManifest.xml`, not through this Rust surface.
//!
//! What *is* here is the bridge the app drives: the 23 methods the Expo
//! `CredentialProviderModule` exposed to React Native — vault state, MUK escrow, vault
//! sync, the pending passkey mutation queue, the 30-day master password clock and the
//! capability probes — plus `is_supported`, the manifest-merge probe M2-C1 left behind.
//!
//! Crypto goes to the shared Rust core over UniFFI, per ADR 0001 — never
//! reimplemented in Kotlin and never routed back through the WebView.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod error;
mod models;

// Android or nothing. iOS deliberately takes the `desktop` path rather than a mobile
// one it has no implementation for: this plugin wraps `CredentialProviderService`, and
// an iOS build must still boot with autofill simply unavailable.
#[cfg(not(target_os = "android"))]
mod desktop;
#[cfg(target_os = "android")]
mod mobile;

pub use error::{Error, Result};
pub use models::*;

#[cfg(not(target_os = "android"))]
use desktop::CredentialProvider;
#[cfg(target_os = "android")]
use mobile::CredentialProvider;

pub trait CredentialProviderExt<R: Runtime> {
    fn credential_provider(&self) -> &CredentialProvider<R>;
}

impl<R: Runtime, T: Manager<R>> CredentialProviderExt<R> for T {
    fn credential_provider(&self) -> &CredentialProvider<R> {
        self.state::<CredentialProvider<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bittery-credential-provider")
        // Must stay in lockstep with `COMMANDS` in build.rs, which is what mints the
        // `allow-…`/`deny-…` permissions the ACL checks before any of this is reached.
        .invoke_handler(tauri::generate_handler![
            commands::set_master_unlock_key,
            commands::set_muk_auto_lock_timeout,
            commands::clear_master_unlock_key,
            commands::clear_all_master_unlock_keys,
            commands::is_vault_unlocked,
            commands::get_master_unlock_key_base64,
            commands::borrow_live_master_unlock_key_base64,
            commands::escrow_muk_with_biometric,
            commands::retrieve_escrowed_muk,
            commands::has_valid_escrow,
            commands::has_valid_escrow_for_email,
            commands::get_escrow_remaining_time,
            commands::clear_escrow,
            commands::clear_escrow_for_account,
            commands::sync_vault_data,
            commands::get_pending_passkey_mutations,
            commands::mark_pending_passkey_mutations_applied,
            commands::mark_pending_passkey_mutations_failed,
            commands::is_master_password_reentry_required,
            commands::can_use_biometric_unlock,
            commands::update_last_master_password_entry,
            commands::get_last_master_password_entry,
            commands::is_available,
            commands::is_biometric_available,
            commands::authenticate,
            commands::open_credential_provider_settings,
            commands::is_supported,
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let credential_provider = mobile::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let credential_provider = desktop::init(app, api)?;
            app.manage(credential_provider);
            Ok(())
        })
        .build()
}
