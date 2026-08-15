/**
 * The Android credential provider bridge, as the app sees it.
 *
 * Method for method the interface `apps/mobile/modules/credential-provider/src/
 * CredentialProviderModule.ts` declared. It is **not** a drop-in, and the difference is
 * a trap rather than a chore.
 *
 * **Everything returns a `Promise` here**, including the six calls Expo exposed
 * synchronously (`isAvailable`, `isVaultUnlocked`, `hasValidEscrow`,
 * `getEscrowRemainingTime`, `isMasterPasswordReentryRequired`,
 * `getLastMasterPasswordEntry`), because Tauri's IPC is asynchronous end to end. A call
 * site that used one in a condition keeps compiling and silently inverts:
 *
 * ```ts
 * // apps/mobile/src/services/lifecycle.ts:30 — was a boolean, is now a Promise
 * if (Platform.OS === "android" && CredentialProvider.isAvailable()) { … }
 * ```
 *
 * A `Promise` is always truthy, so that branch now runs on every Android device
 * including the ones with no credential-provider support, and TypeScript does not flag
 * the truthiness of a `Promise`.
 *
 * Biome's `nursery/noMisusedPromises` does catch it, and this app runs it: the severity
 * lives in `apps/mobile-tauri/biome.json` and the `lint:promises` script — chained onto
 * `check-types`, so `turbo -F mobile-tauri check-types` and `pnpm check:ci` both run
 * it — passes `--only`, which is what actually turns Biome's type-aware scanner on. It
 * is deliberately *not* enabled in the root `biome.json`: six pre-existing violations
 * live in `apps/extension`, `apps/mobile`, `packages/core` and `packages/storage`, and
 * turning it on repo-wide would break their builds before anyone had fixed them.
 *
 * Behind it is `src-tauri/plugins/credential-provider`. The Kotlin resolves
 * `{ "value": … }` for every command and the Rust unwraps it, so what arrives here is
 * already a `boolean`, a `number`, a `string | null` or an array.
 *
 * **Absent plugin.** iOS has no `CredentialProviderService`, and a build where the
 * plugin failed to register has none either. Both must leave the app running with
 * autofill merely unavailable, so the surface is probed — the first call runs
 * `is_available` and remembers whether it answered at all.
 *
 * *Read-only* commands then return a stated fallback instead of throwing. The fallbacks
 * are the conservative ones: locked, no escrow, nothing pending, and master-password
 * re-entry *required*, matching what the Kotlin itself answers below API 23.
 *
 * *Mutating* commands get no fallback — they throw {@link CredentialProviderError} with
 * code `PLUGIN_UNAVAILABLE`. A resolved promise from a mutation is read by callers as
 * proof the mutation happened: `use-credential-provider-sync.ts` caches a sync signature
 * the moment `syncVaultData` resolves, so a fabricated `{vaultKeys: 0, items: 0}` would
 * mark the account synced forever and autofill would serve stale data with no error
 * anywhere. Better to throw and let the caller retry.
 *
 * A failed probe is **not** latched either. `probe` is cleared on rejection so the next
 * call re-probes; a single transient failure must not disable autofill for the lifetime
 * of the process.
 *
 * When the plugin *is* present, errors are not swallowed. A rejected
 * `escrowMukWithBiometric` means the user cancelled the prompt, and a caller that
 * cannot tell that from success would silently claim the vault is protected. Those
 * rejections propagate exactly as the Expo module's did — but as a
 * {@link CredentialProviderError} carrying the Kotlin `code` as a field, because Tauri
 * flattens `invoke.reject(message, code)` into the string `"[CODE] - message"` and
 * string-matching that in every caller is not a plan.
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
/** Bumped per probe attempt, so a late failure only clears the slot it owns. */
let probeGeneration = 0;
let unavailableReason: string | null = null;

/**
 * `invoke.reject(message, code)` in the Kotlin becomes a Tauri `ErrorResponse`, and
 * `ErrorResponse: Display` flattens it to `"[CODE] - message"` before it crosses back
 * into JavaScript as a bare string. Expo gave callers `error.code === "VAULT_LOCKED"`;
 * this puts the code back where a caller can branch on it.
 */
