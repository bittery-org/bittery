use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

/// Desktop exists only so `cargo check` and `cargo clippy` on the host compile.
/// Nothing here can work: `CredentialProviderService` is an Android system service.
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
    pub fn is_supported(&self) -> crate::Result<ProviderSupport> {
        Err(crate::Error::Unsupported)
    }
}
