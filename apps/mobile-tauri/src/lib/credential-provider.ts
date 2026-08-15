/**
 * The Android credential provider bridge, as the app sees it.
 *
 * Method for method the interface `apps/mobile/modules/credential-provider/src/
 * CredentialProviderModule.ts` declared, so the wiring that follows is a drop-in. One
 * unavoidable difference: **everything returns a `Promise` here**, including the six
 * calls Expo exposed synchronously, because Tauri's IPC is asynchronous end to end.
 * Call sites have to `await`.
 *
 * Behind it is `src-tauri/plugins/credential-provider`. The Kotlin resolves
 * `{ "value": … }` for every command and the Rust unwraps it, so what arrives here is
 * already a `boolean`, a `number`, a `string | null` or an array.
 *
 * **Absent plugin.** iOS has no `CredentialProviderService`, and a build where the
 * plugin failed to register has none either. Both must leave the app running with
 * autofill merely unavailable, so the surface is probed **once** — the first call runs
 * `is_available` and remembers whether it answered at all — and every method returns a
 * stated fallback instead of throwing when it did not. The fallbacks are the
 * conservative ones: locked, no escrow, nothing pending, and master-password re-entry
 * *required*, matching what the Kotlin itself answers below API 23.
 *
 * When the plugin *is* present, errors are not swallowed. A rejected
 * `escrowMukWithBiometric` means the user cancelled the prompt, and a caller that
 * cannot tell that from success would silently claim the vault is protected. Those
 * rejections propagate exactly as the Expo module's did.
 */

import type {
	EscrowMukParams,
	PendingPasskeyMutation,
	ProviderSupport,
	SyncVaultDataResult,
} from "./credential-provider.types";

export type {
	EscrowMukParams,
	PendingPasskeyMutation,
	ProviderSupport,
	SyncVaultDataResult,
};

const PLUGIN = "plugin:bittery-credential-provider";

type Args = Record<string, unknown>;

let probe: Promise<boolean> | null = null;
let unavailableReason: string | null = null;

async function tauriInvoke<T>(command: string, args?: Args): Promise<T> {
	const { invoke } = await import("@tauri-apps/api/core");
	return await invoke<T>(`${PLUGIN}|${command}`, args);
}

/**
 * One probe for the whole surface, memoised on the promise so concurrent first calls
 * share it.
 *
 * `is_available` is the probe because it is read-only, cheap, and its *rejection* — not
 * its answer — is the signal: an unregistered command, a missing ACL grant or a
 * non-Tauri host all reject, while a real Android build answers `true` or `false`
 * depending only on the API level. So "the plugin is here" and "this device supports
 * credential providers" stay separate facts, which is what `isAvailable()` reports.
 */
function pluginPresent(): Promise<boolean> {
	probe ??= (async () => {
		try {
			await tauriInvoke<boolean>("is_available");
			return true;
		} catch (cause) {
			unavailableReason =
				cause instanceof Error ? cause.message : String(cause);
			return false;
		}
	})();
	return probe;
}

/** Why the plugin is unavailable, or `null` while it is available or unprobed. */
export function credentialProviderUnavailableReason(): string | null {
	return unavailableReason;
}

async function call<T>(command: string, fallback: T, args?: Args): Promise<T> {
	if (!(await pluginPresent())) {
		return fallback;
	}
	return await tauriInvoke<T>(command, args);
}

// ============================================
// Vault State Management
// ============================================

/**
 * Set the Master Unlock Key after successful login/unlock. This makes the MUK
 * available to the CredentialProviderService for decryption.
 *
 * @param mukBase64 Base64-encoded Master Unlock Key (32 bytes = 44 chars)
 * @returns true if successful
 */
export function setMasterUnlockKey(
	mukBase64: string,
	userId?: string,
	autoLockTimeoutMs?: number,
): Promise<boolean> {
	return call("set_master_unlock_key", false, {
		mukBase64,
		userId,
		autoLockTimeoutMs,
	});
}

/**
 * Update the native MUK auto-lock timeout for a user.
 * Applies immediately to currently persisted native MUK state.
 */
export function setMukAutoLockTimeout(
	timeoutMs: number,
	userId?: string,
): Promise<boolean> {
	return call("set_muk_auto_lock_timeout", false, { timeoutMs, userId });
}

/** Clear the Master Unlock Key (on logout or auto-lock). */
export function clearMasterUnlockKey(userId?: string): Promise<boolean> {
	return call("clear_master_unlock_key", false, { userId });
}

/** Clear all Master Unlock Keys (on logout, or when locking all accounts). */
export function clearAllMasterUnlockKeys(): Promise<boolean> {
	return call("clear_all_master_unlock_keys", false);
}

/** Whether the vault is currently unlocked (MUK available). */
export function isVaultUnlocked(userId?: string): Promise<boolean> {
	return call("is_vault_unlocked", false, { userId });
}

/**
 * The MUK as a Base64 string (for debugging/verification only).
 * WARNING: only use in development builds.
 */
export function getMasterUnlockKeyBase64(
	userId?: string,
): Promise<string | null> {
	return call<string | null>("get_master_unlock_key_base64", null, { userId });
}

// ============================================
// MUK Escrow Management
// ============================================

/**
 * Escrow the MUK with biometric protection after a password unlock, enabling later
 * biometric-only unlocks. Rejects if the user cancels the prompt.
 */
