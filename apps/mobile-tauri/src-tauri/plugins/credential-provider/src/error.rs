use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    // `tauri::plugin::mobile` is `#[cfg(mobile)]`, so the variant has to be too.
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    /// The credential provider is an Android system service. There is nothing on
    /// desktop to fall back to, so the command says so instead of pretending.
    #[cfg(not(mobile))]
    #[error(
        "bittery-credential-provider is Android-only; this platform has no CredentialProviderService"
    )]
    Unsupported,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
