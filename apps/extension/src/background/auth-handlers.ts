/**
 * Authentication Handlers
 * Handles LOGIN, QUICK_UNLOCK, CHECK_AUTH, and related authentication messages
 *
 * Uses shared auth utilities from @bittery/core for SRP login/unlock logic.
 */

import { invalidateAccountSession } from "@bittery/core/services/account-lifecycle";
import {
	performSRPLogin,
	performSRPUnlock,
	storeLoginSessionOwned,
	storeUnlockSessionOwned,
} from "@bittery/core/services/auth-service";
import { unlockAllWithPassword } from "@bittery/core/services/unlock";
import { crypto } from "../lib/crypto";
import { itemCache, storage } from "../lib/storage";
import { apiClient } from "./api-client";
import { PENDING_DESKTOP_UNLOCK } from "./desktop-protocol";
import { isDesktopUnlockedNow } from "./desktop-status";
import { requireDesktopUnlock } from "./desktop-unlock";
import { lifecycleDeps } from "./lifecycle";
import { resolveEmailFromAccountId } from "./services/account-resolution";
import { restoreUnlockedSessions } from "./services/session-restore";
import {
	isUnlocked,
	setDesktopModeSentinel,
	setMasterUnlockKey,
	updateActivity,
} from "./session-manager";
import type { MessageResponse } from "./types";
import { vaultSession } from "./vault-session";

const DEFAULT_SERVER_URL = "http://localhost:3000";

/**
 * Handle LOGIN message - Full SRP authentication
 */
export async function handleLogin(payload: {
	email: string;
	password: string;
	secretKey: string;
	serverUrl?: string;
}): Promise<MessageResponse> {
	const { email, password, secretKey } = payload;
	const serverUrl = payload.serverUrl ?? DEFAULT_SERVER_URL;

	// Perform SRP login using shared utility
	const result = await performSRPLogin(
		{ email, password, secretKey, serverUrl },
		{ apiClient, crypto, storage },
	);

	// Store session data using shared utility
	await storeLoginSessionOwned(
		result,
		secretKey,
		storage,
		itemCache,
		crypto,
		email,
		{
			serverUrl,
			onMasterUnlockKeyTransferred: () => {
				setMasterUnlockKey(result.masterUnlockKey);
			},
		},
	);

	// Start activity tracking
	updateActivity();

	return { success: true };
}

/**
 * Handle QUICK_UNLOCK message - Fast unlock using stored secret key
 */
export async function handleQuickUnlock(payload: {
	password: string;
}): Promise<MessageResponse> {
	const { password } = payload;

	// A connected-but-locked desktop owns the unlock; unlocking locally here
	// would leave the desktop behind. See `desktop-unlock.ts`.
	const desktopUnlock = await requireDesktopUnlock();
	if (desktopUnlock.required) {
		return {
			success: true,
			status: PENDING_DESKTOP_UNLOCK,
			desktopReachable: desktopUnlock.triggered,
		};
	}

	// Get stored email for multi-account support
	const activeAccount = await storage.getActiveAccount();

	if (!activeAccount) {
		throw new Error("Quick unlock not available - no active account");
	}

	// Perform SRP unlock using shared utility (retrieves stored secret key internally)
	const result = await performSRPUnlock(
		{ accountId: activeAccount, password },
		{ apiClient, crypto, storage },
	);

	// Store session data using shared utility
	await storeUnlockSessionOwned(
		result,
		storage,
		itemCache,
		crypto,
		activeAccount,
		{
			travelModeApiClient: apiClient,
			setActive: true,
		},
	);

	// Set MUK in extension's in-memory session manager (for auto-lock)
	if (result.masterUnlockKey) {
		setMasterUnlockKey(result.masterUnlockKey);
	}

	// Start activity tracking
	updateActivity();

	return { success: true };
}

/**
 * Handle CHECK_AUTH message - Check if extension is authenticated and unlocked
 */
export async function handleCheckAuth(): Promise<MessageResponse> {
	// Check if we have a valid session
	const localAuthenticated = await storage.isAuthenticated();

	// Ensure an active account is set if accounts exist but none is active
	// This handles the case where the first account is added but not set as active
	await ensureActiveAccountSet();

	// Try to restore sessions from storage if not already unlocked.
	//
	// The service-worker startup routine already does this once per wake
	// (`restoreUnlockedSessions`); this covers the case where the worker stayed alive
	// through a lock and the popup is asking again.
	if (localAuthenticated && !isUnlocked()) {
		const restored = await restoreUnlockedSessions();
		if (restored.muk) {
			setMasterUnlockKey(restored.muk);
		}
	}

	const desktopUnlocked = await isDesktopUnlockedNow();
	let unlocked = isUnlocked();

	// Service worker restart can lose sentinel MUK; recover desktop mode eagerly.
	if (!unlocked && desktopUnlocked) {
		setDesktopModeSentinel();
		unlocked = true;
	}

	// In desktop mode, local tokens may not be restored yet, but API auth still works
	// through desktop token bridging.
	const authenticated = localAuthenticated || desktopUnlocked;

	if (authenticated && unlocked) {
		await updateActivity();
	}

	return { success: true, authenticated, unlocked };
}

/**
 * Ensure an active account is set if accounts exist but none is active
 * This handles the case where the first account is added but no active account is set
 */
