use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    // `tauri::plugin::mobile` is `#[cfg(mobile)]`, so the variant has to be too.
    #[cfg(target_os = "android")]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    /// The `ACTION_SEND` chooser is Android's, not a cross-platform concept. Desktop
    /// has no equivalent share sheet, so this says so rather than pretending.
    #[cfg(not(target_os = "android"))]
    #[error("bittery-share is Android-only; this platform has no share sheet")]
    Unsupported,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
