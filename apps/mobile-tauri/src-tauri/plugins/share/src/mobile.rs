use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

/// Must match the `@TauriPlugin` class's package in `android/`. Tauri resolves the
/// Kotlin class as `<identifier>.<class name>`.
const PLUGIN_IDENTIFIER: &str = "com.bittery.mobile.share";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<BitteryShare<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "SharePlugin")?;
    Ok(BitteryShare(handle))
}

pub struct BitteryShare<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> BitteryShare<R> {
    pub fn share_text(&self, args: ShareTextArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("shareText", args)
            .map_err(Into::into)
    }

    pub fn share_file(&self, args: ShareFileArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("shareFile", args)
            .map_err(Into::into)
    }
}
