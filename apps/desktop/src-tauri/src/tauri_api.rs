//! The Tauri command surface, as TypeScript sees it.
//!
//! Tauri has no codegen for `invoke`, so before this module the desktop
//! frontend called every command through a bare string literal with an untyped
//! payload. Each command's argument object and non-primitive result is declared
//! here once and ts-rs writes the TypeScript into
//! `apps/desktop/src/generated/tauri-commands.ts`, which
//! `apps/desktop/src/lib/tauri-commands.ts` wraps into one typed function per
//! command. Nothing else may name a command string.
//!
//! **Argument names are the one thing a generator cannot see.** Tauri derives
//! them from the command function's parameters (camelCasing `account_id` into
//! `accountId`), and nothing links those parameters to the types below on their
//! own. So every command builds its argument struct with field-init shorthand,
//! which makes a renamed parameter a compile error rather than a runtime
//! `invalid args` from the other side of the bridge.
//!
//! `export_to` is relative to ts-rs's default export directory,
//! `<crate root>/bindings` — see the note in `desktop_ipc.rs`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::desktop_ipc::DesktopTheme;

/// `keychain_set(key, value)`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/tauri-commands.ts")]
pub struct KeychainSetArgs {
    pub key: String,
    pub value: String,
}

/// `keychain_get(key) -> string | null`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/tauri-commands.ts")]
pub struct KeychainGetArgs {
    pub key: String,
}

/// `keychain_delete(key) -> boolean`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/tauri-commands.ts")]
pub struct KeychainDeleteArgs {
    pub key: String,
}

/// `broadcast_lock_event(reason)`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/tauri-commands.ts")]
pub struct BroadcastLockEventArgs {
    pub reason: String,
}

/// `broadcast_unlock_event(accounts)`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/tauri-commands.ts")]
pub struct BroadcastUnlockEventArgs {
    pub accounts: Vec<String>,
}

/// `broadcast_active_account_changed(accountId)`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/tauri-commands.ts")]
pub struct BroadcastActiveAccountChangedArgs {
    pub account_id: String,
}

/// `set_ui_theme(theme)`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/tauri-commands.ts")]
pub struct SetUiThemeArgs {
    pub theme: DesktopTheme,
}

/// `extension_biometric_unlock(challenge, extensionId, accountId?)`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/generated/tauri-commands.ts")]
pub struct ExtensionBiometricUnlockArgs {
    pub challenge: String,
    pub extension_id: String,
    #[ts(optional)]
    pub account_id: Option<String>,
}

/// What `check_extension_biometric_status` answers.
///
/// `available` is whether the OS offers biometry at all; `enabled` additionally
/// requires that the active account opted in *and* has a session to unlock into.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/generated/tauri-commands.ts")]
pub struct ExtensionBiometricStatus {
    pub available: bool,
    pub enabled: bool,
}
