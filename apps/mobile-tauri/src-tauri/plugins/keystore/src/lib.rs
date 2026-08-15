//! First-party Tauri plugin backing the mobile `secret` tier with the Android Keystore.
//!
//! It exists because every off-the-shelf option was worse:
//! `@choochmeque/tauri-plugin-biometry-api`'s `setData`/`getData` raises a biometric
//! prompt on **every read**, and `jwt_token` is read on every API request;
//! `impierce/tauri-plugin-keystore` is a single 18-month-stale alpha with no npm
//! package. `docs/mobile-migration-decisions.md` D4/D4a holds the long form.
//!
//! The Kotlin in `android/` holds one AES-256-GCM key in the `AndroidKeyStore`
//! provider **without** `setUserAuthenticationRequired`, which is the whole point: the
//! key never leaves the TEE, and reading a secret costs no prompt.
//!
//! Nothing here is load-bearing for the app's ability to *boot*. If the plugin is
//! missing, fails to register, or answers `available: false`, the storage adapter falls
//! back to `secrets.json` — exactly the behaviour that shipped in M1.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

mod commands;
mod error;
mod models;

#[cfg(not(target_os = "android"))]
mod desktop;
#[cfg(target_os = "android")]
mod mobile;

pub use error::{Error, Result};
pub use models::*;

#[cfg(not(target_os = "android"))]
use desktop::BitteryKeystore;
#[cfg(target_os = "android")]
use mobile::BitteryKeystore;

pub trait BitteryKeystoreExt<R: Runtime> {
    fn bittery_keystore(&self) -> &BitteryKeystore<R>;
}

impl<R: Runtime, T: Manager<R>> BitteryKeystoreExt<R> for T {
    fn bittery_keystore(&self) -> &BitteryKeystore<R> {
        self.state::<BitteryKeystore<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bittery-keystore")
        .invoke_handler(tauri::generate_handler![
            commands::secret_set,
            commands::secret_get,
            commands::secret_delete,
            commands::secret_available,
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let keystore = mobile::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let keystore = desktop::init(app, api)?;
            app.manage(keystore);
            Ok(())
        })
        .build()
}