const CODE_PREFIX = /^\[([A-Za-z0-9_]+)\](?: - ([\s\S]*))?$/;

/**
 * A rejection from the credential provider, with the Kotlin error code recovered.
 *
 * `message` stays the raw string the bridge produced, prefix and all, so nothing is lost
 * for a log. {@link code} and {@link detail} are the parsed halves; `code` is `null` when
 * the failure came from somewhere that never had one (a serialisation error, a missing
 * ACL grant, a non-Tauri host).
 *
 * The codes the Kotlin raises today: `NO_ACTIVITY`, `VAULT_LOCKED`, `INVALID_PARAMS`,
 * `UNSUPPORTED`, `NO_ESCROW`, `AUTH_ERROR`, `ESCROW_FAILED`, `RETRIEVE_FAILED`,
 * `PROMPT_FAILED`, `SYNC_FAILED`, `QUERY_FAILED`, `UPDATE_FAILED`. This wrapper adds
 * `PLUGIN_UNAVAILABLE`.
 */
export class CredentialProviderError extends Error {
	/** The Kotlin error code, or `null` when the failure carried none. */
	readonly code: string | null;
	/** The message with the `[CODE] - ` prefix stripped. Equals `message` when there is no code. */
	readonly detail: string;
	/** The command that failed, e.g. `escrow_muk_with_biometric`. */
	readonly command: string;

	constructor(command: string, raw: unknown) {
		const rawMessage = raw instanceof Error ? raw.message : String(raw);
		super(rawMessage, raw instanceof Error ? { cause: raw } : undefined);
		this.name = "CredentialProviderError";
		this.command = command;
		const match = CODE_PREFIX.exec(rawMessage);
		this.code = match?.[1] ?? null;
		this.detail = match ? (match[2] ?? "") : rawMessage;
	}
}

/** Thrown by every mutating command when the plugin is not there to run it. */
export class CredentialProviderUnavailableError extends CredentialProviderError {
	constructor(command: string, reason: string | null) {
		super(
			command,
			`[PLUGIN_UNAVAILABLE] - bittery-credential-provider is unavailable, so "${command}" did not run: ${
				reason ?? "not probed"
			}`,
		);
		this.name = "CredentialProviderUnavailableError";
	}
}

