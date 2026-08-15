use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::CredentialProviderExt;

#[command]
pub(crate) fn is_supported<R: Runtime>(app: AppHandle<R>) -> crate::Result<ProviderSupport> {
    app.credential_provider().is_supported()
}
