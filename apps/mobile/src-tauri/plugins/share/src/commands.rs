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

#[command]
pub(crate) fn share_file<R: Runtime>(
    app: AppHandle<R>,
    base64_data: String,
    file_name: String,
    mime_type: Option<String>,
    title: Option<String>,
) -> crate::Result<()> {
    app.bittery_share().share_file(ShareFileArgs {
        base64_data,
        file_name,
        mime_type,
        title,
    })
}