async function tauriInvoke<T>(command: string, args?: Args): Promise<T> {
	const { invoke } = await import("@tauri-apps/api/core");
	try {
		return await invoke<T>(`${PLUGIN}|${command}`, args);
	} catch (cause) {
		throw new CredentialProviderError(command, cause);
	}
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
 *
 * Only a *success* is memoised. A rejection clears the slot, so the next call probes
 * again: latching one failure for the whole process would take autofill down until the
 * app restarts, and there is no signal anywhere that it happened.
 */
function pluginPresent(): Promise<boolean> {
	if (probe) {
		return probe;
	}
	const generation = ++probeGeneration;
	const started = (async () => {
		try {
			await tauriInvoke<boolean>("is_available");
			unavailableReason = null;
			return true;
		} catch (cause) {
			unavailableReason =
				cause instanceof Error ? cause.message : String(cause);
			if (probeGeneration === generation) {
				probe = null;
			}
			return false;
		}
	})();
	probe = started;
	return started;
}

/** Why the plugin is unavailable, or `null` while it is available or unprobed. */
export function credentialProviderUnavailableReason(): string | null {
	return unavailableReason;
}

/**
 * A read-only command. Answers `fallback` rather than throwing when the plugin is
 * absent, because a reader that cannot reach the plugin and a reader that got a
 * conservative "no" should leave the app in the same state.
 */
async function call<T>(command: string, fallback: T, args?: Args): Promise<T> {
	if (!(await pluginPresent())) {
		return fallback;
	}
	return await tauriInvoke<T>(command, args);
}

/**
 * A command that changes native state. No fallback: an absent plugin throws
 * {@link CredentialProviderUnavailableError}, so a caller can never mistake "there is no
 * plugin" for "it worked". See the module comment.
 */
async function callMutating<T>(command: string, args?: Args): Promise<T> {
	if (!(await pluginPresent())) {
		throw new CredentialProviderUnavailableError(command, unavailableReason);
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
 * Mutating: throws when the plugin is absent.
 *
 * @param mukBase64 Base64-encoded Master Unlock Key (32 bytes = 44 chars)
 * @returns true if successful
 */
export function setMasterUnlockKey(
	mukBase64: string,
	userId?: string,
	autoLockTimeoutMs?: number,
): Promise<boolean> {
	return callMutating("set_master_unlock_key", {
		mukBase64,
		userId,
		autoLockTimeoutMs,
	});
}

/**
 * Update the native MUK auto-lock timeout for a user.
 * Applies immediately to currently persisted native MUK state.
 * Mutating: throws when the plugin is absent.
 */
export function setMukAutoLockTimeout(
	timeoutMs: number,
	userId?: string,
): Promise<boolean> {
	return callMutating("set_muk_auto_lock_timeout", { timeoutMs, userId });
}

/**
 * Clear the Master Unlock Key (on logout or auto-lock).
 * Mutating: throws when the plugin is absent.
 */
export function clearMasterUnlockKey(userId?: string): Promise<boolean> {
	return callMutating("clear_master_unlock_key", { userId });
}

/**
 * Clear all Master Unlock Keys (on logout, or when locking all accounts).
 * Mutating: throws when the plugin is absent.
 */
export function clearAllMasterUnlockKeys(): Promise<boolean> {
	return callMutating("clear_all_master_unlock_keys");
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
 * Mutating: throws when the plugin is absent.
 */
export function escrowMukWithBiometric(
	params: EscrowMukParams,
): Promise<boolean> {
	return callMutating("escrow_muk_with_biometric", {
		email: params.email,
		userId: params.userId,
		timeoutMs: params.timeoutMs,
	});
}

/**
 * Retrieve the escrowed MUK with biometric authentication, unlocking the vault
 * without password entry. Rejects if the user cancels the prompt.
 * Mutating: throws when the plugin is absent.
 */
export function retrieveEscrowedMuk(): Promise<boolean> {
	return callMutating("retrieve_escrowed_muk");
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

/**
 * Clear the MUK escrow (on logout, or when a password is required).
 * Mutating: throws when the plugin is absent.
 */
export function clearEscrow(): Promise<boolean> {
	return callMutating("clear_escrow");
}

// ============================================
// Vault Sync
// ============================================

/**
 * Sync account KDF metadata, vault keys and items for the unified vault-based autofill
 * system. The native side rejects incomplete profiles.
 *
 * Mutating, and the reason the mutating/read-only split exists: callers cache a sync
 * signature the moment this resolves. A fabricated zero-count result would mark the
 * account synced forever. Throws when the plugin is absent.
 */
export function syncVaultData(dataJson: string): Promise<SyncVaultDataResult> {
	return callMutating<SyncVaultDataResult>("sync_vault_data", { dataJson });
}

/** Queued passkey mutations pending durable server writeback. */
export function getPendingPasskeyMutations(
	userId?: string,
): Promise<PendingPasskeyMutation[]> {
	return call<PendingPasskeyMutation[]>("get_pending_passkey_mutations", [], {
		userId,
	});
}

/**
 * Mark queued passkey mutations as successfully applied remotely.
 * Mutating: throws when the plugin is absent.
 */
export function markPendingPasskeyMutationsApplied(
	ids: string[],
): Promise<boolean> {
	return callMutating("mark_pending_passkey_mutations_applied", { ids });
}

/**
 * Mark queued passkey mutations as failed (increments attempt count).
 * Mutating: throws when the plugin is absent.
 */
export function markPendingPasskeyMutationsFailed(
	ids: string[],
	error: string,
): Promise<boolean> {
	return callMutating("mark_pending_passkey_mutations_failed", { ids, error });
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

/**
 * Record a successful password-based unlock.
 * Mutating: throws when the plugin is absent.
 */
export function updateLastMasterPasswordEntry(): Promise<boolean> {
	return callMutating("update_last_master_password_entry");
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
