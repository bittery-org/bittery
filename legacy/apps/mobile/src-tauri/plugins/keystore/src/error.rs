use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    // `tauri::plugin::mobile` is `#[cfg(mobile)]`, so the variant has to be too.
    #[cfg(target_os = "android")]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    /// Every command here needs the Android Keystore. Desktop has the OS keychain
    /// (`apps/desktop/src-tauri/src/keychain.rs`) and iOS has the Keychain, neither of
    /// which this plugin implements, so it says so rather than pretending.
    #[cfg(not(target_os = "android"))]
    #[error("bittery-keystore is Android-only; this platform has no Android Keystore")]
    Unsupported,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
