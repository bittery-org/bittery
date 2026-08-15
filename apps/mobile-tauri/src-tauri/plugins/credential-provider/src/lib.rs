//! Bittery's Android credential provider and autofill services, as a Tauri plugin.
//!
//! The Kotlin under `android/` is the port of
//! `apps/mobile/modules/credential-provider` — the `CredentialProviderService`, the
//! `AutofillService`, their activities, the Room database and the vault crypto. It is
//! reached by the *system*, through the intents declared in the module's own
//! `AndroidManifest.xml`, not through this Rust surface.
//!
//! So the command list is short on purpose. Right now it is one probe, enough to
//! register the plugin and confirm from inside the app that the manifest merge landed.
//! The commands that replace the Expo module bridge come next.
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

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

pub use error::{Error, Result};
pub use models::*;

#[cfg(desktop)]
use desktop::CredentialProvider;
#[cfg(mobile)]
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
        .invoke_handler(tauri::generate_handler![commands::is_supported])
        .setup(|app, api| {
            #[cfg(mobile)]
            let credential_provider = mobile::init(app, api)?;
            #[cfg(desktop)]
            let credential_provider = desktop::init(app, api)?;
            app.manage(credential_provider);
            Ok(())
        })
        .build()
}
