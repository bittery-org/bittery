use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::BitteryShareExt;

#[command]
pub(crate) fn share_text<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    title: Option<String>,
) -> crate::Result<()> {
    app.bittery_share().share_text(ShareTextArgs { text, title })
}
