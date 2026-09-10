use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

/// Everything that is not Android — the host `cargo check`/`clippy` target, and iOS.
///
/// A plugin that failed to register would take the whole app down with it, so this
/// exists purely to keep the app booting; `share_text` answers `Unsupported`.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<BitteryShare<R>> {
    Ok(BitteryShare(std::marker::PhantomData))
}

// `PhantomData<fn() -> R>` rather than `PhantomData<R>`: managed state must be
// `Send + Sync`, and a function pointer is unconditionally both.
pub struct BitteryShare<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> BitteryShare<R> {
    pub fn share_text(&self, _args: ShareTextArgs) -> crate::Result<()> {
        Err(crate::Error::Unsupported)
    }

    pub fn share_file(&self, _args: ShareFileArgs) -> crate::Result<()> {
        Err(crate::Error::Unsupported)
    }
}
