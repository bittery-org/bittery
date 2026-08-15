use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

/// Must match the `@TauriPlugin` class's package in `android/`. Tauri resolves the
/// Kotlin class as `<identifier>.<class name>`.
const PLUGIN_IDENTIFIER: &str = "com.bittery.mobile.keystore";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<BitteryKeystore<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "KeystorePlugin")?;
    Ok(BitteryKeystore(handle))
}

pub struct BitteryKeystore<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> BitteryKeystore<R> {
    pub fn secret_set(&self, args: SetArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("secretSet", args)
            .map_err(Into::into)
    }

    pub fn secret_get(&self, args: KeyArgs) -> crate::Result<SecretValue> {
        self.0
            .run_mobile_plugin("secretGet", args)
            .map_err(Into::into)
    }

    pub fn secret_delete(&self, args: KeyArgs) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("secretDelete", args)
            .map_err(Into::into)
    }

    pub fn secret_available(&self) -> crate::Result<SecretAvailability> {
        self.0
            .run_mobile_plugin("secretAvailable", ())
            .map_err(Into::into)
    }
}
