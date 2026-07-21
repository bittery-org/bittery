/**
 * Authentication Handlers
 * Handles LOGIN, QUICK_UNLOCK, CHECK_AUTH, and related authentication messages
 *
 * Uses shared auth utilities from @bittery/core for SRP login/unlock logic.
 */

import {
	performSRPLogin,
	performSRPUnlock,
	storeLoginSession,
	storeUnlockSession,
} from "@bittery/core";
import { getAccountSessionManager } from "@bittery/core/services/account-session-manager";
import { createAccountRpcClient } from "@bittery/shared/rpc-client-factory";
import { cryptoAdapter } from "../lib/crypto-adapter";
import { storage } from "../lib/storage";
import { isDesktopUnlockedNow } from "./desktop-status";
import { PENDING_DESKTOP_UNLOCK, requireDesktopUnlock } from "./desktop-unlock";
import { rpcClient } from "./rpc-client";
import { resolveEmailFromAccountId } from "./services/account-resolution";
import {
	getAutoLockTimeoutCached,
	getLastActivityTimestamp,
	isDesktopMode,
	isUnlocked,
	lock,
	setDesktopModeSentinel,
	setMasterUnlockKey,
	updateActivity,
} from "./session-manager";
import type { MessageResponse } from "./types";

const DEFAULT_SERVER_URL = "http://localhost:3000";

async function getAccountRpcClient(accountId: string) {
	const token = await storage.getAuthToken(accountId);
	if (!token) {
		return rpcClient;
	}
	const serverUrl =
		(await storage.getServerUrl(accountId)) ??
		(await storage.getServerUrl()) ??
		DEFAULT_SERVER_URL;
	return createAccountRpcClient(token, serverUrl);
}

/**
 * Handle LOGIN message - Full SRP authentication
 */
export async function handleLogin(payload: {
	email: string;
	password: string;
	secretKey: string;
}): Promise<MessageResponse> {
	const { email, password, secretKey } = payload;

	// Perform SRP login using shared utility
	const result = await performSRPLogin(
		{ email, password, secretKey, serverUrl: DEFAULT_SERVER_URL },
		{ crypto: cryptoAdapter, rpcClient, storage },
	);

	// Store session data using shared utility
	await storeLoginSession(result, secretKey, storage, email, {
		serverUrl: DEFAULT_SERVER_URL,
	});

	// Set MUK in extension's in-memory session manager (for auto-lock)
	if (result.masterUnlockKey) {
		setMasterUnlockKey(result.masterUnlockKey);
	}

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

	if (!activeAccount || activeAccount.type !== "single") {
		throw new Error("Quick unlock not available - no active account");
	}

	// Perform SRP unlock using shared utility (retrieves stored secret key internally)
	const result = await performSRPUnlock(
		{ accountId: activeAccount.accountId, password },
		{ crypto: cryptoAdapter, rpcClient, storage },
	);

	// Store session data using shared utility
	await storeUnlockSession(result, storage, activeAccount.accountId, {
		travelModeRpcClient: rpcClient,
	});

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

	// Try to restore sessions from storage if not already unlocked
	// This handles browser restart where in-memory MUKs are cleared
	if (localAuthenticated && !isUnlocked()) {
		await tryRestoreAllSessions();
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
			await storage.setActiveAccount({
				type: "single",
				accountId: firstAccount.accountId,
			});
		} else {
			// Multiple accounts - check if any are unlocked
			const unlockedAccountIds = (await storage.getUnlockedAccounts?.()) ?? [];

			if (unlockedAccountIds.length >= 1) {
				// One or more unlocked - use the first unlocked account as active
				const unlockedAccountId = unlockedAccountIds[0];
				if (!unlockedAccountId) return; // Should never happen but satisfies TS
				await storage.setActiveAccount({
					type: "single",
					accountId: unlockedAccountId,
				});
			} else {
				// None unlocked - default to first account
				const firstAccount = accounts[0];
				if (!firstAccount) return; // Should never happen but satisfies TS
				await storage.setActiveAccount({
					type: "single",
					accountId: firstAccount.accountId,
				});
			}
		}
	} catch (error) {
		console.error("[Auth] Failed to ensure active account:", error);
	}
}

/**
 * Try to restore all account sessions from encrypted storage
 * Called on startup/auth check to restore sessions after browser restart
 */
