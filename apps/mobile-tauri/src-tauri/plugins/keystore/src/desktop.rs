use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

/// Everything that is not Android — the host `cargo check`/`clippy` target, and iOS.
///
/// iOS lands here on purpose. This plugin wraps the *Android* Keystore; an iOS build
/// must still boot, so `secret_available` answers `false` and the storage adapter keeps
/// using `secrets.json` exactly as it does today. A plugin that failed to register would
/// take the whole app down with it.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<BitteryKeystore<R>> {
    Ok(BitteryKeystore(std::marker::PhantomData))
}

// `PhantomData<fn() -> R>` rather than `PhantomData<R>`: managed state must be
// `Send + Sync`, and a function pointer is unconditionally both.
pub struct BitteryKeystore<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> BitteryKeystore<R> {
    pub fn secret_set(&self, _args: SetArgs) -> crate::Result<()> {
        Err(crate::Error::Unsupported)
    }

    pub fn secret_get(&self, _args: KeyArgs) -> crate::Result<SecretValue> {
        Err(crate::Error::Unsupported)
    }

    pub fn secret_delete(&self, _args: KeyArgs) -> crate::Result<()> {
        Err(crate::Error::Unsupported)
    }

    /// Not an error: "no Android Keystore here" is a complete, true answer, and the
    /// adapter's fallback is exactly today's behaviour.
    pub fn secret_available(&self) -> crate::Result<SecretAvailability> {
        Ok(SecretAvailability {
            available: false,
            backing: "no Android Keystore on this platform".to_string(),
        })
    }
}
