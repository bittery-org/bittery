use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::BitteryKeystoreExt;

#[command]
pub(crate) fn secret_set<R: Runtime>(
    app: AppHandle<R>,
    key: String,
    value: String,
) -> crate::Result<()> {
    app.bittery_keystore().secret_set(SetArgs { key, value })
}

#[command]
pub(crate) fn secret_get<R: Runtime>(app: AppHandle<R>, key: String) -> crate::Result<SecretValue> {
    app.bittery_keystore().secret_get(KeyArgs { key })
}

#[command]
pub(crate) fn secret_delete<R: Runtime>(app: AppHandle<R>, key: String) -> crate::Result<()> {
    app.bittery_keystore().secret_delete(KeyArgs { key })
}

#[command]
pub(crate) fn secret_available<R: Runtime>(app: AppHandle<R>) -> crate::Result<SecretAvailability> {
    app.bittery_keystore().secret_available()
}