async function tryRestoreAllSessions(): Promise<void> {
	try {
		const accounts = await storage.getAccountsList();
		if (accounts.length === 0) return;

		const restoredAccountIds: string[] = [];

		// Try to restore each account's session
		for (const account of accounts) {
			try {
				const restored = await getAccountSessionManager({
					storage,
				}).unlockAccount(account.accountId, false);
				if (restored) {
					restoredAccountIds.push(account.accountId);
				}
			} catch (error) {
				console.error(
					`[Auth] Failed to restore session for ${account.email}:`,
					error,
				);
			}
		}

		// If we restored any sessions, set the session manager's global MUK
		// (just a sentinel value indicating "at least one account is unlocked")
		if (restoredAccountIds.length > 0) {
			// Update activity timestamp FIRST to prevent immediate auto-lock
			await updateActivity();

			const muk = await storage.getMasterUnlockKey(restoredAccountIds[0]);
			if (muk) {
				setMasterUnlockKey(muk);
			}
		}
	} catch (error) {
		console.error("[Auth] Failed to restore sessions:", error);
	}
}

/**
 * Handle CAN_QUICK_UNLOCK message - Check if quick unlock is available
 */
export async function handleCanQuickUnlock(): Promise<MessageResponse> {
	const canQuickUnlock = await storage.canQuickUnlock();
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

	const email =
		activeAccount?.type === "single"
			? await resolveEmailFromAccountId(activeAccount.accountId)
			: null;

	return {
		success: true,
		sessionData:
			email && userId ? { email, userId, isValid: sessionValid } : null,
	};
}

/**
 * Handle LOGOUT message - Clear session and lock
 */
export async function handleLogout(): Promise<MessageResponse> {
	await storage.clearSession();
	lock();
	return { success: true };
}

/**
 * Handle GET_SESSION_STATUS message - Report unlock/lock timing for the popup
 * footer. Returns the remaining time before auto-lock when it can be computed
 * cheaply from in-memory session state; otherwise `remainingMs` is null.
 */
export async function handleGetSessionStatus(): Promise<MessageResponse> {
	const unlocked = isUnlocked();
	const desktopMode = isDesktopMode();

	// Desktop mode has no independent countdown (lock state follows the app),
	// and a "never" timeout (-1) has no countdown either.
	const timeoutMs = getAutoLockTimeoutCached();
	let remainingMs: number | null = null;

	if (unlocked && !desktopMode && timeoutMs !== -1) {
		const lastActivity = getLastActivityTimestamp();
		if (lastActivity > 0) {
			remainingMs = Math.max(0, timeoutMs - (Date.now() - lastActivity));
		}
	}

	return {
		success: true,
		unlocked,
		desktopMode,
		remainingMs,
		timeoutMs,
	};
}

/**
 * Handle LOCK message - Manual lock (clears MUK but keeps vault keys)
 */
export async function handleLock(): Promise<MessageResponse> {
	try {
		// Lock extension (clears session manager's global MUK and all per-account MUKs)
		// This will throw an error if desktop is running
		await lock();

		return { success: true };
	} catch (error) {
		// Return user-friendly error when desktop is managing lock state
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to lock - desktop app is managing vault state",
		};
	}
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

	// Get list of all accounts
	const accounts = await storage.getAccountsList();

	if (accounts.length === 0) {
		throw new Error("No accounts found");
	}

	const unlocked: string[] = [];
	const failed: string[] = [];

	// Attempt to unlock each account
	for (const account of accounts) {
		try {
			// Check if account has stored secret key
			const hasSecretKey = await storage.hasStoredSecretKey?.(
				account.accountId,
			);
			if (!hasSecretKey) {
				failed.push(account.accountId);
				continue;
			}

			// Perform SRP unlock for this account
			const result = await performSRPUnlock(
				{ accountId: account.accountId, password },
				{ crypto: cryptoAdapter, rpcClient, storage },
			);

			// Store unlock session data
			const accountRpcClient = await getAccountRpcClient(account.accountId);
			await storeUnlockSession(result, storage, account.accountId, {
				travelModeRpcClient: accountRpcClient,
			});

			unlocked.push(account.accountId);
		} catch (error) {
			console.error(
				`[QUICK_UNLOCK_ALL] Failed to unlock ${account.email}:`,
				error,
			);
			failed.push(account.accountId);
		}
	}

	// If no accounts unlocked, fail
	if (unlocked.length === 0) {
		throw new Error("Failed to unlock any accounts");
	}

	// `unlocked` holds accountIds (UUIDs), not emails.
	const firstUnlockedAccountId = unlocked[0];
	if (!firstUnlockedAccountId) {
		throw new Error("No unlocked accounts found");
	}

	// Set the active account to the first unlocked account. Other accounts stay
	// unlocked in the background but only the active one is surfaced.
	await storage.setActiveAccount({
		type: "single",
		accountId: firstUnlockedAccountId,
	});

	// Set MUK for first unlocked account in session manager
	const activeMuk = await storage.getMasterUnlockKey(firstUnlockedAccountId);
	if (activeMuk) {
		setMasterUnlockKey(activeMuk);
	}

	updateActivity();

	return {
		success: true,
		result: { unlocked, failed },
	};
}
