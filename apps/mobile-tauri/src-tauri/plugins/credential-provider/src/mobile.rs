use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

/// Must match the `@TauriPlugin` class's package in `android/`. Tauri resolves the
/// Kotlin class as `<identifier>.<class name>`.
#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "com.bittery.mobile.credentialprovider";

pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<CredentialProvider<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "CredentialProviderPlugin")?;
    #[cfg(target_os = "ios")]
    let handle = unimplemented!("the credential provider is Android-only for now");
    Ok(CredentialProvider(handle))
}

pub struct CredentialProvider<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> CredentialProvider<R> {
    pub fn is_supported(&self) -> crate::Result<ProviderSupport> {
        self.0
            .run_mobile_plugin("isSupported", ())
            .map_err(Into::into)
    }
}
