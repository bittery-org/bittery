//! First-party Tauri plugin wrapping Android's `ACTION_SEND` share sheet.
//!
//! It exists because none of the off-the-shelf options fit: `tauri-plugin-opener`
//! opens a URL/path with its default handler (`xdg-open`/`start`), which is a
//! different action from Android's cross-app share chooser; `tauri-plugin-share`
//! (crates.io, single-maintainer) only wraps `shareFile`, not the text/URL share this
//! app needs — `apps/mobile`'s `ShareItemSheet` calls React Native's
//! `Share.share({ message: url, title })`, which is `ACTION_SEND` with `text/plain`.
//! Wrapping that intent directly is a dozen lines of Kotlin, so it is first-party,
//! following the same pattern as `plugins/keystore`.
//!
//! Fire-and-forget: `ACTION_SEND` hands off to `Intent.createChooser` and returns
//! immediately. Android gives no reliable "the user picked X and it completed" signal
//! back to the caller, so `share_text` resolves once the chooser is shown, not once
//! something is done with it — the same contract React Native's `Share.share` had in
//! practice, since its `dismissedAction`/`sharedAction` result is unreliable across
//! target apps.

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
use desktop::BitteryShare;
#[cfg(target_os = "android")]
use mobile::BitteryShare;

pub trait BitteryShareExt<R: Runtime> {
    fn bittery_share(&self) -> &BitteryShare<R>;
}

impl<R: Runtime, T: Manager<R>> BitteryShareExt<R> for T {
    fn bittery_share(&self) -> &BitteryShare<R> {
        self.state::<BitteryShare<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("bittery-share")
        .invoke_handler(tauri::generate_handler![commands::share_text])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let share = mobile::init(app, api)?;
            #[cfg(not(target_os = "android"))]
            let share = desktop::init(app, api)?;
            app.manage(share);
            Ok(())
        })
        .build()
}