async function ensureActiveAccountSet(): Promise<void> {
	try {
		const accounts = await storage.getAccountsList();
		if (accounts.length === 0) return;

		const activeAccount = await storage.getActiveAccount();
		if (activeAccount) return; // Already have an active account

		// No active account but we have accounts - set the first one as active
		if (accounts.length === 1) {
			// Single account - set it as active
			const firstAccount = accounts[0];
			if (!firstAccount) return; // Should never happen but satisfies TS
			await storage.setActiveAccount(firstAccount.accountId);
		} else {
			// Multiple accounts - check if any are unlocked
			const unlockedAccountIds = await storage.getUnlockedAccounts();

			if (unlockedAccountIds.length >= 1) {
				// One or more unlocked - use the first unlocked account as active
				const unlockedAccountId = unlockedAccountIds[0];
				if (!unlockedAccountId) return; // Should never happen but satisfies TS
				await storage.setActiveAccount(unlockedAccountId);
			} else {
				// None unlocked - default to first account
				const firstAccount = accounts[0];
				if (!firstAccount) return; // Should never happen but satisfies TS
				await storage.setActiveAccount(firstAccount.accountId);
			}
		}
	} catch (error) {
		console.error("[Auth] Failed to ensure active account:", error);
	}
}

/**
 * Handle CAN_QUICK_UNLOCK message - Check if quick unlock is available
 *
 * Deliberately NOT `storage.canQuickUnlock()`, which additionally requires unexpired
 * `session_data`. Quick unlock does not need it: `performSRPUnlock` re-authenticates against
 * the server and re-issues both the token and the vault keys, so everything it consumes —
 * the accounts list, the stored `secret_key` and the pinned KDF profile — is device-bound
 * and survives a browser restart. The honest question is "can we re-derive?", and that is
 * what this asks.
 */
export async function handleCanQuickUnlock(): Promise<MessageResponse> {
	const activeAccount = await storage.getActiveAccount();
	if (!activeAccount) {
		return { success: true, canQuickUnlock: false };
	}

	const accountId = activeAccount;
	const canQuickUnlock =
		(await storage.hasStoredSecretKey(accountId)) &&
		(await storage.getPinnedKdfProfile(accountId)) !== null;

	return { success: true, canQuickUnlock };
}

/**
 * Handle GET_AUTH_TOKEN message - Get the auth token
 */
export async function handleGetAuthToken(): Promise<MessageResponse> {
	const token = await storage.getAuthToken();
	return { success: true, token };
}

/**
 * Handle GET_SESSION_DATA message - Get stored session data
 */
export async function handleGetSessionData(): Promise<MessageResponse> {
	const activeAccount = await storage.getActiveAccount();
	const userId = await storage.getActiveAccountUserId();
	const sessionValid = await storage.isSessionValid();

	const email = activeAccount
		? await resolveEmailFromAccountId(activeAccount)
		: null;

	return {
		success: true,
		sessionData:
			email && userId ? { email, userId, isValid: sessionValid } : null,
	};
}

/**
 * Handle LOGOUT message - Sign out of the active account and lock
 */
export async function handleLogout(): Promise<MessageResponse> {
	const accountId = await storage.getActiveAccount();
	const outcome = accountId
		? await invalidateAccountSession({ accountId }, lifecycleDeps)
		: null;
	// `source: "logout"` never refuses: signing out must lock even next to a desktop app.
	await vaultSession.dispatch({
		type: "LOCK_REQUESTED",
		source: "logout",
		at: Date.now(),
	});

	// The module reports instead of throwing, so a genuinely failed storage step
	// has to be surfaced here or the popup would call a partial wipe a success.
	if (outcome && outcome.failures.length > 0) {
		console.error("[Auth] Sign-out steps failed:", outcome.failures);
		return { success: false };
	}
	return { success: true };
}

/**
 * Handle GET_SESSION_STATUS message - the whole vault-session snapshot, so lock
 * state and ownership reach the popup as one consistent value. Reading it also
 * re-evaluates the desktop and the auto-lock deadline (fail-closed by design).
 */
export async function handleGetSessionStatus(): Promise<MessageResponse> {
	return { success: true, ...vaultSession.getSnapshot() };
}

/**
 * Handle LOCK message - Manual lock (clears MUK but keeps vault keys)
 *
 * Refusals travel as a machine-readable `code`, never as prose: the popup owns
 * the translated string (strict i18n).
 */
export async function handleLock(): Promise<MessageResponse> {
	await vaultSession.dispatch({
		type: "LOCK_REQUESTED",
		source: "popup",
		at: Date.now(),
	});

	const refusal = vaultSession.consumeRefusal();
	if (refusal) {
		return { success: false, code: refusal };
	}

	return { success: true };
}

/**
 * Handle QUICK_UNLOCK_ALL message - Unlock all accounts with password
 */
export async function handleQuickUnlockAll(payload: {
	password: string;
}): Promise<MessageResponse> {
	const { password } = payload;

	// A connected-but-locked desktop owns the unlock; unlocking locally here
	// would leave the desktop behind. See `desktop-unlock.ts`.
	const desktopUnlock = await requireDesktopUnlock();
	if (desktopUnlock.required) {
		return {
			success: true,
			status: PENDING_DESKTOP_UNLOCK,
			desktopReachable: desktopUnlock.triggered,
		};
	}

	const accounts = await storage.getAccountsList();

	if (accounts.length === 0) {
		throw new Error("No accounts found");
	}

	const { activeAccountId, unlocked, failed } = await unlockAllWithPassword(
		{ password },
		{
			storage,
			itemCache,
			crypto,
			credentialMirror: lifecycleDeps.credentialMirror,
		},
	);

	if (!activeAccountId) {
		throw new Error("Failed to unlock any accounts");
	}

	// The other accounts stay unlocked in the background; only the active one
	// gets its MUK seeded into the in-memory session manager for auto-lock.
	const activeMuk = await storage.getMasterUnlockKey(activeAccountId);
	if (activeMuk) {
		setMasterUnlockKey(activeMuk);
	}

	updateActivity();

	return {
		success: true,
		result: { unlocked, failed },
	};
}
