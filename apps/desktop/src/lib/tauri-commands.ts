/**
 * Every Tauri command this app invokes, once, with types.
 *
 * `invoke` takes a string and an untyped bag, so before this module a typo in a
 * command name or an argument key was a runtime `invalid args` from the other
 * side of the bridge. The argument and result shapes are generated from
 * `apps/desktop/src-tauri/src/tauri_api.rs` (ADR 0012, regenerate with
 * `pnpm -F desktop generate:bindings`); this file is the only place a command
 * name is spelled, and nothing outside it may call `invoke` for one.
 *
 * The import is dynamic because `@tauri-apps/api` must not be pulled into a
 * bundle that can be evaluated before the Tauri runtime exists.
 *
 * Two `#[tauri::command]` functions — `check_extension_biometric_status` and
 * `extension_biometric_unlock` — are deliberately absent: they are not in the
 * app's `generate_handler!` list, so the webview cannot reach them. They exist
 * only as the implementation of the corresponding IPC requests from the browser
 * extension, which arrive over the desktop socket rather than the bridge.
 */

import type {
	BroadcastActiveAccountChangedArgs,
	BroadcastLockEventArgs,
	BroadcastUnlockEventArgs,
	KeychainDeleteArgs,
	KeychainGetArgs,
	KeychainSetArgs,
	SetUiThemeArgs,
} from "@/generated/tauri-commands";

async function invoke<Result>(
	command: string,
	args: Record<string, unknown>,
): Promise<Result> {
	const core = await import("@tauri-apps/api/core");
	return core.invoke<Result>(command, args);
}

// ---------------------------------------------------------------------------
// Keychain — the OS secure store behind the storage port's `secret` tier
// ---------------------------------------------------------------------------

/** Absent keys answer `null`; the empty string is a value, not an absence. */
export async function keychainGet(
	args: KeychainGetArgs,
): Promise<string | null> {
	return (await invoke<string | null>("keychain_get", args)) ?? null;
}

export async function keychainSet(args: KeychainSetArgs): Promise<void> {
	await invoke<null>("keychain_set", args);
}

/** `true` when a value was there to remove. */
export async function keychainDelete(
	args: KeychainDeleteArgs,
): Promise<boolean> {
	return invoke<boolean>("keychain_delete", args);
}

// ---------------------------------------------------------------------------
// Event broadcasts — how the browser extension learns about this app
// ---------------------------------------------------------------------------

export async function broadcastLockEvent(
	args: BroadcastLockEventArgs,
): Promise<void> {
	await invoke<null>("broadcast_lock_event", args);
}

export async function broadcastUnlockEvent(
	args: BroadcastUnlockEventArgs,
): Promise<void> {
	await invoke<null>("broadcast_unlock_event", args);
}

export async function broadcastActiveAccountChanged(
	args: BroadcastActiveAccountChangedArgs,
): Promise<void> {
	await invoke<null>("broadcast_active_account_changed", args);
}

/**
 * Persist the appearance preference where the native host can read it. The
 * webview's localStorage is invisible to that process, so this is the only way
 * the extension learns the desktop app's theme before the window has loaded.
 */
export async function setUiTheme(args: SetUiThemeArgs): Promise<void> {
	await invoke<null>("set_ui_theme", args);
}
