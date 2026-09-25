use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

/// Replica of the tauri::plugin::mobile::ErrorResponse for desktop platforms.
#[cfg(desktop)]
#[derive(Debug, thiserror::Error, Clone, serde::Deserialize)]
pub struct ErrorResponse<T = ()> {
    /// Error code.
    pub code: Option<String>,
    /// Error message.
    pub message: Option<String>,
    /// Optional error data.
    #[serde(flatten)]
    pub data: T,
}

#[cfg(desktop)]
impl<T> std::fmt::Display for ErrorResponse<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(code) = &self.code {
            write!(f, "[{code}]")?;
            if self.message.is_some() {
                write!(f, " - ")?;
            }
        }
        if let Some(message) = &self.message {
            write!(f, "{message}")?;
        }
        Ok(())
    }
}

/// Replica of the tauri::plugin::mobile::PluginInvokeError for desktop platforms.
#[cfg(desktop)]
#[derive(Debug, thiserror::Error)]
pub enum PluginInvokeError {
    /// Error returned from direct desktop plugin.
    #[error(transparent)]
    InvokeRejected(#[from] ErrorResponse),
    /// Failed to deserialize response.
    #[error("failed to deserialize response: {0}")]
    CannotDeserializeResponse(serde_json::Error),
    /// Failed to serialize request payload.
    #[error("failed to serialize payload: {0}")]
    CannotSerializePayload(serde_json::Error),
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
    #[cfg(desktop)]
    #[error(transparent)]
    PluginInvoke(#[from] crate::error::PluginInvokeError),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

impl Error {
    /// Machine-readable plugin failure code. Native localized details are not an authority signal.
    pub fn code(&self) -> Option<&str> {
        match self {
            #[cfg(desktop)]
            Self::PluginInvoke(PluginInvokeError::InvokeRejected(error)) => error.code.as_deref(),
            _ => None,
        }
    }
}

#[cfg(desktop)]
pub(crate) fn prompt_cancelled() -> Error {
    Error::PluginInvoke(PluginInvokeError::InvokeRejected(ErrorResponse {
        code: Some("appCancel".into()),
        message: None,
        data: (),
    }))
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    #[test]
    fn code_is_typed_and_does_not_parse_display_text() {
        assert_eq!(prompt_cancelled().code(), Some("appCancel"));
        let text = Error::Io(std::io::Error::other("[appCancel] - untrusted text"));
        assert_eq!(text.code(), None);
        let encoded = serde_json::to_string(&text).unwrap();
        assert_eq!(encoded, "\"[appCancel] - untrusted text\"");
    }
}
