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
