use serde::{Deserialize, Serialize};

/// What `apps/mobile`'s `Share.share({ message, title })` sent through
/// `react-native`'s bridge, minus the platform-specific result object: the Android
/// share sheet gives no reliable "the user picked X and it completed" signal back to
/// the caller (`ACTION_SEND` is fire-and-forget once the chooser is shown), so this
/// plugin does not pretend to have one either.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareTextArgs {
    /// The text body — for the share-link flow this is the URL itself, matching
    /// `apps/mobile/src/components/share/share-item-sheet.tsx`'s `Share.share({ message: url })`.
    pub text: String,
    /// Shown as the chooser sheet's title, not inserted into the shared content.
    #[serde(default)]
    pub title: Option<String>,
}

/// A decrypted attachment on its way out of the app, matching what `apps/mobile`'s
/// `ItemAttachments` did with `expo-sharing`: write the plaintext to a private cache
/// file, then let Android's chooser decide where it goes (Files, Drive, a viewer).
///
/// The bytes arrive base64-encoded because the Tauri IPC bridge is JSON: a raw
/// `Vec<u8>` would serialize as a JSON array of numbers, roughly 4× the size of
/// base64 for the same payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareFileArgs {
    /// Base64 of the *decrypted* file. It never touches disk anywhere else — the Kotlin
    /// side writes it to the app-private cache and nothing outside the FileProvider grant
    /// can read it.
    pub base64_data: String,
    /// The name the receiving app sees. Already the decrypted attachment name.
    pub file_name: String,
    /// Best-effort; `application/octet-stream` when the attachment's own type is unknown.
    #[serde(default)]
    pub mime_type: Option<String>,
    /// Shown as the chooser sheet's title.
    #[serde(default)]
    pub title: Option<String>,
}