export function escrowMukWithBiometric(
	params: EscrowMukParams,
): Promise<boolean> {
	return call("escrow_muk_with_biometric", false, {
		email: params.email,
		userId: params.userId,
		timeoutMs: params.timeoutMs,
	});
}

/**
 * Retrieve the escrowed MUK with biometric authentication, unlocking the vault
 * without password entry. Rejects if the user cancels the prompt.
 */
export function retrieveEscrowedMuk(): Promise<boolean> {
	return call("retrieve_escrowed_muk", false);
}

/** Whether there is a valid (non-expired) MUK escrow. */
export function hasValidEscrow(): Promise<boolean> {
	return call("has_valid_escrow", false);
}

/** Whether there is a valid escrow for a specific email. */
export function hasValidEscrowForEmail(email: string): Promise<boolean> {
	return call("has_valid_escrow_for_email", false, { email });
}

/** Remaining escrow time, in milliseconds. */
export function getEscrowRemainingTime(): Promise<number> {
	return call("get_escrow_remaining_time", 0);
}

/** Clear the MUK escrow (on logout, or when a password is required). */
export function clearEscrow(): Promise<boolean> {
	return call("clear_escrow", false);
}

// ============================================
// Vault Sync
// ============================================

/**
 * Sync account KDF metadata, vault keys and items for the unified vault-based autofill
 * system. The native side rejects incomplete profiles.
 */
export function syncVaultData(dataJson: string): Promise<SyncVaultDataResult> {
	return call<SyncVaultDataResult>(
		"sync_vault_data",
		{ vaultKeys: 0, items: 0, domains: 0 },
		{ dataJson },
	);
}

/** Queued passkey mutations pending durable server writeback. */
export function getPendingPasskeyMutations(
	userId?: string,
): Promise<PendingPasskeyMutation[]> {
	return call<PendingPasskeyMutation[]>("get_pending_passkey_mutations", [], {
		userId,
	});
}

/** Mark queued passkey mutations as successfully applied remotely. */
export function markPendingPasskeyMutationsApplied(
	ids: string[],
): Promise<boolean> {
	return call("mark_pending_passkey_mutations_applied", false, { ids });
}

/** Mark queued passkey mutations as failed (increments attempt count). */
export function markPendingPasskeyMutationsFailed(
	ids: string[],
	error: string,
): Promise<boolean> {
	return call("mark_pending_passkey_mutations_failed", false, { ids, error });
}

// ============================================
// 30-Day Master Password Re-entry
// ============================================

/**
 * Whether master password re-entry is required (> 30 days since the last entry).
 * Falls back to `true` — requiring the password — when the plugin is absent.
 */
export function isMasterPasswordReentryRequired(): Promise<boolean> {
	return call("is_master_password_reentry_required", true);
}

/** Whether biometric unlock can be used (escrow validity plus the 30-day check). */
export function canUseBiometricUnlock(): Promise<boolean> {
	return call("can_use_biometric_unlock", false);
}

/** Record a successful password-based unlock. */
export function updateLastMasterPasswordEntry(): Promise<boolean> {
	return call("update_last_master_password_entry", false);
}

/** The timestamp of the last master password entry. */
export function getLastMasterPasswordEntry(): Promise<number> {
	return call("get_last_master_password_entry", 0);
}

// ============================================
// Credential Provider API
// ============================================

/**
 * Whether the Credential Manager API is available on this device.
 * Requires Android 14 (API 34) or higher.
 */
export function isAvailable(): Promise<boolean> {
	return call("is_available", false);
}

/** Whether biometric authentication is available. */
export function isBiometricAvailable(): Promise<boolean> {
	return call("is_biometric_available", false);
}

/**
 * Open the Android system settings for credential providers. `true` means the
 * credential-provider screen opened, `false` means it fell back to security settings.
 */
export function openCredentialProviderSettings(): Promise<boolean> {
	return call("open_credential_provider_settings", false);
}

/**
 * The manifest-merge probe M2-C1 left behind. Not part of the Expo interface: it
 * separates "this device supports credential providers" from "the user switched Bittery
 * on" from "the service reached the APK", which `isAvailable()` alone cannot.
 */
export function isSupported(): Promise<ProviderSupport> {
	return call<ProviderSupport>("is_supported", {
		supported: false,
		apiLevel: 0,
		enabled: false,
		serviceDeclared: false,
		component: "",
		detail: `bittery-credential-provider plugin unavailable: ${
			unavailableReason ?? "not probed"
		}`,
	});
}

/**
 * The whole surface as one object, for call sites that held the Expo module's default
 * export in a variable.
 */
export const credentialProvider = {
	setMasterUnlockKey,
	setMukAutoLockTimeout,
	clearMasterUnlockKey,
	clearAllMasterUnlockKeys,
	isVaultUnlocked,
	getMasterUnlockKeyBase64,
	escrowMukWithBiometric,
	retrieveEscrowedMuk,
	hasValidEscrow,
	hasValidEscrowForEmail,
	getEscrowRemainingTime,
	clearEscrow,
	syncVaultData,
	getPendingPasskeyMutations,
	markPendingPasskeyMutationsApplied,
	markPendingPasskeyMutationsFailed,
	isMasterPasswordReentryRequired,
	canUseBiometricUnlock,
	updateLastMasterPasswordEntry,
	getLastMasterPasswordEntry,
	isAvailable,
	isBiometricAvailable,
	openCredentialProviderSettings,
	isSupported,
} as const;
